import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeServer } from '../bridge/server.mjs';
import {
  BridgeClient, testRunConfiguration, startRunBody, findStatus, isTerminal, resolveRef, assertAllowed, push, sha256, summarizeRun, digestExecution,
} from '../bridge/lib/quick.mjs';

const TOKEN = 'a'.repeat(48);
const G = '11111111-2222-4333-8444-555555555555';
const A = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const QAL = readFileSync(new URL('./fixtures/sample.qal.py', import.meta.url), 'utf8');

function req(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

const EXT = { 'x-qcb-token': TOKEN, origin: 'chrome-extension://abcdefghijklmnop' };

test('bridge server relays a command from the CLI to the extension and back', async () => {
  const b = createBridgeServer({ token: TOKEN, pollTimeoutMs: 2000 });
  const port = await b.listen(0);
  try {
    // fake extension: poll once, answer
    const ext = (async () => {
      const p = await req(port, 'GET', '/ext/poll', { headers: EXT });
      assert.equal(p.status, 200);
      assert.equal(p.body.cmd, 'call');
      assert.equal(p.body.args.path, '/x');
      await req(port, 'POST', '/ext/result', { headers: EXT, body: { id: p.body.id, ok: true, result: { ok: true, status: 200, body: { hello: 'world' } } } });
    })();
    const client = new BridgeClient({ port, token: TOKEN });
    const r = await client.call('read', '/x');
    assert.deepEqual(r, { ok: true, status: 200, body: { hello: 'world' } });
    await ext;
    const s = await client.status();
    assert.equal(s.extensionConnected, true);
  } finally { await b.close(); }
});

test('bridge server rejects bad tokens and non-extension origins', async () => {
  const b = createBridgeServer({ token: TOKEN, pollTimeoutMs: 500 });
  const port = await b.listen(0);
  try {
    assert.equal((await req(port, 'GET', '/status', { headers: { 'x-qcb-token': 'nope' } })).status, 401);
    assert.equal((await req(port, 'GET', '/ext/poll', { headers: { 'x-qcb-token': TOKEN, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await req(port, 'GET', '/ext/poll', { headers: EXT })).status, 204, 'empty poll times out with 204');
  } finally { await b.close(); }
});

test('bridge server times out commands when no extension is connected', async () => {
  const b = createBridgeServer({ token: TOKEN });
  const port = await b.listen(0);
  try {
    const r = await req(port, 'POST', '/cmd', { headers: { 'x-qcb-token': TOKEN }, body: { cmd: 'ping', timeoutMs: 300 } });
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /Timed out/);
  } finally { await b.close(); }
});

test('test-run payload mirrors the console (TEST env, test task queues)', () => {
  const wf = {
    workflowArn: 'arn:aws:quicksight:us-east-1:1:automation-group/g/automation/a/workflow/wf123',
    runtimeConfiguration: { configurationVariables: { X: { configValue: '1' } }, resourceConfiguration: {
      CONNECTOR: { c: { resourceConfigValue: 'u' } },
      TASK_QUEUE: { q1: { resourceConfigValue: 'prod-queue' }, task_resource_permissions_q1: { resourceConfigValue: '[]' } },
    } },
  };
  const cfg = testRunConfiguration(wf);
  assert.equal(cfg.resourceConfiguration.TASK_QUEUE.q1.resourceConfigValue, 'wf123-test-task-queue');
  assert.equal(cfg.resourceConfiguration.TASK_QUEUE.task_resource_permissions_q1.resourceConfigValue, '[]');
  assert.equal(wf.runtimeConfiguration.resourceConfiguration.TASK_QUEUE.q1.resourceConfigValue, 'prod-queue', 'input not mutated');
  const body = startRunBody(wf, { a: 1 });
  assert.equal(body.environment, 'TEST');
  assert.equal(body.compiler, 'PYTHON');
  assert.equal(body.inputPayload, '{"a":1}');
  assert.equal(startRunBody(wf).inputPayload, undefined);
});

test('findStatus / isTerminal work on unknown response shapes', () => {
  assert.equal(findStatus({ workflowExecution: { workflowExecutionStatus: 'RUNNING' } }), 'RUNNING');
  assert.equal(findStatus({ status: 'SUCCEEDED' }), 'SUCCEEDED');
  assert.equal(isTerminal('RUNNING'), false);
  assert.equal(isTerminal('FAILED'), true);
});

test('digestExecution collapses event pairs and maps lines to canvas steps', () => {
  const execution = {
    workflowExecutionStatus: 'FAILED',
    actionExecutions: [
      { actionId: '5', status: 'RUNNING', executionStartTime: 1 },
      { actionId: '5', status: 'SUCCEEDED', executionEndTime: 2 },
      { actionId: '7', status: 'RUNNING', executionStartTime: 3 },
      { actionId: '7', status: 'FAILED', executionEndTime: 4, logs: [{ level: 'ERROR', message: 'boom', timestamp: 4 }] },
      { actionId: '2', status: null, logs: '[{"level":"INFO","message":"Execution finished","timestamp":5}]' },
    ],
  };
  const d = digestExecution(execution, QAL);
  assert.equal(d.status, 'FAILED');
  assert.equal(d.steps.length, 3);
  const s5 = d.steps.find((s) => s.line === 5);
  assert.equal(s5.status, 'SUCCEEDED');
  assert.equal(s5.displayId, 'Step 1');
  assert.equal(d.failed.length, 1);
  assert.equal(d.failed[0].displayId, 'Action 1.2');
  assert.deepEqual(d.logs.map((l) => l.message), ['boom', 'Execution finished']);
  assert.equal(d.errorLogs.length, 1);
  const md = summarizeRun({ status: 'FAILED', executionArn: 'arn:x', durationSec: 3, execution }, d);
  assert.match(md, /## Failed\n\n- L7 Action 1\.2 threshold → FAILED/);
  assert.match(md, /\[ERROR\] L7: boom/);
});

test('resolveRef + assertAllowed policy', () => {
  const url = `https://us-east-1.quicksight.aws.amazon.com/sn/account/Acme/automations/arn:aws:quicksight:us-east-1:123456789012:automation-group_${G}_automation_${A}/summary`;
  assert.deepEqual([resolveRef(url, {}).groupId, resolveRef(url, {}).automationId], [G, A]);
  assert.equal(resolveRef(`${G}/${A}`, {}).automationId, A);
  assert.equal(resolveRef('intake', { [A]: { groupId: G, alias: 'intake', name: 'X' } }).automationId, A);
  assert.throws(() => assertAllowed({ automationId: A, name: 'Prod thing' }, {}), /Not allowed/);
  assert.doesNotThrow(() => assertAllowed({ automationId: A, name: 'Thing - agent sandbox' }, {}));
  assert.doesNotThrow(() => assertAllowed({ automationId: A, name: 'Prod thing' }, { [A]: { allowed: true } }));
});

// ---- push() end to end against an in-memory fake Quick ------------------------------------------------

function fakeQuick(initialQal) {
  const state = { qal: initialQal, lmt: 100, lock: null, puts: 0 };
  const client = {
    async call(kind, path, { method, body } = {}) {
      if (path.endsWith('/workflow')) return { ok: true, status: 200, body: { workflowModel: state.qal, lastModifiedTime: state.lmt, runtimeConfiguration: { resourceConfiguration: { CONNECTOR: {
        action_connector_id_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a: {}, action_connector_id_0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b: {} } } } } };
      if (path.endsWith('/validate-automation')) return { ok: true, status: 200, body: { status: 'VALID', errors: [] } };
      if (path.endsWith('/acquire-lock')) { state.lock = 'me'; return { ok: true, status: 200, body: { lockStatus: 'ACQUIRED', expiresAt: 1 } }; }
      if (path.endsWith('/release-lock')) { state.lock = null; return { ok: true, status: 200, body: { lockStatus: 'RELEASED' } }; }
      if (path.endsWith('/workflows') && method === 'PUT') {
        if (body.lastModifiedTime !== state.lmt) return { ok: false, status: 409, body: { message: 'modified by another user' } };
        state.qal = body.workflowModel; state.lmt += 1; state.puts++;
        return { ok: true, status: 200, body: { lastModifiedTime: state.lmt } };
      }
      throw new Error(`unexpected ${kind} ${method} ${path}`);
    },
    async read(path, opts) { const r = await this.call('read', path, opts); return r.body; },
  };
  return { state, client };
}

test('push: validates, saves, re-bases the workspace manifest, then a second push is a clean follow-up', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'qcb-'));
  process.env.QCB_WORKSPACE = ws;
  writeFileSync(join(ws, 'targets.json'), JSON.stringify({ [A]: { groupId: G, name: 'Sample', allowed: true } }));
  const dir = join(ws, 'sample');
  mkdirSync(dir, { recursive: true });
  const { state, client } = fakeQuick(QAL);
  const manifest = { source: { automationGroupId: G, automationId: A }, automation: { lastModifiedTime: 100 }, qal: { sha256: sha256(QAL) } };
  writeFileSync(join(dir, 'export-manifest.json'), JSON.stringify(manifest));

  const edit1 = QAL.replace('Starting A04 — Portal item', 'Starting A04 — Portal item (agent)');
  writeFileSync(join(dir, 'automation.qal.py'), edit1);
  const r1 = await push(client, { groupId: G, automationId: A, name: 'Sample' }, dir);
  assert.equal(r1.ok, true, r1.reason);
  assert.equal(state.qal, edit1);
  assert.equal(state.lock, null, 'lock released');
  const m1 = JSON.parse(readFileSync(join(dir, 'export-manifest.json'), 'utf8'));
  assert.equal(m1.automation.lastModifiedTime, 101);
  assert.equal(m1.qal.sha256, sha256(edit1));

  const edit2 = edit1.replace('(agent)', '(agent v2)');
  writeFileSync(join(dir, 'automation.qal.py'), edit2);
  const r2 = await push(client, { groupId: G, automationId: A, name: 'Sample' }, dir);
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(state.puts, 2);

  // someone else edits Live -> conflict, nothing saved
  state.qal = `${state.qal}\n# human edit\n`; state.lmt = 500;
  writeFileSync(join(dir, 'automation.qal.py'), edit2.replace('v2', 'v3'));
  const r3 = await push(client, { groupId: G, automationId: A, name: 'Sample' }, dir);
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /Conflict/);
  assert.equal(state.puts, 2);

  // not allowed target
  await assert.rejects(push(client, { groupId: G, automationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Prod' }, dir), /Not allowed/);
  delete process.env.QCB_WORKSPACE;
});
