# Commercial Lead Router — Async Setup & Support Guide

Technical reference for deploying and troubleshooting the **Commercial Lead Router (Confidence Gated)** workflow. Tested on self-hosted n8n 2.30.x.

---

## 1. What gets deployed

| Flow | Webhook | Purpose |
|------|---------|---------|
| A — Inbound lead | `POST /webhook/commercial-lead-inbound` | LLM scores lead → auto-enroll if `QUALIFIED` and `confidence ≥ threshold`, else Approve/Reject email → enroll → CRM log |
| B — Prospect reply | `POST /webhook/commercial-lead-reply` | LLM classifies reply → `Positive`/`Question`/`Unknown` held for human review, `Not Interested` dropped |

Safety rules built in:
- Both webhooks require a Header Auth header; with no credential attached they reject every request.
- Lead fields and replies reach the model as escaped JSON inside `<lead_data>` / `<prospect_reply>` tags, with instructions in a separate system message.
- LLM failure, bad JSON, `NOT_QUALIFIED`, a score outside 0–100, or lead fields with instruction-like text (flagged as **Input check** in the approval email) → human approval (never auto-sent).
- Approval callback is **default-reject**: only `decision=approve|approved|yes` or `"approved": true` enrolls.
- CRM records carry `dedupe_key: lead-router:inbound:<email>` and `route: auto_qualified | human_approved`.

---

## 2. Setup checklist

### 2.1 Container environment
Only one env var matters: `WEBHOOK_URL` (recommended), the public base URL with trailing `/` (e.g. `https://n8n.yourcompany.com/`). Without it, approval links (`$execution.resumeUrl`) point to `localhost`. API keys go in credentials (§2.2), so leave n8n's default `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`.

Env vars are fixed when a container is created. `docker restart` does **not** apply new values. Recreate the container (`docker rm -f n8n` then `docker run ... -e VAR=value -v n8n_data:/home/node/.n8n ...`, or `docker compose up -d`). Workflows and credentials live in the `n8n_data` volume and are kept.

Verify:
```bash
docker exec n8n printenv WEBHOOK_URL
```
Use your container name if it isn't `n8n` (`docker ps --format '{{.Names}}\t{{.Image}}'`).

### 2.2 Credentials
1. **Catch Inbound Lead** and **Reply Received Webhook** → *Header Auth* (e.g. name `X-Webhook-Secret`, value = long random string). Callers must send this header.
2. **Enroll in Email Campaign** → *Query Auth*: name `api_key`, value = email platform key.
3. **Log to CRM** → *Header Auth*: name `Authorization`, value `Bearer <CRM key>`.
4. **Qualification Chat Model** and **Reply Chat Model** → Ollama (`http://host.docker.internal:11434`), OpenAI, or Anthropic.
5. **Send Approval Email** and **Notify Admin** → one SMTP credential.

### 2.3 Configuration node (`⚙️ CONFIGURATION - EDIT HERE FIRST`)
`confidence_threshold` (0–100, e.g. `85`), `email_platform_base_url` (no trailing slash), `campaign_id`, `crm_webhook_url`, `lead_source`, `approver_email`, `admin_email`, `notification_from_email` (must be allowed by SMTP provider).

### 2.4 Test, then activate
Test URLs (`/webhook-test/...`) only listen after you click **Execute workflow**, and only for one request. Click it again before each test call.

```bash
# Run from this folder so the @sample files resolve
curl -X POST "https://<n8n>/webhook-test/commercial-lead-inbound" \
  -H "X-Webhook-Secret: <your-secret>" \
  -H "Content-Type: application/json" -d @inbound_lead_sample.json

# Flow B: click "Execute workflow" again first
curl -X POST "https://<n8n>/webhook-test/commercial-lead-reply" \
  -H "X-Webhook-Secret: <your-secret>" \
  -H "Content-Type: application/json" \
  -d @reply_sample.json
```
To force the human path, temporarily set `confidence_threshold` to `101`. Scores max out at `100`, so no lead can auto-enroll. Then click **Approve** in the email, and set the threshold back afterwards.

