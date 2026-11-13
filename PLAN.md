# Plan: Quick Automate Context Bridge

Goal: get a **complete, machine-readable JSON** of an Amazon Quick Automate automation (instead of
screenshots), hand it to an external agent, and — as a second step — let the agent's changes flow
**back into Quick** without a human copy-pasting between the two.

Reference automation: *Claims Automation › Claims Helper OP - Intake*
(`arn:aws:quicksight:us-east-1:<acct>:automation-group_<group-id>_automation_<automation-id>`).

---

## 1. What the provided context tells us

### 1.1 The editor is a React Flow (xyflow) canvas

The saved HTML (`context/complete-html-of-claims-intake-automation.txt`, 5.7 MB) has **no `<script>` tags and no
embedded state JSON**. It's a rendered DOM snapshot. Every canvas element is a React Flow node or edge:

| React Flow node type | What the UI calls it | Count in snapshot |
|---|---|---|
| `START` | Start (inputs) | 1 |
| `INTENT` | Process step (group; can be collapsed) | 12 |
| `FUNCTIONCALL` | Action (Write log message, Outlook/S3/Textract/REST/… connector actions, Append table row…) | 26 |
| `CODEEXECUTE` | Function, i.e. Custom code block (multi-line Python) | 28 |
| `VARASSIGNMENT` | Save value (`(x)` variable assignment) | 16 |
| `EXPRESSION` | Single-line expression (e.g. "Append to message_ocr_results") | 3 |
| `IFELSE` / `ENDIF` | If decision and its merge point | 8 / 8 |
| `FORLOOP` | Loop through items | 3 |
| `AGENT` | Custom agent (instructions, model, mode, actions/knowledge, structured output) | 3 |
| `EXCEPTBLOCK` | Exception flow attached to a step | 1+ |
| `RETURN` | End process (N outputs) | 2 |

- **Edges:** `<g class="react-flow__edge" aria-label="Edge from 57 to 58">`. Labels are `True`, `False`, or
  `Once an exception is flagged`.
- **Hierarchy** lives in display IDs like `Step 2.2`, `Function 2.2.4.10`, `Agent 2.2.4.26.6`, and `Action E2.2.4.26.1`
  (the `E` prefix marks an exception-flow node).
- **Stable selectors:** `data-testid` (`node-display-id`, `step-node-step-name`, `step-node-properties`,
  `icon-deactivated-step`, …) and `data-automation-id` (`editor-workflow-canvas`, `editor-toolbar-*`,
  `editor-canvas-expand-all-button`, `editor-action-library-action-card-*`, …).
- **Expression language:** parameter values are Python-like expressions, for example
  `q_action_connector_config("action_connector_id_14197b…")`, `"outlook_folder_list : " + str(outlook_folder_list)`,
  and `attachment_s3_destination["key"]`.

### 1.2 What a DOM scrape can and cannot recover (verified against the snapshot)

| Recoverable from DOM | NOT recoverable from DOM |
|---|---|
| Node type, display ID, title, enabled/deactivated flag | **Python code of Custom code blocks.** Monaco only renders the visible lines of the one function that's open. |
| Graph edges and branch labels | **Contents of collapsed steps.** Steps 2.2.3, 2.2.4.23 and 2.2.5–2.2.8 render as a single card with no children. |
| One-line parameter summaries (`Connection : …`, `Message : …`) | Full parameter list of each action (Top, Skip, Filter, output variable…). Only the selected node's Properties panel is in the DOM. |
| **Full agent instructions** and model ID (e.g. `us.anthropic.claude-3-5-sonnet-20241022-v2:0`) | Agent structured-output schema definition, linked actions/knowledge/datasets |
| Agent output variable names | Variables list with types/defaults, Start inputs, End outputs schema |
| Connector IDs (`action_connector_id_…`) | Connector ID → connection name map (e.g. "Claims Email Prod 2") |
| | Version list, commit history, automation settings |

