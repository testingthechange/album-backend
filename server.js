// FILE: album-backend/server.js
// ------------------------------------------------------------
// HARD HANDOFF BACKEND
// - Uploads
// - Master Save snapshots
// - Publish = FINAL data dump (manifest + public audio + cover)
// ------------------------------------------------------------

import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const AWS_REGION = process.env.AWS_REGION || "us-west-1";
const S3_BUCKET = process.env.S3_BUCKET || "";
const SIGNED_URL_EXPIRES_SECONDS = Number(process.env.SIGNED_URL_EXPIRES_SECONDS || 1200);
const PUBLIC_PLAYERS_BASE_URL = String(process.env.PUBLIC_PLAYERS_BASE_URL || "").replace(/\/+$/, "");

// ---------- AWS ----------
const s3 = new S3Client({ region: AWS_REGION });

// ---------- CORS ----------
app.use(
  cors({
    origin: (o, cb) => cb(null, true),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------- MULTER ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- HELPERS ----------
const must = (v, msg) => {
  if (!v) throw new Error(msg);
  return v;
};

const isoKey = () => new Date().toISOString().replace(/[:.]/g, "-");

const publicUrl = (key) =>
  PUBLIC_PLAYERS_BASE_URL ? `${PUBLIC_PLAYERS_BASE_URL}/${key}` : `/${key}`;

const streamToBuffer = (s) =>
  new Promise((res, rej) => {
    const c = [];
    s.on("data", (d) => c.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(c)));
    s.on("error", rej);
  });

const getJson = async (key) => {
  const o = await s3.send(new GetObjectCommand({ Bucket: must(S3_BUCKET), Key: key }));
  return JSON.parse((await streamToBuffer(o.Body)).toString("utf8"));
};

const put = async ({ key, body, type, cache }) =>
  s3.send(
    new PutObjectCommand({
      Bucket: must(S3_BUCKET),
      Key: key,
      Body: body,
      ContentType: type,
      CacheControl: cache || "no-store",
      ContentLength: body.length,
    })
  );

// ---------- TRACK EXTRACTION (catalog only) ----------
function extractTracks(project) {
  const songs = project?.catalog?.songs;
  if (!Array.isArray(songs)) return [];

  return songs
    .map((s) => ({
      slot: Number(s.slot),
      title: s.title,
      s3Key: s?.files?.album?.s3Key || "",
      durationSec: Number(s?.durationSec || 0),
    }))
    .filter((t) => t.slot > 0 && t.s3Key);
}

// ---------- COVER EXTRACTION ----------
function extractCoverKey(project) {
  return (
    project?.album?.coverS3Key ||
    project?.coverS3Key ||
    project?.album?.cover?.s3Key ||
    ""
  );
}

// ---------- HEALTH ----------
app.get("/api/health", (_, res) =>
  res.json({ ok: true, service: "album-backend", publish: "/api/publish-minisite" })
);

// ---------- MASTER SAVE ----------
app.post("/api/master-save", async (req, res) => {
  try {
    const { projectId, project } = req.body;
    if (!projectId || !project) throw new Error("missing payload");

    const key = `storage/projects/${projectId}/master_save_snapshots/${isoKey()}.json`;
    await put({ key, body: Buffer.from(JSON.stringify(project, null, 2)), type: "application/json" });

    const latest = `storage/projects/${projectId}/master_save_snapshots/latest.json`;
    await put({
      key: latest,
      body: Buffer.from(JSON.stringify({ projectId, snapshotKey: key })),
      type: "application/json",
    });

    res.json({ ok: true, snapshotKey: key });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- PUBLISH (FINAL HANDOFF) ----------
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId, snapshotKey } = req.body;
    if (!projectId || !snapshotKey) throw new Error("missing publish args");

    const project = await getJson(snapshotKey);
    const shareId = crypto.randomBytes(8).toString("hex");
    const base = `public/players/${shareId}`;

    // ----- COVER -----
    let coverUrl;
    const coverSrc = extractCoverKey(project);
    if (coverSrc) {
      const o = await s3.send(new GetObjectCommand({ Bucket: must(S3_BUCKET), Key: coverSrc }));
      const buf = await streamToBuffer(o.Body);
      const key = `${base}/cover/cover.png`;
      await put({ key, body: buf, type: "image/png", cache: "public, max-age=31536000, immutable" });
      coverUrl = publicUrl(key);
    }

    // ----- AUDIO -----
    const tracks = extractTracks(project);
    const publishedTracks = [];

    for (const t of tracks) {
      const o = await s3.send(new GetObjectCommand({ Bucket: must(S3_BUCKET), Key: t.s3Key }));
      const buf = await streamToBuffer(o.Body);
      const key = `${base}/audio/${t.slot}__${t.title}.mp3`;
      await put({ key, body: buf, type: "audio/mpeg", cache: "public, max-age=31536000, immutable" });

      publishedTracks.push({
        slot: t.slot,
        title: t.title,
        durationSec: t.durationSec || undefined,
        audioUrl: publicUrl(key),
        audioKey: key,
      });
    }

    // ----- TOTAL ALBUM TIME -----
    const totalAlbumTimeSec = publishedTracks.reduce(
      (s, t) => s + (Number(t.durationSec) || 0),
      0
    );

    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

    // ----- MANIFEST -----
    const manifest = {
      version: 1,
      shareId,
      projectId,
      snapshotKey,
      publishedAt: new Date().toISOString(),
      album: {
        title: project?.album?.title || "Album",
        ...(coverUrl ? { coverUrl } : {}),
        ...(totalAlbumTimeSec ? {
          totalAlbumTimeSec,
          totalAlbumTime: fmt(totalAlbumTimeSec),
        } : {}),
      },
      tracks: publishedTracks,
      playback: {
        albumOrder: publishedTracks.map((t) => String(t.slot)),
      },
    };

    const manifestKey = `${base}/manifest.json`;
    await put({
      key: manifestKey,
      body: Buffer.from(JSON.stringify(manifest, null, 2)),
      type: "application/json",
      cache: "public, max-age=31536000, immutable",
    });

    const indexKey = `${base}/index.html`;
    await put({
      key: indexKey,
      body: Buffer.from(`<pre>${JSON.stringify(manifest, null, 2)}</pre>`),
      type: "text/html",
      cache: "public, max-age=31536000, immutable",
    });

    res.json({
      ok: true,
      shareId,
      publicUrl: publicUrl(indexKey),
      manifestKey,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- START ----------
app.listen(PORT, () =>
  console.log(`album-backend running on ${PORT}`)
);
