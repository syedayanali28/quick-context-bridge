// Phase 3 write-back logic (pure functions; the Apply page does the I/O).
//
// Protocol (verified on a sandbox copy, 2026-11-12):
//   POST ~/validate-automation {workflowModel} -> {status:"VALID"|"INVALID", errors:[{actionId:"<1-based line>",
//        errorCode, errorMessages[], propertyId}]}. It saves nothing, and it does NOT check the Python inside _("...").
//   POST ~/acquire-lock -> {lockStatus:"ACQUIRED"|"HELD_BY_OTHER", expiresAt, userId}. ~3 min TTL, non-reentrant,
//        and release propagates after a moment. The server does NOT require the lock to save, so we take it to
//        avoid clobbering an open editor.
//   PUT ~/workflows {workflowModel, runtimeConfiguration, lastModifiedTime, ...} -> {lastModifiedTime, ...}.
//        A stale lastModifiedTime -> 409 "modified by another user" (server-side optimistic concurrency).
//   POST ~/release-lock -> {lockStatus:"RELEASED"|"NOT_HELD"}

import { parseQal, walk } from './qal.js';
import { readPyString, stringStartAt } from './pysrc.js';
import { diffLines, hunks, unified, diffStats } from './diff.js';

/** Find every _("...") wrapper in QAL source. */
export function findExpressions(src) {
  const out = [];
  const re = /\b_\(\s*(?=[rRbBfFuU]{0,2}["'])/g;
  let m;
  let line = 1;
  let pos = 0;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let lit;
    try { lit = readPyString(src, start); } catch { continue; }
    for (; pos < m.index; pos++) if (src.charCodeAt(pos) === 10) line++;
    out.push({ line, expr: lit.value });
    re.lastIndex = lit.end;
  }
  return out;
}

/** Cheap structural check of a Python expression: balanced brackets and terminated strings. */
export function checkExpression(expr) {
  const s = String(expr);
  const stack = [];
  const close = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '#') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (stringStartAt(s, i) >= 0) {
      try { i = readPyString(s, i).end - 1; continue; } catch { return 'unterminated string literal'; }
    }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (close[c]) {
      if (stack.pop() !== close[c]) return `unbalanced '${c}'`;
    }
  }
  if (stack.length) return `unclosed '${stack[stack.length - 1]}'`;
  return null;
}

/**
 * Local lint that complements the server validator.
 * @param {string} src new QAL
 * @param {{runtimeConfiguration?:object}} [live] live workflow (to check connector refs)
 * @returns {{errors:Array<{line:number|null, message:string}>, warnings:Array<{line:number|null, message:string}>, parsed:object}}
 */
export function lintQal(src, live) {
  const errors = [];
  const warnings = [];
  let parsed = null;
  try {
    parsed = parseQal(src);
  } catch (e) {
    errors.push({ line: null, message: `QAL could not be parsed: ${e.message}` });
    return { errors, warnings, parsed };
  }
  for (const w of parsed.warnings) {
    const m = w.match(/^Line (\d+): (.*)$/);
    warnings.push({ line: m ? Number(m[1]) : null, message: m ? m[2] : w });
  }
  if (!parsed.qalVersion) errors.push({ line: null, message: 'Missing __qal_version__(...) line at the end' });
  if (parsed.ioSchema && parsed.ioSchema.raw !== undefined) errors.push({ line: 1, message: 'ioschema is not valid JSON' });
  if (!parsed.nodes.length) errors.push({ line: null, message: 'def main() is missing or empty' });

  for (const e of findExpressions(src)) {
    const problem = checkExpression(e.expr);
    if (problem) errors.push({ line: e.line, message: `Expression ${problem}: ${e.expr.slice(0, 120)}` });
  }

  const ids = new Map();
  for (const b of parsed.codeBlocks) {
    if (ids.has(b.id)) errors.push({ line: b.line, message: `Duplicate code block id ${b.id}` });
    ids.set(b.id, b);
    if (!b.usedBy.length) warnings.push({ line: b.line, message: `Code block ${b.id} is never invoked` });
  }
  const connectors = (live && live.runtimeConfiguration && live.runtimeConfiguration.resourceConfiguration
    && live.runtimeConfiguration.resourceConfiguration.CONNECTOR) || null;
  walk(parsed.nodes, (n) => {
    if (n.kind === 'code_block' && n.codeBlockId && !ids.has(n.codeBlockId)) {
      errors.push({ line: n.line, message: `invoke_code_block references unknown id ${n.codeBlockId}` });
    }
    if (connectors && n.connectorRef && !connectors[n.connectorRef]) {
      errors.push({ line: n.line, message: `Connector ${n.connectorRef} is not configured for this automation` });
    }
  });
  return { errors, warnings, parsed };
}

