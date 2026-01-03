// storage.js — AWS S3-backed JSON + file storage + presigned GET

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const AWS_REGION = String(process.env.AWS_REGION || "").trim();
const S3_BUCKET = String(process.env.S3_BUCKET || "").trim();

if (!AWS_REGION) console.warn("⚠️ AWS_REGION missing");
if (!S3_BUCKET) console.warn("⚠️ S3_BUCKET missing");

const s3 = new S3Client({ region: AWS_REGION });

async function putObjectToS3({ key, body, contentType }) {
  if (!S3_BUCKET) throw new Error("S3_BUCKET missing");
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );
  return { ok: true, key };
}

async function presignGetUrl(key, expiresSeconds = 1200) {
  if (!S3_BUCKET) throw new Error("S3_BUCKET missing");
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return await getSignedUrl(s3, cmd, { expiresIn: expiresSeconds });
}

async function putJson(key, obj) {
  const body = Buffer.from(JSON.stringify(obj ?? {}, null, 2), "utf8");
  return await putObjectToS3({ key, body, contentType: "application/json" });
}

async function getJson(key) {
  if (!S3_BUCKET) throw new Error("S3_BUCKET missing");
  const url = await presignGetUrl(key, 60); // short-lived fetch
  const res = await fetch(url);
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

module.exports = { putJson, getJson, presignGetUrl, putObjectToS3 };
