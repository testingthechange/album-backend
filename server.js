// FILE: server.js
// ------------------------------------------------------------
// IMPORTANT NOTE (2026-01-06..2026-01-09)
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

// OPTIONAL: used to produce a clickable URL in publish response.
// If not set, we return a relative /public/players/... path.
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

async function putObject({ key, body, contentType }) {
  const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "no-store",
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

function extractTracksFromSnapshot(project) {
  if (!project || typeof project !== "object") return [];

  // Try a few likely shapes.
  const candidates = [
    project?.tracks,
    project?.catalog?.tracks,
    project?.catalog?.songs,
    project?.songs,
    project?.songs?.tracks,
    project?.songs?.items,
    project?.album?.tracks,
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
    // Sometimes nested objects contain arrays
    if (c && typeof c === "object") {
      // common: { bySlot: { "1": {...}, ... } }
      const bySlot = c.bySlot || c.metaBySlot || c.tracksBySlot;
      if (bySlot && typeof bySlot === "object") {
        const keys = Object.keys(bySlot);
        if (keys.length) {
          arr = keys
            .map((k) => ({ slot: Number(k), ...(bySlot[k] || {}) }))
            .filter((x) => Number.isFinite(x.slot) && x.slot > 0);
          if (arr.length) break;
        }
      }
    }
  }

  if (!Array.isArray(arr)) return [];

  return arr.map((t, i) => {
    const slot = Number(t?.slot ?? t?.trackNumber ?? t?.index ?? i + 1) || i + 1;

    const title = firstStr(
      t?.title,
      t?.name,
      t?.songTitle,
      t?.trackTitle,
      t?.meta?.title
    ) || "Untitled";

    const s3Key = firstStr(
      t?.s3Key,
      t?.audioS3Key,
      t?.audio?.s3Key,
      t?.audioKey,
      t?.file?.s3Key,
      t?.fileKey,
      t?.asset?.s3Key
    );

    const durationSec = firstNum(
      t?.durationSec,
      t?.duration,
      t?.audio?.durationSec,
      t?.meta?.durationSec
    );

    const lyricsText = firstStr(t?.lyricsText, t?.lyrics, t?.meta?.lyricsText, t?.meta?.lyrics);
    const creditsText = firstStr(t?.creditsText, t?.credits, t?.meta?.creditsText, t?.meta?.credits);

    return {
      slot,
      title,
      s3Key,
      durationSec,
      lyricsText: lyricsText || undefined,
      creditsText: creditsText || undefined,
    };
  });
}

function extractMetaBySlot(project) {
  const meta =
    project?.metaBySlot ||
    project?.meta?.bySlot ||
    project?.songsMetaBySlot ||
    project?.meta?.songsBySlot ||
    null;

  if (!meta || typeof meta !== "object") return undefined;

  // Ensure numeric-ish keys -> object with lyrics/credits
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    const n = Number(k);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (!v || typeof v !== "object") continue;
    out[n] = {
      lyrics: firstStr(v?.lyrics, v?.lyricsText),
      credits: firstStr(v?.credits, v?.creditsText),
    };
  }
  return Object.keys(out).length ? out : undefined;
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

// ---------- PLAYBACK URL ----------
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
    const { projectId, project } = req.body || {};
    if (!projectId || !project) return res.status(400).json({ ok: false, error: "missing payload" });

    const snapshotKey = `storage/projects/${projectId}/master_save_snapshots/${isoForKey()}.json`;
    await putObject({
      key: snapshotKey,
      body: Buffer.from(JSON.stringify(project, null, 2)),
      contentType: "application/json; charset=utf-8",
    });

    // NEW: latest pointer so the UI can load "latest"
    const latestKey = `storage/projects/${projectId}/master_save_snapshots/latest.json`;
    await putObject({
      key: latestKey,
      body: Buffer.from(
        JSON.stringify(
          {
            projectId,
            snapshotKey,
            savedAt: new Date().toISOString(),
          },
          null,
          2
        )
      ),
      contentType: "application/json; charset=utf-8",
    });

    return res.json({ ok: true, snapshotKey, latestKey });
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

    // read latest.json
    const latestObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latestKey }));
    const latestBody = await streamToString(latestObj.Body);
    const latest = JSON.parse(latestBody || "{}");

    const snapshotKey = String(latest?.snapshotKey || "").trim();
    if (!snapshotKey) {
      return res.status(404).json({ ok: false, error: "NO_LATEST_SNAPSHOT_KEY", latestKey });
    }

    // read snapshot json
    const snapObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: snapshotKey }));
    const snapBody = await streamToString(snapObj.Body);
    const project = JSON.parse(snapBody || "{}");

    return res.json({
      ok: true,
      latestKey,
      latest,
      snapshot: {
        projectId,
        savedAt: String(latest?.savedAt || ""),
        project,
      },
    });
  } catch (e) {
    // If latest.json doesn't exist, AWS returns NoSuchKey
    const msg = String(e?.name || "") === "NoSuchKey" ? "NO_LATEST_SNAPSHOT_KEY" : String(e?.message || e);
    console.error("master-save latest error:", e);
    return res.status(404).json({ ok: false, error: msg });
  }
});

