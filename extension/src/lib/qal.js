// Parse QAL (Quick Automation Language) source into a structured tree that mirrors the Quick Automate canvas.
//
// Observed QAL shape (v2.0.0):
//   _("ioschema").lhs = _("{...json schema of inputs/outputs...}")
//   def main():
//       with host() as h_xxxx:
//           with process_step(display_name="...", description_md_key="MD...") as step_xxxx:
//               _("var").lhs = _("<expr>")                                    # qal_display_name: Title
//               _("var").lhs = invoke_code_block(id="function_x", args=_("{...}"))  # qal_display_name: Title
//               _("var").lhs = qactions.<connector>.<Operation>(q_action_connector_id=_(...), k=_(...))
//               _("var").lhs = agents.agents.use_inline_agent(instruction=_(...), agent_mode=_(...), ...)
//               log.info(msg=_("..."))
//               _("<expr>")                                                   # single-line expression
//               if __deactivated_step__: <node>
//               if _("<cond>"): ... elif ...: ... else: ...
//               for x in _("<iterable>"): ...      while _("<cond>"): ...
//               try: ... except AutomationException as error: ...      (exception flow)
//           return _("{...outputs...}")
//   @code_block(title="function_x")
//   def function_x(a, b):
//       '''python
//       <user code>
//       '''
//   __qal_version__(2,0,0)

import {
  logicalLines, parseCall, parseValue, valueText, readPyString, stringLiteralText, dedent,
} from './pysrc.js';

const DISPLAY_TAG = /^qal_display_name:\s*(.*)$/;

/** Kinds that get a display number on the canvas, and the label prefix the UI uses. */
const NUMBER_PREFIX = {
  step: 'Step',
  code_block: 'Function',
  agent: 'Agent',
  action: 'Action',
  set_variable: 'Action',
  expression: 'Action',
  log: 'Action',
  case: 'Action',
  call: 'Action',
};

/**
 * @param {string} src QAL source (the `workflowModel` string)
 */
