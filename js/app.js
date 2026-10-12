import * as geo from "./geo.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);
const HOLD_MS = 1000;
const PERSIST_EVERY_MS = 5000;
const UNIT_TEXT = {
  km: { plural: "kilometers", singular: "kilometer", short: "km", column: "Km" },
  mi: { plural: "miles", singular: "mile", short: "mi", column: "Mile" },
};

const state = {
  settings: store.loadSettings(),
  watchId: null,
  lastFix: null,
  lastFixAt: 0,
  gpsDenied: false,
  run: null, // the run in progress, if any
  ticker: null,
  lastPersist: 0,
  wakeLock: null,
  detailRun: null,
};

// ---------- GPS ----------

function startGPS() {
  if (state.watchId != null) return;
  if (!("geolocation" in navigator)) return setGPS("error", "No GPS");
  setGPS("searching", "Searching…");
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGPSError, {
    enableHighAccuracy: true,
    maximumAge: 0,
  });
}

function stopGPS() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.lastFix = null;
  setGPS("off", "GPS off");
}

function restartGPS() {
  if (state.watchId == null) return;
  navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  startGPS();
}

function onPosition(pos) {
  const c = pos.coords;
  const fix = {
    lat: c.latitude,
    lon: c.longitude,
    acc: c.accuracy,
    alt: c.altitude ?? null,
    t: pos.timestamp || Date.now(),
  };
  state.gpsDenied = false;
  state.lastFix = fix;
  state.lastFixAt = Date.now();
  renderGPS();
  if (state.run?.status === "running") record(fix);
}

function onGPSError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    state.gpsDenied = true;
    stopGPS();
    setGPS("error", "GPS denied");
    alert(
      "RunRunRun needs your location to track runs.\n\n" +
        "On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using the App, " +
        "and make sure Precise Location is on."
    );
  } else {
    setGPS("searching", "Searching…");
  }
}

function setGPS(stateName, text) {
  $("gps").dataset.state = stateName;
  $("gps-text").textContent = text;
}

function renderGPS() {
  if (state.watchId == null) return;
  const fix = state.lastFix;
  if (!fix || Date.now() - state.lastFixAt > 10000) return setGPS("searching", "Searching…");
  const acc = Math.round(fix.acc);
  if (acc <= 12) setGPS("good", `GPS ±${acc} m`);
  else setGPS("weak", `Weak ±${acc} m`);
}

// ---------- Recording ----------

function elapsed(run) {
  return run.activeMs + (run.status === "running" ? Date.now() - run.resumedAt : 0);
}

function points(run) {
  return geo.allPoints(run.segments);
}

function record(fix) {
  const run = state.run;
  if (fix.t < run.resumedAt - 2000) return; // cached fix from before (re)start
  const seg = run.segments[run.segments.length - 1];
  const last = seg[seg.length - 1] ?? null;
  const verdict = geo.evaluateFix(last, fix);
  if (!verdict.accept) return;

  run.distance += verdict.distance;
  const e = Math.max(run.activeMs + (fix.t - run.resumedAt), last?.e ?? 0);
  seg.push({
    lat: fix.lat,
    lon: fix.lon,
    t: fix.t,
    e,
    d: run.distance,
    acc: Math.round(fix.acc),
    alt: fix.alt == null ? null : Math.round(fix.alt * 10) / 10,
  });

  announceSplits();
  renderRun();
  drawRoute($("live-route"), run.segments);
  $("live-route-empty").hidden = true;
}

function persist(force = false) {
  if (!state.run) return;
  const now = Date.now();
  if (!force && now - state.lastPersist < PERSIST_EVERY_MS) return;
  state.lastPersist = now;
  store.saveActiveRun({ ...state.run, savedAt: now });
}

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function startRun() {
  const now = Date.now();
  state.run = {
    id: newId(),
    startedAt: now,
    status: "running",
    activeMs: 0,
    resumedAt: now,
    distance: 0,
    segments: [[]],
    announced: 0,
  };
  speak("Run started");
  startGPS();
  afterStateChange();
}

function pauseRun() {
  const run = state.run;
  if (run?.status !== "running") return;
  run.activeMs += Date.now() - run.resumedAt;
  run.status = "paused";
  speak("Paused");
  afterStateChange();
}

