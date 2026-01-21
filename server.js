// album-backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import path from "path";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.set("trust proxy", 1);

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

if (!AWS_REGION) console.error("Missing required env var: AWS_REGION");
if (!S3_BUCKET) console.error("Missing required env var: S3_BUCKET");

const s3 = new S3Client({
  region: AWS_REGION,
  credentials:
    AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

// ---- CORS ----
const ALLOWED_ORIGINS = [
  "https://smartbridge2.onrender.com",
  "https://betablocker.onrender.com",
  "https://webshell-tm0u.onrender.com",
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

app.options("*", cors());
app.use(express.json());

// ---- helpers ----
function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function safeString(v) {
  return String(v ?? "").trim();
}
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || ""));
}
// IMPORTANT: any "masterSnapshot_*" is NOT an S3 key. Treat as invalid.
function isBogusSnapshotKey(k) {
  const s = safeString(k);
  if (!s) return true;
  if (s.startsWith("masterSnapshot_")) return true;
  if (!s.includes("/") || !s.endsWith(".json")) return true;
  return false;
}

async function readJsonFromS3Key(key, expiresInSec = 60) {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function signS3Key(key, expiresInSec = 60 * 20) {
  await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
}

// ---- health ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "album-backend" });
});

/* =========================================================
   LEGACY SHIMS (Smartbridge expects these)
   - POST /api/upload-to-s3?projectId=...
   - GET  /api/playback-url?s3Key=...
========================================================= */

