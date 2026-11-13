#!/usr/bin/env node
// qcb: agent CLI for Amazon Quick Automate via the Quick Context Bridge extension.
//
//   qcb status                               bridge + extension connection, open Quick tabs
//   qcb allow <ref> [--name N] [--alias A]   permit the agent to push/run this automation
//   qcb pull <ref> [--dir D] [--no-actions]  export into the workspace (../quick-workspace/<slug>)
//   qcb check <ref> [--dir D]                lint + server validate + diff (saves nothing)
//   qcb push <ref> [--dir D] [--force]       validate, then save Live version (lock/verify/release)
//   qcb copy <ref> --name N                  create a copy (sandbox) and allow it
//   qcb run <ref> [--dir D] [--input JSON|@file] [--timeout S]
//                                            TEST run of the Live version; saves runs/<ts>-<status>/
//   qcb inspect <ref> <executionArn>         save/print an existing run (e.g. started from the editor)
//   qcb actions <ref> <executionArn>         dump per-action results of a run
//   qcb read <path> [--method M] [--body J]  raw read call (allowlisted endpoints only)
//
// <ref>: console URL | <groupId>/<automationId> | alias | workspace folder

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrCreateToken, DEFAULT_PORT } from './server.mjs';
import {
  BridgeClient, resolveRef, loadTargets, saveTargets, workspaceRoot, pull, check, push, copy, run, runActions, saveRun,
  describeSemantic, tabs, automationName, fetchExecution, digestExecution,
} from './lib/quick.mjs';
import { slugify } from '../extension/src/lib/ids.js';

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = (...a) => console.log(...a);

function dirFor(target, flags, name) {
  if (flags.dir) return flags.dir;
  const t = loadTargets()[target.automationId];
  return join(workspaceRoot(), (t && t.slug) || slugify(name || target.name || target.automationId));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const client = new BridgeClient({ port: Number(process.env.QCB_PORT) || DEFAULT_PORT, token: loadOrCreateToken() });

  switch (cmd) {
    case 'status': {
      const s = await client.status();
      out(`extension connected: ${s.extensionConnected} (last seen ${s.lastSeenMsAgo ?? '-'} ms ago)`);
      if (s.extensionConnected) {
        for (const t of await tabs(client)) out(`  tab ${t.tabId}: ${t.name || t.title} · hook=${t.hookVersion ?? 'none'} auth=${t.auth}${t.ids ? ` · ${t.ids.groupId}/${t.ids.automationId}` : ''}`);
      }
      out(`workspace: ${workspaceRoot()}`);
      return;
    }
    case 'allow': {
      const target = resolveRef(pos[0]);
      const targets = loadTargets();
      const name = flags.name || target.name || await automationName(client, target).catch(() => null) || target.automationId;
      targets[target.automationId] = { ...(targets[target.automationId] || {}), groupId: target.groupId, name, slug: slugify(name), alias: flags.alias || targets[target.automationId]?.alias, allowed: true, ids: target.ids };
      saveTargets(targets);
      out(`allowed: ${name} (${target.groupId}/${target.automationId})`);
      return;
    }
    case 'pull': {
      const target = resolveRef(pos[0]);
      const name = flags.name || await automationName(client, target);
      const r = await pull(client, target, { dir: dirFor(target, flags, name), includeActions: !flags['no-actions'], name });
      out(`pulled ${r.summary.name} → ${r.dir}`);
      out(JSON.stringify(r.summary));
      return;
    }
    case 'check': {
      const target = resolveRef(pos[0]);
      const dir = dirFor(target, flags);
      const c = await check(client, target, dir);
      printCheck(c);
      process.exitCode = c.server.status === 'VALID' && !c.lint.errors.length && ['ok', 'noop'].includes(c.plan.status) ? 0 : 2;
      return;
    }
    case 'push': {
      const target = resolveRef(pos[0]);
      const dir = dirFor(target, flags);
      const r = await push(client, target, dir, { force: !!flags.force, log: (m) => out(`  ${m}`) });
      printCheck(r.check);
      out(r.ok ? (r.noop ? 'NOOP: Live already matches' : `PUSHED: Live version saved (lastModifiedTime ${r.lastModifiedTime})`) : `NOT PUSHED: ${r.reason}`);
      process.exitCode = r.ok ? 0 : 2;
      return;
    }
    case 'copy': {
      const target = resolveRef(pos[0]);
      if (!flags.name) throw new Error('--name required');
      const c = await copy(client, target, flags.name);
      const targets = loadTargets();
      targets[c.automationId] = { groupId: c.groupId, name: c.name, slug: slugify(c.name), alias: flags.alias, allowed: true, copiedFrom: target.automationId };
      saveTargets(targets);
      out(`copied → ${c.name} (${c.groupId}/${c.automationId}), allowed`);
      return;
    }
    case 'run': {
      const target = resolveRef(pos[0]);
      const dir = dirFor(target, flags);
      let input;
      if (flags.input) input = String(flags.input).startsWith('@') ? readFileSync(String(flags.input).slice(1), 'utf8') : flags.input;
      const r = await run(client, target, { input, timeoutSec: Number(flags.timeout) || 900, log: (m) => out(`  ${m}`) });
      reportRun(r, dir, target, flags.note);
      process.exitCode = /SUCC|COMPLETE/i.test(r.status || '') ? 0 : 3;
      return;
    }
    case 'inspect': {
      // Fetch an existing run (e.g. one started from the editor) and save/print it like `run` does.
      const target = resolveRef(pos[0]);
      const dir = dirFor(target, flags);
      const execution = await fetchExecution(client, target, pos[1]);
      const r = { executionArn: pos[1], status: execution.workflowExecutionStatus, start: null, execution, actions: execution.actionExecutions, timedOut: false, durationSec: 0 };
      reportRun(r, dir, target, flags.note || 'Inspected existing run');
      return;
    }
    case 'actions': {
      const target = resolveRef(pos[0]);
      const acts = await runActions(client, target, pos[1]);
      out(JSON.stringify(acts, null, 2));
      return;
    }
    case 'read': {
      const body = flags.body ? JSON.parse(flags.body) : undefined;
      const r = await client.call('read', pos[0], { method: flags.method || (body ? 'POST' : 'GET'), body });
      out(JSON.stringify(r, null, 2).slice(0, Number(flags.max) || 20000));
      return;
    }
    default:
      out(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(1, 16).map((l) => l.slice(3)).join('\n'));
  }
}