function resumeRun() {
  const run = state.run;
  if (run?.status !== "paused") return;
  run.status = "running";
  run.resumedAt = Date.now();
  run.segments.push([]); // don't draw or count distance across the pause
  speak("Resumed");
  startGPS();
  afterStateChange();
}

async function finishRun() {
  const run = state.run;
  if (!run) return;
  if (run.status === "running") run.activeMs += Date.now() - run.resumedAt;

  state.run = null;
  store.clearActiveRun();
  stopTicker();
  releaseWakeLock();
  stopGPS();
  resetRunView();

  if (run.activeMs < 5000 && run.distance < 10) return; // accidental start

  const saved = {
    id: run.id,
    startedAt: run.startedAt,
    endedAt: Date.now(),
    duration: run.activeMs,
    distance: run.distance,
    segments: run.segments.filter((s) => s.length > 0),
    version: 1,
  };
  await store.saveRun(saved);
  speak(`Run complete. ${spokenDistance(saved.distance)} in ${spokenDuration(saved.duration)}.`);
  showTab("history");
  showDetail(saved.id);
}

function afterStateChange() {
  persist(true);
  $("view-run").dataset.runState = state.run?.status ?? "idle";
  $("restore-hint").hidden = true;
  if (state.run) {
    startTicker();
    requestWakeLock();
  }
  renderRun();
}

function startTicker() {
  if (state.ticker) return;
  state.ticker = setInterval(() => {
    renderRun();
    renderGPS();
    if (state.run?.status === "running") persist();
  }, 500);
}

function stopTicker() {
  clearInterval(state.ticker);
  state.ticker = null;
}

// ---------- Voice ----------

function speak(text) {
  if (!state.settings.voice || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  speechSynthesis.speak(u);
}

function spokenDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (s || parts.length === 0) parts.push(`${s} second${s === 1 ? "" : "s"}`);
  return parts.join(" ");
}

function spokenDistance(meters) {
  const unit = state.settings.unit;
  const n = +(meters / geo.METERS_PER_UNIT[unit]).toFixed(2);
  return `${n} ${n === 1 ? UNIT_TEXT[unit].singular : UNIT_TEXT[unit].plural}`;
}

function announceSplits() {
  const run = state.run;
  const unit = state.settings.unit;
  const done = Math.floor(run.distance / geo.METERS_PER_UNIT[unit]);
  if (done <= run.announced) return;
  run.announced = done;
  const split = geo.computeSplits(points(run), unit).filter((s) => !s.partial).at(-1);
  const name = done === 1 ? UNIT_TEXT[unit].singular : UNIT_TEXT[unit].plural;
  let text = `${done} ${name}. Time ${spokenDuration(elapsed(run))}.`;
  if (split) text += ` Last split ${spokenDuration(split.ms)}.`;
  speak(text);
}

// ---------- Screen wake lock ----------

async function requestWakeLock() {
  if (!state.settings.wakeLock || !("wakeLock" in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => (state.wakeLock = null));
  } catch {
    // Not allowed right now (e.g. page hidden); we'll retry on visibilitychange.
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.run) return;
  requestWakeLock();
  // iOS can stall location updates while backgrounded; kick the watcher.
  restartGPS();
  renderRun();
});

// ---------- Rendering ----------

