// feedback.js — remembers what the user did with each card (Replied / Skipped, and why).
//
// This is how marKit learns. Every decision becomes one entry in
// ~/.config/markit/feedback.json:
//
//   { "version": 1, "entries": [ {
//       "id": "sc-1abc",                 post id (one entry per card)
//       "app": "gridpeek",
//       "source": "socialcrawl",
//       "community": "r/formula1",       where it was posted (subreddit, SE site, web site…)
//       "matchedKeyword": "alternative to TripIt",
//       "intent": "asking_for_recommendation",
//       "score": 92, "preScore": 71,     the agent's score and the prefilter's pre-score
//       "status": "skipped",             replied | skipped
//       "reason": "bans_promotion",      skipped only (see SKIP_REASONS), or "agent_irrelevant"
//       "note": "mods remove app links", optional, max 140 characters, plain text
//       "title": "Any app for…",         cut to 120 characters
//       "decidedAt": "2026-10-22T09:00:00.000Z"
//   } ] }
//
// Three writers, one function each:
//   - the dashboard (Replied / Skip buttons)    → recordDecision()
//   - feedback.js (the user says "skip #3" in chat) → recordDecision()
//   - report.js (the agent's own "irrelevant" verdicts) → mergeAgentVerdicts()
//
// WHY ONE FILE (feedback.json replaces the dashboard's old status.json): the dashboard's
// Replied/Skipped marks and the learning data are the same facts. Keeping them in two files
// means two writes per click and a chance of them disagreeing; one file can't drift. The
// dashboard reads its marks from here (statusMapFrom). An existing status.json is imported
// once, the first time feedback.json doesn't exist yet, and then left alone.
//
// Entries older than KEEP_DAYS (180) are dropped, like seen.json. A card decided more than
// 180 days ago therefore shows as "To do" again if you browse that old run.
//
// SAFETY: entries are built from an allow-list of card fields (never keys, never full post
// text). Titles come from strangers' posts and notes are typed by the user: both are
// stripped of HTML and control characters and cut short before they're stored.

import { existsSync } from "node:fs";
import { readJsonFile, writeJsonFile } from "./files.js";
import { stripHtml, collapseWhitespace, cutAt } from "./normalize.js";
import { SOURCE_LABELS } from "./profile.js";

export const KEEP_DAYS = 180;
export const NOTE_MAX = 140;
export const TITLE_MAX = 120;

// The decisions a user can make. "open" isn't stored: it means "clear my decision".
export const STATUSES = ["replied", "skipped"];

// Why a card was skipped. Codes are stored; labels are what the user sees.
export const SKIP_REASONS = {
  not_my_audience: "Not my audience",
  already_solved: "Already solved",
  wrong_meaning: "Wrong meaning", // the keyword matched a different topic
  too_promotional: "Too promotional to reply",
  bans_promotion: "Community bans promotion",
  other: "Other",
};
// Written only by report.js for posts the agent scored "irrelevant". Users can't pick it.
export const AGENT_REASON = "agent_irrelevant";
export const REASON_LABELS = { ...SKIP_REASONS, [AGENT_REASON]: "Agent: irrelevant" };

// Same rule the dashboard and scored.json use for post ids.
const POST_ID = /^[a-z0-9][a-z0-9:._-]{0,199}$/i;
const INTENTS = ["asking_for_recommendation", "competitor_complaint", "problem_discussion", "direct_mention", "irrelevant"];

/**
 * Plain, single-line, short text: HTML tags removed (and any "<" or ">" left over, since
 * stripHtml turns "&lt;b&gt;" back into "<b>"), control characters removed, spaces collapsed.
 */
export function cleanText(text, max) {
  const plain = collapseWhitespace(
    stripHtml(String(text ?? ""))
      .replace(/[<>]/g, "")
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
  );
  // Cut long text with one "…" (and don't stack it on a "…" the text already ended with).
  return plain.length > max ? cutAt(plain, max - 1).trimEnd().replace(/…+$/, "") + "…" : plain;
}

/** A user's note: plain text, trimmed, at most NOTE_MAX characters. */
export function cleanNote(note) {
  const plain = cleanText(note, Number.MAX_SAFE_INTEGER);
  return cutAt(plain, NOTE_MAX).trim();
}

