// ─────────────────────────────────────────────────────────────────────────
//  Backend abstraction.
//
//  Both backends expose the SAME interface so app.js doesn't care which one
//  is in use:
//     serverNow()                 -> epoch ms in *server* time (clock-synced)
//     onStatus(cb)                -> cb(isOnline)
//     subscribe(room, cb)         -> cb(timersObject); returns unsubscribe fn
//     create(room, data)          -> add a timer (id + createdAt added for you)
//     update(room, id, patch)     -> patch a timer
//     remove(room, id)            -> delete a timer
//
//  createBackend() picks LOCAL (the node server.js over WiFi) when present,
//  otherwise falls back to FIREBASE (internet) if config.js is filled in.
//  Returns null if neither is available (→ app.js shows the setup screen).
// ─────────────────────────────────────────────────────────────────────────

export async function createBackend() {
  // Probe for the local server.
  try {
    const r = await fetch("/health", { cache: "no-store" });
    if (r.ok && (await r.text()) === "ok") return makeLocal();
  } catch { /* not running locally — try Firebase */ }

  try {
    const { firebaseConfig } = await import("./config.js");
    if (!JSON.stringify(firebaseConfig).includes("PASTE_")) return await makeFirebase(firebaseConfig);
  } catch { /* config missing/invalid */ }

  return null;
}

/* ───────────────────────── LOCAL (WiFi) ───────────────────────── */
function makeLocal() {
  let offset = 0;
  let online = false;
  const statusCbs = [];
  const setOnline = (v) => { online = v; statusCbs.forEach((cb) => cb(v)); };

  const post = (room, body) =>
    fetch(`/api/${encodeURIComponent(room)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    mode: "local",
    serverNow: () => Date.now() + offset,
    onStatus(cb) { statusCbs.push(cb); cb(online); },
    subscribe(room, cb) {
      const es = new EventSource(`/events?room=${encodeURIComponent(room)}`);
      es.onopen = () => setOnline(true);
      es.onerror = () => setOnline(false); // EventSource auto-reconnects
      es.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (typeof msg.serverTime === "number") {
          offset = msg.serverTime - Date.now();
          setOnline(true);
        }
        if (msg.type === "state") cb(msg.timers || {}, { count: msg.count || 0, turn: msg.turn || null });
      };
      return () => es.close();
    },
    create(room, data, meta) { return post(room, { op: "create", data, by: meta?.by, action: meta?.action }); },
    update(room, id, patch, meta) { return post(room, { op: "update", id, patch, by: meta?.by, action: meta?.action }); },
    remove(room, id, meta) { return post(room, { op: "remove", id, by: meta?.by, action: meta?.action }); },
    resetCount(room, meta) { return post(room, { op: "resetCount", by: meta?.by }); },
    attribute(room, id, meta) { return post(room, { op: "attribute", id, by: meta?.by }); },
    log(room, since, until) {
      return fetch(`/log?room=${encodeURIComponent(room)}&since=${since}&until=${until}`).then((r) => r.json());
    },
  };
}

/* ───────────────────────── FIREBASE (internet) ───────────────────────── */
async function makeFirebase(firebaseConfig) {
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const {
    getDatabase, ref, onValue, set, update, remove, push, serverTimestamp,
  } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js");

  const app = initializeApp(firebaseConfig);
  const db = getDatabase(app);
  let offset = 0;
  onValue(ref(db, ".info/serverTimeOffset"), (s) => { offset = s.val() || 0; });

  return {
    mode: "firebase",
    serverNow: () => Date.now() + offset,
    onStatus(cb) { onValue(ref(db, ".info/connected"), (s) => cb(s.val() === true)); },
    subscribe(room, cb) {
      return onValue(ref(db, `rooms/${room}/timers`), (s) => cb(s.val() || {}));
    },
    create(room, data) {
      const node = push(ref(db, `rooms/${room}/timers`));
      return set(node, Object.assign({ createdAt: serverTimestamp() }, data));
    },
    update(room, id, patch) { return update(ref(db, `rooms/${room}/timers/${id}`), patch); },
    remove(room, id) { return remove(ref(db, `rooms/${room}/timers/${id}`)); },
  };
}
