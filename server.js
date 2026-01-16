// album-backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.set("trust proxy", 1);

// Crash visibility (Render sometimes only shows "exited early" otherwise)
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION", reason);
  process.exit(1);
});

const upload = multer({ storage: multer.memoryStorage() });

// ---- env ----
const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET } =
  process.env;

const REQUIRED = ["AWS_REGION", "S3_BUCKET"];
for (const k of REQUIRED) {
  if (!process.env[k]) console.error(`Missing required env var: ${k}`);
}

const s3 = new S3Client({
  region: AWS_REGION,
  // If running on Render with an IAM role, credentials can be omitted.
  // If you are using explicit keys, keep them here.
  credentials:
    AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const ALLOWED_ORIGINS = [
  "https://smartbridge2.onrender.com",
  "https://betablocker.onrender.com",
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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// IMPORTANT: preflight must use the same CORS config
app.options("*", cors());
app.use(express.json());

// ---- helpers ----
function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function randId(n = 12) {
  return crypto.randomBytes(n).toString("hex");
}
// kept for parity even if unused
void randId;

function safeFileName(name) {
  const raw = String(name || "file");
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
function guessContentType(file) {
  const mt = String(file?.mimetype || "").toLowerCase();
  return mt || "audio/mpeg";
}
function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || ""));
}

// ---- health ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
});

// ---- debug (TEMP) ----
app.get("/api/debug/s3", (_req, res) => {
  res.json({
    ok: true,
    region: AWS_REGION || null,
    bucket: S3_BUCKET || null,
    hasExplicitKeys: Boolean(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY),
    node: process.version,
  });
});

