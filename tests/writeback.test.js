import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffLines, hunks, unified, diffStats } from '../extension/src/lib/diff.js';
import { parseQal } from '../extension/src/lib/qal.js';
import {
  findExpressions, checkExpression, lintQal, semanticDiff, planApply, buildPutBody, mapValidationErrors, saveLive,
  sanitizeAutomationName, review,
} from '../extension/src/lib/writeback.js';

const QAL = readFileSync(new URL('./fixtures/sample.qal.py', import.meta.url), 'utf8');
const G = '11111111-2222-4333-8444-555555555555';
const A = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const LIVE = {
  workflowModel: QAL,
  lastModifiedTime: 1794449000.5,
  manifest: null, displayIds: null, executionMode: null,
  runtimeConfiguration: { configurationVariables: {}, resourceConfiguration: { CONNECTOR: {
    action_connector_id_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a: { resourceConfigValue: 'c1' },
    action_connector_id_0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b: { resourceConfigValue: 'c2' },
  } } },
};
const MANIFEST = { source: { automationGroupId: G, automationId: A }, automation: { lastModifiedTime: 1794449000.5 } };

function apply(diff) {
  return diff.filter((d) => d.op !== 'del').map((d) => d.text);
}

test('diffLines reconstructs the target and is minimal for a one-line edit', () => {
  const a = QAL.split('\n');
  const b = [...a];
  b[10] = `${b[10]} # edited`;
  b.splice(20, 0, 'new line');
  b.splice(40, 1);
  const d = diffLines(a, b);
  assert.deepEqual(apply(d), b);
  assert.deepEqual(diffStats(d), { added: 2, removed: 2 });
  const hs = hunks(d, 3);
  assert.equal(hs.length, 3);
  assert.equal(hs[0].aStart, 8);
  const u = unified(hs);
  assert.match(u, /^--- live\/automation\.qal\.py\n\+\+\+ new\/automation\.qal\.py\n@@ -8,7 \+8,7 @@/);
});

test('diffLines handles empty sides and total rewrites', () => {
  assert.deepEqual(apply(diffLines([], ['a', 'b'])), ['a', 'b']);
  assert.deepEqual(apply(diffLines(['a'], [])), []);
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
  const d = diffLines(a, b); // exceeds MAX_D -> falls back to replace-all
  assert.deepEqual(apply(d), b);
  assert.deepEqual(review('x\ny', 'x\ny').hunks, []);
});

test('findExpressions + checkExpression', () => {
  const ex = findExpressions(QAL);
  assert.ok(ex.length > 40);
  assert.ok(ex.some((e) => e.expr === 'runtime_config("THRESHOLD")' && e.line === 7));
  for (const e of ex) assert.equal(checkExpression(e.expr), null, `fixture expression flagged: ${e.expr}`);
  assert.equal(checkExpression('runtime_config("THRESHOLD"'), "unclosed '('");
  assert.equal(checkExpression('a[1)'), "unbalanced ')'");
  assert.equal(checkExpression('"abc'), 'unterminated string literal');
  assert.equal(checkExpression('f"{x}" + str(y["k"])'), null);
});

test('lintQal: clean fixture, then broken variants', () => {
  assert.deepEqual(lintQal(QAL, LIVE).errors, []);
  const badExpr = QAL.replace('runtime_config(\\"THRESHOLD\\")")', 'runtime_config(\\"THRESHOLD\\"")');
  const e1 = lintQal(badExpr, LIVE).errors;
  assert.equal(e1.length, 1);
  assert.equal(e1[0].line, 7);
  const badRef = QAL.replace('invoke_code_block(id="function_36184d"', 'invoke_code_block(id="function_zzzzzz"');
  assert.match(lintQal(badRef, LIVE).errors[0].message, /unknown id function_zzzzzz/);
  const badConn = QAL.replace('action_connector_id_0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', 'action_connector_id_0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c');
  assert.match(lintQal(badConn, LIVE).errors[0].message, /not configured/);
  const noVer = QAL.replace('__qal_version__(2,0,0)', '');
  assert.match(lintQal(noVer, LIVE).errors[0].message, /__qal_version__/);
});

