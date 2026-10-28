# QuietCommerce HQ: Production Automation Architecture

Four n8n pipelines run QuietCommerce HQ's lead routing, product fulfillment, customer support and incident alerting. They run in production on a single self-hosted node. Each one follows the same rules: untrusted input stays data, ambiguous outcomes go to a human, and every failure path ends in an alert.

This repository documents the architecture. Workflow exports are not published here. The Commercial Lead Router template is [sold on Gumroad](https://quietcommercehq.gumroad.com/l/ddqvgd).

---

## Infrastructure

```
            Internet
               │
         Cloudflare (TLS, DNS)
               │
   ┌───────────┴─────────────────────────── Hetzner VPS ───────────────────┐
   │  Caddy  (path allowlist)                                              │
   │    /webhook/*  /webhook-test/*  /webhook-waiting/*  /form/*  ──► n8n  │
   │    everything else ──► 404                                            │
   │                                                                       │
   │  Docker                                                               │
   │    n8n  (SQLite, error workflow wired globally)                       │
   │    Ollama  (local 3B model for lead + reply scoring)                  │
   │    qc-builder  (client workflow builder, Docker bridge only)          │
   │                                                                       │
   │  Tailscale  ── editor, REST API, assets: operator tailnet only        │
   └───────────────────────────────────────────────────────────────────────┘
```

| Layer | Choice | Why |
|---|---|---|
| Host | Hetzner VPS, CPU only | Predictable cost. Model sizes are picked to fit in RAM, not GPU. |
| Runtime | Docker | n8n, Ollama and the builder are isolated. Builder ports bind only to the Docker bridge. |
| Edge | Cloudflare → Caddy | Caddy exposes only the four path prefixes live workflows need. The n8n editor and API return 404 from the internet. |
| Admin access | Tailscale | The editor, REST API, `/form-waiting` and static assets are reachable only from the operator tailnet. |

---

## The four pipelines

| Pipeline | Trigger | Model | Human checkpoint | Docs |
|---|---|---|---|---|
| **Commercial Lead Router** | Two header-authenticated webhooks (inbound lead, prospect reply) | Local Llama 3.2 3B via Ollama | Approval email below the confidence threshold. Review queue for positive replies. | [commercial-lead-router](./commercial-lead-router/) |
| **Async Fulfillment Engine** | Public n8n form `/form/client-intake` | None (deterministic builder) | Telegram QA approval before a staged build ships | [async-fulfillment-engine](./async-fulfillment-engine/) |
| **Support Agent** | IMAP poll of the support inbox | Claude Sonnet | Operator alert on any reply that is blocked, empty or fails to send | [support-agent-triage](./support-agent-triage/) |
| **Error Framework** | n8n Error Trigger (global `errorWorkflow`) | None | Every unhandled failure emails the operator | [enterprise-error-framework](./enterprise-error-framework/) |

```
Gumroad buyer ──► /form/client-intake ──► qc-builder ──► staged Lead Router (inactive)
                                                    └──► Telegram QA ──► approve / rebuild

Lead source ──► /webhook/commercial-lead-inbound ──► LLM score ──► confidence gate ──► campaign + CRM
                                                                         └──► approval email ──► human

Buyer email ──► IMAP ──► filter ──► sanitize ──► rate limit ──► Claude + docs ──► DLP ──► reply
                                                                                    └──► operator alert

Any failure in any workflow ──► Error Trigger ──► redacted SMTP alert
```

---

## Confidence gating

Every model decision is checked before anything happens outside the system, and anything uncertain goes to a human.

- The Lead Router turns the model's score into a 0.0–1.0 confidence. Only a `QUALIFIED` verdict at or above the threshold (default **0.85**) auto-enrolls a lead. See the [scoring matrix](./commercial-lead-router/README.md#confidence-scoring-matrix).
- Unparseable output, an out-of-range score or an unknown intent scores **-1**, which always goes to a human. A failed model call goes to a human and also alerts the admin.
- Approval callbacks reject by default. Only an explicit `approve` counts as approval.
- The Support Agent does not use a score. Its gate is a deterministic DLP check on the model's reply: a reply matching a secret or exfiltration pattern is withheld and the operator is alerted.

## Schema contracts

Each pipeline boundary has a documented contract, and payloads that don't match are rejected or diverted before any model runs.

| Boundary | Contract | Enforcement |
|---|---|---|
| Lead source → Lead Router | [`inbound-lead.json`](./commercial-lead-router/payload-schemas/inbound-lead.json) | Header Auth on the webhook. Field length caps and an instruction-text screen before the gate. |
| Lead Router → CRM | [`routed-lead.json`](./commercial-lead-router/payload-schemas/routed-lead.json) | One builder node for both the auto and the human route. `route` and `decided_by` record which path ran. |
| Intake form → qc-builder | Form fields documented in [async-fulfillment-engine](./async-fulfillment-engine/README.md#intake-contract) | Server-side validation: enum fields, a campaign-ID regex per platform, printable-only keys, length caps. |
| Support inbox → model | `{sender, subject, sanitized_email}` | A single plain sender address. HTML, zero-width and bidi characters stripped. 2,000-character cap. |

## Failover and fail-safe behavior

| Failure | Behavior |
|---|---|
| LLM call fails or returns junk (Lead Router) | A failed call alerts the admin and sends the approval email. Junk output scores -1 and goes to the approval email. Either way the lead is never dropped or auto-enrolled. |
| Approval email fails to send | Admin alerted. The execution still enters the Wait so it can be resumed by hand. |
| Campaign enrollment fails | Retries, then alerts the admin. Nothing is written to the CRM, so the CRM never shows a lead as enrolled when enrollment failed. |
| Client build fails (Fulfillment) | Error branch → Telegram "staging failed" with the reason. Nothing is half-built. |
| Model error, DLP block or send failure (Support) | Reply withheld → operator email naming the sender and the reason. |
| Reply loop or inbox flood (Support) | 5 replies per sender and 200 in total per rolling 24 hours, plus an operator alert when the global cap is hit. |
| Any unhandled node error | Global Error Framework → redacted email to the operator. |

---

## Repository layout

```
commercial-lead-router/       Confidence-gated lead routing: architecture, scoring matrix, payload schemas
enterprise-error-framework/   Global error capture and alerting
async-fulfillment-engine/     Gumroad intake → per-client workflow build → QA approval
support-agent-triage/         IMAP support agent: filtering, grounding, DLP, escalation
workflows/                    Buyer-facing template docs (workflow JSON is not published)
```
