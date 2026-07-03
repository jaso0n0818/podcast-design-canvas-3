// tests/riverside.test.mjs — Riverside-link import model: link → fixture
// manifest path resolution, manifest validation, episode-model assignment, and
// consistency of the committed sample fixture set the step declares
// (fixtures/riverside/demo-episode.json + its real WebM tracks).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const { resolveManifestPath, parseManifest, SAMPLE_LINK, SAMPLE_URL_ALIAS } = PDC.riverside;

const VALID_MANIFEST = {
  format: "riverside-episode",
  version: 1,
  title: "Demo Episode",
  tracks: [
    { role: "host", name: "demo-episode-host.webm", src: "host.webm" },
    { role: "guest1", name: "demo-episode-guest1.webm", src: "guest1.webm" },
    { role: "guest2", name: "demo-episode-guest2.webm", src: "guest2.webm" },
  ],
};

test("declared sample link resolves to itself (manifest reference passes through)", () => {
  const r = resolveManifestPath(SAMPLE_LINK);
  assert.equal(r.ok, true);
  assert.equal(r.path, "fixtures/riverside/demo-episode.json");
  assert.equal(r.slug, "demo-episode");
});

test("riverside.fm-style URL alias maps its slug onto the fixture manifest", () => {
  for (const link of [
    SAMPLE_URL_ALIAS,
    "https://riverside.fm/studio/demo-episode",
    "http://riverside.fm/studio/demo-episode",
    "https://www.riverside.fm/studio/demo-episode",
    "riverside.fm/studio/demo-episode",
    "https://riverside.fm/studio/sessions/demo-episode/",
    "https://riverside.fm/studio/demo-episode?utm=x#tracks",
  ]) {
    const r = resolveManifestPath(link);
    assert.equal(r.ok, true, link + " should resolve: " + (r.error || ""));
    assert.equal(r.path, SAMPLE_LINK, link);
    assert.equal(r.slug, "demo-episode", link);
  }
});

test("bare episode slug maps onto the fixture manifest", () => {
  const r = resolveManifestPath("demo-episode");
  assert.equal(r.ok, true);
  assert.equal(r.path, SAMPLE_LINK);
});

test("whitespace around the pasted link is tolerated", () => {
  const r = resolveManifestPath("  " + SAMPLE_URL_ALIAS + "  ");
  assert.equal(r.ok, true);
  assert.equal(r.path, SAMPLE_LINK);
});

test("empty link is rejected with a message naming the sample", () => {
  const r = resolveManifestPath("   ");
  assert.equal(r.ok, false);
  assert.match(r.error, /fixtures\/riverside\/demo-episode\.json/);
});

test("non-riverside network URLs are rejected (real integration is deferred)", () => {
  for (const link of ["https://example.com/episode.json", "https://youtube.com/watch?v=1", "ftp://riverside.fm/x"]) {
    const r = resolveManifestPath(link);
    assert.equal(r.ok, false, link + " must not resolve");
    assert.match(r.error, /deferred|riverside/i);
  }
});

test("riverside.fm link without an episode slug is rejected", () => {
  for (const link of ["https://riverside.fm", "https://riverside.fm/"]) {
    const r = resolveManifestPath(link);
    assert.equal(r.ok, false, link);
    assert.match(r.error, /slug/i);
  }
});

test("manifest references cannot traverse directories", () => {
  const r = resolveManifestPath("../../etc/passwd.json");
  assert.equal(r.ok, false);
  assert.match(r.error, /traverse/i);
});

test("valid manifest parses with roles complete in canonical bucket order", () => {
  const r = parseManifest(VALID_MANIFEST);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.title, "Demo Episode");
  assert.deepEqual(r.tracks.map((t) => t.role), ["host", "guest1", "guest2"]);
  assert.deepEqual(r.tracks.map((t) => t.src), ["host.webm", "guest1.webm", "guest2.webm"]);
  assert.deepEqual(
    r.tracks.map((t) => t.name),
    ["demo-episode-host.webm", "demo-episode-guest1.webm", "demo-episode-guest2.webm"],
  );
});

