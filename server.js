// server.js — album-backend (AWS S3) — album-only publish + playback-url + upload-to-s3

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage() });

const { putJson, getJson, presignGetUrl, putObjectToS3 } = require("./storage");

const app = express();
const port = process.env.PORT || 10000;

// ---------- CORS ----------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "50mb" }));

// ---------- HEALTH ----------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// ---------- PUBLISH PROOF ----------
app.get("/api/publish-proof", (_req, res) => {
  res.json({ ok: true, proof: "publish-proof-v1-album-only" });
});

// =======================================================
// POST /api/upload-to-s3
// multipart/form-data with field "file"
// expects projectId either as:
//  - form field: projectId
//  - or query: ?projectId=...
// writes into: storage/projects/<projectId>/catalog/uploads/<ts>_<rand>_<name>
// returns: { ok:true, s3Key }
// =======================================================
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || req.query?.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

    const safeName = String(req.file.originalname || "upload.bin").replace(/[^\w.\-]+/g, "_");
    const rand = crypto.randomBytes(6).toString("hex");
    const key = `storage/projects/${projectId}/catalog/uploads/${Date.now()}_${rand}_${safeName}`;

    await putObjectToS3({
      key,
      body: req.file.buffer,
      contentType: req.file.mimetype || "application/octet-stream",
    });

    res.json({ ok: true, s3Key: key });
  } catch (err) {
    console.error("upload-to-s3 error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// =======================================================
// GET /api/playback-url?s3Key=...
// returns a short-lived signed URL to play an S3 object
// =======================================================
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = String(req.query?.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });

    const url = await presignGetUrl(s3Key, 60 * 20); // 20 minutes
    res.json({ ok: true, s3Key, url });
  } catch (err) {
    console.error("playback-url error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// =======================================================
// MASTER SAVE (writes snapshot + latest pointer)
// =======================================================
app.post("/api/master-save", async (req, res) => {
  try {
    const { projectId, project } = req.body || {};
    if (!projectId || !project) {
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT" });
    }

    const now = new Date().toISOString();
    const ts = now.replace(/[:.]/g, "-");

    const snapshotKey = `storage/projects/${projectId}/producer_returns/snapshots/${ts}.json`;
    const latestKey = `storage/projects/${projectId}/producer_returns/latest.json`;

    await putJson(snapshotKey, {
      projectId,
      createdAt: now,
      source: "minisite-master-save",
      data: project,
    });

    await putJson(latestKey, {
      projectId,
      latestSnapshotKey: snapshotKey,
      lastMasterSaveAt: now,
    });

    res.json({ ok: true, snapshotKey, latestKey });
  } catch (err) {
    console.error("master-save error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// =======================================================
// MASTER SAVE LATEST (reads latest pointer + snapshot)
// GET /api/master-save/latest/:projectId
// =======================================================
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const latestKey = `storage/projects/${projectId}/producer_returns/latest.json`;

    const latest = await getJson(latestKey);
    const snapKey =
      String(latest?.latestSnapshotKey || "").trim() ||
      String(latest?.snapshotKey || "").trim();

    if (!snapKey) {
      return res.status(404).json({ ok: false, error: "NO_LATEST_SNAPSHOT_KEY", latestKey });
    }

    const snapshot = await getJson(snapKey);
    if (!snapshot) {
      return res.status(404).json({ ok: false, error: "SNAPSHOT_NOT_FOUND", snapKey });
    }

    res.json({ ok: true, latestKey, latest, snapshot });
  } catch (err) {
    console.error("master-save latest error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// =======================================================
// 🔒 ALBUM-ONLY EXTRACTOR (keeps album order)
// =======================================================
function extractAlbumTracks(project) {
  const albumSongs = Array.isArray(project?.album?.songs) ? project.album.songs : [];

  const pickS3Key = (s) => {
    if (s?.file?.s3Key) return String(s.file.s3Key).trim();
    if (s?.s3Key) return String(s.s3Key).trim();
    if (s?.audioS3Key) return String(s.audioS3Key).trim();
    if (s?.audioKey) return String(s.audioKey).trim();
    if (s?.file?.key) return String(s.file.key).trim();
    if (s?.fileKey) return String(s.fileKey).trim();
    if (s?.files?.album?.s3Key) return String(s.files.album.s3Key).trim();
    return "";
  };

  return albumSongs
    .map((s, idx) => {
      const slot = Number(s?.slot ?? idx + 1);
      const title = String(s?.title || `Track ${slot}`).trim();
      const s3Key = pickS3Key(s);
      if (!s3Key) return null;
      return { slot, title, s3Key };
    })
    .filter(Boolean);
}

// =======================================================
// POST /api/publish-minisite (ALBUM MODE ONLY)
// =======================================================
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId, snapshotKey } = req.body || {};
    if (!projectId || !snapshotKey) {
      return res.status(400).json({ ok: false, error: "MISSING_INPUT" });
    }

    const snap = await getJson(snapshotKey);
    const project = snap?.data;

    if (!project) {
      return res.status(400).json({ ok: false, error: "INVALID_SNAPSHOT" });
    }

    const rawTracks = extractAlbumTracks(project);
    if (!rawTracks.length) {
      return res.status(400).json({
        ok: false,
        error: "NO_ALBUM_AUDIO_FOUND",
        hint: "Expected album.songs[*] to include an s3Key (e.g. song.file.s3Key)",
      });
    }

    const tracks = [];
    for (const t of rawTracks) {
      const url = await presignGetUrl(t.s3Key, 60 * 20);
      tracks.push({ ...t, url });
    }

    const shareId = crypto.randomBytes(8).toString("hex");
    const manifestKey = `public/players/${shareId}/manifest.json`;

    const manifest = {
      ok: true,
      version: 1,
      mode: "album",
      shareId,
      projectId,
      publishedAt: new Date().toISOString(),
      trackCount: tracks.length,
      tracks,
    };

    await putJson(manifestKey, manifest);

    res.json({
      ok: true,
      shareId,
      manifestKey,
      manifestUrl: `/api/publish/${shareId}/manifest`,
      publicUrl: `https://blackout-web.onrender.com/shop/product/${shareId}`,
    });
  } catch (err) {
    console.error("publish error", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// =======================================================
// GET /api/publish/:shareId/manifest
// =======================================================
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const shareId = req.params.shareId;
    const key = `public/players/${shareId}/manifest.json`;
    const manifest = await getJson(key);

    if (!manifest) {
      return res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND" });
    }

    res.json(manifest);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ---------- START ----------
app.listen(port, () => {
  console.log(`album-backend running on ${port}`);
});