Rich-text rendering also **mangles agent instructions**: `{`/`}` disappear from embedded JSON schemas in the
DOM text, so even the agent prompts aren't reliable from a scrape.

**Conclusion: DOM scraping is only a fallback.** A complete export has to read the editor's **data model**,
either from the network responses the editor loads it with or from its in-memory store.

---

## 2. What AWS officially offers

Researched 2026-11-12. Docs: `docs.aws.amazon.com/quick/latest/userguide/`.

| Capability | Status | Useful for us? |
|---|---|---|
| CRUD API for automations (Create/Describe/Update/List automation or group) | **Does not exist.** It's not in the QuickSight API reference, and Asset Bundle export/import doesn't cover automations. | Extraction and write-back must go through the console. |
| `StartAutomationJob` / `DescribeAutomationJob` (`aws quicksight start-automation-job`, boto3; GA 2026-04-21) | Exists. Only for **committed + deployed** versions. Input is validated against the Start schema. Status is QUEUED, RUNNING, SUCCEEDED, FAILED or STOPPED, with the output payload. | **Yes:** the agent can *run and verify* a deployed automation without you. |
| UI **Export version / Import version** | Exists. You get a pre-signed URL (valid 12 h) to a **KMS-encrypted, opaque** bundle. It covers committed versions only and excludes connectors and credentials. | Moving versions between groups or accounts and making a sandbox copy. Not readable context. |
| Quick Flows APIs (`CreateFlow`, `DescribeFlow`, …) | Exist, but for **Quick Flows**, a different product. Their `FlowDefinition` is "internal format, subject to change". | No, though they show the shape AWS may later use for automations. |
| MCP | Quick is only an MCP **client** (automations can call remote MCP servers). There's no official MCP server that exposes Quick Automate. | No. We build our own bridge (§4.1). |
| "Tell me what to build" / Build with Assistant | Exists, in-editor only. | A supported but low-precision write path (option E below). |

**Platform facts the exported context should state, so the agent writes valid changes:**
- **Custom code blocks:** RestrictedPython (a subset of Python 3.10). Imports are limited to `base64, datetime,
  json, math, re, zoneinfo`. There's no pip, and a block can't call actions. Start inputs are read through `inputs["x"]`.
- **Variable types:** string, number, boolean, array, object, file, data table.
- **Exception flows** attach to Process steps only. Exceptions are Business or System, with type, reason, message,
  code and caused_by.
- **User tasks** are allowed only inside *Process cases*.
- **Versions:** Live auto-saves. Commit creates a read-only snapshot and is blocked when there are validation
  errors. Only committed versions deploy.

**Hint about the internal format (community post, unofficial):** Assistant output references
`function_used: "agents.agents.use_inline_agent"`, `line_number`, `@code_block()` and
`description_md_key`. That suggests the backend stores an automation as **generated Python that calls an
internal SDK**. If Phase 0 confirms it, the network capture may hand us the whole automation as one Python
source file, which is an ideal format for an agent to read and edit.

---

## 2b. Phase 0 discovery results (2026-11-12, read-only, via Claude in Chrome)

**Method:** opened the automation editor in a fresh tab, recorded fetch/XHR traffic, and read the editor's JS bundle
(`9076.bundle.*.js`, an AWS-SDK-v3-style generated client). Nothing was saved, committed or run.

All calls go to the same origin, `https://us-east-1.quicksight.aws.amazon.com/sn/account/<QuickAccountName>/qbsproxy/quicksight`,
using the browser session cookies. Below, `~` = `/automation-groups/{G}/automations/{A}`.

### The definition is code, not a graph

`GET ~/workflow` → `{ workflowModel: string, runtimeConfiguration, lastModifiedTime, workflowArn, … }` (412 KB here).
`workflowModel` is **QAL (Quick Automation Language), a Python DSL**, ending in `__qal_version__(2,0,0)`.
This automation is 8,647 lines: a `main()` of 265 lines followed by 58 `@code_block` functions.

