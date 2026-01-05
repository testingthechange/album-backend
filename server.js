// server.js
// album-backend
//
// Fix: NEVER return stale presigned URLs from publish time.
// Instead, store s3Key in the published manifest, and re-sign fresh URLs
// every time the client requests /api/publish/:shareId/manifest.

const express = require("express");
const cors = require("cors");

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.use(express.json());

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;

// Bucket/region for where published artifacts + audio live
const AWS_REGION = process.env.AWS_REGION || "us-west-1";
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || ""; // set this on Render

// Optional: lock down later (for now permissive is fine while debugging)
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// -------------------- S3 --------------------
const s3 = new S3Client({ region: AWS_REGION });

async function streamToString(stream) {
  // AWS SDK v3 GetObjectCommand returns a readable stream in Node
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJsonFromS3(key) {
  const out = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    })
  );
  const body = await streamToString(out.Body);
  return JSON.parse(body);
}

async function signGetUrl(key, expiresSeconds = 900) {
  // keep short (10–15 min) because we can always re-sign on next manifest fetch
  return await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }),
    { expiresIn: expiresSeconds }
  );
}

function safeStr(v) {
  return String(v || "").trim();
}

// Your publisher already writes this shape (you showed it):
// manifestKey: "public/players/<shareId>/manifest.json"
function manifestKeyForShareId(shareId) {
  return `public/players/${shareId}/manifest.json`;
}

// -------------------- ROUTES --------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * IMPORTANT FIX:
 * This endpoint must return FRESH signed URLs.
 *
 * blackout-web calls:
 *   GET ${BACKEND_BASE}/api/publish/:shareId/manifest
 *
 * If your stored manifest already contains "tracks[].s3Key", we re-sign here.
 * If your stored manifest contains old "tracks[].url", we IGNORE it and regenerate.
 */
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const shareId = safeStr(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "missing shareId" });
    if (!S3_BUCKET) return res.status(500).json({ ok: false, error: "missing S3_BUCKET env" });

    const key = manifestKeyForShareId(shareId);
    const stored = await readJsonFromS3(key);

    const storedTracks = Array.isArray(stored?.tracks) ? stored.tracks : [];
    if (!storedTracks.length) {
      return res.status(404).json({ ok: false, error: "manifest has no tracks" });
    }

    const tracks = await Promise.all(
      storedTracks.map(async (t) => {
        const s3Key = safeStr(t?.s3Key);
        const title = safeStr(t?.title) || "Untitled";

        if (!s3Key) {
          // keep shape stable even if bad data
          return { ...t, title, s3Key: "", url: "" };
        }

        // 🔥 regenerate a fresh URL every request
        const url = await signGetUrl(s3Key, 900);

        return {
          ...t,
          title,
          s3Key,
          url,
        };
      })
    );

    // Return the shape blackout-web expects (you pasted earlier)
    res.json({
      ok: true,
      version: stored?.version ?? 1,
      mode: stored?.mode ?? "album",
      shareId,
      projectId: safeStr(stored?.projectId),
      publishedAt: safeStr(stored?.publishedAt),
      trackCount: tracks.length,
      tracks,
    });
  } catch (err) {
    console.error("GET /api/publish/:shareId/manifest failed:", err);
    res.status(500).json({ ok: false, error: "manifest fetch failed" });
  }
});

// -------------------- START --------------------
app.listen(PORT, () => {
  console.log(`album-backend listening on :${PORT}`);
  console.log(`AWS_REGION=${AWS_REGION}`);
  console.log(`S3_BUCKET=${S3_BUCKET || "(missing)"}`);
});
