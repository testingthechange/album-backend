// server.js
import express from "express";
import cors from "cors";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(express.json());

// CORS (keep permissive while you’re iterating; tighten later)
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

const PORT = process.env.PORT || 3001;

// ---------- ENV ----------
const AWS_REGION = (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-1").trim();
const S3_BUCKET = (process.env.S3_BUCKET || "").trim();

// Where publish writes the manifest (based on your publish output):
// manifestKey: "public/players/<shareId>/manifest.json"
function manifestKeyForShareId(shareId) {
  return `public/players/${shareId}/manifest.json`;
}

// ---------- S3 ----------
const s3 = new S3Client({ region: AWS_REGION });

async function readJsonFromS3({ bucket, key }) {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const resp = await s3.send(cmd);

  if (!resp?.Body) throw new Error("S3 GetObject missing body");

  const text = await streamToString(resp.Body);
  return JSON.parse(text);
}

function streamToString(body) {
  // AWS SDK v3 Body is a stream in Node
  return new Promise((resolve, reject) => {
    let data = "";
    body.setEncoding("utf8");
    body.on("data", (chunk) => (data += chunk));
    body.on("end", () => resolve(data));
    body.on("error", reject);
  });
}

async function signGetObjectUrl({ bucket, key, expiresInSeconds = 3600 }) {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}

// ---------- ROUTES ----------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "album-backend",
    region: AWS_REGION,
    hasBucket: !!S3_BUCKET,
    time: new Date().toISOString(),
  });
});

/**
 * Manifest endpoint used by blackout-web:
 * GET /api/publish/:shareId/manifest
 *
 * KEY FIX:
 * - Always loads the stored manifest JSON from S3
 * - Ignores any stale `url` fields in it
 * - Re-signs fresh urls from each track's `s3Key` on every request
 */
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const shareId = String(req.params.shareId || "").trim();
    if (!shareId) return res.status(400).json({ ok: false, error: "Missing shareId" });

    if (!S3_BUCKET) {
      return res.status(500).json({ ok: false, error: "Missing env S3_BUCKET" });
    }

    const key = manifestKeyForShareId(shareId);

    const manifest = await readJsonFromS3({ bucket: S3_BUCKET, key });

    // manifest you showed is like:
    // { ok:true, version:1, mode:"album", shareId, projectId, publishedAt, trackCount, tracks:[{slot,title,s3Key,url}] }
    const tracks = Array.isArray(manifest?.tracks) ? manifest.tracks : [];

    // Re-sign from s3Key each time.
    const signedTracks = await Promise.all(
      tracks.map(async (t) => {
        const s3Key = String(t?.s3Key || "").trim();
        if (!s3Key) {
          return {
            ...t,
            url: "",
            _signError: "Missing s3Key",
          };
        }
        const url = await signGetObjectUrl({ bucket: S3_BUCKET, key: s3Key, expiresInSeconds: 3600 });
        return {
          ...t,
          url, // fresh
        };
      })
    );

    const out = {
      ...manifest,
      ok: true,
      shareId,
      tracks: signedTracks,
      trackCount: signedTracks.length,
      signedAt: new Date().toISOString(),
      expiresInSeconds: 3600,
    };

    // Prevent caching so the browser always gets fresh signed URLs
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[album-backend] listening on ${PORT}`);
  console.log(`[album-backend] region=${AWS_REGION} bucket=${S3_BUCKET || "(missing)"}`);
});

