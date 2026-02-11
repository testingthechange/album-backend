// FILE: server.js
// ✅ Added: Resend-based magic link email send endpoint
// Keeps: your existing CORS + S3 publish + /api/playback-url signing

import express from "express";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Resend } from "resend";

const app = express();
console.log("BOOT: album-backend server.js vINLINE-S3-CORS-ERRWRAP-SIGN-RESEND-2026-02-11");

app.use(express.json({ limit: "20mb" }));

/* -------------------------------------------------------------------------- */
/*  CORS (FORCE for every response, including errors)                         */
/* -------------------------------------------------------------------------- */

const ALLOWED_ORIGINS = new Set([
  "https://thirdparty-tz9x.onrender.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* -------------------------------------------------------------------------- */
/*  Small utils                                                               */
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
  try {
    console.error("ERR", {
      path: req?.path,
      method: req?.method,
      msg: errString(e),
      stack: e?.stack,
    });
  } catch {
    console.error("ERR", errString(e));
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* -------------------------------------------------------------------------- */
/*  AWS / S3                                                                  */
/* -------------------------------------------------------------------------- */

function envFirst(...keys) {
  for (const k of keys) {
    const v = String(process.env[k] || "").trim();
    if (v) return v;
  }
  return "";
}

const AWS_REGION = envFirst("AWS_REGION", "AWS_DEFAULT_REGION") || "us-west-1";
const S3_BUCKET = envFirst("S3_BUCKET", "BUCKET", "AWS_S3_BUCKET", "S3_BUCKET_NAME");

if (!S3_BUCKET) {
  console.warn("WARN: Missing bucket env var. Set S3_BUCKET (or BUCKET/AWS_S3_BUCKET/S3_BUCKET_NAME).");
}

const s3 = new S3Client({ region: AWS_REGION });

async function streamToString(body) {
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

/**
 * Minimal strip: remove obvious signed-url fields (keeps s3Key and data).
 * Also removes previewUrl to avoid publishing already-signed S3 URLs.
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
      if (k === "playbackUrl" || k === "playbackURL" || k === "url" || k === "urls" || k === "previewUrl") {
        delete x[k];
        continue;
      }
      walk(x[k]);
    }
    return x;
  }

  const clone = JSON.parse(JSON.stringify(obj || {}));
  return walk(clone);
}

/* -------------------------------------------------------------------------- */
/*  EMAIL (RESEND)                                                            */
/* -------------------------------------------------------------------------- */

// Env vars expected:
// RESEND_API_KEY=...
// MAIL_FROM="Blackout <noreply@yourdomain.com>"   (must be verified in Resend)
// APP_BASE_URL=https://your-frontend.com          (or http://localhost:5173)

const RESEND_API_KEY = safe(process.env.RESEND_API_KEY);
const MAIL_FROM = safe(process.env.MAIL_FROM) || safe(process.env.RESEND_FROM);
const APP_BASE_URL = safe(process.env.APP_BASE_URL) || "http://localhost:5173";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function isEmail(s) {
  const v = safe(s);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function buildMagicLinkUrl({ projectId, token }) {
  const pid = encodeURIComponent(safe(projectId));
  const t = encodeURIComponent(safe(token));
  // producer shell route: adjust if your app uses a different path
  return `${APP_BASE_URL}/producer?projectId=${pid}&token=${t}`;
}

/* -------------------------------------------------------------------------- */
/*  ROUTES                                                                    */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => res.send("album-backend OK"));

app.get(
  "/health",
  wrap(async (req, res) => {
    res.json({
      ok: true,
      region: AWS_REGION,
      bucketConfigured: !!S3_BUCKET,
      resendConfigured: !!(RESEND_API_KEY && MAIL_FROM),
      appBaseUrl: APP_BASE_URL,
    });
  })
);

/**
 * ✅ SIGNED PLAYBACK URL
 * webshell222 calls:
 *   GET /api/playback-url?s3Key=...
 * and expects:
 *   { ok:true, url, playbackUrl }
 */
app.get(
  "/api/playback-url",
  wrap(async (req, res) => {
    const s3Key = safe(req.query?.s3Key);
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_s3Key" });
    if (!S3_BUCKET) return res.status(500).json({ ok: false, error: "MISSING_S3_BUCKET" });

    const expiresIn = 60 * 20; // 20 minutes

    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }), { expiresIn });

    return res.json({ ok: true, s3Key, url, playbackUrl: url, expiresIn });
  })
);

/**
 * ✅ SEND MAGIC LINK EMAIL (BETA)
 * POST /api/magic-link/send
 * body: { to, projectId, producerName? }
 *
 * NOTE:
 * - This does NOT create any project data.
 * - It only creates a token + stores a minimal record in S3 so you can validate later.
 */
app.post(
  "/api/magic-link/send",
  wrap(async (req, res) => {
    const to = safe(req.body?.to);
    const projectId = safe(req.body?.projectId);
    const producerName = safe(req.body?.producerName);

    if (!to || !isEmail(to)) return res.status(400).json({ ok: false, error: "INVALID_to" });
    if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_projectId" });

    if (!resend || !RESEND_API_KEY) return res.status(500).json({ ok: false, error: "MISSING_RESEND_API_KEY" });
    if (!MAIL_FROM) return res.status(500).json({ ok: false, error: "MISSING_MAIL_FROM" });

    // token + storage (so you can validate later if you want)
    const token = randHex(32);
    const createdAt = new Date().toISOString();

    // Store token record (optional but recommended)
    // You can later use this to validate producer sessions.
    const tokenKey = `storage/projects/${projectId}/magic_links/${token}.json`;
    await putJson(tokenKey, {
      projectId,
      token,
      to,
      producerName,
      createdAt,
      status: "sent",
      appBaseUrl: APP_BASE_URL,
    });

    const url = buildMagicLinkUrl({ projectId, token });

    const subject = `Your producer link${projectId ? ` (Project ${projectId})` : ""}`;
    const greeting = producerName ? `Hi ${producerName},` : "Hi,";
    const text = `${greeting}

Here’s your secure producer link:
${url}

If you didn’t request this, you can ignore this email.`;

    const html = `
      <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;">
        <p>${greeting}</p>
        <p>Here’s your secure producer link:</p>
        <p><a href="${url}" style="font-weight:700;">Open Producer Link</a></p>
        <p style="opacity:.8; font-size:12px; word-break:break-all;">${url}</p>
        <hr style="border:none; border-top:1px solid #eee; margin:16px 0;" />
        <p style="opacity:.7; font-size:12px;">If you didn’t request this, you can ignore this email.</p>
      </div>
    `;

    const out = await resend.emails.send({
      from: MAIL_FROM,
      to,
      subject,
      text,
      html,
    });

    return res.json({
      ok: true,
      projectId,
      to,
      producerName: producerName || "",
      token,
      url,
      resendId: safe(out?.data?.id || ""),
    });
  })
);

app.get(
  "/publish/:shareId.json",
  wrap(async (req, res) => {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });

    const key = `public/publish/${shareId}.json`;
    const json = await readJson(key);
    return res.json(json);
  })
);

app.post(
  "/api/publish-minisite",
  wrap(async (req, res) => {
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
  })
);

// Alias
app.post(
  "/api/publish",
  wrap(async (req, res) => {
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
  })
);

/* -------------------------------------------------------------------------- */
/*  JSON error handler (ensures no Express HTML 500)                           */
/* -------------------------------------------------------------------------- */

app.use((err, req, res, next) => {
  logErr(req, err);

  try {
    applyCors(req, res);
  } catch {}

  if (res.headersSent) return next(err);

  const msg = errString(err);

  if (msg.includes("NoSuchKey") || msg.includes("NotFound") || msg.includes("404") || msg.includes("NOT_FOUND")) {
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }

  return res.status(500).json({ ok: false, error: msg });
});

/* -------------------------------------------------------------------------- */
/*  START                                                                     */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