function nodeSignature(n) {
  return `${n.kind}|${n.title || ''}|${n.target || ''}`;
}

function nodeContent(n) {
  const { line, displayId, children, deactivated, ...rest } = n;
  return JSON.stringify({ ...rest, deactivated: !!deactivated });
}

/** Compare two parsed QAL trees at the level a reviewer cares about. */
export function semanticDiff(oldP, newP) {
  const collect = (p) => {
    const map = new Map();
    walk(p.nodes, (n) => {
      if (['else', 'try', 'break', 'continue'].includes(n.kind)) return;
      const sig = nodeSignature(n);
      if (!map.has(sig)) map.set(sig, []);
      map.get(sig).push(n);
    });
    return map;
  };
  const a = collect(oldP);
  const b = collect(newP);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [sig, list] of b) {
    const prev = a.get(sig) || [];
    list.forEach((n, i) => {
      if (!prev[i]) added.push(n);
      else if (nodeContent(prev[i]) !== nodeContent(n)) changed.push({ before: prev[i], after: n });
    });
  }
  for (const [sig, list] of a) {
    const next = b.get(sig) || [];
    list.forEach((n, i) => { if (!next[i]) removed.push(n); });
  }
  const blocksA = new Map(oldP.codeBlocks.map((x) => [x.id, x]));
  const blocksB = new Map(newP.codeBlocks.map((x) => [x.id, x]));
  const codeBlocks = {
    added: [...blocksB.keys()].filter((k) => !blocksA.has(k)),
    removed: [...blocksA.keys()].filter((k) => !blocksB.has(k)),
    changed: [...blocksB.keys()].filter((k) => blocksA.has(k) && (blocksA.get(k).source !== blocksB.get(k).source
      || blocksA.get(k).params.join(',') !== blocksB.get(k).params.join(','))),
  };
  return {
    added, removed, changed, codeBlocks,
    ioSchemaChanged: JSON.stringify(oldP.ioSchema) !== JSON.stringify(newP.ioSchema),
  };
}

/** Describe a node for the review list. */
export function nodeLabel(n) {
  return `${n.displayId ? `${n.displayId} · ` : ''}${n.title || n.kind}${n.deactivated ? ' (deactivated)' : ''} [${n.kind}]`;
}

/**
 * Decide whether an apply can proceed.
 *
 * Lineage is decided by content, not names:
 *  - same automation as the export: conflict only if the Live *content* moved on since the export
 *    (sha256 differs; a re-save without changes is fine).
 *  - another automation (e.g. a sandbox copy): ok if its Live content is identical to the exported version;
 *    a diverged copy (< 50% of lines differ) needs an explicit overwrite; anything else is a different automation.
 *
 * @param {{manifest?:object, target:{groupId:string, automationId:string}, live:object, newQal:string,
 *          isSandboxCopy?:boolean, liveSha256?:string, rewriteShare?:number}} p
 *   liveSha256: sha256 of live.workflowModel; rewriteShare: share of live lines the new QAL replaces (0..1).
 * @returns {{status:'ok'|'conflict'|'noop'|'error', reasons:string[], baseLastModifiedTime:number|null,
 *            relation:'same'|'copy-identical'|'copy-diverged'|'unknown'|null}}
 */
