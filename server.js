// FILE: album-backend/server.js
// ------------------------------------------------------------
// Upload + cover upload + album audio all depend on this file.
// Master Save + Publish minisite depend on this file.
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
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || "";
const SIGNED_URL_EXPIRES_SECONDS = Number(process.env.SIGNED_URL_EXPIRES_SECONDS || 1200);

// If empty, publish returns relative /public/players/... URLs
const PUBLIC_PLAYERS_BASE_URL = String(process.env.PUBLIC_PLAYERS_BASE_URL || "").replace(/\/+$/, "");

// ---------- CORS (CRITICAL) ----------
app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Project-Id", "X-ProjectId", "X-SB-Project-Id"],
  })
);

// ---------- AWS ----------
const s3 = new S3Client({ region: AWS_REGION });

// ---------- MULTER ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});

// ---------- HELPERS ----------
function must(v, msg) {
  if (!v) throw new Error(msg);
  return v;
}

function safeName(name) {
  return String(name || "upload").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isoForKey() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function guessBucketPrefix({ projectId, mimetype }) {
  const mt = String(mimetype || "").toLowerCase();
  if (mt.startsWith("image/")) return `storage/projects/${projectId}/album/cover`;
  if (mt.startsWith("audio/")) return `storage/projects/${projectId}/catalog/audio`;
  return `storage/projects/${projectId}/uploads`;
}

function publicUrlForKey(key) {
  const clean = String(key || "").replace(/^\/+/, "");
  return PUBLIC_PLAYERS_BASE_URL ? `${PUBLIC_PLAYERS_BASE_URL}/${clean}` : `/${clean}`;
}

async function putObject({ key, body, contentType, cacheControl, contentLength }) {
  const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");

  const params = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
    CacheControl: cacheControl || "no-store",
  };
  if (Number.isFinite(contentLength) && contentLength > 0) params.ContentLength = contentLength;

  await s3.send(new PutObjectCommand(params));
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function getObjectJson(key) {
  const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await streamToString(obj.Body);
  return JSON.parse(body || "{}");
}

async function getObjectBuffer(key) {
  const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buf = await streamToBuffer(obj.Body);
  return { buf, contentType: obj.ContentType || "application/octet-stream" };
}

function firstStr(...vals) {
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function firstNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * Tracks extractor that supports your CURRENT catalog snapshot shape:
 *   project.catalog.songs[].files.album.s3Key
 */
function extractTracksFromSnapshot(project) {
  if (!project || typeof project !== "object") return [];

  const candidates = [
    project?.audio?.mp3,
    project?.catalog?.songs,
    project?.tracks,
    project?.catalog?.tracks,
    project?.songs,
    project?.songs?.tracks,
    project?.songs?.items,
    project?.album?.tracks,
    project?.album?.albumMode?.tracks,
    project?.albumBundle?.tracks,
    project?.bundle?.tracks,
    project?.published?.tracks,
  ].filter(Boolean);

  let arr = null;
  for (const c of candidates) {
    if (Array.isArray(c)) {
      arr = c;
      break;
    }
  }
  if (!Array.isArray(arr)) return [];

  const normalized = arr.map((t, i) => {
    const slot = Number(t?.slot ?? t?.trackNumber ?? t?.index ?? i + 1) || i + 1;

    const title =
      firstStr(
        t?.titleJson?.title,
        t?.title,
        t?.name,
        t?.songTitle,
        t?.trackTitle,
        t?.meta?.title,
        t?.albumTitle
      ) || "Untitled";

    const s3Key = firstStr(
      t?.s3Key,
      t?.audioS3Key,
      t?.audio?.s3Key,
      t?.audioKey,
      t?.file?.s3Key,
      t?.fileKey,
      t?.asset?.s3Key,
      t?.audio?.key,
      t?.mp3?.s3Key,
      t?.catalogAudioS3Key,

      // ✅ catalog file shape
      t?.files?.album?.s3Key,
      t?.files?.album?.key,
      t?.files?.a?.s3Key,
      t?.files?.a?.key,
      t?.files?.b?.s3Key,
      t?.files?.b?.key
    );

    const durationSec = firstNum(t?.durationSec, t?.duration, t?.audio?.durationSec, t?.meta?.durationSec);

    return { slot, title, s3Key, durationSec: durationSec || undefined };
  });

  return normalized.filter((t) => String(t?.s3Key || "").trim().length > 0);
}

/**
 * Meta extractor (lyrics/credits) supports:
 * - project.metaBySlot / project.meta.bySlot
 * - project.catalog.songs[].meta / songs[].metaBySlot-ish fields (best-effort)
 */
function extractMetaBySlot(project) {
  const direct =
    project?.metaBySlot ||
    project?.meta?.bySlot ||
    project?.songsMetaBySlot ||
    project?.meta?.songsBySlot ||
    null;

  const out = {};

  // 1) Direct bySlot object
  if (direct && typeof direct === "object") {
    for (const [k, v] of Object.entries(direct)) {
      const n = Number(k);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (!v || typeof v !== "object") continue;

      const lyrics = firstStr(v?.lyrics, v?.lyricsText);
      const credits = firstStr(v?.credits, v?.creditsText);

      if (lyrics || credits) out[n] = { lyrics: lyrics || undefined, credits: credits || undefined };
    }
  }

  // 2) Catalog songs array shape
  const songs = project?.catalog?.songs;
  if (Array.isArray(songs)) {
    for (const s of songs) {
      const slot = Number(s?.slot);
      if (!Number.isFinite(slot) || slot <= 0) continue;

      const lyrics =
        firstStr(
          s?.meta?.lyrics,
          s?.meta?.lyricsText,
          s?.lyrics,
          s?.lyricsText,
          s?.metaBySlot?.[slot]?.lyrics,
          s?.metaBySlot?.[slot]?.lyricsText
        ) || "";

      const credits =
        firstStr(
          s?.meta?.credits,
          s?.meta?.creditsText,
          s?.credits,
          s?.creditsText,
          s?.metaBySlot?.[slot]?.credits,
          s?.metaBySlot?.[slot]?.creditsText
        ) || "";

      if (!out[slot] && (lyrics || credits)) out[slot] = { lyrics: lyrics || undefined, credits: credits || undefined };
    }
  }

  return Object.keys(out).length ? out : undefined;
}

/**
 * Album meta extractor (ALBUM FIELDS ONLY)
 * - explicitly avoids Meta page fields (project.meta.*)
 * - best-effort mapping of common album field locations
 */
function extractAlbumMeta(project) {
  const title = firstStr(
    project?.album?.albumName,
    project?.album?.title,
    project?.albumName,
    project?.albumTitle,
    project?.title
  );

  const artist = firstStr(
    project?.album?.artist,
    project?.album?.performers,
    project?.performers,
    project?.artist
  );

  const releaseDate = firstStr(project?.album?.releaseDate, project?.releaseDate);

  const label = firstStr(project?.album?.label, project?.label);
  const genre = firstStr(project?.album?.genre, project?.genre);
  const upc = firstStr(project?.album?.upc, project?.upc);
  const copyright = firstStr(project?.album?.copyright, project?.copyright);

  const out = {};
  if (title) out.title = title;
  if (artist) out.artist = artist;
  if (releaseDate) out.releaseDate = releaseDate;
  if (label) out.label = label;
  if (genre) out.genre = genre;
  if (upc) out.upc = upc;
  if (copyright) out.copyright = copyright;

  return out;
}

/**
 * Compute total album duration in seconds from extracted track durations.
 * Returns undefined if no durations are present.
 */
function computeTotalDurationSec(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return undefined;
  let sum = 0;
  let any = false;
  for (const t of tracks) {
    const n = Number(t?.durationSec);
    if (Number.isFinite(n) && n > 0) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : undefined;
}

function extractCoverKey(project) {
  return firstStr(
    project?.coverS3Key,
    project?.album?.coverS3Key,
    project?.meta?.coverS3Key,
    project?.album?.cover?.s3Key,
    project?.album?.cover?.key,
    project?.album?.artwork?.s3Key,
    project?.album?.artwork?.key,
    project?.meta?.cover?.s3Key,
    project?.meta?.cover?.key
  );
}

// ---------- HEALTH ----------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "album-backend",
    uploadRoutes: ["/upload-to-s3", "/api/upload-to-s3"],
    playbackRoute: "/api/playback-url",
    masterSaveRoute: "/api/master-save",
    masterSaveLatestRoute: "/api/master-save/latest/:projectId",
    publishRoute: "/api/publish-minisite",
    publishManifestRoute: "/api/publish/:shareId/manifest",
    PUBLIC_PLAYERS_BASE_URL,
  });
});

