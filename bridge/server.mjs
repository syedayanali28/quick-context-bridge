// Quick Context Bridge — local relay between an agent (CLI) and the browser extension.
//
//   agent/CLI ──POST /cmd──▶ server ◀──long-poll GET /ext/poll── extension Bridge page ──▶ Quick tab (page hook)
//                             ▲                                     │
//                             └────────── POST /ext/result ◀────────┘
//
// - Binds to 127.0.0.1 only. Every request must carry the pairing token (header x-qcb-token).
// - Extension endpoints additionally require a chrome-extension:// Origin, so a web page can't pose as the
//   extension even if it guessed the port.
// - No dependencies; runs on Node 18+ (or VS Code's Electron in Node mode).

import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 8765;
const HERE = dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = process.env.QCB_STATE_DIR || join(HERE, '.state');

export function loadOrCreateToken(stateDir = STATE_DIR) {
  mkdirSync(stateDir, { recursive: true });
  const f = join(stateDir, 'token');
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(t)) return t;
  }
  const t = randomBytes(24).toString('hex');
  writeFileSync(f, `${t}\n`, { mode: 0o600 });
  return t;
}

function tokenOk(req, token) {
  const got = String(req.headers['x-qcb-token'] || '');
  if (got.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj, extra = {}) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(body);
}

/**
 * @param {{port?:number, token:string, pollTimeoutMs?:number, log?:(m:string)=>void}} opts
 */
export function createBridgeServer(opts) {
  const token = opts.token;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 25_000;
  const log = opts.log || (() => {});
  const queue = []; // pending commands not yet picked up
  const inflight = new Map(); // id -> {resolve, timer, cmd}
  const waiters = []; // extension polls waiting for a command
  let ext = { connected: false, lastSeen: 0, info: null };

  function dispatch() {
    while (queue.length && waiters.length) {
      const w = waiters.shift();
      const c = queue.shift();
      clearTimeout(w.timer);
      send(w.res, 200, { id: c.id, cmd: c.cmd, args: c.args }, w.cors);
      log(`→ ext ${c.cmd} ${c.id.slice(0, 8)}`);
    }
  }

  function corsFor(req) {
    const origin = String(req.headers.origin || '');
    return origin.startsWith('chrome-extension://')
      ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'x-qcb-token, content-type', 'access-control-allow-methods': 'GET, POST' }
      : {};
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cors = corsFor(req);
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      if (!tokenOk(req, token)) { send(res, 401, { error: 'bad token' }, cors); return; }

      // ---------------- extension side ----------------
      if (url.pathname.startsWith('/ext/')) {
        if (!String(req.headers.origin || '').startsWith('chrome-extension://')) { send(res, 403, { error: 'extension origin required' }); return; }
        ext = { ...ext, connected: true, lastSeen: Date.now() };
        if (url.pathname === '/ext/hello' && req.method === 'POST') {
          ext.info = await readBody(req);
          send(res, 200, { ok: true }, cors);
          return;
        }
        if (url.pathname === '/ext/poll' && req.method === 'GET') {
          const w = { res, cors, timer: null };
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            res.writeHead(204, cors);
            res.end();
          }, pollTimeoutMs);
          req.on('close', () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); clearTimeout(w.timer); } });
          waiters.push(w);
          dispatch();
          return;
        }
        if (url.pathname === '/ext/result' && req.method === 'POST') {
          const r = await readBody(req);
          const p = inflight.get(r.id);
          if (p) {
            inflight.delete(r.id);
            clearTimeout(p.timer);
            p.resolve(r);
            log(`← ext ${p.cmd} ${String(r.id).slice(0, 8)} ${r.ok ? 'ok' : 'error'}`);
          }
          send(res, 200, { ok: true }, cors);
          return;
        }
        send(res, 404, { error: 'not found' }, cors);
        return;
      }

      // ---------------- agent / CLI side ----------------
      if (url.pathname === '/status' && req.method === 'GET') {
        const ageMs = ext.lastSeen ? Date.now() - ext.lastSeen : null;
        send(res, 200, { extensionConnected: ext.connected && ageMs !== null && ageMs < pollTimeoutMs + 10_000, lastSeenMsAgo: ageMs, extension: ext.info, queued: queue.length, inflight: inflight.size });
        return;
      }
      if (url.pathname === '/cmd' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.cmd) { send(res, 400, { error: 'cmd required' }); return; }
        const id = randomUUID();
        const timeoutMs = Math.min(Number(body.timeoutMs) || 120_000, 30 * 60_000);
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            inflight.delete(id);
            const qi = queue.findIndex((c) => c.id === id);
            if (qi >= 0) queue.splice(qi, 1);
            resolve({ id, ok: false, error: `Timed out after ${timeoutMs} ms. Is the extension's Bridge tab open and connected?` });
          }, timeoutMs);
          inflight.set(id, { resolve, timer, cmd: body.cmd });
          queue.push({ id, cmd: body.cmd, args: body.args || {} });
          dispatch();
        });
        send(res, 200, result);
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e && e.message || e) }, cors);
    }
  });

  return {
    server,
    listen(port = opts.port ?? DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      for (const w of waiters) { clearTimeout(w.timer); try { w.res.end(); } catch { /* ignore */ } }
      for (const p of inflight.values()) clearTimeout(p.timer);
      return new Promise((r) => server.close(() => r()));
    },
  };
}

// CLI entry: node bridge/server.mjs [--port N]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.QCB_PORT) || DEFAULT_PORT;
  const token = loadOrCreateToken();
  const b = createBridgeServer({ token, log: (m) => console.log(new Date().toISOString().slice(11, 19), m) });
  b.listen(port).then((p) => {
    console.log(`Quick Context Bridge server listening on http://127.0.0.1:${p}`);
    console.log(`Pairing token is in ${join(STATE_DIR, 'token')}`);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