```python
_("ioschema").lhs = _("{\"inputs\":{},\"outputs\":{...JSON schema of End outputs...}}")

def main():
    with host() as h_2ad0ad:
        with process_step(display_name="Variables", description_md_key="MD07360275") as step_f782b9:
            _("threshold").lhs = _("runtime_config(\"THRESHOLD\")")                        # qal_display_name: threshold
            _("government_clinic_names").lhs = invoke_code_block(id="function_ad1c3d",
                  args=_("{\"government_clinic_names_1\": government_clinic_names_1, ...}")) # qal_display_name: Combine govt clinic names
            _("outlook_folder_list ").lhs = qactions.msexchange_v2.ListMailFolders(
                  q_action_connector_id=_("q_action_connector_config(\"action_connector_id_1419…\")"),
                  user_id=_("user_id"), include_hidden_folders=_("False"), top=_("50"))     # qal_display_name: List mail folders
            if __deactivated_step__:            # ← a deactivated step wraps the node
                ...
            for current_mail in _("…"):         # Loop through items
            if _("…"): / else:                  # If decision
            try: … except AutomationException as error:      # Exception flow
            _("email_extraction_raw").lhs = agents.agents.use_inline_agent(
                  instruction=_("f\"\"\"…full prompt, {{ }} escaped…\"\"\""),
                  agent_mode=_("{\"mode\": \"pro\"}"), agent_name=_("\"Normalize Email Intake Metadata\""),
                  outputSchema=_("{…JSON schema…}"))
            case_management.create_new_case(case_type=…)
            with h_2ad0ad.excel() as x: x.open_new_file(); x.write_range(…)
            datatable.new_table(…), datatable.add_row(…), file.from_bytes(…), log.info(msg=…)
            qactions.amazon_s3.UploadFile(…), qactions.amazon_s3.DownloadFile(…)
        return _("{ \"items_discovered\": items_discovered, … }")   # End process outputs

@code_block(title="function_36184d")
def function_36184d(run_mode, portal_claim_number, source_reference):
    '''python
    mode = str(run_mode or "").strip().upper()
    ...
    '''
__qal_version__(2,0,0)
```

Conventions:
- Every expression is wrapped as `_("<python expr string>")`, and assignment targets are written `_("var").lhs = …`.
- UI titles live in a trailing `# qal_display_name:` comment.
- Connector actions are `qactions.<connector>.<Operation>(q_action_connector_id=…, **params)`.

**This one string is the complete automation:** all code, all parameters, the contents of collapsed and deactivated
steps, full agent prompts and schemas, and the I/O schema. It's an ideal artifact for an agent to read and edit,
and a natural fit for git diffs.

### Supporting endpoints (all observed or present in the client)

