// tests/captions.test.mjs — WebVTT transcript caption model: timestamp and
// cue parsing (header, HH:MM:SS.mmm + MM:SS.mmm, multi-line text, CRLF,
// NOTE/STYLE blocks), validation, [start, end) active-cue lookup boundaries,
// and persistence across preset and template switches.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const C = PDC.captions;
const E = PDC.episode;

test("parseTimestamp accepts HH:MM:SS.mmm and MM:SS.mmm forms", () => {
  assert.equal(C.parseTimestamp("00:00:01.000"), 1);
  assert.equal(C.parseTimestamp("00:01:05.250"), 65.25);
  assert.equal(C.parseTimestamp("01:00:00.000"), 3600);
  assert.equal(C.parseTimestamp("00:05.000"), 5);
  assert.equal(C.parseTimestamp("02:30.5"), 150.5);
  assert.equal(C.parseTimestamp("00:07"), 7, "milliseconds are optional");
  assert.equal(C.parseTimestamp("1:02:03,500"), 3723.5, "comma fraction separator tolerated");
});

test("parseTimestamp rejects non-timestamps", () => {
  for (const bad of ["", "abc", "5", "1:70", "1:2:3:4", "-0:05.000", null, undefined]) {
    assert.ok(Number.isNaN(C.parseTimestamp(bad)), `expected NaN for ${String(bad)}`);
  }
});

test("parseVtt parses a WEBVTT file with both timestamp forms", () => {
  const cues = C.parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHELLO CAPTION ONE\n\n00:05.000 --> 00:07.500\nSECOND CUE TEXT\n",
  );
  assert.deepEqual(cues, [
    { start: 1, end: 3, text: "HELLO CAPTION ONE" },
    { start: 5, end: 7.5, text: "SECOND CUE TEXT" },
  ]);
});

test("parseVtt tolerates CRLF, BOM, header text, and cue identifiers", () => {
  const cues = C.parseVtt(
    "﻿WEBVTT - episode transcript\r\n\r\nintro-cue\r\n00:00:01.000 --> 00:00:03.000\r\nHello there\r\n\r\n2\r\n00:05.000 --> 00:07.500\r\nSecond cue\r\n",
  );
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 3, text: "Hello there" });
  assert.deepEqual(cues[1], { start: 5, end: 7.5, text: "Second cue" });
});

test("parseVtt joins multi-line cue text into one caption", () => {
  const cues = C.parseVtt("WEBVTT\n\n00:01.000 --> 00:03.000\nfirst line\nsecond line\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "first line second line");
});

test("parseVtt skips NOTE and STYLE blocks", () => {
  const cues = C.parseVtt(
    "WEBVTT\n\nNOTE this is a comment\nthat spans two lines\n\nSTYLE\n::cue { color: red }\n\nNOTE\nanother note body\n\n00:01.000 --> 00:03.000\nReal cue\n",
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Real cue");
});

test("parseVtt drops cue settings and inline markup", () => {
  const cues = C.parseVtt(
    "WEBVTT\n\n00:01.000 --> 00:03.000 align:start position:10%\n<v Host>Welcome to the <i>show</i>\n",
  );
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0], { start: 1, end: 3, text: "Welcome to the show" });
});

test("parseVtt handles files without a WEBVTT header and skips garbage lines", () => {
  const cues = C.parseVtt("random preamble\n\n00:01.000 --> 00:03.000\nStill parsed\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Still parsed");
  assert.deepEqual(C.parseVtt(""), []);
  assert.deepEqual(C.parseVtt("just some text\nwith no cues"), []);
  assert.deepEqual(C.parseVtt(null), []);
});

test("parseVtt keeps backwards ranges so validateVtt can report them", () => {
  const cues = C.parseVtt("WEBVTT\n\n00:05.000 --> 00:02.000\nBackwards\n");
  assert.equal(cues.length, 1);
  assert.match(C.validateVtt(cues), /end after it starts/i);
});

