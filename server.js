// ─────────────────────────────────────────────────────────────────────────
//  Dudi Timer — server.
//  Zero-config locally; uses Postgres when deployed.
//
//  Run locally:   node server.js          (saves to .timers-data.json)
//  On Render:     DATABASE_URL is set  →   saves to Neon Postgres
//
//  Responsibilities:
//   • serve the page
//   • sync timers between phones in real time (Server-Sent Events)
//   • detect when a timer hits zero → bump the "parts made" counter
//     and send a push notification (rings even when the app is closed)
// ─────────────────────────────────────────────────────────────────────────

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, ".timers-data.json");

// Web Push is optional — if the package isn't installed (e.g. local dev with no
// `npm install`), the app still works; only background alerts are disabled.
let webpush = null;
try { webpush = require("web-push"); } catch { /* push disabled */ }
let pushEnabled = false;

// In-memory state (the live copy SSE broadcasts from)
let timers = {};    // { room: { id: data } }
let counters = {};  // { room: number }
let subs = {};      // { endpoint: { room, sub } }
let meta = {};      // { vapid: { publicKey, privateKey } }

/* ──────────────────────────────────────────────────────────────
   Storage: Postgres when DATABASE_URL is set, else a JSON file.
   ────────────────────────────────────────────────────────────── */
