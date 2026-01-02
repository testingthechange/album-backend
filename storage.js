// storage.js
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET || process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;

// R2 endpoint example:
// https://<ACCOUNT_ID>.r2.cloudflarestorage.com
const ENDPOINT =
  process.env.R2_ENDPOINT ||
  (ACCOUNT_ID ? `https://${ACCOUNT_ID}.r2.cloudflarestorage.com` : null);

function r2Configured() {
  return Boolean(ENDPOINT && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET);
}

function getClient() {
  if (!r2Configured()) return null;

  return new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });
}

// --- helpers to read GetObject body ---
async function streamToString(stream) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

// ✅ Upload any file buffer to R2
async function saveFileToR2({ key, contentType, body }) {
  const client = getClient();
  if (!client) throw new Error("R2 credentials are missing! Check env vars.");

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "no-store, max-age=0",
    })
  );

  // Public URL depends on your setup; backend doesn’t need it for master-save.
  return { ok: true, key };
}

// ✅ Write JSON to R2
async function putJson(key, obj) {
  const client = getClient();
  if (!client) throw new Error("R2 credentials are missing! Check env vars.");

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(JSON.stringify(obj ?? {}, null, 2)),
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store, max-age=0",
    })
  );

  return { ok: true, key };
}

// ✅ READ JSON from R2  (THIS IS WHAT YOU WERE MISSING)
async function getJson(key) {
  const client = getClient();
  if (!client) throw new Error("R2 credentials are missing! Check env vars.");

  const out = await client.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );

  const raw = await streamToString(out.Body);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON at key: ${key}`);
  }
}

module.exports = {
  saveFileToR2,
  putJson,
  getJson,
};
