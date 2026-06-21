import { DEFAULT_ROOM } from "./config.js";
import { createBackend } from "./backend.js";

/* ──────────────────────────────────────────────────────────────
   Pick a backend: local WiFi server if running, else Firebase.
   If neither is available, show the setup screen and stop.
   ────────────────────────────────────────────────────────────── */
const be = await createBackend();
if (!be) {
  document.getElementById("setup").classList.remove("hidden");
  throw new Error("No backend available — start the local server or fill in config.js");
}

const serverNow = () => be.serverNow();

const statusEl = document.getElementById("status");
be.onStatus((on) => {
  statusEl.classList.toggle("online", on);
  statusEl.classList.toggle("offline", !on);
  statusEl.title = on ? "Connected — synced" : "Reconnecting…";
});

/* ──────────────────────────────────────────────────────────────
   Room (shared channel)
   ────────────────────────────────────────────────────────────── */
const sanitizeRoom = (s) =>
  (s || "").trim().toLowerCase().replace(/[.#$/\[\]]/g, "-").slice(0, 32) || DEFAULT_ROOM;

let room = sanitizeRoom(localStorage.getItem("ft_room") || DEFAULT_ROOM);
let unsubscribe = null;
document.getElementById("roomLabel").textContent = room;

/* ──────────────────────────────────────────────────────────────
   Operators (who is using this phone)
   ────────────────────────────────────────────────────────────── */
const OPERATORS = ["Alon", "Aviv"];
const OP_COLORS = { Alon: "#5e7cff", Aviv: "#ffb13d" };
const opColor = (name) => OP_COLORS[name] || "#8a90a6";
const supportsLog = be.mode === "local"; // operators/log are server features

let operator = localStorage.getItem("dt_operator");
if (!OPERATORS.includes(operator)) operator = OPERATORS[0];
const meta = () => ({ by: operator });

/* ──────────────────────────────────────────────────────────────
   State
   ────────────────────────────────────────────────────────────── */
let timers = {};            // id -> data
const els = {};             // id -> { card, time, bar, stateLabel, play, ... }
const alarmed = new Set();  // ids that already fired their alarm this run

const PALETTE = [
  "#5e7cff", "#2ee6a6", "#ff5d6c", "#ffb13d",
  "#b98cff", "#3ad1ff", "#ff7ac2", "#7dff5e",
];

/* ──────────────────────────────────────────────────────────────
   Time helpers
   ────────────────────────────────────────────────────────────── */
function remainingMs(t) {
  if (t.state === "running") return Math.max(0, (t.endAt || 0) - serverNow());
  return Math.max(0, t.remaining ?? t.duration ?? 0);
}

function fmt(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/* ──────────────────────────────────────────────────────────────
   Subscribe to the room's timers
   ────────────────────────────────────────────────────────────── */
function subscribe() {
  if (unsubscribe) unsubscribe();
  unsubscribe = be.subscribe(room, (data, extra) => {
    timers = data || {};
    if (extra && typeof extra.count === "number") setCount(extra.count);
    if (extra) setTurn(extra.turn);
    render();
    maybeRefreshLog();
    checkPending();
  });
}

/* ──────────────────────────────────────────────────────────────
   "Parts made by now" counter (server feature → only in local mode)
   ────────────────────────────────────────────────────────────── */
const counterEl = document.getElementById("counter");
const countValEl = document.getElementById("countVal");

function setCount(n) { countValEl.textContent = n; }

if (supportsLog) {
  counterEl.classList.remove("hidden");
  document.getElementById("countReset").addEventListener("click", () => {
    if (confirm("Reset the parts count to 0 for this room?")) be.resetCount(room, { by: operator });
  });
}

/* Time-of-day helper for logs */
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/* Whose turn is next (set by answering the finish prompt) */
const nextupEl = document.getElementById("nextup");
const nextupNameEl = document.getElementById("nextupName");
function setTurn(name) {
  if (!supportsLog || !name) { nextupEl.classList.add("hidden"); return; }
  nextupEl.classList.remove("hidden");
  nextupEl.style.setProperty("--nu", opColor(name));
  nextupNameEl.textContent = name;
}

/* ──────────────────────────────────────────────────────────────
   Render the grid (structure). Ticking only updates text/bar.
   ────────────────────────────────────────────────────────────── */
const grid = document.getElementById("grid");
const emptyEl = document.getElementById("empty");

function sortedIds() {
  return Object.keys(timers).sort(
    (a, b) => (timers[a].createdAt || 0) - (timers[b].createdAt || 0)
  );
}

function render() {
  const ids = sortedIds();
  emptyEl.classList.toggle("hidden", ids.length > 0);

  for (const id of Object.keys(els)) {
    if (!timers[id]) { els[id].card.remove(); delete els[id]; alarmed.delete(id); }
  }

  for (const id of ids) {
    if (!els[id]) els[id] = buildCard(id);
    paintCard(id, timers[id]);
  }

  ids.forEach((id) => grid.appendChild(els[id].card));
  tick();
}

function buildCard(id) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="card-top">
      <div class="card-name"><span class="tag"></span><span class="txt"></span></div>
      <button class="edit-btn" aria-label="Edit timer">✎</button>
    </div>
    <div class="time">00:00</div>
    <div class="state-label"></div>
    <div class="bar"><i></i></div>
    <div class="controls">
      <button class="btn btn-play">Start</button>
      <button class="btn btn-reset">Reset</button>
    </div>
    <div class="cardlog empty"></div>`;

  const refs = {
    card,
    name: card.querySelector(".txt"),
    tag: card.querySelector(".tag"),
    time: card.querySelector(".time"),
    stateLabel: card.querySelector(".state-label"),
    bar: card.querySelector(".bar > i"),
    play: card.querySelector(".btn-play"),
    reset: card.querySelector(".btn-reset"),
    edit: card.querySelector(".edit-btn"),
    log: card.querySelector(".cardlog"),
  };

  refs.play.addEventListener("click", () => toggle(id));
  refs.reset.addEventListener("click", () => resetTimer(id));
  refs.edit.addEventListener("click", () => openEditor(id));
  return refs;
}

function paintCard(id, t) {
  const e = els[id];
  e.card.style.setProperty("--c", t.color || "#5e7cff");
  e.name.textContent = t.name || "Timer";
  e.play.textContent = t.state === "running" ? "Pause" : "Start";
  e.play.classList.toggle("btn-pause", t.state === "running");
  renderCardLog(e.log, t);
}

// The little "who changed it" history under each part.
function renderCardLog(box, t) {
  const entries = (t.log || []).slice(0, 4);
  if (!supportsLog || entries.length === 0) { box.classList.add("empty"); box.innerHTML = ""; return; }
  box.classList.remove("empty");
  box.innerHTML = entries.map((ev, i) => `
    <div class="logrow${i === 0 ? " first" : ""}" style="--op:${opColor(ev.by)}">
      <span class="who">${escapeHtml(ev.by)}</span>
      <span class="act">${escapeHtml(ev.action)}</span>
      <span class="when">${fmtClock(ev.ts)}</span>
    </div>`).join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ──────────────────────────────────────────────────────────────
   Tick loop — updates digits, bar, alarm states locally only.
   ────────────────────────────────────────────────────────────── */
function tick() {
  for (const id of Object.keys(els)) {
    const t = timers[id];
    if (!t) continue;
    const e = els[id];
    const rem = remainingMs(t);
    const dur = t.duration || 1;
    const running = t.state === "running";
    // "done" can come from the server (state set when it counts the part) or
    // be detected locally the instant a running timer crosses zero.
    const done = t.state === "done" || (running && rem <= 0);

    e.time.textContent = fmt(rem);
    e.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, rem / dur))})`;
    e.card.classList.toggle("running", running && !done);
    e.card.classList.toggle("done", done);

    if (done) {
      e.stateLabel.textContent = "Time's up";
      if (!alarmed.has(id)) { alarmed.add(id); fireAlarm(); }
    } else {
      if (rem > 0) alarmed.delete(id);
      e.stateLabel.textContent =
        running ? "Running" : (t.state === "paused" ? "Paused" : "Ready");
    }
  }
}
setInterval(tick, 200);

/* ──────────────────────────────────────────────────────────────
   Alarm: beep + vibrate (local to each phone)
   ────────────────────────────────────────────────────────────── */
let audioCtx = null;
function fireAlarm() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;
    [0, 0.28, 0.56].forEach((off) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "square";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, now + off);
      g.gain.exponentialRampToValueAtTime(0.25, now + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + off + 0.22);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + off);
      o.stop(now + off + 0.24);
    });
  } catch { /* audio may be blocked until first tap */ }
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
}

