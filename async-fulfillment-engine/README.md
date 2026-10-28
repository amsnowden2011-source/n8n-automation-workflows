# Async Fulfillment Engine

Turns a Gumroad "done-for-you setup" purchase into a staged, client-specific Commercial Lead Router workflow, with a human QA approval before anything ships.

---

## Flow

```
Buyer (after Gumroad purchase)
  └─► GET/POST /form/client-intake         (public n8n Form Trigger; the only public form path)
        └─► Build & Stage Lead Router      (HTTP → qc-builder /stage, Header Auth)
              ├─ ok ──► Dispatch QA Alert (Telegram: client, stack, rebuild flag, approve/rebuild links)
              │           └─► Wait for QA Decision (resume webhook)
              │                 └─► Route Decision
              │                       ├─ decision=approve ─► Notify Shipped
              │                       └─ anything else ────► Notify Rebuild Queued
              └─ error ─► Notify Staging Failed (Telegram, with the reason; nothing is built)
```

The resume links in the QA alert use `/webhook-waiting/*`, one of the four path prefixes Caddy exposes publicly. The n8n editor stays on the Tailscale tailnet.

## Intake contract

| Form field | Type | Server-side validation (qc-builder) |
|---|---|---|
| Company Name | text | Required. Control characters stripped. Max 80. |
| Contact Email | email | Required. Strict address regex. Max 254. |
| CRM Platform | dropdown | One of HubSpot, Salesforce, Pipedrive, Zoho CRM |
| CRM API Key / Access Token | password | 1–512 printable characters, no whitespace |
| Cold Outreach Platform | dropdown | One of Smartlead, Instantly, Lemlist, Apollo |
| Cold Outreach API Key | password | 1–512 printable characters, no whitespace |
| Outreach Campaign ID | text | Max 64, with a format regex for each platform |

Form validation is cosmetic. The builder re-validates every field and returns `400` with a readable reason, which ends up in the "staging failed" alert.

## qc-builder: deterministic builds and dynamic secrets

`qc-builder` is a small Python HTTP service in `/opt/qc-builder`. It listens only on the Docker bridge and requires an `X-Stage-Token` header.

**Deterministic IDs.** The company name is slugged and hashed (`sha256(slug:tag)`) to derive a stable workflow ID and three credential IDs. Re-submitting the form for the same client overwrites that client's workflow (flagged as a *rebuild* in the QA alert) instead of creating duplicates.

**Dynamic secret generation.** On the first build for a client:

1. A 256-bit webhook secret is generated with `secrets.token_urlsafe(32)`.
2. It is written to `/opt/qc-builder/secrets/<workflow-id>.webhook-secret` with mode `0600`.
3. A Header Auth credential holding that secret is imported into n8n and bound to the client's two webhook triggers.

Rebuilds reuse the existing secret, so the client's integrations keep working.

**Credential handling.** The client's CRM and outreach keys go straight into n8n credentials, which n8n encrypts at rest. The builder never logs request bodies (only the request line), and the staged workflow references credentials by ID only.

**Staged, not live.** Every build is imported with `active: false`. The workflow goes live only after QA approval and a manual activation.

## Failure handling

| Failure | Result |
|---|---|
| Validation error | `400` → "Lead Router staging FAILED" Telegram alert with the reason. No workflow or credential is created. |
| Builder unreachable or 5xx | Same error branch, with the HTTP error as the reason |
| Unhandled error elsewhere | Global [Error Framework](../enterprise-error-framework/) |
| Ambiguous QA callback | Anything other than `decision=approve` queues a rebuild. It never ships. |
