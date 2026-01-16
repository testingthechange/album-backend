// album-backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.set("trust proxy", 1);

const upload = multer({ storage: multer.memoryStorage() });

const {
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  S3_BUCKET,
} = process.env;

const REQUIRED = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}`);
  }
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  } : undefined,
});

const ALLOWED_ORIGINS = [
  "https://smartbridge2.onrender.com",
  "https://betablocker.onrender.com",
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
app.use(express.json());

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function randId(n = 12) {
  return crypto.randomBytes(n).toString("hex");
}
function safeFileName(name) {
  const raw = String(name || "file");
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
function guessContentType(file) {
  const mt = String(file?.mimetype || "").toLowerCase();
  if (mt) return mt;
  // fallback for common audio uploads
  return "audio/mpeg";
}

// ---- health ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
});

// ---- upload-to-s3 (REAL S3) ----
// POST /api/upload-to-s3?projectId=...
// multipart form-data: file, s3Key
// Returns: { ok:true, s3Key }
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    const projectId = String(req.query?.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok: false, error: "NO_FILE" });

    // The frontend sends s3Key; we MUST honor it so playback-url matches.
    let s3Key = String(req.body?.s3Key || "").trim();

    // If missing, generate a deterministic-ish key under the same storage path pattern
    if (!s3Key) {
      const fn = safeFileName(file.originalname || "audio.mp3");
      s3Key = `storage/projects/${projectId}/catalog/uploads/${isoStamp()}__${fn}`;
    }

    const contentType = guessContentType(file);

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: file.buffer,
        ContentType: contentType,
        // optional: better behavior for streaming/mp3
        CacheControl: "no-store",
      })
    );

    return res.json({ ok: true, s3Key });
  } catch (err) {
    console.error("upload-to-s3 error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- playback-url (SIGNED S3 GET) ----
// GET /api/playback-url?s3Key=...
// Returns: { ok:true, url }
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = String(req.query?.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });

    // if already a URL, return it (lets you keep demo URLs)
    if (/^https?:\/\//i.test(s3Key)) return res.json({ ok: true, url: s3Key });

    // Confirm object exists (gives cleaner error than signing a missing key)
    try {
      await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    } catch {
      return res.status(404).json({ ok: false, error: "UPLOAD_NOT_FOUND_FOR_S3KEY", s3Key });
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
      { expiresIn: 60 * 20 } // 20 minutes
    );

    return res.json({ ok: true, url });
  } catch (err) {
    console.error("playback-url error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- master-save (S3 JSON) ----
// POST /api/master-save
// Body: { projectId, project }
// Returns: { ok:true, snapshotKey, latestKey }
app.post("/api/master-save", async (req, res) => {
  try {
    const { projectId, project } = req.body || {};
    const pid = String(projectId || "").trim();
    if (!pid || !project) return res.status(400).json({ ok: false, error: "Missing projectId or project" });

    const now = new Date().toISOString();
    const ts = isoStamp();

    const snapshotKey = `storage/projects/${pid}/producer_returns/snapshots/${ts}.json`;
    const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;

    const snapshotBody = JSON.stringify(
      {
        projectId: pid,
        createdAt: now,
        source: "minisite-master-save",
        data: project,
      },
      null,
      2
    );

    const latestBody = JSON.stringify(
      {
        projectId: pid,
        latestSnapshotKey: snapshotKey,
        lastMasterSaveAt: now,
      },
      null,
      2
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: snapshotKey,
        Body: snapshotBody,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      })
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: latestKey,
        Body: latestBody,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      })
    );

    return res.json({ ok: true, snapshotKey, latestKey });
  } catch (err) {
    console.error("master-save error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- publish demo manifest (unchanged) ----
const manifests = {
  demo: {
    albumTitle: "Demo Album",
    tracks: [
      { id: "t1", title: "Track 1", duration: "3:12", previewUrl: "https://album-backend-kmuo.onrender.com/media/track1-preview.mp3" },
      { id: "t2", title: "Track 2", duration: "2:58", previewUrl: "https://album-backend-kmuo.onrender.com/media/track2-preview.mp3" },
      { id: "t3", title: "Track 3", duration: "4:01", previewUrl: "https://album-backend-kmuo.onrender.com/media/track3-preview.mp3" },
    ],
  },
};

app.get("/publish", (_req, res) => res.json({ shareIds: Object.keys(manifests) }));

app.get("/publish/:shareId.json", (req, res) => {
  const manifest = manifests[req.params.shareId];
  if (!manifest) return res.status(404).json({ error: "not_found", shareId: req.params.shareId });
  return res.json({ shareId: req.params.shareId, ...manifest });
});

// root
app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /api/health or /publish/demo.json");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