test("validateVtt requires at least one cue with 0 <= start < end and text", () => {
  assert.equal(C.validateVtt([{ start: 1, end: 3, text: "ok" }]), "");
  assert.match(C.validateVtt([]), /at least one timed cue/i);
  assert.match(C.validateVtt(null), /at least one timed cue/i);
  assert.match(C.validateVtt([{ start: 3, end: 3, text: "x" }]), /end after it starts/i);
  assert.match(C.validateVtt([{ start: NaN, end: 3, text: "x" }]), /invalid time range/i);
  assert.match(C.validateVtt([{ start: -1, end: 3, text: "x" }]), /invalid time range/i);
  assert.match(C.validateVtt([{ start: 1, end: 3, text: "  " }]), /no text/i);
});

test("setCaptions stores sorted cues with the file name on the episode", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, [
    { start: 5, end: 7.5, text: "second" },
    { start: 1, end: 3, text: "first" },
  ], "transcript.vtt");
  const store = C.getCaptions(ep);
  assert.equal(store.fileName, "transcript.vtt");
  assert.deepEqual(store.cues.map((c) => c.text), ["first", "second"], "cues sorted by start");
  assert.equal(C.cueCount(ep), 2);
  assert.equal(C.firstCue(ep).text, "first");
});

test("activeCue is start-inclusive and end-exclusive", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, [
    { start: 1, end: 3, text: "ONE" },
    { start: 5, end: 7.5, text: "TWO" },
  ], "t.vtt");
  const at = (t) => (C.activeCue(ep, t) ? C.activeCue(ep, t).text : "");
  assert.equal(at(0), "", "nothing before the first cue");
  assert.equal(at(1), "ONE", "start boundary is inclusive");
  assert.equal(at(2.999), "ONE");
  assert.equal(at(3), "", "end boundary is exclusive");
  assert.equal(at(4), "", "gap between cues shows nothing");
  assert.equal(at(5), "TWO");
  assert.equal(at(7.499), "TWO");
  assert.equal(at(7.5), "");
  assert.equal(at(-1), "");
  assert.equal(at(NaN), "");
});

test("overlapping cues resolve to the earliest-starting cue", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, [
    { start: 2, end: 6, text: "late" },
    { start: 0, end: 4, text: "early" },
  ], "t.vtt");
  assert.equal(C.activeCue(ep, 3).text, "early");
  assert.equal(C.activeCue(ep, 5).text, "late");
});

test("captions live on the episode and survive preset and template switches", () => {
  const ep = E.createEpisode({});
  C.setCaptions(ep, C.parseVtt("WEBVTT\n\n00:01.000 --> 00:03.000\nKEEP ME\n"), "keep.vtt");
  const before = JSON.stringify(C.getCaptions(ep));
  for (const preset of ["stack", "spotlight", "split"]) {
    E.setPreset(ep, preset);
    assert.equal(ep.presetId, preset);
    assert.equal(JSON.stringify(C.getCaptions(ep)), before, `captions unchanged on ${preset}`);
    assert.equal(C.activeCue(ep, 2).text, "KEEP ME");
  }
  const tpl = PDC.templates.saveTemplate("Custom", { host: { x: 0, y: 0, w: 50, h: 100 } });
  E.setPreset(ep, tpl.id);
  assert.equal(ep.presetId, tpl.id);
  assert.equal(JSON.stringify(C.getCaptions(ep)), before, "captions unchanged on a custom template");
});

test("clearCaptions removes captions; a fresh or reset episode has none", () => {
  const ep = E.createEpisode({});
  assert.equal(C.getCaptions(ep), null);
  assert.equal(C.cueCount(ep), 0);
  C.setCaptions(ep, [{ start: 1, end: 3, text: "x" }], "t.vtt");
  assert.equal(C.cueCount(ep), 1);
  C.clearCaptions(ep);
  assert.equal(C.getCaptions(ep), null);
  C.setCaptions(ep, [{ start: 1, end: 3, text: "x" }], "t.vtt");
  E.resetEpisode(ep, {});
  assert.equal(C.getCaptions(ep), null, "start-new-episode clears captions");
});

test("episodes created before the captions feature still work", () => {
  const ep = E.createEpisode({});
  delete ep.captions; // simulate a pre-feature episode object
  assert.equal(C.getCaptions(ep), null);
  assert.equal(C.activeCue(ep, 1), null);
  assert.equal(C.cueCount(ep), 0);
  C.setCaptions(ep, [{ start: 1, end: 3, text: "x" }], "t.vtt");
  assert.equal(C.cueCount(ep), 1);
});
