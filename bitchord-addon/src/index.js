const NAME = "BitChord Lossless";
const VERSION = "1.0.2";

// Public community TIDAL proxy instances. These are unofficial and can go down.
const TIDAL_APIS = [
  "https://api.monochrome.tf",
  "https://monochrome-api.samidy.com",
  "https://hifi.geeked.wtf",
  "https://wolf.qqdl.site",
  "https://maus.qqdl.site",
  "https://vogel.qqdl.site"
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
        "User-Agent": "BitChord-Lossless/1.0.2",
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

function artworkUrl(cover) {
  if (!cover) return null;
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

function looksLikeFlacUrl(value) {
  if (!isHttpUrl(value)) return false;
  const low = value.toLowerCase();
  return low.includes(".flac") || low.includes("/flac/") || low.includes("format=flac");
}

function chooseFlacUrl(urls) {
  if (!Array.isArray(urls)) return null;
  const candidates = urls.filter(isHttpUrl);
  if (!candidates.length) return null;

  const explicit = candidates.find(looksLikeFlacUrl);
  return explicit || null;
}

function flacUrlFromManifest(value) {
  const text = decodeManifestText(value);
  if (!text) return null;

  // A DASH MPD is segmented transport and must never be mislabeled as a FLAC file.
  if (/<MPD(?:\s|>)/i.test(text)) return null;

  try {
    const parsed = JSON.parse(text);
    const mimeType = String(parsed?.mimeType || parsed?.MimeType || "").toLowerCase();
    const codecs = String(parsed?.codecs || parsed?.codec || "").toLowerCase();
    const flacPayload = mimeType === "audio/flac" || codecs.includes("flac");

    if (Array.isArray(parsed?.urls) && flacPayload) {
      // HiFi API's BTS LOSSLESS manifest normally supplies a direct .flac CDN URL.
      // Only accept it when the manifest itself says the payload is FLAC.
      return chooseFlacUrl(parsed.urls) || (parsed.urls[0] && isHttpUrl(parsed.urls[0]) ? parsed.urls[0] : null);
    }

    if (isHttpUrl(parsed?.url) && (flacPayload || looksLikeFlacUrl(parsed.url))) {
      return parsed.url;
    }
  } catch {
    // Fall through to a conservative URL scan for legacy variants.
  }

  const direct = text.match(/https?:\/\/[^"'\s]+\.flac(?:\?[^"'\s]+)?/i);
  return direct?.[0] || null;
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
    streamQuality: "[TIDAL] LOSSLESS",
    audioQuality: "LOSSLESS",
    codec: "flac",
    container: "flac",
    manifest: "none",
    sampleRate: Number(data.sampleRate) || null,
    bitDepth: Number(data.bitDepth) || null,
    provider: "tidal"
  };
}

async function resolveViaTrack(tidalId, base) {
  // This endpoint is the reliable path for CD-quality LOSSLESS. The HiFi API
  // returns a base64 BTS manifest whose JSON contains a direct FLAC CDN URL.
  const path = `/track/?id=${encodeURIComponent(tidalId)}&quality=LOSSLESS`;
  const upstream = await fetchJson(base + path);
  if (!upstream.response.ok || !upstream.data) return null;

  const root = upstream.data;
  const data = root?.data && typeof root.data === "object" ? root.data : root;
  const audioQuality = String(data?.audioQuality || "").toUpperCase();

  // Never turn an AAC response into a fake FLAC result.
  if (audioQuality && audioQuality !== "LOSSLESS") return null;

  const manifest = data?.manifest ?? root?.manifest;
  const flacUrl = flacUrlFromManifest(manifest);
  if (!flacUrl) return null;

  return losslessStream(flacUrl, data);
}

async function resolveViaTrackManifests(tidalId, base) {
  // Keep this as a secondary path. Newer trackManifests commonly returns a
  // signed DASH MPD, which is useful to a DASH-capable player but is not a
  // single-file FLAC URL for the BitChord addon contract.
  const path = `/trackManifests/?id=${encodeURIComponent(tidalId)}&adaptive=false&formats=FLAC&manifestType=MPEG_DASH&uriScheme=HTTPS`;
  const lookup = await fetchJson(base + path, {
    headers: { Accept: "application/json" }
  });
  if (!lookup.response.ok || !lookup.data) return null;

  const manifestUri = extractManifestUri(lookup.data);
  if (!manifestUri) return null;

  const manifestResponse = await fetchResponse(manifestUri, {
    headers: { Accept: "application/json, text/plain, */*" }
  });
  if (!manifestResponse.ok) return null;

  const manifestText = await manifestResponse.text();
  const flacUrl = flacUrlFromManifest(manifestText);
  if (!flacUrl) return null;

  const attrs = lookup.data?.data?.data?.attributes || lookup.data?.data?.attributes || {};
  return losslessStream(flacUrl, attrs);
}

async function resolveTidalStream(tidalId) {
  let lastError = null;

  for (const base of TIDAL_APIS) {
    try {
      // Prefer /track because LOSSLESS yields a direct FLAC BTS manifest on the
      // upstream HiFi API, avoiding the DASH path entirely.
      const legacy = await resolveViaTrack(tidalId, base);
      if (legacy) return legacy;

      const modern = await resolveViaTrackManifests(tidalId, base);
      if (modern) return modern;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No directly playable FLAC URL in TIDAL response");
}

async function searchFromBase(base, query) {
  const path = `/search/?s=${encodeURIComponent(query)}&limit=20`;
  const response = await fetchJson(base + path);
  if (!response.response.ok || !response.data) return null;
  return response.data;
}

async function handleSearch(query) {
  if (!query.trim()) return json({ tracks: [] });

  let lastError = null;
  for (const base of TIDAL_APIS) {
    try {
      const data = await searchFromBase(base, query);
      const items = data?.data?.items;
      if (!Array.isArray(items)) continue;
      const tracks = items
        .filter(item => item && item.id && item.title)
        .map(normalizeTrack)
        .filter(track => track.duration == null || track.duration > 0);
      return json({ tracks });
    } catch (error) {
      lastError = error;
    }
  }
  return textError(502, `Search upstream unavailable: ${lastError?.message || "unknown error"}`);
}

async function handleStream(id) {
  const tidalId = String(id).replace(/^tidal:/i, "").trim();
  if (!/^\d+$/.test(tidalId)) {
    return textError(400, "Invalid TIDAL track id");
  }

  try {
    const stream = await resolveTidalStream(tidalId);
    return json(stream, 200, { "Cache-Control": "no-store" });
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
