import express from "express";
import cors from "cors";

const app = express();

// Allow your frontend to fetch from Render static site.
// You can widen this later if you embed elsewhere.
app.use(
  cors({
    origin: [
      "https://betablocker.onrender.com",
      "http://localhost:5173"
    ],
  })
);

app.use(express.json());

// --- In-memory stub manifests (replace with real storage later) ---
const manifests = {
  demo: {
    albumTitle: "Demo Album",
    tracks: [
      { id: "t1", title: "Track 1", duration: "3:12", previewUrl: "" },
      { id: "t2", title: "Track 2", duration: "2:58", previewUrl: "" },
      { id: "t3", title: "Track 3", duration: "4:01", previewUrl: "" }
    ]
  }
};

// --- Health check ---
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- List available shareIds ---
app.get("/publish", (_req, res) => {
  res.json({ shareIds: Object.keys(manifests) });
});

// --- Manifest endpoint (contract) ---
app.get("/publish/:shareId.json", (req, res) => {
  const { shareId } = req.params;
  const manifest = manifests[shareId];

  if (!manifest) {
    return res.status(404).json({ error: "not_found", shareId });
  }

  // Optional: include shareId in payload for debugging
  return res.json({ shareId, ...manifest });
});

// --- Root ---
app.get("/", (_req, res) => {
  res.type("text").send("album-backend OK. Try /health or /publish/demo.json");
});

// Render provides PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`album-backend listening on ${PORT}`);
});
