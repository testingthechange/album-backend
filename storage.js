// storage.js
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.error("R2 credentials are missing! Check env vars.");
}

const bucket = process.env.R2_BUCKET || "album-storage";

async function uploadSongToR2({ projectId, songId, fileBuffer, contentType }) {
  const key = `projects/${projectId}/songs/${songId}.mp3`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType || "audio/mpeg",
  });

  await r2Client.send(command);

  // public-ish URL (we can refine later)
  const url = `${process.env.R2_ENDPOINT}/${bucket}/${key}`;
  return { key, url };
}

module.exports = { uploadSongToR2 };