// Smartbridge upload shim
// Expects multipart/form-data with file field "file"
// Returns: { ok:true, projectId, s3Key, playbackUrl }
app.post("/api/upload-to-s3", upload.single("file"), async (req, res) => {
  try {
    const projectId = safeString(req.query?.projectId || req.body?.projectId);
    if (!projectId) {
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });
    }

    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, error: "MISSING_FILE" });
    }

    const original = safeString(file.originalname || "upload.bin");
    const ext = path.extname(original) || "";
    const base = original.replace(ext, "").replace(/\s+/g, "_").slice(0, 80);

    // If Smartbridge sends song slot or id, keep it; otherwise default song_1
    const songId =
      safeString(req.query?.songId || req.body?.songId || req.query?.slot || "")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 32) || "song_1";

    // If Smartbridge sends "kind" (album/preview/etc) keep it; default "album"
    const kind =
      safeString(req.query?.kind || req.body?.kind || "album")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 24) || "album";

    const key = `storage/projects/${projectId}/catalog/uploads/${songId}/${kind}/${isoStamp()}__${base}${ext}`;

    const contentType =
      safeString(file.mimetype) || "application/octet-stream";

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: contentType,
        CacheControl: "no-store",
      })
    );

    const playbackUrl = await signS3Key(key, 60 * 20);

    return res.json({
      ok: true,
      projectId,
      s3Key: key,
      playbackUrl,
    });
  } catch (err) {
    console.error("upload-to-s3 error", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

// Smartbridge playback shim
// GET /api/playback-url?s3Key=storage/projects/.../file.mp3
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3KeyRaw = safeString(req.query?.s3Key || "");
    if (!s3KeyRaw) {
      return res.status(400).json({ ok: false, error: "MISSING_S3_KEY" });
    }

    const s3Key = decodeURIComponent(s3KeyRaw);
    const playbackUrl = await signS3Key(s3Key, 60 * 20);

    return res.json({ ok: true, s3Key, playbackUrl });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("NotFound") || msg.includes("404")) {
      return res.status(404).json({ ok: false, error: "S3_OBJECT_NOT_FOUND" });
    }
    console.error("playback-url error", err);
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* =========================================================
   EXISTING API (newer / structured)
========================================================= */

// ---- master-save (S3 JSON) ----
// POST /api/master-save
// Body: { projectId, project }
// Returns: { ok:true, snapshotKey, latestKey }
app.post("/api/master-save", async (req, res) => {
  try {
    const { projectId, project } = req.body || {};
    const pid = safeString(projectId);
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
      {
        projectId: pid,
        createdAt: now,
        source: "minisite-master-save",
        data: project,
      },
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
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- master-save latest ----
// GET /api/master-save/latest/:projectId
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    const pid = safeString(req.params.projectId);
    if (!pid)
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;

    let latestJson;
    try {
      latestJson = await readJsonFromS3Key(latestKey, 60);
    } catch (_e) {
      return res.status(404).json({ ok: false, error: "NO_LATEST", latestKey });
    }

    const snapshotKey =
      safeString(latestJson?.latestSnapshotKey) ||
      safeString(latestJson?.snapshotKey);

    if (!snapshotKey) {
      return res.status(404).json({
        ok: false,
        error: "NO_LATEST_SNAPSHOT_KEY",
        latestKey,
      });
    }

    let snapshotJson;
    try {
      snapshotJson = await readJsonFromS3Key(snapshotKey, 60);
    } catch (_e) {
      return res
        .status(404)
        .json({ ok: false, error: "SNAPSHOT_NOT_FOUND", snapshotKey });
    }

    return res.json({
      ok: true,
      latestKey,
      latest: latestJson,
      snapshot: snapshotJson,
    });
  } catch (err) {
    console.error("master-save latest error", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- publish helpers ----
function deriveTracksFromSnapshotData(data) {
  const songs = Array.isArray(data?.catalog?.songs) ? data.catalog.songs : [];
  const out = [];

  for (const s of songs) {
    const slot = safeNum(s?.slot);
    if (!slot) continue;

    const title = safeString(s?.title) || `Track ${slot}`;
    const fAlbum = s?.files?.album || {};
    const s3Key = safeString(fAlbum?.s3Key);
    const playbackUrl = safeString(fAlbum?.playbackUrl);

    if (!s3Key && !playbackUrl) continue;

    out.push({
      slot,
      title,
      s3Key,
      playbackUrl,
      durationSec: safeNum(fAlbum?.durationSec || 0),
    });
  }

  return out;
}

async function signTrackPlaybackUrl(track) {
  const s3Key = safeString(track?.s3Key);
  if (s3Key && !isHttpUrl(s3Key)) {
    return signS3Key(s3Key, 60 * 20);
  }
  const u = safeString(track?.playbackUrl) || safeString(track?.s3Key);
  return isHttpUrl(u) ? u : "";
}

function deriveAlbumMetaFromSnapshotData(data) {
  const albumMeta = data?.album?.meta || {};
  const albumCover = data?.album?.cover || {};

  const albumTitle =
    safeString(albumMeta?.albumTitle) || safeString(data?.albumTitle) || "Album";

  const artistName = safeString(albumMeta?.artistName) || "";
  const releaseDate = safeString(albumMeta?.releaseDate) || "";

  const coverUrl =
    safeString(albumCover?.s3Key) ||
    safeString(albumCover?.previewUrl) ||
    safeString(albumCover?.url) ||
    safeString(data?.coverUrl) ||
    "";

  return {
    albumTitle,
    meta: { albumTitle, artistName, releaseDate },
    coverUrl,
  };
}

/* =======================
   PUBLISH
======================= */

app.post("/api/publish-minisite", async (req, res) => {
  try {
    const projectId = safeString(req.body?.projectId);
    let snapshotKey = safeString(req.body?.snapshotKey);

    if (!projectId) {
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });
    }

    if (!snapshotKey || isBogusSnapshotKey(snapshotKey)) {
      const latestKey = `storage/projects/${projectId}/producer_returns/latest.json`;
      const latest = await readJsonFromS3Key(latestKey, 60);
      snapshotKey = safeString(latest?.latestSnapshotKey) || "";
    }

    if (!snapshotKey || isBogusSnapshotKey(snapshotKey)) {
      return res
        .status(404)
        .json({ ok: false, error: "NO_LATEST_SNAPSHOT_KEY" });
    }

    const snapshot = await readJsonFromS3Key(snapshotKey, 60);

    const data =
      (snapshot && typeof snapshot === "object" ? snapshot.data : null) ||
      snapshot?.project ||
      null;

    if (!data || typeof data !== "object") {
      return res
        .status(500)
        .json({ ok: false, error: "SNAPSHOT_MISSING_DATA", snapshotKey });
    }

    const createdAt =
      safeString(snapshot?.createdAt) || new Date().toISOString();
    const shareId = `share_${isoStamp()}_${crypto
      .randomBytes(3)
      .toString("hex")}`;

    const { albumTitle, meta, coverUrl } = deriveAlbumMetaFromSnapshotData(data);

    // ---- COPY COVER INTO PUBLIC PLAYER ----
    const publicCoverKey = `public/players/${shareId}/cover.png`;
    const publicCoverUrl = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${publicCoverKey}`;

    if (coverUrl && !isHttpUrl(coverUrl)) {
      const sourceKey = coverUrl;

      await s3.send(
        new HeadObjectCommand({
          Bucket: S3_BUCKET,
          Key: sourceKey,
        })
      );

      await s3.send(
        new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: `${S3_BUCKET}/${sourceKey}`,
          Key: publicCoverKey,
          ContentType: "image/png",
          CacheControl: "public, max-age=31536000, immutable",
        })
      );
    }

    const tracksRaw = deriveTracksFromSnapshotData(data);
    const tracks = await Promise.all(
      tracksRaw.map(async (t) => ({
        slot: safeNum(t.slot),
        title: safeString(t.title) || `Track ${safeNum(t.slot)}`,
        durationSec: safeNum(t.durationSec || 0),
        s3Key: safeString(t.s3Key),
        playbackUrl: await signTrackPlaybackUrl(t),
      }))
    );

    const manifest = {
      ok: true,
      shareId,
      projectId,
      createdAt,
      snapshotKey,
      albumTitle,
      meta,
      coverUrl: coverUrl && !isHttpUrl(coverUrl) ? publicCoverUrl : coverUrl,
      tracks: tracks.filter((t) => t && t.slot),
    };

    const manifestKey = `public/players/${shareId}/manifest.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: manifestKey,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      })
    );

    return res.json({
      ok: true,
      shareId,
      manifestKey,
      publicUrl: `${req.protocol}://${req.get("host")}/publish/${shareId}.json`,
      snapshotKey,
      publicCoverKey,
      publicCoverUrl,
    });
  } catch (err) {
    console.error("publish-minisite error", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const shareId = safeString(req.params.shareId);
    if (!shareId)
      return res.status(400).json({ ok: false, error: "MISSING_SHARE_ID" });

    const manifestKey = `public/players/${shareId}/manifest.json`;
    const manifest = await readJsonFromS3Key(manifestKey, 60);

    return res.json({
      ok: true,
      shareId: safeString(manifest?.shareId) || shareId,
      projectId: safeString(manifest?.projectId),
      createdAt: safeString(manifest?.createdAt),
      snapshotKey: safeString(manifest?.snapshotKey),
      albumTitle: safeString(manifest?.albumTitle) || "Album",
      meta: manifest?.meta || {
        albumTitle: safeString(manifest?.albumTitle) || "Album",
        artistName: "",
        releaseDate: "",
      },
      coverUrl: safeString(manifest?.coverUrl || ""),
      tracks: Array.isArray(manifest?.tracks) ? manifest.tracks : [],
    });
  } catch (_e) {
    return res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND" });
  }
});

// root
app.get("/", (_req, res) => {
  res
    .type("text")
    .send("album-backend OK. Try /api/health or /publish/<shareId>.json");
});

const PORT = process.env.PORT || 3000;
console.log("Starting album-backend...", {
  node: process.version,
  port: PORT,
  region: AWS_REGION || null,
  bucket: S3_BUCKET || null,
});
app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
