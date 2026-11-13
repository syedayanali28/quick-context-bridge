// Turn the raw backend responses into the export bundle (a list of files).

import { parseQal, walk } from './qal.js';
import { renderOutline } from './render.js';
import { slugify } from './ids.js';
import { redactText } from './redact.js';
import { PLATFORM_MD } from './platform-doc.js';

export const CONTEXT_SCHEMA = 'quick-automation-context/v1';
export const EXPORTER_VERSION = '0.1.0';

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(v) {
  return `${JSON.stringify(v, null, 2)}\n`;
}

function epochToIso(t) {
  if (typeof t !== 'number') return null;
  const ms = t > 1e12 ? t : t * 1000;
  return new Date(ms).toISOString();
}

/** Build the lookup of connector refs (action_connector_id_x) -> {connectionId, name, type, ...}. */
export function resolveConnectors(workflow, associations, actionGroups) {
  const map = (workflow && workflow.runtimeConfiguration && workflow.runtimeConfiguration.resourceConfiguration
    && workflow.runtimeConfiguration.resourceConfiguration.CONNECTOR) || {};
  const byId = new Map();
  for (const a of (associations && associations.associations) || []) {
    const d = a.actionConnectorDetails;
    if (d && d.id) byId.set(d.id, { name: d.name, type: d.type, description: d.description || null, arn: a.resourceArn });
    if (d && a.resourceArn) {
      const tail = String(a.resourceArn).split('/').pop();
      if (tail && !byId.has(tail)) byId.set(tail, { name: d.name, type: d.type, description: d.description || null, arn: a.resourceArn });
    }
  }
  for (const g of (actionGroups && actionGroups.actionGroups) || []) {
    if (!byId.has(g.actionGroupId)) byId.set(g.actionGroupId, { name: g.actionGroupName, type: g.actionGroupType });
  }
  const out = {};
  for (const [ref, cfg] of Object.entries(map)) {
    const connectionId = cfg && cfg.resourceConfigValue;
    const hit = byId.get(connectionId) || null;
    out[ref] = {
      connectionId,
      name: hit ? hit.name : null,
      type: hit ? hit.type : null,
      description: (cfg && cfg.resourceConfigDescription) || (hit && hit.description) || null,
    };
  }
  return out;
}

/**
 * @param {object} raw
 * @param {object} raw.ids          parseAutomationUrl() result
 * @param {string} raw.name         automation name (from page)
 * @param {string} raw.pageUrl
 * @param {object} raw.workflow     GET ~/workflow
 * @param {object} [raw.associations] POST associations/list
 * @param {object} [raw.actionGroups] GET action-groups
 * @param {object} [raw.actionSchemas] POST action-groups/batch
 * @param {object} [raw.versions]   GET ~/versions
 * @param {string[]} [raw.errors]   non-fatal fetch errors
 * @param {{redact?:boolean, includeActionSchemas?:boolean, now?:Date}} [opts]
 */