export function planApply({ manifest, target, live, newQal, isSandboxCopy = false, liveSha256 = null, rewriteShare = null }) {
  const reasons = [];
  const out = (status, relation, baseLastModifiedTime) => ({ status, reasons, baseLastModifiedTime, relation });
  if (!live || typeof live.workflowModel !== 'string') { reasons.push('Live workflow not loaded'); return out('error', null, null); }
  if (manifest && manifest.redacted) {
    reasons.push('This export is redacted. Redacted QAL cannot be imported back.');
    return out('error', null, null);
  }
  if (newQal === live.workflowModel) {
    reasons.push('The new QAL is identical to the Live version');
    return out('noop', null, live.lastModifiedTime);
  }
  const lmt = live.lastModifiedTime;
  if (!manifest || !manifest.source) {
    reasons.push('No export-manifest.json provided, so the change is checked against the current Live version only.');
    return out('ok', 'unknown', lmt);
  }

  const s = manifest.source;
  const exportName = (manifest.automation && manifest.automation.name) || s.automationId;
  const baseSha = manifest.qal && manifest.qal.sha256;
  const contentUnchanged = !!(liveSha256 && baseSha && liveSha256 === baseSha);
  const sameAutomation = (!s.automationId || s.automationId === target.automationId)
    && (!s.automationGroupId || s.automationGroupId === target.groupId);

  if (sameAutomation) {
    const exportLmt = manifest.automation ? manifest.automation.lastModifiedTime : null;
    if (isSandboxCopy || contentUnchanged || exportLmt == null || exportLmt === lmt) {
      if (contentUnchanged && exportLmt != null && exportLmt !== lmt) {
        reasons.push('The Live version was re-saved since the export, but its content is unchanged.');
      }
      return out('ok', 'same', lmt);
    }
    reasons.push(`The Live version changed since this export (exported ${fmt(exportLmt)}, live now ${fmt(lmt)}). `
      + 'Saving would discard those changes. Re-export and re-apply your edits, or explicitly choose to overwrite.');
    return out('conflict', 'same', exportLmt);
  }

  // A different automation: accept it as a copy of the exported one when the content says so.
  if (contentUnchanged) {
    reasons.push(`The target is a copy of "${exportName}": its Live version is identical to the exported version, so the change applies cleanly.`);
    return out('ok', 'copy-identical', lmt);
  }
  if (rewriteShare !== null && rewriteShare < 0.5) {
    reasons.push(`The target looks like a copy of "${exportName}" (${Math.round(rewriteShare * 100)}% of its lines would change), `
      + 'but its Live version differs from the exported version. Saving replaces those differences. Review the diff, then tick "overwrite" if that is intended.');
    return out('conflict', 'copy-diverged', lmt);
  }
  reasons.push(`This export is from a different automation, "${exportName}" (${s.automationId}), and the target's content does not match it. `
    + 'Open that automation (or a copy of it) in Quick, then open "Apply changes…" from the extension popup on that tab.');
  return out('error', null, null);
}

