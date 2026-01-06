// server.js
// ------------------------------------------------------------
// IMPORTANT NOTE (2026-01-06):
//
// Frontend calls:
//   POST /api/upload-to-s3
//   POST /api/master-save
//
// Backend must support BOTH /api/* and non-/api/* forms to prevent drift.
// ------------------------------------------------------------

import express from "express";
import cors from "cors";
import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(express.json({ limit: "5mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const AWS_REGION = process.env.AWS_REGION || "us-west-1";
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || "";
const SIGNED_URL_EXPIRES_SECONDS = Number(
  process.env.SIGNED_URL_EXPIRES_SECONDS || 1200
);

// ---------- CORS ----------
app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------- AWS ----------
const s3 = new S3Client({ region: AWS_REGION });

// ---------- MULTER (IN-MEMORY UPLOADS) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});

// ---------- HELPERS ----------
function must(v, msg) {
  if (!v) throw new Error(msg);
  return v;
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function tsForKey() {
  // S3-friendly timestamp
  return nowIso().replace(/[:.]/g, "-");
}

// ---------- HEALTH ----------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "album-backend",
    version: 1,
    uploadRoutes: ["/upload-to-s3", "/api/upload-to-s3"],
    masterSaveRoutes: ["/master-save", "/api/master-save"],
    note: "Do not remove dual routes",
  });
});

// ---------- UPLOAD HANDLER ----------
async function uploadToS3Handler(req, res) {
  try {
    const projectId = safeStr(req.query.projectId);
    if (!projectId) return res.status(400).json({ ok: false, error: "missing projectId" });

    const file = req.file;
    const s3Key = safeStr(req.body?.s3Key);

    if (!file) return res.status(400).json({ ok: false, error: "missing file" });
    if (!s3Key) return res.status(400).json({ ok: false, error: "missing s3Key" });

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype || "application/octet-stream",
        Metadata: { projectid: projectId },
      })
    );

    return res.json({ ok: true, bucket, s3Key });
  } catch (e) {
    console.error("upload-to-s3 error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// ---------- CRITICAL UPLOAD ROUTES (DO NOT REMOVE) ----------
app.post("/upload-to-s3", upload.single("file"), uploadToS3Handler);
app.post("/api/upload-to-s3", upload.single("file"), uploadToS3Handler);

// ---------- MASTER SAVE (JSON -> S3) ----------
// Accepts JSON:
//   { projectId: "348697", project: {...} }
// Writes to:
//   storage/projects/<projectId>/master_saves/<timestamp>__snapshot.json
async function masterSaveHandler(req, res) {
  try {
    const projectId = safeStr(req.body?.projectId || req.query?.projectId);
    const project = req.body?.project;

    if (!projectId) return res.status(400).json({ ok: false, error: "missing projectId" });
    if (!project || typeof project !== "object")
      return res.status(400).json({ ok: false, error: "missing project" });

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");

    const stamp = tsForKey();
    const snapshotKey = `storage/projects/${projectId}/master_saves/${stamp}__snapshot.json`;

    const payload = {
      ok: true,
      projectId,
      savedAt: nowIso(),
      project,
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: snapshotKey,
        Body: Buffer.from(JSON.stringify(payload, null, 2), "utf8"),
        ContentType: "application/json",
        Metadata: { projectid: projectId, kind: "master_save" },
      })
    );

    return res.json({
      ok: true,
      bucket,
      snapshotKey,
      savedAt: payload.savedAt,
    });
  } catch (e) {
    console.error("master-save error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// Support both paths
app.post("/master-save", masterSaveHandler);
app.post("/api/master-save", masterSaveHandler);

// ---------- PLAYBACK URL ----------
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = safeStr(req.query.s3Key);
    if (!s3Key) return res.status(400).json({ ok: false, error: "missing s3Key" });

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
    const url = await getSignedUrl(s3, cmd, { expiresIn: SIGNED_URL_EXPIRES_SECONDS });

    return res.json({ ok: true, url, expiresSeconds: SIGNED_URL_EXPIRES_SECONDS });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
  console.log(`AWS_REGION=${AWS_REGION}`);
  console.log(`S3_BUCKET=${S3_BUCKET || "(missing)"}`);
});