| Purpose | Call | Notes |
|---|---|---|
| Definition | `GET ~/workflow` | QAL plus `runtimeConfiguration.configurationVariables` (e.g. `THRESHOLD: {configValue:"80"}`) and `resourceConfiguration.CONNECTOR` (`action_connector_id_… → resourceConfigValue: <connection uuid>`) |
| Connection names | `POST /automation-groups/{G}/associations/list` (body `{}`) | uuid → the named connections (Outlook, S3, Textract, REST API, Bedrock …) |
| Action catalog | `GET /automation-groups/{G}/action-groups`, then `POST …/action-groups/batch {actionGroupIds}` | 20 groups; each `actionSchemas` is an **OpenAPI 3.0** doc listing every operation and parameter. Ideal to give the agent so it writes valid `qactions.*` calls. |
| Connectors | `POST /actions/internal/<awsAccountId>/action-connectors` | status, enabled actions |
| **Validate** | `POST ~/validate-automation {workflowModel}` → `{status, errors[], automationQAL}` | **Server-side compile check without saving.** The editor calls it on load. |
| **Save Live** | `PUT ~/workflows {workflowModel, runtimeConfiguration, lastModifiedTime, manifest, displayIds, executionMode, aiConfiguration}` | `lastModifiedTime` looks like optimistic concurrency |
| Edit lock | `POST ~/acquire-lock` / `~/update-lock` / `~/release-lock` | Lock TTL ≈ 3 min, renewed by heartbeat. A 409 means "locked for editing by another user". |
| Versions | `GET ~/versions`, `GET ~/versions/{v}`, `POST ~/versions/{v}` (likely Commit), `PUT ~/versions/{v} {runtimeConfiguration}` | We never call commit |
| Copy | `POST ~/copy {destinationAutomationGroupId, newAutomationName}` | **Make a sandbox copy for write-back testing** |
| Docs and assistant | `GET ~/document`, `POST ~/automation-document-markdown`, `~/messages`, `~/converse-with-assistant/stream` | Process-step descriptions are probably resolved through `description_md_key` |
| Runs and debug | `POST /start/automation-groups/workflow-executions`, `POST /get/automation-groups/workflow-executions`, `POST /automation-groups/{G}/get-workflow-action-execution`, `POST /search/automation-groups/automation-runs` | Test runs on the Live version, plus per-action I/O, so the agent can debug |

**Side effect to know about:** opening the editor acquires the edit lock. When I opened it, the first attempt returned
409 ("locked … by another user"), most likely your own open editor tab. A retry then acquired the lock. I left the
editor and the lock expired about 3 minutes later (no explicit release call was seen). Write-back tooling must
respect this lock protocol and never take over a lock someone else holds.

---

## 3. Architecture

```
┌─────────────────────── Browser (Chrome/Edge, logged into Quick) ───────────────────────┐
│  Quick Automate editor tab                                                             │
│   ├─ MAIN-world hook (document_start): wraps fetch/XHR → records automation JSON       │
│   ├─ State reader: React fiber → React Flow store / app store → nodes+edges+data       │
│   └─ DOM scraper (fallback): data-testid / react-flow selectors                        │
│                         │                                                              │
│  Extension service worker ── normalizer → Canonical Context JSON (+ Markdown view)     │
│        │  popup: Export JSON · Export Markdown · Copy · (later) Apply change          │
└────────┼───────────────────────────────────────────────────────────────────────────────┘
         │ (Phase 4) native messaging / localhost websocket
┌────────▼────────┐        MCP (stdio)        ┌──────────────────────┐
│ quick-bridge    │ ◄───────────────────────► │ Claude Code / agent  │
│ local MCP server│  get_context, propose,    └──────────────────────┘
└─────────────────┘  apply (user-approved)
```

### 3.1 Capture tiers (extract)

1. **Direct read via the console's own endpoints (primary; confirmed in Phase 0).** From a content script on the
   Quick origin, call `GET ~/workflow`, `associations/list` and `action-groups/batch` (§2b) with the page's
   session. Group and automation IDs come from the URL. This gives the complete QAL source plus runtime
   config, connection names and the action catalog. No interception or open editor is needed, and it **doesn't
   take the edit lock**.
   _Auth (found while building Phase 1):_ every proxy call needs `?mbtc=<per-session token>` plus `x-amzn-csrf-token`
   (= `AppConfig.getCsrf()`). `mbtc` can't be read from cookies or storage, so the page hook learns it from the
   app's own first request.
2. **In-memory state (secondary; also captures unsaved edits; not needed so far).** Walk from `.react-flow` DOM elements to the
   React fiber (`__reactFiber$…`). From there, find the xyflow store (`nodes`, `edges`, each with full `data`)
   and/or the app's own store (Redux/Zustand) that holds the workflow model.
3. **DOM scrape (fallback, lossy).** Implemented and unit-tested against the provided HTML snapshot. Before
   scraping it clicks `editor-canvas-expand-all-button` so collapsed steps render.

All tiers feed one **normalizer**, which tags every field with its `source` so the agent knows how much to trust it.

