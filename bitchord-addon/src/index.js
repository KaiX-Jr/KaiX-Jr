const NAME = "BitChord Lossless";
const VERSION = "1.0.1";

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

async function fetchResponse(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": "BitChord-Lossless/1.0.1",
        ...(init.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, init = {}, timeoutMs = 8000) {
  const response = await fetchResponse(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers || {})
    }
  }, timeoutMs);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Ignore malformed upstream payloads and let the caller try another mirror.
  }
  return { response, data, text };
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
    audioQuality: "LOSSLESS",
    tidalId: String(item.id)
  };
}

function decodeBase64Text(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeManifestText(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();

  // Some hifi-api versions return a base64-encoded BTS manifest.
  try {
    const decoded = decodeBase64Text(raw).trim();
    if (decoded.startsWith("{") || decoded.startsWith("[") || decoded.startsWith("<")) {
      return decoded;
    }
  } catch {
    // Not base64; use the raw value below.
  }

  return raw;
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function chooseFlacUrl(urls) {
  if (!Array.isArray(urls)) return null;
  const candidates = urls.filter(isHttpUrl);
  if (!candidates.length) return null;

  // Prefer URLs that explicitly identify FLAC/lossless content.
  const ranked = candidates.slice().sort((a, b) => {
    const rank = url => {
      const low = url.toLowerCase();
      if (low.includes("flac")) return 0;
      if (low.includes("lossless")) return 1;
      if (low.includes("hi-res") || low.includes("hires")) return 2;
      return 10;
    };
    return rank(a) - rank(b);
  });

  return ranked[0];
}

function flacUrlFromManifest(value) {
  const text = decodeManifestText(value);
  if (!text) return null;

  // A DASH MPD is segmented transport, not a single-file FLAC URL.
  if (/<MPD(?:\s|>)/i.test(text)) return null;

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.urls)) {
      return chooseFlacUrl(parsed.urls);
    }
    if (isHttpUrl(parsed?.url)) {
      return parsed.url;
    }
  } catch {
    // Fall through to a conservative URL scan for older API variants.
  }

  const match = text.match(/https?:\/\/[^"'\s]+/i);
  return match?.[0] || null;
}

function extractManifestUri(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [
    body?.data?.data?.attributes?.uri,
    body?.data?.attributes?.uri,
    body?.attributes?.uri,
    body?.uri
  ];
  return candidates.find(isHttpUrl) || null;
}

function losslessStream(url, data = {}) {
  return {
    url,
    format: "flac",
    quality: data.bitDepth
      ? `${data.bitDepth}-bit FLAC`
      : "lossless FLAC",
    streamQuality: data.audioQuality === "HI_RES_LOSSLESS"
      ? "[TIDAL] HI_RES_LOSSLESS"
      : "[TIDAL] LOSSLESS",
    audioQuality: "LOSSLESS",
    codec: "flac",
    container: "flac",
    manifest: "none",
    sampleRate: Number(data.sampleRate) || null,
    bitDepth: Number(data.bitDepth) || null,
    provider: "tidal"
  };
}

async function resolveViaTrackManifests(tidalId, base) {
  const path = `/trackManifests/?id=${encodeURIComponent(tidalId)}&quality=LOSSLESS&adaptive=false&formats=FLAC`;
  const lookup = await fetchJson(base + path, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!lookup.response.ok || !lookup.data) return null;

  const manifestUri = extractManifestUri(lookup.data);
  if (!manifestUri) return null;

  const manifestResponse = await fetchResponse(manifestUri, {
    headers: {
      Accept: "application/json, text/plain, */*"
    }
  });
  if (!manifestResponse.ok) return null;

  const manifestText = await manifestResponse.text();
  const flacUrl = flacUrlFromManifest(manifestText);
  if (!flacUrl) return null;

  return losslessStream(flacUrl, lookup.data?.data || lookup.data);
}

async function resolveViaTrack(tidalId, base) {
  // Older hifi-api builds expose /track directly. LOSSLESS is intentional:
  // HI_RES_LOSSLESS may yield a DASH MPD rather than one directly-playable FLAC.
  const path = `/track/?id=${encodeURIComponent(tidalId)}&quality=LOSSLESS&country=US`;
  const upstream = await fetchJson(base + path);
  if (!upstream.response.ok || !upstream.data) return null;

  const root = upstream.data;
  const data = root?.data && typeof root.data === "object" ? root.data : root;

  const directUrl = [
    data?.OriginalTrackUrl,
    data?.originalTrackUrl,
    data?.url
  ].find(isHttpUrl);

  if (directUrl) {
    return losslessStream(directUrl, data);
  }

  const manifest = data?.manifest ?? root?.manifest;
  const flacUrl = flacUrlFromManifest(manifest);
  if (!flacUrl) return null;

  return losslessStream(flacUrl, data);
}

async function resolveTidalStream(tidalId) {
  let lastError = null;

  for (const base of TIDAL_APIS) {
    try {
      // Newer hifi-api instances expose trackManifests and let us explicitly
      // ask for FLAC, non-adaptive LOSSLESS audio.
      const modern = await resolveViaTrackManifests(tidalId, base);
      if (modern) return modern;

      // Fall back to the older /track contract used by several mirrors.
      const legacy = await resolveViaTrack(tidalId, base);
      if (legacy) return legacy;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No directly playable FLAC URL in TIDAL response");
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
      // Signed CDN URLs should never be cached by the Worker.
      "Cache-Control": "no-store"
    });
  } catch (error) {
    return textError(502, `Lossless FLAC stream unavailable: ${error?.message || "unknown error"}`);
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

    // BitChord's addon protocol uses /stream/{id}. Also accept /stream?id=
    // for compatibility with simple clients and manual testing.
    if (url.pathname.startsWith("/stream/")) {
      return handleStream(decodeURIComponent(url.pathname.slice("/stream/".length)));
    }

    if (url.pathname === "/stream" && url.searchParams.has("id")) {
      return handleStream(url.searchParams.get("id") || "");
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: NAME,
        version: VERSION,
        mode: "direct-flac",
        providers: TIDAL_APIS
      });
    }

    return textError(404, "Not found");
  }
};