function renderUnits() {
  const unit = state.settings.unit;
  document.querySelectorAll(".unit-suffix").forEach((el) => (el.textContent = `/${UNIT_TEXT[unit].short}`));
  $("stat-distance-unit").textContent = UNIT_TEXT[unit].plural;
  document.querySelectorAll("[data-unit]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.unit === unit)));
}

function renderRun() {
  const run = state.run;
  const unit = state.settings.unit;
  if (!run) return;
  const ms = elapsed(run);
  $("stat-distance").textContent = geo.formatDistance(run.distance, unit);
  $("stat-time").textContent = geo.formatDuration(ms);
  $("stat-avg").textContent = geo.formatPace(run.distance >= 50 ? geo.paceSecondsPerUnit(run.distance, ms, unit) : null);

  const pts = points(run);
  const last = pts.at(-1);
  const fresh = run.status === "running" && last && ms - last.e < 15000;
  $("stat-pace").textContent = geo.formatPace(fresh ? geo.recentPace(pts, unit) : null);
}

function resetRunView() {
  $("view-run").dataset.runState = "idle";
  $("stat-distance").textContent = "0.00";
  $("stat-time").textContent = "0:00";
  $("stat-pace").textContent = geo.formatPace(null);
  $("stat-avg").textContent = geo.formatPace(null);
  $("live-route").innerHTML = "";
  $("live-route-empty").hidden = false;
}

function drawRoute(svg, segments) {
  const { lines, start, end } = geo.projectRoute(segments, 320, 200, 16);
  if (!start) {
    svg.innerHTML = "";
    return;
  }
  svg.innerHTML =
    lines.map((l) => `<polyline points="${l}"/>`).join("") +
    `<circle class="start" cx="${start[0]}" cy="${start[1]}" r="6"/>` +
    `<circle class="end" cx="${end[0]}" cy="${end[1]}" r="6"/>`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const longDateFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function statTile(value, label) {
  return el("div", { className: "stat" }, [
    el("div", { className: "value", textContent: value }),
    el("div", { className: "label", textContent: label }),
  ]);
}

function formatTotalTime(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

async function renderHistory() {
  const unit = state.settings.unit;
  const runs = await store.listRuns();
  const totalDist = runs.reduce((s, r) => s + r.distance, 0);
  const totalMs = runs.reduce((s, r) => s + r.duration, 0);
  $("totals").replaceChildren(
    statTile(String(runs.length), runs.length === 1 ? "Run" : "Runs"),
    statTile((totalDist / geo.METERS_PER_UNIT[unit]).toFixed(1), `Total ${UNIT_TEXT[unit].short}`),
    statTile(formatTotalTime(totalMs), "Time")
  );
  $("history-empty").hidden = runs.length > 0;
  $("history-list").replaceChildren(
    ...runs.map((r) => {
      const pace = geo.formatPace(geo.paceSecondsPerUnit(r.distance, r.duration, unit));
      const btn = el("button", { type: "button" }, [
        el("span", { className: "h-date", textContent: `${dateFmt.format(r.startedAt)}` }),
        el("span", { className: "h-dist" }, [geo.formatDistance(r.distance, unit), el("small", { textContent: UNIT_TEXT[unit].short })]),
        el("span", {
          className: "h-meta",
          textContent: `${timeFmt.format(r.startedAt)} · ${geo.formatDuration(r.duration)} · ${pace} /${UNIT_TEXT[unit].short}`,
        }),
      ]);
      btn.addEventListener("click", () => showDetail(r.id));
      return el("li", {}, [btn]);
    })
  );
}

async function showDetail(id) {
  const run = await store.getRun(id);
  if (!run) return showTab("history");
  state.detailRun = run;
  renderDetail();
  showView("detail");
  window.scrollTo(0, 0);
}

function renderDetail() {
  const run = state.detailRun;
  if (!run) return;
  const unit = state.settings.unit;
  $("detail-title").textContent = `${longDateFmt.format(run.startedAt)} · ${timeFmt.format(run.startedAt)}`;
  $("detail-distance").textContent = geo.formatDistance(run.distance, unit);
  $("detail-distance-unit").textContent = UNIT_TEXT[unit].plural;
  $("detail-time").textContent = geo.formatDuration(run.duration);
  $("detail-pace").textContent = geo.formatPace(geo.paceSecondsPerUnit(run.distance, run.duration, unit));
  drawRoute($("detail-route"), run.segments);

  $("splits-unit").textContent = UNIT_TEXT[unit].column;
  const splits = geo.computeSplits(geo.allPoints(run.segments), unit).map((s) => ({
    ...s,
    pace: s.ms / 1000 / (s.partial ? s.fraction : 1),
  }));
  const fastest = Math.min(...splits.map((s) => s.pace));
  const fastestFull = Math.min(...splits.filter((s) => !s.partial).map((s) => s.pace));
  $("splits-body").replaceChildren(
    ...splits.map((s) => {
      const label = s.partial ? s.fraction.toFixed(2) : String(s.index);
      const bar = el("div", { className: "bar" });
      bar.style.width = `${Math.round((fastest / s.pace) * 100)}%`;
      const row = el("tr", {}, [
        el("td", { textContent: label }),
        el("td", { textContent: geo.formatPace(s.pace) }),
        el("td", {}, [bar]),
      ]);
      if (splits.length > 1 && s.pace === fastestFull && !s.partial) row.className = "fastest";
      return row;
    })
  );
  if (splits.length === 0) {
    $("splits-body").replaceChildren(el("tr", {}, [el("td", { colSpan: 3, textContent: "Not enough distance for splits." })]));
  }
}

async function exportGPX() {
  const run = state.detailRun;
  if (!run) return;
  const day = new Date(run.startedAt).toISOString().slice(0, 10);
  const name = `RunRunRun ${day}`;
  const file = new File([geo.toGPX(run, name)], `run-${day}.gpx`, { type: "application/gpx+xml" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  el("a", { href: url, download: file.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function deleteDetailRun() {
  const run = state.detailRun;
  if (!run || !confirm("Delete this run? This can't be undone.")) return;
  await store.deleteRun(run.id);
  state.detailRun = null;
  showTab("history");
}

// ---------- Navigation ----------

function showView(name) {
  for (const v of ["run", "history", "detail", "settings"]) $(`view-${v}`).hidden = v !== name;
}

function showTab(tab) {
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  showView(tab);
  if (tab === "history") renderHistory();
  window.scrollTo(0, 0);
}

// ---------- Wiring ----------

function wireHoldButton(button, onDone) {
  let timer = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    button.classList.remove("holding");
  };
  button.style.setProperty("--hold-ms", `${HOLD_MS}ms`);
  button.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    button.classList.add("holding");
    timer = setTimeout(() => {
      cancel();
      navigator.vibrate?.(60);
      onDone();
    }, HOLD_MS);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => button.addEventListener(t, cancel));
  button.addEventListener("contextmenu", (e) => e.preventDefault());
  // Keyboard / assistive-tech activation has no hold; ask instead.
  button.addEventListener("click", (e) => {
    if (e.detail === 0 && confirm("Finish this run?")) onDone();
  });
}

function wire() {
  $("btn-start").addEventListener("click", startRun);
  $("btn-pause").addEventListener("click", pauseRun);
  $("btn-resume").addEventListener("click", resumeRun);
  wireHoldButton($("btn-finish"), finishRun);

  $("gps").addEventListener("click", () => (state.watchId == null ? startGPS() : renderGPS()));

  document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("btn-back").addEventListener("click", () => showTab("history"));
  $("btn-gpx").addEventListener("click", exportGPX);
  $("btn-delete").addEventListener("click", deleteDetailRun);

  document.querySelectorAll("[data-unit]").forEach((b) =>
    b.addEventListener("click", () => {
      state.settings.unit = b.dataset.unit;
      store.saveSettings(state.settings);
      if (state.run) state.run.announced = Math.floor(state.run.distance / geo.METERS_PER_UNIT[state.settings.unit]);
      renderUnits();
      renderRun();
      renderDetail();
    })
  );

  const voice = $("set-voice");
  voice.checked = state.settings.voice;
  voice.addEventListener("change", () => {
    state.settings.voice = voice.checked;
    store.saveSettings(state.settings);
  });

  const wake = $("set-wakelock");
  wake.checked = state.settings.wakeLock;
  wake.addEventListener("change", () => {
    state.settings.wakeLock = wake.checked;
    store.saveSettings(state.settings);
    if (!wake.checked) releaseWakeLock();
    else if (state.run) requestWakeLock();
  });

  document.querySelectorAll("[data-dismiss]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.dismiss;
      $(id).hidden = true;
      try {
        localStorage.setItem(`runrunrun.dismissed.${id}`, "1");
      } catch {}
    })
  );
}

function maybeShowInstallHint() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("runrunrun.dismissed.install-hint") === "1";
  } catch {}
  $("install-hint").hidden = !ios || standalone || dismissed;
}

// A run that was in progress when the page was killed comes back paused.
function restoreActiveRun() {
  const saved = store.loadActiveRun();
  if (!saved?.segments) return;
  if (saved.status === "running") {
    saved.activeMs += Math.max(0, (saved.savedAt ?? saved.resumedAt) - saved.resumedAt);
    saved.status = "paused";
  }
  delete saved.savedAt;
  state.run = saved;
  afterStateChange();
  $("restore-hint").hidden = false;
  drawRoute($("live-route"), saved.segments);
  $("live-route-empty").hidden = saved.segments.flat().length > 0;
}

async function warmUpGPSIfAllowed() {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    if (status?.state === "granted") startGPS();
  } catch {
    // Permissions API unsupported; GPS starts when the run does.
  }
}

function init() {
  wire();
  renderUnits();
  resetRunView();
  restoreActiveRun();
  maybeShowInstallHint();
  warmUpGPSIfAllowed();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
