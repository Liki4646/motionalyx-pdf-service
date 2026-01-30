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

// ---- PDF GENERATION ----
async function htmlToPdfBuffer(html) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH, // <-- IMPORTANT: use system chromium from Docker
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    // Important: wait until images load
    await page.setContent(html, { waitUntil: "networkidle" });

    // preferCSSPageSize = honors @page settings in your templates
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
    });

    await page.close();
    return pdf;
  } finally {
    await browser.close();
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

// ---- TEMPLATE MAP (we will add these files next) ----
const TEMPLATE_FILES = {
  meal_first: path.join(__dirname, "templates", "meal_first.html"),
  meal_weekly: path.join(__dirname, "templates", "meal_weekly.html"),
  workout_first: path.join(__dirname, "templates", "workout_first.html"),
  workout_weekly: path.join(__dirname, "templates", "workout_weekly.html"),
  bundle_first: path.join(__dirname, "templates", "bundle_first.html"),
  bundle_weekly: path.join(__dirname, "templates", "bundle_weekly.html"),
};

// ---- ROUTES ----
app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "motionalyx-pdf" }));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

/**
 * POST /pdfs
 * Payload: flat JSON (same payload for all templates).
 * Generates 6 PDFs, uploads to GCS, returns signed URLs.
 */
app.post("/pdfs", async (req, res) => {
  try {
    const payload = req.body || {};

    // optional: allow custom folder or job id
    const jobId = payload.job_id || crypto.randomUUID();
    const basePrefix = payload.prefix || `pdfs/${nowStamp()}_${jobId}`;

    const results = {};
    for (const [key, tplPath] of Object.entries(TEMPLATE_FILES)) {
      const htmlRaw = await fs.readFile(tplPath, "utf8");
      const html = renderTemplate(htmlRaw, payload);

      const pdfBuffer = await htmlToPdfBuffer(html);

      const safeName = payload.client_name
        ? String(payload.client_name)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
        : "client";

      const fileName = `${key}_${safeName}_${jobId}.pdf`;
      const objectName = `${basePrefix}/${fileName}`;

      const uploaded = await uploadPdfAndSign({ buffer: pdfBuffer, objectName });
      results[key] = { fileName, ...uploaded };
    }

    res.status(200).json({
      ok: true,
      job_id: jobId,
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Listening on ${PORT}`);
});
