// server.js
// ------------------------------------------------------------
// IMPORTANT NOTE (2026-01-06):
//
// Uploads broke previously because the frontend called
//   POST /api/upload-to-s3
// while the backend only exposed
//   POST /upload-to-s3
//
// Result: silent 404s.
//
// FIX: This server MUST support BOTH routes permanently.
// Do NOT remove either route.
//
// ALSO (2026-01-06):
// Master Save requires POST /api/master-save.
// If missing, Catalog will fail with: "Master Save failed (404)".
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
app.use(express.json({ limit: "15mb" })); // master-save payload can be large

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const AWS_REGION = process.env.AWS_REGION || "us-west-1";
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || "";
const SIGNED_URL_EXPIRES_SECONDS = Number(
  process.env.SIGNED_URL_EXPIRES_SECONDS || 1200
);

// Where Master Save snapshots are written.
// Example:
//   storage/projects/348697/master_save_snapshots/2026-01-06T07-50-00.000Z.json
const MASTER_SAVE_PREFIX = String(
  process.env.MASTER_SAVE_PREFIX || "storage/projects"
).replace(/^\/+|\/+$/g, "");

// ---------- CORS ----------
app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST", "OPTIONS", "PUT"],
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

function isoForKey() {
  // S3-friendly timestamp
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---------- HEALTH CHECK ----------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "album-backend",
    version: "2026-01-06-upload+master-save",
    uploadRoutes: ["/upload-to-s3", "/api/upload-to-s3"],
    masterSaveRoute: "/api/master-save",
    note: "Do not remove either upload route",
  });
});

// ---------- SHARED UPLOAD HANDLER ----------
async function uploadToS3Handler(req, res) {
  try {
    const projectId = safeStr(req.query.projectId);
    if (!projectId) {
      return res.status(400).json({ ok: false, error: "missing projectId" });
    }

    const file = req.file;
    const s3Key = safeStr(req.body?.s3Key);

    if (!file) {
      return res.status(400).json({ ok: false, error: "missing file" });
    }
    if (!s3Key) {
      return res.status(400).json({ ok: false, error: "missing s3Key" });
    }

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
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}

// ---------- CRITICAL ROUTES (DO NOT REMOVE) ----------
app.post("/upload-to-s3", upload.single("file"), uploadToS3Handler);
app.post("/api/upload-to-s3", upload.single("file"), uploadToS3Handler);

// ---------- MASTER SAVE ----------
// Expects JSON:
// {
//   projectId: "348697",
//   project: { ... }   // full project object
// }
//
// Writes snapshot JSON to S3 and returns:
// { ok:true, snapshotKey }
app.post("/api/master-save", async (req, res) => {
  try {
    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");

    const projectId = safeStr(req.body?.projectId || req.query?.projectId);
    const project = req.body?.project;

    if (!projectId) {
      return res.status(400).json({ ok: false, error: "missing projectId" });
    }
    if (!project || typeof project !== "object") {
      return res.status(400).json({ ok: false, error: "missing project object" });
    }

    const snapshot = {
      ok: true,
      projectId,
      createdAt: new Date().toISOString(),
      project,
    };

    const key = `${MASTER_SAVE_PREFIX}/${projectId}/master_save_snapshots/${isoForKey()}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"),
        ContentType: "application/json",
        Metadata: { projectid: projectId, kind: "master-save" },
      })
    );

    return res.json({ ok: true, snapshotKey: key });
  } catch (e) {
    console.error("master-save error:", e);
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

// ---------- PLAYBACK URL ----------
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = safeStr(req.query.s3Key);
    if (!s3Key) {
      return res.status(400).json({ ok: false, error: "missing s3Key" });
    }

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
    const url = await getSignedUrl(s3, cmd, {
      expiresIn: SIGNED_URL_EXPIRES_SECONDS,
    });

    return res.json({ ok: true, url, expiresSeconds: SIGNED_URL_EXPIRES_SECONDS });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
  console.log(`AWS_REGION=${AWS_REGION}`);
  console.log(`S3_BUCKET=${S3_BUCKET || "(missing)"}`);
  console.log(`MASTER_SAVE_PREFIX=${MASTER_SAVE_PREFIX}`);
});
