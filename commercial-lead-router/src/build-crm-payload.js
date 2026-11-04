/**
 * @file build-crm-payload.js
 * @module commercial-lead-router/build-crm-payload
 *
 * Builds the `{ action, payload }` record that "Log to CRM" POSTs after a lead
 * has been enrolled in the email campaign.
 * Sample output: ../payload-schemas/routed-lead.json
 *
 * Source node: "Build CRM Payload" (Code node, Run Once for Each Item).
 *
 * Two branches reach this node: the auto-qualified branch (confidence gate
 * passed) and the human-approved branch. The caller reports which branch ran
 * through `viaHuman`, so one node serves both instead of two copies.
 *
 * The node does not call the LLM again. It reuses the gate's existing score:
 * a second inference would double the cost and could contradict the routing
 * decision that was already made.
 *
 * n8n usage (Code node, "Run Once for Each Item"):
 *   // Paste safeParseGate + buildCrmPayload above this. Code nodes cannot
 *   // require() local files unless NODE_FUNCTION_ALLOW_EXTERNAL is configured.
 *   let viaHuman = false;
 *   try { viaHuman = $('Wait for Human Approval').isExecuted; } catch (e) {}
 *   let approval = null;
 *   if (viaHuman) { try { approval = $('Parse Approval Decision').first().json; } catch (e) {} }
 *   return {
 *     json: buildCrmPayload({
 *       config:           $('⚙️ CONFIGURATION - EDIT HERE FIRST').first().json,
 *       lead:             $('Catch Inbound Lead').first().json.body,
 *       qualifyText:      $('Qualify Lead').first().json.text,
 *       viaHuman,
 *       approval,
 *       campaignResponse: $json,
 *     }),
 *   };
 */

'use strict';

/**
 * @typedef {Object} RouterConfig
 * Values from the "⚙️ CONFIGURATION - EDIT HERE FIRST" Set node.
 * @property {string} campaign_id   - Campaign the lead was enrolled in.
 * @property {string} [lead_source] - Fallback `source` when the lead does not supply one.
 */

/**
 * @typedef {Object} InboundLead
 * Body of the "Catch Inbound Lead" webhook (see ../payload-schemas/inbound-lead.json).
 * @property {string} email
 * @property {string} [firstName]
 * @property {string} [lastName]
 * @property {string} [company]
 * @property {string} [companyDomain]
 * @property {string} [title]
 * @property {string} [linkedinUrl]
 * @property {string} [phone]  - Usually absent: most inbound sources are email-only.
 * @property {string} [source]
 */

/**
 * @typedef {Object} ApprovalDecision
 * Output of parse-approval-decision.js. Only `decided_by` is read here.
 * @property {string} [decided_by]
 */

/**
 * @typedef {Object} CrmRecord
 * @property {'inbound_routing'} action
 * @property {Object}  payload
 * @property {string}  payload.email
 * @property {string}  [payload.first_name]
 * @property {string}  [payload.last_name]
 * @property {string|null} payload.phone          - `null` when not supplied (the CRM enriches it).
 * @property {string|null} payload.company_name
 * @property {string|null} payload.company_domain
 * @property {string|null} payload.job_title
 * @property {string|null} payload.linkedin_url
 * @property {Object}  payload.enrichment
 * @property {boolean} payload.enrichment.needs_phone_lookup - `true` when `phone` is `null`.
 * @property {string[]} payload.enrichment.available_vectors - Names of the populated firmographic fields.
 * @property {number}  payload.enrichment.vector_count
 * @property {Object}  payload.qualification
 * @property {string|null} payload.qualification.intent     - From the gate's JSON, else `null`.
 * @property {number|null} payload.qualification.confidence - From the gate's JSON, else `null`.
 * @property {'auto_qualified'|'human_approved'} payload.qualification.route
 * @property {string}  payload.qualification.decided_by     - `'llm-gate'`, or the reviewer's identity.
 * @property {Object}  payload.campaign
 * @property {string}  payload.campaign.campaign_id
 * @property {true}    payload.campaign.enrolled           - Always `true`. This node only runs after enrollment.
 * @property {string|null} payload.campaign.response_id    - Enrollment ID from the email platform, else `null`.
 * @property {string}  [payload.source]
 * @property {string}  payload.dedupe_key                 - `lead-router:inbound:<email>`, for idempotent CRM upserts.
 */

