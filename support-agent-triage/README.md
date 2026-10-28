# Support Agent Triage

An email support agent for buyers of the Commercial Lead Router template. It reads the support inbox, filters out anything that isn't a real customer question, answers from the product documentation with Claude, checks the reply for leaks, and escalates to the operator whenever it can't answer safely.

---

## Flow

```
Email Read (IMAP, UNSEEN)
  └─► Intake filter (If)
        └─► Sanitize
              └─► Rate Limit
                    └─► Allowed?
                          ├─ yes ─► Read System Docs ─► Extract Docs ─► Message a model (Claude)
                          │                                                ├─ ok ──► DLP Guard ─► Reply OK?
                          │                                                │                        ├─ yes ─► Send AI Reply
                          │                                                │                        │           └─ error ─► Alert: No Reply Sent
                          │                                                │                        └─ no ──► Alert: No Reply Sent
                          │                                                └─ error ─► Alert: No Reply Sent
                          └─ no ──► Global Limit Alert? ─► Alert: Global Limit Hit
```

## Intent classification

Classification happens in two stages, with deterministic rules first and the model second.

**Stage 1: deterministic intake filter.** A message is processed only if the subject contains `support` and it looks like it came from a person. Messages are dropped if:

| Signal | Rule |
|---|---|
| Sender | `mailer-daemon`, `postmaster`, `noreply`/`no-reply`, or the support address itself (stops self-loops) |
| `Auto-Submitted` | Any value other than `no` |
| `Precedence` | `bulk`, `junk`, `list` or `auto_reply` |
| List / auto-reply headers | `List-Id`, `List-Unsubscribe`, `X-Autoreply`, `X-Autorespond` or `X-Auto-Response-Suppress` is present |
| Authentication | `dmarc=fail` in `Authentication-Results` |

**Stage 2: model intent routing.** The system prompt sorts each question into one of three outcomes:

| Intent | Model action |
|---|---|
| Setup, configuration, credentials, environment variables, troubleshooting | Answered directly, using only the reference docs |
| Business strategy, sales or marketing advice | Declined. Out of scope. |
| Custom architecture, custom development, hands-on account help | Escalated: the customer is pointed to the operator's direct support contact |

## Context preservation

| Context | How it's kept |
|---|---|
| Product knowledge | The current setup guide is read from disk and inserted on every run, so answers follow the docs as they stand at that moment, not a stale embedding. |
| Thread | The reply keeps the original subject (adding `Re:` only if missing) so it threads in the customer's client. |
| Sender identity | `Sanitize` reduces `From` to exactly one plain address. A header with a comma or several `@` signs is dropped, so a crafted header can't redirect the reply. |
| Message body | HTML tags, zero-width characters and bidi controls are removed. Capped at 2,000 characters and passed to the model inside `<customer_inquiry>` as passive data. |
| Per-sender history | Workflow static data keeps a rolling 24-hour reply ledger per sender, which the rate limiter uses. |

Each email is answered on its own, with no conversation memory across messages. The thread subject and the customer's quoted text supply the continuity.

## Operator escalation triggers

| Trigger | Detection | Operator receives |
|---|---|---|
| Model error | Error output on `Message a model` | "No reply sent to <sender>" with the error |
| DLP block | The reply matches API-key patterns (`sk-`, `pat-`, `gh*_`, `AKIA`, `xox*-`), Tailscale `100.x` IPs, markdown images/links or "system prompt" | "No reply sent" with the block reason. The reply is withheld. |
| Empty reply | No text in the model response | "No reply sent" |
| Send failure | Error output on `Send AI Reply` | "No reply sent" with the SMTP error |
| Per-sender cap | More than 5 replies to one sender in 24 hours | Message skipped silently (stops reply loops) |
| Global cap | 200 replies in 24 hours across all senders | "Daily reply limit reached" alert. New mail is skipped until the window rolls over. |
| Anything unhandled | — | Global [Error Framework](../enterprise-error-framework/) alert |

Every escalation names the sender, so the operator can answer by hand from the support inbox.