// ---- upload-to-s3 (REAL S3) ----
// POST /api/upload-to-s3?projectId=...
// multipart form-data: file, s3Key
// Returns: { ok:true, s3Key, url }
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    const projectId = String(req.query?.projectId || "").trim();
    if (!projectId)
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    const file = req.file;
    if (!file?.buffer)
      return res.status(400).json({ ok: false, error: "NO_FILE" });

    // MUST honor frontend-provided s3Key (so playback-url matches)
    let s3Key = String(req.body?.s3Key || "").trim();

    if (!s3Key) {
      const fn = safeFileName(file.originalname || "audio.mp3");
      s3Key = `storage/projects/${projectId}/catalog/uploads/${isoStamp()}__${fn}`;
    }

    const contentType = guessContentType(file);

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: file.buffer,
        ContentType: contentType,
        CacheControl: "no-store",
      })
    );

    // Convenience: return a signed URL immediately
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
      { expiresIn: 60 * 20 } // 20 minutes
    );

    return res.json({ ok: true, s3Key, url });
  } catch (err) {
    console.error("upload-to-s3 error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- playback-url (SIGNED S3 GET) ----
// GET /api/playback-url?s3Key=...
// Returns: { ok:true, url }
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = String(req.query?.s3Key || "").trim();
    if (!s3Key)
      return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });

    // allow demo URLs
    if (isHttpUrl(s3Key)) return res.json({ ok: true, url: s3Key });

    // confirm exists
    try {
      await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    } catch (e) {
      const name = String(e?.name || "");
      const http = e?.$metadata?.httpStatusCode;

      if (name === "AccessDenied" || http === 403) {
        return res.status(403).json({
          ok: false,
          error: "S3_ACCESS_DENIED",
          s3Key,
          aws: {
            name,
            httpStatusCode: http,
            message: String(e?.message || ""),
          },
        });
      }

      return res.status(404).json({
        ok: false,
        error: "UPLOAD_NOT_FOUND_FOR_S3KEY",
        s3Key,
        aws: {
          name,
          httpStatusCode: http,
          message: String(e?.message || ""),
        },
      });
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
      { expiresIn: 60 * 20 } // 20 minutes
    );

    return res.json({ ok: true, url });
  } catch (err) {
    console.error("playback-url error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- master-save (S3 JSON) ----
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
    const ts = isoStamp();

    const snapshotKey = `storage/projects/${pid}/producer_returns/snapshots/${ts}.json`;
    const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;

    const snapshotBody = JSON.stringify(
      { projectId: pid, createdAt: now, source: "minisite-master-save", data: project },
      null,
      2
    );

    const latestBody = JSON.stringify(
      { projectId: pid, latestSnapshotKey: snapshotKey, lastMasterSaveAt: now },
      null,
      2
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: snapshotKey,
        Body: snapshotBody,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      })
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: latestKey,
        Body: latestBody,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      })
    );

    return res.json({ ok: true, snapshotKey, latestKey });
  } catch (err) {
    console.error("master-save error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- master-save latest (S3 JSON) ----
// GET /api/master-save/latest/:projectId
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    const pid = String(req.params.projectId || "").trim();
    if (!pid) return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;

    // fetch latest.json
    let latestJson;
    try {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: latestKey }),
        { expiresIn: 60 }
      );
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      latestJson = await r.json();
    } catch (_e) {
      return res.status(404).json({ ok: false, error: "NO_LATEST", latestKey });
    }

    const snapKey =
      String(latestJson?.latestSnapshotKey || "").trim() ||
      String(latestJson?.snapshotKey || "").trim();

    if (!snapKey) {
      return res
        .status(404)
        .json({ ok: false, error: "NO_LATEST_SNAPSHOT_KEY", latestKey });
    }

    // fetch snapshot
    let snapshotJson;
    try {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: snapKey }),
        { expiresIn: 60 }
      );
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      snapshotJson = await r.json();
    } catch (_e) {
      return res
        .status(404)
        .json({ ok: false, error: "SNAPSHOT_NOT_FOUND", snapshotKey: snapKey });
    }

    return res.json({ ok: true, latestKey, latest: latestJson, snapshot: snapshotJson });
  } catch (err) {
    console.error("master-save latest error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- publish minisite (S3 JSON manifest) ----
// POST /api/publish-minisite
// Body: { projectId: string }
// Returns: { ok:true, shareId, manifestKey, publicUrl, snapshotKey }
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId } = req.body || {};
    const pid = String(projectId || "").trim();
    if (!pid) return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;

    // fetch latest.json
    let latestJson;
    try {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: latestKey }),
        { expiresIn: 60 }
      );
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      latestJson = await r.json();
    } catch (_e) {
      return res.status(404).json({ ok: false, error: "NO_LATEST_MASTER_SAVE", latestKey });
    }

    const snapshotKey =
      String(latestJson?.latestSnapshotKey || "").trim() ||
      String(latestJson?.snapshotKey || "").trim();

    if (!snapshotKey) {
      return res.status(404).json({ ok: false, error: "NO_SNAPSHOT_KEY", latestKey });
    }

    // fetch snapshot
    let snapshotJson;
    try {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: snapshotKey }),
        { expiresIn: 60 }
      );
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      snapshotJson = await r.json();
    } catch (_e) {
      return res.status(404).json({ ok: false, error: "SNAPSHOT_NOT_FOUND", snapshotKey });
    }

    // master-save stores data under {data: project}
    const project = snapshotJson?.data || {};
    const album = project?.album || {};
    const tracks = Array.isArray(album?.tracks) ? album.tracks : [];

    const shareId = `share_${isoStamp()}_${crypto.randomBytes(3).toString("hex")}`;
    const manifestKey = `public/players/${shareId}/manifest.json`;

    const manifest = {
      ok: true,
      shareId,
      projectId: pid,
      createdAt: new Date().toISOString(),
      snapshotKey,
      albumTitle: String(album?.albumTitle || album?.title || project?.projectName || "Album"),
      tracks: tracks.map((t, i) => ({
        id: String(t?.id || `t${i + 1}`),
        slot: Number(t?.slot || i + 1),
        title: String(t?.title || `Track ${i + 1}`),
        playbackUrl: String(t?.playbackUrl || ""),
        s3Key: String(t?.s3Key || ""),
        durationSec: Number(t?.durationSec || 0) || 0,
      })),
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: manifestKey,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      })
    );

    // Return a signed URL for the manifest (works even if bucket is private)
    const publicUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: manifestKey }),
      { expiresIn: 60 * 60 } // 1 hour
    );

    return res.json({ ok: true, shareId, manifestKey, publicUrl, snapshotKey });
  } catch (err) {
    console.error("publish-minisite error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
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

// root
app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /api/health or /publish/demo.json");
});

const PORT = process.env.PORT || 3000;

console.log("Starting album-backend...", {
  node: process.version,
  port: PORT,
  region: AWS_REGION || null,
  bucket: S3_BUCKET || null,
});

app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
