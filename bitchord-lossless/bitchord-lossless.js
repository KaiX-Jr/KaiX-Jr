/*
 * BitChord Lossless Remote Adapter
 * Target: BitChord 1.5.2 custom HTTP/QuickJS source-module system
 *
 * This module talks only to public HTTPS APIs. It does not require a local
 * server and does not bypass DRM. It resolves a BitChord/YouTube Music track
 * to a lossless-provider track and returns a playable FLAC/DASH URL.
 *
 * IMPORTANT:
 * BitChord 1.5.2's release notes confirm the QuickJS/Convx-style module
 * system, but the public project does not document the full JS ABI. This
 * file therefore exposes several common entrypoint aliases so it can be
 * adapted easily if the installed build expects a specific name.
 */

const API_KEY = "explore-obscure-chivalry-travesty-blinks";

const PROVIDERS = [
  { name: "tidal",  base: "https://tdl-foss.spotbye.qzz.io" },
  { name: "qobuz",  base: "https://qbz-foss.spotbye.qzz.io" },
  { name: "amazon", base: "https://amz-foss.spotbye.qzz.io" }
];

const STATUS_URL = "https://spotbye.qzz.io/api/status";
const ODESLI_URL = "https://api.song.link/v1-alpha.1/links";

function enc(v) {
  return encodeURIComponent(String(v ?? ""));
}

function str(v) {
  return v == null ? "" : String(v);
}

function firstArtist(artist) {
  const s = str(artist);
  return s.split(/\s*(?:,|&|feat\.?|ft\.?|featuring)\s*/i)[0].trim() || s;
}

function seconds(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeTrack(input) {
  const x = input || {};
  const videoId = x.videoId || x.video_id || x.youtubeId || x.youtube_id || x.id;
  let url = x.url || x.youtubeUrl || x.youtube_url || x.sourceUrl || x.source_url || "";
  if (!url && videoId) url = "https://music.youtube.com/watch?v=" + enc(videoId);

  return {
    title: str(x.title || x.name || x.track || x.song),
    artist: str(x.artist || x.artists || x.artistName),
    album: str(x.album || x.albumName),
    duration: seconds(x.duration || x.durationSeconds || x.duration_seconds),
    isrc: str(x.isrc || x.ISRC),
    url
  };
}

async function getJson(url, options) {
  const res = await fetch(url, Object.assign({
    headers: {
      "Accept": "application/json",
      "User-Agent": "BitChord-Lossless/1.0"
    }
  }, options || {}));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  return { status: res.status, ok: res.ok, data, text };
}

function entityId(linksByPlatform, platform, prefix) {
  const p = linksByPlatform && linksByPlatform[platform];
  const u = p && p.entityUniqueId;
  if (!u) return null;
  return str(u).startsWith(prefix) ? str(u).slice(prefix.length) : str(u).split("::").pop();
}

async function resolveProviderIds(track) {
  let tidalId = null;
  let amazonId = null;
  let qobuzId = null;

  // Best-effort exact cross-service mapping through song.link/Odesli.
  if (track.url) {
    const q = await getJson(ODESLI_URL + "?url=" + enc(track.url));
    const links = q.data && q.data.linksByPlatform;
    if (links) {
      tidalId = entityId(links, "tidal", "TIDAL_SONG::");
      amazonId = entityId(links, "amazonMusic", "AMAZON_SONG::");
    }
  }

  // Optional direct provider identifiers if the caller already has them.
  const extra = track.providerIds || {};
  tidalId = tidalId || extra.tidal || track.tidalId || null;
  amazonId = amazonId || extra.amazon || track.amazonId || null;
  qobuzId = extra.qobuz || track.qobuzId || null;

  return { tidalId, qobuzId, amazonId };
}

function pickUrl(obj) {
  const candidates = [];
  if (!obj) return null;
  for (const k of ["url", "download_url", "stream_url", "streamUrl"]) {
    if (typeof obj[k] === "string" && obj[k].startsWith("http")) candidates.push(obj[k]);
  }
  if (obj.data && typeof obj.data === "object") {
    return pickUrl(obj.data);
  }
  return candidates[0] || null;
}

function qualityFromUrl(url) {
  const s = str(url).toLowerCase();
  if (s.includes("flac") || s.includes("lossless") || s.includes("hi-res")) return "lossless";
  return "unknown";
}

async function communityDl(provider, id, quality = "LOSSLESS") {
  if (!id) return null;

  const res = await getJson(provider.base + "/api/dl", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "BitChord-Lossless/1.0",
      "x-api-key": API_KEY
    },
    body: JSON.stringify({ id: String(id), quality })
  });

  if (res.status === 503 || res.status === 429) return null;
  if (!res.ok || !res.data) return null;

  let url = pickUrl(res.data);
  if (!url && typeof res.data === "object" && typeof res.data.url === "string") {
    url = res.data.url;
  }

  // Some current SpotiFLAC responses may use MANIFEST:<base64>.
  if (url && url.startsWith("MANIFEST:")) {
    const b64 = url.slice("MANIFEST:".length).trim();
    try {
      const decoded = atob(b64);
      if (!decoded.includes("<MPD")) {
        const obj = JSON.parse(decoded);
        const u = pickUrl(obj);
        if (u) url = u;
      } else {
        url = "data:application/dash+xml;base64," + b64;
      }
    } catch (_) {}
  }

  if (!url) return null;

  return {
    url,
    provider: provider.name,
    container: url.startsWith("data:application/dash+xml") ? "dash" : "flac",
    quality: qualityFromUrl(url)
  };
}

