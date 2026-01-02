// server.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const crypto = require("crypto");

const upload = multer({ storage: multer.memoryStorage() });

// ✅ storage exports
const { saveFileToR2, putJson, getJson, presignGetUrl } = require("./storage");

const app = express();
const port = process.env.PORT || 10000;

// ---------- CORS ----------
const ALLOWED_ORIGINS = [
  "https://blackout-web.onrender.com",
  "http://localhost:5173",
  "http://localhost:4173",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.use(express.json({ limit: process.env.JSON_LIMIT || "60mb" }));

// ---------- DATABASE ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ---------- ROOT ----------
app.get("/", (req, res) => {
  res.status(200).send("album-backend OK");
});

// ---------- HEALTH ----------
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// ---------- PROOF ----------
app.get("/api/publish-proof", (req, res) => {
  res.json({
    ok: true,
    proof: "publish-proof-v2-compat",
    commit: process.env.RENDER_GIT_COMMIT || "unknown",
    deployedAt: process.env.RENDER_DEPLOYED_AT || "unknown",
  });
});

// ---------- VERSION ----------
app.get("/api/version", (req, res) => {
  res.json({
    ok: true,
    service: "album-backend",
    commit: process.env.RENDER_GIT_COMMIT || "unknown",
    deployedAt: process.env.RENDER_DEPLOYED_AT || "unknown",
  });
});

// ---------- META ----------
app.post("/api/projects/:projectId/meta", async (req, res) => {
  const { projectId } = req.params;
  const meta = req.body;

  if (!meta || typeof meta !== "object") {
    return res.status(400).json({ ok: false, error: "NO_META_PAYLOAD" });
  }

  try {
    await pool.query(
      `
      INSERT INTO project_meta (project_id, meta_json)
      VALUES ($1, $2)
      ON CONFLICT (project_id)
      DO UPDATE SET
        meta_json = EXCLUDED.meta_json,
        updated_at = now()
      `,
      [projectId, meta]
    );

    res.json({ ok: true, projectId });
  } catch (err) {
    console.error("Error saving meta", err);
    res.status(500).json({ ok: false, error: "META_SAVE_FAILED" });
  }
});

app.get("/api/projects/:projectId/meta", async (req, res) => {
  const { projectId } = req.params;

  try {
    const result = await pool.query(
      `SELECT meta_json FROM project_meta WHERE project_id = $1`,
      [projectId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, meta: null });
    }

    res.json({ ok: true, meta: result.rows[0].meta_json });
  } catch (err) {
    console.error("Error loading meta", err);
    res.status(500).json({ ok: false, error: "META_LOAD_FAILED" });
  }
});

// ---------- MP3 UPLOAD ----------
app.post(
  "/api/projects/:projectId/songs/:songId/upload",
  upload.single("file"),
  async (req, res) => {
    const { projectId, songId } = req.params;

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "NO_FILE" });
    }

    const key = `projects/${projectId}/songs/${songId}/${req.file.originalname}`;

    try {
      const url = await saveFileToR2({
        key,
        contentType: req.file.mimetype,
        body: req.file.buffer,
      });

      res.json({ ok: true, url });
    } catch (err) {
      console.error("upload failed", err);
      res.status(500).json({ ok: false, error: "UPLOAD_FAILED" });
    }
  }
);