### 3.2 Canonical Context JSON (draft schema `quick-automation-context/v1`)

```jsonc
{
  "schema": "quick-automation-context/v1",
  "exportedAt": "2026-11-12T09:30:00+08:00",
  "captureSources": ["network", "state", "dom"],
  "automation": {
    "arn": "...", "groupArn": "...", "groupName": "Claims Automation",
    "name": "Claims Helper OP - Intake", "version": "Live version",
    "runAs": "Service", "lastSaved": "09:17 GMT+8"
  },
  "inputs":  [ { "name": "...", "type": "...", "required": true } ],
  "outputs": [ { "name": "run_status", "type": "..." } ],
  "variables": [ { "name": "user_id", "type": "string", "default": "..." } ],
  "connections": [ { "id": "action_connector_id_1419…", "name": "Claims Email Prod 2", "type": "Microsoft Outlook (New)" } ],
  "flow": [                                   // ordered tree, mirrors display IDs
    {
      "displayId": "Step 2", "nodeId": "56", "kind": "process_step",   // INTENT
      "title": "A02 — Validate and route invocation", "description": "", "enabled": true,
      "children": [
        { "displayId": "Function 2.1", "kind": "code_block", "title": "Validation",
          "code": { "language": "python", "params": ["..."], "source": "def function(...):\n ..." },
          "returnVariable": "..." },
        { "displayId": "If valid", "kind": "if", "condition": "...",
          "true": [ ... ], "false": [ ... ] },
        { "kind": "loop", "iterateOver": "emails", "itemVariable": "...", "body": [ ... ] },
        { "kind": "action", "actionType": "outlook.list_mail_folders",
          "connection": "action_connector_id_1419…",
          "params": { "user_id": "user_id", "top": 50, "include_hidden_folders": false },
          "output": "outlook_folder_list" },
        { "kind": "agent", "title": "Normalize Email Intake Metadata", "mode": "Pro",
          "model": "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
          "instructions": "…full text…", "structuredOutput": { "name": "email_extraction_raw", "schema": { } },
          "actions": [], "knowledge": [], "output": "email_extraction_raw" }
      ],
      "exceptionFlow": [ ... ]
    }
  ],
  "raw": { "network": { /* untouched backend payloads, for round-tripping */ } }
}
```

**Revised after Phase 0:** the export bundle is a folder or zip the agent can work on like a repo:

```
claims-helper-op-intake/
  automation.qal.py        # workflowModel verbatim: source of truth, round-trippable
  context.json             # the structured view above, generated by parsing QAL (Python ast on the extension/bridge side)
  runtime-config.json      # configurationVariables + CONNECTOR map, with connection names resolved
  actions/openapi/*.json   # action catalog for the connectors this group can use
  PLATFORM.md              # QAL conventions + RestrictedPython limits, so agent edits compile
```

The agent edits `automation.qal.py`. `context.json` is for orientation and is regenerated, never hand-edited.

There's also a **Markdown rendering** of the same model: an indented outline with code in fenced blocks. It's far
more token-efficient to paste into an agent, and the JSON remains the source of truth for write-back.

**Redaction options:** account ID, connector IDs, and email addresses or bucket names inside literals (off by
default; on when sharing outside the team).

---

## 4. Write-back (agent → Quick): options, ranked

| # | Approach | Fidelity | Robustness | Risk |
|---|---|---|---|---|
| A | **Official public API.** None exists for editing today (§2); watch What's New. | n/a | n/a | n/a |
| B | **Use the editor's own calls (confirmed in Phase 0).** The agent returns a modified `automation.qal.py`. The extension (1) runs `POST ~/validate-automation` and shows compile errors to the agent, (2) shows you a diff, (3) on approval: `acquire-lock` (abort on 409, never take over), check `lastModifiedTime` is unchanged since export, `PUT ~/workflows`, then `release-lock`. Only the **Live** version changes; **never Commit**. | Full | Medium (undocumented internal API, can change) | Medium. Use a `~/copy` sandbox first and check org policy. |
| C | **Drive the editor UI** (Playwright / Claude in Chrome). For example, set code through the Monaco model API, fill Properties fields, add nodes from the action library. | Partial | Low (selector drift, slow) | Low. Only does what a user could do. |
| D | **Import version bundle.** It's KMS-encrypted and opaque, so we can't generate one. | None | n/a | n/a |
| E | **Feed the in-editor Assistant.** The agent writes a precise "Tell me what to build" prompt; the extension pastes it and the user reviews the Assistant's edit. | Low–Medium | Medium | Low. A supported path. |

