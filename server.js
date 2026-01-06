// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(express.json());

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const AWS_REGION = process.env.AWS_REGION || "us-west-1";
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || "";
const SIGNED_URL_EXPIRES_SECONDS = Number(
  process.env.SIGNED_URL_EXPIRES_SECONDS || 1200
);

const ALLOWED_ORIGINS = [
  "https://blackout-web.onrender.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------- S3 ----------
const s3 = new S3Client({ region: AWS_REGION });

// ---------- UPLOAD (multer in-memory) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});

// ---------- HELPERS ----------
function must(v, msg) {
  if (!v) throw new Error(msg);
  return v;
}

// ---------- HEALTH ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "album-backend", version: 1 });
});

// ---------- UPLOAD HANDLER (SHARED) ----------
async function uploadToS3Handler(req, res) {
  try {
    const projectId = String(req.query.projectId || "").trim();
    if (!projectId) {
      return res.status(400).json({ ok: false, error: "missing projectId" });
    }

    const file = req.file;
    const s3Key = String(req.body?.s3Key || "").trim();

    if (!file) {
      return res.status(400).json({ ok: false, error: "missing file" });
    }
    if (!s3Key) {
      return res.status(400).json({ ok: false, error: "missing s3Key" });
    }

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype || "application/octet-stream",
        Metadata: {
          projectid: projectId,
        },
      })
    );

    return res.json({
      ok: true,
      bucket,
      s3Key,
    });
  } catch (e) {
    console.error("upload-to-s3 error:", e);
    return res
      .status(500)
      .json({ ok: false, error: String(e?.message || e) });
  }
}

// ---------- MOUNT BOTH ROUTES (CRITICAL FIX) ----------
app.post("/upload-to-s3", upload.single("file"), uploadToS3Handler);
app.post("/api/upload-to-s3", upload.single("file"), uploadToS3Handler);

// ---------- PLAYBACK URL ----------
app.get("/api/playback-url", async (req, res) => {
  try {
    const s3Key = String(req.query.s3Key || "").trim();
    if (!s3Key) {
      return res.status(400).json({ ok: false, error: "missing s3Key" });
    }

    const bucket = must(S3_BUCKET, "Missing env S3_BUCKET");

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
    const url = await getSignedUrl(s3, cmd, {
      expiresIn: SIGNED_URL_EXPIRES_SECONDS,
    });

    return res.json({
      ok: true,
      url,
      expiresSeconds: SIGNED_URL_EXPIRES_SECONDS,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
  console.log(`AWS_REGION=${AWS_REGION}`);
  console.log(`S3_BUCKET=${S3_BUCKET || "(missing)"}`);
});

