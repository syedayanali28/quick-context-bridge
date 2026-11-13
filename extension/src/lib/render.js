// Render a parsed QAL tree as a compact Markdown outline for LLM agents and humans.

const ONE_LINE = 140;

function clip(s, n = ONE_LINE) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function code(s, n) {
  const t = clip(s, n).replace(/`/g, 'ʼ');
  return t ? `\`${t}\`` : '';
}

function label(n) {
  const id = n.displayId ? `**${n.displayId}** · ` : '';
  const off = n.deactivated ? ' _(deactivated)_' : '';
  return `${id}${n.title || ''}${off}`.trim();
}

function describe(n, ctx) {
  switch (n.kind) {
    case 'step':
      return `${label(n)} — _process step_`;
    case 'code_block': {
      const block = ctx.blocks.get(n.codeBlockId);
      const params = block ? `(${block.params.join(', ')})` : '';
      return `${label(n)} — code block \`${n.codeBlockId}${params}\`${n.target ? ` → \`${n.target}\`` : ''}`
        + ` · see \`code-blocks/${ctx.codeBlockFile(n.codeBlockId)}.py\``;
    }
    case 'agent': {
      const mode = n.agentMode && typeof n.agentMode === 'object' ? n.agentMode.mode : n.agentMode;
      return `${label(n)} — custom agent${mode ? ` (${mode}${n.model ? `, \`${n.model}\`` : ''})` : ''}${n.target ? ` → \`${n.target}\`` : ''}`
        + ` · see \`agents/${ctx.agentFile.get(n)}\``;
    }
    case 'action': {
      const conn = n.connectorRef ? ctx.connectorName(n.connectorRef) : null;
      const params = Object.entries(n.params || {}).map(([k, v]) => `${k}=${clip(v, 50)}`).join(', ');
      return `${label(n)} — \`${n.connector}.${n.operation}\`${conn ? ` via _${conn}_` : ''}`
        + `${params ? ` (${code(params, 160)})` : ''}${n.target ? ` → \`${n.target}\`` : ''}`;
    }
    case 'set_variable':
      return `${label(n)} — \`${n.target}\` = ${code(n.expression)}`;
    case 'expression':
      return `${label(n)} — expression ${code(n.expression)}`;
    case 'log':
      return `${label(n)} — log ${code(n.message)}`;
    case 'case':
    case 'call': {
      const params = Object.entries(n.params || {}).map(([k, v]) => `${k}=${clip(v, 50)}`).join(', ');
      return `${label(n)} — \`${n.function}\`${params ? ` (${code(params, 160)})` : ''}${n.target ? ` → \`${n.target}\`` : ''}`;
    }
    case 'if':
      return `**If** ${n.title ? `_${n.title}_ ` : ''}— ${code(n.condition)}${n.deactivated ? ' _(deactivated)_' : ''}`;
    case 'elif':
      return `**Else if** ${n.title ? `_${n.title}_ ` : ''}— ${code(n.condition)}`;
    case 'else':
      return '**Else**';
    case 'loop':
      return n.loopType === 'process_cases'
        ? `**Process cases** ${n.title ? `_${n.title}_ ` : ''}— each \`${n.itemVariable}\` from ${code(n.iterable)}`
        : `**Loop** ${n.title ? `_${n.title}_ ` : ''}— for \`${n.itemVariable}\` in ${code(n.iterable)}`;
    case 'case_acquire':
      return `**Acquire case** \`${n.expression}\``;
    case 'block':
      return `**with** ${code(n.expression)}${n.alias ? ` as \`${n.alias}\`` : ''}`;
    case 'loop_while':
      return `**Loop while** ${n.title ? `_${n.title}_ ` : ''}— ${code(n.condition)}`;
    case 'try':
      return '**Try** (protected by the exception flow below)';
    case 'exception_flow':
      return `**Exception flow**${n.exceptionType ? ` — catches \`${n.exceptionType}\`` : ''}${n.errorVariable ? ` as \`${n.errorVariable}\`` : ''}`;
    case 'session':
      return `**${n.app} session** \`${n.alias}\``;
    case 'end':
      return `**End process** — outputs ${code(n.outputs, 200)}`;
    case 'break':
    case 'continue':
      return `\`${n.kind}\``;
    default:
      return `${label(n)} ${code(n.code)}`;
  }
}

function lines(nodes, depth, ctx, out) {
  for (const n of nodes) {
    out.push(`${'  '.repeat(depth)}- ${describe(n, ctx)} <sub>L${n.line}</sub>`);
    if (n.children && n.children.length) lines(n.children, depth + 1, ctx, out);
  }
}

/**
 * @param {ReturnType<import('./qal.js').parseQal>} parsed
 * @param {{name:string, connectorName:(ref:string)=>string|null, agentFile:Map<object,string>, meta:object}} opts
 */
export function renderOutline(parsed, opts) {
  const ctx = {
    blocks: new Map(parsed.codeBlocks.map((b) => [b.id, b])),
    connectorName: opts.connectorName || (() => null),
    agentFile: opts.agentFile || new Map(),
    codeBlockFile: (id) => (opts.sameAs && opts.sameAs.get(id)) || id,
  };
  const out = [];
  out.push(`# ${opts.name || 'Automation'} — flow outline`);
  out.push('');
  out.push('Generated from `automation.qal.py` (the source of truth). Display IDs follow the canvas numbering;');
  out.push('`L<n>` is the line in `automation.qal.py`. Expressions are Python (RestrictedPython 3.10 subset).');
  out.push('');
  if (parsed.ioSchema) {
    const inputs = parsed.ioSchema.inputs && parsed.ioSchema.inputs.properties
      ? Object.keys(parsed.ioSchema.inputs.properties) : [];
    const outputs = parsed.ioSchema.outputs && parsed.ioSchema.outputs.properties
      ? Object.keys(parsed.ioSchema.outputs.properties) : [];
    out.push(`**Start inputs:** ${inputs.length ? inputs.map((x) => `\`${x}\``).join(', ') : '_none_'}  `);
    out.push(`**End outputs:** ${outputs.length ? outputs.map((x) => `\`${x}\``).join(', ') : '_none_'}`);
    out.push('');
  }
  out.push('## Flow');
  out.push('');
  lines(parsed.nodes, 0, ctx, out);
  out.push('');
  out.push('## Code blocks');
  out.push('');
  out.push('| Block | Parameters | Used by | Lines |');
  out.push('|---|---|---|---|');
  for (const b of parsed.codeBlocks) {
    const used = b.usedBy.length
      ? b.usedBy.map((u) => `${u.displayId || '?'} ${u.title || ''}`.trim()).join('; ')
      : '_unused_';
    out.push(`| \`${b.id}\` | ${b.params.map((p) => `\`${p}\``).join(', ')} | ${used.replace(/\|/g, '\\|')} | ${b.line}–${b.endLine} |`);
  }
  out.push('');
  return out.join('\n');
}
