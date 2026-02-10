// FILE: server.js
// Drop-in server.js that boots without ./lib/storage.js or ./lib/stripPlaybackUrls.js
// Provides:
// - Forced CORS for https://thirdparty-tz9x.onrender.com (+ localhost)
// - GET  /publish/:shareId.json          reads S3 key public/publish/{shareId}.json
// - POST /api/publish-minisite           writes S3 publish wrapper
// - POST /api/publish                   alias
//
// Requires AWS env vars (likely already set in Render):
// - AWS_REGION (or AWS_DEFAULT_REGION)
// - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or IAM role)
// - S3_BUCKET (or BUCKET / AWS_S3_BUCKET / S3_BUCKET_NAME)

import express from "express";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const app = express();
console.log("BOOT: album-backend server.js vINLINE-S3-CORS-2026-02-10-1805");

app.use(express.json({ limit: "20mb" }));

/* -------------------------------------------------------------------------- */
/*  FORCED CORS (must be before routes)                                       */
/* -------------------------------------------------------------------------- */

const ALLOWED_ORIGINS = new Set([
  "https://thirdparty-tz9x.onrender.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* -------------------------------------------------------------------------- */
/*  AWS / S3 helpers                                                          */
/* -------------------------------------------------------------------------- */

function envFirst(...keys) {
  for (const k of keys) {
    const v = String(process.env[k] || "").trim();
    if (v) return v;
  }
  return "";
}

const AWS_REGION =
  envFirst("AWS_REGION", "AWS_DEFAULT_REGION") || "us-west-1"; // fallback only
const S3_BUCKET = envFirst("S3_BUCKET", "AWS_S3_BUCKET", "S3_BUCKET_NAME", "BUCKET");

if (!S3_BUCKET) {
  console.warn("WARN: Missing S3 bucket env var. Set S3_BUCKET (or BUCKET/AWS_S3_BUCKET).");
}

const s3 = new S3Client({ region: AWS_REGION });

async function streamToString(body) {
  // AWS SDK v3 returns ReadableStream/Readable in Node
  if (!body) return "";
  if (typeof body.transformToString === "function") return await body.transformToString();
  return await new Promise((resolve, reject) => {
    const chunks = [];
    body.on("data", (c) => chunks.push(Buffer.from(c)));
    body.on("error", reject);
    body.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function readJson(key) {
  if (!S3_BUCKET) throw new Error("MISSING_S3_BUCKET");
  const out = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const text = await streamToString(out.Body);
  return JSON.parse(text);
}

async function putJson(key, obj) {
  if (!S3_BUCKET) throw new Error("MISSING_S3_BUCKET");
  const body = JSON.stringify(obj);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store",
    })
  );
}

/* -------------------------------------------------------------------------- */
/*  Minimal utils                                                             */
/* -------------------------------------------------------------------------- */

function safe(v) {
  return String(v ?? "").trim();
}

function randHex(n = 24) {
  const chars = "abcdef0123456789";
  let out = "";
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function errString(e) {
  if (!e) return "UNKNOWN";
  if (typeof e === "string") return e;
  return String(e?.message || e);
}

function logErr(req, e) {
  console.error("ERR", {
    path: req?.path,
    method: req?.method,
    msg: errString(e),
    stack: e?.stack,
  });
}

/**
 * Minimal strip: remove fields commonly used to leak signed URLs
 * (keeps s3Key, removes playbackUrl/url fields if present)
 */
function stripPlaybackUrls(obj) {
  const seen = new WeakSet();

  function walk(x) {
    if (!x || typeof x !== "object") return x;
    if (seen.has(x)) return x;
    seen.add(x);

    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return x;
    }

    for (const k of Object.keys(x)) {
      if (k === "playbackUrl" || k === "playbackURL" || k === "url" || k === "urls") {
        // only delete obvious signed-url style fields; keep other structures intact
        delete x[k];
        continue;
      }
      walk(x[k]);
    }
    return x;
  }

  // deep clone to avoid mutating stored snapshots
  const clone = JSON.parse(JSON.stringify(obj || {}));
  return walk(clone);
}

/* -------------------------------------------------------------------------- */
/*  ROUTES                                                                    */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => res.send("album-backend OK"));
app.get("/health", (req, res) => res.json({ ok: true, region: AWS_REGION, bucket: !!S3_BUCKET }));

app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });

    const key = `public/publish/${shareId}.json`;
    const json = await readJson(key);
    return res.json(json);
  } catch (e) {
    logErr(req, e);
    // 404 for missing keys, 500 for real failures
    const msg = errString(e);
    if (msg.includes("NoSuchKey") || msg.includes("NOT_FOUND")) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/publish-minisite", async (req, res) => {
  try {
    const projectId = safe(req.body?.projectId);
    let snapshotKey = safe(req.body?.snapshotKey);

    if (!projectId && !snapshotKey) {
      return res.status(400).json({ ok: false, error: "MISSING_projectId_AND_snapshotKey" });
    }

    if (!snapshotKey) {
      const metaKey = `storage/projects/${projectId}/producer_returns/latest.json`;
      const meta = await readJson(metaKey);
      snapshotKey = safe(meta?.latestSnapshotKey);
      if (!snapshotKey) throw new Error("LATEST_snapshotKey_MISSING");
    }

    const rawSnapshot = await readJson(snapshotKey);
    const cleanSnapshot = stripPlaybackUrls(rawSnapshot);

    const shareId = randHex(24);
    const publicKey = `public/publish/${shareId}.json`;

    await putJson(publicKey, {
      shareId,
      projectId: projectId || safe(cleanSnapshot?.projectId) || "",
      snapshotKey,
      snapshot: cleanSnapshot,
      createdAt: new Date().toISOString(),
    });

    return res.json({
      ok: true,
      shareId,
      snapshotKey,
      publicUrl: `${req.protocol}://${req.get("host")}/publish/${shareId}.json`,
    });
  } catch (e) {
    logErr(req, e);
    return res.status(500).json({ ok: false, error: errString(e) });
  }
});