function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    return {
      kind: "postgres",
      async init() {
        await pool.query(`CREATE TABLE IF NOT EXISTS timers (room text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (room, id))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS counters (room text PRIMARY KEY, count bigint NOT NULL DEFAULT 0)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (endpoint text PRIMARY KEY, room text NOT NULL, sub jsonb NOT NULL)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS meta (k text PRIMARY KEY, v jsonb NOT NULL)`);
      },
      async loadAll() {
        const t = {}, c = {}, s = {}, m = {};
        for (const r of (await pool.query("SELECT room, id, data FROM timers")).rows) (t[r.room] ||= {})[r.id] = r.data;
        for (const r of (await pool.query("SELECT room, count FROM counters")).rows) c[r.room] = Number(r.count);
        for (const r of (await pool.query("SELECT endpoint, room, sub FROM subscriptions")).rows) s[r.endpoint] = { room: r.room, sub: r.sub };
        for (const r of (await pool.query("SELECT k, v FROM meta")).rows) m[r.k] = r.v;
        return { timers: t, counters: c, subs: s, meta: m };
      },
      async saveTimer(room, id, data) {
        await pool.query(`INSERT INTO timers (room, id, data) VALUES ($1,$2,$3) ON CONFLICT (room,id) DO UPDATE SET data=EXCLUDED.data`, [room, id, data]);
      },
      async removeTimer(room, id) { await pool.query("DELETE FROM timers WHERE room=$1 AND id=$2", [room, id]); },
      async setCounter(room, n) {
        await pool.query(`INSERT INTO counters (room, count) VALUES ($1,$2) ON CONFLICT (room) DO UPDATE SET count=EXCLUDED.count`, [room, n]);
      },
      async saveMeta(k, v) {
        await pool.query(`INSERT INTO meta (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [k, v]);
      },
      async addSub(endpoint, room, sub) {
        await pool.query(`INSERT INTO subscriptions (endpoint, room, sub) VALUES ($1,$2,$3) ON CONFLICT (endpoint) DO UPDATE SET room=EXCLUDED.room, sub=EXCLUDED.sub`, [endpoint, room, sub]);
      },
      async removeSub(endpoint) { await pool.query("DELETE FROM subscriptions WHERE endpoint=$1", [endpoint]); },
    };
  }

  // Local fallback: persist everything to one JSON file.
  const persist = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify({ timers, counters, subs, meta })); } catch {} };
  return {
    kind: "file",
    async init() {},
    async loadAll() {
      try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        if (raw && (raw.timers || raw.counters || raw.subs || raw.meta)) {
          return { timers: raw.timers || {}, counters: raw.counters || {}, subs: raw.subs || {}, meta: raw.meta || {} };
        }
        return { timers: raw || {}, counters: {}, subs: {}, meta: {} }; // migrate old format
      } catch { return { timers: {}, counters: {}, subs: {}, meta: {} }; }
    },
    async saveTimer() { persist(); },
    async removeTimer() { persist(); },
    async setCounter() { persist(); },
    async saveMeta() { persist(); },
    async addSub() { persist(); },
    async removeSub() { persist(); },
  };
}

const store = makeStore();

/* ──────────────────────────────────────────────────────────────
   SSE
   ────────────────────────────────────────────────────────────── */
const clients = new Map(); // room -> Set<res>

function roomTimers(room) { if (!timers[room]) timers[room] = {}; return timers[room]; }

function statePayload(room) {
  return `data: ${JSON.stringify({ type: "state", timers: roomTimers(room), count: counters[room] || 0, serverTime: Date.now() })}\n\n`;
}

function broadcast(room) {
  const set = clients.get(room);
  if (!set) return;
  const payload = statePayload(room);
  for (const res of set) res.write(payload);
}

setInterval(() => {
  const ping = `data: ${JSON.stringify({ type: "ping", serverTime: Date.now() })}\n\n`;
  for (const set of clients.values()) for (const res of set) res.write(ping);
}, 15000);

/* ──────────────────────────────────────────────────────────────
   Timer-end detection → counter + push (the heart of the new feature)
   ────────────────────────────────────────────────────────────── */
async function sendPush(room, name) {
  if (!pushEnabled) return;
  const count = counters[room] || 0;
  const payload = JSON.stringify({
    title: "Dudi Timer",
    body: `⏰ ${name || "Timer"} finished — parts made: ${count}`,
  });
  for (const [endpoint, entry] of Object.entries(subs)) {
    if (entry.room !== room) continue;
    try {
      await webpush.sendNotification(entry.sub, payload);
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        delete subs[endpoint];
        store.removeSub(endpoint).catch(() => {});
      }
    }
  }
}

async function scanEnds() {
  const now = Date.now();
  for (const room of Object.keys(timers)) {
    for (const id of Object.keys(timers[room])) {
      const t = timers[room][id];
      if (t.state === "running" && t.endAt && t.endAt <= now) {
        t.state = "done"; t.remaining = 0; t.endAt = null;
        counters[room] = (counters[room] || 0) + 1;
        try { await store.saveTimer(room, id, t); await store.setCounter(room, counters[room]); } catch (e) { console.error("persist end:", e.message); }
        broadcast(room);
        sendPush(room, t.name);
      }
    }
  }
}
setInterval(() => { scanEnds().catch((e) => console.error("scan:", e.message)); }, 1000);

/* ──────────────────────────────────────────────────────────────
   Static files
   ────────────────────────────────────────────────────────────── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("bad json")); } });
  });
}

/* ──────────────────────────────────────────────────────────────
   HTTP
   ────────────────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); return; }

  if (url.pathname === "/vapidPublicKey") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(pushEnabled && meta.vapid ? meta.vapid.publicKey : "");
    return;
  }

  if (url.pathname === "/subscribe" && req.method === "POST") {
    try {
      const msg = await readBody(req);
      if (!msg.sub || !msg.sub.endpoint) { res.writeHead(400).end("no sub"); return; }
      const room = (msg.room || "factory");
      subs[msg.sub.endpoint] = { room, sub: msg.sub };
      await store.addSub(msg.sub.endpoint, room, msg.sub);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end("{\"ok\":true}");
    } catch { res.writeHead(400).end("bad request"); }
    return;
  }

  // Diagnostics
  if (url.pathname === "/debug/subs") {
    const byRoom = {};
    for (const { room } of Object.values(subs)) byRoom[room] = (byRoom[room] || 0) + 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pushEnabled, total: Object.keys(subs).length, byRoom }));
    return;
  }
  if (url.pathname === "/debug/test-push" && req.method === "POST") {
    let msg = {}; try { msg = await readBody(req); } catch {}
    const room = msg.room || "factory";
    await sendPush(room, "Test alert ✅");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sent: Object.values(subs).filter((s) => s.room === room).length }));
    return;
  }

  if (url.pathname === "/events") {
    const room = url.searchParams.get("room") || "factory";
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write("retry: 2000\n\n");
    if (!clients.has(room)) clients.set(room, new Set());
    clients.get(room).add(res);
    res.write(statePayload(room));
    req.on("close", () => { const s = clients.get(room); if (s) s.delete(res); });
    return;
  }

  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    const room = decodeURIComponent(url.pathname.slice(5)) || "factory";
    let msg;
    try { msg = await readBody(req); } catch { res.writeHead(400).end("bad json"); return; }
    const rt = roomTimers(room);
    try {
      if (msg.op === "create") {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const data = Object.assign({ createdAt: Date.now() }, msg.data || {});
        rt[id] = data;
        await store.saveTimer(room, id, data);
      } else if (msg.op === "update" && msg.id) {
        const data = Object.assign({}, rt[msg.id], msg.patch || {});
        rt[msg.id] = data;
        await store.saveTimer(room, msg.id, data);
      } else if (msg.op === "remove" && msg.id) {
        delete rt[msg.id];
        await store.removeTimer(room, msg.id);
      } else if (msg.op === "resetCount") {
        counters[room] = 0;
        await store.setCounter(room, 0);
      } else {
        res.writeHead(400).end("bad op"); return;
      }
    } catch (e) {
      console.error("storage error:", e.message);
      res.writeHead(500).end("storage error"); return;
    }
    broadcast(room);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{\"ok\":true}");
    return;
  }

  serveStatic(req, res);
});

/* ──────────────────────────────────────────────────────────────
   Start
   ────────────────────────────────────────────────────────────── */
(async () => {
  await store.init();
  const loaded = await store.loadAll();
  timers = loaded.timers; counters = loaded.counters; subs = loaded.subs; meta = loaded.meta;

  if (webpush) {
    if (!meta.vapid || !meta.vapid.publicKey) {
      meta.vapid = webpush.generateVAPIDKeys();
      try { await store.saveMeta("vapid", meta.vapid); } catch (e) { console.error("vapid save:", e.message); }
    }
    webpush.setVapidDetails("mailto:alonbenzion2005@gmail.com", meta.vapid.publicKey, meta.vapid.privateKey);
    pushEnabled = true;
  }

  server.listen(PORT, () => {
    console.log(`\n  ⏱  Dudi Timer — running on port ${PORT}  (storage: ${store.kind}, push: ${pushEnabled ? "on" : "off"})\n`);
    if (store.kind === "file") {
      const nets = os.networkInterfaces();
      const ips = [];
      for (const name of Object.keys(nets)) for (const n of nets[name] || []) if (n.family === "IPv4" && !n.internal) ips.push(n.address);
      console.log(`     On this Mac:   http://localhost:${PORT}`);
      if (ips.length) { console.log("\n     On the phones (same WiFi), open:"); for (const ip of ips) console.log(`        →  http://${ip}:${PORT}`); }
      console.log("\n     Stop the server with  Ctrl+C\n");
    }
  });
})().catch((e) => { console.error("Failed to start:", e); process.exit(1); });
