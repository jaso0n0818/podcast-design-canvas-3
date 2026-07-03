// app/riverside.js
// Riverside-link import model: resolve a pasted Riverside-style episode link or
// manifest reference to a local fixture manifest path, and validate the
// manifest's shape (which speaker track fills which bucket). Pure string/data
// work — no network, no DOM — so it is unit-testable under plain Node
// (tests/riverside.test.mjs); the UI (app/ui.js) does the actual fetching and
// runs each track through the SAME ingest path manual uploads use.
//
// The repo's DECLARED sample link is fixtures/riverside/demo-episode.json,
// also reachable through the riverside.fm-style alias
// https://riverside.fm/studio/demo-episode (the trailing slug maps onto
// fixtures/riverside/<slug>.json). Real Riverside network integration,
// authentication, and social research are intentionally deferred: only local
// fixture manifests resolve. Classic script — exposed on window.PDC.riverside.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { SPEAKER_BUCKETS, BUCKET_LABELS } = PDC.presets;

  const FIXTURE_DIR = "fixtures/riverside/";
  const SAMPLE_LINK = FIXTURE_DIR + "demo-episode.json";
  const SAMPLE_URL_ALIAS = "https://riverside.fm/studio/demo-episode";
  const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

  // Resolve a pasted link to a same-origin manifest path. Accepted forms:
  //   - a .json manifest reference (the declared sample link above),
  //   - a riverside.fm-style episode URL — the last path segment is the
  //     episode slug and maps to fixtures/riverside/<slug>.json,
  //   - a bare episode slug (demo-episode) — same fixture mapping.
  // Returns { ok:true, path, slug } or { ok:false, error } with a message the
  // UI can show verbatim.
  function resolveManifestPath(raw) {
    const link = String(raw || "").trim();
    if (!link) {
      return { ok: false, error: "Paste a Riverside episode link or manifest reference first — sample: " + SAMPLE_LINK + "." };
    }
    const noScheme = link.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    if (/^riverside\.fm([/?#]|$)/i.test(noScheme)) {
      const segments = noScheme.split(/[?#]/)[0].split("/").filter(Boolean).slice(1);
      const slug = segments.length ? segments[segments.length - 1] : "";
      if (!SLUG_RE.test(slug)) {
        return { ok: false, error: "That riverside.fm link has no episode slug — try the sample alias " + SAMPLE_URL_ALIAS + "." };
      }
      return { ok: true, path: FIXTURE_DIR + slug + ".json", slug };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(link)) {
      return {
        ok: false,
        error: "Only riverside.fm-style links and local fixture manifests are supported here — real Riverside network integration is deferred. Sample: " + SAMPLE_LINK + ".",
      };
    }
    if (/\.json$/i.test(link)) {
      const cleaned = link.replace(/^\.?\/+/, "");
      if (cleaned.split("/").indexOf("..") !== -1) {
        return { ok: false, error: "Manifest references cannot traverse directories — sample: " + SAMPLE_LINK + "." };
      }
      const base = cleaned.split("/").pop();
      return { ok: true, path: cleaned, slug: base.replace(/\.json$/i, "") };
    }
    if (SLUG_RE.test(link)) {
      return { ok: true, path: FIXTURE_DIR + link + ".json", slug: link };
    }
    return { ok: false, error: "That does not look like a Riverside episode link or manifest reference — sample: " + SAMPLE_LINK + "." };
  }

  // Validate a fetched manifest object. A valid Riverside-style episode
  // manifest looks like:
  //   { "title": "Demo Episode",
  //     "tracks": [ { "role": "host", "name": "…webm", "src": "host.webm" }, … ] }
  // Roles must be speaker buckets (host / guest1 / guest2), unique, and include
  // at least host and guest1 (the product's own two-speaker minimum); guest2 is
  // optional. `src` is required per track (relative to the manifest); `name`
  // defaults to the src basename. Returns { ok:true, title, tracks } with
  // tracks in canonical bucket order, or { ok:false, error }.
  function parseManifest(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "The manifest is not a Riverside episode object." };
    }
    if (!Array.isArray(data.tracks) || data.tracks.length === 0) {
      return { ok: false, error: "The manifest has no tracks[] — expected host, guest1, and guest2 entries." };
    }
    const byRole = {};
    for (let i = 0; i < data.tracks.length; i++) {
      const track = data.tracks[i];
      if (!track || typeof track !== "object" || Array.isArray(track)) {
        return { ok: false, error: "Track " + (i + 1) + " in the manifest is not an object." };
      }
      const role = typeof track.role === "string" ? track.role.trim() : "";
      if (SPEAKER_BUCKETS.indexOf(role) === -1) {
        return { ok: false, error: "Track " + (i + 1) + ' has unsupported role "' + role + '" — expected host, guest1, or guest2.' };
      }
      if (byRole[role]) {
        return { ok: false, error: 'The manifest lists the "' + role + '" track more than once.' };
      }
      const src = typeof track.src === "string" ? track.src.trim() : "";
      if (!src) {
        return { ok: false, error: 'The "' + role + '" track is missing its src (the synced media file to import).' };
      }
      const name = (typeof track.name === "string" && track.name.trim()) || src.split("/").pop();
      byRole[role] = { role, src, name };
    }
    for (const required of ["host", "guest1"]) {
      if (!byRole[required]) {
        return { ok: false, error: "The manifest is missing the " + BUCKET_LABELS[required] + " (" + required + ") track — a Riverside episode import needs at least host and guest1." };
      }
    }
    const tracks = SPEAKER_BUCKETS.filter(function (bucket) { return byRole[bucket]; }).map(function (bucket) { return byRole[bucket]; });
    const title = (typeof data.title === "string" && data.title.trim()) || "";
    return { ok: true, title, tracks };
  }

  PDC.riverside = {
    SAMPLE_LINK,
    SAMPLE_URL_ALIAS,
    resolveManifestPath,
    parseManifest,
  };
})();
