// FILE: album-backend/server.js
// ------------------------------------------------------------
// IMPORTANT NOTE (2026-01-06..2026-01-12)
//
// Upload + cover upload + album audio all depend on this file.
// Master Save + Publish minisite depend on this file.
//
// DO NOT remove allowedHeaders entries.
// DO NOT remove either upload route.
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

// OPTIONAL: used to produce clickable URLs in publish response.
// If not set, we return relative /public/players/... paths.
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

// ---------- MULTER (IN-MEMORY) ----------
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

async function putObject({ key, body, contentType, cacheControl }) {
  const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl || "no-store",
    })
  );
}

// AWS SDK v3: stream -> string (needed for GET object bodies)
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function getObjectJson(key) {
  const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await streamToString(obj.Body);
  return JSON.parse(body || "{}");
}

async function getObjectStream(key) {
  const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return obj; // includes Body stream + ContentType + Metadata (if present)
}

function publicUrlForKey(key) {
  const clean = String(key || "").replace(/^\/+/, "");
  return PUBLIC_PLAYERS_BASE_URL ? `${PUBLIC_PLAYERS_BASE_URL}/${clean}` : `/${clean}`;
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
 * Extract tracks from snapshot and ONLY return tracks that actually have audio (s3Key).
 */
function extractTracksFromSnapshot(project) {
  if (!project || typeof project !== "object") return [];

  // Prefer masterSaveMiniSite shape if present
  const candidates = [
    project?.audio?.mp3, // from masterSaveMiniSite
    project?.tracks,
    project?.catalog?.tracks,
    project?.catalog?.songs,
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
    // masterSaveMiniSite audio.mp3 entries use trackId + s3Key
    const slot = Number(t?.slot ?? t?.trackNumber ?? t?.index ?? i + 1) || i + 1;

    const title =
      firstStr(t?.title, t?.name, t?.songTitle, t?.trackTitle, t?.meta?.title, t?.albumTitle) || "Untitled";

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
      t?.catalogAudioS3Key
    );

    const durationSec = firstNum(t?.durationSec, t?.duration, t?.audio?.durationSec, t?.meta?.durationSec);

    const trackId = firstStr(t?.trackId, t?.id);

    return {
      slot,
      trackId: trackId || undefined,
      title,
      s3Key,
      durationSec: durationSec || undefined,
    };
  });

  return normalized.filter((t) => String(t?.s3Key || "").trim().length > 0);
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

    // Frontend SHOULD send s3Key, but sometimes doesn't.
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

// ---------- PLAYBACK URL (legacy; not needed post-handoff, but kept) ----------
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

// ---------- MASTER SAVE (writes snapshot + latest pointer) ----------
app.post("/api/master-save", async (req, res) => {
  try {
    // ✅ accept both new + legacy caller shapes
    const projectId = String(req.body?.projectId || "").trim();
    const project =
      req.body?.project ||
      req.body?.masterSave ||
      req.body?.masterSave?.project ||
      null;

    if (!projectId || !project) return res.status(400).json({ ok: false, error: "missing payload" });

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

    return res.json({
      ok: true,
      snapshotKey,
      latestKey,
      // legacy alias so old callers that expect s3Key keep working
      s3Key: snapshotKey,
    });
  } catch (e) {
    console.error("master-save error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- MASTER SAVE LATEST (reads latest.json -> snapshot) ----------
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
      // ✅ add top-level convenience keys for UI code
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

// ---------- PUBLISH MINISITE (HARD HANDOFF: writes full manifest + public audio copies) ----------
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId, snapshotKey } = req.body || {};
    if (!projectId || !snapshotKey) {
      return res.status(400).json({ ok: false, error: "projectId and snapshotKey are required" });
    }

    // 1) load snapshot (AlbumBundle source of truth)
    const project = await getObjectJson(String(snapshotKey).trim());

    // 2) generate shareId + base publish prefix
    const shareId = crypto.randomBytes(8).toString("hex");
    const baseKey = `public/players/${shareId}`;

    // 3) extract audio-backed tracks from snapshot
    const tracks = extractTracksFromSnapshot(project);

    // 4) copy audio into public publish area + build track urls
    const publishedTracks = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const srcKey = String(t.s3Key || "").trim();
      if (!srcKey) continue;

      const slot = Number(t.slot || i + 1) || i + 1;
      const fileName = safeName(`${slot}__${t.title || "track"}.mp3`);
      const dstKey = `${baseKey}/audio/${fileName}`;

      const obj = await getObjectStream(srcKey);
      await putObject({
        key: dstKey,
        body: obj.Body, // stream
        contentType: "audio/mpeg",
        // publish artifacts should be cacheable (immutable path)
        cacheControl: "public, max-age=31536000, immutable",
      });

      publishedTracks.push({
        slot,
        trackId: t.trackId || undefined,
        title: t.title || "Untitled",
        durationSec: t.durationSec || undefined,
        audioUrl: publicUrlForKey(dstKey),
        audioKey: dstKey,
      });
    }

    // 5) hard-handoff manifest (self-contained; no backend required after publish)
    const manifest = {
      version: 1,
      shareId,
      projectId: String(projectId),
      snapshotKey: String(snapshotKey),
      publishedAt: new Date().toISOString(),

      // minimal album surface (extend later if needed)
      album: {
        title: firstStr(project?.albumName, project?.albumTitle, project?.title, "Album"),
        artist: firstStr(project?.performers, project?.artist, project?.album?.artist, "") || undefined,
      },

      tracks: publishedTracks,

      // placeholder smart bridge plan (data-only; computed at publish when ready)
      playback: {
        albumOrder: publishedTracks.map((t) => t.trackId || String(t.slot)),
        smartBridge: { mode: "graph", entry: publishedTracks[0]?.trackId || String(publishedTracks[0]?.slot || 1), edges: [] },
      },
    };

    const manifestKey = `${baseKey}/manifest.json`;
    await putObject({
      key: manifestKey,
      body: Buffer.from(JSON.stringify(manifest, null, 2)),
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    });

    // Optional index.html (debug)
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
    });

    const publicUrl = publicUrlForKey(indexKey);

    return res.json({ ok: true, shareId, publicUrl, manifestKey });
  } catch (e) {
    console.error("publish-minisite error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- PUBLISHED MANIFEST (now returns the published manifest directly) ----------
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
