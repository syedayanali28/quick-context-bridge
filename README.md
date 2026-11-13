# Quick Context Bridge

Export an **Amazon Quick Automate** automation as files an AI agent can actually work with. You get the complete
source, a flow outline with canvas display IDs, structured JSON, every code block and agent prompt, the
connections, and the action catalog. No more screenshots.

It also **applies an agent's edits back** (Phase 3). The Apply page validates on the server, shows a diff, detects
conflicts, and saves only the **Live** version under Quick's edit lock. It never commits, deploys, deletes or runs
anything: the page hook's write allowlist is validate, lock, save Live and copy. See [PLAN.md](PLAN.md) for the design
and the verified protocol.

## Install (Chrome or Edge, unpacked)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder of this repo.
3. **Reload any open Quick tabs.** The extension hooks the page at load time.

## Use

1. Open the automation in Quick: its Summary, Versions or editor page. The URL contains
   `…/automations/arn:aws:quicksight:…:automation-group_<id>_automation_<id>/…`.
2. If the popup says "Waiting for the Quick session", click any tab in Quick (for example **Versions**) once.
3. Click the extension icon → **Export** → **Download .zip** (or **Download folder**, or one of the Copy buttons).

Files are saved under `Downloads/quick-exports/<automation>-<timestamp>/`:

| File | Contents |
|---|---|
| `automation.qal.py` | The whole automation as Quick stores it (QAL, a Python DSL). This is the source of truth. |
| `outline.md` | The flow as an indented outline with canvas display IDs (`Function 2.2.4.10`), connections and QAL line numbers. **Start here.** |
| `context.json` | The same tree as JSON (`quick-automation-context/v1`): steps, actions with params, code blocks with source, agents with full instructions and schemas |
| `code-blocks/*.py` | One file per custom code block |
| `agents/*.md` | One file per custom agent (instructions, mode, model, output schema) |
| `runtime-config.json`, `connections.json` | Runtime variables, plus connector IDs resolved to connection names |
| `actions/*.openapi.json` | OpenAPI 3.0 schemas of every action the automation group can call |
| `versions.json` | Committed versions |
| `PLATFORM.md` | QAL conventions and RestrictedPython limits, for the agent |
| `export-manifest.json` | IDs, `lastModifiedTime`, SHA-256 of the QAL (write-back uses these to detect conflicts) |

To hand off to an agent, give it the folder and say: *"Read README.md, PLATFORM.md and outline.md, then edit
automation.qal.py."*

The **Redact** option replaces the AWS account ID, the Quick account name and email addresses. Use it when sharing
outside your team. A redacted export can't be imported back. Redaction does **not** catch other personal data that
sits in the QAL itself, such as hard-coded test records with names or policy numbers in deactivated steps.

## Apply changes back

1. Make sure no Quick editor tab is open on the target automation; an open editor holds the edit lock.
2. On the automation's Summary/Versions page, open the popup → **Apply changes…**. A tab opens.
3. **Choose export folder…** and pick the folder your agent edited. It reads `automation.qal.py`, and
   `export-manifest.json` for conflict detection.
4. Optional: tick **Apply to a new sandbox copy** to leave the original untouched.
5. **Check changes**. This runs:
   - a local lint (expressions, code-block references, connector IDs)
   - Quick's `validate-automation` (which saves nothing)
   - a line diff and a step-level summary of what changes on the canvas
   - a conflict check: if the Live version changed since the export, saving is blocked unless you explicitly choose to overwrite.
6. Tick **I reviewed the diff** → **Save to Live version**. The extension then takes the lock, saves, reads the
   automation back to verify, and releases the lock.
7. Open the editor to review, then **Commit** there yourself when ready.

## How it works

- The Quick console talks to `…/sn/account/<acct>/qbsproxy/quicksight/…` using a per-session `mbtc` query token and an
  `x-amzn-csrf-token` header. `extension/src/page-hook.js` runs in the page at `document_start`, picks those up from
  the app's own requests, and keeps them in memory only. They're never stored or exported.
- The popup asks the hook to fetch `GET …/automations/{id}/workflow`, `associations/list`, `versions`,
  `action-groups` and `action-groups/batch`. It then builds the bundle locally (`extension/src/lib/`).
- `lib/qal.js` parses QAL into the canvas tree. It was checked against the live Claims Helper OP - Intake automation:
  8,647 lines parsed in about 0.1 s with no warnings. All 83 display IDs visible on the canvas matched, with titles, as
  did 58/58 code blocks and 19/19 connectors.

## Develop

No build step: the extension is plain ES modules. Run the tests with:

```bash
bash scripts/test.sh
```

If Node isn't installed, the script falls back to VS Code's bundled runtime.

```
extension/
  manifest.json
  src/page-hook.js        MAIN-world hook: session capture + read-only request allowlist
  src/popup.{html,css,js} UI: probe tab, fetch, build, download/copy
  src/apply.{html,css,js} Phase 3 UI: load edited export, check, diff, save Live version
  src/lib/writeback.js    lint, semantic diff, conflict planning, lock → save → verify → release
  src/lib/diff.js         Myers line diff + unified hunks
  src/lib/pysrc.js        tiny Python tokenizer helpers (strings, brackets, calls)
  src/lib/qal.js          QAL → flow tree with canvas display IDs
  src/lib/render.js       flow tree → outline.md
  src/lib/bundle.js       raw responses → export files
  src/lib/zip.js          store-only zip writer
tests/                    node:test suites + synthetic QAL fixture
context/                  original screenshots and HTML snapshot used for discovery
```
