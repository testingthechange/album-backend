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
const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET } = process.env;

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
function randId(n = 12) {
  return crypto.randomBytes(n).toString("hex");
}
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
function safeString(v) {
  return String(v ?? "").trim();
}
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// IMPORTANT: any "masterSnapshot_*" is NOT an S3 key. Treat as invalid.
function isBogusSnapshotKey(k) {
  const s = safeString(k);
  if (!s) return true;
  if (s.startsWith("masterSnapshot_")) return true;
  // real S3 keys in this system are paths like "storage/projects/..../snapshots/...json"
  if (!s.includes("/") || !s.endsWith(".json")) return true;
  return false;
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
    if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });

    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok: false, error: "NO_FILE" });

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
    if (!s3Key) return res.status(400).json({ ok: false, error: "MISSING_S3KEY" });

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
      return res.status(400).json({ ok: false, error: "Missing projectId or project" });
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
      String(latestJson?.latestSnapshotKey || "").trim() || String(latestJson?.snapshotKey || "").trim();

    if (!snapKey) {
      return res.status(404).json({ ok: false, error: "NO_LATEST_SNAPSHOT_KEY", latestKey });
    }

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
      return res.status(404).json({ ok: false, error: "SNAPSHOT_NOT_FOUND", snapshotKey: snapKey });
    }

    return res.json({ ok: true, latestKey, latest: latestJson, snapshot: snapshotJson });
  } catch (err) {
    console.error("master-save latest error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* =============================================================================
   PUBLISH (SECURE)
============================================================================= */

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

function deriveTracksFromSnapshotData(data) {
  const songs = Array.isArray(data?.catalog?.songs) ? data.catalog.songs : [];
  const out = [];

  for (const s of songs) {
    const slot = safeNum(s?.slot);
    if (!slot) continue;

    const title = safeString(s?.title) || `Track ${slot}`;

    const fAlbum = s?.files?.album || s?.files?.Album || s?.files?.ALBUM || {};
    const s3Key = safeString(fAlbum?.s3Key);
    const existingUrl = safeString(fAlbum?.playbackUrl);

    if (!s3Key && !existingUrl) continue;

    const durationSec = safeNum(fAlbum?.durationSec || s?.durationSec || 0);

    out.push({
      slot,
      title,
      s3Key,
      playbackUrl: existingUrl,
      durationSec,
    });
  }

  return out;
}

async function signTrackPlaybackUrl(track) {
  const s3Key = safeString(track?.s3Key);
  if (s3Key && !isHttpUrl(s3Key)) {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
      { expiresIn: 60 * 20 }
    );
    return url;
  }

  const u = safeString(track?.playbackUrl) || safeString(track?.s3Key);
  if (isHttpUrl(u)) return u;

  return "";
}

// POST /api/publish-minisite
// Body: { projectId, snapshotKey? }
// Returns: { ok:true, shareId, manifestKey, publicUrl, snapshotKey }
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const projectId = safeString(req.body?.projectId);
    let providedSnapshotKey = safeString(req.body?.snapshotKey);

    if (!projectId) {
      return res.status(400).json({ ok: false, error: "MISSING_PROJECT_ID" });
    }

    // CRITICAL FIX:
    // If frontend sends "masterSnapshot_*" (not a real S3 key), ignore it and publish from latest.json.
    if (!providedSnapshotKey || isBogusSnapshotKey(providedSnapshotKey)) {
      providedSnapshotKey = "";
    }

    // choose snapshot key
    let snapshotKey = providedSnapshotKey;
    if (!snapshotKey) {
      const latestKey = `storage/projects/${projectId}/producer_returns/latest.json`;
      const latest = await readJsonFromS3Key(latestKey, 60);
      snapshotKey = safeString(latest?.latestSnapshotKey || latest?.snapshotKey);
      if (!snapshotKey) {
        return res.status(404).json({ ok: false, error: "NO_LATEST_SNAPSHOT_KEY", latestKey });
      }
    }

    // read snapshot
    const snapshot = await readJsonFromS3Key(snapshotKey, 60);

    // normalize to "data" (new) or "project" (legacy)
    const data =
      (snapshot && typeof snapshot === "object" ? snapshot.data : null) || snapshot.project || null;

    if (!data || typeof data !== "object") {
      return res.status(500).json({ ok: false, error: "SNAPSHOT_MISSING_DATA", snapshotKey });
    }

    const createdAt = safeString(snapshot?.createdAt) || new Date().toISOString();
    const shareId = `share_${isoStamp()}_${crypto.randomBytes(3).toString("hex")}`;

    const albumTitle =
      safeString(data?.album?.meta?.albumTitle) || safeString(data?.albumTitle) || "Album";

    const tracksRaw = deriveTracksFromSnapshotData(data);

    const tracks = await Promise.all(
      tracksRaw.map(async (t) => {
        let url = "";
        try {
          url = await signTrackPlaybackUrl(t);
        } catch (e) {
          console.error("publish: track sign failed", {
            slot: t?.slot,
            s3Key: t?.s3Key,
            err: String(e?.message || e),
          });
          url = "";
        }
        return {
          slot: safeNum(t.slot),
          title: safeString(t.title) || `Track ${safeNum(t.slot)}`,
          durationSec: safeNum(t.durationSec || 0),
          playbackUrl: url,
          s3Key: safeString(t.s3Key),
        };
      })
    );

    const manifest = {
      ok: true,
      shareId,
      projectId,
      createdAt,
      snapshotKey,
      albumTitle,
      tracks,
    };

    const manifestKey = `public/players/${shareId}/manifest.json`;
    const body = JSON.stringify(manifest, null, 2);

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: manifestKey,
        Body: body,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      })
    );

    const publicUrl = `${req.protocol}://${req.get("host")}/publish/${encodeURIComponent(shareId)}.json`;

    // NOTE: snapshotKey returned here is ALWAYS the real S3 snapshot key (never "masterSnapshot_*").
    return res.json({ ok: true, shareId, manifestKey, publicUrl, snapshotKey });
  } catch (err) {
    console.error("publish-minisite error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// GET /publish/:shareId.json
// Reads manifest from S3 and re-signs playback URLs on demand (no public S3 required)
app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const shareId = safeString(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_SHARE_ID" });

    const manifestKey = `public/players/${shareId}/manifest.json`;

    let manifest;
    try {
      manifest = await readJsonFromS3Key(manifestKey, 60);
    } catch (_e) {
      return res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND", manifestKey, shareId });
    }

    const tracksIn = Array.isArray(manifest?.tracks) ? manifest.tracks : [];
    const tracksOut = await Promise.all(
      tracksIn.map(async (t) => {
        const s3Key = safeString(t?.s3Key);
        const title = safeString(t?.title);
        const slot = safeNum(t?.slot);
        const durationSec = safeNum(t?.durationSec || 0);

        let playbackUrl = "";

        if (s3Key && !isHttpUrl(s3Key)) {
          try {
            await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
            playbackUrl = await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }),
              { expiresIn: 60 * 20 }
            );
          } catch (_e) {
            playbackUrl = "";
          }
        } else {
          const u = safeString(t?.playbackUrl) || safeString(s3Key);
          playbackUrl = isHttpUrl(u) ? u : "";
        }

        return { slot, title, durationSec, playbackUrl, s3Key };
      })
    );

    return res.json({
      ok: true,
      shareId: safeString(manifest?.shareId) || shareId,
      projectId: safeString(manifest?.projectId),
      createdAt: safeString(manifest?.createdAt),
      snapshotKey: safeString(manifest?.snapshotKey),
      albumTitle: safeString(manifest?.albumTitle) || "Album",
      tracks: tracksOut.filter((t) => t && t.slot),
    });
  } catch (err) {
    console.error("publish GET error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* =============================================================================
   DEMO (unchanged)
============================================================================= */

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

// keep a simple list endpoint for demo shareIds
app.get("/publish", (_req, res) => res.json({ shareIds: Object.keys(manifests) }));

// demo manifest endpoint (separate suffix to avoid clashing with real shareIds)
app.get("/publish/:shareId.json.demo", (req, res) => {
  const manifest = manifests[req.params.shareId];
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
