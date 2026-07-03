// scripts/verify-riverside-import.mjs
// Drives the shipped app in headless Chrome and proves step #195 end to end:
// from the normal setup panel, paste the repo's DECLARED sample Riverside-style
// manifest link (fixtures/riverside/demo-episode.json) into the real
// #riverside-link input, click the real Import button, and confirm Host,
// Guest 1, and Guest 2 fill with the manifest's REAL synced WebM tracks
// (blob-backed <video> decoders with real dimensions) composing as three
// distinct colors in the live preview. Then switch Split, Stack, and Spotlight
// and pixel-sample each preset's regions to confirm the imported videos
// rerender in distinct layouts, click the real Export action, and load the
// produced file back into a <video>: real dimensions, non-trivial bytes, and
// visible decoded frames showing the imported (red host) content.
//
// The app is served over a local HTTP server (same as `npm run serve`) because
// the import control fetches the manifest + tracks relative to the page — the
// fixtures are the sample INPUT media the step declares, loaded only through
// the product's own import control (no seeded episode state, no verifier-only
// product paths). Mirrors the CDP harness used by the other rendered checks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run Riverside import verification.");
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

// Same static file serving the product ships in scripts/serve.mjs — the import
// control fetches the manifest + tracks relative to the page, which needs http.
function startServer(rootDir) {
  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webm": "video/webm",
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const full = path.join(rootDir, rel);
    if (!full.startsWith(rootDir)) { res.writeHead(403).end("Forbidden"); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(full)] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const browserExpression = `
(async () => {
  const SAMPLE_LINK = "fixtures/riverside/demo-episode.json";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(typeof label === "function" ? label() : label);
  };

  function regionAvgColor(x0Pct, y0Pct, x1Pct, y1Pct) {
    const c = document.getElementById("stage-canvas");
    const w = c.width, h = c.height;
    const data = c.getContext("2d").getImageData(0, 0, w, h).data;
    const x0 = Math.floor(x0Pct / 100 * w), x1 = Math.floor(x1Pct / 100 * w);
    const y0 = Math.floor(y0Pct / 100 * h), y1 = Math.floor(y1Pct / 100 * h);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }
  function dominantChannel(color) {
    if (color.r > color.g + 25 && color.r > color.b + 25) return "red";
    if (color.g > color.r + 25 && color.g > color.b + 25) return "green";
    if (color.b > color.r + 25 && color.b > color.g + 25) return "blue";
    return "mixed";
  }
  function assertRegionColor(label, x0, y0, x1, y1, expected) {
    const color = regionAvgColor(x0, y0, x1, y1);
    const dom = dominantChannel(color);
    assert(dom === expected, label + ": expected " + expected + "-dominant imported-track pixels, got " + dom + " (" + JSON.stringify(color) + ")");
    return color;
  }
  function canvasLitPct() {
    const c = document.getElementById("stage-canvas");
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) lit++;
    return Math.round((lit / (data.length / 4)) * 100);
  }
  function layoutSignature() {
    const presetId = document.querySelector("#stage-canvas").dataset.preset;
    const n = Number(document.querySelector("#stage-canvas").dataset.speakers);
    return { presetId, rects: window.PDC.presets.getPreset(presetId).layout(n) };
  }

  await waitFor(() => window.PDC && window.PDC.riverside && document.querySelector("#riverside-link")
    && document.querySelector("#riverside-import") && document.querySelector("#export"),
    "shipped Riverside import + export controls should exist");
  assert(document.querySelectorAll(".bucket.filled").length === 0, "speaker buckets must start empty before import");
  assert(document.querySelector("#export").disabled, "export must start disabled before import");

  // Paste the repo's DECLARED sample manifest link into the real input and
  // click the real Import control. The handler reads the value at click time.
  const linkInput = document.querySelector("#riverside-link");
  linkInput.value = SAMPLE_LINK;
  linkInput.dispatchEvent(new Event("input", { bubbles: true }));
  linkInput.dispatchEvent(new Event("change", { bubbles: true }));
  document.querySelector("#riverside-import").click();

  const statusEl = document.querySelector("#riverside-status");
  const errorEl = document.querySelector("#riverside-error");
  await waitFor(
    () => /Imported 3 synced tracks/.test(statusEl.textContent) || (!errorEl.hidden && errorEl.textContent),
    () => "import should report success; status=" + JSON.stringify(statusEl.textContent) + " error=" + JSON.stringify(errorEl.textContent),
    300,
  );
  assert(errorEl.hidden, "import must not fail: " + errorEl.textContent);
  const statusLine = statusEl.textContent;
  assert(/Imported 3 synced tracks/.test(statusLine), "status should report 3 imported tracks, got: " + statusLine);
  assert(/Demo Episode/.test(statusLine), "status should name the imported episode, got: " + statusLine);
  assert(/Host, Guest 1, Guest 2/.test(statusLine), "status should list the filled speakers, got: " + statusLine);

  // Three speaker buckets populated as Host / Guest 1 / Guest 2, showing the
  // manifest's real track names through the same bucket rows uploads use.
  const filled = [...document.querySelectorAll(".bucket.filled")].map((b) => b.dataset.bucket);
  assert(JSON.stringify(filled) === JSON.stringify(["host", "guest1", "guest2"]),
    "all three buckets should fill from the import, got " + JSON.stringify(filled));
  const expectNames = { host: "Host", guest1: "Guest 1", guest2: "Guest 2" };
  const expectTracks = { host: "demo-episode-host.webm", guest1: "demo-episode-guest1.webm", guest2: "demo-episode-guest2.webm" };
  for (const bucket of ["host", "guest1", "guest2"]) {
    const name = document.querySelector('.bucket[data-bucket="' + bucket + '"] .bucket-name').textContent;
    const track = document.querySelector('[data-status="' + bucket + '"]').textContent;
    assert(name === expectNames[bucket], bucket + " should be labeled " + expectNames[bucket] + ", got " + JSON.stringify(name));
    assert(track === expectTracks[bucket], bucket + " should show its imported track name " + expectTracks[bucket] + ", got " + JSON.stringify(track));
  }

  // REAL synced video tracks: blob-backed hidden decoders with real dimensions.
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 3,
    "three hidden decoder videos should exist after import", 200);
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(() => vids.every((v) => v.videoWidth > 0 && v.videoHeight > 0),
    () => "imported tracks should decode real dimensions, got " + JSON.stringify(vids.map((v) => v.videoWidth + "x" + v.videoHeight)),
    300);
  assert(vids.every((v) => v.src.indexOf("blob:") === 0), "imported tracks must be real blob-backed files");
  const importedTracks = vids.map((v) => ({ speaker: v.dataset.speaker, dimensions: v.videoWidth + "x" + v.videoHeight, srcIsBlob: v.src.indexOf("blob:") === 0 }));

  await waitFor(() => !document.querySelector("#play").disabled, "preview transport should be usable after import");
  await waitFor(() => canvasLitPct() >= 5, () => "composed preview should light up after import (lit=" + canvasLitPct() + "%)", 200);
  await sleep(600);

  // Split (default preset): host tall on the left (red), guest1 top-right
  // (green), guest2 bottom-right (blue) — the fixture tracks' distinct colors.
  const canvas = document.querySelector("#stage-canvas");
  assert(canvas.dataset.preset === "split", "default preset should be split, got " + canvas.dataset.preset);
  assert(canvas.dataset.speakers === "3", "preview should compose all 3 imported speakers, got " + canvas.dataset.speakers);
  const splitLayout = layoutSignature();
  const splitColors = {
    host: assertRegionColor("split host (left half)", 4, 15, 46, 78, "red"),
    guest1: assertRegionColor("split guest1 (top right)", 54, 4, 96, 42, "green"),
    guest2: assertRegionColor("split guest2 (bottom right)", 54, 54, 96, 88, "blue"),
  };

  async function clickPreset(id) {
    document.querySelector('[data-preset="' + id + '"]').click();
    await sleep(500);
    assert(canvas.dataset.preset === id, "preset switch should recompose to " + id + ", got " + canvas.dataset.preset);
    assert(canvas.dataset.speakers === "3", id + " should keep composing 3 imported speakers");
  }

  // Stack: three full-width rows, host/guest1/guest2 top to bottom.
  await clickPreset("stack");
  const stackLayout = layoutSignature();
  const stackRects = window.PDC.presets.getPreset("stack").layout(3);
  const stackRows = stackRects.map((rect, i) => {
    const pad = Math.min(4, rect.h * 0.15);
    const color = regionAvgColor(rect.x + 2, rect.y + pad, rect.x + rect.w - 2, rect.y + rect.h - pad);
    return { row: i, color, dom: dominantChannel(color) };
  });
  assert(stackRows[0].dom === "red", "stack row 1 should show the imported host feed: " + JSON.stringify(stackRows[0]));
  assert(stackRows[1].dom === "green", "stack row 2 should show the imported Guest 1 feed: " + JSON.stringify(stackRows[1]));
  assert(stackRows[2].dom === "blue", "stack row 3 should show the imported Guest 2 feed: " + JSON.stringify(stackRows[2]));

  // Spotlight: host fills the stage; guests are PiP insets.
  await clickPreset("spotlight");
  const spotlightLayout = layoutSignature();
  const spotRects = window.PDC.presets.getPreset("spotlight").layout(3);
  assert(spotRects[0].w === 100 && spotRects[0].h === 100, "spotlight host should fill the stage");
  const spotlightRegions = {
    center: assertRegionColor("spotlight center", 25, 25, 70, 70, "red"),
    guest1Pip: assertRegionColor("spotlight guest1 PiP", spotRects[1].x + 2, spotRects[1].y + 2, spotRects[1].x + spotRects[1].w - 2, spotRects[1].y + spotRects[1].h - 2, "green"),
    guest2Pip: assertRegionColor("spotlight guest2 PiP", spotRects[2].x + 2, spotRects[2].y + 2, spotRects[2].x + spotRects[2].w - 2, spotRects[2].y + spotRects[2].h - 2, "blue"),
  };

  // The three presets must be genuinely distinct geometries (not one rerender).
  const signatures = [splitLayout, stackLayout, spotlightLayout].map((s) => JSON.stringify(s.rects));
  assert(new Set(signatures).size === 3, "Split/Stack/Spotlight must compose distinct geometries: " + signatures.join(" | "));

  // Imported tracks survive the preset cycling intact (same session).
  assert(document.querySelector('[data-status="host"]').textContent === expectTracks.host, "imported host track should survive preset cycling");
  assert(document.querySelectorAll(".bucket.filled").length === 3, "all buckets should stay filled through preset cycling");

  // Export with the imported tracks in the same session, through the real
  // control, and prove the produced file is a genuinely playable video.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled with imported tracks");
  document.querySelector("#export").click();
  await waitFor(() => document.querySelector("#export-download"), "export should produce a downloadable result", 700);
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 2048, "exported file should carry non-trivial bytes, got " + blob.size);

  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0,
    "exported file should be a playable video with real dimensions, got " + v.videoWidth + "x" + v.videoHeight);
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }

  // Decoded frames must be visibly nonblank and show the imported host content
  // (spotlight was the selected preset, so frames are host-red dominant).
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
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 300);
    });
    const ctx = probe.getContext("2d");
    ctx.drawImage(v, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let lit = 0, r = 0, g = 0, b = 0;
    const total = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) lit++;
      r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
    const avg = { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) };
    return { t: Math.round(t * 100) / 100, litPct: Math.round((lit / total) * 100), avg, dom: dominantChannel(avg) };
  }
  const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
  const frameA = await seekAndSample(Math.max(0.05, dur * 0.3));
  const frameB = await seekAndSample(Math.min(dur - 0.05, dur * 0.7));
  assert(frameA.litPct > 20, "exported frame near " + frameA.t + "s should show visible decoded pixels: " + JSON.stringify(frameA));
  assert(frameB.litPct > 20, "exported frame near " + frameB.t + "s should show visible decoded pixels: " + JSON.stringify(frameB));
  assert(frameA.dom === "red" && frameB.dom === "red",
    "exported frames should show the imported host (red) spotlight content: " + JSON.stringify([frameA, frameB]));

  return {
    statusLine,
    filledBuckets: filled,
    bucketLabels: expectNames,
    importedTracks,
    splitColors,
    stackRows,
    spotlightRegions,
    layoutsDistinct: signatures.length === new Set(signatures).size,
    export: {
      bytes: blob.size,
      dimensions: v.videoWidth + "x" + v.videoHeight,
      duration: Math.round(dur * 100) / 100,
      downloadName: document.querySelector("#export-download").getAttribute("download"),
      frames: [frameA, frameB],
    },
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const debugPort = await getFreePort();
  const { server, port: httpPort } = await startServer(root);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-riverside-"));
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
    `http://127.0.0.1:${httpPort}/`,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    // The http-served page may still be mid-navigation when the socket opens;
    // an evaluate issued then dies with "Execution context was destroyed".
    // Bounded wait for a settled document before driving the workflow.
    // The probe also requires the served origin + the app namespace, because the
    // initial target can be a fully-"complete" about:blank that is about to
    // navigate away and destroy the context.
    let pageReady = false;
    const readyProbe = `location.host + "|" + document.readyState + "|" + String(!!window.PDC)`;
    for (let i = 0; i < 100 && !pageReady; i++) {
      try {
        const probe = await send("Runtime.evaluate", { expression: readyProbe, returnByValue: true });
        pageReady = probe.result && probe.result.value === `127.0.0.1:${httpPort}|complete|true`;
      } catch (e) { /* still navigating */ }
      if (!pageReady) await sleep(100);
    }
    if (!pageReady) throw new Error("the served app never finished loading");
    // 60s budget: fixture import + three preset recompositions + a full export.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-riverside-import: OK — sample Riverside link fills Host/Guest 1/Guest 2 with real synced tracks, recomposes across presets, and exports a playable video");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    server.close();
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-riverside-import: ${e.message}`); process.exit(1); });
