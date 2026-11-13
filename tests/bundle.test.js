import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBundle, resolveConnectors } from '../extension/src/lib/bundle.js';
import { parseAutomationUrl, slugify } from '../extension/src/lib/ids.js';
import { makeZip, crc32 } from '../extension/src/lib/zip.js';
import { redactText } from '../extension/src/lib/redact.js';

const QAL = readFileSync(new URL('./fixtures/sample.qal.py', import.meta.url), 'utf8');
const URL_ = 'https://us-east-1.quicksight.aws.amazon.com/sn/account/Acme-Prod/automations/'
  + 'arn:aws:quicksight:us-east-1:123456789012:automation-group_11111111-2222-4333-8444-555555555555'
  + '_automation_66666666-7777-4888-9999-aaaaaaaaaaaa/workflow-builder';

const RAW = {
  ids: parseAutomationUrl(URL_),
  name: 'Claims Helper OP - Intake',
  pageUrl: URL_,
  workflow: {
    automationId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
    workflowArn: 'arn:aws:quicksight:us-east-1:123456789012:automation-group/x/automation/y/workflow',
    lastModifiedTime: 1794449000.5,
    workflowCompletionStatus: 'COMPLETE',
    workflowModel: QAL,
    runtimeConfiguration: {
      configurationVariables: { THRESHOLD: { configDescription: '', configValue: '80' } },
      resourceConfiguration: {
        CONNECTOR: {
          action_connector_id_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a: { resourceConfigDescription: '', resourceConfigValue: 'conn-outlook' },
          action_connector_id_0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b: { resourceConfigDescription: '', resourceConfigValue: 'conn-s3' },
        },
        CREDENTIAL: {},
        TASK_QUEUE: {},
      },
    },
  },
  associations: { associations: [
    { resourceType: 'Q_ACTION_CONNECTION', resourceArn: 'arn:x/conn-outlook', actionConnectorDetails: { id: 'conn-outlook', name: 'Mailbox Connection', type: 'MICROSOFT_OUTLOOK_V2', enabledActions: [] } },
  ] },
  actionGroups: { actionGroups: [
    { actionGroupId: 'conn-s3', actionGroupName: 'Docs S3 Connection', actionGroupType: 'AMAZON_S3', actionGroupProvider: 'QUICK_ACTIONS' },
  ] },
  actionSchemas: { actionGroups: [
    { actionGroupId: 'conn-s3', actionSchemas: JSON.stringify({ openapi: '3.0.0', paths: { '/upload': { post: { operationId: 'UploadFile' } } } }) },
  ] },
  versions: { workflowVersions: [{ versionId: '1.41', versionNumber: 17, description: 'note', creationTime: 1794370570.881, committedBy: 'arn:me' }] },
  errors: [],
};

test('parseAutomationUrl', () => {
  const ids = RAW.ids;
  assert.equal(ids.region, 'us-east-1');
  assert.equal(ids.awsAccountId, '123456789012');
  assert.equal(ids.groupId, '11111111-2222-4333-8444-555555555555');
  assert.equal(ids.automationId, '66666666-7777-4888-9999-aaaaaaaaaaaa');
  assert.equal(ids.quickAccount, 'Acme-Prod');
  assert.equal(ids.view, 'workflow-builder');
  assert.equal(parseAutomationUrl('https://example.com/x'), null);
  assert.equal(slugify('Claims Helper OP - Intake'), 'claims-helper-op-intake');
});

test('resolveConnectors uses associations and action groups', () => {
  const c = resolveConnectors(RAW.workflow, RAW.associations, RAW.actionGroups);
  assert.equal(c.action_connector_id_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a.name, 'Mailbox Connection');
  assert.equal(c.action_connector_id_0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b.name, 'Docs S3 Connection');
});

test('buildBundle produces the expected files', async () => {
  const b = await buildBundle(RAW, { now: new Date('2026-11-12T10:00:00Z') });
  const paths = b.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'PLATFORM.md', 'README.md',
    'actions/docs-s3-connection.openapi.json', 'actions/index.json',
    'agents/attachment-quality-gate.md',
    'automation.qal.py',
    'code-blocks/function_36184d.py', 'code-blocks/function_51f7d3.py', 'code-blocks/function_ad1c3d.py',
    'connections.json', 'context.json', 'export-manifest.json', 'outline.md', 'runtime-config.json', 'versions.json',
  ]);
  const get = (p) => b.files.find((f) => f.path === p).content;
  assert.equal(get('automation.qal.py'), QAL, 'QAL must be byte-identical');

  const manifest = JSON.parse(get('export-manifest.json'));
  assert.equal(manifest.qal.sha256.length, 64);
  assert.equal(manifest.automation.lastModifiedTime, 1794449000.5);
  assert.deepEqual(manifest.stats.deactivated, ['Function 2.2.2.4']);

  const ctx = JSON.parse(get('context.json'));
  assert.equal(ctx.schema, 'quick-automation-context/v1');
  assert.equal(ctx.flow[0].title, 'Variables');
  assert.equal(ctx.codeBlocks.length, 3);
  assert.equal(ctx.runtimeConfig.variables.THRESHOLD.value, '80');

  const outline = get('outline.md');
  assert.match(outline, /\*\*Action 2\.2\.2\.3\*\* · List mail folders — `msexchange_v2\.ListMailFolders` via _Mailbox Connection_/);
  assert.match(outline, /\| `function_51f7d3` \| `outlook_folders` \| Function 2\.2\.2\.4 Pick Pending folder \|/);

  const agent = get('agents/attachment-quality-gate.md');
  assert.match(agent, /Return JSON like \{\n {2}"is_logo": false\n\}/);

  const cb = get('code-blocks/function_36184d.py');
  assert.match(cb, /def function_36184d\(run_mode\):\n {4}mode = str/);

  const idx = JSON.parse(get('actions/index.json'));
  assert.equal(idx[0].usedByThisAutomation, true);
  assert.deepEqual(idx[0].operations, ['UploadFile']);

  assert.equal(b.summary.codeBlocks, 3);
  assert.equal(b.summary.unresolvedConnectors, 0);
  assert.match(b.folder, /^claims-helper-op-intake-202611121000$/);
});

test('redaction removes account ids and emails', async () => {
  const b = await buildBundle(RAW, { redact: true });
  for (const f of b.files) {
    assert.ok(!f.content.includes('123456789012'), `${f.path} leaks account id`);
    assert.ok(!f.content.includes('claims@example.com'), `${f.path} leaks email`);
    assert.ok(!f.content.includes('Acme-Prod'), `${f.path} leaks quick account`);
  }
  assert.equal(redactText('a b@c.io 123456789012', { awsAccountId: '123456789012' }), 'a <email> <aws-account-id>');
});

test('makeZip writes a valid store-only archive', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = makeZip([{ path: 'a/b.txt', content: 'hello' }, { path: 'c.json', content: '{"ü":1}' }]);
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2);
});
