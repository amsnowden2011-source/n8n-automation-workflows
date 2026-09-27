# Production n8n Workflows & Automation Architecture

A collection of production-tested n8n workflow blueprints demonstrating multi-agent routing, webhook event handling, API data transformation, and automated business operations.

## Key Workflows

* **AI Lead Enrichment & Confidence-Gated Routing (`smartlead_ai_enrichment___routing__confidence_gated_.json`):** Evaluates incoming lead replies, assesses intent confidence scores, and routes high-probability opportunities while isolating edge cases for human review.
* **Client Onboarding & Contract Pipeline (`client_onboarding___msa_signed.json`):** Listens for e-signature completion webhooks, executes deduplication and signature verification checks, and triggers downstream billing and workspace provisioning.
* **Community Monitor & Alert Agent (`community_monitor_agent.json`):** Monitors incoming event feeds, parses JSON message payloads, and distributes prioritized alerts.
* **SalesGod Adapter (`salesgod_adapter.json`):** Normalizes, formats, and transforms external API data payloads across connected CRM endpoints.
