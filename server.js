// album-backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import path from "path";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.set("trust proxy", 1);

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION", reason);
  process.exit(1);
});

const upload = multer({ storage: multer.memoryStorage() });

// ---- env ----
const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET } =
  process.env;

if (!AWS_REGION) console.error("Missing required env var: AWS_REGION");
if (!S3_BUCKET) console.error("Missing required env var: S3_BUCKET");

const s3 = new S3Client({
  region: AWS_REGION,
  credentials:
    AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

// ---- CORS ----
const ALLOWED_ORIGINS = [
  "https://smartbridge2.onrender.com",
  "https://betablocker.onrender.com",
  "https://webshell-tm0u.onrender.com",
  "http://localhost:5173",
  "http://localhost:4173",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());
app.use(express.json({ limit: "25mb" }));

// ---- helpers ----
function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function safeString(v) {
  return String(v ?? "").trim();
}
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || ""));
}
function isBogusSnapshotKey(k) {
  const s = safeString(k);
  if (!s) return true;
  if (s.startsWith("masterSnapshot_")) return true;
  if (!s.includes("/") || !s.endsWith(".json")) return true;
  return false;
}
function randHex(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
}

async function readJsonFromS3Key(key, expiresInSec = 60) {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function signS3Key(key, expiresInSec = 60 * 20) {
  await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
}

// ---- health ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
});

/* =========================================================
   MASTER SAVE (FIX)
   Expected:
     HTTP 200
     { ok:true, snapshotKey, latestKey }
========================================================= */

app.post("/api/master-save", async (req, res) => {
  try {
    const projectId = safeString(req.body?.projectId);
    const project = req.body?.project;

    if (!projectId) {
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });
    }
    if (project == null || typeof project !== "object") {
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT_OBJECT" });
    }

    // Require S3 env to be present for real saves
    if (!AWS_REGION || !S3_BUCKET) {
      return res.status(500).json({ ok: false, error: "S3_NOT_CONFIGURED" });
    }

    const stamp = isoStamp();
    const nonce = randHex(8);

    // Keep paths stable and easy to reason about
    const snapshotKey = `storage/projects/${projectId}/master_saves/snapshots/${stamp}__${nonce}.json`;
    const latestKey = `storage/projects/${projectId}/master_saves/latest.json`;

    const payload = {
      ok: true,
      projectId,
      createdAt: new Date().toISOString(),
      snapshotKey,
      latestKey,
      project,
    };

    // 1) Write snapshot
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: snapshotKey,
        Body: Buffer.from(JSON.stringify(payload)),
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      })
    );

    // 2) Update latest (copy snapshot -> latest)
    await s3.send(
      new CopyObjectCommand({
        Bucket: S3_BUCKET,
        Key: latestKey,
        CopySource: `${S3_BUCKET}/${snapshotKey}`,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
        MetadataDirective: "REPLACE",
      })
    );

    return res.json({ ok: true, snapshotKey, latestKey });
  } catch (err) {
    console.error("master-save error", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

/* =========================================================
   LEGACY SHIMS (Smartbridge expects these)
========================================================= */

// POST /api/upload-to-s3
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    const projectId = safeString(req.query?.projectId || req.body?.projectId);
    if (!projectId) {
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });
    }

    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, error: "MISSING_FILE" });
    }

    const original = safeString(file.originalname || "upload.bin");
    const ext = path.extname(original) || "";
    const base = original.replace(ext, "").replace(/\s+/g, "_").slice(0, 80);

    const songId =
      safeString(req.query?.songId || req.body?.songId || req.query?.slot || "")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 32) || "song_1";

    const kind =
      safeString(req.query?.kind || req.body?.kind || "album")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 24) || "album";

    const key = `storage/projects/${projectId}/catalog/uploads/${songId}/${kind}/${isoStamp()}__${base}${ext}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: safeString(file.mimetype),
        CacheControl: "no-store",
      })
    );

    const playbackUrl = await signS3Key(key);

    return res.json({
      ok: true,
      projectId,
      s3Key: key,
      playbackUrl,
      url: playbackUrl, // ✅ COMPAT (Smartbridge)
    });
  } catch (err) {
    console.error("upload-to-s3 error", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

// GET /api/playback-url
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3KeyRaw = safeString(req.query?.s3Key || "");
    if (!s3KeyRaw) {
      return res.status(400).json({ ok: false, error: "MISSING_S3_KEY" });
    }

    const s3Key = decodeURIComponent(s3KeyRaw);
    const playbackUrl = await signS3Key(s3Key);

    return res.json({
      ok: true,
      s3Key,
      playbackUrl,
      url: playbackUrl, // ✅ COMPAT (Smartbridge)
    });
  } catch (err) {
    console.error("playback-url error", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- root ----
app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /api/health");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("album-backend listening on", PORT);
});
