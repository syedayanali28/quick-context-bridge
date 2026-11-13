import { parseAutomationUrl } from './lib/ids.js';
import { parseQal } from './lib/qal.js';
import {
  lintQal, semanticDiff, nodeLabel, planApply, mapValidationErrors, review, saveLive, sanitizeAutomationName,
  largeRewriteReason,
} from './lib/writeback.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));

const state = {
  tab: null,
  ids: null,
  name: '',
  newQal: null,
  manifest: null,
  sourceLabel: '',
  checked: null, // result of the last check
};

// ---------------------------------------------------------------- page I/O (runs in the Quick tab, MAIN world)

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

async function call(kind, path, opts) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageCall, args: [kind, path, opts || {}] });
  const r = res && res.result;
  if (!r) throw new Error('No response from the Quick tab. Is it still open?');
  const tabName = `the Quick tab "${(state.tab && state.tab.title) || 'Quick'}"${state.name ? ` (${state.name})` : ''}`;
  if (r.fatal === 'NO_HOOK') throw new Error(`Reload ${tabName}. It was opened before the extension was installed or reloaded. Then click "Check changes" again.`);
  if (r.fatal === 'OLD_HOOK') throw new Error(`Reload ${tabName}. It still runs the previous extension version, which can't save. Then click "Check changes" again.`);
  if (r.fatal === 'NO_AUTH') throw new Error('Quick session not detected yet. Click any tab in Quick (for example Versions), then retry.');
  return r;
}

async function probeName() {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => ((document.querySelector('[data-automation-id="editor-project-name-link"]') || {}).textContent
      || (document.querySelector('h1') || {}).textContent || '').trim(),
  });
  return res && res.result;
}

// ---------------------------------------------------------------- UI helpers

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

function log(msg, cls = '') {
  $('log').append(el('li', { class: cls, text: `${new Date().toLocaleTimeString()}  ${msg}` }));
}

function issues(list, cls) {
  if (!list.length) return el('span');
  return el('ul', { class: `issues ${cls}` }, ...list.slice(0, 50).map((i) => el('li', {},
    i.line ? el('b', { text: `L${i.line}: ` }) : '',
    `${i.code ? `${i.code} — ` : ''}${i.message}`,
    i.text ? el('div', {}, el('code', { text: i.text })) : '')));
}

function editorUrl(groupId, automationId) {
  const { host, quickAccount, region, awsAccountId } = state.ids;
  return `https://${host}/sn/account/${quickAccount}/automations/arn:aws:quicksight:${region}:${awsAccountId}:automation-group_${groupId}_automation_${automationId}/workflow-builder`;
}

function updateButtons() {
  $('btnCheck').disabled = !state.newQal || !state.ids;
  const c = state.checked;
  const conflictOk = c && (c.plan.status === 'ok' || (c.plan.status === 'conflict' && $('optOverride').checked));
  $('btnSave').disabled = !(c && c.serverValid && !c.lint.errors.length && conflictOk && $('optReviewed').checked
    && c.forQal === state.newQal && c.sandbox === $('optSandbox').checked);
}

function invalidate() {
  state.checked = null;
  $('checks').replaceChildren();
  $('semantic').replaceChildren();
  $('diffBox').hidden = true;
  $('overrideRow').hidden = true;
  updateButtons();
}

// ---------------------------------------------------------------- loading the new version

