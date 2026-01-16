// album-backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// IMPORTANT: allow both frontends
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

// ---- health (what smartbridge expects) ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
});

// ---- upload-to-s3 (stub to unblock UI) ----
// Expects multipart form-data: file, s3Key
// Returns: { ok:true, s3Key }
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    const s3Key = String(req.body?.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });
    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

    // TODO: replace this stub with real R2/S3 upload.
    // For now we just echo s3Key so Catalog can proceed.
    return res.json({ ok: true, s3Key });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- playback-url (REQUIRED for Catalog to play audio) ----
// Catalog calls: GET /api/playback-url?s3Key=...
// For now: treat s3Key as a URL if it looks like one; otherwise return a safe error.
// This prevents "Upload did not return s3Key" follow-on failures and stops 404s.
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = String(req.query?.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });

    // TEMP behavior:
    // - If s3Key is already a full URL (http/https), return it directly.
    // - Otherwise, we can't sign yet (no R2/S3 wired), so return a clear error (not 404).
    const isUrl = /^https?:\/\/.+/i.test(s3Key);

    if (isUrl) {
      return res.json({ ok: true, url: s3Key });
    }

    return res.status(501).json({
      ok: false,
      error: "PLAYBACK_URL_NOT_IMPLEMENTED",
      note:
        "upload-to-s3 is currently a stub that echoes s3Key. Wire real R2/S3 upload + signing to return a playable URL.",
      s3Key,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- publish demo manifest (your existing contract) ----
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

// root
app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /api/health or /publish/demo.json");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