function reportRun(r, dir, target, note) {
  if (existsSync(join(dir, 'automation.qal.py'))) {
    const { folder, digest } = saveRun(dir, r, { automation: { groupId: target.groupId, automationId: target.automationId, name: target.name }, note });
    out(`RUN ${r.status}${r.timedOut ? ' (timed out waiting)' : ''} · ${digest.steps.length} steps executed · ${digest.failed.length} failed · ${digest.logs.length} log lines`);
    out(`saved ${folder}`);
    for (const s of digest.failed) out(`  FAILED L${s.line} ${s.displayId || ''} ${s.title || s.code || ''}`);
    for (const l of digest.logs.slice(-30)) out(`  [${l.level}] L${l.line}: ${String(l.message).slice(0, 300)}`);
  } else {
    const digest = digestExecution(r.execution);
    out(`RUN ${r.status} · ${digest.steps.length} steps · ${digest.failed.length} failed (not saved: pull the automation into the workspace first)`);
    for (const l of digest.logs.slice(-30)) out(`  [${l.level}] L${l.line}: ${String(l.message).slice(0, 300)}`);
  }
}

function printCheck(c) {
  if (!c) return;
  out(`plan: ${c.plan.status}${c.plan.relation ? ` (${c.plan.relation})` : ''}`);
  for (const r of c.plan.reasons) out(`  - ${r}`);
  out(`lint: ${c.lint.errors.length} errors, ${c.lint.warnings.length} warnings`);
  for (const e of c.lint.errors.slice(0, 20)) out(`  L${e.line ?? '?'}: ${e.message}`);
  out(`server: ${c.server.status}`);
  for (const e of c.server.errors.slice(0, 20)) out(`  L${e.line ?? '?'}: ${e.code || ''} ${e.message}${e.text ? `\n      ${e.text}` : ''}`);
  out(`diff: +${c.diff.stats.added} / -${c.diff.stats.removed} lines, ${c.diff.hunks.length} hunks`);
  for (const s of describeSemantic(c.semantic).slice(0, 40)) out(`  ${s}`);
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