app.post("/api/publish", async (req, res) => {
  // alias to publish-minisite (duplicate body to keep it simple/robust)
  try {
    const projectId = safe(req.body?.projectId);
    let snapshotKey = safe(req.body?.snapshotKey);

    if (!projectId && !snapshotKey) {
      return res.status(400).json({ ok: false, error: "MISSING_projectId_AND_snapshotKey" });
    }

    if (!snapshotKey) {
      const metaKey = `storage/projects/${projectId}/producer_returns/latest.json`;
      const meta = await readJson(metaKey);
      snapshotKey = safe(meta?.latestSnapshotKey);
      if (!snapshotKey) throw new Error("LATEST_snapshotKey_MISSING");
    }

    const rawSnapshot = await readJson(snapshotKey);
    const cleanSnapshot = stripPlaybackUrls(rawSnapshot);

    const shareId = randHex(24);
    const publicKey = `public/publish/${shareId}.json`;

    await putJson(publicKey, {
      shareId,
      projectId: projectId || safe(cleanSnapshot?.projectId) || "",
      snapshotKey,
      snapshot: cleanSnapshot,
      createdAt: new Date().toISOString(),
    });

    return res.json({
      ok: true,
      shareId,
      snapshotKey,
      publicUrl: `${req.protocol}://${req.get("host")}/publish/${shareId}.json`,
    });
  } catch (e) {
    logErr(req, e);
    return res.status(500).json({ ok: false, error: errString(e) });
  }
});

/* -------------------------------------------------------------------------- */
/*  Global error handler                                                      */
/* -------------------------------------------------------------------------- */

app.use((err, req, res, next) => {
  logErr(req, err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ ok: false, error: errString(err) });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
