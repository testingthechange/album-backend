// server.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const crypto = require("crypto");

const upload = multer({ storage: multer.memoryStorage() });

// storage exports: getJson, putJson, presignGetUrl, saveFileToR2
const { saveFileToR2, putJson, getJson, presignGetUrl } = require("./storage");

const app = express();
const port = process.env.PORT || 3000;

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

// ---------- publish-proof ----------
app.get("/api/publish-proof", (req, res) => {
  res.json({
    ok: true,
    proof: "publish-proof-v1-album-backend",
    commit: process.env.RENDER_GIT_COMMIT || "unknown",
    deployedAt: process.env.RENDER_DEPLOYED_AT || "unknown",
  });
});

// ---------- version ----------
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

// ---------- MP3 UPLOAD → S3/R2 ----------
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
      console.error("R2/S3 upload failed", err);
      res.status(500).json({ ok: false, error: "UPLOAD_FAILED" });
    }
  }
);

// ---------- MASTER SAVE (WRITE) ----------
app.post("/api/master-save", async (req, res) => {
  try {
    const { projectId, project } = req.body || {};
    if (!projectId || !project) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing projectId or project" });
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

// =======================================================
// PUBLISH MINI SITE (shareId-based manifest)
// POST /api/publish-minisite
// body: { projectId, snapshotKey }
// - reads snapshot JSON (getJson)
// - extracts tracks from snapshot (supports versions.A/B + files.album/a/b)
// - presigns urls (or uses PUBLIC_FILES_BASE_URL if set)
// - stores manifest at: public/players/<shareId>/manifest.json
// - returns shareId + manifestKey + manifestUrl
// =======================================================
function safeStr(v) {
  return String(v ?? "").trim();
}

function extractTracksFromProject(project) {
  const songs = Array.isArray(project?.catalog?.songs) ? project.catalog.songs : [];

  return songs
    .map((s, idx) => {
      // slot can be songNumber (real schema) or slot or fallback index+1
      const slot = Number(s?.songNumber || s?.slot || idx + 1);

      // title can be title, or titleJson.title, or fallback
      const title =
        safeStr(s?.title) ||
        safeStr(s?.titleJson?.title) ||
        `Track ${slot}`;

      // real schema: versions.A/B.s3Key
      const vA = safeStr(s?.versions?.A?.s3Key);
      const vB = safeStr(s?.versions?.B?.s3Key);

      // legacy schema support: files.album/a/b.s3Key
      const albumKey = safeStr(s?.files?.album?.s3Key);
      const aKey = safeStr(s?.files?.a?.s3Key);
      const bKey = safeStr(s?.files?.b?.s3Key);

      // prefer albumKey, then versions A/B, then a/b
      const s3Key = albumKey || vA || vB || aKey || bKey;

      return s3Key ? { slot, title, s3Key } : null;
    })
    .filter(Boolean);
}

app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId, snapshotKey } = req.body || {};
    if (!projectId || !snapshotKey) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing projectId or snapshotKey" });
    }

    const snapWrap = await getJson(snapshotKey);

    // wrapper shape can be { data: project } OR already a project-ish object
    const project = snapWrap?.data || snapWrap?.project || snapWrap?.snapshot || snapWrap || null;
    if (!project || typeof project !== "object") {
      return res
        .status(400)
        .json({ ok: false, error: "Snapshot invalid or missing project data" });
    }

    const tracks = extractTracksFromProject(project);
    if (!tracks.length) {
      return res.status(400).json({
        ok: false,
        error:
          "No playable tracks found (expected catalog.songs[*].versions.A/B.s3Key or files.album/a/b.s3Key)",
      });
    }

    // add presigned URLs so the frontend can actually play different songs
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
// GET /api/publish/:shareId/manifest
// IMPORTANT: return BOTH shapes:
//  1) top-level { ok, tracks } (new client)
//  2) { manifest: { album: ... } } (older deployed blackout-web expects manifest.album)
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

    const tracks = Array.isArray(stored.tracks) ? stored.tracks : [];

    // Legacy wrapper (minified blackout-web is checking A.manifest.album)
    const album = {
      id: `published-${stored.shareId || shareId}`,
      albumName: "Published Album",
      artist: "Smart Bridge",
      coverUrl: "https://placehold.co/600x600/png?text=cover",
      releaseDate: stored.publishedAt ? String(stored.publishedAt).slice(0, 10) : "—",
      shareId: stored.shareId || shareId,
      isPublished: true,
      tracks: tracks.map((t, i) => ({
        id: `pub-${stored.shareId || shareId}-${i}`,
        title: t.title || `Track ${i + 1}`,
        url: t.url || "",
        previewUrl: t.url || "",
        s3Key: t.s3Key || "",
        slot: t.slot || i + 1,
      })),
    };

    // ✅ Return BOTH
    res.json({
      ok: true,

      // raw fields
      version: stored.version ?? 1,
      shareId: stored.shareId || shareId,
      projectId: stored.projectId,
      snapshotKey: stored.snapshotKey,
      publishedAt: stored.publishedAt,
      trackCount: tracks.length,
      tracks,

      // legacy expected shape
      manifest: { album },
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
