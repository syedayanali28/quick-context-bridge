// Agent-side operations on Amazon Quick Automate, executed through the extension's authenticated page hook.
// All logic runs here (Node); the extension only relays HTTP calls with the user's Quick session.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseAutomationUrl, slugify } from '../../extension/src/lib/ids.js';
import { buildBundle } from '../../extension/src/lib/bundle.js';
import { parseQal } from '../../extension/src/lib/qal.js';
import {
  lintQal, planApply, mapValidationErrors, review, saveLive, semanticDiff, nodeLabel, largeRewriteReason, sanitizeAutomationName,
} from '../../extension/src/lib/writeback.js';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ------------------------------------------------------------------ transport

export class BridgeClient {
  constructor({ port = 8765, token, host = '127.0.0.1' }) {
    this.base = `http://${host}:${port}`;
    this.token = token;
  }

  async status() {
    const r = await fetch(`${this.base}/status`, { headers: { 'x-qcb-token': this.token } });
    if (!r.ok) throw new Error(`bridge status HTTP ${r.status}`);
    return r.json();
  }

  async cmd(cmd, args = {}, timeoutMs = 120_000) {
    const r = await fetch(`${this.base}/cmd`, {
      method: 'POST',
      headers: { 'x-qcb-token': this.token, 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, args, timeoutMs }),
    });
    if (!r.ok) throw new Error(`bridge HTTP ${r.status}: ${await r.text()}`);
    const res = await r.json();
    if (!res.ok) throw new Error(res.error || `${cmd} failed`);
    return res.result;
  }

  /**
   * {ok, status, body} from the page hook. kind = 'read' | 'write'.
   * Routed through a Quick tab of the same automation group (tabs can be in other groups/regions).
   */
  async call(kind, path, { method, body, tabId, groupId } = {}) {
    const g = groupId || (String(path).match(/\/automation-groups\/([0-9a-f-]{36})/) || [])[1] || this.lastGroup;
    if (g) this.lastGroup = g;
    const tab = tabId || (g ? await this.tabFor(g) : undefined);
    return this.cmd('call', { kind, path, method: method || (kind === 'read' ? 'GET' : 'POST'), body, tabId: tab }, 180_000);
  }

  /** A ready Quick tab (hook v2 + session) on the same host as a tab showing this group. */
  async tabFor(groupId) {
    if (!this.tabCache || Date.now() - this.tabCache.at > 60_000) this.tabCache = { at: Date.now(), tabs: await this.cmd('tabs', {}, 30_000) };
    const ready = this.tabCache.tabs.filter((t) => t.hookVersion >= 2 && t.auth)
      .sort((a, b) => Number(b.hookVersion) - Number(a.hookVersion)); // newest page hook first
    const exact = ready.find((t) => t.ids && t.ids.groupId === groupId);
    if (exact) return exact.tabId;
    const host = (this.tabCache.tabs.find((t) => t.ids && t.ids.groupId === groupId) || {}).url;
    const sameHost = host && ready.find((t) => new URL(t.url).host === new URL(host).host);
    return sameHost ? sameHost.tabId : undefined;
  }

  async read(path, opts = {}) {
    const r = await this.call('read', path, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${opts.method || 'GET'} ${path}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }
}

// ------------------------------------------------------------------ workspace + targets

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Default: a sibling folder of this repo, ../quick-workspace (its own private git repo). */
export function workspaceRoot() {
  return process.env.QCB_WORKSPACE || join(REPO_ROOT, '..', 'quick-workspace');
}

export function loadTargets(ws = workspaceRoot()) {
  const f = join(ws, 'targets.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}

export function saveTargets(targets, ws = workspaceRoot()) {
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'targets.json'), `${JSON.stringify(targets, null, 2)}\n`);
}

/**
 * Resolve "<console url>" | "<groupId>/<automationId>" | "<alias>" | "<workspace folder>" to ids.
 * @returns {{groupId:string, automationId:string, name?:string, ids?:object}}
 */