/* ──────────────────────────────────────────────────────────────
   Timer actions → write through the backend (both phones receive)
   ────────────────────────────────────────────────────────────── */
function toggle(id) {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume(); // unlock audio on tap
  const t = timers[id];
  if (!t) return;
  if (t.state === "running") {
    be.update(room, id, { state: "paused", remaining: remainingMs(t), endAt: null }, { by: operator, action: "paused" });
  } else {
    let rem = remainingMs(t);
    if (rem <= 0) rem = t.duration || 0;          // restart a finished timer
    be.update(room, id, { state: "running", endAt: serverNow() + rem, remaining: null }, { by: operator, action: "started" });
  }
}

function resetTimer(id) {
  const t = timers[id];
  if (!t) return;
  alarmed.delete(id);
  be.update(room, id, { state: "idle", remaining: t.duration || 0, endAt: null }, { by: operator, action: "reset" });
}

/* ──────────────────────────────────────────────────────────────
   Editor modal (create / edit / delete)
   ────────────────────────────────────────────────────────────── */
const modal = document.getElementById("modal");
const fName = document.getElementById("fName");
const fH = document.getElementById("fH");
const fM = document.getElementById("fM");
const fS = document.getElementById("fS");
const swatches = document.getElementById("swatches");
const deleteBtn = document.getElementById("deleteBtn");
let editingId = null;
let chosenColor = PALETTE[0];

