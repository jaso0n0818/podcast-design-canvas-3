# Riverside sample episode fixtures (step #195 input media)

This directory holds the repo's **declared sample Riverside-style episode** for
the setup panel's "import a Riverside episode link" control. These are the
sample INPUT media the step explicitly calls for (like bundled sample files in
an editor) — they are only ever loaded when a creator pastes a Riverside link
and clicks Import; no product code path seeds them into an episode on its own,
and manual upload works exactly as before.

## Declared sample link

```
fixtures/riverside/demo-episode.json
```

Alias (riverside.fm-style URL — the trailing slug maps to
`fixtures/riverside/<slug>.json`):

```
https://riverside.fm/studio/demo-episode
```

Paste either into the "Riverside episode link" input and click **Import
episode**: Host, Guest 1, and Guest 2 fill with the three real synced WebM
tracks below and compose in the live preview, ready for the normal preset
(Split / Stack / Spotlight), custom-layout, and export controls.

Real Riverside network integration, authentication, and social research are
deferred — only local fixture manifests resolve, and any other http(s) URL is
rejected with a visible error.

## Manifest shape

```json
{
  "format": "riverside-episode",
  "version": 1,
  "title": "Demo Episode",
  "tracks": [
    { "role": "host",   "name": "demo-episode-host.webm",   "src": "host.webm" },
    { "role": "guest1", "name": "demo-episode-guest1.webm", "src": "guest1.webm" },
    { "role": "guest2", "name": "demo-episode-guest2.webm", "src": "guest2.webm" }
  ]
}
```

`role` must be a speaker bucket (`host` / `guest1` / `guest2`, unique, host and
guest1 required), `src` is the synced media file relative to the manifest, and
`name` (optional, defaults to the src basename) is the file name shown in the
speaker bucket. Parsing/validation lives in `app/riverside.js` and is
unit-tested in `tests/riverside.test.mjs`.

## Track files

`host.webm`, `guest1.webm`, `guest2.webm` are tiny (~1.5 s, 320×180, <100 KB)
real VP8+Opus WebM recordings generated once in headless Chromium with
`canvas.captureStream()` + an `AudioContext` oscillator + `MediaRecorder` —
each track is a distinct solid color with a frame counter and its own audio
tone, mimicking three synced per-speaker Riverside studio tracks:

| track  | color                | tone   |
| ------ | -------------------- | ------ |
| host   | red (`#b91c1c`)      | 220 Hz |
| guest1 | green (`#047857`)    | 320 Hz |
| guest2 | blue (`#2563eb`)     | 440 Hz |

Because the app serves fixtures over the same origin, run it with
`npm run serve` (fixture fetches cannot work from `file://`).