// ---------- MASTER SAVE (WRITE) ----------
app.post("/api/master-save", async (req, res) => {
  try {
    const { projectId, project } = req.body || {};
    if (!projectId || !project) {
      return res.status(400).json({ ok: false, error: "Missing projectId or project" });
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

// ---------- MASTER SAVE (READ LATEST) ----------
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const latestKey = `storage/projects/${projectId}/producer_returns/latest.json`;

    const latest = await getJson(latestKey);
    if (!latest?.latestSnapshotKey) {
      return res.status(404).json({
        ok: false,
        error: "NO_LATEST_FOUND",
        hint: "POST /api/master-save first to create latest.json",
        latestKey,
      });
    }

    const snapshot = await getJson(latest.latestSnapshotKey);
    res.json({ ok: true, latestKey, latest, snapshot });
  } catch (err) {
    console.error("master-save latest error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ---------- PUBLISH HELPERS ----------
function safeStr(v) {
  return String(v ?? "").trim();
}

function extractTracksFromProject(project) {
  const songs = Array.isArray(project?.catalog?.songs) ? project.catalog.songs : [];

  return songs
    .map((s, idx) => {
      const slot = Number(s?.songNumber || s?.slot || idx + 1);
      const title =
        safeStr(s?.title) ||
        safeStr(s?.titleJson?.title) ||
        `Track ${slot}`;

      const vA = safeStr(s?.versions?.A?.s3Key);
      const vB = safeStr(s?.versions?.B?.s3Key);

      const albumKey = safeStr(s?.files?.album?.s3Key);
      const aKey = safeStr(s?.files?.a?.s3Key);
      const bKey = safeStr(s?.files?.b?.s3Key);

      const s3Key = albumKey || vA || vB || aKey || bKey;

      return s3Key ? { slot, title, s3Key } : null;
    })
    .filter(Boolean);
}

// ---------- PUBLISH MINI SITE ----------
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId, snapshotKey } = req.body || {};
    if (!projectId || !snapshotKey) {
      return res.status(400).json({ ok: false, error: "Missing projectId or snapshotKey" });
    }

    const snapWrap = await getJson(snapshotKey);
    const project = snapWrap?.data || snapWrap?.project || snapWrap?.snapshot || null;

    if (!project || typeof project !== "object") {
      return res.status(400).json({ ok: false, error: "Snapshot invalid or missing project data" });
    }

    const tracks = extractTracksFromProject(project);
    if (!tracks.length) {
      return res.status(400).json({
        ok: false,
        error:
          "No playable tracks found (expected catalog.songs[*].versions.A/B.s3Key or files.album/a/b.s3Key)",
      });
    }

    // ✅ add presigned URLs (or public URLs) so frontend can play
    const tracksWithUrls = [];
    for (const t of tracks) {
      const url = await presignGetUrl(t.s3Key, 60 * 20);
      tracksWithUrls.push({ ...t, url });
    }

    const shareId = crypto.randomBytes(8).toString("hex");
    const manifestKey = `public/players/${shareId}/manifest.json`;

    const manifest = {
      ok: true,
      version: 1,
      shareId,
      projectId: String(projectId),
      snapshotKey: String(snapshotKey),
      publishedAt: new Date().toISOString(),
      trackCount: tracksWithUrls.length,
      tracks: tracksWithUrls,
    };

    await putJson(manifestKey, manifest);

    res.json({
      ok: true,
      shareId,
      manifestKey,
      manifestUrl: `/api/publish/${shareId}/manifest`,
    });
  } catch (err) {
    console.error("publish-minisite error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// =======================================================
// ✅ COMPAT ENDPOINT
// GET /api/publish/:shareId/manifest
// Returns BOTH formats:
// 1) New: { ok, tracks, ... }
// 2) Old: { manifest: { album: {...} } }
// =======================================================
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const shareId = String(req.params.shareId || "").trim();
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_SHARE_ID" });

    const manifestKey = `public/players/${shareId}/manifest.json`;
    const stored = await getJson(manifestKey);

    if (!stored) {
      return res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND", shareId });
    }

    // ✅ Build legacy wrapper that blackout-web old build expects:
    // expects: { ok:true, manifest: { album: {...} } }
    const legacyAlbum = {
      id: `published-${stored.shareId}`,
      albumName: "Published Album",
      artist: "Smart Bridge",
      coverUrl: "", // leave blank; frontend can still show fallback cover
      releaseDate: stored.publishedAt ? String(stored.publishedAt).slice(0, 10) : "—",
      tracks: (stored.tracks || []).map((t, i) => ({
        id: `pub-${stored.shareId}-${i}`,
        title: t.title || `Track ${i + 1}`,
        url: t.url || "",
        previewUrl: t.url || "",
        s3Key: t.s3Key || "",
        slot: t.slot || i + 1,
      })),
      isPublished: true,
      shareId: stored.shareId,
    };

    // ✅ respond with BOTH shapes
    res.json({
      ...stored, // ok, version, shareId, tracks[], etc (top-level)
      manifest: { album: legacyAlbum }, // legacy wrapper
    });
  } catch (err) {
    console.error("publish manifest error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ---------- START ----------
app.listen(port, () => {
  console.log(`album-backend listening on port ${port}`);
});
