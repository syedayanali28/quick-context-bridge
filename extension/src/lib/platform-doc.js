// Static guidance shipped inside every export so an agent writes QAL that Quick will accept.

export const PLATFORM_MD = `# Amazon Quick Automate: platform notes for agents

These notes describe the export format and platform rules. They're based on AWS docs (Nov 2026) and the observed
QAL v2.0.0 format. QAL is not officially documented.

## Files in this export

| File | What it is | Edit it? |
|---|---|---|
| \`automation.qal.py\` | The complete automation as stored by Quick ("workflowModel") | **Yes. This is the source of truth.** |
| \`outline.md\` | Readable flow outline with canvas display IDs and line numbers | No (generated) |
| \`context.json\` | Structured JSON tree of the flow (\`quick-automation-context/v1\`) | No (generated) |
| \`code-blocks/<id>.py\` | Each custom code block's Python body, extracted for reading | No. Edit inside \`automation.qal.py\`. |
| \`agents/<name>.md\` | Each custom agent's full instructions and output schema | No. Edit inside \`automation.qal.py\`. |
| \`runtime-config.json\` | Runtime configuration variables, plus the connector map with connection names | Reference |
| \`actions/*.openapi.json\` | OpenAPI 3.0 schema of every action available to this automation group | Reference |
| \`versions.json\` | Committed versions (number, note, date) | Reference |
| \`export-manifest.json\` | Export metadata (ids, \`lastModifiedTime\`, SHA-256 of the QAL) | Don't edit. Write-back uses it to detect conflicts. |

## QAL conventions (observed)

- Every expression is a Python expression **inside a string**: \`_("<expr>")\`.
- An assignment target is written \`_("var").lhs = <rhs>\`. Assigning to a new name creates the variable.
- The canvas title is a trailing comment: \`# qal_display_name: <title>\`.
- Process step: \`with process_step(display_name="...", description_md_key="MD...") as step_<hex>:\`.
- Code block call: \`_("out").lhs = invoke_code_block(id="function_<hex>", args=_("{\\"param\\": var}"))\`.
- Code block definition (module level):
  \`\`\`
  @code_block(title="function_<hex>")
  def function_<hex>(param1, param2):
      '''python
      <body: runs as the function body; \`return\` the result>
      '''
  \`\`\`
- Connector action: \`qactions.<connector>.<Operation>(q_action_connector_id=_("q_action_connector_config(\\"action_connector_id_<hex>\\")"), <param>=_("<expr>"), ...)\`.
  The connector ids map to named connections in \`runtime-config.json\`, and parameters are listed in \`actions/*.openapi.json\`.
- Custom agent: \`agents.agents.use_inline_agent(instruction=_("f\\"\\"\\"...\\"\\"\\""), agent_mode=_("{\\"mode\\": \\"pro\\"}"), agent_name=_("\\"...\\""), outputSchema=_("{json schema}"))\`.
  The instruction is an f-string: write literal braces as \`{{\` and \`}}\`.
- Other built-ins seen: \`log.info(msg=...)\`, \`runtime_config("NAME")\`, \`case_management.create_new_case(...)\`,
  \`datatable.new_table/add_row(...)\`, \`file.from_bytes/to_bytes(...)\`, \`with h.excel() as x: x.open_new_file() ...\`.
- Control flow: \`if/elif/else\` (If decision), \`for x in _("..."):\` (Loop through items), \`while _("..."):\` (Loop while),
  \`try: ... except AutomationException as error:\` (Exception flow, attached to a process step).
- A deactivated step is wrapped in \`if __deactivated_step__:\`.
- The first line declares the I/O schema: \`_("ioschema").lhs = _("{\\"inputs\\":..., \\"outputs\\":...}")\`. The last line is \`__qal_version__(2,0,0)\`.

## Platform rules (AWS docs)

- Code blocks run in **RestrictedPython (a subset of Python 3.10)**. You can only import \`base64\`, \`datetime\`, \`json\`, \`math\`, \`re\` and \`zoneinfo\`.
  There's no pip and no file or network access, and a code block can't call actions or other code blocks.
- Start inputs are read through \`inputs["name"]\`. Start-node input files are limited to 5 MB.
- Variable types are string, number, boolean, array, object, file and data table.
- An exception flow can only be attached to a **Process step**. Exceptions are Business or System and expose type, reason, message, code and caused_by.
- **Create user task** is only allowed inside *Process cases*.
- **Versions:** the Live version auto-saves. Commit makes a read-only snapshot and is blocked if there are validation errors. Only committed versions can be deployed.
- Deployed versions can be run by API: \`aws quicksight start-automation-job\` / \`describe-automation-job\`.

## Making changes

1. Edit \`automation.qal.py\` only. Keep every \`qal_display_name\` comment and every \`function_<hex>\` id stable unless you mean to rename.
2. Keep connector ids (\`action_connector_id_...\`) as they are. They're bound to credentials in the automation group.
3. To add a new code block, add both the \`@code_block\` definition and an \`invoke_code_block\` call. Use a new unique \`function_<6 hex>\` id.
4. Hand back the full file. Write-back (Phase 3) validates it server-side first, shows a diff, and saves only the Live version. It never commits.
`;