/**
 * Parse an LLM chain's JSON-string output without ever throwing.
 *
 * @param {*} text - Raw `text` from the "Qualify Lead" chain. Markdown ```json fences are stripped.
 * @returns {{intent?: string, confidence?: number}} Parsed object, or `{}` if the text is missing or invalid.
 */
function safeParseGate(text) {
  try {
    return JSON.parse(String(text || '{}').replace(/```json|```/g, '').trim());
  } catch (e) {
    return {};
  }
}

/**
 * Assemble the CRM record for an enrolled lead.
 *
 * Defensive fallbacks:
 * - Missing `lead` → treated as `{}`. Fields come out `undefined`/`null`, and
 *   the node does not crash.
 * - Missing or invalid gate output → `intent` and `confidence` are `null`.
 *   The record is still sent: the lead is already enrolled and must be logged.
 * - `viaHuman` with no `approval` → `decided_by` falls back to `'human-reviewer'`.
 * - Missing phone → `phone: null` and `needs_phone_lookup: true`. Rather than
 *   failing, the record lists which identifiers the CRM can enrich from
 *   (`available_vectors`), so a phone that stays null can be traced back.
 * - Enrollment response ID → `campaignResponse.id`, then `campaignResponse.data.id`,
 *   else `null` (response shapes vary by email platform).
 * - `source` → the lead's own `source`, else `config.lead_source`.
 *
 * @param {Object}         args
 * @param {RouterConfig}   args.config             - Configuration node values.
 * @param {InboundLead}    [args.lead={}]          - Inbound webhook body.
 * @param {*}              [args.qualifyText]      - Raw `text` from "Qualify Lead" (JSON string).
 * @param {boolean}        [args.viaHuman=false]   - `true` if the human-approval branch ran.
 * @param {ApprovalDecision|null} [args.approval=null] - Reviewer decision (human branch only).
 * @param {Object}         [args.campaignResponse={}] - Response from "Enroll in Email Campaign" (`$json`).
 * @returns {CrmRecord}
 */
function buildCrmPayload({
  config,
  lead,
  qualifyText,
  viaHuman = false,
  approval = null,
  campaignResponse = {},
}) {
  const cfg = config || {};
  const l = lead || {};
  const res = campaignResponse || {};
  const gate = safeParseGate(qualifyText);

  // Most inbound sources are email-only, so phone is expected to be null.
  // The CRM gets every identifier it can find a number from and enriches it natively.
  const phone = l.phone || null;

  const firmographics = {
    company_name: l.company || null,
    company_domain: l.companyDomain || null,
    job_title: l.title || null,
    linkedin_url: l.linkedinUrl || null,
  };

  // Lists which fields are actually populated, so a null phone can be traced
  // back instead of looking like a silent enrichment failure on the CRM side.
  const vectors = Object.entries(firmographics)
    .filter(([, v]) => v)
    .map(([k]) => k);

  return {
    action: 'inbound_routing',
    payload: {
      email: l.email,
      first_name: l.firstName,
      last_name: l.lastName,
      phone,

      ...firmographics,

      enrichment: {
        needs_phone_lookup: phone === null,
        available_vectors: vectors,
        vector_count: vectors.length,
      },

      qualification: {
        intent: gate.intent ?? null,
        confidence: gate.confidence ?? null,
        route: viaHuman ? 'human_approved' : 'auto_qualified',
        decided_by: viaHuman ? (approval?.decided_by ?? 'human-reviewer') : 'llm-gate',
      },

      campaign: {
        campaign_id: cfg.campaign_id,
        enrolled: true,
        response_id: res.id ?? res.data?.id ?? null,
      },

      source: l.source || cfg.lead_source,
      dedupe_key: `lead-router:inbound:${l.email}`,
    },
  };
}

module.exports = { buildCrmPayload, safeParseGate };
