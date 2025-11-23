// storage.js
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function saveFileToR2({ key, contentType, body }) {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  const base = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const url = `${base}/${key}`;
  return url;
}

module.exports = { saveFileToR2 };
