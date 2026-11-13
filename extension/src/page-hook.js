// Runs in the Quick page's MAIN world at document_start (see manifest.json).
//
// The Quick console's backend proxy (/qbsproxy/quicksight/...) only accepts requests that carry the
// per-session `mbtc` query parameter plus the `x-amzn-csrf-token` header. The `mbtc` value is not readable
// from cookies/storage, so we observe it on the app's own outgoing requests and keep it in this closure.
// It is never written to storage, never sent anywhere else, and never included in exports.
//
// We expose two helpers on window.__quickContextBridge:
//   request(): read-only endpoints (export)
//   write():   a short allowlist for write-back (validate, lock, save Live version, copy). It never commits,
//              deploys, deletes or runs. Writes are only issued by the extension's Apply page after the user
//              confirms.
(() => {
  if (window.__quickContextBridge) return;

  const PROXY_MARK = '/qbsproxy/quicksight';
  let auth = null; // { root, mbtc, csrf, seenAt }

  function learn(url, headers) {
    try {
      const u = new URL(url, location.href);
      const i = u.pathname.indexOf(PROXY_MARK);
      if (i < 0 || u.host !== location.host) return;
      const mbtc = u.searchParams.get('mbtc');
      if (!mbtc) return;
      let csrf = null;
      if (headers) {
        const h = new Headers(headers);
        csrf = h.get('x-amzn-csrf-token');
      }
      if (!csrf) {
        try { csrf = window.AppConfig && window.AppConfig.getCsrf && window.AppConfig.getCsrf(); } catch (_) { /* ignore */ }
      }
      auth = { root: u.pathname.slice(0, i + PROXY_MARK.length), mbtc, csrf, seenAt: Date.now() };
    } catch (_) { /* never break the page */ }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && url.indexOf(PROXY_MARK) >= 0) {
        learn(url, (init && init.headers) || (typeof input !== 'string' && input.headers));
      }
    } catch (_) { /* ignore */ }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__qcbUrl = url;
    this.__qcbHeaders = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__qcbHeaders) this.__qcbHeaders[k] = v; } catch (_) { /* ignore */ }
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (this.__qcbUrl && String(this.__qcbUrl).indexOf(PROXY_MARK) >= 0) learn(this.__qcbUrl, this.__qcbHeaders);
    } catch (_) { /* ignore */ }
    return origSend.apply(this, arguments);
  };

  // Read-only allowlist: [method, regex over the path after /qbsproxy/quicksight].
  const ID = '[0-9a-f-]{36}';
  const AUTO = `/automation-groups/${ID}/automations/${ID}`;
  const READ_ONLY = [
    ['GET', new RegExp(`^${AUTO}/workflow$`)],
    ['GET', new RegExp(`^${AUTO}/versions$`)],
    ['GET', new RegExp(`^${AUTO}/versions/[^/]+$`)],
    ['GET', new RegExp(`^/automation-groups/${ID}/action-groups$`)],
    ['POST', new RegExp(`^/automation-groups/${ID}/action-groups/batch$`)],
    ['POST', new RegExp(`^/automation-groups/${ID}/associations/list$`)],
    // Run inspection (POST but read-only)
    ['POST', /^\/get\/automation-groups\/workflow-executions$/],
    ['POST', new RegExp(`^/automation-groups/${ID}/get-workflow-action-execution$`)],
    ['POST', /^\/search\/automation-groups\/automation-runs$/],
  ];

  // Write-back + test runs. Deliberately excluded: commit (POST ~/versions/{v}), deploy, delete, triggers,
  // deployed-job APIs. Saving only ever touches the Live (draft) version; runs are TEST-environment runs.
  const WRITE = [
    ['POST', new RegExp(`^${AUTO}/validate-automation$`)], // server-side compile check, saves nothing
    ['POST', new RegExp(`^${AUTO}/acquire-lock$`)],
    ['POST', new RegExp(`^${AUTO}/release-lock$`)],
    ['PUT', new RegExp(`^${AUTO}/workflows$`)], // save Live version (optimistic concurrency via lastModifiedTime)
    ['POST', new RegExp(`^${AUTO}/copy$`)], // create a sandbox copy
    // Test runs of the Live version (environment TEST), started only by the local agent bridge
    ['POST', /^\/start\/automation-groups\/workflow-executions$/],
    ['PUT', /^\/workflow-executions\/automation-groups$/], // debug commands, e.g. stop a test run
  ];

  const allowedIn = (list, method, path) => list.some(([m, re]) => m === method && re.test(path));

  async function send(path, method, body) {
    if (!auth) throw new Error('NO_AUTH');
    const url = `${auth.root}${path}?mbtc=${encodeURIComponent(auth.mbtc)}`;
    const headers = {};
    if (auth.csrf) headers['x-amzn-csrf-token'] = auth.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await origFetch.call(window, url, {
      method,
      credentials: 'include',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; }
    return { ok: res.ok, status: res.status, body: parsed };
  }

  /** Read-only request; throws on HTTP errors. */
  async function request(path, { method = 'GET', body } = {}) {
    method = method.toUpperCase();
    if (!allowedIn(READ_ONLY, method, path)) throw new Error(`Blocked by read-only allowlist: ${method} ${path}`);
    const r = await send(path, method, body);
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} for ${method} ${path}: ${JSON.stringify(r.body).slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return r.body;
  }

  /** Guarded write; returns {ok, status, body} without throwing on HTTP errors. */
  async function write(path, { method = 'POST', body } = {}) {
    method = method.toUpperCase();
    if (!allowedIn(WRITE, method, path)) throw new Error(`Blocked by write allowlist: ${method} ${path}`);
    return send(path, method, body);
  }

  Object.defineProperty(window, '__quickContextBridge', {
    value: Object.freeze({
      version: 3, // 3 = adds test runs + run inspection to the allowlists
      hasAuth: () => !!auth,
      authAgeMs: () => (auth ? Date.now() - auth.seenAt : null),
      request,
      write,
    }),
    enumerable: false,
  });
})();
