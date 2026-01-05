// album-backend/server.js
import express from "express";
import cors from "cors";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// If you already have a "readJson" helper, use that instead.
// This version reads JSON from S3 using bucket + key.
import { Readable } from "stream";

const app = express();
app.use(express.json());

// ---- CORS (adjust as needed) ----
// Allow your web app origin. You can also set "*" temporarily for debugging.
const allowedOrigins = [
  process.env.WEB_ORIGIN || "https://blackout-web.onrender.com",
];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, true); // keep permissive for now; tighten later
    },
    credentials: true,
  })
);

// ---- ENV ----
const AWS_REGION = process.env.AWS_REGION || "us-west-1";
const S3_BUCKET = process.env.S3_BUCKET; // REQUIRED (the bucket you publish into)

// IMPORTANT: your stored manifests are using keys like:
// public/players/<shareId>/manifest.json
// Make sure this matches what your publisher writes.
function manifestKeyForShareId(shareId) {
  return `public/players/${shareId}/manifest.json`;
}

if (!S3_BUCKET) {
  console.warn("WARNING: Missing env S3_BUCKET");
}

// ---- S3 ----
const s3 = new S3Client({ region: AWS_REGION });

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJsonFromS3(key) {
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    })
  );
  const body = await streamToString(res.Body);
  return JSON.parse(body);
}

async function signGetUrl(key, expiresSeconds = 900) {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }),
    { expiresIn: expiresSeconds }
  );
  return url;
}

// ---- Health ----
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ---- Publish manifest (FIXED: refresh signed URLs every request) ----
// Your blackout-web fetches: `${BACKEND_BASE}/api/publish/${shareId}/manifest`
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const shareId = String(req.params.shareId || "").trim();
    if (!shareId) return res.status(400).json({ ok: false, error: "missing shareId" });
    if (!S3_BUCKET) return res.status(500).json({ ok: false, error: "missing S3_BUCKET env" });

    // Read the stored manifest written at publish time.
    // It should include track entries with at least: { title, s3Key }
    const stored = await readJsonFromS3(manifestKeyForShareId(shareId));

    const tracks = Array.isArray(stored?.tracks) ? stored.tracks : [];
    if (!tracks.length) {
      return res.status(404).json({ ok: false, error: "manifest has no tracks" });
    }

    // Re-sign URLs from s3Key each time so they never expire for the user.
    const signedTracks = await Promise.all(
      tracks.map(async (t) => {
        const s3Key = String(t?.s3Key || "").trim();
        const title = String(t?.title || "").trim() || "Untitled";

        if (!s3Key) {
          return { ...t, title, s3Key: "", url: "" };
        }

        const url = await signGetUrl(s3Key, 900); // 15 min is fine; it refreshes on reload
        return {
          ...t,
          title,
          s3Key,
          url, // fresh presigned url
        };
      })
    );

    // Return a manifest shaped like blackout-web expects:
    // { ok:true, shareId, projectId, publishedAt, tracks:[{title,url,s3Key,slot...}] }
    return res.json({
      ok: true,
      version: stored?.version ?? 1,
      mode: stored?.mode ?? "album",
      shareId,
      projectId: stored?.projectId || "",
      publishedAt: stored?.publishedAt || "",
      trackCount: signedTracks.length,
      tracks: signedTracks,
    });
  } catch (err) {
    console.error("manifest error", err);
    return res.status(500).json({ ok: false, error: "manifest fetch failed" });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