PALETTE.forEach((c) => {
  const sw = document.createElement("button");
  sw.className = "swatch";
  sw.style.setProperty("--sc", c);
  sw.dataset.color = c;
  sw.addEventListener("click", () => selectColor(c));
  swatches.appendChild(sw);
});

function selectColor(c) {
  chosenColor = c;
  [...swatches.children].forEach((s) => s.classList.toggle("sel", s.dataset.color === c));
}

function openEditor(id) {
  editingId = id;
  const t = id ? timers[id] : null;
  document.getElementById("modalTitle").textContent = id ? "Edit timer" : "New timer";
  deleteBtn.classList.toggle("hidden", !id);

  const dur = t ? t.duration : 5 * 60 * 1000;
  const total = Math.round(dur / 1000);
  fName.value = t ? (t.name || "") : "";
  fH.value = Math.floor(total / 3600) || "";
  fM.value = Math.floor((total % 3600) / 60) || "";
  fS.value = total % 60 || "";

  selectColor(t ? (t.color || PALETTE[0]) : PALETTE[Object.keys(timers).length % PALETTE.length]);
  modal.classList.remove("hidden");
  setTimeout(() => fName.focus(), 60);
}

function closeEditor() { modal.classList.add("hidden"); editingId = null; }

function readDuration() {
  const h = Math.min(99, parseInt(fH.value || "0", 10) || 0);
  const m = Math.min(59, parseInt(fM.value || "0", 10) || 0);
  const s = Math.min(59, parseInt(fS.value || "0", 10) || 0);
  return ((h * 3600) + (m * 60) + s) * 1000;
}

document.getElementById("saveBtn").addEventListener("click", () => {
  let duration = readDuration();
  if (duration <= 0) duration = 60 * 1000; // never save a 0-length timer
  const name = (fName.value || "").trim() || "Timer";

  if (editingId) {
    const t = timers[editingId];
    const patch = { name, color: chosenColor, duration };
    if (t.state !== "running") { patch.remaining = duration; patch.state = "idle"; }
    be.update(room, editingId, patch, { by: operator, action: "edited" });
    alarmed.delete(editingId);
  } else {
    be.create(room, {
      name, color: chosenColor, duration,
      state: "idle", remaining: duration, endAt: null,
    }, { by: operator, action: "created" });
  }
  closeEditor();
});

deleteBtn.addEventListener("click", () => {
  if (editingId && confirm("Delete this timer for both phones?")) {
    be.remove(room, editingId, { by: operator, action: "deleted" });
    closeEditor();
  }
});

document.getElementById("modalClose").addEventListener("click", closeEditor);
document.getElementById("addBtn").addEventListener("click", () => openEditor(null));
modal.addEventListener("click", (e) => { if (e.target === modal) closeEditor(); });

/* ──────────────────────────────────────────────────────────────
   Room modal
   ────────────────────────────────────────────────────────────── */
const roomModal = document.getElementById("roomModal");
const roomInput = document.getElementById("roomInput");

document.getElementById("roomBtn").addEventListener("click", () => {
  roomInput.value = room;
  roomModal.classList.remove("hidden");
  setTimeout(() => roomInput.focus(), 60);
});
document.getElementById("roomClose").addEventListener("click", () => roomModal.classList.add("hidden"));
roomModal.addEventListener("click", (e) => { if (e.target === roomModal) roomModal.classList.add("hidden"); });