/**
 * Turn what the user typed ("wrong meaning", "Community bans promotion", "too-promotional")
 * into a reason code. Returns "" for nothing, or null if it isn't a known reason.
 */
export function normalizeReason(input) {
  if (input === undefined || input === null || String(input).trim() === "") return "";
  const slug = String(input).toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
  if (SKIP_REASONS[slug]) return slug;
  // Also accept the full labels ("too_promotional_to_reply", "community_bans_promotion").
  for (const [code, label] of Object.entries(SKIP_REASONS)) {
    if (label.toLowerCase().replace(/[^a-z]+/g, "_") === slug) return code;
  }
  return null;
}

/**
 * Check one decision. Used by the dashboard's POST /api/status and by feedback.js, so both
 * accept exactly the same things.
 *
 * @param {{ status, reason?, note? }} input - reason must already be a code (see normalizeReason)
 * @returns {{ ok: true, status, reason, note } | { ok: false, error }}
 */
export function validateDecision({ status, reason, note } = {}) {
  if (typeof status !== "string" || ![...STATUSES, "open"].includes(status)) {
    return { ok: false, error: `status must be one of: ${[...STATUSES, "open"].join(", ")}` };
  }
  if (reason !== undefined && reason !== null && reason !== "") {
    if (typeof reason !== "string" || !SKIP_REASONS[reason]) {
      return { ok: false, error: `reason must be one of: ${Object.keys(SKIP_REASONS).join(", ")}` };
    }
    if (status !== "skipped") return { ok: false, error: "a reason only goes with status skipped" };
  }
  if (note !== undefined && note !== null && typeof note !== "string") return { ok: false, error: "note must be text" };
  return { ok: true, status, reason: reason || "", note: cleanNote(note ?? "") };
}

/**
 * Where a post lives, as a short name used to spot communities you keep skipping:
 *   "Reddit r/formula1" → "r/formula1", Stack Exchange → "Stack Exchange softwarerecs",
 *   a web result → its site name, everything else → the platform ("Hacker News").
 */
export function communityOf(post = {}) {
  const site = cleanText(post.site ?? "", 60);
  if (site) return site.replace(/^Reddit (r\/\S+)$/i, "$1");
  if (post.source === "stackexchange") {
    const m = /^se-(.+)-\d+$/.exec(String(post.id ?? ""));
    if (m) return `Stack Exchange ${cleanText(m[1], 40)}`;
  }
  if (post.source === "web") return "Web";
  return SOURCE_LABELS[post.source] ?? cleanText(post.source ?? "", 40);
}

/** Build one entry from a card (or a scored post). Only allow-listed fields are copied. */
export function entryFrom(card, { app, status, reason = "", note = "", decidedAt }) {
  return {
    id: String(card.id),
    app: String(app ?? ""),
    source: cleanText(card.source ?? "", 30),
    community: communityOf(card),
    matchedKeyword: cleanText(card.matchedKeyword ?? "", 100),
    intent: INTENTS.includes(card.intent) ? card.intent : "",
    score: Number.isFinite(card.score) ? card.score : null,
    preScore: Number.isFinite(card.preScore) ? card.preScore : null,
    status,
    reason: reason || "",
    note: cleanNote(note),
    title: cleanText(card.title || card.excerpt || "", TITLE_MAX),
    decidedAt,
  };
}

/** Is this an entry the user made (not the agent's "irrelevant" verdict)? */
export const isUserEntry = (e) => e.reason !== AGENT_REASON;

/** Drop entries older than KEEP_DAYS. */
export function prune(entries, now = new Date()) {
  const cutoff = now.getTime() - KEEP_DAYS * 86400000;
  return entries.filter((e) => new Date(e.decidedAt).getTime() >= cutoff);
}

/** Keep only entries with the basic shape (the file may have been hand-edited). */
function wellFormed(e) {
  return e && typeof e === "object" && typeof e.id === "string" && POST_ID.test(e.id) && STATUSES.includes(e.status) && !Number.isNaN(new Date(e.decidedAt).getTime());
}

