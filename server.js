// album-backend/server.js (ESM)
import express from "express";
import cors from "cors";
import multer from "multer";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.set("trust proxy", 1);

const upload = multer({ storage: multer.memoryStorage() });

const ALLOWED_ORIGINS = [
  "https://betablocker.onrender.com",
  "https://smartbridge2.onrender.com",
  "http://localhost:5173",
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
app.use(express.json({ limit: "10mb" }));

// -------------------------
// S3 CONFIG (Render env vars)
// -------------------------
const S3_BUCKET = String(process.env.S3_BUCKET || "").trim();
const S3_REGION = String(process.env.S3_REGION || "").trim() || "us-east-1";

// If you’re using standard AWS creds, Render env vars should be:
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (and optional AWS_SESSION_TOKEN)
const s3 = new S3Client({ region: S3_REGION });

function requireS3(res) {
  if (!S3_BUCKET) {
    res.status(500).json({ ok: false, error: "S3_BUCKET_NOT_SET" });
    return false;
  }
  return true;
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---- health ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
});

// ---- upload-to-s3 (REAL) ----
// multipart form-data: file, s3Key
// returns: { ok:true, s3Key }
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    if (!requireS3(res)) return;

    const s3Key = String(req.body?.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });
    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

    const contentType = req.file.mimetype || "application/octet-stream";

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: req.file.buffer,
        ContentType: contentType,
      })
    );

    return res.json({ ok: true, s3Key });
  } catch (err) {
    console.error("upload-to-s3 error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- playback-url (REAL signing) ----
// GET /api/playback-url?s3Key=...
// returns: { ok:true, url }
app.get("/api/playback-url", async (req, res) => {
  try {
    if (!requireS3(res)) return;

    const s3Key = String(req.query?.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });

    // If already a URL, echo (supports your existing demo/previewUrl paths)
    if (/^https?:\/\//i.test(s3Key)) {
      return res.json({ ok: true, url: s3Key });
    }

    // Optional: fail fast if object missing (clearer errors)
    try {
      await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    } catch {
      return res.status(404).json({ ok: false, error: "S3_OBJECT_NOT_FOUND", s3Key });
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
      { expiresIn: 60 * 15 } // 15 minutes
    );

    return res.json({ ok: true, url });
  } catch (err) {
    console.error("playback-url error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- master-save (REAL to S3 JSON) ----
// POST /api/master-save { projectId, project }
// returns { ok:true, snapshotKey, latestKey }
app.post("/api/master-save", async (req, res) => {
  try {
    if (!requireS3(res)) return;

    const { projectId, project } = req.body || {};
    const pid = String(projectId || "").trim();
    if (!pid || !project) {
      return res.status(400).json({ ok: false, error: "Missing projectId or project" });
    }

    const now = new Date().toISOString();
    const ts = isoStamp();

    const snapshotKey = `storage/projects/${pid}/producer_returns/snapshots/${ts}.json`;
    const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;

    const snapshotPayload = {
      projectId: pid,
      createdAt: now,
      source: "minisite-master-save",
      data: project,
    };

    const latestPayload = {
      projectId: pid,
      latestSnapshotKey: snapshotKey,
      lastMasterSaveAt: now,
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: snapshotKey,
        Body: Buffer.from(JSON.stringify(snapshotPayload, null, 2)),
        ContentType: "application/json",
      })
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: latestKey,
        Body: Buffer.from(JSON.stringify(latestPayload, null, 2)),
        ContentType: "application/json",
      })
    );

    return res.json({ ok: true, snapshotKey, latestKey });
  } catch (err) {
    console.error("master-save error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- master-save latest (REAL) ----
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    if (!requireS3(res)) return;

    const pid = String(req.params.projectId || "").trim();
    if (!pid) return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;

    const latestUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: latestKey }),
      { expiresIn: 60 } // short
    );

    // fetch latest JSON via signed URL (simpler than streaming in Node)
    const latestRes = await fetch(latestUrl, { cache: "no-store" });
    if (!latestRes.ok) {
      return res.status(404).json({ ok: false, error: "NO_LATEST", latestKey });
    }
    const latest = await latestRes.json();

    const snapKey =
      String(latest?.latestSnapshotKey || "").trim() ||
      String(latest?.snapshotKey || "").trim();

    if (!snapKey) {
      return res.status(404).json({ ok: false, error: "NO_LATEST_SNAPSHOT_KEY", latestKey });
    }

    const snapUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: snapKey }),
      { expiresIn: 60 }
    );

    const snapRes = await fetch(snapUrl, { cache: "no-store" });
    if (!snapRes.ok) {
      return res.status(404).json({ ok: false, error: "SNAPSHOT_NOT_FOUND", snapKey });
    }
    const snapshot = await snapRes.json();

    return res.json({ ok: true, latestKey, latest, snapshot });
  } catch (err) {
    console.error("master-save latest error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Root
app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /api/health");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
PORT, () => console.log(`album-backend listening on ${PORT}`));
