# BitChord Lossless HTTP Addon

A serverless HTTP addon for BitChord 1.5.2+.

## Endpoints

- `GET /manifest.json`
- `GET /search?q=artist%20title`
- `GET /stream/{id}`
- `GET /health`

The Worker searches public community TIDAL proxy APIs and resolves lossless FLAC URLs. The upstream services are unofficial and may be rate-limited or unavailable.

## Deploy with Cloudflare Workers

1. Open Cloudflare Workers and create a Worker.
2. Copy `src/index.js` into the Worker editor, or connect this GitHub repository and use `bitchord-addon/src/index.js` as the entry file.
3. Deploy the Worker.
4. In BitChord: Sources → Add addon → paste the Worker URL, for example `https://bitchord-lossless.<your-subdomain>.workers.dev`.

BitChord must receive the Worker URL, not the GitHub `.js` raw-file URL.
