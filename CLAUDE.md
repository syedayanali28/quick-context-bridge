# CLAUDE.md: working on Amazon Quick Automate automations

This repo is **Quick Context Bridge**: a Chrome extension plus a local bridge that lets the agent pull, edit,
validate, save (Live version), copy and test-run Amazon Quick Automate automations with the user's browser
session. Read `PLAN.md` §2b/§4.2 for the reverse-engineered protocol.

## The feature loop (what to do when the user asks for a change to an automation)

The user asks for functionality in an automation. You run the whole loop yourself and come back with proof.

1. **Preflight**
   - The bridge server must be running: `bash scripts/bridge.sh` (run it in the background), then
     `bash scripts/qcb.sh status`. You need `extension connected: true` and a Quick tab with `hook=2 auth=true`.
   - If it's not connected, ask the user to open the extension popup → **Agent bridge…** → Connect, and to reload
     the Quick tab (F5), then click any Quick tab once.
2. **Target**
   - Resolve the automation the user named (console URL, `<group>/<automation>`, or alias).
   - The user may let you edit any automation they name (decision of 2026-11-13). Record it with
     `qcb allow <ref> --name "<name>"`.
   - Prefer a sandbox copy unless the user said to change the original:
     `qcb copy <ref> --name "<name> - agent sandbox"`. That allows it automatically. Names: letters, digits, spaces, `-` and `.` only.
3. **Baseline**
   - `qcb pull <ref>` exports into `../quick-workspace/<slug>/`.
   - In `../quick-workspace` run `git add -A && git commit -m "<slug>: baseline"`.
4. **Plan**
   - Read `outline.md`, `PLATFORM.md` and the relevant `code-blocks/*.py` and `agents/*.md`.
   - Write down **acceptance criteria** first: which log lines, statuses or outputs will prove the change works.
     Add `log.info(...)` steps where needed, so a run can show the behaviour.
5. **Edit**: change `automation.qal.py` only. Follow `PLATFORM.md`: QAL conventions, RestrictedPython, keep ids and connector ids.
6. **Check**: `qcb check <ref>` runs local lint, Quick's server validation and the diff. Fix until `server: VALID` and lint shows 0 errors.
7. **Push**: `qcb push <ref>` (lock → save Live → verify → release). It refuses on conflicts; use `--force` only after reading the diff.
8. **Run**:
   - `qcb run <ref> [--input '{"k":"v"}'] [--timeout 900] --note "<what this iteration tests>"`.
   - Read `runs/<ts>-<status>/summary.md`, plus `digest.json` for the executed steps, failures and logs.
   - TEST runs use the real connectors (Outlook, S3, Claims API, agents). The user accepted this; still avoid
     needless runs.
9. **Commit every run** in `../quick-workspace`:
   `git add -A && git commit -m "<slug>: iter N: <change> — run <STATUS>: <verdict vs criteria>"`.
10. **Iterate**: repeat 5–9 until the criteria pass, or until you're blocked. Stop after about 5 failed iterations
    and report.
11. **Report** to the user:
    - What was added or fixed, and the proof: run ARN, status, the log lines and steps that show it, and the commit hashes.
    - If it failed: why, what you tried, and the alternatives you considered.
    - Remind them that nothing was committed or deployed in Quick. The Live version of the target changed; they review and Commit in the editor.

## Hard rules

- Never call commit, deploy, delete or trigger endpoints (the page hook doesn't allow them anyway).
- Never push `../quick-workspace` anywhere: it holds business logic and test records with personal data.
- Never put automation exports, QAL or run logs into this repo. This repo is public. `.gitignore` covers
  `context/`, `quick-exports/` and `bridge/.state/`.
- Don't close or navigate the user's own Quick tabs. Editor tabs hold the edit lock; ask the user to close them if a push says the lock is held.

## Dev

- Tests: `bash scripts/test.sh` (node:test). `scripts/node.sh` falls back to VS Code's bundled Node.
- Extension: plain ES modules, no build step. After changing it, the user reloads it in `chrome://extensions`
  and reloads their Quick tabs.
- Commits in this repo end with the attribution lines from the session's system reminder.
