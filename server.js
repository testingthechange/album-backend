// server.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { saveFileToR2 } = require("./storage");

const app = express();
const port = process.env.PORT || 3000;

// Postgres pool; Render will use DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(cors());
app.use(express.json());

// health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// ---------- META ENDPOINTS ----------

// save Meta for a project
app.post("/api/projects/:projectId/meta", async (req, res) => {
  const { projectId } = req.params;
  const meta = req.body; // expected to be the full meta JSON

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

// load Meta for a project
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

// ---------- SERVER START ----------

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
