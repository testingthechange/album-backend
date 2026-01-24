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
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.set("trust proxy", 1);

const upload = multer({ storage: multer.memoryStorage() });

// ---------- env ----------
const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET } =
  process.env;

const s3 = new S3Client({
  region: AWS_REGION,
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
  })
);

app.use(express.json({ limit: "25mb" }));

// ---------- helpers ----------
const iso = () => new Date().toISOString().replace(/[:.]/g, "-");
const safe = (v) => String(v ?? "").trim();
const rand = (n = 12) => crypto.randomBytes(n).toString("hex");

async function signS3(key, expires = 1200) {
  await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: expires }
  );
}

async function readJson(key) {
  const url = await signS3(key, 60);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function putJson(key, obj) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
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
    const projectId = safe(req.query.projectId || req.body.projectId);
    if (!projectId || !req.file) {
      return res.status(400).json({ ok: false });
    }

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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- playback (runtime) ----------
app.get("/api/playback-url", async (req, res) => {
  try {
    const key = decodeURIComponent(safe(req.query.s3Key));
    if (!key) return res.status(400).json({ ok: false });
    const url = await signS3(key);
    res.json({ ok: true, url, playbackUrl: url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- master save ----------
app.post("/api/master-save", async (req, res) => {
  try {
    const pid = safe(req.body.projectId);
    const project = req.body.project;
    if (!pid || !project) return res.status(400).json({ ok: false });

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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- publish (FIXED) ----------
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const projectId = safe(req.body.projectId);
    let snapshotKey = safe(req.body.snapshotKey);

    if (!snapshotKey) {
      const meta = await readJson(
        `storage/projects/${projectId}/producer_returns/latest.json`
      );
      snapshotKey = meta.latestSnapshotKey;
    }

    const rawSnapshot = await readJson(snapshotKey);
    const cleanSnapshot = stripPlaybackUrls(rawSnapshot);

    const shareId = rand(12);
    const publicKey = `public/publish/${shareId}.json`;

    await putJson(publicKey, {
      shareId,
      projectId,
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- publish GET ----------
app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const key = `public/publish/${safe(req.params.shareId)}.json`;
    const json = await readJson(key);
    res.json(json);
  } catch {
    res.status(404).json({ ok: false });
  }
});

// ---------- root ----------
app.get("/", (_req, res) => {
  res.send("album-backend OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("album-backend listening on", PORT));
