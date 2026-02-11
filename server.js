// FILE: server.js
// album-backend server.js (CORS + JSON errors + S3 + signed playback + publish + magic-link via Resend)

import express from "express";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
console.log("BOOT: album-backend server.js vMAGICLINK-RESEND-S3-SIGN-2026-02-11");

app.use(express.json({ limit: "20mb" }));

/* -------------------------------------------------------------------------- */
/*  ENV                                                                        */
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

const RESEND_API_KEY = envFirst("RESEND_API_KEY");
const MAIL_FROM = envFirst("MAIL_FROM") || "Blackout <noreply@smartb4email.onrender.com>";
const APP_BASE_URL = (envFirst("APP_BASE_URL") || "https://smartb4email.onrender.com").replace(/\/+$/, "");

/* -------------------------------------------------------------------------- */
/*  CORS                                                                       */
/* -------------------------------------------------------------------------- */

const ALLOWED_ORIGINS = new Set([
  "https://smartb4email.onrender.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* -------------------------------------------------------------------------- */
/*  Small utils                                                                */
/* -------------------------------------------------------------------------- */

function safe(v) {
  return String(v ?? "").trim();
}

function randHex(n = 32) {
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
/*  AWS / S3                                                                   */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Publish scrub                                                              */
/* -------------------------------------------------------------------------- */

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
/*  Resend                                                                     */
/* -------------------------------------------------------------------------- */

async function sendResendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) throw new Error("MISSING_RESEND_API_KEY");

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to,
      subject,
      html,
    }),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.message || j.error)) || `RESEND_HTTP_${r.status}`);
  return j;
}

/* -------------------------------------------------------------------------- */
/*  ROUTES                                                                     */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => res.type("text").send("album-backend OK. Try /api/health or /publish/<shareId>.json"));

// Keep your existing endpoint
app.get("/api/health", (req, res) => res.json({ ok: true, service: "album-backend" }));

// Alias to reduce confusion
app.get("/health", (req, res) => res.redirect(302, "/api/health"));

/**
 * Signed playback URL for audio + cover.
 * GET /api/playback-url?s3Key=...
 */
app.get(
  "/api/playback-url",
  wrap(async (req, res) => {
    const s3Key = safe(req.query?.s3Key);
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_s3Key" });
    if (!S3_BUCKET) return res.status(500).json({ ok: false, error: "MISSING_S3_BUCKET" });

    const expiresIn = 60 * 20; // 20 min
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }), { expiresIn });
    res.json({ ok: true, s3Key, url, playbackUrl: url, expiresIn });
  })
);

/**
 * Magic link send (beta).
 * POST /api/magic-link/send
 * body: { to, projectId, expiresInMinutes?, dryRun? }
 */
app.post(
  "/api/magic-link/send",
  wrap(async (req, res) => {
    const to = safe(req.body?.to);
    const projectId = safe(req.body?.projectId);
    const dryRun = req.body?.dryRun === true;
    const expiresInMinutes = Number(req.body?.expiresInMinutes || 60 * 24 * 7); // default 7 days

    if (!to) return res.status(400).json({ ok: false, error: "MISSING_to" });
    if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_projectId" });

    const token = randHex(48);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + Math.max(5, expiresInMinutes) * 60 * 1000).toISOString();

    const magicLinkUrl = `${APP_BASE_URL}/minisite?projectId=${encodeURIComponent(projectId)}&token=${encodeURIComponent(
      token
    )}`;

    // Record token in S3 so minisite can validate later.
    // If S3 isn't configured yet, still send the email and return a warning.
    let tokenKey = "";
    let tokenStored = false;
    let tokenStoreWarning = "";

    if (S3_BUCKET) {
      tokenKey = `storage/projects/${projectId}/magic_links/${token}.json`;
      await putJson(tokenKey, { projectId, to, token, createdAt, expiresAt, status: "active" });
      tokenStored = true;
    } else {
      tokenStoreWarning = "S3_BUCKET missing; token not stored (email still sent).";
    }

    const subject = `Your Blackout Producer Link (${projectId})`;
    const html = `
      <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;">
        <h2 style="margin:0 0 12px 0;">Blackout Producer Link</h2>
        <div style="margin:0 0 10px 0; opacity:0.8;">Project ID: <b>${projectId}</b></div>
        <div style="margin:0 0 14px 0;">Click to open your link:</div>
        <div style="margin:0 0 18px 0;">
          <a href="${magicLinkUrl}" style="display:inline-block;padding:10px 14px;border-radius:12px;background:#111;color:#fff;text-decoration:none;">
            Open Producer Mini-site
          </a>
        </div>
        <div style="font-size:12px;opacity:0.7;word-break:break-word;">${magicLinkUrl}</div>
        <div style="margin-top:14px;font-size:12px;opacity:0.7;">Expires: ${expiresAt}</div>
      </div>
    `;

    let resendResult = null;
    if (!dryRun) {
      resendResult = await sendResendEmail({ to, subject, html });
    }

    res.json({
      ok: true,
      to,
      projectId,
      token,
      magicLinkUrl,
      createdAt,
      expiresAt,
      dryRun,
      tokenStored,
      tokenKey,
      tokenStoreWarning,
      resendResult,
    });
  })
);

/**
 * Publish endpoints (kept)
 */
app.get(
  "/publish/:shareId.json",
  wrap(async (req, res) => {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });

    const key = `public/publish/${shareId}.json`;
    const json = await readJson(key);
    res.json(json);
  })
);

app.post(
  "/api/publish-minisite",
  wrap(async (req, res) => {
    const projectId = safe(req.body?.projectId);
    let snapshotKey = safe(req.body?.snapshotKey);

    if (!projectId && !snapshotKey) return res.status(400).json({ ok: false, error: "MISSING_projectId_AND_snapshotKey" });

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

    res.json({
      ok: true,
      shareId,
      snapshotKey,
      publicUrl: `${req.protocol}://${req.get("host")}/publish/${shareId}.json`,
    });
  })
);

app.post("/api/publish", (req, res, next) => app._router.handle(req, res, next));

/* -------------------------------------------------------------------------- */
/*  404 + JSON error handler                                                   */
/* -------------------------------------------------------------------------- */

app.use((req, res) => {
  applyCors(req, res);
  res.status(404).json({ ok: false, error: "NOT_FOUND", path: req.path });
});

app.use((err, req, res, next) => {
  logErr(req, err);
  try {
    applyCors(req, res);
  } catch {}
  if (res.headersSent) return next(err);

  const msg = errString(err);
  const status = msg.includes("NoSuchKey") || msg.includes("NotFound") ? 404 : 500;
  res.status(status).json({ ok: false, error: msg });
});

/* -------------------------------------------------------------------------- */
/*  START                                                                      */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.PORT || 3002);
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
