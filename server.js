// album-backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

const app = express();
app.set("trust proxy", 1);

const upload = multer({ storage: multer.memoryStorage() });

const ALLOWED_ORIGINS = [
  "https://betablocker.onrender.com",
  "https://smartbridge2.onrender.com",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());
app.use(express.json());

// -------------------------
// TEMP in-memory storage
// NOTE: will reset on redeploy/restart (OK for unblocking)
// -------------------------
const uploadsByS3Key = new Map(); // s3Key -> { id, contentType, buffer }
const uploadsById = new Map(); // id -> { contentType, buffer }

// Master Save temp storage (latest per project)
const latestByProjectId = new Map(); // projectId -> { snapshotKey, latestKey, savedAt, project }

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---- health (what smartbridge expects) ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
});

// ---- master-save (TEMP) ----
// POST /api/master-save
// Body: { projectId, project }
// Returns: { ok:true, snapshotKey, latestKey }
app.post("/api/master-save", async (req, res) => {
  try {
    const { projectId, project } = req.body || {};
    const pid = String(projectId || "").trim();
    if (!pid || !project) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing projectId or project" });
    }

    const now = new Date().toISOString();
    const snapshotKey = `memory://storage/projects/${pid}/producer_returns/snapshots/${isoStamp()}.json`;
    const latestKey = `memory://storage/projects/${pid}/producer_returns/latest.json`;

    latestByProjectId.set(pid, { snapshotKey, latestKey, savedAt: now, project });

    return res.json({ ok: true, snapshotKey, latestKey });
  } catch (err) {
    console.error("master-save error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Optional: read latest (TEMP)
// GET /api/master-save/latest/:projectId
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    const pid = String(req.params.projectId || "").trim();
    const latest = latestByProjectId.get(pid);
    if (!latest) {
      return res.status(404).json({ ok: false, error: "NO_LATEST", projectId: pid });
    }
    return res.json({ ok: true, ...latest });
  } catch (err) {
    console.error("master-save latest error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- upload-to-s3 (TEMP) ----
// Expects multipart form-data: file, s3Key
// Returns: { ok:true, s3Key }
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    const s3Key = String(req.body?.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });
    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

    const id = makeId();
    const contentType = req.file.mimetype || "audio/mpeg";
    const buffer = req.file.buffer;

    uploadsByS3Key.set(s3Key, { id, contentType, buffer });
    uploadsById.set(id, { contentType, buffer });

    return res.json({ ok: true, s3Key });
  } catch (err) {
    console.error("upload-to-s3 error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- playback-url (Smartbridge Catalog expects this) ----
// GET /api/playback-url?s3Key=...
// Returns: { ok:true, url }
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = String(req.query?.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });

    // If already a URL, echo it
    if (/^https?:\/\//i.test(s3Key)) {
      return res.json({ ok: true, url: s3Key });
    }

    const found = uploadsByS3Key.get(s3Key);
    if (!found?.id) {
      return res.status(404).json({ ok: false, error: "UPLOAD_NOT_FOUND_FOR_S3KEY", s3Key });
    }

    const base = `${req.protocol}://${req.get("host")}`;
    const url = `${base}/media/${encodeURIComponent(found.id)}.mp3`;
    return res.json({ ok: true, url });
  } catch (err) {
    console.error("playback-url error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- serve uploaded audio WITH RANGE SUPPORT ----
app.get("/media/:file", (req, res) => {
  const file = String(req.params.file || "");
  const id = file.replace(/\.mp3$/i, "");
  const rec = uploadsById.get(id);

  if (!rec?.buffer) return res.status(404).send("not_found");

  const buf = rec.buffer;
  const total = buf.length;
  const contentType = rec.contentType || "audio/mpeg";

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", total);
    return res.status(200).send(buf);
  }

  const m = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!m) return res.status(416).end();

  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : total - 1;

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start >= total ||
    end >= total ||
    end < start
  ) {
    return res.status(416).end();
  }

  const chunk = buf.subarray(start, end + 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.setHeader("Content-Length", chunk.length);
  return res.send(chunk);
});

// ---- publish demo manifest (unchanged) ----
const manifests = {
  demo: {
    albumTitle: "Demo Album",
    tracks: [
      {
        id: "t1",
        title: "Track 1",
        duration: "3:12",
        previewUrl: "https://album-backend-kmuo.onrender.com/media/track1-preview.mp3",
      },
      {
        id: "t2",
        title: "Track 2",
        duration: "2:58",
        previewUrl: "https://album-backend-kmuo.onrender.com/media/track2-preview.mp3",
      },
      {
        id: "t3",
        title: "Track 3",
        duration: "4:01",
        previewUrl: "https://album-backend-kmuo.onrender.com/media/track3-preview.mp3",
      },
    ],
  },
};

app.get("/publish", (_req, res) => res.json({ shareIds: Object.keys(manifests) }));

app.get("/publish/:shareId.json", (req, res) => {
  const manifest = manifests[req.params.shareId];
  if (!manifest) {
    return res.status(404).json({ error: "not_found", shareId: req.params.shareId });
  }
  return res.json({ shareId: req.params.shareId, ...manifest });
});

app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /api/health or /publish/demo.json");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
