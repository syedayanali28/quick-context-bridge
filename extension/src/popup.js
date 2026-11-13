import { parseAutomationUrl } from './lib/ids.js';
import { buildBundle } from './lib/bundle.js';
import { makeZip } from './lib/zip.js';

const $ = (id) => document.getElementById(id);
let tab = null;
let ids = null;
let bundle = null;

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

/**
 * Runs in the page's MAIN world (must be self-contained: no closures over popup variables).
 * Uses the read-only bridge installed by page-hook.js.
 */
async function pageProbe() {
  const b = window.__quickContextBridge;
  const name = (document.querySelector('[data-automation-id="editor-project-name-link"]') || {}).textContent
    || (document.querySelector('h1') || {}).textContent
    || '';
  return { hook: !!b, auth: !!(b && b.hasAuth()), name: name.trim() };
}

async function pageFetchAll(groupId, automationId, includeSchemas) {
  const b = window.__quickContextBridge;
  if (!b) return { fatal: 'NO_HOOK' };
  if (!b.hasAuth()) return { fatal: 'NO_AUTH' };
  const g = `/automation-groups/${groupId}`;
  const a = `${g}/automations/${automationId}`;
  const out = { errors: [] };
  try {
    out.workflow = await b.request(`${a}/workflow`);
  } catch (e) {
    return { fatal: String(e && e.message || e) };
  }
  const soft = async (key, fn) => {
    try { out[key] = await fn(); } catch (e) { out.errors.push(`${key}: ${e && e.message || e}`); }
  };
  await soft('associations', () => b.request(`${g}/associations/list`, { method: 'POST', body: {} }));
  await soft('versions', () => b.request(`${a}/versions`));
  await soft('actionGroups', () => b.request(`${g}/action-groups`));
  if (includeSchemas && out.actionGroups && out.actionGroups.actionGroups) {
    const groupIds = out.actionGroups.actionGroups.map((x) => x.actionGroupId);
    await soft('actionSchemas', () => b.request(`${g}/action-groups/batch`, { method: 'POST', body: { actionGroupIds: groupIds } }));
  }
  return out;
}

async function inPage(func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func, args });
  return res && res.result;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ids = tab && tab.url ? parseAutomationUrl(tab.url) : null;
  if (!ids) {
    setStatus('Open an automation in Amazon Quick (…/automations/arn:aws:quicksight:…automation-group_…_automation_…) and click again.', 'err');
    return;
  }
  let probe;
  try {
    probe = await inPage(pageProbe);
  } catch (e) {
    setStatus(`Cannot access this tab: ${e.message}`, 'err');
    return;
  }
  $('target').hidden = false;
  $('autoName').textContent = probe.name || '(unnamed automation)';
  $('autoIds').textContent = `group ${ids.groupId}\nautomation ${ids.automationId}`;
  if (!probe.hook) {
    setStatus('Reload this Quick tab once. The extension was installed or updated after the page loaded.', 'err');
    return;
  }
  if (!probe.auth) {
    setStatus('Waiting for the Quick session. Click any tab in Quick (for example Versions), then reopen this popup.', 'err');
    return;
  }
  setStatus('Ready. Session detected.', 'ok');
  $('controls').hidden = false;
}

async function doExport() {
  $('btnExport').disabled = true;
  $('result').hidden = true;
  setStatus('Fetching automation…');
  try {
    const includeSchemas = $('optSchemas').checked;
    const raw = await inPage(pageFetchAll, [ids.groupId, ids.automationId, includeSchemas]);
    if (!raw || raw.fatal) {
      const msg = raw && raw.fatal;
      if (msg === 'NO_AUTH') throw new Error('Session not detected yet. Click any tab in Quick, then retry.');
      if (msg === 'NO_HOOK') throw new Error('Reload the Quick tab once, then retry.');
      throw new Error(msg || 'No response from page');
    }
    setStatus('Building bundle…');
    const probe = await inPage(pageProbe);
    bundle = await buildBundle({ ...raw, ids, name: probe.name, pageUrl: tab.url }, {
      redact: $('optRedact').checked,
      includeActionSchemas: includeSchemas,
    });
    showResult();
    setStatus('Export ready.', 'ok');
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, 'err');
  } finally {
    $('btnExport').disabled = false;
  }
}

function showResult() {
  const s = bundle.summary;
  const items = [
    `${s.qalLines.toLocaleString()} lines of QAL (${Math.round(s.qalBytes / 1024)} KB)`,
    `${s.steps} process steps · ${s.actions} connector/built-in actions`,
    `${s.codeBlocks} code blocks (${s.distinctCodeBlocks} distinct) · ${s.agents} agents (${s.distinctAgents} distinct)`,
    `${s.connectors} connectors${s.unresolvedConnectors ? ` (${s.unresolvedConnectors} unnamed)` : ''}`,
    `${bundle.files.length} files`,
  ];
  $('summary').replaceChildren(...items.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  const warns = [];
  if (s.fetchErrors) warns.push(`Optional data missing:\n${bundle.manifest.fetchErrors.join('\n')}`);
  if (s.warnings) warns.push(`${s.warnings} parser warning(s). See export-manifest.json.`);
  if (bundle.manifest.redacted) warns.push('Redacted export: for reading only. Do not import it back.');
  $('warn').hidden = !warns.length;
  $('warn').textContent = warns.join('\n\n');
  $('result').hidden = false;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  return chrome.downloads.download({ url, filename, conflictAction: 'uniquify' })
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 60_000));
}

async function downloadZip() {
  const zip = makeZip(bundle.files.map((f) => ({ path: `${bundle.folder}/${f.path}`, content: f.content })));
  await download(new Blob([zip], { type: 'application/zip' }), `quick-exports/${bundle.folder}.zip`);
  setStatus(`Saved to Downloads/quick-exports/${bundle.folder}.zip`, 'ok');
}

async function downloadFolder() {
  for (const f of bundle.files) {
    // octet-stream: with text/plain, Chrome on Windows rewrites .py/.md/.json extensions to .txt
    await download(new Blob([f.content], { type: 'application/octet-stream' }), `quick-exports/${bundle.folder}/${f.path}`);
  }
  setStatus(`Saved ${bundle.files.length} files to Downloads/quick-exports/${bundle.folder}/`, 'ok');
}

async function copy(path) {
  const f = bundle.files.find((x) => x.path === path);
  await navigator.clipboard.writeText(f.content);
  setStatus(`Copied ${path} (${Math.round(f.content.length / 1024)} KB) to the clipboard.`, 'ok');
}

$('btnExport').addEventListener('click', doExport);
$('btnApply').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/apply.html?tabId=${tab.id}`) });
  window.close();
});
$('btnZip').addEventListener('click', () => downloadZip().catch((e) => setStatus(e.message, 'err')));
$('btnFolder').addEventListener('click', () => downloadFolder().catch((e) => setStatus(e.message, 'err')));
$('btnCopyOutline').addEventListener('click', () => copy('outline.md').catch((e) => setStatus(e.message, 'err')));
$('btnCopyQal').addEventListener('click', () => copy('automation.qal.py').catch((e) => setStatus(e.message, 'err')));
$('btnCopyJson').addEventListener('click', () => copy('context.json').catch((e) => setStatus(e.message, 'err')));
init();