export function resolveRef(ref, targets = loadTargets(), ws = workspaceRoot()) {
  if (!ref) throw new Error('automation reference required (console URL, <group>/<automation>, alias or workspace folder)');
  const fromUrl = parseAutomationUrl(ref);
  if (fromUrl) return { groupId: fromUrl.groupId, automationId: fromUrl.automationId, ids: fromUrl, name: targets[fromUrl.automationId]?.name };
  const m = String(ref).match(/^([0-9a-f-]{36})\/([0-9a-f-]{36})$/i);
  if (m) return { groupId: m[1].toLowerCase(), automationId: m[2].toLowerCase(), name: targets[m[2].toLowerCase()]?.name };
  for (const [id, t] of Object.entries(targets)) {
    if (t.alias === ref || t.slug === ref) return { groupId: t.groupId, automationId: id, name: t.name, ids: t.ids };
  }
  const dir = existsSync(ref) ? ref : join(ws, ref);
  const man = join(dir, 'export-manifest.json');
  if (existsSync(man)) {
    const s = JSON.parse(readFileSync(man, 'utf8')).source;
    return { groupId: s.automationGroupId, automationId: s.automationId, name: targets[s.automationId]?.name, ids: s };
  }
  throw new Error(`Unknown automation reference: ${ref}`);
}

/** Policy: the agent may write to / run an automation only if the user named it (targets.json) or it is a sandbox. */
export function assertAllowed(target, targets = loadTargets()) {
  const t = targets[target.automationId];
  if (t && t.allowed) return;
  if (/sandbox/i.test(target.name || (t && t.name) || '')) return;
  throw new Error(`Not allowed to modify/run ${target.name || target.automationId}. Add it with: qcb allow <ref> --name "<name>"`);
}

// ------------------------------------------------------------------ discovery

export async function tabs(client) {
  return client.cmd('tabs', {}, 30_000);
}

/** Best-effort automation name: from an open Quick tab showing it, else targets.json. */
export async function automationName(client, target) {
  if (target.name) return target.name;
  try {
    const ts = await tabs(client);
    const hit = ts.find((t) => t.ids && t.ids.automationId === target.automationId && t.name);
    if (hit) return hit.name;
  } catch { /* ignore */ }
  return null;
}

function base(target) {
  return `/automation-groups/${target.groupId}/automations/${target.automationId}`;
}

// ------------------------------------------------------------------ pull

export async function fetchRaw(client, target, { includeActions = true } = {}) {
  const g = `/automation-groups/${target.groupId}`;
  const out = { errors: [] };
  out.workflow = await client.read(`${base(target)}/workflow`);
  const soft = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out.errors.push(`${k}: ${e.message}`); } };
  await soft('associations', () => client.read(`${g}/associations/list`, { method: 'POST', body: {} }));
  await soft('versions', () => client.read(`${base(target)}/versions`));
  await soft('actionGroups', () => client.read(`${g}/action-groups`));
  if (includeActions && out.actionGroups?.actionGroups) {
    await soft('actionSchemas', () => client.read(`${g}/action-groups/batch`, {
      method: 'POST', body: { actionGroupIds: out.actionGroups.actionGroups.map((x) => x.actionGroupId) },
    }));
  }
  return out;
}

/**
 * Export an automation into a workspace folder (runs/ and other local files are preserved).
 * @returns {{dir:string, summary:object}}
 */