// ---------- UPLOAD HANDLER ----------
async function uploadToS3Handler(req, res) {
  try {
    const projectId = String(req.query.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "missing projectId" });

    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "missing file" });

    let s3Key = String(req.body?.s3Key || "").trim();
    if (!s3Key) {
      const prefix = guessBucketPrefix({ projectId, mimetype: file.mimetype });
      const name = safeName(file.originalname || "upload");
      s3Key = `${prefix}/${isoForKey()}__${name}`;
    }

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype || "application/octet-stream",
        Metadata: { projectid: projectId },
      })
    );

    return res.json({ ok: true, bucket, s3Key });
  } catch (e) {
    console.error("upload-to-s3 error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// ---------- UPLOAD ROUTES (KEEP BOTH) ----------
app.post("/upload-to-s3", upload.single("file"), uploadToS3Handler);
app.post("/api/upload-to-s3", upload.single("file"), uploadToS3Handler);

// ---------- PLAYBACK URL (legacy; kept) ----------
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = String(req.query.s3Key || "").trim();
    if (!s3Key) return res.status(400).json({ ok: false, error: "missing s3Key" });

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
    const url = await getSignedUrl(s3, cmd, { expiresIn: SIGNED_URL_EXPIRES_SECONDS });

    return res.json({ ok: true, url, expiresSeconds: SIGNED_URL_EXPIRES_SECONDS });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- MASTER SAVE ----------
app.post("/api/master-save", async (req, res) => {
  try {
    // Accept multiple caller shapes (project or masterSave)
    const projectId = String(req.body?.projectId || "").trim();
    const project = req.body?.project || req.body?.masterSave || req.body?.masterSave?.project || null;
    if (!projectId || !project) return res.status(400).json({ ok: false, error: "missing payload" });

    // NOTE: snapshot is stored as-is (caller owns shape). Publish derives album meta + total time.
    const snapshotKey = `storage/projects/${projectId}/master_save_snapshots/${isoForKey()}.json`;
    await putObject({
      key: snapshotKey,
      body: Buffer.from(JSON.stringify(project, null, 2)),
      contentType: "application/json; charset=utf-8",
    });

    const latestKey = `storage/projects/${projectId}/master_save_snapshots/latest.json`;
    await putObject({
      key: latestKey,
      body: Buffer.from(JSON.stringify({ projectId, snapshotKey, savedAt: new Date().toISOString() }, null, 2)),
      contentType: "application/json; charset=utf-8",
    });

    return res.json({ ok: true, snapshotKey, latestKey, s3Key: snapshotKey });
  } catch (e) {
    console.error("master-save error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- MASTER SAVE LATEST ----------
app.get("/api/master-save/latest/:projectId", async (req, res) => {
  try {
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "missing projectId" });

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
    const latestKey = `storage/projects/${projectId}/master_save_snapshots/latest.json`;

    const latestObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latestKey }));
    const latestBody = await streamToString(latestObj.Body);
    const latest = JSON.parse(latestBody || "{}");

    const snapshotKey = String(latest?.snapshotKey || "").trim();
    if (!snapshotKey) return res.status(404).json({ ok: false, error: "NO_LATEST_SNAPSHOT_KEY", latestKey });

    const snapObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: snapshotKey }));
    const snapBody = await streamToString(snapObj.Body);
    const project = JSON.parse(snapBody || "{}");

    return res.json({
      ok: true,
      latestKey,
      latest,
      latestSnapshotKey: snapshotKey,
      latestSnapshot: { snapshotKey, savedAt: String(latest?.savedAt || "") },
      snapshot: { projectId, savedAt: String(latest?.savedAt || ""), project },
    });
  } catch (e) {
    const msg = String(e?.name || "") === "NoSuchKey" ? "NO_LATEST_SNAPSHOT_KEY" : String(e?.message || e);
    console.error("master-save latest error:", e);
    return res.status(404).json({ ok: false, error: msg });
  }
});