async function readFiles(fileList) {
  const files = [...fileList];
  // Accept the names an older "Download folder" produced too (Chrome renamed them to .txt).
  const pick = (...names) => files
    .filter((f) => names.includes((f.webkitRelativePath || f.name).split('/').pop()))
    .sort((a, b) => (a.webkitRelativePath || a.name).split('/').length - (b.webkitRelativePath || b.name).split('/').length)[0];
  const qalFile = pick('automation.qal.py', 'automation.qal.txt', 'automation.qal.py.txt')
    || files.find((f) => /\.(py|txt)$/i.test(f.name) && !/manifest/i.test(f.name));
  const manFile = pick('export-manifest.json', 'export-manifest.txt', 'export-manifest.json.txt');
  if (!qalFile) { $('source').textContent = 'No automation.qal.py found in the selection.'; return; }
  state.newQal = await qalFile.text();
  state.manifest = manFile ? JSON.parse(await manFile.text()) : null;
  state.sourceLabel = qalFile.webkitRelativePath || qalFile.name;
  showSource();
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Note (before Check) when the export comes from another automation; Check decides by content. */
function targetMismatch() {
  const s = state.manifest && state.manifest.source;
  if (!s || !state.ids || !s.automationId) return null;
  if (s.automationId === state.ids.automationId) return null;
  const exp = (state.manifest.automation && state.manifest.automation.name) || s.automationId;
  return `This export is from "${exp}"; the target is "${state.name || state.ids.automationId}". `
    + 'Check changes will compare the target\'s content with the export to confirm it is a copy.';
}

function showSource() {
  const lines = state.newQal.split('\n').length;
  const m = state.manifest;
  $('source').replaceChildren(
    el('div', {}, el('b', { text: state.sourceLabel }), ` · ${lines.toLocaleString()} lines`),
    el('div', { text: m
      ? `Manifest: exported ${m.exportedAt} from automation ${m.source && m.source.automationId}${m.redacted ? ' (REDACTED: cannot be applied)' : ''}`
      : 'No export-manifest.json, so there is no conflict check against the export time.' }),
  );
  const mismatch = targetMismatch();
  if (mismatch) $('source').append(el('div', { class: 'warn', text: mismatch }));
  invalidate();
}

// ---------------------------------------------------------------- check

async function doCheck() {
  invalidate();
  $('btnCheck').disabled = true;
  const out = $('checks');
  const sandbox = $('optSandbox').checked;
  try {
    const { groupId, automationId } = state.ids;
    const base = `/automation-groups/${groupId}/automations/${automationId}`;
    out.append(el('p', { class: 'muted', text: 'Fetching the Live version…' }));
    const liveRes = await call('read', `${base}/workflow`);
    const live = liveRes.body;
    const rv = review(live.workflowModel, state.newQal);
    const liveLines = live.workflowModel.split('\n').length;
    const plan = planApply({
      manifest: state.manifest, target: { groupId, automationId }, live, newQal: state.newQal, isSandboxCopy: sandbox,
      liveSha256: await sha256Hex(live.workflowModel),
      rewriteShare: liveLines ? rv.stats.removed / liveLines : null,
    });
    const lint = lintQal(state.newQal, live);
    let server = { body: { status: 'SKIPPED', errors: [] } };
    if (plan.status !== 'error' && plan.status !== 'noop') {
      out.lastChild.textContent = 'Validating on the server (nothing is saved)…';
      server = await call('write', `${base}/validate-automation`, { method: 'POST', body: { workflowModel: state.newQal } });
    }
    const serverValid = server.ok && server.body && server.body.status === 'VALID';
    const serverErrors = mapValidationErrors(server.body && server.body.errors, state.newQal);
    const rewrite = largeRewriteReason(rv.stats, liveLines);
    if (rewrite && plan.status === 'ok') { plan.status = 'conflict'; plan.reasons.push(rewrite); }
    let sem = null;
    if (lint.parsed) {
      try { sem = semanticDiff(parseQal(live.workflowModel), lint.parsed); } catch { sem = null; }
    }
    state.checked = { live, plan, lint, serverValid, forQal: state.newQal, sandbox };

    const planCls = { ok: 'ok', noop: 'warn', conflict: 'err', error: 'err' }[plan.status];
    out.replaceChildren(
      el('ul', { class: 'checks' },
        el('li', {}, el('span', { class: `chip ${planCls}`, text: plan.status.toUpperCase() }),
          sandbox ? 'Will be applied to a new sandbox copy of this automation' : `Target: ${state.name || automationId}`,
          { 'copy-identical': ' · identified as an unchanged copy of the exported automation',
            'copy-diverged': ' · looks like a copy of the exported automation, with changes of its own' }[plan.relation] || ''),
        ...plan.reasons.map((r) => el('li', { class: planCls === 'ok' ? 'muted' : planCls, text: r })),
        el('li', {}, el('span', { class: `chip ${lint.errors.length ? 'err' : 'ok'}`, text: `local lint: ${lint.errors.length} errors` }),
          `${lint.warnings.length} warnings`),
        el('li', {}, el('span', { class: `chip ${serverValid ? 'ok' : (server.body && server.body.status === 'SKIPPED' ? 'warn' : 'err')}`,
          text: `server: ${server.body && server.body.status || `HTTP ${server.status}`}` }),
        server.body && server.body.message ? server.body.message : ''),
        el('li', {}, el('span', { class: 'chip', text: `+${rv.stats.added} / −${rv.stats.removed} lines` }), `${rv.hunks.length} hunks`),
      ),
      issues(lint.errors, 'err'),
      issues(serverErrors, 'err'),
      issues(lint.warnings, 'warn'),
    );

    if (sem) {
      const items = [];
      sem.added.forEach((n) => items.push(['ok', `+ ${nodeLabel(n)}`]));
      sem.removed.forEach((n) => items.push(['err', `− ${nodeLabel(n)}`]));
      sem.changed.forEach((c) => items.push(['warn', `~ ${nodeLabel(c.after)}`]));
      sem.codeBlocks.added.forEach((id) => items.push(['ok', `+ code block ${id}`]));
      sem.codeBlocks.removed.forEach((id) => items.push(['err', `− code block ${id}`]));
      sem.codeBlocks.changed.forEach((id) => items.push(['warn', `~ code block ${id}`]));
      if (sem.ioSchemaChanged) items.push(['warn', '~ Start/End input-output schema']);
      $('semantic').replaceChildren(el('h3', { text: 'What changes on the canvas' }),
        items.length ? el('ul', { class: 'semantic' }, ...items.map(([c, t]) => el('li', { class: c, text: t })))
          : el('p', { class: 'muted', text: 'No step-level changes detected (formatting or comments only).' }));
    }

    if (rv.hunks.length) {
      const pre = $('diff');
      pre.replaceChildren(...rv.unified.split('\n').slice(0, 4000).map((line) => {
        const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add'
          : line.startsWith('-') && !line.startsWith('---') ? 'del' : '';
        return el('span', { class: cls, text: line || ' ' });
      }));
      $('diffSummary').textContent = `Diff: live → new (+${rv.stats.added} / −${rv.stats.removed})`;
      $('diffBox').hidden = false;
    }
    $('overrideRow').hidden = plan.status !== 'conflict';
  } catch (e) {
    out.replaceChildren(el('p', { class: 'err', text: `Check failed: ${e.message}` }));
  } finally {
    $('btnCheck').disabled = false;
    updateButtons();
  }
}

// ---------------------------------------------------------------- save

async function doSave() {
  const c = state.checked;
  if (!c) return;
  $('btnSave').disabled = true;
  $('btnCheck').disabled = true;
  $('log').replaceChildren();
  try {
    let { groupId, automationId } = state.ids;
    let live = c.live;
    let baseLmt = c.plan.baseLastModifiedTime;
    if (c.plan.status === 'conflict' && $('optOverride').checked) {
      baseLmt = live.lastModifiedTime;
      log('Overwrite chosen: the save is based on the current Live version.', 'warn');
    }

    if (c.sandbox) {
      const name = sanitizeAutomationName($('sandboxName').value);
      log(`Creating sandbox copy "${name}"…`);
      const cp = await call('write', `/automation-groups/${groupId}/automations/${automationId}/copy`, {
        method: 'POST', body: { destinationAutomationGroupId: groupId, newAutomationName: name },
      });
      if (!cp.ok) throw new Error(`Copy failed (HTTP ${cp.status}): ${JSON.stringify(cp.body).slice(0, 300)}`);
      const newId = String(cp.body.automationArn || '').split('/automation/').pop();
      if (!/^[0-9a-f-]{36}$/.test(newId)) throw new Error(`Unexpected copy response: ${JSON.stringify(cp.body).slice(0, 200)}`);
      automationId = newId;
      log(`Sandbox created: ${automationId}`, 'ok');
      const fresh = await call('read', `/automation-groups/${groupId}/automations/${automationId}/workflow`);
      live = fresh.body;
      baseLmt = live.lastModifiedTime;
    }

    const res = await saveLive({ call, groupId, automationId, live, newQal: state.newQal, baseLastModifiedTime: baseLmt, log });
    if (res.ok) {
      const url = editorUrl(groupId, automationId);
      $('log').append(el('li', { class: 'ok' }, 'Done. Open the editor to review, then Commit there when ready: ',
        el('a', { href: url, target: '_blank', rel: 'noopener', text: 'open in Quick' })));
      if (!c.sandbox) state.manifest = state.manifest ? { ...state.manifest, automation: { ...state.manifest.automation, lastModifiedTime: res.lastModifiedTime } } : null;
    }
  } catch (e) {
    log(e.message, 'err');
  } finally {
    state.checked = null; // force a fresh check before another save
    $('btnCheck').disabled = false;
    updateButtons();
  }
}

// ---------------------------------------------------------------- init

async function init() {
  if (!tabId) { $('target').textContent = 'Open this page from the extension popup on a Quick automation tab.'; return; }
  try {
    state.tab = await chrome.tabs.get(tabId);
  } catch {
    $('target').textContent = 'The Quick tab this page was opened for is gone. Reopen from the popup.';
    return;
  }
  state.ids = parseAutomationUrl(state.tab.url || '');
  if (!state.ids) { $('target').textContent = 'That tab is not showing a Quick automation.'; return; }
  try { state.name = await probeName(); } catch { state.name = ''; }
  $('target').replaceChildren(
    el('div', {}, el('b', { text: state.name || '(unnamed automation)' })),
    el('div', { class: 'mono muted', text: `group ${state.ids.groupId} · automation ${state.ids.automationId} · ${state.ids.region}` }),
  );
  $('sandboxName').value = sanitizeAutomationName(`${state.name || 'Automation'} - agent sandbox`);
  updateButtons();
}

$('pickFolder').addEventListener('change', (e) => readFiles(e.target.files).catch((err) => { $('source').textContent = err.message; }));
$('pickFiles').addEventListener('change', (e) => readFiles(e.target.files).catch((err) => { $('source').textContent = err.message; }));
$('togglePaste').addEventListener('click', () => { $('paste').hidden = !$('paste').hidden; });
$('paste').addEventListener('input', () => {
  state.newQal = $('paste').value;
  state.manifest = null;
  state.sourceLabel = 'Pasted QAL';
  showSource();
});
$('btnCheck').addEventListener('click', doCheck);
$('btnSave').addEventListener('click', doSave);
for (const id of ['optOverride', 'optReviewed']) $(id).addEventListener('change', updateButtons);
$('optSandbox').addEventListener('change', invalidate);
init();