**Recommendation:** build B, with C as the fallback for small targeted edits (for example "replace the code of
Function 2.2.4.10"), and E for larger structural changes if B turns out to be blocked. Switch to A if AWS ships it.
For **verification**, the agent calls the official `StartAutomationJob` / `DescribeAutomationJob` on a deployed
sandbox version. Every write is a **proposal**: the extension shows a
semantic diff (nodes added, removed or changed; code diff) and the user clicks Apply. Commit stays manual.

### 4.2 Write protocol, verified on a sandbox copy (2026-11-12)

| Call | Observed behaviour |
|---|---|
| `POST ~/copy {destinationAutomationGroupId, newAutomationName}` | → `{automationArn}`. The name must match `[-.\w]+(?:\s*[-.\w]+)*` (no parentheses). The copy is the source's Live version. |
| `POST ~/validate-automation {workflowModel}` | → `{status: VALID\|INVALID, errors:[{actionId:"<1-based QAL line>", errorCode, errorMessages[], propertyId}]}`. Catches syntax errors (`INVALID_SYNTAX`) and unknown actions (`UNKNOWN_SKILL`), but **not** broken Python inside `_("…")`, so the extension adds a local bracket/string check. |
| `POST ~/acquire-lock` | → `{lockStatus: ACQUIRED, expiresAt}` (~3 min) or `HELD_BY_OTHER` + `userId`. Not reentrant, and release takes a moment to propagate, so the extension retries 4× at 1.5 s. |
| `PUT ~/workflows {workflowModel, runtimeConfiguration, lastModifiedTime}` | → `{lastModifiedTime, workflowCompletionStatus: COMPLETE, workflowVersionArn}`. **The server doesn't require the lock**, so the extension always takes it. **A stale `lastModifiedTime` → 409** "modified by another user". This is the conflict check: the extension sends the export's `lastModifiedTime`. |
| `POST ~/release-lock` | → `RELEASED` / `NOT_HELD` |

An editor tab left open on an automation holds its lock and can show a "Leave site?" prompt. Close it before applying.

### 4.1 Closing the loop without a human relay (Phase 4)

A small local **MCP server** (`quick-bridge`) paired with the extension (Chrome Native Messaging, or a localhost
WebSocket with a pairing token) exposes these tools to Claude Code:

- `quick.list_open_automations()`
- `quick.get_context(automationArn, format="json"|"markdown")`
- `quick.get_node(displayId)`: full config and code for one node
- `quick.validate(qal)`: server-side compile check via `validate-automation`, with no save, so the agent can iterate alone
- `quick.propose_change(patch)`: queues a change and shows the diff in the extension
- `quick.apply_change(id)`: only after the user approves in the browser
- `quick.run_job(groupId, automationId, input)` / `quick.get_job(jobId)`: official `StartAutomationJob` /
  `DescribeAutomationJob` through the AWS SDK with your local credentials, so the agent can test a deployed
  sandbox version and read its outputs
- `quick.get_run_logs(runId)` (only if Phase 0 finds the console's run-log endpoints)

---

## 5. Phased build plan

| Phase | Deliverable | Needs from you |
|---|---|---|
| **0. Discovery** | ✅ **Done 2026-11-12.** See §2b. Definition = QAL Python via `GET ~/workflow`. Save = `PUT ~/workflows` under an edit lock. Validate endpoint exists. | n/a |
| **1. Extractor MVP** | ✅ **Built 2026-11-12** (`extension/`, see README). Plain-JS MV3 extension with no build step, because Node isn't installed; tests run on VS Code's bundled Node. **Auth finding:** the proxy needs the per-session `mbtc` query token, which isn't readable from cookies or storage. A MAIN-world hook captures it from the app's own requests, keeps it in memory, and only allows 6 read endpoints. **Pulled forward from Phase 2:** a QAL parser → `context.json` + `outline.md` with canvas display IDs, per-block and per-agent files. **Dropped:** the DOM-scrape fallback, since the API path is complete and verified. **Verified on live data:** 83/83 canvas IDs+titles, 58/58 code blocks, 19/19 connectors, 0 parser warnings. **Verified by you:** a real export (Claims Helper OP - Process Case, 3,510 lines). | ✅ |
| **2. Refinements** | ✅ Partly done: `Process cases` loops (`deque_cases`) and `with <case>.acquire():`. Identical agents and code blocks are deduplicated (Process Case: 126 agent steps → 39 files, 80 code blocks → 11). **Open:** process-step descriptions via `~/document`, Python `ast` check in the bridge, an "only used actions" filter, a Mermaid diagram, a steps-only outline for very large automations. | Feedback on the export. |
| **3. Write-back** | ✅ **Built 2026-11-12** (`extension/src/apply.*`, `lib/writeback.js`, `lib/diff.js`). The Apply page loads an edited export folder and runs local lint + server `validate-automation` + line diff + a step-level semantic diff, then conflict detection from the manifest's `lastModifiedTime`. On approval: optionally `~/copy` to a sandbox, then lock → `PUT ~/workflows` → read-back verify → release. **Protocol verified by hand on the sandbox copy** ("Claims Helper OP - Intake - bridge sandbox"): the save persisted, a stale `lastModifiedTime` got 409, and the lock was released. See §4.2. **Not yet verified:** the Apply page click-through in your browser. | Reload the extension and run one apply against the sandbox. |
| **4. Agent bridge** | ✅ **Built 2026-11-13** (`bridge/`, `extension/src/bridge.*`, `CLAUDE.md`). A local relay server (127.0.0.1 + token) and the `qcb` CLI; the extension's Bridge tab long-polls and relays calls to the Quick page hook. Commands: pull, check, push, copy, run (TEST env, mirrors the editor's Run: `compiler:"PYTHON"`, `environment:"TEST"`, test task queues), inspect. **Run data comes from `get-workflow-action-execution`:** `workflowExecutionStatus`, `actionExecutions[]` (`actionId` = QAL line, RUNNING→final event pairs, `logs[]` = `log.info` output), plus the executed QAL. `/get/…/workflow-executions` returned 403. The agent commits each iteration to the private `../quick-workspace` repo. The user chose full autonomy and "any automation I name". An MCP wrapper is optional later. | Connect the Bridge tab once (token). |

### Project layout (proposed)

```
extension/            MV3 extension (manifest, MAIN-world hook, content script, popup, service worker)
  src/capture/        network.ts, state.ts, dom.ts
  src/model/          schema.ts (types + JSON Schema), normalize.ts, markdown.ts, redact.ts
  src/writeback/      diff.ts, apply-api.ts, apply-ui.ts
bridge/               local MCP server (Node/TS), native-messaging host
tests/fixtures/       claims-intake.html (the provided snapshot)
```

---

## 6. Open questions / risks

- **Undocumented internals.** Endpoints and store shapes are private and may change. Mitigate with tiered
  capture, version-tagged parsers, and a completeness report.
- **Governance.** This is a *Prod* account. Write-back should run only against a sandbox automation, never
  Commit, and should respect your org's policy on browser extensions and internal APIs.
- **Browser.** Chrome or Edge? Can unpacked or self-hosted extensions be installed on your managed machine?
