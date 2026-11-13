import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQal, walk } from '../extension/src/lib/qal.js';
import { readPyString, logicalLines, parseCall, parseValue, stringLiteralText } from '../extension/src/lib/pysrc.js';

const SRC = readFileSync(new URL('./fixtures/sample.qal.py', import.meta.url), 'utf8');

function byTitle(nodes, title) {
  let hit = null;
  walk(nodes, (n) => { if (!hit && n.title === title) hit = n; });
  return hit;
}

test('readPyString handles escapes, prefixes and triple quotes', () => {
  assert.equal(readPyString('"a\\"b\\n"', 0).value, 'a"b\n');
  assert.equal(readPyString("r'a\\d'", 0).value, 'a\\d');
  const t = readPyString('f"""x\n"y"\n"""tail', 0);
  assert.equal(t.value, 'x\n"y"\n');
  assert.equal(t.prefix, 'f');
});

test('stringLiteralText collapses f-string brace escapes only', () => {
  assert.equal(stringLiteralText('f"""{{a}} {b}"""'), '{a} {b}');
  assert.equal(stringLiteralText('"{{a}}"'), '{{a}}');
  assert.equal(stringLiteralText('x + "y"'), null);
});

test('logicalLines joins bracketed continuations and captures comments', () => {
  const ls = logicalLines('a = f(1,\n  2) # note\nb = 3\n');
  assert.equal(ls.length, 2);
  assert.equal(ls[0].comment, 'note');
  assert.equal(ls[0].line, 0);
  assert.equal(ls[1].line, 2);
});

test('parseCall + parseValue read QAL kwargs', () => {
  const c = parseCall('qactions.x.Op(q_action_connector_id=_("q(\\"id\\")"), top=_("50"), id="function_1")');
  assert.equal(c.callee, 'qactions.x.Op');
  assert.deepEqual(c.args.map((a) => a.name), ['q_action_connector_id', 'top', 'id']);
  assert.deepEqual(parseValue(c.args[1].text), { type: 'expr', expr: '50' });
  assert.deepEqual(parseValue(c.args[2].text), { type: 'str', value: 'function_1' });
});