Go-live: toggle the workflow **Active**, then switch callers to the production URLs:
- `https://<n8n>/webhook/commercial-lead-inbound`
- `https://<n8n>/webhook/commercial-lead-reply`

---

## 3. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| HTTP nodes return **401** | Credential missing or wrong key | Check the Query Auth (`api_key`) on **Enroll in Email Campaign** and the Header Auth (`Authorization: Bearer …`) on **Log to CRM** (§2.2) |
| Webhook returns **403** or **500 "No authentication data defined on node"** | Caller didn't send the header, or no Header Auth credential is attached to the trigger | Attach the credential (§2.2) and send the exact header name and value |
| **404** on webhook | `/webhook/` while workflow inactive, or `/webhook-test/` without clicking "Execute workflow" first (it listens for one call only) | Use the URL that matches the mode |
| Approve/Reject links open `localhost` | `WEBHOOK_URL` unset | Set public URL with trailing `/`, then **recreate** the container (§2.1) |
| Every lead goes to human review | Model returns non-JSON / low score, threshold too high, or lead fields trip the input screen | Check **Qualify Lead** output and the email's **Input check** row; set temperature `0`–`0.2`; use a larger model; review threshold |
| Clicking Approve does nothing / rejects | Callback lacks an explicit approve value, or the link points at `localhost` | The link needs `decision=approve` (or `approved`/`yes`), or the body needs `"approved": true`. Check `WEBHOOK_URL` and the **Parse Approval Decision** output |
| Executions stuck in "Waiting" | Approval never clicked (no timeout by default) | Set *Limit Wait Time* on **Wait for Human Approval**, or resume/stop manually |
| No approval email, admin alert received | SMTP failure | Fix SMTP creds / From address; execution is still in Wait and resumable |
| Lead enrolled but no CRM record | **Log to CRM** failed after retries | Re-post record manually from the Notify Admin payload (dedupe key prevents dupes if CRM honors it) |
| Enroll fails, nothing in CRM | Email platform rejected call (bad URL, campaign ID, key) | Check `email_platform_base_url` (no trailing slash), `campaign_id`; edit node if API uses header auth |
| Ollama execution dies mid-run | OOM on CPU host < ~6 GB RAM with 7B+ model | Use `llama3.2:3b` or a cloud provider |
| Ollama connection refused | Wrong base URL from inside container | Use `http://host.docker.internal:11434` (Linux: add `--add-host=host.docker.internal:host-gateway`) |
| Flow B returns `intent: Unknown` | Model output not parseable or not one of the three intents | Held for human review; raw text is in `draft_reply`. Tighten model/temperature |
| Duplicate leads in CRM | CRM ignores `dedupe_key` | Configure CRM upsert on `dedupe_key` or `email` |

### Error-handling map
| Node | Behavior on failure |
|------|---------------------|
| Qualify Lead | Alerts admin + routes to approval email |
| Confidence Gate | Bad JSON, non-`QUALIFIED`, score outside 0–100, or input screen hit → human path |
| Send Approval Email | Alerts admin, still enters Wait |
| Enroll in Email Campaign | Retry, 30 s timeout → alert; no CRM write |
| Log to CRM | Retry, 30 s timeout → alert; lead already enrolled |
| Analyze Reply | Alerts admin |
| Parse Reply Intent | Never throws (`intent: Unknown` → human review) |
| Notify Admin | Continues even if alert email fails |

Notify Admin includes workflow name, execution ID, failed node, and full error JSON — ask the client to forward it with any support request.

---

## 4. Payload contract

**Inbound lead** — required: `email`, `firstName`, `lastName`, `company`, `title`. Optional: `linkedinUrl`, `companyDomain`, `phone`, `source` (overrides `lead_source`).

**Reply** — required: `msg` (or `reply`). Optional: `email` / `lead_email` / `to_email`, `campaign_id`.

---

## 5. Info to collect from client for async setup
- n8n version, hosting (Docker/cloud), public URL
- LLM provider + model (and host RAM if Ollama)
- Email platform API base URL, campaign ID, auth style (query vs header)
- CRM webhook URL and auth method
- SMTP host/user, allowed From address
- Approver and admin email addresses, desired confidence threshold
- Execution ID + Notify Admin email for any failure
