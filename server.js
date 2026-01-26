
// album-backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.set("trust proxy", 1);

const upload = multer({ storage: multer.memoryStorage() });

// ---------- env ----------
const {
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  S3_BUCKET,
  PORT,
} = process.env;

if (!AWS_REGION) console.warn("WARN: AWS_REGION is not set");
if (!S3_BUCKET) console.warn("WARN: S3_BUCKET is not set");

// If creds are not provided, the SDK will fall back to the environment / instance role.
// Keep this behavior but be explicit about region default.
const s3 = new S3Client({
  region: AWS_REGION || "us-east-1",
  credentials:
    AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
      : undefined,
});

// ---------- cors ----------
app.use(
  cors({
    origin: [
      "https://smartbridge2.onrender.com",
      "https://betablocker.onrender.com",
      "https://webshell-tm0u.onrender.com",
      "http://localhost:5173",
      "http://localhost:4173",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Make OPTIONS always quick/clean.
app.options("*", cors());

app.use(express.json({ limit: "25mb" }));

// ---------- helpers ----------
const iso = () => new Date().toISOString().replace(/[:.]/g, "-");
const safe = (v) => String(v ?? "").trim();
const rand = (n = 12) => crypto.randomBytes(n).toString("hex");

/** Always produce a useful error string (AWS SDK errors are often objects). */
function errString(e) {
  if (!e) return "UNKNOWN_ERROR";
  if (typeof e === "string") return e;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function logErr(req, e) {
  const rid = req?.headers?.["x-request-id"] || req?.headers?.["x-render-request-id"] || "";
  console.error(
    `ERROR ${req.method} ${req.originalUrl} requestID=${rid} ::`,
    e?.stack || e
  );
}

async function signS3(key, expires = 1200) {
  if (!S3_BUCKET) throw new Error("S3_BUCKET_NOT_SET");
  const Key = safe(key);
  if (!Key) throw new Error("S3_KEY_EMPTY");

  // Head first to validate existence and produce a clearer error.
  await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key }));
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key }),
    { expiresIn: expires }
  );
}

async function readJson(key) {
  const url = await signS3(key, 60);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`READ_JSON_HTTP_${r.status}${text ? ` :: ${text.slice(0, 200)}` : ""}`);
  }
  return r.json();
}

async function putJson(key, obj) {
  if (!S3_BUCKET) throw new Error("S3_BUCKET_NOT_SET");
  const Key = safe(key);
  if (!Key) throw new Error("S3_KEY_EMPTY");

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key,
      Body: Buffer.from(JSON.stringify(obj)),
      ContentType: "application/json",
      CacheControl: "no-store",
    })
  );
}

// ---------- strip playbackUrl (CRITICAL FIX) ----------
function stripPlaybackUrls(obj) {
  if (Array.isArray(obj)) return obj.map(stripPlaybackUrls);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "playbackUrl" || k === "url") continue;
      out[k] = stripPlaybackUrls(v);
    }
    return out;
  }
  return obj;
}

// ---------- health ----------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
});

// ---------- upload (editor only) ----------
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    const projectId = safe(req.query.projectId || req.body?.projectId);
    if (!projectId || !req.file) {
      return res.status(400).json({ ok: false, error: "MISSING_projectId_OR_file" });
    }
    if (!S3_BUCKET) return res.status(500).json({ ok: false, error: "S3_BUCKET_NOT_SET" });

    const key = `storage/projects/${projectId}/uploads/${iso()}__${req.file.originalname}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const playbackUrl = await signS3(key);
    res.json({ ok: true, s3Key: key, playbackUrl });
  } catch (e) {
    logErr(req, e);
    res.status(500).json({ ok: false, error: errString(e) });
  }
});

// ---------- playback (runtime) ----------
app.get("/api/playback-url", async (req, res) => {
  try {
    const key = decodeURIComponent(safe(req.query.s3Key));
    if (!key) return res.status(400).json({ ok: false, error: "MISSING_s3Key" });
    const url = await signS3(key);
    res.json({ ok: true, url, playbackUrl: url });
  } catch (e) {
    logErr(req, e);
    res.status(500).json({ ok: false, error: errString(e) });
  }
});

// ---------- master save ----------
app.post("/api/master-save", async (req, res) => {
  try {
    const pid = safe(req.body?.projectId);
    const project = req.body?.project;
    if (!pid || !project) return res.status(400).json({ ok: false, error: "MISSING_projectId_OR_project" });

    const snapKey = `storage/projects/${pid}/producer_returns/snapshots/${iso()}.json`;
    const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;

    await putJson(snapKey, project);
    await putJson(latestKey, {
      projectId: pid,
      latestSnapshotKey: snapKey,
      lastMasterSaveAt: new Date().toISOString(),
    });

    res.json({ ok: true, snapshotKey: snapKey });
  } catch (e) {
    logErr(req, e);
    res.status(500).json({ ok: false, error: errString(e) });
  }
});

// ---------- master save latest ----------
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    const projectId = safe(req.params.projectId);
    if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_projectId" });

    const meta = await readJson(`storage/projects/${projectId}/producer_returns/latest.json`);
    res.json({ ok: true, ...meta });
  } catch (e) {
    logErr(req, e);
    res.status(500).json({ ok: false, error: errString(e) });
  }
});

// ---------- publish ----------
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const projectId = safe(req.body?.projectId);
    let snapshotKey = safe(req.body?.snapshotKey);

    if (!projectId && !snapshotKey) {
      return res.status(400).json({ ok: false, error: "MISSING_projectId_AND_snapshotKey" });
    }

    // If snapshotKey not provided, resolve from latest.json
    if (!snapshotKey) {
      if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_projectId" });
      const meta = await readJson(`storage/projects/${projectId}/producer_returns/latest.json`);
      snapshotKey = safe(meta?.latestSnapshotKey);
      if (!snapshotKey) throw new Error("LATEST_snapshotKey_MISSING");
    }

    // Read snapshot from S3
    const rawSnapshot = await readJson(snapshotKey);
    const cleanSnapshot = stripPlaybackUrls(rawSnapshot);

    // Publish artifact
    const shareId = rand(12);
    const publicKey = `public/publish/${shareId}.json`;

    await putJson(publicKey, {
      shareId,
      projectId: projectId || safe(cleanSnapshot?.projectId) || "",
      snapshotKey,
      snapshot: cleanSnapshot,
      createdAt: new Date().toISOString(),
    });

    res.json({
      ok: true,
      shareId,
      snapshotKey,
      publicUrl: `${req.protocol}://${req.get("host")}/publish/${shareId}.json`,
    });
  } catch (e) {
    logErr(req, e);
    res.status(500).json({ ok: false, error: errString(e) });
  }
});

// ---------- publish GET ----------
app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const key = `public/publish/${safe(req.params.shareId)}.json`;
    const json = await readJson(key);
    res.json(json);
  } catch (e) {
    // Keep 404 for not-found, but log for debugging.
    logErr(req, e);
    res.status(404).json({ ok: false });
  }
});

// ---------- root ----------
app.get("/", (_req, res) => {
  res.send("album-backend OK");
});

// ---------- start ----------
const port = Number(PORT || 10000);
app.listen(port, () => {
  console.log(`album-backend listening on ${port}`);
});
