// ─────────────────────────────────────────────────────────────────────────
//  Factory Timers — server.
//  Zero-config locally; uses Postgres when deployed.
//
//  Run locally:   node server.js          (saves to .timers-data.json)
//  On Render:     DATABASE_URL is set  →   saves to Neon Postgres
//
//  Either way it serves the page and syncs timers between phones in real time
//  using Server-Sent Events.
// ─────────────────────────────────────────────────────────────────────────

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, ".timers-data.json");

// In-memory state (the live copy SSE broadcasts from): { room: { id: data } }
let state = {};

/* ──────────────────────────────────────────────────────────────
   Storage: Postgres when DATABASE_URL is set, else a JSON file.
   Both expose: init(), load(), upsert(room,id,data), remove(room,id)
   ────────────────────────────────────────────────────────────── */
function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon/Render require SSL
    });
    return {
      kind: "postgres",
      async init() {
        await pool.query(`CREATE TABLE IF NOT EXISTS timers (
          room text NOT NULL,
          id   text NOT NULL,
          data jsonb NOT NULL,
          PRIMARY KEY (room, id)
        )`);
      },
      async load() {
        const { rows } = await pool.query("SELECT room, id, data FROM timers");
        const s = {};
        for (const r of rows) { (s[r.room] ||= {})[r.id] = r.data; }
        return s;
      },
      async upsert(room, id, data) {
        await pool.query(
          `INSERT INTO timers (room, id, data) VALUES ($1, $2, $3)
           ON CONFLICT (room, id) DO UPDATE SET data = EXCLUDED.data`,
          [room, id, data]
        );
      },
      async remove(room, id) {
        await pool.query("DELETE FROM timers WHERE room = $1 AND id = $2", [room, id]);
      },
    };
  }

  // Local fallback: persist the whole state to one JSON file.
  const saveAll = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch {} };
  return {
    kind: "file",
    async init() {},
    async load() {
      try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) || {}; } catch { return {}; }
    },
    async upsert() { saveAll(); },
    async remove() { saveAll(); },
  };
}

const store = makeStore();

// SSE clients per room:  roomName -> Set<res>
const clients = new Map();

function roomTimers(room) {
  if (!state[room]) state[room] = {};
  return state[room];
}

function broadcast(room) {
  const set = clients.get(room);
  if (!set) return;
  const payload = `data: ${JSON.stringify({ type: "state", timers: roomTimers(room), serverTime: Date.now() })}\n\n`;
  for (const res of set) res.write(payload);
}

// Heartbeat: keeps SSE connections alive and re-syncs each phone's clock.
setInterval(() => {
  const ping = `data: ${JSON.stringify({ type: "ping", serverTime: Date.now() })}\n\n`;
  for (const set of clients.values()) for (const res of set) res.write(ping);
}, 15000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health probe — the client uses this to detect the server.
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // SSE stream for a room.
  if (url.pathname === "/events") {
    const room = url.searchParams.get("room") || "factory";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("retry: 2000\n\n");
    if (!clients.has(room)) clients.set(room, new Set());
    clients.get(room).add(res);
    res.write(`data: ${JSON.stringify({ type: "state", timers: roomTimers(room), serverTime: Date.now() })}\n\n`);
    req.on("close", () => { const s = clients.get(room); if (s) s.delete(res); });
    return;
  }

  // Mutations: POST /api/<room>  with JSON body {op, id?, data?, patch?}
  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    const room = decodeURIComponent(url.pathname.slice(5)) || "factory";
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      let msg;
      try { msg = JSON.parse(body || "{}"); } catch { res.writeHead(400).end("bad json"); return; }
      const timers = roomTimers(room);
      try {
        if (msg.op === "create") {
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          const data = Object.assign({ createdAt: Date.now() }, msg.data || {});
          timers[id] = data;
          await store.upsert(room, id, data);
        } else if (msg.op === "update" && msg.id) {
          const data = Object.assign({}, timers[msg.id], msg.patch || {});
          timers[msg.id] = data;
          await store.upsert(room, msg.id, data);
        } else if (msg.op === "remove" && msg.id) {
          delete timers[msg.id];
          await store.remove(room, msg.id);
        } else {
          res.writeHead(400).end("bad op"); return;
        }
      } catch (e) {
        console.error("storage error:", e.message);
        res.writeHead(500).end("storage error"); return;
      }
      broadcast(room);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{\"ok\":true}");
    });
    return;
  }

  serveStatic(req, res);
});

/* ──────────────────────────────────────────────────────────────
   Start
   ────────────────────────────────────────────────────────────── */
(async () => {
  await store.init();
  state = await store.load();

  server.listen(PORT, () => {
    console.log(`\n  ⏱  Factory Timers — running on port ${PORT}  (storage: ${store.kind})\n`);
    if (store.kind === "file") {
      const nets = os.networkInterfaces();
      const ips = [];
      for (const name of Object.keys(nets)) {
        for (const n of nets[name] || []) {
          if (n.family === "IPv4" && !n.internal) ips.push(n.address);
        }
      }
      console.log(`     On this Mac:   http://localhost:${PORT}`);
      if (ips.length) {
        console.log("\n     On the phones (same WiFi), open:");
        for (const ip of ips) console.log(`        →  http://${ip}:${PORT}`);
      }
      console.log("\n     Stop the server with  Ctrl+C\n");
    }
  });
})().catch((e) => { console.error("Failed to start:", e); process.exit(1); });
