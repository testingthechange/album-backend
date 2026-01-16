// album-backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

const app = express();
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
  })
);

app.use(express.json());

// -------------------------
// TEMP in-memory storage
// NOTE: will reset on redeploy/restart (OK for unblocking)
// -------------------------
/**
 * key: s3Key string (from Catalog)
 * val: { id, contentType, buffer }
 */
const uploadsByS3Key = new Map();
/**
 * key: id string
 * val: { contentType, buffer }
 */
const uploadsById = new Map();

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

// ---- health (what smartbridge expects) ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
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

    // critical: Catalog only needs ok + s3Key
    return res.json({ ok: true, s3Key });
  } catch (err) {
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

    // If already a URL, just echo
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
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- serve uploaded audio ----
app.get("/media/:file", (req, res) => {
  const file = String(req.params.file || "");
  const id = file.replace(/\.mp3$/i, "");
  const rec = uploadsById.get(id);

  if (!rec?.buffer) return res.status(404).send("not_found");

  res.setHeader("Content-Type", rec.contentType || "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(rec.buffer);
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
  if (!manifest) return res.status(404).json({ error: "not_found", shareId: req.params.shareId });
  return res.json({ shareId: req.params.shareId, ...manifest });
});

app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /api/health or /publish/demo.json");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