export async function buildBundle(raw, opts = {}) {
  const now = opts.now || new Date();
  const wf = raw.workflow;
  if (!wf || typeof wf.workflowModel !== 'string') throw new Error('Workflow response has no workflowModel');
  const qal = wf.workflowModel;
  const parsed = parseQal(qal);
  const connectors = resolveConnectors(wf, raw.associations, raw.actionGroups);
  const connectorName = (ref) => (connectors[ref] && connectors[ref].name) || null;
  const name = raw.name || 'Automation';
  const slug = slugify(name);
  const files = [];
  const add = (path, content) => files.push({ path, content });

  // Agents: one file per *distinct* definition (instruction + mode + output schema). Real automations
  // repeat the same agent many times (e.g. 126 agent steps but only 39 distinct prompts), so each file
  // lists every place it is used. agentFile maps each node to its file for the outline.
  const agentFile = new Map();
  const agents = []; // one entry per agent node
  const agentDefs = new Map(); // key -> {file, nodes[]}
  const usedFiles = new Set();
  walk(parsed.nodes, (n) => {
    if (n.kind !== 'agent') return;
    const key = JSON.stringify([n.instruction || '', n.agentMode || null, n.outputSchema || null, n.params || null]);
    let def = agentDefs.get(key);
    if (!def) {
      const base = slugify(n.title || n.agentName || 'agent', 'agent');
      let file = `${base}.md`;
      let k = 2;
      while (usedFiles.has(file)) file = `${base}-${k++}.md`;
      usedFiles.add(file);
      def = { file, nodes: [] };
      agentDefs.set(key, def);
    }
    def.nodes.push(n);
    agentFile.set(n, def.file);
    agents.push({ file: def.file, node: n });
  });

  // Code blocks with identical source: the first keeps the body, the rest point at it.
  const firstBySource = new Map();
  const sameAs = new Map();
  for (const b of parsed.codeBlocks) {
    const key = `${b.params.join(',')}\n${b.source}`;
    if (firstBySource.has(key)) sameAs.set(b.id, firstBySource.get(key));
    else firstBySource.set(key, b.id);
  }

  const counts = {};
  walk(parsed.nodes, (n) => { counts[n.kind] = (counts[n.kind] || 0) + 1; });
  const deactivated = [];
  walk(parsed.nodes, (n) => { if (n.deactivated && n.displayId) deactivated.push(n.displayId); });

  const qalSha256 = await sha256Hex(qal);
  const manifest = {
    exporter: { name: 'quick-context-bridge', version: EXPORTER_VERSION },
    schema: CONTEXT_SCHEMA,
    exportedAt: now.toISOString(),
    redacted: !!opts.redact,
    source: {
      pageUrl: raw.pageUrl || null,
      automationArn: raw.ids && raw.ids.arn,
      region: raw.ids && raw.ids.region,
      awsAccountId: raw.ids && raw.ids.awsAccountId,
      quickAccount: raw.ids && raw.ids.quickAccount,
      automationGroupId: raw.ids && raw.ids.groupId,
      automationId: raw.ids && raw.ids.automationId,
    },
    automation: {
      name,
      workflowArn: wf.workflowArn || null,
      lastModifiedTime: wf.lastModifiedTime ?? null,
      lastModifiedIso: epochToIso(wf.lastModifiedTime),
      creationTime: wf.creationTime ?? null,
      workflowCompletionStatus: wf.workflowCompletionStatus || null,
      latestCommittedVersionId: wf.latestCommittedVersionId || null,
      qalVersion: parsed.qalVersion,
    },
    qal: { file: 'automation.qal.py', sha256: qalSha256, bytes: new TextEncoder().encode(qal).length, lines: qal.split('\n').length },
    stats: {
      nodes: counts,
      codeBlocks: parsed.codeBlocks.length,
      distinctCodeBlocks: firstBySource.size,
      agents: agents.length,
      distinctAgents: agentDefs.size,
      deactivated,
    },
    fetchErrors: raw.errors || [],
    parserWarnings: parsed.warnings,
  };

  // ---- files ----
  add('automation.qal.py', qal);

  add('outline.md', renderOutline(parsed, { name, connectorName, agentFile, sameAs }));

  const context = {
    schema: CONTEXT_SCHEMA,
    exportedAt: manifest.exportedAt,
    automation: { ...manifest.automation, arn: manifest.source.automationArn, groupId: manifest.source.automationGroupId,
      automationId: manifest.source.automationId },
    io: parsed.ioSchema,
    runtimeConfig: {
      variables: Object.fromEntries(Object.entries((wf.runtimeConfiguration && wf.runtimeConfiguration.configurationVariables) || {})
        .map(([k, v]) => [k, { value: v && v.configValue, description: (v && v.configDescription) || null }])),
      connectors,
    },
    flow: parsed.nodes,
    codeBlocks: parsed.codeBlocks.map((b) => (sameAs.has(b.id)
      ? { ...b, source: undefined, sameSourceAs: sameAs.get(b.id), file: `code-blocks/${sameAs.get(b.id)}.py` }
      : { ...b, file: `code-blocks/${b.id}.py` })),
    agents: agents.map((a) => ({ displayId: a.node.displayId, title: a.node.title, target: a.node.target, file: `agents/${a.file}` })),
    stats: manifest.stats,
    warnings: parsed.warnings,
  };
  add('context.json', json(context));

  const duplicatesOf = new Map();
  for (const [dup, orig] of sameAs) {
    if (!duplicatesOf.has(orig)) duplicatesOf.set(orig, []);
    duplicatesOf.get(orig).push(dup);
  }
  for (const b of parsed.codeBlocks) {
    if (sameAs.has(b.id)) continue;
    const group = [b, ...(duplicatesOf.get(b.id) || []).map((id) => parsed.codeBlocks.find((x) => x.id === id))];
    const used = group.flatMap((g) => g.usedBy.map((u) => `${u.displayId || '?'} "${u.title || ''}" (${g.id}, QAL line ${u.line})`));
    const header = [
      `# Code block ${b.id}  (automation.qal.py lines ${b.line}-${b.endLine})`,
      group.length > 1 ? `# Identical source also defined as: ${group.slice(1).map((g) => `${g.id} (lines ${g.line}-${g.endLine})`).join(', ')}` : null,
      `# Used by: ${used.join('; ') || 'not referenced'}`,
      '# Read-only extract: edit the block(s) inside automation.qal.py.',
      `def ${b.id}(${b.params.join(', ')}):`,
    ].filter(Boolean).join('\n');
    const body = b.source.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');
    add(`code-blocks/${b.id}.py`, `${header}\n${body}`);
  }

  for (const def of agentDefs.values()) {
    const n = def.nodes[0];
    const mode = n.agentMode && typeof n.agentMode === 'object' ? JSON.stringify(n.agentMode) : n.agentMode;
    const uses = def.nodes.map((u) => `| ${u.displayId || ''} | ${(u.title || '').replace(/\|/g, '\\|')}${u.deactivated ? ' _(deactivated)_' : ''} | \`${u.target || ''}\` | ${u.line} |`);
    const md = [
      `# ${n.title || n.agentName || 'Agent'}${def.nodes.length > 1 ? ` (used ${def.nodes.length}×)` : ''}`,
      '',
      `- **Agent name:** ${n.agentName || ''}`,
      `- **Mode:** \`${mode || ''}\``,
      n.model ? `- **Model:** \`${n.model}\`` : null,
      n.params ? `- **Other parameters:** \`${JSON.stringify(n.params)}\`` : null,
      '',
      def.nodes.length > 1 ? 'Every step below uses this exact definition. Changing it in one place in automation.qal.py does not change the others.' : null,
      def.nodes.length > 1 ? '' : null,
      '| Step | Title | Output variable | QAL line |',
      '|---|---|---|---|',
      ...uses,
      '',
      '## Instructions',
      '',
      n.instructionIsTemplate ? '_(The instruction is a dynamic expression, shown verbatim.)_\n' : null,
      '````text',
      n.instruction || '',
      '````',
      '',
      '## Output schema',
      '',
      '```json',
      typeof n.outputSchema === 'string' ? n.outputSchema : JSON.stringify(n.outputSchema, null, 2),
      '```',
      '',
    ].filter((x) => x !== null).join('\n');
    add(`agents/${def.file}`, md);
  }

  add('runtime-config.json', json({
    configurationVariables: context.runtimeConfig.variables,
    connectors,
    credential: (wf.runtimeConfiguration && wf.runtimeConfiguration.resourceConfiguration
      && wf.runtimeConfiguration.resourceConfiguration.CREDENTIAL) || {},
    taskQueue: (wf.runtimeConfiguration && wf.runtimeConfiguration.resourceConfiguration
      && wf.runtimeConfiguration.resourceConfiguration.TASK_QUEUE) || {},
  }));

  if (raw.associations) {
    add('connections.json', json(((raw.associations && raw.associations.associations) || []).map((a) => ({
      resourceType: a.resourceType,
      resourceArn: a.resourceArn,
      id: a.actionConnectorDetails && a.actionConnectorDetails.id,
      name: a.actionConnectorDetails && a.actionConnectorDetails.name,
      type: a.actionConnectorDetails && a.actionConnectorDetails.type,
      description: a.actionConnectorDetails && a.actionConnectorDetails.description,
      enabledActions: a.actionConnectorDetails && a.actionConnectorDetails.enabledActions,
    }))));
  }

  if (raw.actionSchemas && opts.includeActionSchemas !== false) {
    const groups = new Map(((raw.actionGroups && raw.actionGroups.actionGroups) || []).map((g) => [g.actionGroupId, g]));
    const usedIds = new Set(Object.values(connectors).map((c) => c.connectionId));
    const usedNames = new Set(Object.values(connectors).map((c) => c.name).filter(Boolean));
    const index = [];
    const seen = new Set();
    for (const g of raw.actionSchemas.actionGroups || []) {
      const meta = groups.get(g.actionGroupId) || {};
      let schema = g.actionSchemas;
      try { schema = JSON.parse(g.actionSchemas); } catch { /* keep string */ }
      let file = `${slugify(meta.actionGroupName || g.actionGroupId)}.openapi.json`;
      let k = 2;
      while (seen.has(file)) file = file.replace(/(-\d+)?\.openapi\.json$/, `-${k++}.openapi.json`);
      seen.add(file);
      const ops = schema && schema.paths
        ? Object.entries(schema.paths).flatMap(([p, item]) => Object.entries(item)
          .filter(([m]) => /^(get|put|post|patch|delete)$/.test(m))
          .map(([, op]) => op.operationId || p))
        : [];
      index.push({
        file: `actions/${file}`,
        actionGroupId: g.actionGroupId,
        name: meta.actionGroupName || null,
        type: meta.actionGroupType || null,
        provider: meta.actionGroupProvider || null,
        usedByThisAutomation: usedIds.has(g.actionGroupId) || usedNames.has(meta.actionGroupName),
        operations: ops,
      });
      add(`actions/${file}`, typeof schema === 'string' ? schema : json(schema));
    }
    add('actions/index.json', json(index));
  }

  if (raw.versions) {
    add('versions.json', json(((raw.versions && raw.versions.workflowVersions) || []).map((v) => ({
      versionId: v.versionId,
      versionNumber: v.versionNumber,
      description: v.description,
      created: epochToIso(v.creationTime),
      committedBy: v.committedBy,
      executionMode: v.executionMode,
    }))));
  }

  add('PLATFORM.md', PLATFORM_MD);
  add('README.md', readme(name, manifest));
  add('export-manifest.json', json(manifest));

  const finalFiles = opts.redact
    ? files.map((f) => ({ path: f.path, content: redactText(f.content, raw.ids || {}) }))
    : files;

  return {
    folder: `${slug}-${now.toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/-/g, '')}`,
    files: finalFiles,
    parsed,
    manifest,
    summary: {
      name,
      qalLines: manifest.qal.lines,
      qalBytes: manifest.qal.bytes,
      codeBlocks: parsed.codeBlocks.length,
      distinctCodeBlocks: firstBySource.size,
      agents: agents.length,
      distinctAgents: agentDefs.size,
      steps: counts.step || 0,
      actions: (counts.action || 0) + (counts.call || 0) + (counts.case || 0),
      connectors: Object.keys(connectors).length,
      unresolvedConnectors: Object.values(connectors).filter((c) => !c.name).length,
      warnings: parsed.warnings.length,
      fetchErrors: (raw.errors || []).length,
    },
  };
}

