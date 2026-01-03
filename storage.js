// storage.js (Render / R2-backed storage)
//
// Required env vars on Render:
// - R2_ENDPOINT           (e.g. https://<accountid>.r2.cloudflarestorage.com)
// - R2_ACCESS_KEY_ID
// - R2_SECRET_ACCESS_KEY
// - R2_BUCKET
//
// Optional:
// - R2_PUBLIC_BASE_URL    (if you want to build public urls; not required here)

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const endpoint = process.env.R2_ENDPOINT;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;

if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
  // Fail fast, but do not crash on import; callers will see clearer runtime errors.
  console.warn(
    "[storage] Missing one or more R2 env vars: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET"
  );
}

const s3 = new S3Client({
  region: "auto",
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
});

// ---------- helpers ----------
function isNotFoundErr(err) {
  const name = err?.name || "";
  const code = err?.$metadata?.httpStatusCode;
  return name === "NoSuchKey" || code === 404;
}

async function streamToString(stream) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// ---------- JSON write ----------
async function putJson(key, obj) {
  if (!bucket) throw new Error("R2_BUCKET missing");
  const Body = Buffer.from(JSON.stringify(obj ?? {}, null, 2), "utf8");

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: String(key || "").replace(/^\/+/, ""),
      Body,
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store",
    })
  );

  return { ok: true, key };
}

// ---------- JSON read ----------
async function getJson(key) {
  if (!bucket) throw new Error("R2_BUCKET missing");

  const Key = String(key || "").replace(/^\/+/, "");
  try {
    const out = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key,
      })
    );

    const text = await streamToString(out.Body);
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (err) {
    if (isNotFoundErr(err)) return null;
    throw err;
  }
}

// ---------- presign GET url for an R2 object key ----------
async function presignGetUrl(s3Key, expiresInSeconds = 1200) {
  if (!bucket) throw new Error("R2_BUCKET missing");
  const Key = String(s3Key || "").replace(/^\/+/, "");
  if (!Key) throw new Error("presignGetUrl missing s3Key");

  return await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key,
    }),
    { expiresIn: Number(expiresInSeconds) || 1200 }
  );
}

module.exports = {
  putJson,
  getJson,
  presignGetUrl,
};
