// PATCH for album-backend/server.js
// Adds:
// 1) POST /api/publish        (alias to /api/publish-minisite so Export.jsx stops 404'ing)
// 2) GET  /api/published/:id  (returns { ok:true, manifest } derived from published snapshot)
// Optional: also writes manifest to S3 at public/manifests/{shareId}.json for caching

/* -------------------------------------------------------------------------- */
/*  ADD THESE HELPERS somewhere near stripPlaybackUrls (before routes is fine) */
/* -------------------------------------------------------------------------- */

function parseDurationToSec(text) {
  const s = String(text || "").trim();
  const m = s.match(/^(\d+):([0-5]\d)$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function firstS3Key(...candidates) {
  for (const c of candidates) {
    const k = String(c || "").trim();
    if (k) return k;
  }
  return "";
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function ensureCredits(obj) {
  const c = obj && typeof obj === "object" ? obj : {};
  return {
    songwriters: toArray(c.songwriters).map(String).filter(Boolean),
    producers: toArray(c.producers).map(String).filter(Boolean),
    engineers: toArray(c.engineers).map(String).filter(Boolean),
    performers: toArray(c.performers).map(String).filter(Boolean),
  };
}

function convertSnapshotToManifest({ shareId, projectId, snapshotKey, snapshot, publishedAt }) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};

  const albumMeta = snap?.album?.meta || {};
  const albumTitle = String(albumMeta.albumTitle || albumMeta.title || "");
  const artistName = String(albumMeta.artistName || albumMeta.artist || "");

  // cover: prefer album.cover.s3Key, else try album.coverKey, else empty
  const coverS3Key = firstS3Key(snap?.album?.cover?.s3Key, snap?.album?.coverKey, snap?.album?.cover?.key);

  const catalogSongs = toArray(snap?.catalog?.songs);
  const metaSongs = toArray(snap?.meta?.songs);

  const tracks = catalogSongs.map((row0, i) => {
    const row = row0 && typeof row0 === "object" ? row0 : {};
    const files = row?.files || {};
    const slot = Number(row?.slot || i + 1);

    const title =
      String(row?.title || "").trim() ||
      String(metaSongs?.[i]?.title || "").trim() ||
      `Song ${i + 1}`;

    const durationText = String(row?.duration || "").trim() || "0:00";
    const durationSec = parseDurationToSec(durationText);

    // audio key: ALBUM first, then A, then B
    const s3Key = firstS3Key(files?.album?.s3Key, files?.a?.s3Key, files?.b?.s3Key);

    // meta credits/lyrics live in snap.meta.songs[i]
    const metaRow = metaSongs?.[i] && typeof metaSongs[i] === "object" ? metaSongs[i] : {};
    const credits = ensureCredits(metaRow?.credits);
    const lyricsText = String(metaRow?.lyrics?.text || metaRow?.lyricsText || "").trim();

    return {
      slot,
      title,
      durationText,
      durationSec,
      audio: { s3Key },
      credits,
      lyrics: { text: lyricsText, s3Key: "" },
    };
  });

  return {
    ok: true,
    shareId: String(shareId || "").trim(),
    projectId: String(projectId || "").trim(),
    lineage: {
      snapshotKey: String(snapshotKey || "").trim(),
      publishedAt: String(publishedAt || new Date().toISOString()),
    },
    album: {
      meta: { albumTitle, artistName },
      cover: { s3Key: coverS3Key },
      trackDurations: tracks.map((t) => ({
        slot: t.slot,
        title: t.title,
        s3Key: t.audio.s3Key,
        durationSec: t.durationSec,
        durationText: t.durationText,
      })),
      tracks, // keep full track objects too (credits + lyrics)
    },
    nftMix: snap?.nftMix || {},
  };
}

/* -------------------------------------------------------------------------- */
/*  ADD THESE ROUTES near your publish routes                                 */
/* -------------------------------------------------------------------------- */

// 1) ALIAS: Export.jsx calls /api/publish, but backend currently has /api/publish-minisite
app.post("/api/publish", async (req, res) => {
  // exact same behavior as /api/publish-minisite
  // (copy-paste the handler body so we don't rely on express internal routing)
  try {
    const projectId = safe(req.body?.projectId);
    let snapshotKey = safe(req.body?.snapshotKey);

    if (!projectId && !snapshotKey) {
      return res.status(400).json({ ok: false, error: "MISSING_projectId_AND_snapshotKey" });
    }

    if (!snapshotKey) {
      if (!projectId) return res.status(400).json({ ok: false, error: "MISSING_projectId" });
      const meta = await readJson(`storage/projects/${projectId}/producer_returns/latest.json`);
      snapshotKey = safe(meta?.latestSnapshotKey);
      if (!snapshotKey) throw new Error("LATEST_snapshotKey_MISSING");
    }

    const rawSnapshot = await readJson(snapshotKey);
    const cleanSnapshot = stripPlaybackUrls(rawSnapshot);

    const shareId = rand(12);
    const publicKey = `public/publish/${shareId}.json`;

    await putJson(publicKey, {
      shareId,
      projectId: projectId || safe(cleanSnapshot?.projectId) || "",
      snapshotKey,
      snapshot: cleanSnapshot,
      createdAt: new Date().toISOString(),
    });

    res.json({
      ok: true,
      shareId,
      snapshotKey,
      publicUrl: `${req.protocol}://${req.get("host")}/publish/${shareId}.json`,
    });
  } catch (e) {
    logErr(req, e);
    res.status(500).json({ ok: false, error: errString(e) });
  }
});

// 2) PUBLISHED MANIFEST: Player.jsx expects GET /api/published/:shareId
app.get("/api/published/:shareId", async (req, res) => {
  try {
    const shareId = safe(req.params.shareId);
    if (!shareId) return res.status(400).json({ ok: false, error: "MISSING_shareId" });

    // read the published artifact
    const pubKey = `public/publish/${shareId}.json`;
    const pub = await readJson(pubKey);

    const snapshot = pub?.snapshot;
    const snapshotKey = safe(pub?.snapshotKey);
    const projectId = safe(pub?.projectId || snapshot?.projectId);

    const manifest = convertSnapshotToManifest({
      shareId,
      projectId,
      snapshotKey,
      snapshot,
      publishedAt: pub?.createdAt || new Date().toISOString(),
    });

    // OPTIONAL CACHE (recommended): write manifest so future loads are fast + stable
    // (safe even if you keep it; it contains only s3Key, no playbackUrl)
    const manifestKey = `public/manifests/${shareId}.json`;
    try {
      await putJson(manifestKey, manifest);
    } catch (e) {
      // non-fatal; still return manifest
      console.warn("WARN: manifest cache write failed:", errString(e));
    }

    res.json({ ok: true, shareId, manifest, manifestKey, manifestUrl: `/manifests/${shareId}.json` });
  } catch (e) {
    logErr(req, e);
    res.status(404).json({ ok: false, error: errString(e) });
  }
});

// OPTIONAL: serve manifest cache directly (handy for debugging)
// NOTE: this reads from S3 via readJson, not from local filesystem.
app.get("/manifests/:shareId.json", async (req, res) => {
  try {
    const key = `public/manifests/${safe(req.params.shareId)}.json`;
    const json = await readJson(key);
    res.json(json);
  } catch (e) {
    logErr(req, e);
    res.status(404).json({ ok: false });
  }
});