document.getElementById("roomSave").addEventListener("click", () => {
  const next = sanitizeRoom(roomInput.value);
  roomModal.classList.add("hidden");
  if (next === room) return;
  room = next;
  localStorage.setItem("ft_room", room);
  document.getElementById("roomLabel").textContent = room;
  for (const id of Object.keys(els)) { els[id].card.remove(); delete els[id]; }
  alarmed.clear();
  timers = {};
  setCount(0);
  subscribe();
  if (Notification?.permission === "granted") subscribePush().catch(() => {});
});

/* ──────────────────────────────────────────────────────────────
   Operator picker
   ────────────────────────────────────────────────────────────── */
const opBtn = document.getElementById("opBtn");
const opModal = document.getElementById("opModal");
const opChoices = document.getElementById("opChoices");

function paintOperator() {
  document.getElementById("opLabel").textContent = operator;
  opBtn.style.setProperty("--op", opColor(operator));
}

if (supportsLog) {
  opBtn.classList.remove("hidden");
  paintOperator();
  OPERATORS.forEach((name) => {
    const b = document.createElement("button");
    b.className = "op-choice";
    b.style.setProperty("--oc", opColor(name));
    b.innerHTML = `<span class="swatch-dot"></span>${name}`;
    b.addEventListener("click", () => {
      operator = name;
      localStorage.setItem("dt_operator", name);
      paintOperator();
      opModal.classList.add("hidden");
    });
    opChoices.appendChild(b);
  });
  opBtn.addEventListener("click", () => {
    [...opChoices.children].forEach((c, i) => c.classList.toggle("sel", OPERATORS[i] === operator));
    opModal.classList.remove("hidden");
  });
  document.getElementById("opClose").addEventListener("click", () => opModal.classList.add("hidden"));
  opModal.addEventListener("click", (e) => { if (e.target === opModal) opModal.classList.add("hidden"); });
}

/* ──────────────────────────────────────────────────────────────
   Day log
   ────────────────────────────────────────────────────────────── */
const logModal = document.getElementById("logModal");
const logList = document.getElementById("logList");
const logSummary = document.getElementById("logSummary");
const logDateLabel = document.getElementById("logDateLabel");
const logPrev = document.getElementById("logPrev");
const logNext = document.getElementById("logNext");

const DAY = 86400000;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
let logDay = startOfDay(Date.now());
let logOpen = false;

const ACTION_CLASS = { finished: "finished", started: "started", deleted: "deleted" };

