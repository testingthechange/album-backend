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
  credentials:
    AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
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

app.options("*", cors());
app.use(express.json());

// ---- helpers ----
function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function randId(n = 8) {
  return crypto.randomBytes(n).toString("hex");
}
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

async function s3GetJson(Key) {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key }),
    { expiresIn: 60 }
  );
  const r = await fetch(url);
  if (!r.ok) throw new Error(`S3_GET_JSON_HTTP_${r.status}`);
  return await r.json();
}

async function s3PutJson(Key, obj) {
  const Body = JSON.stringify(obj, null, 2);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key,
      Body,
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store",
    })
  );
}

// Pull the canonical project object out of any snapshot wrapper shapes we’ve used.
function projectFromSnapshotJson(snapshotJson) {
  // master-save snapshotBody currently: { projectId, createdAt, source, data: project }
  // legacy/other variants might have { project: ... } or { data: { project: ... } }
  const p1 = snapshotJson?.data;
  if (p1 && typeof p1 === "object" && !Array.isArray(p1)) return p1;

  const p2 = snapshotJson?.project;
  if (p2 && typeof p2 === "object" && !Array.isArray(p2)) return p2;

  const p3 = snapshotJson?.data?.project;
  if (p3 && typeof p3 === "object" && !Array.isArray(p3)) return p3;

  return null;
}

function normalizeAlbumTracksFromProject(project) {
  const tracks = Array.isArray(project?.album?.tracks) ? project.album.tracks : null;

  if (tracks && tracks.length) {
    return tracks
      .map((t) => {
        const slot = Number(t?.slot || t?.songNumber || 0) || 0;
        const title = String(t?.title || "").trim();
        const durationSec = Number(t?.durationSec || 0) || 0;
        const s3Key = String(t?.s3Key || "").trim();
        const playbackUrl = String(t?.playbackUrl || "").trim();

        if (!slot) return null;

        // Keep both. We will re-sign from s3Key when serving.
        // If only playbackUrl exists (http URL demo), we can serve that as-is.
        return {
          slot,
          title: title || `Track ${slot}`,
          durationSec,
          s3Key,
          playbackUrl,
        };
      })
      .filter(Boolean);
  }

  // Fallback: derive from catalog album files (if present)
  const songs = Array.isArray(project?.catalog?.songs) ? project.catalog.songs : [];
  return songs
    .map((s) => {
      const slot = Number(s?.slot || 0) || 0;
      if (!slot) return null;

      const title = String(s?.title || "").trim() || `Track ${slot}`;
      const fAlbum = s?.files?.album || s?.files?.Album || s?.files?.ALBUM || {};
      const s3Key = String(fAlbum?.s3Key || "").trim();
      const playbackUrl = String(fAlbum?.playbackUrl || "").trim();
      const durationSec = Number(fAlbum?.durationSec || s?.durationSec || 0) || 0;

      if (!s3Key && !playbackUrl) return null;

      return { slot, title, durationSec, s3Key, playbackUrl };
    })
    .filter(Boolean);
}

async function signTrackPlaybackUrl(track) {
  const s3Key = String(track?.s3Key || "").trim();
  const playbackUrl = String(track?.playbackUrl || "").trim();

  // If already an http(s) URL (demo/external), pass through.
  if (playbackUrl && isHttpUrl(playbackUrl)) return playbackUrl;

  // If the "playbackUrl" accidentally contains the s3Key string, treat it as s3Key.
  if (!s3Key && playbackUrl && !isHttpUrl(playbackUrl)) {
    // not expected, but safe fallback
    return playbackUrl;
  }

  if (!s3Key) return "";

  return await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
    { expiresIn: 60 * 20 }
  );
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

