# Enterprise Error Framework

A single n8n error workflow that every production workflow reports to. An unhandled failure anywhere sends a redacted alert email to the operator, with a link to the failed execution.

---

## Global error capture

```
Any production workflow
  settings.errorWorkflow = "QuietCommerce HQ - Error Alert"
        │  (unhandled node error, trigger error, or a deliberate throw)
        ▼
Error Trigger
  └─► Send Alert (SMTP, redacted body)
```

- **Wired at the workflow-settings level.** Every active production workflow (Fulfillment Engine, Support Agent) sets `errorWorkflow` to this workflow, so no per-node wiring is needed. New workflows are added by setting one field.
- **Two layers.** Failures a workflow expects, such as a model error, a DLP block or a failed staging call, are handled inline through `continueErrorOutput` branches with a context-specific alert. The Error Framework catches everything those branches don't.
- **Deliberate throws are tagged.** A workflow can throw on purpose, for example `DLP violation: …` in the Support Agent, and the alert subject marks these (`(DLP block, no reply sent)`) so the operator can tell a policy stop from a crash.

## Execution tracking

Each alert includes:

| Field | Source |
|---|---|
| Workflow name and ID | `$json.workflow` |
| Timestamp | ISO time when the alert was sent |
| Failed node | `execution.lastNodeExecuted`, then `error.node.name`, then `trigger` |
| Error message | Redacted (see below) |
| Execution link | `execution.url` when execution saving is on. Otherwise the alert says the execution wasn't saved. |

Execution data is pruned after 14 days (`EXECUTIONS_DATA_MAX_AGE=336`), so the link in an alert works for two weeks.

## Redaction

Error messages often contain request URLs and headers. Before sending, the alert body removes:

- Provider API keys (`sk-`, `pk-`, `rk-`, `pat-`, Slack `xox*-`, GitHub `gh*_`, AWS `AKIA…`)
- JWTs (`eyJ….….…`)
- `Bearer` / `Basic` credentials
- Values of `api_key`, `token`, `secret`, `password`, `authorization` and similar `key=value` pairs

## SMTP alerting and failover

| Layer | Current behavior |
|---|---|
| Primary channel | Authenticated SMTP (STARTTLS on 587) from the support domain to the operator mailbox |
| Independent alert paths | Fulfillment failures also go to Telegram, and Support Agent failures have their own inline SMTP alert, so one broken path doesn't hide all failures |
| Reachability | SMTP connectivity is checked from inside the n8n container as part of pre-launch audits |
| Secondary transport for this workflow | **Not yet implemented.** If SMTP itself fails, the Error Trigger execution fails and is recorded in n8n's execution log. The planned fix is a `continueErrorOutput` branch on **Send Alert** that falls back to Telegram. |