// ---------- PUBLISH MINISITE (HARD HANDOFF: manifest + public audio + public cover) ----------
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId, snapshotKey } = req.body || {};
    if (!projectId || !snapshotKey) {
      return res.status(400).json({ ok: false, error: "projectId and snapshotKey are required" });
    }

    const project = await getObjectJson(String(snapshotKey).trim());

    const shareId = crypto.randomBytes(8).toString("hex");
    const baseKey = `public/players/${shareId}`;

    // ----- cover publish -----
    let coverKey = "";
    let coverUrl = "";
    const srcCoverKey = extractCoverKey(project);

    if (srcCoverKey) {
      const { buf, contentType } = await getObjectBuffer(srcCoverKey);
      const ext =
        String(contentType || "").includes("png")
          ? "png"
          : String(contentType || "").includes("webp")
          ? "webp"
          : String(contentType || "").includes("jpeg") || String(contentType || "").includes("jpg")
          ? "jpg"
          : "jpg";

      coverKey = `${baseKey}/cover/cover.${ext}`;
      await putObject({
        key: coverKey,
        body: buf,
        contentType: contentType || "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable",
        contentLength: buf.length,
      });
      coverUrl = publicUrlForKey(coverKey);
    }

    // ----- audio publish -----
    const tracks = extractTracksFromSnapshot(project);
    const metaBySlot = extractMetaBySlot(project);

    const publishedTracks = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const srcKey = String(t.s3Key || "").trim();
      if (!srcKey) continue;

      const slot = Number(t.slot || i + 1) || i + 1;
      const fileName = safeName(`${slot}__${t.title || "track"}.mp3`);
      const dstKey = `${baseKey}/audio/${fileName}`;

      const { buf } = await getObjectBuffer(srcKey);

      await putObject({
        key: dstKey,
        body: buf,
        contentType: "audio/mpeg",
        cacheControl: "public, max-age=31536000, immutable",
        contentLength: buf.length,
      });

      const m = metaBySlot?.[slot] || undefined;

      publishedTracks.push({
        slot,
        title: t.title || "Untitled",
        durationSec: t.durationSec || undefined,
        audioUrl: publicUrlForKey(dstKey),
        audioKey: dstKey,
        ...(m ? { meta: m } : {}),
      });
    }

    // ----- album meta + total time (NEW) -----
    const albumMeta = extractAlbumMeta(project);
    const totalDurationSec = computeTotalDurationSec(publishedTracks);

    // Self-contained manifest for third-party consumption
    const manifest = {
      version: 1,
      shareId,
      projectId: String(projectId),
      snapshotKey: String(snapshotKey),
      publishedAt: new Date().toISOString(),
      album: {
        title: albumMeta.title || "Album",
        ...(albumMeta.artist ? { artist: albumMeta.artist } : {}),
        ...(albumMeta.releaseDate ? { releaseDate: albumMeta.releaseDate } : {}),
        ...(albumMeta.label ? { label: albumMeta.label } : {}),
        ...(albumMeta.genre ? { genre: albumMeta.genre } : {}),
        ...(albumMeta.upc ? { upc: albumMeta.upc } : {}),
        ...(albumMeta.copyright ? { copyright: albumMeta.copyright } : {}),
        ...(coverUrl ? { coverUrl } : {}),
        ...(coverKey ? { coverKey } : {}),
        ...(totalDurationSec ? { totalDurationSec } : {}),
      },
      tracks: publishedTracks,
      playback: {
        albumOrder: publishedTracks.map((t) => String(t.slot)),
        smartBridge: {
          mode: "graph",
          entry: String(publishedTracks[0]?.slot || 1),
          edges: [],
        },
      },
      diagnostics: {
        tracksFoundInSnapshot: tracks.length,
        tracksPublished: publishedTracks.length,
        coverPublished: !!coverUrl,
        albumMetaIncluded: Object.keys(albumMeta || {}).length > 0,
        totalDurationSec: totalDurationSec || 0,
      },
    };

    const manifestKey = `${baseKey}/manifest.json`;
    const manifestStr = JSON.stringify(manifest, null, 2);

    await putObject({
      key: manifestKey,
      body: Buffer.from(manifestStr),
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
      contentLength: Buffer.byteLength(manifestStr),
    });

    // Optional debug index
    const indexKey = `${baseKey}/index.html`;
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Published</title></head>
<body><pre id="out">Loading…</pre>
<script>
fetch("./manifest.json").then(r=>r.json()).then(m=>{document.getElementById("out").textContent=JSON.stringify(m,null,2);})
.catch(e=>{document.getElementById("out").textContent=String(e);});
</script>
</body></html>`;

    await putObject({
      key: indexKey,
      body: Buffer.from(html),
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
      contentLength: Buffer.byteLength(html),
    });

    const publicUrl = publicUrlForKey(indexKey);

    return res.json({ ok: true, shareId, publicUrl, manifestKey });
  } catch (e) {
    console.error("publish-minisite error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- PUBLISHED MANIFEST (read back the published artifact) ----------
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const shareId = String(req.params.shareId || "").trim();
    if (!shareId) return res.status(400).json({ ok: false, error: "missing shareId" });

    const key = `public/players/${shareId}/manifest.json`;
    const manifest = await getObjectJson(key);

    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, ...manifest });
  } catch (e) {
    const msg = String(e?.name || "") === "NoSuchKey" ? "NO_SUCH_SHARE" : String(e?.message || e);
    console.error("publish manifest error:", e);
    return res.status(404).json({ ok: false, error: msg });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
  console.log(`AWS_REGION=${AWS_REGION}`);
  console.log(`S3_BUCKET=${S3_BUCKET || "(missing)"}`);
  console.log(`PUBLIC_PLAYERS_BASE_URL=${PUBLIC_PLAYERS_BASE_URL || "(empty)"}`);
});