function makeResult(track, stream) {
  if (!stream) return null;
  const q = track.duration ? Math.round(track.duration) : null;

  return {
    id: track.videoId || track.id || track.url || (track.title + "|" + track.artist),
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: q,
    streamUrl: stream.url,
    url: stream.url,
    audioUrl: stream.url,
    codec: stream.container === "dash" ? "FLAC/DASH" : "FLAC",
    container: stream.container,
    quality: stream.quality === "lossless" ? "LOSSLESS" : "UNKNOWN",
    bitDepth: null,
    sampleRate: null,
    provider: stream.provider
  };
}

async function resolve(input) {
  const track = normalizeTrack(input);
  if (!track.title && !track.url) throw new Error("BitChord Lossless: missing track title/url");

  const ids = await resolveProviderIds(track);

  // Prefer Tidal, then Qobuz, then Amazon.
  const order = [
    [PROVIDERS[0], ids.tidalId],
    [PROVIDERS[1], ids.qobuzId],
    [PROVIDERS[2], ids.amazonId]
  ];

  for (const [provider, id] of order) {
    if (!id) continue;
    const hit = await communityDl(provider, id, "LOSSLESS");
    if (hit) return makeResult(track, hit);
  }

  return null;
}

async function search(input) {
  const track = normalizeTrack(input);
  // BitChord already owns catalogue search. This source is an upgrade source,
  // so return the input as the candidate rather than duplicating YT Music search.
  return [{
    id: track.url || (track.title + "|" + track.artist),
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration
  }];
}

async function health() {
  const r = await getJson(STATUS_URL);
  if (!r.ok || !r.data) return { ok: false, providers: [] };

  const status = r.data.spotiflac && r.data.spotiflac.status;
  const providers = [];
  for (const p of ["tidal", "qobuz", "amazon"]) {
    if (status && status[p]) providers.push({ name: p, status: status[p] });
  }
  return { ok: true, providers };
}

// Broad export surface for QuickJS/Convx-style runtimes.
const moduleApi = {
  manifest: {
    id: "bitchord-lossless",
    name: "BitChord Lossless Remote",
    version: "0.1.0",
    author: "Local adapter",
    description: "Remote FLAC/ALAC upgrade source using community lossless APIs",
    capabilities: ["search", "stream", "health"]
  },

  health,
  test: health,
  search,
  find: search,

  resolve,
  stream: resolve,
  getStream: resolve,
  resolveStream: resolve,

  // Common metadata aliases used by source-module systems.
  getSource: resolve,
  source: resolve
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = moduleApi;
}

// ESM/QuickJS-friendly global export fallback.
if (typeof globalThis !== "undefined") {
  globalThis.BitChordLossless = moduleApi;
}
