// storage.js — AWS S3 backed storage (Render)

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const bucket = process.env.S3_BUCKET;
const region = process.env.AWS_REGION;

if (!bucket || !region) {
  console.warn("[storage] Missing S3_BUCKET or AWS_REGION");
}

const s3 = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ---------- helpers ----------
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
  if (!bucket) throw new Error("S3_BUCKET missing");

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: String(key).replace(/^\/+/, ""),
      Body: JSON.stringify(obj ?? {}, null, 2),
      ContentType: "application/json",
      CacheControl: "no-store",
    })
  );

  return { ok: true, key };
}

// ---------- JSON read ----------
async function getJson(key) {
  if (!bucket) throw new Error("S3_BUCKET missing");

  try {
    const out = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: String(key).replace(/^\/+/, ""),
      })
    );

    const text = await streamToString(out.Body);
    return JSON.parse(text);
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// ---------- presign GET ----------
async function presignGetUrl(s3Key, expiresInSeconds = 1200) {
  if (!bucket) throw new Error("S3_BUCKET missing");

  return await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: String(s3Key).replace(/^\/+/, ""),
    }),
    { expiresIn: expiresInSeconds }
  );
}

module.exports = {
  putJson,
  getJson,
  presignGetUrl,
};
