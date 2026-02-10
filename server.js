// FILE: server.js
// Full server.js (drop-in) focused on ONE goal: make /publish/:shareId.json fetchable
// from https://thirdparty-tz9x.onrender.com (CORS) and keep your existing publish flow.
//
// IMPORTANT:
// - Keep your existing readJson/putJson/stripPlaybackUrls imports if your paths differ.
// - This version inlines safe/rand/errString/logErr so you do NOT depend on ./lib/util.js.
// - CORS is permissive for GET/POST/OPTIONS to avoid origin-callback crashes.
// - Adds a global error handler so 500s return JSON (not HTML) and still include CORS headers.

import express from "express";
import cors from "cors";

// ---- KEEP/ADJUST these two imports to match your repo (they must exist)
import { readJson, putJson } from "./lib/storage.js";
import { stripPlaybackUrls } from "./lib/stripPlaybackUrls.js";

const app = express();

// Fingerprint (confirm Render is running THIS file)
console.log("BOOT: album-backend server.js vCORS-2026-02-10-1740");

app.use(express.json({ limit: "20mb" }));

/* -------------------------------------------------------------------------- */
/*  CORS (MUST be before routes)                                              */
/* -------------------------------------------------------------------------- */
/**
 * Why permissive here:
 * - Your published artifacts are public JSON.
 * - Your browser fetch must work cross-origin.
 * - This avoids misconfigured origin callbacks that can throw and cause 500.
 */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));

/* -------------------------------------------------------------------------- */
/*  Small utils (inline so we can't crash on missing util imports)            */
/* -------------------------------------------------------------------------- */

function safe(v) {
  return String(v ?? "").trim();
}

function rand(n = 24) {
  // hex string length n
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
    // If missing or unreadable, return 404 so frontend can show a clear error
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
  // Same behavior as /api/publish-minisite
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
/*  Global error handler (prevents Express HTML 500 pages)                    */
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

// Hard-crash visibility in Render logs
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
