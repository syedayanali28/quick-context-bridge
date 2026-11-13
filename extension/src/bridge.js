// Extension side of the agent bridge: long-polls the local server and relays commands to a Quick tab's page hook.
import { parseAutomationUrl } from './lib/ids.js';

const $ = (id) => document.getElementById(id);
let running = false;
let abort = null;

function log(msg, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  $('log').prepend(li);
  while ($('log').children.length > 300) $('log').lastChild.remove();
}

function setState(text, cls) {
  $('state').textContent = text;
  $('state').className = `chip ${cls || ''}`;
}

// ------------------------------------------------------------------ page functions (MAIN world, self-contained)

function pageProbe() {
  const b = window.__quickContextBridge;
  const name = ((document.querySelector('[data-automation-id="editor-project-name-link"]') || {}).textContent
    || (document.querySelector('h1') || {}).textContent || '').trim();
  return { hookVersion: b ? b.version : null, auth: !!(b && b.hasAuth()), name };
}

async function pageCall(kind, path, opts) {
  const b = window.__quickContextBridge;
  if (!b) return { fatal: 'NO_HOOK' };
  if (!b.hasAuth()) return { fatal: 'NO_AUTH' };
  if (kind === 'write' && typeof b.write !== 'function') return { fatal: 'OLD_HOOK' };
  try {
    if (kind === 'read') return { ok: true, status: 200, body: await b.request(path, opts || {}) };
    return await b.write(path, opts || {});
  } catch (e) {
    return { ok: false, status: e && e.status || 0, body: { message: String(e && e.message || e) } };
  }
}

// ------------------------------------------------------------------ commands

async function quickTabs() {
  const ts = await chrome.tabs.query({ url: 'https://*.quicksight.aws.amazon.com/*' });
  const out = [];
  for (const t of ts) {
    let probe = { hookVersion: null, auth: false, name: '' };
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: pageProbe });
      probe = r.result || probe;
    } catch { /* tab not scriptable */ }
    out.push({ tabId: t.id, title: t.title, url: t.url, ids: parseAutomationUrl(t.url || ''), ...probe });
  }
  return out;
}

async function pickTab(tabId) {
  if (tabId) return tabId;
  const ts = await quickTabs();
  const good = ts.filter((t) => t.auth && t.hookVersion >= 2).sort((a, b) => Number(b.hookVersion) - Number(a.hookVersion));
  if (good.length) return good[0].tabId;
  if (ts.some((t) => t.hookVersion === 1 || (t.hookVersion && !t.auth))) {
    throw new Error('Quick tab found but not ready: reload it (F5), then click any tab in Quick (e.g. Versions) once.');
  }
  throw new Error('No Quick tab open. Open any automation page in Amazon Quick and log in.');
}

async function handle(cmd, args) {
  if (cmd === 'ping') return { pong: true, version: chrome.runtime.getManifest().version };
  if (cmd === 'tabs') return quickTabs();
  if (cmd === 'call') {
    const tabId = await pickTab(args.tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: pageCall,
      args: [args.kind, args.path, { method: args.method, body: args.body }],
    });
    const res = r && r.result;
    if (!res) throw new Error('No response from the Quick tab');
    if (res.fatal) {
      throw new Error({
        NO_HOOK: 'Quick tab has no page hook: reload it (F5).',
        OLD_HOOK: 'Quick tab runs an older extension version: reload it (F5).',
        NO_AUTH: 'Quick session not detected yet: click any tab in Quick (e.g. Versions) once.',
      }[res.fatal] || res.fatal);
    }
    return res;
  }
  throw new Error(`Unknown command ${cmd}`);
}

// ------------------------------------------------------------------ connection loop

async function loop() {
  const port = Number($('port').value) || 8765;
  const token = $('token').value.trim();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-qcb-token': token, 'content-type': 'application/json' };
  let failures = 0;
  try {
    const hello = await fetch(`${base}/ext/hello`, { method: 'POST', headers, body: JSON.stringify({ version: chrome.runtime.getManifest().version }) });
    if (hello.status === 401) throw new Error('Wrong pairing token');
    if (!hello.ok) throw new Error(`Server answered HTTP ${hello.status}`);
  } catch (e) {
    setState('disconnected', 'err');
    log(`Cannot reach the bridge server at ${base}: ${e.message}`, 'err');
    stop();
    return;
  }
  setState('connected', 'ok');
  log(`Connected to ${base}`, 'ok');
  while (running) {
    try {
      abort = new AbortController();
      const r = await fetch(`${base}/ext/poll`, { headers, signal: abort.signal });
      if (r.status === 204) { failures = 0; continue; }
      if (r.status === 401) throw new Error('Wrong pairing token');
      if (!r.ok) throw new Error(`poll HTTP ${r.status}`);
      failures = 0;
      setState('connected', 'ok');
      const { id, cmd, args } = await r.json();
      const label = cmd === 'call' ? `${args.kind} ${args.method} ${args.path}` : cmd;
      let result;
      try {
        result = { id, ok: true, result: await handle(cmd, args) };
        log(`${label}${cmd === 'call' ? ` → ${result.result.status}` : ''}`, cmd === 'call' && args.kind === 'write' ? 'warn' : '');
      } catch (e) {
        result = { id, ok: false, error: e.message };
        log(`${label} → ${e.message}`, 'err');
      }
      await fetch(`${base}/ext/result`, { method: 'POST', headers, body: JSON.stringify(result) });
    } catch (e) {
      if (!running) break;
      failures++;
      setState('reconnecting…', 'warn');
      if (failures === 1 || failures % 10 === 0) log(`Bridge unreachable (${e.message}), retrying…`, 'err');
      await new Promise((res) => setTimeout(res, Math.min(10_000, 1000 * failures)));
    }
  }
}

// chrome.storage needs the "storage" permission; fall back to localStorage if the extension wasn't reloaded.
const store = {
  async get(keys) {
    if (chrome.storage && chrome.storage.local) return chrome.storage.local.get(keys);
    const o = {};
    for (const k of keys) { try { const v = localStorage.getItem(k); if (v !== null) o[k] = JSON.parse(v); } catch { /* ignore */ } }
    return o;
  },
  async set(obj) {
    if (chrome.storage && chrome.storage.local) return chrome.storage.local.set(obj);
    for (const [k, v] of Object.entries(obj)) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
  },
};

function start() {
  if (running) return;
  const token = $('token').value.trim();
  if (!/^[0-9a-f]{48}$/.test(token)) {
    log(token ? 'That is not a pairing token (expected 48 hex characters). Copy it from bridge/.state/token.' : 'Paste the pairing token first.', 'err');
    $('token').focus();
    return;
  }
  $('token').value = token;
  running = true;
  $('btnConnect').disabled = true;
  $('btnDisconnect').disabled = false;
  store.set({ bridgePort: $('port').value, bridgeToken: token, bridgeAuto: true });
  loop();
}

function stop() {
  running = false;
  if (abort) abort.abort();
  $('btnConnect').disabled = false;
  $('btnDisconnect').disabled = true;
  setState('disconnected');
}

$('btnConnect').addEventListener('click', start);
$('btnDisconnect').addEventListener('click', () => { store.set({ bridgeAuto: false }); stop(); log('Disconnected'); });
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });

store.get(['bridgePort', 'bridgeToken', 'bridgeAuto']).then((s) => {
  if (s.bridgePort) $('port').value = s.bridgePort;
  if (s.bridgeToken) $('token').value = s.bridgeToken;
  if (s.bridgeAuto && s.bridgeToken) start();
});