function readme(name, m) {
  return `# ${name}: Quick Automate export

Exported ${m.exportedAt} by quick-context-bridge ${m.exporter.version}${m.redacted ? ' (**redacted**: read-only, cannot be imported back)' : ''}.

- Automation ARN: \`${m.source.automationArn}\`
- Live version last modified: ${m.automation.lastModifiedIso || 'unknown'}
- QAL ${m.automation.qalVersion || '?'}: ${m.qal.lines} lines, sha256 \`${m.qal.sha256.slice(0, 16)}…\`
- ${m.stats.codeBlocks} code blocks (${m.stats.distinctCodeBlocks} distinct), ${m.stats.agents} agent steps (${m.stats.distinctAgents} distinct definitions)${m.stats.deactivated.length ? `, ${m.stats.deactivated.length} deactivated steps` : ''}

**Start here:** \`outline.md\` gives the flow at a glance. \`PLATFORM.md\` covers the rules. \`automation.qal.py\` is the thing to edit.
${m.fetchErrors.length ? `\n> Some optional data could not be fetched:\n${m.fetchErrors.map((e) => `> - ${e}`).join('\n')}\n` : ''}${m.parserWarnings.length ? `\n> Parser warnings (${m.parserWarnings.length}) are listed in \`export-manifest.json\`.\n` : ''}`;
}
