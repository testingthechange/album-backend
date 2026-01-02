// storage.js
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

let getSignedUrl = null;
try {
  ({ getSignedUrl } = require("@aws-sdk/s3-request-presigner"));
} catch (e) {
  console.warn("⚠️ @aws-sdk/s3-request-presigner not installed. Presigned URLs disabled.");
}

// ---------- ENV ----------
const BUCKET = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || process.env.R2_BUCKET;

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "auto";
const ENDPOINT = process.env.AWS_ENDPOINT || process.env.R2_ENDPOINT;

// Optional: if your bucket is public via a domain, set this and we can return playable URLs without presigning
// Example: https://block-7306-player.s3.us-west-1.amazonaws.com
const PUBLIC_FILES_BASE_URL = (process.env.PUBLIC_FILES_BASE_URL || "").trim().replace(/\/+$/, "");

if (!BUCKET) console.warn("⚠️ storage.js: BUCKET env var missing");

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT || undefined,
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
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
    const code = err?.$metadata?.httpStatusCode;
    if (code === 404) throw new Error("JSON_NOT_FOUND");
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

// ---------- PRESIGN ----------
async function presignGetUrl(key, expiresInSeconds = 60 * 20) {
  if (!key) throw new Error("presignGetUrl: missing key");

  // If files are public, skip presign
  if (PUBLIC_FILES_BASE_URL) return `${PUBLIC_FILES_BASE_URL}/${key.replace(/^\/+/, "")}`;

  if (!getSignedUrl) return ""; // don’t crash if missing

  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseCacheControl: "no-store, max-age=0",
  });

  return await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}

module.exports = {
  putJson,
  getJson,
  saveFileToR2,
  presignGetUrl,
};
