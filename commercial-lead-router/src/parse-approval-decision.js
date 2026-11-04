/**
 * @file parse-approval-decision.js
 * @module commercial-lead-router/parse-approval-decision
 *
 * Normalises the callback a human reviewer sends to resume the
 * "Wait for Human Approval" node into a single approve/reject decision.
 *
 * Source node: "Parse Approval Decision" (Code node, Run Once for Each Item).
 *
 * Safety rule: this function DEFAULTS TO REJECT. The only leads that reach the
 * reviewer are ones the confidence gate already doubted, so an ambiguous,
 * empty or malformed callback must never enroll one in a campaign.
 *
 * n8n usage (Code node, "Run Once for Each Item"):
 *   return { json: parseApprovalDecision($json) };
 */

'use strict';

/** Decision strings (lower-cased) that count as an approval. */
const APPROVE_VALUES = new Set(['approve', 'approved', 'yes']);

/**
 * @typedef {Object} ResumeCallback
 * The item n8n emits when a Wait node resumes via its webhook URL.
 * The reviewer may call back in different ways, so every field is optional.
 * @property {Object<string, *>} [query] - Query-string params, e.g. `?decision=approve&user=sam`.
 * @property {Object<string, *>} [body]  - JSON body, e.g. `{ "decision": "approve", "user": "sam" }`
 *                                         or `{ "approved": true }`.
 */

/**
 * @typedef {Object} ApprovalDecision
 * @property {boolean} approved   - `true` only for an explicit approval; consumed by the "Approved?" IF node.
 * @property {string}  decision   - Lower-cased raw decision string, or `'none'` if the callback carried none.
 * @property {string}  decided_by - Reviewer identity from `body.user` / `query.user`, else `'human-reviewer'`.
 */

/**
 * Parse a Wait-node resume callback into an approve/reject decision.
 *
 * Lookup order for the raw decision (first non-null/undefined wins):
 *   `query.decision` → `body.decision` → `query.action` → `body.action`.
 * Because this uses `??`, an empty string in an earlier field (e.g. `?decision=`)
 * stops the lookup there and is treated as "no decision", so the lead is rejected.
 *
 * Defensive fallbacks:
 * - Missing `query` / `body` objects are treated as empty (bare ping → reject).
 * - Non-string decision values are coerced with `String()` before matching.
 * - Matching is case-insensitive but exact: `'approve'`, `'approved'`, `'yes'`.
 *   Anything else (`'ok'`, `'reject'`, typos) is a rejection.
 * - `body.approved` only approves when it is the boolean `true`. The string
 *   `"true"` does NOT approve.
 *
 * @param {ResumeCallback} [callback={}] - The resumed item's JSON (`$json` in n8n).
 * @returns {ApprovalDecision} Normalised decision. Approval is never assumed.
 *
 * @example
 * parseApprovalDecision({ query: { decision: 'Approve', user: 'sam' } });
 * // → { approved: true, decision: 'approve', decided_by: 'sam' }
 *
 * @example
 * parseApprovalDecision({}); // bare ping
 * // → { approved: false, decision: 'none', decided_by: 'human-reviewer' }
 */
function parseApprovalDecision(callback = {}) {
  const q = (callback && callback.query) || {};
  const b = (callback && callback.body) || {};

  const raw = String(q.decision ?? b.decision ?? q.action ?? b.action ?? '').toLowerCase();

  const approved = APPROVE_VALUES.has(raw) || b.approved === true;

  return {
    approved,
    decision: raw || 'none',
    decided_by: b.user || q.user || 'human-reviewer',
  };
}

module.exports = { parseApprovalDecision, APPROVE_VALUES };