test('semanticDiff reports changed, added and removed steps and code blocks', () => {
  const edited = QAL
    .replace('Starting A04 — Portal item\\""))', 'Starting A04 — Portal item v2\\""))')
    .replace('            _("validation").lhs', '            log.info(msg=_("\\"hello\\"")) # qal_display_name: Hello\n            _("validation").lhs')
    .replace(/\s*_\("threshold"\)\.lhs = [^\n]*\n/, '\n')
    .replace('mode in ("EMAIL", "PORTAL")', 'mode in ("EMAIL", "PORTAL", "API")');
  const s = semanticDiff(parseQal(QAL), parseQal(edited));
  assert.deepEqual(s.changed.map((c) => c.after.title), ['Starting A04 — Portal item']);
  assert.deepEqual(s.added.map((n) => n.title), ['Hello']);
  assert.deepEqual(s.removed.map((n) => n.title), ['threshold']);
  assert.deepEqual(s.codeBlocks.changed, ['function_36184d']);
  assert.equal(s.ioSchemaChanged, false);
});

test('planApply decisions', () => {
  const target = { groupId: G, automationId: A };
  const changed = `${QAL}\n`;
  assert.equal(planApply({ manifest: MANIFEST, target, live: LIVE, newQal: changed }).status, 'ok');
  assert.equal(planApply({ manifest: MANIFEST, target, live: LIVE, newQal: QAL }).status, 'noop');
  assert.equal(planApply({ manifest: { ...MANIFEST, redacted: true }, target, live: LIVE, newQal: changed }).status, 'error');
  const other = { ...MANIFEST, source: { automationGroupId: G, automationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } };
  assert.equal(planApply({ manifest: other, target, live: LIVE, newQal: changed }).status, 'error');
  assert.equal(planApply({ manifest: other, target, live: LIVE, newQal: changed, isSandboxCopy: true }).status, 'error',
    'a sandbox copies the target, so an export of another automation must still be rejected');
  const moved = { ...LIVE, lastModifiedTime: 1794449999 };
  const c = planApply({ manifest: MANIFEST, target, live: moved, newQal: changed });
  assert.equal(c.status, 'conflict');
  assert.equal(c.baseLastModifiedTime, 1794449000.5);
  const noMan = planApply({ manifest: null, target, live: moved, newQal: changed });
  assert.equal(noMan.status, 'ok');
  assert.equal(noMan.baseLastModifiedTime, 1794449999);
});

