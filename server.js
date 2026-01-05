// server.js
import express from "express";
import cors from "cors";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(express.json());

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const AWS_REGION = process.env.AWS_REGION || "us-west-1";
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || "";
const SIGNED_URL_EXPIRES_SECONDS = Number(process.env.SIGNED_URL_EXPIRES_SECONDS || 1200);

// ✅ Your publish writes: public/players/<shareId>/manifest.json
// Keep env override, but default to the correct location.
const PLAYERS_PREFIX = (process.env.PLAYERS_PREFIX || "public/players").replace(/^\/+|\/+$/g, "");

// Optional legacy fallback (older assumption); only used if players path missing.
const LEGACY_PUBLISHED_PREFIX = (process.env.LEGACY_PUBLISHED_PREFIX || "storage/published").replace(
  /^\/+|\/+$/g,
  ""
);

const ALLOWED_ORIGINS = [
  "https://blackout-web.onrender.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser / curl
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      // If you want to lock down later, change this to cb(new Error("Not allowed"), false)
      return cb(null, true);
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

async function s3GetJson({ Bucket, Key }) {
  const cmd = new GetObjectCommand({ Bucket, Key });
  const out = await s3.send(cmd);

  const body = out?.Body;
  if (!body) throw new Error(`S3 missing body for ${Key}`);

  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");

  return JSON.parse(raw);
}

async function readManifest({ bucket, shareId }) {
  // Primary (correct) path
  const primaryKey = `${PLAYERS_PREFIX}/${shareId}/manifest.json`;

  try {
    const m = await s3GetJson({ Bucket: bucket, Key: primaryKey });
    return { manifest: m, keyUsed: primaryKey };
  } catch {
    // Legacy fallback path (only if needed)
    const legacyKey = `${LEGACY_PUBLISHED_PREFIX}/${shareId}/manifest.json`;
    const m = await s3GetJson({ Bucket: bucket, Key: legacyKey });
    return { manifest: m, keyUsed: legacyKey };
  }
}

// ---------- ROUTES ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "album-backend", version: 1 });
});

/**
 * Published manifest
 * Reads from S3: public/players/<shareId>/manifest.json  (default)
 * Returns tracks with s3Key only (no pre-signed urls)
 */
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const { shareId } = req.params;
    if (!shareId) return res.status(400).json({ ok: false, error: "missing shareId" });

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET (or AWS_S3_BUCKET)");

    let m, keyUsed;
    try {
      const out = await readManifest({ bucket, shareId });
      m = out.manifest;
      keyUsed = out.keyUsed;
    } catch (e) {
      // return 404 if missing
      return res.status(404).json({
        ok: false,
        error: `manifest not found at s3://${bucket}/${PLAYERS_PREFIX}/${shareId}/manifest.json`,
      });
    }

    // Your publish result includes: { ok:true, shareId, projectId, publishedAt, tracks:[{slot,title,s3Key,url}] }
    if (!m?.ok || !Array.isArray(m.tracks)) {
      return res.status(404).json({ ok: false, error: "manifest invalid" });
    }

    const tracks = m.tracks
      .map((t) => ({
        slot: Number(t?.slot || 0),
        title: String(t?.title || "").trim(),
        s3Key: String(t?.s3Key || "").trim(),
      }))
      .filter((t) => t.s3Key);

    if (!tracks.length) {
      return res.status(404).json({ ok: false, error: "manifest has no tracks with s3Key" });
    }

    return res.json({
      ok: true,
      version: 1,
      mode: "album",
      shareId: String(m.shareId || shareId),
      projectId: String(m.projectId || ""),
      publishedAt: String(m.publishedAt || ""),
      manifestKey: keyUsed, // useful for debugging
      trackCount: tracks.length,
      tracks,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Sign on demand
 * GET /api/playback-url?s3Key=storage/projects/...mp3
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

app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
  console.log(`AWS_REGION=${AWS_REGION}`);
  console.log(`S3_BUCKET=${S3_BUCKET || "(missing)"}`);
  console.log(`PLAYERS_PREFIX=${PLAYERS_PREFIX}`);
  console.log(`LEGACY_PUBLISHED_PREFIX=${LEGACY_PUBLISHED_PREFIX}`);
  console.log(`SIGNED_URL_EXPIRES_SECONDS=${SIGNED_URL_EXPIRES_SECONDS}`);
});
