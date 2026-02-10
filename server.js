// FILE: server.js
// Full updated server with:
// - CORS that works for browser fetch from https://thirdparty-tz9x.onrender.com
// - GET  /publish/:shareId.json          (reads S3 key public/publish/{shareId}.json)
// - POST /api/publish-minisite           (THIS matches what is live in your prod backend)
// - POST /api/publish                   (alias; same behavior)
// - GET  /api/published/:shareId         (optional manifest wrapper)
// - GET  /manifests/:shareId.json        (optional cached manifest)
//
// IMPORTANT:
// 1) Adjust the 3 import lines below to match your repo paths/names if needed.
// 2) Do NOT change your storage key prefixes unless you know your bucket layout.
// 3) Deploy this to album-backend and retest webshell222 fetch.

import express from "express";
import cors from "cors";

// ---- Adjust these to your repo (keep your existing ones if they differ)
import { readJson, putJson } from "./lib/storage.js";
import { stripPlaybackUrls } from "./lib/stripPlaybackUrls.js";
import { safe, rand, errString, logErr } from "./lib/util.js";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* -------------------------------------------------------------------------- */
/*  CORS (MUST be before routes)                                              */
/* -------------------------------------------------------------------------- */

const ALLOWED = new Set([
  "https://thirdparty-tz9x.onrender.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);

app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || ALLOWED.has(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Ensure preflight always succeeds
app.options("*", cors());

/* -------------------------------------------------------------------------- */
/*  HELPERS (manifest conversion; optional)                                   */
/* -------------------------------------------------------------------------- */

function parseDurationToSec(text) {
  const s = String(text || "").trim();
  const m = s.match(/^(\d+):([0-5]\d)$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function firstS3Key(...candidates) {
  for (const c of candidates) {
    const k = String(c || "").trim();
    if (k) return k;
  }
  return "";
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function ensureCredits(obj) {
  const c = obj && typeof obj === "object" ? obj : {};
  return {
    songwriters: toArray(c.songwriters).map(String).filter(Boolean),
    producers: toArray(c.producers).map(String).filter(Boolean),
    engineers: toArray(c.engineers).map(String).filter(Boolean),
    performers: toArray(c.performers).map(String).filter(Boolean),
  };
}

function convertSnapshotToManifest({ shareId, projectId, snapshotKey, snapshot, publishedAt }) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};

  const albumMeta = snap?.album?.meta || {};
  const albumTitle = String(albumMeta.albumTitle || albumMeta.title || "");
  const artistName = String(albumMeta.artistName || albumMeta.artist || "");

  const coverS3Key = firstS3Key(snap?.album?.cover?.s3Key, snap?.album?.coverKey, snap?.album?.cover?.key);

  // Your published wrapper currently has snapshot.catalog.songs
  const catalogSongs = toArray(snap?.catalog?.songs);
  const metaSongs = toArray(snap?.meta?.songs);

  const tracks = catalogSongs.map((row0, i) => {
    const row = row0 && typeof row0 === "object" ? row0 : {};
    const files = row?.files || {};
    const slot = Number(row?.slot || i + 1);

    const title =
      String(row?.title || "").trim() ||
      String(metaSongs?.[i]?.title || "").trim() ||
      `Song ${i + 1}`;

    const durationText = String(row?.duration || "").trim() || "0:00";
    const durationSec = parseDurationToSec(durationText);

    // Prefer album, then a, then b
    const s3Key = firstS3Key(files?.album?.s3Key, files?.a?.s3Key, files?.b?.s3Key);

    const metaRow = metaSongs?.[i] && typeof metaSongs[i] === "object" ? metaSongs[i] : {};
    const credits = ensureCredits(metaRow?.credits);
    const lyricsText = String(metaRow?.lyrics?.text || metaRow?.lyricsText || "").trim();

    return {
      slot,
      title,
      durationText,
      durationSec,
      audio: { s3Key },
      credits,
      lyrics: { text: lyricsText, s3Key: "" },
    };
  });

  return {
    ok: true,
    shareId: String(shareId || "").trim(),
    projectId: String(projectId || "").trim(),
    lineage: {
      snapshotKey: String(snapshotKey || "").trim(),
      publishedAt: String(publishedAt || new Date().toISOString()),
    },
    album: {
      meta: { albumTitle, artistName },
      cover: { s3Key: coverS3Key },
      trackDurations: tracks.map((t) => ({
        slot: t.slot,
        title: t.title,
        s3Key: t.audio.s3Key,
        durationSec: t.durationSec,
        durationText: t.durationText,
      })),
      tracks,
    },
    nftMix: snap?.nftMix || {},
  };
}

/* -------------------------------------------------------------------------- */
/*  ROUTES                                                                    */
/* -------------------------------------------------------------------------- */

// Root (matches what your prod backend already returns)
app.get("/", (req, res) => res.send("album-backend OK"));

// (Optional) Health endpoint for your own checks
app.get("/health", (req, res) => res.json({ ok: true }));

// Serve published snapshot wrapper (stored in S3)
app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });

    const key = `public/publish/${shareId}.json`;
    const json = await readJson(key);

    return res.json(json);
  } catch (e) {
    logErr(req, e);
    // Important: return 404 so the browser doesn't treat it like a crash
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }
});

// Core publisher (THIS is what your live prod uses)
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

    const shareId = rand(24); // long id (your current prod returns 24 chars)
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

// Alias (so any frontend calling /api/publish also works)
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

// Optional manifest endpoint (useful if you want a stable player-facing shape)
app.get("/api/published/:shareId", async (req, res) => {
  try {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });

    const pubKey = `public/publish/${shareId}.json`;
    const pub = await readJson(pubKey);

    const snapshot = pub?.snapshot;
    const snapshotKey = safe(pub?.snapshotKey);
    const projectId = safe(pub?.projectId || snapshot?.projectId);

    const manifest = convertSnapshotToManifest({
      shareId,
      projectId,
      snapshotKey,
      snapshot,
      publishedAt: pub?.createdAt || new Date().toISOString(),
    });

    // Cache (non-fatal)
    const manifestKey = `public/manifests/${shareId}.json`;
    try {
      await putJson(manifestKey, manifest);
    } catch (e) {
      // ignore
    }

    return res.json({ ok: true, shareId, manifest, manifestUrl: `/manifests/${shareId}.json` });
  } catch (e) {
    logErr(req, e);
    return res.status(404).json({ ok: false, error: errString(e) });
  }
});

// Optional: serve cached manifest
app.get("/manifests/:shareId.json", async (req, res) => {
  try {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });
    const key = `public/manifests/${shareId}.json`;
    const json = await readJson(key);
    return res.json(json);
  } catch (e) {
    logErr(req, e);
    return res.status(404).json({ ok: false });
  }
});

/* -------------------------------------------------------------------------- */
/*  START                                                                     */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
});