function fmt(t) {
  if (typeof t !== 'number') return String(t);
  return new Date((t > 1e12 ? t : t * 1000)).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/**
 * Body for PUT ~/workflows. Fields mirror the console's UpdateWorkflow serializer; nulls are omitted.
 * @param {object} live current GET ~/workflow response
 * @param {string} newQal
 * @param {number} lastModifiedTime the version we are replacing (server rejects with 409 if it moved on)
 */
export function buildPutBody(live, newQal, lastModifiedTime) {
  const body = {
    workflowModel: newQal,
    runtimeConfiguration: live.runtimeConfiguration,
    lastModifiedTime,
  };
  for (const k of ['manifest', 'displayIds', 'executionMode']) {
    if (live[k] !== null && live[k] !== undefined) body[k] = live[k];
  }
  return body;
}

/** Attach QAL line text to server validation errors (actionId is the 1-based line number). */
export function mapValidationErrors(errors, src) {
  const lines = src.split('\n');
  return (errors || []).map((e) => {
    const n = Number(e.actionId);
    const line = Number.isInteger(n) && n >= 1 && n <= lines.length ? n : null;
    return {
      line,
      code: e.errorCode,
      message: (e.errorMessages || []).join('; '),
      property: e.propertyId,
      text: line ? lines[line - 1].trim().slice(0, 200) : null,
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lock → save → verify → release. `call(kind, path, opts)` performs I/O and returns {ok, status, body}
 * (kind is 'read' or 'write'). Never commits.
 * @param {{call:Function, groupId:string, automationId:string, live:object, newQal:string,
 *          baseLastModifiedTime:number, log?:(msg:string, cls?:string)=>void, lockRetries?:number, retryDelayMs?:number}} p
 * @returns {Promise<{ok:boolean, reason?:string, lastModifiedTime?:number}>}
 */
export async function saveLive(p) {
  const { call, groupId, automationId, live, newQal, baseLastModifiedTime } = p;
  const log = p.log || (() => {});
  const retries = p.lockRetries ?? 4;
  const delay = p.retryDelayMs ?? 1500;
  const base = `/automation-groups/${groupId}/automations/${automationId}`;

  let lock = null;
  for (let i = 0; i <= retries; i++) {
    lock = await call('write', `${base}/acquire-lock`, { method: 'POST', body: {} });
    const st = lock.body && lock.body.lockStatus;
    if (lock.ok && st === 'ACQUIRED') break;
    if (i < retries) { log(`Lock busy (${st || `HTTP ${lock.status}`}), retrying…`); await sleep(delay); }
  }
  const lockStatus = lock && lock.body && lock.body.lockStatus;
  if (!lock || !lock.ok || lockStatus !== 'ACQUIRED') {
    const who = lock && lock.body && lock.body.userId ? ` by ${lock.body.userId}` : '';
    const reason = `Could not take the edit lock (${lockStatus || (lock && lock.body && lock.body.message) || `HTTP ${lock && lock.status}`}${who}). `
      + 'Close any open editor tab for this automation (it holds the lock), wait a minute, and retry.';
    log(reason, 'err');
    return { ok: false, reason };
  }
  log(`Edit lock acquired (expires ${lock.body.expiresAt ? new Date(lock.body.expiresAt * 1000).toLocaleTimeString() : '?'})`, 'ok');

  try {
    const put = await call('write', `${base}/workflows`, { method: 'PUT', body: buildPutBody(live, newQal, baseLastModifiedTime) });
    if (put.status === 409) {
      const reason = `Quick rejected the save: ${(put.body && put.body.message) || 'modified by another user'}. Nothing was changed.`;
      log(reason, 'err');
      return { ok: false, reason };
    }
    if (!put.ok) {
      const reason = `Save failed (HTTP ${put.status}): ${JSON.stringify(put.body).slice(0, 300)}`;
      log(reason, 'err');
      return { ok: false, reason };
    }
    log(`Saved. New lastModifiedTime ${put.body && put.body.lastModifiedTime}`, 'ok');

    const after = await call('read', `${base}/workflow`, {});
    if (!after.ok || !after.body || after.body.workflowModel !== newQal) {
      const reason = 'Saved, but the read-back does not match the submitted QAL. Check the automation in the editor.';
      log(reason, 'err');
      return { ok: false, reason, lastModifiedTime: after.body && after.body.lastModifiedTime };
    }
    log('Verified: the Live version now matches the submitted QAL.', 'ok');
    return { ok: true, lastModifiedTime: after.body.lastModifiedTime };
  } finally {
    const rel = await call('write', `${base}/release-lock`, { method: 'POST', body: {} }).catch((e) => ({ ok: false, body: { message: e.message } }));
    log(`Edit lock released (${(rel.body && rel.body.lockStatus) || `HTTP ${rel.status}`})`);
  }
}

/** Quick's automation-name rule: [-.\w]+(?:\s*[-.\w]+)* */
export function sanitizeAutomationName(name) {
  const cleaned = String(name || '').replace(/[^-.\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Automation sandbox';
}

/**
 * Guard against applying the wrong automation's QAL (e.g. picking another export while a different
 * automation is open): if most of the Live version would be replaced, require an explicit override.
 */
export function largeRewriteReason(stats, liveLineCount, threshold = 0.5) {
  if (!liveLineCount) return null;
  const share = stats.removed / liveLineCount;
  if (share < threshold) return null;
  return `${Math.round(share * 100)}% of the Live version's lines would be replaced. That usually means the file is `
    + 'from a different automation. Check the target, or tick "overwrite" if this is intended.';
}

/** Everything the review screen needs, computed in one go. */
export function review(liveQal, newQal) {
  const d = diffLines(liveQal.split('\n'), newQal.split('\n'));
  const hs = hunks(d, 3);
  return { stats: diffStats(d), hunks: hs, unified: unified(hs) };
}