export function parseQal(src) {
  const lines = logicalLines(src);
  const result = {
    qalVersion: null,
    ioSchema: null,
    nodes: [],
    codeBlocks: [],
    warnings: [],
  };

  // ---- module level ----
  let i = 0;
  while (i < lines.length) {
    const L = lines[i];
    if (L.indent !== 0) { i++; continue; }
    const code = L.code.trim();

    if (code.startsWith('_("ioschema").lhs')) {
      const v = parseValue(code.slice(code.indexOf('=') + 1));
      if (v.type === 'expr') {
        try { result.ioSchema = JSON.parse(v.expr); } catch { result.ioSchema = { raw: v.expr }; }
      }
      i++;
      continue;
    }

    const ver = code.match(/^__qal_version__\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (ver) { result.qalVersion = `${ver[1]}.${ver[2]}.${ver[3]}`; i++; continue; }

    if (code.startsWith('def main(')) {
      const body = [];
      i++;
      while (i < lines.length && lines[i].indent > 0) body.push(lines[i++]);
      result.nodes = buildTree(body, result.warnings);
      continue;
    }

    if (code.startsWith('@code_block(')) {
      const deco = parseCall(code.slice(1));
      const titleArg = deco && deco.args.find((a) => a.name === 'title');
      const title = titleArg ? valueText(parseValue(titleArg.text)).replace(/^"|"$/g, '') : null;
      const def = lines[i + 1];
      const dm = def && def.code.match(/^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/);
      if (!dm) { result.warnings.push(`Line ${L.line + 1}: @code_block without def`); i++; continue; }
      const block = {
        id: dm[1],
        title,
        params: dm[2].split(',').map((p) => p.trim()).filter(Boolean),
        source: '',
        line: def.line + 1,
        endLine: def.endLine + 1,
        usedBy: [],
      };
      i += 2;
      const bodyLines = [];
      while (i < lines.length && lines[i].indent > 0) bodyLines.push(lines[i++]);
      if (bodyLines.length) {
        block.endLine = bodyLines[bodyLines.length - 1].endLine + 1;
        const first = bodyLines[0].code.trim();
        try {
          const s = readPyString(first, 0);
          // Quick treats the '''python … ''' body as raw source text (not a Python string), so use the raw
          // body: decoding escapes would turn "\n" / b"\xff" inside the user's code into real characters.
          block.source = dedent(s.body.replace(/^python[ \t]*\r?\n/, '')).replace(/\s+$/, '') + '\n';
        } catch {
          block.source = dedent(bodyLines.map((b) => b.code).join('\n')) + '\n';
          result.warnings.push(`Code block ${block.id}: body is not a '''python string`);
        }
      }
      result.codeBlocks.push(block);
      continue;
    }

    if (code) result.warnings.push(`Line ${L.line + 1}: unrecognised module-level statement`);
    i++;
  }

  // ---- cross-reference code blocks to their call sites ----
  const byId = new Map(result.codeBlocks.map((b) => [b.id, b]));
  walk(result.nodes, (n) => {
    if (n.kind === 'code_block' && n.codeBlockId && byId.has(n.codeBlockId)) {
      byId.get(n.codeBlockId).usedBy.push({ displayId: n.displayId, title: n.title, line: n.line });
    }
  });

  return result;
}

/** Depth-first traversal over nodes and their children/branches. */
export function walk(nodes, fn, parent = null) {
  for (const n of nodes) {
    fn(n, parent);
    if (n.children) walk(n.children, fn, n);
  }
}

// ---------------------------------------------------------------------------------------------------------

function buildTree(body, warnings) {
  // Convert indentation into a nested list: [{L, kids:[...]}]
  const root = { kids: [] };
  const stack = [{ indent: -1, node: root }];
  for (const L of body) {
    while (stack.length > 1 && L.indent <= stack[stack.length - 1].indent) stack.pop();
    const item = { L, kids: [] };
    stack[stack.length - 1].node.kids.push(item);
    if (/:\s*$/.test(L.code)) stack.push({ indent: L.indent, node: item });
  }

  const scope = { prefix: '', counter: 0 };
  return convert(root.kids, scope, { deactivated: false }, warnings);
}

function nextId(kind, scope) {
  const p = NUMBER_PREFIX[kind];
  if (!p) return null;
  scope.counter += 1;
  return `${p} ${scope.prefix}${scope.counter}`;
}

function convert(items, scope, ctx, warnings) {
  const out = [];
  for (let k = 0; k < items.length; k++) {
    const { L, kids } = items[k];
    const code = L.code.trim();
    const title = displayName(L.comment);
    const base = { line: L.line + 1 };

    // with host() as h:  -> transparent
    if (/^with\s+host\s*\(\s*\)\s+as\s+\w+\s*:$/.test(code)) {
      out.push(...convert(kids, scope, ctx, warnings));
      continue;
    }

    // with process_step(display_name=..., description_md_key=...) as step_x:
    let m = code.match(/^with\s+(process_step\(.*\))\s+as\s+(\w+)\s*:$/s);
    if (m) {
      const call = parseCall(m[1]);
      const args = kwargs(call);
      const node = {
        kind: 'step',
        ...base,
        title: args.display_name ? strOf(args.display_name) : title,
        description: args.description ? strOf(args.description) : null,
        descriptionKey: args.description_md_key ? strOf(args.description_md_key) : null,
        deactivated: ctx.deactivated || undefined,
      };
      node.displayId = nextId('step', scope);
      const inner = { prefix: `${node.displayId.replace(/^Step /, '')}.`, counter: 0 };
      node.children = convert(kids, inner, ctx, warnings);
      out.push(node);
      continue;
    }

    // with <h>.excel() as x:  -> an Excel session container (transparent for numbering)
    m = code.match(/^with\s+(\w+)\.(\w+)\s*\(\s*\)\s+as\s+(\w+)\s*:$/);
    if (m) {
      out.push({ kind: 'session', ...base, title: title || `${m[2]} session`, app: m[2], alias: m[3],
        children: convert(kids, scope, ctx, warnings) });
      continue;
    }

    // with <case>.acquire():  -> case lock inside "Process cases" (transparent for numbering)
    // and any other `with <expr>[ as x]:` block we don't know.
    m = code.match(/^with\s+(.+?)(?:\s+as\s+(\w+))?\s*:$/s);
    if (m) {
      const acq = m[1].match(/^(\w+)\.acquire\(\s*\)$/);
      out.push({
        kind: acq ? 'case_acquire' : 'block', ...base,
        title: title || (acq ? `Acquire case ${acq[1]}` : m[1].slice(0, 80)),
        expression: m[1], alias: m[2] || null,
        children: convert(kids, scope, ctx, warnings),
      });
      continue;
    }

    // if __deactivated_step__:  -> wrapper marking its children as deactivated
    if (/^if\s+__deactivated_step__\s*:$/.test(code)) {
      out.push(...convert(kids, scope, { ...ctx, deactivated: true }, warnings));
      continue;
    }

    // if / elif / else
    m = code.match(/^(if|elif)\s+(.*):$/s);
    if (m || code === 'else:') {
      const kind = m ? m[1] : 'else';
      const node = { kind, ...base, title };
      if (m) node.condition = valueText(parseValue(m[2]));
      if (ctx.deactivated) node.deactivated = true;
      node.children = convert(kids, scope, ctx, warnings);
      out.push(node);
      continue;
    }

    // for x in _("..."):
    m = code.match(/^for\s+(.+?)\s+in\s+(.*):$/s);
    if (m) {
      const iterable = valueText(parseValue(m[2]));
      const node = { kind: 'loop', ...base, title, itemVariable: m[1], iterable,
        deactivated: ctx.deactivated || undefined };
      if (/^deque_cases\s*\(/.test(m[2].trim())) {
        node.loopType = 'process_cases';
        const call = parseCall(m[2].trim());
        node.params = {};
        if (call) call.args.forEach((a, idx) => { node.params[a.name || `arg${idx}`] = valueText(parseValue(a.text)); });
      }
      node.children = convert(kids, scope, ctx, warnings);
      out.push(node);
      continue;
    }

    // while _("..."):
    m = code.match(/^while\s+(.*):$/s);
    if (m) {
      out.push({ kind: 'loop_while', ...base, title, condition: valueText(parseValue(m[1])),
        deactivated: ctx.deactivated || undefined, children: convert(kids, scope, ctx, warnings) });
      continue;
    }

    // try: / except X as e:   (exception flow)
    if (code === 'try:') {
      out.push({ kind: 'try', ...base, title, children: convert(kids, scope, ctx, warnings) });
      continue;
    }
    m = code.match(/^except\s*(.*?)\s*(?:as\s+(\w+))?\s*:$/);
    if (m) {
      const eScope = { prefix: `E${scope.prefix}`, counter: 0 };
      out.push({ kind: 'exception_flow', ...base, title: title || 'Exception flow', exceptionType: m[1] || null,
        errorVariable: m[2] || null, children: convert(kids, eScope, ctx, warnings) });
      continue;
    }

    if (code === 'pass') continue;
    if (code === 'break' || code === 'continue') { out.push({ kind: code, ...base }); continue; }

    // return _("{...}")  -> End process
    m = code.match(/^return\b\s*(.*)$/s);
    if (m) {
      out.push({ kind: 'end', ...base, title: title || 'End process', outputs: m[1] ? valueText(parseValue(m[1])) : null });
      continue;
    }

    // Statements with optional assignment target: _("t").lhs = <rhs>   |  <rhs>
    let target = null;
    let rhs = code;
    m = code.match(/^_\(\s*("(?:[^"\\]|\\.)*")\s*\)\.lhs\s*=\s*/s);
    if (m) {
      target = readPyString(m[1], 0).value.trim();
      rhs = code.slice(m[0].length);
    }
    const node = statementNode(rhs, target, title, base, warnings);
    if (ctx.deactivated) node.deactivated = true;
    node.displayId = nextId(node.kind, scope);
    if (kids.length) node.children = convert(kids, scope, ctx, warnings);
    out.push(node);
  }
  return out;
}

function statementNode(rhs, target, title, base, warnings) {
  // Pure expression wrapper: _("...")
  const v = parseValue(rhs);
  if (v.type === 'expr') {
    if (target) return { kind: 'set_variable', ...base, title: title || target, target, expression: v.expr };
    return { kind: 'expression', ...base, title: title || v.expr.slice(0, 80), expression: v.expr };
  }

  const call = parseCall(rhs);
  if (!call) {
    warnings.push(`Line ${base.line}: unrecognised statement`);
    return { kind: 'raw', ...base, title, target, code: rhs };
  }
  const args = kwargs(call);
  const c = call.callee;

  if (c === 'invoke_code_block') {
    return {
      kind: 'code_block', ...base, title, target,
      codeBlockId: args.id ? strOf(args.id) : null,
      arguments: args.args ? valueText(args.args) : null,
    };
  }

  if (c === 'agents.agents.use_inline_agent' || c.startsWith('agents.')) {
    const node = { kind: 'agent', ...base, title, target, function: c };
    for (const [k, val] of Object.entries(args)) {
      if (k === 'instruction') {
        const text = val.type === 'expr' ? stringLiteralText(val.expr) : null;
        node.instruction = text !== null ? text : valueText(val);
        node.instructionIsTemplate = text === null;
      } else if (k === 'agent_mode') {
        node.agentMode = jsonOr(valueText(val));
      } else if (k === 'agent_name') {
        node.agentName = strOf(val);
      } else if (k === 'outputSchema') {
        node.outputSchema = jsonOr(valueText(val));
      } else {
        node.params = node.params || {};
        node.params[k] = jsonOr(valueText(val));
      }
    }
    // Custom mode carries the model: {"mode":"custom","config":{"model_id":"...","q_action_connector_id":"..."}}
    if (node.agentMode && typeof node.agentMode === 'object' && node.agentMode.config) {
      node.model = node.agentMode.config.model_id || null;
    }
    node.title = node.title || node.agentName;
    return node;
  }

  if (c.startsWith('qactions.')) {
    const [, connector, operation] = c.split('.');
    const params = {};
    let connectorRef = null;
    for (const [k, val] of Object.entries(args)) {
      if (k === 'q_action_connector_id') {
        const mm = valueText(val).match(/action_connector_id_[0-9a-f]+/);
        connectorRef = mm ? mm[0] : valueText(val);
      } else {
        params[k] = valueText(val);
      }
    }
    return { kind: 'action', ...base, title: title || `${connector}.${operation}`, target, connector, operation,
      connectorRef, params };
  }

  if (c === 'log.info' || c.startsWith('log.')) {
    return { kind: 'log', ...base, title: title || 'Write log message', level: c.split('.')[1],
      message: args.msg ? valueText(args.msg) : call.args.map((a) => valueText(parseValue(a.text))).join(', ') };
  }

  const params = {};
  call.args.forEach((a, idx) => { params[a.name || `arg${idx}`] = valueText(parseValue(a.text)); });
  const kind = c.startsWith('case_management.') ? 'case' : 'call';
  return { kind, ...base, title: title || c, target, function: c, params };
}

function kwargs(call) {
  const out = {};
  if (!call) return out;
  call.args.forEach((a, idx) => { out[a.name || `arg${idx}`] = parseValue(a.text); });
  return out;
}

function strOf(v) {
  if (!v) return null;
  if (v.type === 'str') return v.value;
  if (v.type === 'expr') {
    const lit = stringLiteralText(v.expr);
    return lit !== null ? lit : v.expr;
  }
  return v.text;
}

function jsonOr(text) {
  if (typeof text !== 'string') return text;
  const t = text.trim();
  if (!/^[[{]/.test(t)) {
    const lit = stringLiteralText(t);
    return lit !== null ? lit : t;
  }
  try { return JSON.parse(t); } catch { return t; }
}

function displayName(comment) {
  if (!comment) return null;
  const m = comment.match(DISPLAY_TAG);
  return m ? m[1].trim() : null;
}