test('planApply decides lineage by content, not ids or names', () => {
  const target = { groupId: G, automationId: A };
  const changed = `${QAL}\n# agent edit\n`;
  const exportOfOther = {
    source: { automationGroupId: G, automationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    automation: { name: 'Claims Helper OP - Process Case', lastModifiedTime: 1 },
    qal: { sha256: 'abc' },
  };
  // A copy whose Live content is byte-identical to the exported version: clean apply.
  const copy = planApply({ manifest: exportOfOther, target, live: LIVE, newQal: changed, liveSha256: 'abc', rewriteShare: 0 });
  assert.equal(copy.status, 'ok');
  assert.equal(copy.relation, 'copy-identical');
  assert.equal(copy.baseLastModifiedTime, LIVE.lastModifiedTime, 'save is based on the target\'s own lastModifiedTime');
  assert.equal(planApply({ manifest: exportOfOther, target, live: LIVE, newQal: changed, isSandboxCopy: true, liveSha256: 'abc' }).status, 'ok');
  // A copy that has diverged a little: needs the explicit overwrite.
  const div = planApply({ manifest: exportOfOther, target, live: LIVE, newQal: changed, liveSha256: 'zzz', rewriteShare: 0.02 });
  assert.equal(div.status, 'conflict');
  assert.equal(div.relation, 'copy-diverged');
  // Mostly different content: a different automation.
  assert.equal(planApply({ manifest: exportOfOther, target, live: LIVE, newQal: changed, liveSha256: 'zzz', rewriteShare: 0.9 }).status, 'error');
  // Same automation, re-saved since export but content identical: not a conflict.
  const resaved = planApply({ manifest: { ...MANIFEST, qal: { sha256: 'abc' } }, target, live: { ...LIVE, lastModifiedTime: 99 }, newQal: changed, liveSha256: 'abc' });
  assert.equal(resaved.status, 'ok');
  assert.equal(resaved.baseLastModifiedTime, 99);
});

test('buildPutBody mirrors the console serializer and omits nulls', () => {
  const b = buildPutBody(LIVE, 'NEW', 123.5);
  assert.deepEqual(Object.keys(b).sort(), ['lastModifiedTime', 'runtimeConfiguration', 'workflowModel']);
  assert.equal(b.lastModifiedTime, 123.5);
  const b2 = buildPutBody({ ...LIVE, executionMode: 'X', manifest: { a: 1 } }, 'NEW', 1);
  assert.equal(b2.executionMode, 'X');
  assert.deepEqual(b2.manifest, { a: 1 });
});

test('mapValidationErrors attaches line text', () => {
  const m = mapValidationErrors([{ actionId: '3', errorCode: 'INVALID_SYNTAX', errorMessages: ['boom'], propertyId: ':' }], QAL);
  assert.equal(m[0].line, 3);
  assert.equal(m[0].text, 'def main():');
  assert.equal(mapValidationErrors([{ actionId: 'x', errorMessages: [] }], QAL)[0].line, null);
});

test('sanitizeAutomationName satisfies Quick\'s name pattern', () => {
  const re = /^[-.\w]+(?:\s*[-.\w]+)*$/;
  const n = sanitizeAutomationName('Claims Helper OP - Intake (agent sandbox)!');
  assert.equal(n, 'Claims Helper OP - Intake agent sandbox');
  assert.match(n, re);
});

// ---- saveLive against a fake server ----------------------------------------------------------------------

function fakeServer({ lockSeq = ['ACQUIRED'], putStatus = 200, readBack } = {}) {
  const calls = [];
  const seen = {};
  let locks = [...lockSeq];
  const call = async (kind, path, opts) => {
    calls.push(`${opts.method || 'GET'} ${path.split('/').pop()}`);
    if (path.endsWith('/acquire-lock')) {
      const st = locks.length > 1 ? locks.shift() : locks[0];
      return { ok: true, status: 200, body: { lockStatus: st, expiresAt: 1, userId: st === 'ACQUIRED' ? null : 'someone@example.com' } };
    }
    if (path.endsWith('/release-lock')) return { ok: true, status: 200, body: { lockStatus: 'RELEASED' } };
    if (path.endsWith('/workflows')) {
      if (putStatus === 409) return { ok: false, status: 409, body: { message: 'modified by another user' } };
      seen.body = opts.body;
      return { ok: true, status: 200, body: { lastModifiedTime: 2 } };
    }
    if (path.endsWith('/workflow')) return { ok: true, status: 200, body: { workflowModel: readBack ?? seen.body.workflowModel, lastModifiedTime: 2 } };
    throw new Error(`unexpected ${path}`);
  };
  return { call, calls, seen };
}

const P = { groupId: G, automationId: A, live: LIVE, newQal: 'NEW QAL', baseLastModifiedTime: 1794449000.5, retryDelayMs: 1 };

test('saveLive: success path locks, saves, verifies and releases', async () => {
  const s = fakeServer();
  const r = await saveLive({ ...P, call: s.call });
  assert.equal(r.ok, true);
  assert.equal(r.lastModifiedTime, 2);
  assert.deepEqual(s.calls, ['POST acquire-lock', 'PUT workflows', 'GET workflow', 'POST release-lock']);
  assert.equal(s.seen.body.lastModifiedTime, 1794449000.5);
  assert.equal(s.seen.body.workflowModel, 'NEW QAL');
});

test('saveLive: retries a briefly-busy lock', async () => {
  const s = fakeServer({ lockSeq: ['HELD_BY_OTHER', 'ACQUIRED'] });
  const r = await saveLive({ ...P, call: s.call });
  assert.equal(r.ok, true);
  assert.equal(s.calls.filter((c) => c.includes('acquire')).length, 2);
});

test('saveLive: never saves when the lock stays held', async () => {
  const s = fakeServer({ lockSeq: ['HELD_BY_OTHER'] });
  const r = await saveLive({ ...P, call: s.call, lockRetries: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /someone@example\.com/);
  assert.ok(!s.calls.some((c) => c.includes('workflows')));
  assert.ok(!s.calls.some((c) => c.includes('release')), 'must not release a lock we do not hold');
});

test('saveLive: 409 conflict reports and still releases the lock', async () => {
  const s = fakeServer({ putStatus: 409 });
  const r = await saveLive({ ...P, call: s.call });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Nothing was changed/);
  assert.equal(s.calls[s.calls.length - 1], 'POST release-lock');
});

test('saveLive: read-back mismatch is reported', async () => {
  const s = fakeServer({ readBack: 'SOMETHING ELSE' });
  const r = await saveLive({ ...P, call: s.call });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not match/);
  assert.equal(s.calls[s.calls.length - 1], 'POST release-lock');
});

test('largeRewriteReason flags applying a different automation', async () => {
  const { largeRewriteReason } = await import('../extension/src/lib/writeback.js');
  assert.equal(largeRewriteReason({ added: 3, removed: 0 }, 3510), null);
  assert.match(largeRewriteReason({ added: 3000, removed: 3400 }, 3510), /97% of the Live version/);
});
