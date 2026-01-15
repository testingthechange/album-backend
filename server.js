// server.js
// Backend manifest contract for betablocker
// Endpoints:
//   GET  /health
//   GET  /publish
//   GET  /publish/:shareId.json

import express from "express";
import cors from "cors";

const app = express();

app.use(
  cors({
    origin: ["https://betablocker.onrender.com", "http://localhost:5173"],
  })
);

app.use(express.json());

// ---------------------------------------------------------------------
// DEMO manifest (replace previewUrl values with real URLs)
// ---------------------------------------------------------------------
const manifests = {
  demo: {
    albumTitle: "Demo Album",
    tracks: [
      {
        id: "t1",
        title: "Track 1",
        duration: "3:12",
        previewUrl: "https://YOUR_CDN_OR_S3/track1-preview.mp3",
      },
      {
        id: "t2",
        title: "Track 2",
        duration: "2:58",
        previewUrl: "https://YOUR_CDN_OR_S3/track2-preview.mp3",
      },
      {
        id: "t3",
        title: "Track 3",
        duration: "4:01",
        previewUrl: "https://YOUR_CDN_OR_S3/track3-preview.mp3",
      },
    ],
  },
};

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/publish", (_req, res) => {
  res.json({ shareIds: Object.keys(manifests) });
});

app.get("/publish/:shareId.json", (req, res) => {
  const { shareId } = req.params;
  const manifest = manifests[shareId];

  if (!manifest) {
    return res.status(404).json({ error: "not_found", shareId });
  }

  return res.json({ shareId, ...manifest });
});

app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /health or /publish/demo.json");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
});
