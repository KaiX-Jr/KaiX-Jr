import test from "node:test";
import assert from "node:assert/strict";
import worker, { __test } from "../src/index.js";

const FLAC_MANIFEST = {
  mimeType: "audio/flac",
  codecs: "flac",
  encryptionType: "NONE",
  urls: ["https://example.invalid/track/0.flac?token=test"]
};

function b64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

test("decodes a TIDAL BTS manifest to a direct FLAC URL", () => {
  assert.equal(__test.flacUrlFromManifest(b64(JSON.stringify(FLAC_MANIFEST))), FLAC_MANIFEST.urls[0]);
});

test("accepts raw FLAC manifest JSON", () => {
  assert.equal(__test.flacUrlFromManifest(JSON.stringify(FLAC_MANIFEST)), FLAC_MANIFEST.urls[0]);
});

test("rejects DASH MPD manifests", () => {
  assert.equal(__test.flacUrlFromManifest(b64("<?xml version=\"1.0\"?><MPD><Period /></MPD>")), null);
});

test("rejects non-FLAC JSON payloads", () => {
  assert.equal(__test.flacUrlFromManifest(b64(JSON.stringify({
    mimeType: "audio/aac",
    codecs: "mp4a.40.2",
    urls: ["https://example.invalid/track.m4a"]
  }))), null);
});

test("manifest endpoint exposes version 1.2.0", async () => {
  const response = await worker.fetch(new Request("https://example.test/"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, "com.kai.jr.bitchord.lossless");
  assert.equal(body.version, "1.2.0");
  assert.deepEqual(body.resources, ["search", "stream"]);
});

test("health endpoint reports both lossless resolver paths", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, "1.2.0");
  assert.equal(body.mode, "direct-flac");
  assert.equal(body.quality, "LOSSLESS");
  assert.deepEqual(body.resolver, ["track", "trackManifests"]);
  assert.ok(body.providers.length >= 10);
});

test("stream endpoint validates track ids before upstream access", async () => {
  const response = await worker.fetch(new Request("https://example.test/stream/not-a-track"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid TIDAL track id" });
});

test("method and CORS contracts remain intact", async () => {
  const post = await worker.fetch(new Request("https://example.test/", { method: "POST" }));
  assert.equal(post.status, 405);

  const options = await worker.fetch(new Request("https://example.test/", { method: "OPTIONS" }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), "*");
});
