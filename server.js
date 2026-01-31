import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import { Storage } from "@google-cloud/storage";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "25mb" }));

// ---- ENV ----
const BUCKET_NAME = process.env.BUCKET_NAME || ""; // npr: "motionalyx-pdfs-motionalyx-pdf-service"
const PDF_URL_TTL_MINUTES = Number(process.env.PDF_URL_TTL_MINUTES || "10080"); // default 7 dni
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium"; // system chromium inside Docker

// ---- PATH HELPERS ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(
    d.getUTCHours()
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function safeSlug(input) {
  if (!input) return "client";
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// ---- SIMPLE DATE FORMAT (supports "%B %d, %Y") ----
function formatDate(input, fmt) {
  if (!input) return "";
  const dt = new Date(input);
  if (Number.isNaN(dt.getTime())) return String(input);

  const months = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December"
  ];

  const DD = String(dt.getDate()).padStart(2, "0");
  const YYYY = String(dt.getFullYear());
  const B = months[dt.getMonth()];

  // Minimal support for your current template usage:
  // "%B %d, %Y"
  if (fmt === "%B %d, %Y") return `${B} ${DD}, ${YYYY}`;

  // Fallback: ISO date (YYYY-MM-DD)
  const MM = String(dt.getMonth() + 1).padStart(2, "0");
  return `${YYYY}-${MM}-${DD}`;
}

// ---- TEMPLATE RENDER (supports {{key}} + {{ key | date: "%B %d, %Y" }}) ----
function renderTemplate(html, data) {
  // Liquid-ish date filter (limited)
  html = html.replace(
    /{{\s*([a-zA-Z0-9_]+)\s*\|\s*date:\s*"([^"]+)"\s*}}/g,
    (_m, key, fmt) => formatDate(data?.[key], fmt)
  );

  // Standard {{key}}
  html = html.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_m, key) => {
    const v = data?.[key];
    if (v === null || v === undefined) return "";
    return String(v);
  });

  return html;
}

// ---- PLAYWRIGHT (REUSE BROWSER FOR SPEED) ----
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: CHROMIUM_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

async function htmlToPdfBuffer(html) {
  const browser = await getBrowser();
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });

    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
    });

    await page.close();
    return pdf;
  } finally {
    await context.close();
  }
}

// ---- GCS UPLOAD + SIGNED URL ----
const storage = new Storage();

async function uploadPdfAndSign({ buffer, objectName }) {
  if (!BUCKET_NAME) {
    throw new Error("Missing BUCKET_NAME env var");
  }

  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(objectName);

  await file.save(buffer, {
    resumable: false,
    contentType: "application/pdf",
    metadata: {
      cacheControl: "private, max-age=0, no-transform",
    },
  });

  const expiresMs = PDF_URL_TTL_MINUTES * 60 * 1000;
  const [signedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + expiresMs,
  });

  return {
    gcsPath: `gs://${BUCKET_NAME}/${objectName}`,
    url: signedUrl,
  };
}

// ---- TEMPLATE MAP ----
const TEMPLATE_FILES = {
  meal_first: path.join(__dirname, "templates", "meal_first.html"),
  meal_weekly: path.join(__dirname, "templates", "meal_weekly.html"),
  workout_first: path.join(__dirname, "templates", "workout_first.html"),
  workout_weekly: path.join(__dirname, "templates", "workout_weekly.html"),
  bundle_first: path.join(__dirname, "templates", "bundle_first.html"),
  bundle_weekly: path.join(__dirname, "templates", "bundle_weekly.html"),
};

function resolveTemplateKey(reqBody, reqQuery) {
  // Allow: body.template_key OR query ?template_key= OR ?template=
  return (
    reqBody?.template_key ||
    reqQuery?.template_key ||
    reqQuery?.template ||
    ""
  );
}

async function generateOnePdf({ templateKey, payload }) {
  const tplPath = TEMPLATE_FILES[templateKey];
  if (!tplPath) {
    const keys = Object.keys(TEMPLATE_FILES);
    throw new Error(`Unknown template_key "${templateKey}". Allowed: ${keys.join(", ")}`);
  }

  const htmlRaw = await fs.readFile(tplPath, "utf8");
  const html = renderTemplate(htmlRaw, payload);
  const pdfBuffer = await htmlToPdfBuffer(html);

  const jobId = payload.job_id || crypto.randomUUID();
  const basePrefix = payload.prefix || `pdfs/${nowStamp()}_${jobId}`;

  const safeName = safeSlug(payload.client_name);
  const fileName = `${templateKey}_${safeName}_${jobId}.pdf`;
  const objectName = `${basePrefix}/${fileName}`;

  const uploaded = await uploadPdfAndSign({ buffer: pdfBuffer, objectName });

  return {
    template_key: templateKey,
    job_id: jobId,
    bucket: BUCKET_NAME,
    fileName,
    objectName,
    ...uploaded,
  };
}

// ---- ROUTES ----
app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "motionalyx-pdf" }));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// (Optional) list templates for debugging
app.get("/templates", (_req, res) => {
  res.status(200).json({ ok: true, template_keys: Object.keys(TEMPLATE_FILES) });
});

/**
 * POST /pdf
 * Generates ONLY ONE PDF.
 *
 * Body example (flat payload + template_key):
 * {
 *   "template_key": "meal_weekly",
 *   "client_name": "...",
 *   "plan_date": "...",
 *   ...
 * }
 *
 * Response:
 * { ok:true, file:{ url, gcsPath, fileName, ... } }
 */
app.post("/pdf", async (req, res) => {
  try {
    const payload = req.body || {};
    const templateKey = resolveTemplateKey(payload, req.query);

    if (!templateKey) {
      return res.status(400).json({
        ok: false,
        error: `Missing template_key. Allowed: ${Object.keys(TEMPLATE_FILES).join(", ")}`,
      });
    }

    const file = await generateOnePdf({ templateKey, payload });

    res.status(200).json({
      ok: true,
      file,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

/**
 * POST /pdfs
 * Optional multi-generate, but ONLY the ones you specify.
 * - If body.template_keys is provided (array), it generates only those.
 * - If not provided, it generates ALL (backward compatible).
 *
 * Body example:
 * {
 *   "template_keys": ["meal_weekly", "workout_weekly"],
 *   ...same payload fields...
 * }
 */
app.post("/pdfs", async (req, res) => {
  try {
    const payload = req.body || {};
    const requested = Array.isArray(payload.template_keys) ? payload.template_keys : null;

    const keysToGenerate = requested && requested.length > 0
      ? requested
      : Object.keys(TEMPLATE_FILES);

    const results = {};
    for (const key of keysToGenerate) {
      const file = await generateOnePdf({ templateKey: key, payload });
      results[key] = file;
    }

    res.status(200).json({
      ok: true,
      job_id: payload.job_id || null,
      bucket: BUCKET_NAME,
      files: results,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

// ---- GRACEFUL SHUTDOWN ----
async function shutdown() {
  try {
    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close();
    }
  } catch (_e) {
    // ignore
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Listening on ${PORT}`);
});
