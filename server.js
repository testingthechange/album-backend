// server.js
import express from "express";
import cors from "cors";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const AWS_REGION = process.env.AWS_REGION || "us-west-1";
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || "";
const PUBLISH_STORE_DIR = process.env.PUBLISH_STORE_DIR || "./publish_store"; // local json store
const SIGNED_URL_EXPIRES_SECONDS = Number(process.env.SIGNED_URL_EXPIRES_SECONDS || 1200);

// Allow your deployed site + local dev
const ALLOWED_ORIGINS = [
  "https://blackout-web.onrender.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow curl/no-origin
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, true); // loosened to avoid blocking while you iterate
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------- S3 ----------
const s3 = new S3Client({ region: AWS_REGION });

function must(v, msg) {
  if (!v) throw new Error(msg);
  return v;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readPublishManifest(shareId) {
  // You can swap this to PG later; keeping local file store for now.
  const p = path.join(PUBLISH_STORE_DIR, `${shareId}.manifest.json`);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  return safeJsonParse(raw);
}

// ---------- ROUTES ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "album-backend", version: 1 });
});

/**
 * A) PUBLISHED MANIFEST (STABLE)
 * Returns: { ok, shareId, projectId, publishedAt, tracks: [{slot,title,s3Key}] }
 * IMPORTANT: NO pre-signed URLs returned here.
 */
app.get("/api/publish/:shareId/manifest", (req, res) => {
  try {
    const { shareId } = req.params;
    if (!shareId) return res.status(400).json({ ok: false, error: "missing shareId" });

    const m = readPublishManifest(shareId);
    if (!m?.ok || !Array.isArray(m.tracks)) {
      return res.status(404).json({ ok: false, error: "manifest not found" });
    }

    // Strip any accidental url fields (defensive)
    const tracks = m.tracks.map((t) => ({
      slot: Number(t.slot || 0),
      title: String(t.title || "").trim(),
      s3Key: String(t.s3Key || "").trim(),
    }));

    return res.json({
      ok: true,
      version: 1,
      mode: "album",
      shareId: String(m.shareId || shareId),
      projectId: String(m.projectId || ""),
      publishedAt: String(m.publishedAt || ""),
      trackCount: tracks.length,
      tracks,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * A) SIGN ON DEMAND (PER TRACK)
 * GET /api/playback-url?s3Key=storage/projects/...mp3
 * Returns: { ok, url, expiresSeconds }
 */
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = String(req.query.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "missing s3Key" });

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET (or AWS_S3_BUCKET)");

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
    const url = await getSignedUrl(s3, cmd, { expiresIn: SIGNED_URL_EXPIRES_SECONDS });

    return res.json({ ok: true, url, expiresSeconds: SIGNED_URL_EXPIRES_SECONDS });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- START ----------
ensureDir(PUBLISH_STORE_DIR);

app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
  console.log(`S3_BUCKET=${S3_BUCKET || "(missing)"}`);
  console.log(`PUBLISH_STORE_DIR=${PUBLISH_STORE_DIR}`);
});
