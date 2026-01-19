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

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION", reason);
  process.exit(1);
});

const upload = multer({ storage: multer.memoryStorage() });

const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET } =
  process.env;

const s3 = new S3Client({
  region: AWS_REGION,
  credentials:
    AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
      : undefined,
});

app.use(cors());
app.use(express.json());

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

function deriveTracksFromSnapshotData(data) {
  const songs = Array.isArray(data?.catalog?.songs)
    ? data.catalog.songs
    : [];
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
  if (track.s3Key && !isHttpUrl(track.s3Key)) {
    await s3.send(
      new HeadObjectCommand({ Bucket: S3_BUCKET, Key: track.s3Key })
    );
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: track.s3Key }),
      { expiresIn: 60 * 20 }
    );
  }
  return track.playbackUrl || "";
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
      const latest = await readJsonFromS3Key(latestKey);
      snapshotKey = safeString(latest?.latestSnapshotKey);
    }

    const snapshot = await readJsonFromS3Key(snapshotKey);
    const data = snapshot?.data;

    const albumMeta = data?.album?.meta || {};
    const albumCover = data?.album?.cover || {};

    const tracksRaw = deriveTracksFromSnapshotData(data);
    const tracks = await Promise.all(
      tracksRaw.map(async (t) => ({
        ...t,
        playbackUrl: await signTrackPlaybackUrl(t),
      }))
    );

    const shareId = `share_${isoStamp()}_${crypto
      .randomBytes(3)
      .toString("hex")}`;

    const manifest = {
      ok: true,
      shareId,
      projectId,
      createdAt: snapshot?.createdAt || new Date().toISOString(),
      snapshotKey,

      albumTitle: safeString(albumMeta.albumTitle) || "Album",
      artistName: safeString(albumMeta.artistName) || "",
      releaseDate: safeString(albumMeta.releaseDate) || "",
      coverUrl: safeString(albumCover.previewUrl) || "",

      tracks,
    };

    const manifestKey = `public/players/${shareId}/manifest.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: manifestKey,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: "application/json",
        CacheControl: "no-store",
      })
    );

    return res.json({
      ok: true,
      shareId,
      manifestKey,
      publicUrl: `${req.protocol}://${req.get(
        "host"
      )}/publish/${shareId}.json`,
      snapshotKey,
    });
  } catch (err) {
    console.error("publish-minisite error", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/publish/:shareId.json", async (req, res) => {
  try {
    const manifestKey = `public/players/${req.params.shareId}/manifest.json`;
    const manifest = await readJsonFromS3Key(manifestKey);
    return res.json(manifest);
  } catch {
    return res.status(404).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`album-backend listening on ${PORT}`)
);
