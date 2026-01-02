// storage.js
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// ---------- ENV ----------
const BUCKET =
  process.env.AWS_S3_BUCKET ||
  process.env.S3_BUCKET ||
  process.env.R2_BUCKET;

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "auto"; // R2 uses "auto"

const ENDPOINT =
  process.env.AWS_ENDPOINT ||
  process.env.R2_ENDPOINT ||
  undefined;

// If you're using Cloudflare R2, ENDPOINT is required and usually looks like:
// https://<accountid>.r2.cloudflarestorage.com
// (or a custom domain if you set one)

if (!BUCKET) console.warn("⚠️ storage.js: BUCKET env var missing");

// ---------- CLIENT ----------
const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  // R2 often needs path-style addressing; S3 generally doesn't mind.
  forcePathStyle: Boolean(ENDPOINT),
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined,
});

// ---------- STREAM UTILS ----------
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

// ---------- JSON HELPERS ----------
async function putJson(key, data) {
  if (!key) throw new Error("putJson: missing key");

  const body = Buffer.from(JSON.stringify(data, null, 2));

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store",
    })
  );

  return { ok: true, key };
}

async function getJson(key) {
  if (!key) throw new Error("getJson: missing key");

  try {
    const out = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );

    const text = await streamToString(out.Body);
    return JSON.parse(text);
  } catch (err) {
    // normalize not-found into a consistent error string
    const code = err?.name || err?.Code || "";
    const http = err?.$metadata?.httpStatusCode;

    if (http === 404 || code === "NoSuchKey" || code === "NotFound") {
      throw new Error("JSON_NOT_FOUND");
    }
    throw err;
  }
}

// ---------- FILE UPLOAD (optional; keeps your existing behavior) ----------
async function saveFileToR2({ key, body, contentType }) {
  if (!key) throw new Error("saveFileToR2: missing key");
  if (!body) throw new Error("saveFileToR2: missing body");

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "no-store",
    })
  );

  return key;
}

// ---------- PRESIGNED GET URL (THIS IS THE MISSING PIECE FOR PLAYBACK) ----------
async function presignGetUrl(key, expiresInSeconds = 60 * 20) {
  if (!key) throw new Error("presignGetUrl: missing key");

  return await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseCacheControl: "no-store, max-age=0",
      ResponseExpires: new Date(0).toUTCString(),
    }),
    { expiresIn: expiresInSeconds }
  );
}

// ---------- EXPORTS ----------
module.exports = {
  putJson,
  getJson,
  saveFileToR2,
  presignGetUrl,
};