/** Old dashboard marks ({ ids: { id: { status, updatedAt } } }) as minimal entries. */
function importLegacyStatus(file) {
  const data = readJsonFile(file, null);
  const ids = data && typeof data.ids === "object" && data.ids ? data.ids : {};
  return Object.entries(ids)
    .filter(([id, s]) => POST_ID.test(id) && STATUSES.includes(s?.status))
    .map(([id, s]) => entryFrom({ id }, { app: "", status: s.status, decidedAt: s.updatedAt ?? new Date(0).toISOString() }));
}

/**
 * Read feedback.json as a list of entries (pruned). If it doesn't exist yet but the old
 * status.json does, that file's marks are imported (in memory; saved on the next write).
 */
export function readFeedback(file, { legacyStatusFile, now = new Date() } = {}) {
  let entries;
  if (!existsSync(file) && legacyStatusFile && existsSync(legacyStatusFile)) {
    try {
      entries = importLegacyStatus(legacyStatusFile);
    } catch {
      entries = []; // a broken old file is just ignored
    }
  } else {
    const data = readJsonFile(file, { entries: [] });
    entries = Array.isArray(data?.entries) ? data.entries : [];
  }
  return prune(entries.filter(wellFormed), now);
}

/** The message shown when feedback.json can't be read (no path: it's shown in the dashboard too). */
export const BROKEN_FEEDBACK = "feedback.json in your marKit config folder isn't valid JSON, so your past Replied/Skipped decisions can't be used. Fix or delete it, then try again.";

/**
 * Like readFeedback, but a broken file never stops the caller: learning is optional, a run
 * isn't. Returns { entries, broken }; when broken, callers must NOT write the file (that
 * would wipe decisions the user may still recover by fixing it).
 */
export function tryReadFeedback(file, opts = {}) {
  try {
    return { entries: readFeedback(file, opts), broken: false };
  } catch {
    return { entries: [], broken: true };
  }
}

/** Save entries (pruned, oldest first). */
export function writeFeedback(file, entries, now = new Date()) {
  const kept = prune(entries.filter(wellFormed), now).sort((a, b) => String(a.decidedAt).localeCompare(String(b.decidedAt)));
  writeJsonFile(file, { version: 1, entries: kept });
  return kept;
}

/**
 * Save one user decision for a card. "open" removes the decision. One entry per card id:
 * a new decision replaces the old one (including an agent "irrelevant" verdict).
 *
 * @returns {object} the saved entry, or { status: "open" }
 */
export function recordDecision(file, { card, app, status, reason = "", note = "", now = new Date(), legacyStatusFile } = {}) {
  const entries = readFeedback(file, { legacyStatusFile, now }).filter((e) => e.id !== card.id);
  let saved = { status: "open" };
  if (status !== "open") {
    saved = entryFrom(card, { app, status, reason: status === "skipped" ? reason : "", note, decidedAt: now.toISOString() });
    entries.push(saved);
  }
  writeFeedback(file, entries, now);
  return saved;
}

/**
 * Add the agent's "irrelevant" verdicts from one run (pure: returns the new list).
 *   - irrelevant post, no entry yet       → add { status: "skipped", reason: "agent_irrelevant" }
 *   - irrelevant post, the user decided   → leave the user's decision alone
 *   - no longer irrelevant (agent changed its mind and re-ran report.js) → remove the agent entry
 */
export function mergeAgentVerdicts(entries, { app, posts, now = new Date() }) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const post of posts) {
    const existing = byId.get(post.id);
    if (existing && isUserEntry(existing)) continue;
    if (post.intent === "irrelevant") {
      byId.set(post.id, entryFrom(post, { app, status: "skipped", reason: AGENT_REASON, decidedAt: existing?.decidedAt ?? now.toISOString() }));
    } else if (existing) {
      byId.delete(post.id);
    }
  }
  return [...byId.values()];
}

/**
 * The dashboard's view: { id: { status, updatedAt, reason, note } } for the user's own
 * decisions only (agent verdicts are about posts that never became cards).
 */
export function statusMapFrom(entries) {
  const map = {};
  for (const e of entries) {
    if (isUserEntry(e)) map[e.id] = { status: e.status, updatedAt: e.decidedAt, reason: e.reason, note: e.note };
  }
  return map;
}
