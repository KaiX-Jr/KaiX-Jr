const NAME = "BitChord Lossless";
const VERSION = "1.0.0";
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
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra }
  });
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "BitChord-Lossless/1.0" }
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function upstream(path) {
  let lastError = null;
  for (const base of TIDAL_APIS) {
    try {
      const r = await fetchJson(base + path);
      if (r.response.ok && r.data) return r.data;
      lastError = new Error(`upstream HTTP ${r.response.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("No TIDAL mirror available");
}

function artworkUrl(cover) {
  if (!cover) return null;
  return `https://resources.tidal.com/images/${String(cover).replace(/-/g, "/")}/640x640.jpg`;
}

function trackRow(item) {
  return {
    id: `tidal:${item.id}`,
    title: item.title || "Unknown Title",
    artist: item.artist?.name || item.artists?.[0]?.name || "Unknown Artist",
    album: item.album?.title || "",
    duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
    artworkURL: artworkUrl(item.album?.cover),
    format: "flac"
  };
}

function decodeManifest(value) {
  const bytes = Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function search(query) {
  const data = await upstream(`/search/?s=${encodeURIComponent(query)}&limit=20`);
  const items = data?.data?.items;
  return Array.isArray(items) ? items.filter(x => x?.id && x?.title).map(trackRow) : [];
}

async function stream(tidalId) {
  const id = String(tidalId).replace(/^tidal:/i, "");
  if (!/^\d+$/.test(id)) throw new Error("Invalid TIDAL track id");

  let data = await upstream(`/track/?id=${encodeURIComponent(id)}&quality=HI_RES_LOSSLESS`);
  let track = data?.data;
  if (!track) throw new Error("TIDAL returned no track data");

  let streamUrl = null;
  let sampleRate = Number(track.sampleRate) || null;
  let bitDepth = Number(track.bitDepth) || null;

  if (typeof track.manifest === "string") {
    try {
      const manifest = decodeManifest(track.manifest);
      if (Array.isArray(manifest.urls) && /^https?:\/\//.test(manifest.urls[0] || "")) {
        streamUrl = manifest.urls[0];
      }
    } catch {}
  }

  if (!streamUrl && typeof track.manifest === "string" && /^https?:\/\//.test(track.manifest)) {
    streamUrl = track.manifest;
  }

  // Some public mirrors can fail HI_RES while still serving CD lossless.
  if (!streamUrl) {
    data = await upstream(`/track/?id=${encodeURIComponent(id)}&quality=LOSSLESS`);
    track = data?.data;
    if (!track) throw new Error("No lossless track data");
    sampleRate = Number(track.sampleRate) || sampleRate;
    bitDepth = Number(track.bitDepth) || bitDepth;
    if (typeof track.manifest === "string") {
      try {
        const manifest = decodeManifest(track.manifest);
        if (Array.isArray(manifest.urls) && /^https?:\/\//.test(manifest.urls[0] || "")) {
          streamUrl = manifest.urls[0];
        }
      } catch {}
    }
  }

  if (!streamUrl) throw new Error("No playable FLAC URL");

  return {
    url: streamUrl,
    format: "flac",
    quality: track.audioQuality === "HI_RES_LOSSLESS" ? "hi-res lossless" : "lossless",
    codec: "flac",
    container: "flac",
    manifest: "none",
    sampleRate,
    bitDepth
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    if (url.pathname === "/" || url.pathname === "/manifest.json") {
      return json({
        id: "com.kaixjr.bitchord.lossless",
        name: NAME,
        version: VERSION,
        description: "Lossless FLAC source for BitChord using public community TIDAL APIs.",
        author: "KaiX-Jr",
        resources: ["search", "stream"]
      });
    }

    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ tracks: [] });
      try { return json({ tracks: await search(q) }); }
      catch (e) { return json({ error: `Search unavailable: ${e?.message || "upstream error"}` }, 502); }
    }

    if (url.pathname.startsWith("/stream/")) {
      const id = decodeURIComponent(url.pathname.slice("/stream/".length));
      try { return json(await stream(id), 200, { "Cache-Control": "no-store" }); }
      catch (e) { return json({ error: `Stream unavailable: ${e?.message || "upstream error"}` }, 502); }
    }

    if (url.pathname === "/health") return json({ ok: true, service: NAME, version: VERSION });
    return json({ error: "Not found" }, 404);
  }
};
