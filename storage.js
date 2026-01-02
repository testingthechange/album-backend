// storage.js
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

// OPTIONAL dependency (prevents deploy crash if not installed)
let getSignedUrl = null;
try {
  ({ getSignedUrl } = require("@aws-sdk/s3-request-presigner"));
} catch (e) {
  // Do not crash the server if the package isn't installed yet
  console.warn("⚠️ @aws-sdk/s3-request-presigner not installed. Presigned URLs disabled.");
}

// ---------- ENV ----------
const BUCKET =
  process.env.AWS_S3_BUCKET ||
  process.env.S3_BUCKET ||
  process.env.R2_BUCKET;

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "auto";

const ENDPOINT =
  process.env.AWS_ENDPOINT ||
  process.env.R2_ENDPOINT ||
  undefined;

// Optional: if your bucket is public via a domain, set this and we can return playable URLs without presigning
// Example: https://pub-xxxxx.r2.dev  OR https://files.yourdomain.com
const PUBLIC_FILES_BASE_URL = String(process.env.PUBLIC_FILES_BASE_URL || "").replace(/\/+$/, "");

if (!BUCKET) console.warn("⚠️ storage.js: BUCKET env var missing");

// ---------- CLIENT ----------
const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
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
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await streamToString(out.Body);
    return JSON.parse(text);
  } catch (err) {
    const code = err?.name || err?.Code || "";
    const http = err?.$metadata?.httpStatusCode;
    if (http === 404 || code === "NoSuchKey" || code === "NotFound") {
      throw new Error("JSON_NOT_FOUND");
    }
    throw err;
  }
}

// ---------- FILE UPLOAD ----------
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

// ---------- PLAYBACK URL HELPERS ----------
function buildPublicUrl(key) {
  if (!PUBLIC_FILES_BASE_URL) return "";
  return `${PUBLIC_FILES_BASE_URL}/${String(key).replace(/^\/+/, "")}`;
}

async function presignGetUrl(key, expiresInSeconds = 60 * 20) {
  if (!key) throw new Error("presignGetUrl: missing key");

  // If you set PUBLIC_FILES_BASE_URL, we can return playable URLs without presigner.
  const publicUrl = buildPublicUrl(key);
  if (publicUrl) return publicUrl;

  // If presigner isn't installed, don't crash; return empty string (server can still publish manifests).
  if (!getSignedUrl) return "";

  return await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseCacheControl: "no-store, max-age=0",
    }),
    { expiresIn: expiresInSeconds }
  );
}

module.exports = {
  putJson,
  getJson,
  saveFileToR2,
  presignGetUrl,
};
