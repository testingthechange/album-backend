// storage.js
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

// ---------- ENV ----------
const BUCKET =
  process.env.AWS_S3_BUCKET ||
  process.env.S3_BUCKET ||
  process.env.R2_BUCKET;

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "auto"; // R2 uses "auto"

const ENDPOINT = process.env.AWS_ENDPOINT || process.env.R2_ENDPOINT;

// ---------- CLIENT ----------
if (!BUCKET) {
  console.warn("⚠️ storage.js: BUCKET env var missing");
}

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined, // Render IAM / R2 bindings
});

// ---------- HELPERS ----------
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
    if (err?.$metadata?.httpStatusCode === 404) {
      throw new Error("JSON_NOT_FOUND");
    }
    throw err;
  }
}

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

// ---------- STREAM UTILS ----------
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf-8"))
    );
  });
}

// ---------- EXPORTS ----------
module.exports = {
  putJson,
  getJson,
  saveFileToR2,
};