// Inspect a stored snapshot JSON (useful to confirm snapshot shape & where tracks live)
app.get("/api/debug/snapshot", async (req, res) => {
  try {
    const key = String(req.query?.key || "").trim();
    if (!key) return res.status(400).json({ ok: false, error: "MISSING_KEY" });

    const json = await s3GetJson(key);
    const project = projectFromSnapshotJson(json);

    return res.json({
      ok: true,
      key,
      snapshotKeysPresent: Object.keys(json || {}),
      projectKeysPresent: project ? Object.keys(project) : null,
      albumTracksPath:
        Array.isArray(project?.album?.tracks) ? "project.album.tracks" : null,
      trackCount: Array.isArray(project?.album?.tracks)
        ? project.album.tracks.length
        : null,
      snapshot: json,
    });
  } catch (err) {
    console.error("debug/snapshot error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
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

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
      { expiresIn: 60 * 20 }
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

    if (isHttpUrl(s3Key)) return res.json({ ok: true, url: s3Key });

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
          aws: { name, httpStatusCode: http, message: String(e?.message || "") },
        });
      }

      return res.status(404).json({
        ok: false,
        error: "UPLOAD_NOT_FOUND_FOR_S3KEY",
        s3Key,
        aws: { name, httpStatusCode: http, message: String(e?.message || "") },
      });
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
      { expiresIn: 60 * 20 }
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

    let latestJson;
    try {
      latestJson = await s3GetJson(latestKey);
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

    let snapshotJson;
    try {
      snapshotJson = await s3GetJson(snapKey);
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

// ---------------------------------------------------------------------------
// NEW: Publish minisite -> stores a PRIVATE manifest in S3,
// and serves it via GET /publish/:shareId.json with re-signed track URLs.
// ---------------------------------------------------------------------------

// POST /api/publish-minisite
// Body: { projectId: string, snapshotKey?: string }
// Returns: { ok:true, shareId, manifestKey, publicUrl, snapshotKey }
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const pid = String(req.body?.projectId || "").trim();
    const requestedSnapshotKey = String(req.body?.snapshotKey || "").trim();

    if (!pid) return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    // Resolve snapshotKey
    let snapshotKey = requestedSnapshotKey;
    if (!snapshotKey) {
      const latestKey = `storage/projects/${pid}/producer_returns/latest.json`;
      const latestJson = await s3GetJson(latestKey);
      snapshotKey = String(latestJson?.latestSnapshotKey || "").trim();
    }
    if (!snapshotKey) return res.status(404).json({ ok: false, error: "NO_SNAPSHOT_KEY" });

    // Load snapshot + extract project
    const snapshotJson = await s3GetJson(snapshotKey);
    const project = projectFromSnapshotJson(snapshotJson);
    if (!project) return res.status(400).json({ ok: false, error: "SNAPSHOT_PROJECT_MISSING", snapshotKey });

    const albumTitle =
      String(project?.album?.albumTitle || project?.album?.title || project?.album?.name || "Album").trim() || "Album";

    const rawTracks = normalizeAlbumTracksFromProject(project);

    // Store PRIVATE manifest (no signed URLs stored; they will be re-signed when served)
    const shareId = `share_${isoStamp()}_${randId(3)}`;
    const manifestKey = `public/players/${shareId}/manifest.json`; // stored in S3, but served through backend

    const manifest = {
      ok: true,
      shareId,
      projectId: pid,
      createdAt: new Date().toISOString(),
      snapshotKey,
      albumTitle,
      tracks: rawTracks.map((t) => ({
        slot: Number(t.slot),
        title: String(t.title || `Track ${t.slot}`),
        durationSec: Number(t.durationSec || 0) || 0,
        s3Key: String(t.s3Key || "").trim(),
        playbackUrl: String(t.playbackUrl || "").trim(), // may be empty; may be external URL
      })),
    };

    await s3PutJson(manifestKey, manifest);

    return res.json({
      ok: true,
      shareId,
      manifestKey,
      publicUrl: `/publish/${shareId}.json`,
      snapshotKey,
    });
  } catch (err) {
    console.error("publish-minisite error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// GET /publish/:shareId.json
// Reads the stored manifest from S3 and RE-SIGNS track playback URLs on demand.
// Returns: { ok:true, shareId, projectId, createdAt, snapshotKey, albumTitle, tracks:[...] }
app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const shareId = String(req.params.shareId || "").trim();
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_SHARE_ID" });

    const manifestKey = `public/players/${shareId}/manifest.json`;

    let stored;
    try {
      stored = await s3GetJson(manifestKey);
    } catch (_e) {
      return res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND", shareId });
    }

    const baseTracks = Array.isArray(stored?.tracks) ? stored.tracks : [];
    const tracks = await Promise.all(
      baseTracks.map(async (t) => {
        const slot = Number(t?.slot || 0) || 0;
        if (!slot) return null;

        const title = String(t?.title || `Track ${slot}`).trim() || `Track ${slot}`;
        const durationSec = Number(t?.durationSec || 0) || 0;
        const s3Key = String(t?.s3Key || "").trim();
        const playbackUrlRaw = String(t?.playbackUrl || "").trim();

        let playbackUrl = "";
        try {
          playbackUrl = await signTrackPlaybackUrl({ s3Key, playbackUrl: playbackUrlRaw });
        } catch (e) {
          // If signing fails, return empty url but keep track info for debugging.
          playbackUrl = "";
        }

        return { slot, title, durationSec, playbackUrl };
      })
    );

    return res.json({
      ok: true,
      shareId: String(stored?.shareId || shareId),
      projectId: String(stored?.projectId || ""),
      createdAt: String(stored?.createdAt || ""),
      snapshotKey: String(stored?.snapshotKey || ""),
      albumTitle: String(stored?.albumTitle || "Album"),
      tracks: tracks.filter(Boolean),
    });
  } catch (err) {
    console.error("publish/:shareId.json error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---- publish demo manifest (kept) ----
const demoManifests = {
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

app.get("/publish", (_req, res) => res.json({ shareIds: Object.keys(demoManifests) }));

app.get("/publish-demo/:shareId.json", (req, res) => {
  const manifest = demoManifests[req.params.shareId];
  if (!manifest) return res.status(404).json({ error: "not_found", shareId: req.params.shareId });
  return res.json({ shareId: req.params.shareId, ...manifest });
});

// root
app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /api/health or /publish/<shareId>.json");
});

const PORT = process.env.PORT || 3000;

console.log("Starting album-backend...", {
  node: process.version,
  port: PORT,
  region: AWS_REGION || null,
  bucket: S3_BUCKET || null,
});

app.listen(PORT, () => console.log(`album-backend listening on ${PORT}`));
