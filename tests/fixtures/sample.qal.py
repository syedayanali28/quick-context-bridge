_("ioschema").lhs = _("{\"inputs\":{},\"outputs\":{\"type\":\"object\",\"properties\":{\"items_discovered\":{\"type\":\"number\"},\"cases_created\":{\"type\":\"number\"}}}}")

def main():
    with host() as h_2ad0ad:
        with process_step(display_name="Variables", description_md_key="MD07360275") as step_f782b9:
            _("run_start_timestamp").lhs = _("datetime.datetime.utcnow().isoformat()") # qal_display_name: Run Start Timestamp
            _("threshold").lhs = _("runtime_config(\"THRESHOLD\")") # qal_display_name: threshold
            _("government_clinic_names").lhs = invoke_code_block(id="function_ad1c3d", args=_("{\"names_1\": government_clinic_names_1, \"names_2\": government_clinic_names_2}")) # qal_display_name: Combine govt clinic names
        with process_step(display_name="A02 — Validate and route invocation", description_md_key="MD1111") as step_aaaaaa:
            _("validation").lhs = invoke_code_block(id="function_36184d", args=_("{\"run_mode\": run_mode}")) # qal_display_name: Validation
            if _("validation[\"valid\"]"): # qal_display_name: If valid
                if _("run_mode == \"EMAIL\""): # qal_display_name: If Email
                    with process_step(display_name="A03 - Outlook input adapter and extrator", description_md_key="MD2222") as step_bbbbbb:
                        log.info(msg=_("\"Starting A03 — Outlook EMAIL_POLL\"")) # qal_display_name: Starting A03 — Existing email extraction and OCR
                        with process_step(display_name="Email folder extraction", description_md_key="MD3333") as step_cccccc:
                            _("email_metadata").lhs = _("{}") # qal_display_name: email_metadata
                            _("user_id").lhs = _("\"claims@example.com\"") # qal_display_name: user_id
                            _("outlook_folder_list ").lhs = qactions.msexchange_v2.ListMailFolders(q_action_connector_id=_("q_action_connector_config(\"action_connector_id_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a\")"), user_id=_("user_id"), include_hidden_folders=_("False"), top=_("50")) # qal_display_name: List mail folders
                            if __deactivated_step__:
                                _("inbox_folder").lhs = invoke_code_block(id="function_51f7d3", args=_("{\"outlook_folders\": outlook_folder_list}")) # qal_display_name: Pick Pending folder
                        for current_mail in _("outlook_messages"): # qal_display_name: Loop through emails
                            with process_step(display_name="Read Photo", description_md_key="MD74802b41") as step_c5acff:
                                try:
                                    _("attachment_quality_agent").lhs = agents.agents.use_inline_agent(instruction=_("f\"\"\"CLAIMS ATTACHMENT OCR QUALITY GATE\n\nReturn JSON like {{\n  \"is_logo\": false\n}}\nUser: {user_id}\"\"\""), agent_mode=_("{\"mode\": \"pro\"}"), agent_name=_("\"Attachment Quality Gate\""), outputSchema=_("{\"type\":\"object\",\"properties\":{\"attachment_quality_raw\":{\"type\":\"object\"}},\"required\":[\"attachment_quality_raw\"]}")) # qal_display_name: Attachment Quality Gate
                                    if _("attachment_quality.get(\"passes\")"): # qal_display_name: If attachment passes
                                        _("message_ocr_results.append(validated_document)") # qal_display_name: Append to message_ocr_results
                                        qactions.amazon_s3.UploadFile(q_action_connector_id=_("q_action_connector_config(\"action_connector_id_0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b\")"), File=_("cleaned_attachment_file"), Bucket=_("bucket_name"), Key=_("attachment_s3_destination[\"key\"]")) # qal_display_name: Upload file
                                    else:
                                        log.info(msg=_("\"OCR skipped for \" + str(attachment_quality.get(\"attachment_name\"))")) # qal_display_name: OCR skipped
                                except AutomationException as error:
                                    log.info(msg=_("error[\"message\"]")) # qal_display_name: execption error log
                        with h_2ad0ad.excel() as excel_1a2b3c:
                            _("workbook").lhs = excel_1a2b3c.open_new_file() # qal_display_name: Create new workbook
                        for current_case_input in deque_cases(case_type=_("\"claim-adjudication\"")): # qal_display_name: Process Ready Cases
                            with current_case_input.acquire():
                                _("current_case").lhs = _("current_case_input") # qal_display_name: current_case_input
                        _("created").lhs = case_management.create_new_case(case_type=_("claim_case_type"), case_data=_("case_payload")) # qal_display_name: Create Case
                else:
                    if _("run_mode == \"PORTAL\""): # qal_display_name: If decision
                        log.info(msg=_("\"Starting A04 — Portal item\"")) # qal_display_name: Starting A04 — Portal item
                    else:
                        log.info(msg=_("\"Starting A05 — Existing CL\"")) # qal_display_name: Starting A05 — Existing CL
                log.info(msg=_("\"Total Cases created \" + str(cases_created)")) # qal_display_name: Write log message
            else:
                _("run_status").lhs = _("\"FAILED\"") # qal_display_name: run_status
                return _("{\n    \"items_discovered\": items_discovered,\n    \"cases_created\": cases_created\n}")
        return _("{\n    \"items_discovered\": items_discovered,\n    \"cases_created\": cases_created\n}")

@code_block(title="function_ad1c3d")
def function_ad1c3d(names_1, names_2):
    '''python
    out = []
    for n in (names_1 or "").split(",") + (names_2 or "").split(","):
        if n.strip():
            out.append(n.strip())
    return out
    '''

@code_block(title="function_36184d")
def function_36184d(run_mode):
    '''python
    mode = str(run_mode or "").strip().upper()
    return {"valid": mode in ("EMAIL", "PORTAL"), "mode": mode}
    '''

@code_block(title="function_51f7d3")
def function_51f7d3(outlook_folders):
    '''python
    for f in outlook_folders or []:
        if f.get("displayName") == "Pending":
            return f
    return None
    '''

__qal_version__(2,0,0)
