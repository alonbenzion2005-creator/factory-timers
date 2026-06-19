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
  unsubscribe = be.subscribe(room, (data) => { timers = data || {}; render(); });
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
    </div>`;

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
    const done = running && rem <= 0;

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
    be.update(room, id, { state: "paused", remaining: remainingMs(t), endAt: null });
  } else {
    let rem = remainingMs(t);
    if (rem <= 0) rem = t.duration || 0;          // restart a finished timer
    be.update(room, id, { state: "running", endAt: serverNow() + rem, remaining: null });
  }
}

function resetTimer(id) {
  const t = timers[id];
  if (!t) return;
  alarmed.delete(id);
  be.update(room, id, { state: "idle", remaining: t.duration || 0, endAt: null });
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
    be.update(room, editingId, patch);
    alarmed.delete(editingId);
  } else {
    be.create(room, {
      name, color: chosenColor, duration,
      state: "idle", remaining: duration, endAt: null,
    });
  }
  closeEditor();
});

deleteBtn.addEventListener("click", () => {
  if (editingId && confirm("Delete this timer for both phones?")) {
    be.remove(room, editingId);
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
  subscribe();
});

/* ──────────────────────────────────────────────────────────────
   Go
   ────────────────────────────────────────────────────────────── */
subscribe();
