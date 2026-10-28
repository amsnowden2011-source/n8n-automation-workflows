# Commercial Lead Router (Confidence Gated)

[![Buy Template on Gumroad](https://img.shields.io/badge/Gumroad-Buy_Template_$47-black?style=for-the-badge&logo=gumroad)](https://quietcommercehq.gumroad.com/l/ddqvgd)
[![Get Done-For-You Setup](https://img.shields.io/badge/QuietCommerce-Async_Setup_$197-blue?style=for-the-badge)](https://quietcommercehq.gumroad.com/l/ddqvgd)

An n8n workflow that scores inbound B2B leads with an LLM. It auto-enrolls the ones it is confident about into a cold-email campaign and sends everything else to a human for one-click Approve/Reject. Every enrolled lead is written to your CRM. A second webhook classifies prospect replies and holds the positive ones for review.

- Commercial Template — Available on Gumroad / Inquire at alexander@quietcommercehq.com for direct licensing & deployment
- **Workflow file:** not in this repository. The importable `commercial_lead_router.json` is delivered with the Gumroad purchase.
- **Schema:** [`inbound_lead_schema.json`](inbound_lead_schema.json) (JSON Schema 2020-12, types + required fields)
- **Test payloads:** [`inbound_lead_sample.json`](inbound_lead_sample.json) (Flow A), [`reply_sample.json`](reply_sample.json) (Flow B)
- **Tested on:** n8n 2.30.x, self-hosted (last verified against the Gumroad build; this repo pins no n8n version)

---

## Architecture

```
FLOW A: inbound lead
POST /webhook/commercial-lead-inbound
  └─► ⚙️ CONFIGURATION (8 variables)
        └─► Qualify Lead (LLM → {"intent","confidence"})
              ├─ ok ──► Confidence Gate (confidence ≥ threshold?)
              │           ├─ yes ─────────────────────────────┐
              │           └─ no ──► Send Approval Email       │
              │                       └─► Wait for Human Approval (resume URL)
              │                             └─► Parse Approval Decision
              │                                   └─► Approved?
              │                                         ├─ yes ┤
              │                                         └─ no ──► Rejected - No Action
              │                                                 ▼
              │                                   Enroll in Email Campaign (HTTP POST)
              │                                         └─► Build CRM Payload
              │                                               └─► Log to CRM (HTTP POST)
              └─ error ─► Notify Admin + Send Approval Email (fail toward a human)

FLOW B: prospect reply
POST /webhook/commercial-lead-reply
  └─► Analyze Reply (LLM → {"intent","draft_reply"})
        └─► Parse Reply Intent
              └─► Positive Reply?  (Positive | Question)
                    ├─ yes ─► Wait for Human Review
                    └─ no ──► Not Interested - No Action
```

Design choices:

- **Fail toward a human.** Only a lead the model marks `QUALIFIED` with a valid 0–100 confidence at or above the threshold is auto-enrolled. A failed call, unparseable output, `NOT_QUALIFIED`, or an out-of-range score goes to the approval email instead.
- **Default-reject approvals.** Only an explicit `decision=approve` (or `approved`/`yes`, or `"approved": true` in the body) enrolls a lead. A bare ping or anything ambiguous counts as a rejection.
- **One CRM builder for both paths.** `Build CRM Payload` checks whether the human-approval branch ran and stamps `route: auto_qualified | human_approved`. It reuses the gate's score rather than calling the model a second time.
- **Untrusted input stays data.** Prompt instructions live in a system message; lead fields and prospect replies are passed as escaped JSON inside `<lead_data>` / `<prospect_reply>` tags, and the model is told never to follow instructions found there. Because small models can still be talked round, the gate also refuses to auto-enroll any lead whose fields contain instruction-like text (line breaks, `{}<>`, words such as *ignore*, *system*, *respond*, *qualified*, *confidence*) or values over 150 characters. Those leads go to the approval email with an **Input check** warning. Lead values are HTML-escaped in every email, and API keys are redacted from admin alerts.
- **Authenticated by default.** Both webhook triggers use Header Auth and reject every request until you attach a credential.
- **Idempotency hint.** Every CRM record carries `dedupe_key: lead-router:inbound:<email>` so the CRM can drop duplicate records.

## 15-minute quickstart

| Min | Step |
|-----|------|
| 2–5 | **Credentials.** Attach a *Header Auth* credential to both webhook triggers, *Query Auth* to **Enroll in Email Campaign** and *Header Auth* to **Log to CRM** (see [Required credentials](#required-credentials)). No env vars are needed. |
| 5–8 | **LLM credentials.** Open **Qualification Chat Model**, then *Credential* → *Create new* → Ollama base URL (e.g. `http://host.docker.internal:11434`). Do the same for **Reply Chat Model**. To use a cloud model, see [LLM provider swap](#llm-provider-swap-ollama--openai--anthropic). |
| 8–9 | **SMTP credential.** Attach one SMTP credential to **Send Approval Email** and **Notify Admin**. |
| 9–12 | **Config.** Open **⚙️ CONFIGURATION - EDIT HERE FIRST** and fill in the [8 variables](#configuration-variables). |
| 12–15 | **Test.** Click *Execute workflow*, then send the sample lead to the **test** URL: |

```bash
curl -X POST "https://<your-n8n>/webhook-test/commercial-lead-inbound" \
  -H "X-Webhook-Secret: <your-secret>" \
  -H "Content-Type: application/json" \
  -d @inbound_lead_sample.json
```

Look at the execution. A high score should go straight to **Enroll in Email Campaign**. To force the human path, set `confidence_threshold` to `101` (scores max out at 100), re-run, and click **Approve** in the email. When the run looks right, toggle the workflow **Active** and change `/webhook-test/` to `/webhook/` in the URL.

The sample omits `source` on purpose so the run exercises the `lead_source` fallback. Add a `source` field to the payload to test the override path.

To test Flow B:

```bash
curl -X POST "https://<your-n8n>/webhook-test/commercial-lead-reply" \
  -H "X-Webhook-Secret: <your-secret>" \
  -H "Content-Type: application/json" \
  -d @reply_sample.json
```

Once the workflow is **Active**, switch both URLs from `/webhook-test/` to `/webhook/`.

## Configuration variables

All 8 values are set in the **⚙️ CONFIGURATION - EDIT HERE FIRST** Set node. Downstream nodes read them with `$('⚙️ CONFIGURATION - EDIT HERE FIRST').first().json.<name>`.

| # | Variable | Type | Purpose | Example |
|---|----------|------|---------|---------|
| 1 | `confidence_threshold` | number | Minimum model confidence (0–100) for auto-enroll. Anything lower goes to a human. | `85` |
| 2 | `email_platform_base_url` | string | API root of your cold-email platform, no trailing slash. | `https://server.yourplatform.com/api/v1` |
| 3 | `campaign_id` | string | Campaign that approved leads are enrolled into. | `4821993` |
| 4 | `crm_webhook_url` | string | Endpoint that receives the final `{action, payload}` record. | `https://hooks.yourcrm.com/inbound/leads` |
| 5 | `lead_source` | string | Fallback source label, used when the payload has no `source`. | `website-demo-form` |
| 6 | `approver_email` | string | Receives the Approve/Reject email for low-confidence leads. | `sales-lead@yourcompany.com` |
| 7 | `admin_email` | string | Receives node-failure alerts. | `ops@yourcompany.com` |
| 8 | `notification_from_email` | string | From address for both emails. Must be allowed by your SMTP provider. | `n8n@yourcompany.com` |

## Required credentials

Keys live in n8n credentials (encrypted at rest), not env vars, so you can keep n8n's default `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`.

| Node | Credential type | Fields |
|------|-----------------|--------|
| **Catch Inbound Lead**, **Reply Received Webhook** | Header Auth | Name e.g. `X-Webhook-Secret`, value = a long random string. Callers must send this header; until a credential is attached the webhooks reject every request. |
| **Enroll in Email Campaign** | Query Auth | Name `api_key`, value = your email platform key (Smartlead-style). If your platform wants a header, switch the node to Header Auth. |
| **Log to CRM** | Header Auth | Name `Authorization`, value `Bearer <CRM key>`. |
| Chat model sub-nodes | Ollama / OpenAI / Anthropic | See [LLM provider swap](#llm-provider-swap-ollama--openai--anthropic). |
| **Send Approval Email**, **Notify Admin** | SMTP | One credential for both. |

One env var is still recommended: `WEBHOOK_URL`, the public base URL of n8n with a trailing `/`. Without it, the Approve/Reject links (`$execution.resumeUrl`) point at `localhost`.

```bash
docker run -d --name n8n -p 5678:5678 \
  -e WEBHOOK_URL=https://n8n.yourcompany.com/ \
  -v n8n_data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n:latest
```

## LLM provider swap (Ollama / OpenAI / Anthropic)

The two **Basic LLM Chain** nodes (`Qualify Lead` and `Analyze Reply`) don't depend on the provider. Only the attached chat-model sub-nodes change. Both prompts ask for strict JSON, and every parser strips ```` ```json ```` fences, so any capable chat model works.

| Provider | Sub-node to attach | Suggested model | Credential |
|----------|--------------------|-----------------|------------|
| **Ollama** (default) | *Ollama Chat Model* | `llama3.2:3b` (ships in the export), or `llama3.1:8b` if you have ≥ 8 GB RAM | Base URL, e.g. `http://host.docker.internal:11434` |
| **OpenAI** | *OpenAI Chat Model* | `gpt-4o-mini` | OpenAI API key |
| **Anthropic** | *Anthropic Chat Model* | `claude-haiku-5-5` (fast and cheap) or `claude-sonnet-5-5` | Anthropic API key |

To swap a provider:

1. Delete **Qualification Chat Model** (and/or **Reply Chat Model**).
2. Click the **+** under *Model* on the chain node and pick the new chat model.
3. Create or attach its credential and choose the model.
4. Optional: set temperature to `0`–`0.2` on the qualification model for more stable scores.

You can use different providers in the two flows, e.g. a cloud model for qualification and a local 3B model for reply triage.

> On CPU-only hosts with less than ~6 GB RAM, Ollama models of 7B and up can be OOM-killed in the middle of an execution. Stay on 3B, or use a cloud provider.

## Error handling

| Node | Setting | What happens on failure |
|------|---------|-------------------------|
| Qualify Lead | `continueErrorOutput` | Alerts the admin **and** sends the lead to the approval email. It is never auto-sent. |
| Confidence Gate | try/catch in expression | Bad or missing JSON, an intent other than `QUALIFIED`, a score outside 0–100, or a lead that fails the input screen takes the human path. |
| Send Approval Email | `continueErrorOutput` | Alerts the admin and still enters the Wait, so the execution can be resumed by hand. |
| Parse Approval Decision | default-reject | Any unclear callback counts as a rejection. |
| Enroll in Email Campaign | `retryOnFail` + `continueErrorOutput`, 30 s timeout | Retries, then alerts the admin. Nothing is written to the CRM. |
| Log to CRM | `retryOnFail` + `continueErrorOutput`, 30 s timeout | Retries, then alerts the admin. The lead is **already enrolled**, so add the CRM record by hand from the alert payload. |
| Analyze Reply | `continueErrorOutput` | Alerts the admin. |
| Parse Reply Intent | never throws | Bad JSON or an unexpected intent gives `intent: Unknown` (raw text in `draft_reply`), which is held for human review rather than dropped. |
| Notify Admin | `continueRegularOutput` | If the alert email itself fails, the execution still finishes. |

The **Notify Admin** email includes the workflow name, execution ID, the failed node and the full error JSON, with `api_key=` values and `Bearer` tokens redacted.

Approval Waits have no timeout by default. To expire stale approvals, set *Limit Wait Time* on **Wait for Human Approval**.

## Payload reference

**Inbound lead** (`POST /webhook/commercial-lead-inbound`, with your Header Auth header): validated by [`inbound_lead_schema.json`](inbound_lead_schema.json); example body in [`inbound_lead_sample.json`](inbound_lead_sample.json). Required fields below match the schema's `required` array.

| Field | Required | Notes |
|-------|----------|-------|
| `email` | ✅ | Used to enroll the lead and as the dedupe key. |
| `firstName`, `lastName`, `company`, `title` | ✅ | Sent to the LLM prompt. |
| `linkedinUrl`, `companyDomain`, `phone` | optional | Passed to the CRM as enrichment vectors. |
| `source` | optional | Overrides `lead_source`. |

**Reply** (`POST /webhook/commercial-lead-reply`): `msg` (or `reply`) is required. `email` / `lead_email` / `to_email` and `campaign_id` are optional. Example body in [`reply_sample.json`](reply_sample.json).

## Support
For technical support and setup inquiries, contact support@quietcommercehq.com.

## Offboarding & Key Rotation

Your Commercial Lead Router engagement is now closed and my access to your n8n instance has been removed. Please rotate the following credentials today: the cold-email platform key (Query Auth on **Enroll in Email Campaign**), the CRM key (Header Auth on **Log to CRM**), the webhook header secret (Header Auth on both triggers; update every caller that sends it), and any SMTP password used by the workflow. Generate new keys in each vendor dashboard, update them in the n8n Credentials menu (no restart needed), and send one test lead to confirm enrollment and CRM logging still work. Support remains available at support@quietcommercehq.com for 14 days.
