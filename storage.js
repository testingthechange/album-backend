// server.js
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const { putJson, getJson, presignGetUrl } = require("./storage");

const app = express();
const port = process.env.PORT || 10000;

// ---------- CORS ----------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.use(express.json({ limit: "50mb" }));

// ---------- HEALTH ----------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// ---------- PUBLISH PROOF ----------
app.get("/api/publish-proof", (_req, res) => {
  res.json({
    ok: true,
    proof: "publish-proof-v1-album-only",
  });
});

// =======================================================
// 🔒 ALBUM-ONLY EXTRACTOR (NO FALLBACK)
// =======================================================
function extractAlbumTracks(project) {
  const albumSongs = Array.isArray(project?.album?.songs)
    ? project.album.songs
    : [];

  return albumSongs
    .map((s, idx) => {
      const slot = Number(s?.slot || idx + 1);
      const title = String(s?.title || `Track ${slot}`).trim();
      const s3Key = String(s?.file?.s3Key || "").trim();

      if (!s3Key) return null;

      return { slot, title, s3Key };
    })
    .filter(Boolean);
}

// =======================================================
// POST /api/publish-minisite
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

    // 🔒 album-only
    const rawTracks = extractAlbumTracks(project);
    if (!rawTracks.length) {
      return res.status(400).json({
        ok: false,
        error: "NO_ALBUM_AUDIO_FOUND",
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
    });
  } catch (err) {
    console.error("publish error", err);
    res.status(500).json({ ok: false, error: String(err) });
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
    res.json(manifest);
  } catch {
    res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND" });
  }
});

// ---------- START ----------
app.listen(port, () => {
  console.log(`album-backend running on ${port}`);
});
