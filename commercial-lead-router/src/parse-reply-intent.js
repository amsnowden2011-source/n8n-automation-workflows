/**
 * @file parse-reply-intent.js
 * @module commercial-lead-router/parse-reply-intent
 *
 * Turns the "Analyze Reply" LLM output into a typed intent, and joins it with
 * the original reply webhook so the next nodes have everything in one item.
 *
 * Source node: "Parse Reply Intent" (Code node, Run Once for Each Item).
 *
 * Safety rule: this function NEVER THROWS. A malformed, fenced or off-schema
 * model answer resolves to intent `'Unknown'`, and `'Unknown'` is held for
 * human review. A broken LLM response therefore routes a reply to a person;
 * it never fails the execution or silently drops the reply.
 *
 * n8n usage (Code node, "Run Once for Each Item"):
 *   return {
 *     json: parseReplyIntent(
 *       $json.text,
 *       $('Reply Received Webhook').first().json.body,
 *     ),
 *   };
 */

'use strict';

/**
 * Accepted intents: lower-cased model label → canonical label.
 * Anything not listed here becomes `'Unknown'`.
 * @type {Readonly<Object<string, ReplyIntent>>}
 */
const ALLOWED_INTENTS = Object.freeze({
  positive: 'Positive',
  question: 'Question',
  'not interested': 'Not Interested',
});

/** Max characters of raw model text kept as a draft when JSON parsing fails. */
const RAW_DRAFT_LIMIT = 2000;

/**
 * @typedef {'Positive' | 'Question' | 'Not Interested' | 'Unknown'} ReplyIntent
 */

/**
 * @typedef {Object} ReplyWebhookBody
 * Body POSTed to "Reply Received Webhook" by the email platform. Field names
 * vary between providers, so several aliases are accepted.
 * @property {string} [email]       - Lead email (preferred).
 * @property {string} [lead_email]  - Lead email (alias).
 * @property {string} [to_email]    - Lead email (alias).
 * @property {string} [campaign_id] - Campaign the reply belongs to.
 * @property {string} [msg]         - Reply text (preferred).
 * @property {string} [reply]       - Reply text (alias).
 */

/**
 * @typedef {Object} ParsedReply
 * @property {ReplyIntent} intent      - Canonical intent label.
 * @property {string}      draft_reply - Model-suggested response. If the model output was not
 *                                       valid JSON, this is the first 2000 chars of the raw text.
 * @property {boolean}     is_positive - `true` for `'Positive'` or `'Question'`; consumed by the
 *                                       "Positive Reply?" IF node.
 * @property {boolean}     needs_review - `true` for everything except `'Not Interested'`
 *                                       (including `'Unknown'`).
 * @property {string|null} lead_email  - First of `email` / `lead_email` / `to_email`, else `null`.
 * @property {string|null} campaign_id - From the webhook, else `null`.
 * @property {string|null} reply_text  - First of `msg` / `reply`, else `null`.
 */

/**
 * Parse an LLM chain's JSON-string output, tolerating Markdown code fences.
 *
 * @param {*} text - Raw `text` from the chain node. Non-strings are coerced; empty → `'{}'`.
 * @returns {Object} Parsed object.
 * @throws {SyntaxError} If the cleaned text is not valid JSON (callers catch this).
 */
function parseModelJson(text) {
  return JSON.parse(String(text || '{}').replace(/```json|```/g, '').trim());
}

/**
 * Classify a lead's reply from the model output and attach webhook context.
 *
 * Expected model output (in `modelText`), optionally wrapped in ```json fences:
 *   `{ "intent": "Positive" | "Question" | "Not Interested", "draft_reply": "..." }`
 *
 * Defensive fallbacks:
 * - Invalid JSON → intent `'Unknown'`. The raw text (first 2000 chars) is kept
 *   as `draft_reply` so the reviewer can still see what the model said.
 * - Intent matching trims and lower-cases the label; unrecognised labels → `'Unknown'`.
 * - A missing `draft_reply` → `''`.
 * - A missing webhook body → every webhook-derived field is `null`.
 *
 * @param {*} modelText - The `text` field from the "Analyze Reply" chain (`$json.text`).
 * @param {ReplyWebhookBody} [hookBody={}] - Body of the "Reply Received Webhook" item.
 * @returns {ParsedReply} Never throws.
 *
 * @example
 * parseReplyIntent('```json\n{"intent":"question","draft_reply":"Happy to explain."}\n```',
 *                  { email: 'dana@example.com', msg: 'How much is it?' });
 * // → { intent: 'Question', draft_reply: 'Happy to explain.', is_positive: true,
 * //     needs_review: true, lead_email: 'dana@example.com', campaign_id: null,
 * //     reply_text: 'How much is it?' }
 */
function parseReplyIntent(modelText, hookBody = {}) {
  let intent = 'Unknown';
  let draft = '';

  try {
    const parsed = parseModelJson(modelText);
    intent = ALLOWED_INTENTS[String(parsed.intent ?? '').trim().toLowerCase()] || 'Unknown';
    draft = String(parsed.draft_reply ?? '');
  } catch (e) {
    intent = 'Unknown';
    draft = String(modelText || '').slice(0, RAW_DRAFT_LIMIT);
  }

  const hook = hookBody || {};

  return {
    intent,
    draft_reply: draft,
    is_positive: intent === 'Positive' || intent === 'Question',
    // Positive, Question and anything the model got wrong are held for a person.
    needs_review: intent !== 'Not Interested',
    lead_email: hook.email || hook.lead_email || hook.to_email || null,
    campaign_id: hook.campaign_id || null,
    reply_text: hook.msg || hook.reply || null,
  };
}

module.exports = { parseReplyIntent, parseModelJson, ALLOWED_INTENTS, RAW_DRAFT_LIMIT };