function dayLabel(ms) {
  const today = startOfDay(Date.now());
  if (ms === today) return "Today";
  if (ms === today - DAY) return "Yesterday";
  return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

async function loadDayLog() {
  if (!supportsLog) return;
  const since = logDay, until = logDay + DAY - 1;
  logDateLabel.textContent = dayLabel(logDay);
  logNext.disabled = logDay >= startOfDay(Date.now());
  let data;
  try { data = await be.log(room, since, until); } catch { logList.innerHTML = `<div class="logempty">Couldn't load the log.</div>`; return; }
  const evs = (data.events || []).slice().reverse(); // newest first

  // Summary: parts finished + actions per operator
  const stats = {};
  for (const name of OPERATORS) stats[name] = { finished: 0, actions: 0 };
  for (const ev of data.events || []) {
    if (!stats[ev.by]) stats[ev.by] = { finished: 0, actions: 0 };
    stats[ev.by].actions++;
    if (ev.action === "finished") stats[ev.by].finished++;
  }
  logSummary.innerHTML = OPERATORS.map((name) => `
    <div class="sumcard" style="--sc2:${opColor(name)}">
      <div class="sumname"><span class="d"></span>${escapeHtml(name)}</div>
      <div class="sumbig">${stats[name].finished}</div>
      <div class="sumsub">parts · ${stats[name].actions} actions</div>
    </div>`).join("");

  logList.innerHTML = evs.length
    ? evs.map((ev) => `
      <div class="logitem">
        <span class="lt">${fmtClock(ev.ts)}</span>
        <span class="lwho" style="color:${opColor(ev.by)}">${escapeHtml(ev.by)}</span>
        <span class="lpart">${escapeHtml(ev.timerName || "—")}</span>
        <span class="lact ${ACTION_CLASS[ev.action] || ""}">${escapeHtml(ev.action)}</span>
      </div>`).join("")
    : `<div class="logempty">Nothing logged for this day yet.</div>`;
}

function maybeRefreshLog() {
  if (logOpen && logDay === startOfDay(Date.now())) loadDayLog();
}

if (supportsLog) {
  document.getElementById("logBtn").addEventListener("click", () => {
    logDay = startOfDay(Date.now());
    logOpen = true;
    logModal.classList.remove("hidden");
    loadDayLog();
  });
  document.getElementById("logClose").addEventListener("click", () => { logOpen = false; logModal.classList.add("hidden"); });
  logModal.addEventListener("click", (e) => { if (e.target === logModal) { logOpen = false; logModal.classList.add("hidden"); } });
  logPrev.addEventListener("click", () => { logDay -= DAY; loadDayLog(); });
  logNext.addEventListener("click", () => { if (logDay < startOfDay(Date.now())) { logDay += DAY; loadDayLog(); } });
}

/* ──────────────────────────────────────────────────────────────
   Glowing "who made this part?" prompt at every timer end.
   The answer credits the part AND decides whose turn is next.
   ────────────────────────────────────────────────────────────── */
const finishModal = document.getElementById("finishModal");
const finishPart = document.getElementById("finishPart");
const finishOps = document.getElementById("finishOps");
let finishShownKey = null;            // which finish instance is on screen
const dismissed = new Set();          // finish instances skipped this session

const finishKey = (id, t) => `${id}:${t.lastAt || 0}`;

if (supportsLog) {
  OPERATORS.forEach((name) => {
    const b = document.createElement("button");
    b.className = "finish-op";
    b.style.setProperty("--oc", opColor(name));
    b.innerHTML = `<span class="dot"></span>${name}`;
    b.addEventListener("click", () => answerFinish(name));
    finishOps.appendChild(b);
  });
  document.getElementById("finishSkip").addEventListener("click", () => {
    if (finishShownKey) dismissed.add(finishShownKey);
    hideFinish();
  });
}

let finishForId = null;
function showFinishPrompt(id) {
  const t = timers[id];
  if (!t) return;
  finishForId = id;
  finishShownKey = finishKey(id, t);
  finishPart.textContent = t.name || "Timer";
  finishPart.style.color = t.color || "#fff";
  finishModal.classList.remove("hidden");
}
function hideFinish() { finishModal.classList.add("hidden"); finishForId = null; finishShownKey = null; checkPending(); }
function answerFinish(name) {
  if (finishForId) be.attribute(room, finishForId, { by: name });
  hideFinish();
}

// Show the prompt for any finished-but-unattributed timer (one at a time).
function checkPending() {
  if (!supportsLog || finishForId) return;
  const id = sortedIds().find((id) => {
    const t = timers[id];
    return t && t.state === "done" && t.needsAttrib && !dismissed.has(finishKey(id, t));
  });
  if (id) showFinishPrompt(id);
}

/* ──────────────────────────────────────────────────────────────
   Push notifications — ring even when the app is closed.
   Only available when served by our server (local mode) over HTTPS.
   ────────────────────────────────────────────────────────────── */
const bellBtn = document.getElementById("bellBtn");
let vapidKey = null;

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function updateBell() {
  if (!vapidKey) { bellBtn.classList.add("hidden"); return; }
  bellBtn.classList.remove("hidden");
  const on = "Notification" in window && Notification.permission === "granted";
  bellBtn.textContent = on ? "🔔" : "🔕";
  bellBtn.classList.toggle("on", on);
  bellBtn.title = on
    ? "Background alerts are on — tap to re-check"
    : "Turn on alerts so timers ring even when the app is closed";
}

async function subscribePush() {
  if (!vapidKey || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(vapidKey),
    });
  }
  await fetch("/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, sub }),
  });
}

async function enableNotifications() {
  if (!("Notification" in window)) { alert("This browser can't show notifications."); return; }
  if (Notification.permission === "denied") {
    alert("Notifications are blocked. Enable them for this site in your phone's settings, then tap the bell again.");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    try { await subscribePush(); } catch (e) { console.warn("push subscribe failed", e); }
  }
  updateBell();
}

bellBtn.addEventListener("click", enableNotifications);

async function setupPush() {
  if (be.mode !== "local") return;            // no server to push from
  try {
    const r = await fetch("/vapidPublicKey");
    if (r.ok) { const k = (await r.text()).trim(); if (k) vapidKey = k; }
  } catch { /* push unavailable */ }
  updateBell();
  // If already granted on a previous visit, refresh the subscription silently
  // (also re-points it at the current room).
  if (vapidKey && "Notification" in window && Notification.permission === "granted") {
    subscribePush().catch(() => {});
  }
}

/* ──────────────────────────────────────────────────────────────
   Go
   ────────────────────────────────────────────────────────────── */
subscribe();
setupPush();
