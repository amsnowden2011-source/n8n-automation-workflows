# Commercial Lead Router (Confidence Gated)

[![Buy Template on Gumroad](https://img.shields.io/badge/Gumroad-Buy_Template_$97-black?style=for-the-badge&logo=gumroad)](https://quietalexander.gumroad.com/l/commercial-lead-router)

An n8n workflow that scores inbound B2B leads with a local LLM, auto-enrolls only the confident ones into a cold-email campaign, and sends everything else to a human. A second trigger classifies prospect replies and queues the warm ones for review.

**Get it:** [quietalexander.gumroad.com/l/commercial-lead-router](https://quietalexander.gumroad.com/l/commercial-lead-router). Buyers get the workflow export, the setup guide and the payload schemas. The workflow JSON is not published in this repository.

---

## Dual-trigger paths

The workflow has two independent entry points. Both use Header Auth, and both put untrusted text inside tagged JSON so the model treats it as data, not instructions.

### Path A: inbound lead → `POST /webhook/commercial-lead-inbound`

```
Catch Inbound Lead (Header Auth)
  └─► Qualify Lead (LLM → {"intent", "confidence"})
        └─► Confidence Gate
              ├─ pass ──────────────────────────────► Enroll in Email Campaign ─► Build CRM Payload ─► Log to CRM
              └─ fail ─► Send Approval Email ─► Wait for Human Approval
                                                   └─► Parse Approval Decision (default reject)
                                                         ├─ approve ─► Enroll in Email Campaign ─► …
                                                         └─ anything else ─► Rejected, no action
```

### Path B: prospect reply → `POST /webhook/commercial-lead-reply`

```
Reply Received Webhook (Header Auth)
  └─► Analyze Reply (LLM → {"intent", "draft_reply"})
        └─► Parse Reply Intent (whitelist: Positive | Question | Not Interested, otherwise Unknown)
              ├─ Positive / Question / Unknown ─► Wait for Human Review (draft attached)
              └─ Not Interested ────────────────► No action
```

The model only drafts replies. A human always sends them. If a reply can't be classified, it becomes `Unknown` and goes to review rather than being discarded.

---

## Confidence scoring matrix

The model returns `confidence` as an integer from 0 to 100, which the gate scales to 0.0–1.0 before comparing it with `confidence_threshold`. The table shows the live threshold of **0.85**. The export ships in shadow mode at **1.01** (see below).

| Model output | Normalized score | Input screen | Route | `qualification.route` |
|---|---|---|---|---|
| `QUALIFIED`, valid score | **0.85 – 1.00** | clean | Auto-enroll → CRM | `auto_qualified` |
| `QUALIFIED`, valid score | **0.85 – 1.00** | flagged¹ | Approval email with an **Input check** warning | `human_approved` if approved |
| `QUALIFIED`, valid score | **0.00 – 0.84** | any | Approval email | `human_approved` if approved |
| `NOT_QUALIFIED` | any | any | Approval email | `human_approved` if approved |
| Unparseable JSON, missing fields, score outside 0–100 | **-1** (sentinel) | any | Approval email | `human_approved` if approved |
| Model call fails | n/a | any | Error output → admin alert **and** approval email | `human_approved` if approved |

¹ The input screen flags a lead if any of `firstName`, `lastName`, `company`, `title` or `email` is longer than 150 characters, or contains line breaks, `{}<>` or a backtick, or contains words like *ignore*, *system*, *respond*, *qualified* or *confidence*. Small models can be talked into a high score, so the gate doesn't rely on the model alone.

**Approval semantics.** Only an explicit `decision=approve` (or `approved`/`yes`, or `"approved": true`) enrolls a lead. A bare callback, an unknown value or a malformed body counts as a rejection.

**One scoring call.** `Build CRM Payload` reuses the gate's score rather than calling the model again. A second call would cost more and could contradict the routing decision.

### Shadow-mode rollout (`1.01` → `0.85`)

The workflow ships with `confidence_threshold: 1.01`. No normalized score can reach it, so every lead goes to a human while the model's score is shown in the approval email. Once reviewers agree with the model's high scores, set the threshold to `0.85` in **⚙️ CONFIGURATION - EDIT HERE FIRST** to turn on auto-enrollment. Setting it back to `1.01` is the rollback.

---

## 24h dead man's switch

`heartbeat-monitor.json` is a second, small workflow. Every 24 hours it reads the router's executions through the n8n API and, if none started in the last 24 hours, emails `admin_email`. If the API call fails, it sends a "check failed" email instead of staying silent. Alerts use the same `api_key=` / `Bearer` redaction as **Notify Admin**. It imports inactive.

```
Every 24 Hours ─► Configuration ─► Get Router Executions ─► Count Executions (Last 24h) ─► No Leads? (count == 0) ─► Send Email
                                          └─ error ─► Send Check-Failed Email
```

---

## Files

```
commercial-lead-router/
├── README.md                    # this page
├── payload-schemas/
│   ├── inbound-lead.json        # lead source → Path A (mock)
│   └── routed-lead.json         # router → CRM (mock)
└── src/                         # Code node logic as standalone JS modules
    ├── build-crm-payload.js
    ├── parse-approval-decision.js
    └── parse-reply-intent.js
```

Buyer package (`Commercial_Lead_Router_v2.zip`, not in this repo): `Commercial_Lead_Router_v2.json`, `heartbeat-monitor.json`, `README.md`, `async-setup.md`.

---

## Payload schemas

| File | Direction | Description |
|---|---|---|
| [`payload-schemas/inbound-lead.json`](./payload-schemas/inbound-lead.json) | Lead source → Path A | Sanitized mock of an inbound lead |
| [`payload-schemas/routed-lead.json`](./payload-schemas/routed-lead.json) | Router → CRM | Sanitized mock of the `{action, payload}` record sent to the CRM after enrollment |

All names, domains and IDs in the mocks are fictitious (`*.example.com`).

### Inbound Webhook Payload

```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane.doe@example.com",
  "company": "Example Industries",
  "companyDomain": "example.com",
  "title": "VP of Operations",
  "linkedinUrl": "https://www.linkedin.com/in/jane-doe-example",
  "phone": null,
  "source": "website-demo-request"
}
```

### LLM Qualification Output (Llama 3.2)

```json
{"intent":"QUALIFIED","confidence":90}
```

---

## Error handling

| Node | Strategy | Result |
|---|---|---|
| Confidence Gate | Expression wrapped in try/catch | Any parse failure scores -1 → human path |
| Send Approval Email | `continueErrorOutput` | Admin alerted. The execution still waits so it can be resumed by hand. |
| Parse Approval Decision | Default reject | An unclear callback never enrolls a lead |
| Enroll in Email Campaign | `retryOnFail` + error output, 30 s timeout | Retries, then alerts. The CRM is never written for a failed enrollment. |
| Notify Admin | Redacting formatter | `api_key=` values and `Bearer` tokens are stripped from alerts |

## Stack

n8n · Ollama (Llama 3.2 3B, CPU) · any cold-email platform with a REST enroll endpoint · any CRM with an inbound webhook · SMTP for approvals and alerts. The LLM node can be swapped for OpenAI or Anthropic without changing the gate.
