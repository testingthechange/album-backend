// storage.js (CommonJS)
// Cloudflare R2 via S3-compatible AWS SDK v3

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const R2_BUCKET = process.env.R2_BUCKET || process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ENDPOINT =
  process.env.R2_ENDPOINT ||
  (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");

const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "";
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "";

// Optional public base used by saveFileToR2 when you want a public URL.
// If your bucket is private, you can still return a "r2://" style URL and later presign via backend.
const PUBLIC_R2_BASE = (process.env.PUBLIC_R2_BASE_URL || "").trim();

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env: ${name}`);
}

function makeClient() {
  requireEnv("R2_BUCKET (or AWS_S3_BUCKET/S3_BUCKET)", R2_BUCKET);
  requireEnv("R2_ENDPOINT (or R2_ACCOUNT_ID)", R2_ENDPOINT);
  requireEnv("R2_ACCESS_KEY_ID (or AWS_ACCESS_KEY_ID)", ACCESS_KEY_ID);
  requireEnv("R2_SECRET_ACCESS_KEY (or AWS_SECRET_ACCESS_KEY)", SECRET_ACCESS_KEY);

  return new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });
}

let _client = null;
function client() {
  if (!_client) _client = makeClient();
  return _client;
}

async function saveFileToR2({ key, contentType, body }) {
  if (!key) throw new Error("saveFileToR2: missing key");
  if (!body) throw new Error("saveFileToR2: missing body");

  await client().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "no-store, max-age=0",
    })
  );

  // If you have a public base (custom domain/CDN), return a usable URL
  if (PUBLIC_R2_BASE) {
    const base = PUBLIC_R2_BASE.replace(/\/+$/, "");
    const safeKey = String(key).replace(/^\/+/, "");
    return `${base}/${safeKey}`;
  }

  // Otherwise return a descriptive non-public URL
  return `r2://${R2_BUCKET}/${key}`;
}

async function putJson(key, obj) {
  if (!key) throw new Error("putJson: missing key");
  const body = Buffer.from(JSON.stringify(obj ?? {}, null, 2));
  await client().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store, max-age=0",
    })
  );
  return { ok: true, key };
}

async function streamToString(stream) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function getJson(key) {
  if (!key) throw new Error("getJson: missing key");

  try {
    const out = await client().send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    );

    if (!out || !out.Body) throw new Error("Missing Body from GetObject");
    const txt = await streamToString(out.Body);
    const parsed = JSON.parse(txt);
    return parsed;
  } catch (err) {
    // Normalize "not found" into null so callers can decide how to respond
    const msg = String(err?.name || err?.Code || err?.message || err);
    const isNotFound =
      msg.includes("NoSuchKey") ||
      msg.includes("NotFound") ||
      msg.includes("404") ||
      msg.includes("The specified key does not exist");

    if (isNotFound) return null;
    throw err;
  }
}

module.exports = {
  saveFileToR2,
  putJson,
  getJson, // ✅ required by /api/master-save/latest/:projectId
};
