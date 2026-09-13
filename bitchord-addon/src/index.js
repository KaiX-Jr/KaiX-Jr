const NAME = "BitChord Lossless";
const VERSION = "1.2.0";

// Public community HiFi API mirrors. They are unofficial and can change or go offline.
const TIDAL_APIS = [
  "https://api.monochrome.tf",
  "https://monochrome-api.samidy.com",
  "https://hifi.geeked.wtf",
  "https://wolf.qqdl.site",
  "https://maus.qqdl.site",
  "https://vogel.qqdl.site",
  "https://katze.qqdl.site",
  "https://hund.qqdl.site",
  "https://tidal.kinoplus.online",
  "https://eu-central.monochrome.tf",
  "https://us-west.monochrome.tf",
  "https://arran.monochrome.tf",
  "https://triton.squid.wtf"
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

async function fetchResponse(url, init = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": `BitChord-Lossless/${VERSION}`,
        ...(init.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, init = {}, timeoutMs = 9000) {
  const response = await fetchResponse(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers || {})
    }
  }, timeoutMs);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { response, data, text };
}

async function fetchText(url, init = {}, timeoutMs = 9000) {
  const response = await fetchResponse(url, init, timeoutMs);
  return { response, text: await response.text() };
}

function artworkUrl(cover) {
  if (!cover) return null;
  const clean = String(cover).replace(/-/g, "/");
  return `https://resources.tidal.com/images/${clean}/640x640.jpg`;
}

function normalizeTrack(item) {
  const artist = item.artist?.name || item.artists?.[0]?.name || "Unknown Artist";
  return {
    id: `tidal:${item.id}`,
    title: item.title || "Unknown Title",
    artist,
    album: item.album?.title || "",
    duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
    artworkURL: artworkUrl(item.album?.cover),
    format: "flac",
    audioQuality: "LOSSLESS",
    tidalId: String(item.id),
    isrc: item.isrc || null
  };
}

function decodeBase64Text(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function decodeManifestText(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const decoded = decodeBase64Text(raw);
  if (decoded) {
    const clean = decoded.trim();
    if (clean.startsWith("{") || clean.startsWith("[") || clean.startsWith("<")) return clean;
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

function flacUrlFromManifest(value) {
  const text = decodeManifestText(value);
  if (!text || /<MPD(?:\s|>)/i.test(text)) return null;

  try {
    const parsed = JSON.parse(text);
    const mimeType = String(parsed?.mimeType || parsed?.MimeType || "").toLowerCase();
    const codecs = String(parsed?.codecs || parsed?.codec || "").toLowerCase();
    const saysFlac = mimeType === "audio/flac" || codecs.includes("flac");

    if (Array.isArray(parsed?.urls) && saysFlac) {
      const urls = parsed.urls.filter(isHttpUrl);
      return urls.find(looksLikeFlacUrl) || urls[0] || null;
    }

    if (isHttpUrl(parsed?.url) && (saysFlac || looksLikeFlacUrl(parsed.url))) return parsed.url;
  } catch {}

  const direct = text.match(/https?:\/\/[^\s"']+\.flac(?:\?[^\s"']+)?/i);
  return direct?.[0] || null;
}

function losslessStream(url, data = {}) {
  return {
    url,
    format: "flac",
    quality: data.bitDepth ? `${data.bitDepth}-bit FLAC` : "16-bit FLAC",
    streamQuality: "[TIDAL] LOSSLESS",
    audioQuality: "LOSSLESS",
    codec: "flac",
    container: "flac",
    manifest: "none",
    sampleRate: Number(data.sampleRate) || 44100,
    bitDepth: Number(data.bitDepth) || 16,
    provider: "tidal"
  };
}

async function resolveViaTrack(tidalId, base) {
  const upstream = await fetchJson(`${base}/track/?id=${encodeURIComponent(tidalId)}&quality=LOSSLESS`);
  if (!upstream.response.ok || !upstream.data) return null;

  const root = upstream.data;
  const data = root?.data && typeof root.data === "object" ? root.data : root;
  const audioQuality = String(data?.audioQuality || "").toUpperCase();
  if (audioQuality && audioQuality !== "LOSSLESS") return null;

  const manifestMime = String(data?.manifestMimeType || "").toLowerCase();
  if (manifestMime && manifestMime !== "application/vnd.tidal.bts") return null;

  const url = flacUrlFromManifest(data?.manifest ?? root?.manifest);
  return url ? losslessStream(url, data) : null;
}

async function resolveViaTrackManifests(tidalId, base) {
  // Newer mirrors expose /trackManifests. We only accept the returned resource
  // if it ultimately resolves to a single FLAC URL. DASH MPDs are rejected.
  const lookup = await fetchJson(
    `${base}/trackManifests/?id=${encodeURIComponent(tidalId)}&adaptive=false&formats=FLAC&usage=PLAYBACK&manifestType=MPEG_DASH&uriScheme=HTTPS`
  );
  if (!lookup.response.ok || !lookup.data) return null;

  const uri = lookup.data?.data?.data?.attributes?.uri || lookup.data?.data?.attributes?.uri;
  if (!isHttpUrl(uri)) return null;

  const manifest = await fetchText(uri);
  if (!manifest.response.ok) return null;

  const url = flacUrlFromManifest(manifest.text);
  if (!url) return null;

  return losslessStream(url, lookup.data?.data?.data?.attributes || {});
}

async function resolveTidalStream(tidalId) {
  let lastError = null;

  for (const base of TIDAL_APIS) {
    try {
      // Prefer the simple BTS endpoint because it directly returns a single FLAC.
      const direct = await resolveViaTrack(tidalId, base);
      if (direct) return direct;

      // Fall back to newer mirror implementations when /track/ is unavailable.
      const manifest = await resolveViaTrackManifests(tidalId, base);
      if (manifest) return manifest;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No directly playable LOSSLESS FLAC URL was returned by any mirror");
}

async function searchFromBase(base, query) {
  const result = await fetchJson(`${base}/search/?s=${encodeURIComponent(query)}&limit=20`);
  if (!result.response.ok || !result.data) return null;
  return result.data;
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
  if (!/^\d+$/.test(tidalId)) return textError(400, "Invalid TIDAL track id");

  try {
    const stream = await resolveTidalStream(tidalId);
    return json(stream, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    return textError(502, `Lossless FLAC stream unavailable: ${error?.message || "unknown error"}`);
  }
}

const worker = {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return textError(405, "Method not allowed");

    if (url.pathname === "/" || url.pathname === "/manifest.json") {
      return json({
        id: "com.kai.jr.bitchord.lossless",
        name: NAME,
        version: VERSION,
        description: "Lossless FLAC source for BitChord using public community TIDAL APIs with mirror failover.",
        author: "KaiX-Jr",
        resources: ["search", "stream"]
      });
    }

    if (url.pathname === "/search") return handleSearch(url.searchParams.get("q") || "");
    if (url.pathname.startsWith("/stream/")) return handleStream(decodeURIComponent(url.pathname.slice("/stream/".length)));
    if (url.pathname === "/stream" && url.searchParams.has("id")) return handleStream(url.searchParams.get("id") || "");

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: NAME,
        version: VERSION,
        mode: "direct-flac",
        quality: "LOSSLESS",
        resolver: ["track", "trackManifests"],
        providers: TIDAL_APIS
      });
    }

    return textError(404, "Not found");
  }
};

export const __test = { decodeManifestText, flacUrlFromManifest, normalizeTrack };
export default worker;