// ---------- PUBLISH MINISITE ----------
app.post("/api/publish-minisite", async (req, res) => {
  try {
    const { projectId, snapshotKey } = req.body || {};
    if (!projectId || !snapshotKey) {
      return res.status(400).json({ ok: false, error: "projectId and snapshotKey are required" });
    }

    const shareId = crypto.randomBytes(8).toString("hex");
    const baseKey = `public/players/${shareId}`;

    const manifest = {
      ok: true,
      projectId,
      snapshotKey,
      shareId,
      publishedAt: new Date().toISOString(),
      version: 1,
    };

    const manifestKey = `${baseKey}/manifest.json`;
    await putObject({
      key: manifestKey,
      body: Buffer.from(JSON.stringify(manifest, null, 2)),
      contentType: "application/json; charset=utf-8",
    });

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Smart Bridge Minisite</title>
</head>
<body>
  <h3>Smart Bridge Minisite</h3>
  <p>This share points at a Master Save snapshot.</p>
  <pre id="out">Loading manifest…</pre>
  <script>
    fetch("./manifest.json")
      .then(r => r.json())
      .then(m => {
        document.getElementById("out").textContent = JSON.stringify(m, null, 2);
      })
      .catch(err => {
        document.getElementById("out").textContent = String(err);
      });
  </script>
</body>
</html>`;

    const indexKey = `${baseKey}/index.html`;
    await putObject({
      key: indexKey,
      body: Buffer.from(html),
      contentType: "text/html; charset=utf-8",
    });

    const publicUrl = PUBLIC_PLAYERS_BASE_URL
      ? `${PUBLIC_PLAYERS_BASE_URL}/${baseKey}/index.html`
      : `/${baseKey}/index.html`;

    return res.json({ ok: true, shareId, publicUrl, manifestKey });
  } catch (e) {
    console.error("publish-minisite error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- PUBLISHED MANIFEST FOR WEB APP (MUST INCLUDE tracks[]) ----------
// The blackout-web UI calls:
//   GET {VITE_ALBUM_BACKEND_URL}/api/publish/:shareId/manifest
// and expects: { ok:true, tracks:[...], albumName, coverUrl/coverS3Key, ... }
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const shareId = String(req.params.shareId || "").trim();
    if (!shareId) return res.status(400).json({ ok: false, error: "missing shareId" });

    const pointerKey = `public/players/${shareId}/manifest.json`;

    // 1) read publish pointer (contains snapshotKey)
    const pointer = await getObjectJson(pointerKey);

    const snapshotKey = String(pointer?.snapshotKey || "").trim();
    if (!snapshotKey) {
      return res.status(404).json({ ok: false, error: "PUBLISH_POINTER_MISSING_SNAPSHOT_KEY", pointerKey, pointer });
    }

    // 2) read snapshot project JSON
    const project = await getObjectJson(snapshotKey);

    // 3) extract UI-friendly fields
    const albumName = firstStr(
      project?.albumName,
      project?.albumTitle,
      project?.title,
      project?.album?.name,
      project?.album?.title,
      project?.meta?.albumName,
      project?.meta?.albumTitle
    );

    const performers = firstStr(project?.performers, project?.artist, project?.album?.artist, project?.meta?.performers);
    const releaseDate = firstStr(project?.releaseDate, project?.album?.releaseDate, project?.meta?.releaseDate);

    const coverUrl = firstStr(project?.coverUrl, project?.album?.coverUrl, project?.meta?.coverUrl);
    const coverS3Key = firstStr(project?.coverS3Key, project?.album?.coverS3Key, project?.meta?.coverS3Key);

    const tracks = extractTracksFromSnapshot(project);

    // Optional meta-by-slot (lyrics/credits)
    const metaBySlot = extractMetaBySlot(project);

    // 4) respond in the shape blackout-web expects
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      shareId,
      projectId: String(pointer?.projectId || project?.projectId || ""),
      snapshotKey,
      publishedAt: String(pointer?.publishedAt || ""),
      version: Number(pointer?.version || 1),

      albumName: albumName || "Album",
      performers: performers || undefined,
      releaseDate: releaseDate || undefined,

      coverUrl: coverUrl || undefined,
      coverS3Key: coverS3Key || undefined,

      tracks,
      metaBySlot: metaBySlot || undefined,
    });
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
