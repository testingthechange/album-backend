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

// Your Project page shows: public/players/<shareId>/manifest.json
const PUBLISHED_PREFIX = (process.env.PUBLISHED_PREFIX || "public/players").replace(/^\/+|\/+$/g, "");

const ALLOWED_ORIGINS = [
  "https://blackout-web.onrender.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
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

function safeStr(v) {
  return String(v ?? "").trim();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safeStr(v);
    if (s) return s;
  }
  return "";
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------- ROUTES ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "album-backend", version: 1 });
});

/**
 * Published manifest
 * Reads: {PUBLISHED_PREFIX}/{shareId}/manifest.json
 *
 * If cover fields are missing, attempts a best-effort fallback read:
 *   {PUBLISHED_PREFIX}/{shareId}/album.bundle.json
 * and extracts cover keys/urls from it.
 */
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const { shareId } = req.params;
    if (!shareId) return res.status(400).json({ ok: false, error: "missing shareId" });

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET (or AWS_S3_BUCKET)");
    const manifestKey = `${PUBLISHED_PREFIX}/${shareId}/manifest.json`;

    let m;
    try {
      m = await s3GetJson({ Bucket: bucket, Key: manifestKey });
    } catch {
      return res.status(404).json({ ok: false, error: `manifest not found at s3://${bucket}/${manifestKey}` });
    }

    const tracksArr = Array.isArray(m?.tracks) ? m.tracks : Array.isArray(m?.album?.tracks) ? m.album.tracks : null;
    if (!tracksArr) return res.status(404).json({ ok: false, error: "manifest invalid (missing tracks)" });

    // cover: read from manifest if available
    let coverS3Key = firstNonEmpty(
      m?.coverS3Key,
      m?.cover?.s3Key,
      m?.album?.coverS3Key,
      m?.album?.coverArtS3Key,
      m?.album?.coverArtKey,
      m?.album?.coverKey
    );

    let coverUrl = firstNonEmpty(m?.coverUrl, m?.cover?.url, m?.album?.coverUrl, m?.album?.coverArtUrl);

    // album meta
    const albumTitle = firstNonEmpty(m?.albumTitle, m?.album?.title, m?.title);
    const artist = firstNonEmpty(m?.artist, m?.album?.artist);

    // If cover missing, try fallback bundle
    if (!coverS3Key && !coverUrl) {
      const bundleKey = `${PUBLISHED_PREFIX}/${shareId}/album.bundle.json`;
      try {
        const b = await s3GetJson({ Bucket: bucket, Key: bundleKey });

        // Pull cover from common bundle shapes
        coverS3Key = firstNonEmpty(
          b?.album?.coverS3Key,
          b?.album?.coverArtS3Key,
          b?.album?.coverArtKey,
          b?.album?.coverKey,
          b?.coverS3Key,
          b?.cover?.s3Key
        );

        coverUrl = firstNonEmpty(
          b?.album?.coverUrl,
          b?.album?.coverArtUrl,
          b?.coverUrl,
          b?.cover?.url
        );
      } catch {
        // best effort only; ignore if not present
      }
    }

    const tracks = tracksArr
      .map((t) => ({
        slot: safeNum(t?.slot || t?.trackNumber || 0),
        title: safeStr(t?.title),
        s3Key: safeStr(t?.s3Key || t?.audioS3Key || t?.audioKey),
        durationSeconds: safeNum(t?.durationSeconds || t?.duration || t?.seconds),
      }))
      .filter((t) => t.s3Key);

    return res.json({
      ok: true,
      version: 1,
      mode: "album",
      shareId: safeStr(m?.shareId || shareId),
      projectId: safeStr(m?.projectId || ""),
      publishedAt: safeStr(m?.publishedAt || m?.createdAt || ""),
      albumTitle,
      artist,
      coverS3Key,
      coverUrl,
      trackCount: tracks.length,
      tracks,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Sign on demand (audio OR cover)
 * GET /api/playback-url?s3Key=public/players/... OR storage/projects/...mp3
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
  console.log(`PUBLISHED_PREFIX=${PUBLISHED_PREFIX}`);
});