export async function pull(client, target, { dir, includeActions = true, name } = {}) {
  const raw = await fetchRaw(client, target, { includeActions });
  const nm = name || await automationName(client, target) || target.automationId;
  const ids = target.ids && target.ids.region
    ? { ...target.ids, groupId: target.groupId, automationId: target.automationId }
    : { groupId: target.groupId, automationId: target.automationId, arn: raw.workflow.workflowArn };
  const b = await buildBundle({ ...raw, ids, name: nm, pageUrl: null }, { includeActionSchemas: includeActions });
  const out = dir || join(workspaceRoot(), slugify(nm));
  for (const f of b.files) {
    const p = join(out, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  return { dir: out, summary: b.summary, manifest: b.manifest };
}

// ------------------------------------------------------------------ validate / push

function readWorkspace(dir) {
  const qal = readFileSync(join(dir, 'automation.qal.py'), 'utf8');
  const mf = join(dir, 'export-manifest.json');
  return { qal, manifest: existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : null };
}

/** Lint + server validation + diff against Live. Saves nothing. */
export async function check(client, target, dir) {
  const { qal, manifest } = readWorkspace(dir);
  const live = await client.read(`${base(target)}/workflow`);
  const rv = review(live.workflowModel, qal);
  const liveLines = live.workflowModel.split('\n').length;
  const plan = planApply({
    manifest, target, live, newQal: qal, liveSha256: sha256(live.workflowModel), rewriteShare: liveLines ? rv.stats.removed / liveLines : null,
  });
  const rewrite = largeRewriteReason(rv.stats, liveLines);
  if (rewrite && plan.status === 'ok') { plan.status = 'conflict'; plan.reasons.push(rewrite); }
  const lint = lintQal(qal, live);
  let server = { status: 'SKIPPED', errors: [] };
  if (plan.status !== 'noop' && plan.status !== 'error') {
    const v = await client.call('write', `${base(target)}/validate-automation`, { method: 'POST', body: { workflowModel: qal } });
    server = v.ok ? { status: v.body.status, errors: mapValidationErrors(v.body.errors, qal) } : { status: `HTTP ${v.status}`, errors: [{ message: JSON.stringify(v.body).slice(0, 300) }] };
  }
  let sem = null;
  try { sem = semanticDiff(parseQal(live.workflowModel), lint.parsed); } catch { /* ignore */ }
  return { live, qal, manifest, plan, lint, server, diff: rv, semantic: sem };
}

export function describeSemantic(sem) {
  if (!sem) return [];
  return [
    ...sem.added.map((n) => `+ ${nodeLabel(n)}`),
    ...sem.removed.map((n) => `- ${nodeLabel(n)}`),
    ...sem.changed.map((c) => `~ ${nodeLabel(c.after)}`),
    ...sem.codeBlocks.added.map((id) => `+ code block ${id}`),
    ...sem.codeBlocks.removed.map((id) => `- code block ${id}`),
    ...sem.codeBlocks.changed.map((id) => `~ code block ${id}`),
    ...(sem.ioSchemaChanged ? ['~ input/output schema'] : []),
  ];
}

/**
 * Validate and save the workspace QAL to the target's Live version (lock → PUT → verify → release).
 * On success the workspace manifest is re-based on the new Live version.
 */
export async function push(client, target, dir, { force = false, log = () => {} } = {}) {
  assertAllowed(target);
  const c = await check(client, target, dir);
  if (c.plan.status === 'noop') return { ok: true, noop: true, check: c };
  if (c.plan.status === 'error') return { ok: false, reason: c.plan.reasons.join(' '), check: c };
  if (c.lint.errors.length) return { ok: false, reason: `Local lint: ${c.lint.errors.length} error(s)`, check: c };
  if (c.server.status !== 'VALID') return { ok: false, reason: `Server validation: ${c.server.status}`, check: c };
  if (c.plan.status === 'conflict' && !force) return { ok: false, reason: `Conflict: ${c.plan.reasons.join(' ')} (use --force to overwrite)`, check: c };
  const baseLmt = c.plan.status === 'conflict' ? c.live.lastModifiedTime : c.plan.baseLastModifiedTime;
  const call = (kind, path, opts) => client.call(kind, path, opts);
  const res = await saveLive({ call, groupId: target.groupId, automationId: target.automationId, live: c.live, newQal: c.qal, baseLastModifiedTime: baseLmt, log });
  if (res.ok && c.manifest) {
    const m = c.manifest;
    m.automation = { ...m.automation, lastModifiedTime: res.lastModifiedTime };
    m.qal = { ...m.qal, sha256: sha256(c.qal), bytes: Buffer.byteLength(c.qal), lines: c.qal.split('\n').length };
    m.source = { ...m.source, automationGroupId: target.groupId, automationId: target.automationId };
    writeFileSync(join(dir, 'export-manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  }
  return { ...res, check: c };
}

export async function copy(client, target, name) {
  const newName = sanitizeAutomationName(name);
  const r = await client.call('write', `${base(target)}/copy`, { method: 'POST', body: { destinationAutomationGroupId: target.groupId, newAutomationName: newName } });
  if (!r.ok) throw new Error(`copy failed HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  const automationId = String(r.body.automationArn || '').split('/automation/').pop();
  return { groupId: target.groupId, automationId, name: newName, arn: r.body.automationArn };
}

// ------------------------------------------------------------------ test runs

const TERMINAL = /^(SUCCEEDED|SUCCESS|SUCCESSFUL|COMPLETED|COMPLETE|FAILED|FAILURE|ERROR|STOPPED|CANCELLED|CANCELED|TIMED_OUT|ABORTED)$/i;

/** Find the execution status in an unknown response shape. */
export function findStatus(obj) {
  let hit = null;
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4 || hit) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /status$/i.test(k) && /^[A-Z_]+$/.test(v)) { hit = v; return; }
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  visit(obj, 0);
  return hit;
}

export const isTerminal = (s) => !!s && TERMINAL.test(s);

/** Mirror of the console's test-run configuration: runtime config with test task queues. */
export function testRunConfiguration(workflow) {
  const cfg = JSON.parse(JSON.stringify(workflow.runtimeConfiguration || {}));
  const id = String(workflow.workflowArn || '').split('/').pop();
  const tq = cfg.resourceConfiguration && cfg.resourceConfiguration.TASK_QUEUE;
  if (id && tq) {
    for (const k of Object.keys(tq)) {
      if (k.startsWith('task_resource_permissions_')) continue;
      tq[k] = { ...(tq[k] || {}), resourceConfigValue: `${id}-test-task-queue` };
    }
  }
  return cfg;
}

export function startRunBody(workflow, input) {
  const body = {
    workflowArn: workflow.workflowArn,
    compiler: 'PYTHON',
    environment: 'TEST',
    debugConfig: { enabled: false, staticBreakpoints: [] },
    configuration: testRunConfiguration(workflow),
  };
  if (input !== undefined && input !== null) body.inputPayload = typeof input === 'string' ? input : JSON.stringify(input);
  return body;
}

/** The run/job ARN in the start response (shape not documented): any ARN string pointing at a /job/. */
export function findArn(obj) {
  let hit = null;
  const visit = (o, d) => {
    if (!o || typeof o !== 'object' || d > 3 || hit) return;
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && /^arn:aws:quicksight:.*:automation-group\/.+\/job\//.test(v)) { hit = v; return; }
    }
    for (const v of Object.values(o)) visit(v, d + 1);
  };
  visit(obj, 0);
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** get-workflow-action-execution, all pages: {workflowExecutionStatus, actionExecutions[], dsl, ...}. */
export async function fetchExecution(client, target, executionArn) {
  const all = [];
  let first = null;
  let nextToken;
  for (let page = 0; page < 50; page++) {
    const body = {
      automationId: target.automationId, workflowExecutionArn: executionArn,
      includeInputPayload: true, includeOutputPayload: true, includeDebugOutput: true, maxResults: 100,
    };
    if (nextToken) body.nextToken = nextToken;
    const r = await client.call('read', `/automation-groups/${target.groupId}/get-workflow-action-execution`, { method: 'POST', body });
    if (!r.ok) throw new Error(`get-workflow-action-execution HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    if (!first) first = r.body;
    all.push(...(r.body.actionExecutions || []));
    nextToken = r.body.nextToken;
    if (!nextToken) break;
  }
  return { ...first, actionExecutions: all, nextToken: null };
}

/** Just the action list of a run. */
export async function runActions(client, target, executionArn) {
  return (await fetchExecution(client, target, executionArn)).actionExecutions;
}

/**
 * Start a TEST run of the Live version, wait for it, and return the execution record.
 * @returns {Promise<{executionArn, status, start, execution, actions, timedOut, durationSec}>}
 */
export async function run(client, target, { input, timeoutSec = 900, pollSec = 5, log = () => {} } = {}) {
  assertAllowed(target);
  const workflow = await client.read(`${base(target)}/workflow`);
  const start = await client.call('write', '/start/automation-groups/workflow-executions', { method: 'POST', body: startRunBody(workflow, input), groupId: target.groupId });
  if (!start.ok) {
    const msg = JSON.stringify(start.body).slice(0, 400);
    if (/write allowlist/.test(msg)) throw new Error('The Quick tab runs an older page hook without test runs: reload the extension, press F5 on a Quick tab of this group, click any Quick tab once, then retry.');
    throw new Error(`start failed HTTP ${start.status}: ${msg}`);
  }
  const executionArn = findArn(start.body);
  if (!executionArn) throw new Error(`start returned no execution ARN: ${JSON.stringify(start.body).slice(0, 300)}`);
  log(`Run started: ${executionArn}`);
  const t0 = Date.now();
  let execution = null;
  let status = null;
  let timedOut = false;
  for (;;) {
    await sleep(pollSec * 1000);
    try {
      execution = await fetchExecution(client, target, executionArn);
    } catch (e) {
      if (Date.now() - t0 > 60_000) throw e; // the record can take a moment to appear
      continue;
    }
    const s = execution.workflowExecutionStatus || findStatus(execution);
    if (s !== status) { status = s; log(`Status: ${s}`); }
    if (isTerminal(s)) break;
    if (Date.now() - t0 > timeoutSec * 1000) { timedOut = true; break; }
  }
  return { executionArn, status, start: start.body, execution, actions: execution ? execution.actionExecutions : [], timedOut, durationSec: Math.round((Date.now() - t0) / 1000) };
}

/**
 * Collapse the RUNNING/final event pairs into one row per executed QAL line, annotated with the canvas
 * display ID and title (actionId is the 1-based QAL line number).
 */
export function digestExecution(execution, qal) {
  const src = (execution && execution.dsl && execution.dsl.body) || qal || '';
  const byLine = new Map();
  if (src) {
    try {
      const walkAll = (nodes) => { for (const n of nodes) { byLine.set(n.line, n); if (n.children) walkAll(n.children); } };
      walkAll(parseQal(src).nodes);
    } catch { /* ignore */ }
  }
  const lines = src.split('\n');
  const rows = new Map();
  const logs = [];
  for (const a of (execution && execution.actionExecutions) || []) {
    const line = Number(a.actionId);
    const row = rows.get(line) || { line, status: null, events: 0, startedAt: null, endedAt: null };
    row.events++;
    if (a.status) row.status = a.status;
    if (a.executionStartTime) row.startedAt = row.startedAt ?? a.executionStartTime;
    if (a.executionEndTime) row.endedAt = a.executionEndTime;
    rows.set(line, row);
    let entries = a.logs;
    if (typeof entries === 'string') { try { entries = JSON.parse(entries); } catch { entries = [{ message: entries }]; } }
    for (const l of entries || []) logs.push({ line, level: l.level || 'INFO', message: l.message, timestamp: l.timestamp });
  }
  const steps = [...rows.values()].map((r) => {
    const n = byLine.get(r.line);
    return { ...r, displayId: n ? n.displayId || null : null, title: n ? n.title || n.kind : null, kind: n ? n.kind : null,
      code: !n && lines[r.line - 1] ? lines[r.line - 1].trim().slice(0, 120) : undefined };
  });
  logs.sort((x, y) => (x.timestamp || 0) - (y.timestamp || 0));
  return {
    status: execution && execution.workflowExecutionStatus,
    startTime: execution && execution.startTime,
    endTime: execution && execution.endTime,
    steps,
    failed: steps.filter((s) => /FAIL|ERROR|TIMED_OUT/i.test(s.status || '')),
    logs,
    errorLogs: logs.filter((l) => /ERROR|WARN|CRITICAL/i.test(l.level)),
    outputPayload: execution && execution.outputPayload,
    debugOutput: execution && execution.debugOutput,
  };
}

/** Save run artifacts under <dir>/runs/<timestamp>-<status>/ and return {folder, digest}. */
export function saveRun(dir, result, extra = {}) {
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const out = join(dir, 'runs', `${ts}-${String(result.status || 'UNKNOWN').toLowerCase()}`);
  mkdirSync(out, { recursive: true });
  const qalFile = join(dir, 'automation.qal.py');
  const digest = digestExecution(result.execution, existsSync(qalFile) ? readFileSync(qalFile, 'utf8') : null);
  const { dsl, actionExecutions, ...meta } = result.execution || {};
  writeFileSync(join(out, 'run.json'), `${JSON.stringify({ ...extra, executionArn: result.executionArn, status: result.status, timedOut: result.timedOut, durationSec: result.durationSec, start: result.start, execution: meta }, null, 2)}\n`);
  writeFileSync(join(out, 'actions.json'), `${JSON.stringify(actionExecutions || [], null, 2)}\n`);
  writeFileSync(join(out, 'digest.json'), `${JSON.stringify(digest, null, 2)}\n`);
  writeFileSync(join(out, 'summary.md'), summarizeRun(result, digest, extra));
  return { folder: out, digest };
}

function short(v, n = 300) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Human/agent-readable run summary: status, failures, log messages, executed steps. */
export function summarizeRun(result, digest = digestExecution(result.execution), extra = {}) {
  const L = [`# Test run ${result.status || 'UNKNOWN'}${result.timedOut ? ' (timed out waiting)' : ''}`, ''];
  if (extra.note) L.push(extra.note, '');
  L.push(`- Execution: \`${result.executionArn}\``, `- Wait time: ${result.durationSec}s`,
    `- Executed steps: ${digest.steps.length} · failed: ${digest.failed.length} · log lines: ${digest.logs.length}`, '');
  if (digest.failed.length) {
    L.push('## Failed', '');
    for (const s of digest.failed) L.push(`- L${s.line} ${s.displayId || ''} ${s.title || s.code || ''} → ${s.status}`);
    L.push('');
  }
  if (digest.logs.length) {
    L.push('## Logs', '');
    for (const l of digest.logs) L.push(`- [${l.level}] L${l.line}: ${short(l.message, 500)}`);
    L.push('');
  }
  L.push('## Executed steps', '');
  for (const s of digest.steps) L.push(`- L${s.line} ${s.displayId || ''} ${s.title || s.code || ''} → ${s.status || '?'}`);
  if (digest.outputPayload) L.push('', '## Output payload', '', '```json', short(digest.outputPayload, 4000), '```');
  return `${L.join('\n')}\n`;
}

export function listRuns(dir) {
  const r = join(dir, 'runs');
  return existsSync(r) ? readdirSync(r).sort() : [];
}
