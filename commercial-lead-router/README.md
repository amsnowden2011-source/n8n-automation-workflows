# Commercial Lead Router (Confidence Gated)

[![Buy Template on Gumroad](https://img.shields.io/badge/Gumroad-Buy_Template_$47-black?style=for-the-badge&logo=gumroad)](https://quietcommercehq.gumroad.com/l/ddqvgd)

An n8n workflow that scores inbound B2B leads with a local LLM, auto-enrolls only the confident ones into a cold-email campaign, and sends everything else to a human. A second trigger classifies prospect replies and queues the warm ones for review.

**Get it:** [quietcommercehq.gumroad.com/l/ddqvgd](https://quietcommercehq.gumroad.com/l/ddqvgd). Buyers get the workflow export, the setup guide and the payload schemas. The workflow JSON is not published in this repository.

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

The model returns `confidence` as an integer from 0 to 100, which this table shows scaled to 0.0–1.0. The threshold is configurable and defaults to **0.85** (`confidence_threshold: 85`).

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
