// app/captions.js — WebVTT transcript captions scheduled over the composed
// episode. Pure, DOM-free model: parsed cues live ON THE EPISODE (like timed
// moments), so switching Split/Stack/Spotlight or applying a saved show
// template keeps every caption attached. The preview draws whichever cue is
// active at the shared reference time straight onto the stage canvas each
// frame, and because export records that same canvas, captions are burned
// into the exported video at their scheduled times. Classic script — exposed
// on window.PDC.captions.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // "HH:MM:SS.mmm" or "MM:SS.mmm" (hours optional, milliseconds optional,
  // comma tolerated as the fraction separator) -> seconds, or NaN.
  function parseTimestamp(raw) {
    const s = String(raw == null ? "" : raw).trim();
    let m = s.match(/^(\d{1,3}):([0-5]?\d):([0-5]?\d(?:[.,]\d{1,3})?)$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3].replace(",", "."));
    m = s.match(/^(\d{1,4}):([0-5]?\d(?:[.,]\d{1,3})?)$/);
    if (m) return Number(m[1]) * 60 + Number(m[2].replace(",", "."));
    return NaN;
  }

  // Parse WebVTT text into [{ start, end, text }] cues. Tolerant by design:
  // optional BOM and "WEBVTT" header line, \r\n / \r / \n line endings, cue
  // identifier lines, NOTE / STYLE / REGION blocks (skipped), cue settings
  // after the end timestamp (dropped), and inline markup tags (stripped).
  // Multi-line cue text is joined into one caption line; cues with an
  // unparseable timing line or no text are not cues and are skipped, but
  // cues with a backwards range are KEPT so validateVtt can name them.
  function parseVtt(text) {
    const lines = String(text == null ? "" : text)
      .replace(/^\uFEFF/, "")
      .split(/\r\n|\r|\n/);
    const cues = [];
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length && /^WEBVTT([ \t].*)?$/.test(lines[i].trim())) i++;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        i++;
        continue;
      }
      // NOTE/STYLE/REGION block: skip every line until the next blank line.
      if (/^(NOTE|STYLE|REGION)($|[ \t])/.test(line)) {
        i++;
        while (i < lines.length && lines[i].trim()) i++;
        continue;
      }
      // Optional cue identifier — the timing line must follow immediately.
      let timing = line;
      if (timing.indexOf("-->") === -1) {
        i++;
        timing = i < lines.length ? lines[i].trim() : "";
        if (timing.indexOf("-->") === -1) continue; // stray line, not a cue block
      }
      i++;
      const arrow = timing.split("-->");
      const start = parseTimestamp(arrow[0]);
      // Cue settings (e.g. "align:start position:0%") follow the end timestamp.
      const end = parseTimestamp((arrow[1] || "").trim().split(/[ \t]/)[0]);
      const textLines = [];
      while (i < lines.length && lines[i].trim()) {
        textLines.push(lines[i].trim());
        i++;
      }
      const cueText = textLines
        .join(" ")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (Number.isFinite(start) && Number.isFinite(end) && cueText) {
        cues.push({ start, end, text: cueText });
      }
    }
    return cues;
  }

  // "" when the parsed cues describe usable captions, otherwise a
  // creator-readable reason (at least one cue, every cue 0 <= start < end).
  function validateVtt(cues) {
    if (!Array.isArray(cues) || !cues.length) {
      return "No caption cues found — upload a WebVTT (.vtt) file with at least one timed cue like 00:00:01.000 --> 00:00:03.000.";
    }
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i] || {};
      if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0) {
        return "Caption cue " + (i + 1) + " has an invalid time range.";
      }
      if (c.end <= c.start) {
        return "Caption cue " + (i + 1) + " must end after it starts.";
      }
      if (!String(c.text == null ? "" : c.text).trim()) {
        return "Caption cue " + (i + 1) + " has no text.";
      }
    }
    return "";
  }

  // Store validated cues on the episode (sorted by start time so the first
  // cue is always cues[0]). Captions belong to the episode — presets and
  // saved templates never touch them, exactly like timed moments.
  function setCaptions(episode, cues, fileName) {
    const sorted = (cues || []).slice().sort((a, b) => a.start - b.start || a.end - b.end);
    episode.captions = { fileName: String(fileName || "captions.vtt"), cues: sorted };
    return episode.captions;
  }

  function clearCaptions(episode) {
    episode.captions = null;
    return episode;
  }

  // { fileName, cues } or null (episodes created before this feature simply
  // have no captions — nothing to migrate).
  function getCaptions(episode) {
    const store = episode && episode.captions;
    if (!store || !Array.isArray(store.cues)) return null;
    return store;
  }

  function cueCount(episode) {
    const store = getCaptions(episode);
    return store ? store.cues.length : 0;
  }

  function firstCue(episode) {
    const store = getCaptions(episode);
    return store && store.cues.length ? store.cues[0] : null;
  }

  // The cue scheduled over time t (seconds): start inclusive, end exclusive —
  // a 1.0–3.0 cue is visible at exactly 1.0 and gone at exactly 3.0. When
  // cues overlap, the earliest-starting one wins (they are stored sorted).
  function activeCue(episode, tSeconds) {
    const t = Number(tSeconds);
    if (!Number.isFinite(t)) return null;
    const store = getCaptions(episode);
    if (!store) return null;
    for (const c of store.cues) {
      if (t >= c.start && t < c.end) return c;
    }
    return null;
  }

  PDC.captions = {
    parseTimestamp,
    parseVtt,
    validateVtt,
    setCaptions,
    clearCaptions,
    getCaptions,
    cueCount,
    firstCue,
    activeCue,
  };
})();
