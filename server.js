// server.js
// Backend manifest contract for betablocker
// Endpoints:
//   GET  /health
//   GET  /publish
//   GET  /publish/:shareId.json
//   GET  /media/*.mp3

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(
  cors({
    origin: ["https://betablocker.onrender.com", "http://localhost:5173"],
  })
);

app.use(express.json());

// Serve audio previews from repo folder ./media
app.use("/media", express.static(path.join(__dirname, "media")));

// IMPORTANT: This is the public base for previewUrl values.
// If you ever change your backend URL, update this one line.
const BASE_URL = "https://album-backend-kmuo.onrender.com";

// Demo manifest: previewUrl points to this backend's /media files
const manifests = {
  demo: {
    albumTitle: "Demo Album",
    tracks: [
      {
        id: "t1",
        title: "Track 1",
        duration: "3:12",
        previewUrl: `${BASE_URL}/media/track1-preview.mp3`,
      },
      {
        id: "t2",
        title: "Track 2",
        duration: "2:58",
        previewUrl: `${BASE_URL}/media/track2-preview.mp3`,
      },
      {
        id: "t3",
        title: "Track 3",
        duration: "4:01",
        previewUrl: `${BASE_URL}/media/track3-preview.mp3`,
      },
    ],
  },
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/publish", (_req, res) => {
  res.json({ shareIds: Object.keys(manifests) });
});

app.get("/publish/:shareId.json", (req, res) => {
  const { shareId } = req.params;
  const manifest = manifests[shareId];

  if (!manifest) return res.status(404).json({ error: "not_found", shareId });

  return res.json({ shareId, ...manifest });
});

app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /publish/demo.json");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
});
