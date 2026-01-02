// server.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const crypto = require("crypto");

const upload = multer({ storage: multer.memoryStorage() });

// storage layer (R2)
const { saveFileToR2, putJson, getJson } = require("./storage");

const app = express();
const port = process.env.PORT || 3000;

// ---------- CORS (REQUIRED FOR FRONTEND) ----------
const ALLOWED_ORIGINS = [
  "https://blackout-web.onrender.com",
  "http://localhost:5173",
  "http://localhost:4173",
];

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server + health checks (no Origin header)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.use(express.json());

// ---------- DATABASE ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ---------- ROOT (frontend ping hits this) ----------
app.get("/", (req, res) => {
  res.status(200).send("album-backend OK");
});

// ---------- VERSION / PROOF (debug routes) ----------
app.get("/api/version", (req, res) => {
  res.json({
    ok: true,
    service: "album-backend",
    commit: process.env.RENDER_GIT_COMMIT || "unknown",
    deployedAt: process.env.RENDER_DEPLOYED_AT || "unknown",
  });
});

app.get("/api/publish-proof", (req, res) => {
  res.json({
    ok: true,
    proof: "publish-proof-v1-album-backend",
    commit: process.env.RENDER_GIT_COMMIT || "unknown",
    deployedAt: process.env.RENDER_DEPLOYED_AT || "unknown",
  });
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

// ---------- MP3 UPLOAD → R2 ----------
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
      console.error("R2 upload failed", err);
      res.status(500).json({ ok: false, error: "UPLOAD_FAILED" });
    }
  }
);

// =======================================================
// MASTER SAVE (WRITE)
// expects { projectId, project }
// writes:
//   storage/projects/{projectId}/producer_returns/snapshots/{ts}.json
//   storage/projects/{projectId}/producer_returns/latest.json
// =======================================================
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
      projectId: String(projectId),
      savedAt: now,
      project,
    });

    await putJson(latestKey, {
      projectId: String(projectId),
      latestSnapshotKey: snapshotKey,
      savedAt: now,
    });

    res.json({ ok: true, snapshotKey, latestKey });
  } catch (err) {
    console.error("master-save error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// =======================================================
// MASTER SAVE (READ BACK)
// GET /api/master-save/latest/:projectId
// =======================================================
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const latestKey = `storage/projects/${projectId}/producer_returns/latest.json`;

    const latest = await getJson(latestKey);
    if (!latest || !latest.latestSnapshotKey) {
      return res.status(404).json({
        ok: false,
        error: "NO_LATEST_FOUND",
        latestKey,
      });
    }

    const snapshot = await getJson(latest.latestSnapshotKey);
    return res.json({ ok: true, latestKey, latest, snapshot });
  } catch (err) {
    console.error("master-save latest error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// =======================================================
// PUBLISH (Option 1 shareId-based)
// POST /api/publish-minisite
// body: { projectId, snapshotKey }
// writes manifest to:
//   storage/public/publish/{shareId}/manifest.json
// =======================================================
function safeString(v) {
  return String(v ?? "").trim();
}

function extractTracksFromSnapshot(snap) {
  const inner = snap?.project || snap?.snapshot || snap || null;
  const songs = Array.isArray(inner?.catalog?.songs) ? inner.catalog.songs : [];

  return songs
    .map((s, idx) => {
      const slot = Number(s?.slot || idx + 1);
      const title = safeString(s?.title) || `Track ${slot}`;

      // use album s3Key if present
      const s3Key = safeString(s?.files?.album?.s3Key) || safeString(s?.files?.a?.s3Key) || safeString(s?.files?.b?.s3Key);
      if (!s3Key) return null;

      return { slot, title, s3Key };
    })
    .filter(Boolean);
}

app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId, snapshotKey } = req.body || {};
    if (!projectId || !snapshotKey) {
      return res.status(400).json({ ok: false, error: "Missing projectId or snapshotKey" });
    }

    // read snapshot json
    const snapWrap = await getJson(snapshotKey);
    if (!snapWrap || typeof snapWrap !== "object") {
      return res.status(400).json({ ok: false, error: "Snapshot not found or invalid JSON at snapshotKey" });
    }

    const tracks = extractTracksFromSnapshot(snapWrap);
    if (!tracks.length) {
      return res.status(400).json({
        ok: false,
        error: "No playable tracks found in snapshot. Expected catalog.songs[*].files.album/a/b.s3Key",
      });
    }

    const shareId = crypto.randomBytes(8).toString("hex");

    const manifest = {
      ok: true,
      version: 1,
      shareId,
      projectId: String(projectId),
      snapshotKey: String(snapshotKey),
      publishedAt: new Date().toISOString(),
      trackCount: tracks.length,
      tracks,
    };

    // Store manifest in R2 under a stable path
    const manifestKey = `storage/public/publish/${shareId}/manifest.json`;
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
// READ-ONLY manifest endpoint (Option 1)
// GET /api/publish/:shareId/manifest
// =======================================================
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const { shareId } = req.params;
    const key = `storage/public/publish/${shareId}/manifest.json`;

    const manifest = await getJson(key);
    if (!manifest) {
      return res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND", shareId });
    }

    res.json({ ok: true, manifest });
  } catch (err) {
    console.error("publish manifest read error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ---------- START ----------
app.listen(port, () => {
  console.log(`album-backend listening on port ${port}`);
});