test("track order in the manifest does not matter — output is canonical", () => {
  const shuffled = { ...VALID_MANIFEST, tracks: [VALID_MANIFEST.tracks[2], VALID_MANIFEST.tracks[0], VALID_MANIFEST.tracks[1]] };
  const r = parseManifest(shuffled);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tracks.map((t) => t.role), ["host", "guest1", "guest2"]);
});

test("track name defaults to the src basename when omitted", () => {
  const r = parseManifest({
    tracks: [
      { role: "host", src: "media/host-take2.webm" },
      { role: "guest1", src: "guest1.webm" },
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tracks[0].name, "host-take2.webm");
  assert.equal(r.tracks[1].name, "guest1.webm");
});

test("two-speaker manifest (host + guest1) is valid; guest2 is optional", () => {
  const r = parseManifest({ tracks: VALID_MANIFEST.tracks.slice(0, 2) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tracks.map((t) => t.role), ["host", "guest1"]);
  assert.equal(r.title, "");
});

test("missing required track is a visible error naming the role", () => {
  const noHost = parseManifest({ tracks: VALID_MANIFEST.tracks.slice(1) });
  assert.equal(noHost.ok, false);
  assert.match(noHost.error, /Host \(host\)/);
  const noGuest1 = parseManifest({ tracks: [VALID_MANIFEST.tracks[0], VALID_MANIFEST.tracks[2]] });
  assert.equal(noGuest1.ok, false);
  assert.match(noGuest1.error, /Guest 1 \(guest1\)/);
});

test("malformed manifests are rejected with specific errors", () => {
  assert.equal(parseManifest(null).ok, false);
  assert.equal(parseManifest([1, 2]).ok, false);
  assert.equal(parseManifest({}).ok, false);
  assert.match(parseManifest({ tracks: [] }).error, /no tracks/i);
  assert.match(parseManifest({ tracks: ["x"] }).error, /not an object/i);
  assert.match(
    parseManifest({ tracks: [{ role: "producer", src: "x.webm" }] }).error,
    /unsupported role "producer"/,
  );
  assert.match(
    parseManifest({ tracks: [VALID_MANIFEST.tracks[0], VALID_MANIFEST.tracks[0]] }).error,
    /more than once/,
  );
  assert.match(parseManifest({ tracks: [{ role: "host" }] }).error, /missing its src/);
});

test("parsed tracks assign into the episode model and reach compose-readiness", () => {
  const parsed = parseManifest(VALID_MANIFEST);
  const ep = PDC.episode.createEpisode({ title: "before import" });
  assert.equal(PDC.episode.canCompose(ep), false);
  for (const track of parsed.tracks) {
    PDC.episode.assignMedia(ep, track.role, { name: track.name, size: 1000, type: "video/webm" });
  }
  if (parsed.title) ep.title = parsed.title;
  assert.deepEqual(PDC.episode.assignedBuckets(ep), ["host", "guest1", "guest2"]);
  assert.equal(PDC.episode.canCompose(ep), true);
  assert.equal(ep.title, "Demo Episode");
  assert.equal(ep.media.host.name, "demo-episode-host.webm");
  // Imported speakers still show the canonical labels until social links are set.
  assert.equal(PDC.episode.speakerName(ep, "host"), "Host");
  assert.equal(PDC.episode.speakerName(ep, "guest1"), "Guest 1");
  assert.equal(PDC.episode.speakerName(ep, "guest2"), "Guest 2");
});

test("committed sample fixture set is consistent: manifest valid, tracks real WebM files", () => {
  const dir = path.join(root, "fixtures", "riverside");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "demo-episode.json"), "utf8"));
  const parsed = parseManifest(manifest);
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.tracks.map((t) => t.role), ["host", "guest1", "guest2"], "sample episode must fill all three buckets");
  for (const track of parsed.tracks) {
    const file = path.join(dir, track.src);
    assert.ok(fs.existsSync(file), track.src + " must exist next to the manifest");
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > 4096, track.src + " must carry real bytes, got " + bytes.length);
    assert.ok(bytes.length < 120000, track.src + " must stay a small fixture, got " + bytes.length);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], track.src + " must be a real WebM/EBML file");
  }
});
