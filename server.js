// server.js (full updated template)
// Replace your existing server.js with this ONLY if your current file is close to this structure.
// If your repo has additional routes/middleware, merge them in carefully.

import express from "express";
import cors from "cors";

// ---- these must already exist in your codebase (keep your existing imports if names differ)
import { readJson, putJson } from "./lib/storage.js"; // adjust path
import { stripPlaybackUrls } from "./lib/stripPlaybackUrls.js"; // adjust path
import { safe, rand, errString, logErr } from "./lib/util.js"; // adjust path

const app = express();

// Body parsing
app.use(express.json({ limit: "20mb" }));

/* -------------------------------------------------------------------------- */
/*  CORS (MUST be before routes so even 500/404 include ACAO header)           */
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
app.options("*", cors());

/* -------------------------------------------------------------------------- */
/*  HELPERS (from your patch)                                                 */
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
/*  ROUTES                                                                     */
/* -------------------------------------------------------------------------- */

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// IMPORTANT: this route is what your frontend error was calling.
// If your backend already has /publish/:id.json, keep only ONE version.
app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });

    const key = `public/publish/${shareId}.json`;
    const json = await readJson(key);

    // Return the published snapshot artifact
    return res.json(json);
  } catch (e) {
    logErr(req, e);
    // If missing, this should be 404 (not 500)
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }
});

// 1) ALIAS: Export.jsx calls /api/publish, backend previously had /api/publish-minisite
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

    const shareId = rand(12);
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

// 2) PUBLISHED MANIFEST: Player.jsx expects GET /api/published/:shareId
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

    // Optional cache write
    const manifestKey = `public/manifests/${shareId}.json`;
    try {
      await putJson(manifestKey, manifest);
    } catch (e) {
      console.warn("WARN: manifest cache write failed:", errString(e));
    }

    return res.json({ ok: true, shareId, manifest, manifestKey, manifestUrl: `/manifests/${shareId}.json` });
  } catch (e) {
    logErr(req, e);
    return res.status(404).json({ ok: false, error: errString(e) });
  }
});

// Optional: serve manifest cache
app.get("/manifests/:shareId.json", async (req, res) => {
  try {
    const shareId = safe(req.params.shareId);
    const key = `public/manifests/${shareId}.json`;
    const json = await readJson(key);
    return res.json(json);
  } catch (e) {
    logErr(req, e);
    return res.status(404).json({ ok: false });
  }
});

/* -------------------------------------------------------------------------- */
/*  START                                                                      */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
});
