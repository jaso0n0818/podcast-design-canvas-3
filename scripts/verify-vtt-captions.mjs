// scripts/verify-vtt-captions.mjs
// Drives the shipped app in headless Chrome and proves the WebVTT transcript
// caption workflow end to end: upload two generated speaker WebM videos
// (solid red host / solid green guest, ~9s, each with an audio tone) through
// the normal Host and Guest controls, then upload a generated WebVTT file
// with two timed cues ("HELLO CAPTION ONE" 1.0-3.0s, "SECOND CUE TEXT"
// 5.0-7.5s) through the real caption input. It verifies the status line
// reports both cues; that uploading while PAUSED auto-seeks into the first
// cue so the caption is immediately visible on the static canvas; that during
// playback and while scrubbing the caption bar renders ONLY inside each cue's
// [start, end) range (present at 2s and 6s, absent at 4s); that switching to
// Stack and Spotlight keeps the same captions attached and rendering over the
// recomposed preview; and finally that the real Export action produces a
// playable video WITH A DECODABLE, NON-SILENT AUDIO TRACK in which the
// captions are BURNED INTO the frames: the exported file is loaded back into
// a <video>, seeked to 2s / 4s / 6s, and each decoded frame is drawn to a
// probe canvas and region-sampled (dark backing bar + light text = present;
// plain bright video = absent), with every frame nonblank. All pixel
// assertions are region-based, tolerant of encoder loss, and carry measured
// diagnostics; every wait polls a natural condition with a hard bound — no
// committed fixtures, seeded media, or verifier-only product paths. Mirrors
// the CDP harness used by the other rendered checks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run vtt-captions verification.");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); child.off("exit", onExit); resolve(ok); };
    const onExit = () => finish(true);
    const t = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2000);
}
async function removeDirEventually(dir) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (i === 7) return; await sleep(100 * (i + 1)); }
  }
}
async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
    await sleep(250);
  }
  throw last;
}
function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  // ~9.2s solid-color speaker video (uniform frames — no baked-in text — so
  // the caption-bar region is trivially distinguishable) with an audio tone.
  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.frequency.value = freq || 440;
    const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 92; i++) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); await sleep(100); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  // Region sampling: the caption bar renders bottom-centered (dark backing +
  // light text). "Present" = mostly dark pixels plus some light text pixels;
  // "absent" = plain bright video (the generated speakers are solid red/green,
  // which carry no dark/near-white pixels in this region across Split, Stack,
  // and Spotlight — speaker name tags sit below it and the Spotlight PiP inset
  // sits right of it). Bounds are inset from the drawn bar so the checks stay
  // tolerant of encoder loss and rounding.
  const CAPTION_REGION = { x0: 44, y0: 87.5, x1: 56, y1: 94 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, light = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 70 && g < 70 && b < 70) dark++;
      if (r > 180 && g > 180 && b > 180) light++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { dark: Number((dark / n).toFixed(4)), light: Number((light / n).toFixed(4)), bright: Number((bright / n).toFixed(4)) };
  }
  const stage = () => document.querySelector("#stage-canvas");
  const captionShown = () => { const s = regionStats(stage(), CAPTION_REGION); return s.dark > 0.45 && s.light > 0.004; };
  const captionAbsent = () => { const s = regionStats(stage(), CAPTION_REGION); return s.dark < 0.1 && s.light < 0.01; };

  await waitFor(() => window.PDC && window.PDC.captions && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector("#caption-file") && document.querySelector("#caption-status")
    && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped caption/scrub/export controls should exist");

  // Model semantics: both timestamp forms parse, NOTE blocks are skipped,
  // multi-line cue text joins, and activation is [start, end).
  {
    const sample = "WEBVTT - sample\\r\\n\\r\\nNOTE generated for the model check\\r\\nspans two lines\\r\\n\\r\\nintro\\r\\n00:00:01.000 --> 00:00:03.000\\r\\nHELLO LINE\\r\\ncontinued\\r\\n\\r\\n00:05.000 --> 00:07.500\\r\\nSECOND\\r\\n";
    const cues = window.PDC.captions.parseVtt(sample);
    assert(cues.length === 2, "sample VTT should parse 2 cues, got " + JSON.stringify(cues));
    assert(cues[0].start === 1 && cues[0].end === 3 && cues[0].text === "HELLO LINE continued",
      "first cue should join multi-line text with HH:MM:SS.mmm times: " + JSON.stringify(cues[0]));
    assert(cues[1].start === 5 && cues[1].end === 7.5 && cues[1].text === "SECOND",
      "second cue should parse MM:SS.mmm times: " + JSON.stringify(cues[1]));
    assert(window.PDC.captions.validateVtt(cues) === "", "sample cues should validate");
    const scratch = window.PDC.episode.createEpisode({});
    window.PDC.captions.setCaptions(scratch, cues, "sample.vtt");
    const at = (t) => { const c = window.PDC.captions.activeCue(scratch, t); return c ? c.text : ""; };
    assert(at(1) === "HELLO LINE continued", "cue should be active at exactly its start (inclusive)");
    assert(at(2.9) !== "" && at(3) === "", "cue should end exactly at its end time (exclusive)");
    assert(at(4) === "", "nothing should be active in the 3-5s gap");
    assert(at(5) === "SECOND" && at(7.5) === "", "second cue should span [5, 7.5)");
  }

  // Upload two speaker videos through the normal Host and Guest controls.
  const [host, guest] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
  ]);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 8),
    "uploaded speakers should decode with a real duration covering both cue ranges", 400,
  );

  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");

  // Choose Split.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  // PAUSE the preview, then upload the maintainer-owned WebVTT file through
  // the real caption input. With no captions loaded the caption region must
  // show plain bright video first.
  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  pausePreview();
  await waitFor(() => captionAbsent(), "before any VTT upload the caption region should be plain video: "
    + JSON.stringify(regionStats(stage(), CAPTION_REGION)), 100);

  const vttText = "WEBVTT\\r\\n\\r\\nNOTE two timed caption cues over the composed episode\\r\\n\\r\\n1\\r\\n00:00:01.000 --> 00:00:03.000\\r\\nHELLO CAPTION ONE\\r\\n\\r\\n2\\r\\n00:05.000 --> 00:07.500\\r\\nSECOND CUE TEXT\\r\\n";
  uploadTo(document.querySelector("#caption-file"), new File([vttText], "maintainer-captions.vtt", { type: "text/vtt" }));
  await waitFor(
    () => /2 captions loaded from maintainer-captions\\.vtt/.test(document.querySelector("#caption-status").textContent),
    "status line should report 2 captions loaded, got: " + document.querySelector("#caption-status").textContent, 200,
  );
  const capErr = document.querySelector("#caption-error");
  assert(capErr.hidden || !capErr.textContent.trim(), "no caption error should be shown for a valid VTT: " + capErr.textContent);
  const listItems = document.querySelectorAll("#caption-list li");
  assert(listItems.length === 2, "caption list should show both cues, got " + listItems.length);
  const listText = document.querySelector("#caption-list").textContent;
  assert(listText.includes("HELLO CAPTION ONE") && listText.includes("SECOND CUE TEXT"),
    "caption list should show both cue texts: " + listText);

  // STATIC: because the preview was paused, the upload auto-seeks into the
  // first cue — the caption must be visible on the canvas with no further
  // interaction, and the scrub readout must sit at the first cue's start.
  await waitFor(() => captionShown(),
    "paused VTT upload should auto-seek so the first caption is immediately visible: "
    + JSON.stringify(regionStats(stage(), CAPTION_REGION)), 160);
  const staticStats = regionStats(stage(), CAPTION_REGION);
  assert(document.querySelector("#scrub-time").textContent === "0:01",
    "scrub readout should sit at the first cue start after the paused auto-seek, got " + document.querySelector("#scrub-time").textContent);

  // PLAYBACK: pressing Play restarts the shared timeline from 0, so the whole
  // schedule unfolds live on the canvas: no caption before 1.0s, HELLO CAPTION
  // ONE inside 1-3s, nothing in the 3-5s gap, SECOND CUE TEXT inside 5-7.5s.
  document.querySelector("#play").click();
  await waitFor(() => captionAbsent(), "playback should restart before the first cue (no caption under 1.0s)", 200);
  await waitFor(() => captionShown(), "first caption should appear during playback inside 1-3s", 200);
  await waitFor(() => captionAbsent(), "caption should disappear once playback passes 3.0s", 200);
  await waitFor(() => captionShown(), "second caption should appear during playback inside 5.0-7.5s", 200);
  const playbackStats = regionStats(stage(), CAPTION_REGION);

  // SCRUB: pause, then sample exact times through the real scrub control.
  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 8, "scrub bar should span the episode", 100);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  }
  pausePreview();
  await scrubTo(2);
  await waitFor(() => captionShown(), "scrubbed to 2s: HELLO CAPTION ONE should be shown (Split): "
    + JSON.stringify(regionStats(stage(), CAPTION_REGION)));
  const splitAt2 = regionStats(stage(), CAPTION_REGION);
  await scrubTo(4);
  await waitFor(() => captionAbsent(), "scrubbed to 4s: no caption should be shown in the gap (Split): "
    + JSON.stringify(regionStats(stage(), CAPTION_REGION)));
  assert(regionStats(stage(), CAPTION_REGION).bright > 0.5, "at 4s the caption region should show plain bright video: "
    + JSON.stringify(regionStats(stage(), CAPTION_REGION)));
  await scrubTo(6);
  await waitFor(() => captionShown(), "scrubbed to 6s: SECOND CUE TEXT should be shown (Split): "
    + JSON.stringify(regionStats(stage(), CAPTION_REGION)));
  const splitAt6 = regionStats(stage(), CAPTION_REGION);

  // PRESET SWITCHES: the same captions must stay attached to the episode and
  // render over the recomposed Stack and Spotlight layouts at the same times.
  const presetStats = {};
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    assert(/2 captions loaded/.test(document.querySelector("#caption-status").textContent),
      "caption status should survive switching to " + presetId);
    assert(document.querySelectorAll("#caption-list li").length === 2, "caption list should survive switching to " + presetId);
    pausePreview();
    await scrubTo(6);
    await waitFor(() => captionShown(), presetId + ": caption should render over the recomposed layout at 6s: "
      + JSON.stringify(regionStats(stage(), CAPTION_REGION)));
    presetStats[presetId + "At6"] = regionStats(stage(), CAPTION_REGION);
    await scrubTo(4);
    await waitFor(() => captionAbsent(), presetId + ": no caption at 4s: "
      + JSON.stringify(regionStats(stage(), CAPTION_REGION)));
  }

  // Back to Split for the export.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");

  // EXPORT: click the real Export action and read the product's own download.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  const exportStartedAt = performance.now();
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 800,
  );
  const exportWallSeconds = Number(((performance.now() - exportStartedAt) / 1000).toFixed(1));
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  // Load the exported file back into a <video>, resolve its real duration
  // (recorder-produced WebM reports Infinity until nudged to the end).
  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }
  assert(v.duration >= 7.6, "export should cover both cue ranges, duration=" + v.duration);

  // The contract requires the file to remain playable WITH AUDIO: decode the
  // audio track via Web Audio and require real, non-silent samples.
  const buf = await blob.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let audioPeak = 0, audioSamples = 0;
  try {
    const decoded = await ac.decodeAudioData(buf.slice(0));
    audioSamples = decoded.length;
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < data.length; i += 97) { const a = Math.abs(data[i]); if (a > audioPeak) audioPeak = a; }
    }
  } catch (e) {
    throw new Error("exported file has no decodable audio track (" + e.name + ") — it must remain playable with audio");
  } finally { ac.close(); }
  assert(audioSamples > 0 && audioPeak > 1e-4,
    "exported audio must be audible (non-silent), samples=" + audioSamples + " peak=" + audioPeak);

  // Seek into and outside each cue range and sample the decoded frames.
  const probe = document.createElement("canvas");
  probe.width = v.videoWidth; probe.height = v.videoHeight;
  async function seekAndSample(t) {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
      v.addEventListener("seeked", fin);
      setTimeout(fin, 4000);
      try { v.currentTime = t; } catch (e) { fin(); }
    });
    // Let the seeked frame present (bounded; rVFC when available).
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 300);
    });
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return {
      t,
      caption: regionStats(probe, CAPTION_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }
  const inCueOne = await seekAndSample(2);
  const inGap = await seekAndSample(4);
  const inCueTwo = await seekAndSample(6);
  const burnedIn = (s) => s.dark > 0.3 && s.light > 0.0015;
  const plainVideo = (s) => s.dark < 0.15 && s.light < 0.02;
  assert(inCueOne.frame.bright > 0.2, "exported frame at 2s should be nonblank: " + JSON.stringify(inCueOne.frame));
  assert(burnedIn(inCueOne.caption), "HELLO CAPTION ONE should be burned into the exported frame at 2s: " + JSON.stringify(inCueOne.caption));
  assert(inGap.frame.bright > 0.2, "exported frame at 4s should be nonblank: " + JSON.stringify(inGap.frame));
  assert(plainVideo(inGap.caption), "no caption should be burned in at 4s: " + JSON.stringify(inGap.caption));
  assert(inCueTwo.frame.bright > 0.2, "exported frame at 6s should be nonblank: " + JSON.stringify(inCueTwo.frame));
  assert(burnedIn(inCueTwo.caption), "SECOND CUE TEXT should be burned into the exported frame at 6s: " + JSON.stringify(inCueTwo.caption));

  return {
    captionStatus: document.querySelector("#caption-status").textContent,
    preview: {
      staticAfterPausedUpload: staticStats,
      playbackSecondCue: playbackStats,
      splitAt2,
      splitAt6,
      stackAt6: presetStats.stackAt6,
      spotlightAt6: presetStats.spotlightAt6,
    },
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
    exportWallSeconds,
    exportAudio: { samples: audioSamples, peak: Number(audioPeak.toFixed(4)) },
    exportSamples: { inCueOne, inGap, inCueTwo },
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-vtt-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, entryUrl,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    // 150s budget: two ~9s in-browser media generations, static + playback +
    // scrub + preset-switch sampling, one full-length export, an audio decode,
    // and three decode-seeks.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 150000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-vtt-captions: OK — WebVTT cues render only in range across Split/Stack/Spotlight, survive preset switches, and are burned into a playable export with audio");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-vtt-captions: ${e.message}`); process.exit(1); });
