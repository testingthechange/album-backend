// ✅ Option 1 endpoint (read-only): GET /api/publish/:shareId/manifest
// IMPORTANT: blackout-web currently expects { ok:true, manifest:{ album:{...} } }
// So we wrap the stored manifest into that legacy shape.
app.get("/api/publish/:shareId/manifest", async (req, res) => {
  try {
    const shareId = String(req.params.shareId || "").trim();
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_SHARE_ID" });

    const manifestKey = `public/players/${shareId}/manifest.json`;
    const stored = await getJson(manifestKey);

    if (!stored) {
      return res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND", shareId });
    }

    // stored is what publish-minisite wrote:
    // { ok:true, version, shareId, projectId, snapshotKey, publishedAt, tracks:[{slot,title,s3Key,url}] }

    const tracks = Array.isArray(stored.tracks) ? stored.tracks : [];

    // Build the legacy "album" object the deployed blackout-web expects.
    const album = {
      id: `published-${stored.shareId || shareId}`,
      albumName: "Published Album",
      artist: "Smart Bridge",
      coverUrl: "https://placehold.co/600x600/png?text=cover",
      releaseDate: stored.publishedAt ? String(stored.publishedAt).slice(0, 10) : "—",
      shareId: stored.shareId || shareId,
      isPublished: true,
      tracks: tracks.map((t, i) => ({
        id: `pub-${stored.shareId || shareId}-${i}`,
        title: t.title || `Track ${i + 1}`,
        url: t.url || "",        // ✅ presigned playable URL
        previewUrl: t.url || "", // ✅ preview uses same URL for now
        s3Key: t.s3Key || "",
        slot: t.slot || (i + 1),
      })),
    };

    // ✅ Return both:
    // - legacy wrapper (for blackout-web currently deployed)
    // - and the raw stored manifest (for debugging / future)
    return res.json({
      ok: true,
      manifest: { album },
      raw: stored,
    });
  } catch (err) {
    console.error("publish manifest error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});
