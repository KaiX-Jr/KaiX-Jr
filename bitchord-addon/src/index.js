const NAME = "BitChord Lossless";
const VERSION = "1.0.0";

// Public community TIDAL proxy instances. These are unofficial and can go down.
const TIDAL_APIS = [
  "https://api.monochrome.tf",
  "https://monochrome-api.samidy.com",
  "https://hifi.geeked.wtf"
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...extra
    }
  });
}

function textError(status, message) {
  return json({ error: message }, status);
}

async function fetchJson(url, init = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "BitChord-Lossless/1.0",
        ...(init.headers || {})
      }
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Ignore malformed upstream payloads and let the caller try another mirror.
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromMirrors(path, init = {}) {
  let lastError = null;
  for (const base of TIDAL_APIS) {
    try {
      const result = await fetchJson(base + path, init);
      if (result.response.ok && result.data) return { ...result, base };
      lastError = new Error(`upstream ${result.response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No upstream mirror available");
}

function artworkUrl(cover) {
  if (!cover) return null;
  // TIDAL cover identifiers are UUID-like hex paths separated by slashes.
  const clean = String(cover).replace(/-/g, "/");
  return `https://resources.tidal.com/images/${clean}/640x640.jpg`;
}

function normalizeTrack(item) {
  const artist = item.artist?.name || item.artists?.[0]?.name || "Unknown Artist";
  const album = item.album?.title || "";
  return {
    id: `tidal:${item.id}`,
    title: item.title || "Unknown Title",
    artist,
    album,
    duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
    artworkURL: artworkUrl(item.album?.cover),
    format: "flac",
    tidalId: String(item.id)
  };
}

function decodeBase64Json(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function resolveTidalStream(tidalId) {
  const path = `/track/?id=${encodeURIComponent(tidalId)}&quality=HI_RES_LOSSLESS`;
  const upstream = await fetchFromMirrors(path);
  const data = upstream.data?.data;
  if (!data) throw new Error("TIDAL did not return track data");

  let streamUrl = null;
  const rawManifest = data.manifest;
  if (rawManifest) {
    try {
      const manifest = decodeBase64Json(rawManifest);
      const urls = Array.isArray(manifest.urls) ? manifest.urls : [];
      if (typeof urls[0] === "string" && /^https?:\/\//.test(urls[0])) {
        streamUrl = urls[0];
      }
    } catch {
      // Some mirrors may return a different manifest representation.
    }
  }

  if (!streamUrl && typeof data.manifest === "string" && /^https?:\/\//.test(data.manifest)) {
    streamUrl = data.manifest;
  }

  if (!streamUrl) {
    throw new Error("No playable lossless URL in TIDAL response");
  }

  return {
    url: streamUrl,
    format: "flac",
    quality: data.audioQuality === "HI_RES_LOSSLESS" ? "hi-res lossless" : "lossless",
    codec: "flac",
    container: "flac",
    manifest: "none",
    sampleRate: Number(data.sampleRate) || null,
    bitDepth: Number(data.bitDepth) || null,
    provider: "tidal"
  };
}

async function handleSearch(query) {
  if (!query.trim()) return json({ tracks: [] });

  try {
    const upstream = await fetchFromMirrors(`/search/?s=${encodeURIComponent(query)}&limit=20`);
    const items = upstream.data?.data?.items;
    if (!Array.isArray(items)) return json({ tracks: [] });

    const tracks = items
      .filter(item => item && item.id && item.title)
      .map(normalizeTrack)
      .filter(track => track.duration == null || track.duration > 0);

    return json({ tracks });
  } catch (error) {
    return textError(502, `Search upstream unavailable: ${error?.message || "unknown error"}`);
  }
}

async function handleStream(id) {
  const tidalId = String(id).replace(/^tidal:/i, "").trim();
  if (!/^\d+$/.test(tidalId)) {
    return textError(400, "Invalid TIDAL track id");
  }

  try {
    const stream = await resolveTidalStream(tidalId);
    return json(stream, 200, {
      // The URL is a signed CDN URL and should not be cached for long.
      "Cache-Control": "no-store"
    });
  } catch (error) {
    return textError(502, `Lossless stream unavailable: ${error?.message || "unknown error"}`);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "GET") {
      return textError(405, "Method not allowed");
    }

    if (url.pathname === "/" || url.pathname === "/manifest.json") {
      return json({
        id: "com.kai.jr.bitchord.lossless",
        name: NAME,
        version: VERSION,
        description: "Lossless FLAC source for BitChord using public community TIDAL APIs.",
        author: "KaiX-Jr",
        resources: ["search", "stream"]
      });
    }

    if (url.pathname === "/search") {
      return handleSearch(url.searchParams.get("q") || "");
    }

    if (url.pathname.startsWith("/stream/")) {
      return handleStream(decodeURIComponent(url.pathname.slice("/stream/".length)));
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: NAME, version: VERSION, providers: TIDAL_APIS });
    }

    return textError(404, "Not found");
  }
};
