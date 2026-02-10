// FILE: server.js
// Goal: make /publish/:shareId.json fetchable from https://thirdparty-tz9x.onrender.com.
// This version DOES NOT rely on the cors package for the critical header.
// It FORCE-SETS CORS headers for allowed origins (and handles OPTIONS) before any routes.

import express from "express";
// cors import can stay, but we are not relying on it for the critical header
import cors from "cors";

// ---- KEEP/ADJUST these two imports to match your repo (they must exist)
import { readJson, putJson } from "./lib/storage.js";
import { stripPlaybackUrls } from "./lib/stripPlaybackUrls.js";

const app = express();

// Fingerprint (confirm Render is running THIS file)
console.log("BOOT: album-backend server.js vCORS-FORCED-2026-02-10-1758");

app.use(express.json({ limit: "20mb" }));

/* -------------------------------------------------------------------------- */
/*  FORCED CORS (MUST be before routes)                                       */
/* -------------------------------------------------------------------------- */
/**
 * Your curl test proved ACAO is missing when Origin is present.
 * This middleware hard-sets the headers for known origins so browser fetch works.
 */
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

  // Always set these (safe)
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Preflight
  if (req.method === "OPTIONS") return res.sendStatus(204);

  next();
});

/**
 * Keep cors() as a non-critical helper (optional).
 * If it ever behaves oddly, the forced headers above still make the browser work.
 */
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.has(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* -------------------------------------------------------------------------- */
/*  Small utils (inline so we can't crash on missing util imports)            */
/* -------------------------------------------------------------------------- */

function safe(v) {
  return String(v ?? "").trim();
}

function rand(n = 24) {
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

/* -------------------------------------------------------------------------- */
/*  ROUTES                                                                    */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => res.send("album-backend OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Read published wrapper from S3 at public/publish/{shareId}.json
app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });

    const key = `public/publish/${shareId}.json`;
    const json = await readJson(key);

    return res.json(json);
  } catch (e) {
    logErr(req, e);
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }
});

// Core publisher (matches your prod reality: POST /api/publish-minisite)
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const projectId = safe(req.body?.projectId);
    let snapshotKey = safe(req.body?.snapshotKey);

    if (!projectId && !snapshotKey) {
      return res.status(400).json({ ok: false, error: "MISSING_projectId_AND_snapshotKey" });
    }

    if (!snapshotKey) {
      if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_projectId" });
      const meta = await readJson(`storage/projects/${projectId}/producer_returns/latest.json`);
      snapshotKey = safe(meta?.latestSnapshotKey);
      if (!snapshotKey) throw new Error("LATEST_snapshotKey_MISSING");
    }

    const rawSnapshot = await readJson(snapshotKey);
    const cleanSnapshot = stripPlaybackUrls(rawSnapshot);

    const shareId = rand(24);
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

// Alias (so callers using /api/publish keep working)
app.post("/api/publish", async (req, res) => {
  try {
    const projectId = safe(req.body?.projectId);
    let snapshotKey = safe(req.body?.snapshotKey);

    if (!projectId && !snapshotKey) {
      return res.status(400).json({ ok: false, error: "MISSING_projectId_AND_snapshotKey" });
    }

    if (!snapshotKey) {
      if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_projectId" });
      const meta = await readJson(`storage/projects/${projectId}/producer_returns/latest.json`);
      snapshotKey = safe(meta?.latestSnapshotKey);
      if (!snapshotKey) throw new Error("LATEST_snapshotKey_MISSING");
    }

    const rawSnapshot = await readJson(snapshotKey);
    const cleanSnapshot = stripPlaybackUrls(rawSnapshot);

    const shareId = rand(24);
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

/* -------------------------------------------------------------------------- */
/*  START                                                                     */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