test('module level: version, io schema, code blocks', () => {
  const p = parseQal(SRC);
  assert.equal(p.qalVersion, '2.0.0');
  assert.deepEqual(Object.keys(p.ioSchema.outputs.properties), ['items_discovered', 'cases_created']);
  assert.deepEqual(p.codeBlocks.map((b) => b.id), ['function_ad1c3d', 'function_36184d', 'function_51f7d3']);
  const v = p.codeBlocks[1];
  assert.deepEqual(v.params, ['run_mode']);
  assert.match(v.source, /^mode = str\(run_mode/);
  assert.match(v.source, /\nreturn \{"valid"/);
  assert.deepEqual(p.warnings, []);
});

test('display ids follow canvas numbering', () => {
  const p = parseQal(SRC);
  const ids = [];
  walk(p.nodes, (n) => { if (n.displayId) ids.push(`${n.displayId} ${n.title}`); });
  assert.deepEqual(ids, [
    'Step 1 Variables',
    'Action 1.1 Run Start Timestamp',
    'Action 1.2 threshold',
    'Function 1.3 Combine govt clinic names',
    'Step 2 A02 — Validate and route invocation',
    'Function 2.1 Validation',
    'Step 2.2 A03 - Outlook input adapter and extrator',
    'Action 2.2.1 Starting A03 — Existing email extraction and OCR',
    'Step 2.2.2 Email folder extraction',
    'Action 2.2.2.1 email_metadata',
    'Action 2.2.2.2 user_id',
    'Action 2.2.2.3 List mail folders',
    'Function 2.2.2.4 Pick Pending folder',
    'Step 2.2.3 Read Photo',
    'Agent 2.2.3.1 Attachment Quality Gate',
    'Action 2.2.3.2 Append to message_ocr_results',
    'Action 2.2.3.3 Upload file',
    'Action 2.2.3.4 OCR skipped',
    'Action E2.2.3.1 execption error log',
    'Action 2.2.4 Create new workbook',
    'Action 2.2.5 current_case_input',
    'Action 2.2.6 Create Case',
    'Action 2.3 Starting A04 — Portal item',
    'Action 2.4 Starting A05 — Existing CL',
    'Action 2.5 Write log message',
    'Action 2.6 run_status',
  ]);
});

test('process cases loop and case acquire block', () => {
  const p = parseQal(SRC);
  const loop = byTitle(p.nodes, 'Process Ready Cases');
  assert.equal(loop.loopType, 'process_cases');
  assert.deepEqual(loop.params, { case_type: '"claim-adjudication"' });
  assert.equal(loop.children[0].kind, 'case_acquire');
  assert.equal(loop.children[0].children[0].title, 'current_case_input');
  assert.deepEqual(p.warnings, []);
});

test('node details: action, agent, deactivated, loop, exception flow, end', () => {
  const p = parseQal(SRC);
  const a = byTitle(p.nodes, 'List mail folders');
  assert.equal(a.kind, 'action');
  assert.equal(a.connector, 'msexchange_v2');
  assert.equal(a.operation, 'ListMailFolders');
  assert.equal(a.connectorRef, 'action_connector_id_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
  assert.equal(a.target, 'outlook_folder_list');
  assert.deepEqual(a.params, { user_id: 'user_id', include_hidden_folders: 'False', top: '50' });

  const ag = byTitle(p.nodes, 'Attachment Quality Gate');
  assert.equal(ag.kind, 'agent');
  assert.deepEqual(ag.agentMode, { mode: 'pro' });
  assert.equal(ag.agentName, 'Attachment Quality Gate');
  assert.match(ag.instruction, /^CLAIMS ATTACHMENT OCR QUALITY GATE\n\nReturn JSON like \{\n {2}"is_logo": false\n\}\nUser: \{user_id\}$/);
  assert.equal(ag.outputSchema.required[0], 'attachment_quality_raw');

  assert.equal(byTitle(p.nodes, 'Pick Pending folder').deactivated, true);
  assert.equal(byTitle(p.nodes, 'List mail folders').deactivated, undefined);

  const loop = byTitle(p.nodes, 'Loop through emails');
  assert.equal(loop.kind, 'loop');
  assert.equal(loop.itemVariable, 'current_mail');
  assert.equal(loop.iterable, 'outlook_messages');

  let exc = null;
  walk(p.nodes, (n) => { if (n.kind === 'exception_flow') exc = n; });
  assert.equal(exc.exceptionType, 'AutomationException');
  assert.equal(exc.errorVariable, 'error');

  const ends = [];
  walk(p.nodes, (n) => { if (n.kind === 'end') ends.push(n); });
  assert.equal(ends.length, 2);
  assert.match(ends[0].outputs, /"items_discovered": items_discovered/);

  const expr = byTitle(p.nodes, 'Append to message_ocr_results');
  assert.equal(expr.kind, 'expression');
  assert.equal(expr.expression, 'message_ocr_results.append(validated_document)');

  const ifValid = byTitle(p.nodes, 'If valid');
  assert.equal(ifValid.kind, 'if');
  assert.equal(ifValid.condition, 'validation["valid"]');
});

test('code block source keeps escape sequences verbatim (raw source, not a decoded string)', () => {
  const src = "def main():\n    with host() as h:\n        pass\n\n@code_block(title=\"function_aaaaaa\")\n"
    + "def function_aaaaaa(t):\n    '''python\n    t = t.replace(\"\\n\", \"\")\n    if t[0:2] != b\"\\xff\\xd8\":\n        return t\n    '''\n\n__qal_version__(2,0,0)\n";
  const p = parseQal(src);
  assert.equal(p.codeBlocks[0].source, 't = t.replace("\\n", "")\nif t[0:2] != b"\\xff\\xd8":\n    return t\n');
});

test('custom-mode agent exposes its model id', () => {
  const src = 'def main():\n    with host() as h:\n        _("r").lhs = agents.agents.use_inline_agent(instruction=_("\\"hi\\""), '
    + 'agent_mode=_("{\\"mode\\": \\"custom\\", \\"config\\": {\\"model_id\\": \\"us.anthropic.claude-3-5-sonnet-20241022-v2:0\\"}}"), '
    + 'agent_name=_("\\"X\\"")) # qal_display_name: X\n';
  const p = parseQal(src);
  assert.equal(p.nodes[0].model, 'us.anthropic.claude-3-5-sonnet-20241022-v2:0');
  assert.equal(p.nodes[0].instruction, 'hi');
});

test('code blocks are cross-referenced to call sites', () => {
  const p = parseQal(SRC);
  const b = p.codeBlocks.find((x) => x.id === 'function_51f7d3');
  assert.deepEqual(b.usedBy.map((u) => u.displayId), ['Function 2.2.2.4']);
});

test('parser is robust to a statement it does not know', () => {
  const p = parseQal('def main():\n    with host() as h:\n        weird stuff here\n__qal_version__(2,0,0)\n');
  assert.equal(p.qalVersion, '2.0.0');
  assert.equal(p.warnings.length, 1);
});
