// dashboard-data.js — everything the dashboard reads and writes, kept away from HTTP code.
//
// READS (read-only) from the reports folder (settings.json → reportsDir, e.g. ~/markit-reports):
//   <reportsDir>/<app>/<run>/cards.json     numbered cards, written by report.js
//   <reportsDir>/<app>/<run>/scored.json    fallback for runs made before cards.json existed
//   <reportsDir>/<app>/<run>/raw.json       run info for that fallback
//
// READS AND WRITES exactly one file in the config folder:
//   ~/.config/markit/feedback.json   your Replied / Skipped decisions (+ skip reason and note),
//                                    shared with feedback.js and report.js (lib/feedback.js)
// and reads the old status.json once, only to import marks saved before feedback.json existed.
//
// Nothing else from the config folder is ever read or exposed here: not .env, not profiles,
// not usage.json. (dashboard.js reads settings.json once at startup to find reportsDir, and
// never serves it.)
//
// SAFETY: app and run names arrive from web requests, so they're checked against strict
// patterns BEFORE being used in any path. "../../.config" can never match, so a request can't
// walk out of the reports folder.
//
// This module imports shared code with plain imports. That's safe because dashboard.js only
// loads this file after shared.js has confirmed the sibling markit-find folder exists.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readJsonFile } from "../../markit-find/scripts/lib/files.js";
import { validateScored } from "../../markit-find/scripts/lib/scored.js";
import { sortPosts, sourceLabel } from "../../markit-find/scripts/lib/render-report.js";
import { cleanContext, contextLine } from "../../markit-find/scripts/lib/context.js";
import { prefilterLine } from "../../markit-find/scripts/lib/filters.js";
import { readFeedback, tryReadFeedback, recordDecision, statusMapFrom, validateDecision, SKIP_REASONS, REASON_LABELS, BROKEN_FEEDBACK } from "../../markit-find/scripts/lib/feedback.js";
import { healthDetail } from "../../markit-find/scripts/lib/learn.js";

// App names follow the same rule as profiles (lib/config.js validateAppName).
export const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Run folders are named by search.js: 2026-10-21-2105, or 2026-10-21-2105-2 for a second run.
export const RUN_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}(-\d{1,3})?$/;
// Post ids look like "hn-123", "se-travel-9", "bsky-did:plc:abc-3kxyz", "web-3f2a9c1b7d0e".
export const POST_ID = /^[a-z0-9][a-z0-9:._-]{0,199}$/i;
// The only statuses the dashboard can set. "open" means "clear the mark".
export const STATUSES = ["replied", "skipped", "open"];
// The only fields POST /api/status accepts.
const STATUS_FIELDS = ["id", "status", "reason", "note"];

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** App names that have at least one run folder in the reports folder. */
export function listApps(reportsDir) {
  if (!isDir(reportsDir)) return [];
  return readdirSync(reportsDir)
    .filter((name) => APP_NAME.test(name) && isDir(path.join(reportsDir, name)))
    .filter((app) => listRunNames(reportsDir, app).length > 0)
    .sort();
}

/** Run folder names for one app, newest first. Only runs that have a report. */
function listRunNames(reportsDir, app) {
  if (!APP_NAME.test(app)) return [];
  const dir = path.join(reportsDir, app);
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((run) => RUN_NAME.test(run))
    .filter((run) => existsSync(path.join(dir, run, "cards.json")) || existsSync(path.join(dir, run, "scored.json")))
    // Names sort by date and time; reverse for newest first. ("-2" suffixes sort after.)
    .sort()
    .reverse();
}

/**
 * The fields a card may have. Anything else in the source files is dropped, so the
 * dashboard only ever sends what it needs.
 */
const CARD_FIELDS = ["number", "id", "source", "provider", "site", "url", "title", "excerpt", "author", "createdAt", "matchedKeyword", "intent", "score", "priority", "why", "draftReply", "caution", "mention"];

/** Engagement as plain numbers/booleans only (e.g. { score: 12, comments: 4 }). */
function cleanEngagement(engagement) {
  const out = {};
  if (!engagement || typeof engagement !== "object") return out;
  for (const [key, value] of Object.entries(engagement)) {
    if (/^[a-zA-Z]{1,20}$/.test(key) && (Number.isFinite(value) || typeof value === "boolean")) out[key] = value;
  }
  return out;
}

/** Only valid http(s) links, at most 5 (for "also posted at"). */
function cleanUrls(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).filter((v) => {
    try {
      const u = new URL(String(v));
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  });
}

function pick(card) {
  const out = {};
  for (const field of CARD_FIELDS) if (card[field] !== undefined) out[field] = card[field];
  out.engagement = cleanEngagement(card.engagement);
  // Thread context: re-checked field by field (comment text is untrusted), plus the
  // one-line summary the page shows ("Thread: 12 comments · … · not solved").
  out.context = cleanContext(card.context);
  out.contextLine = contextLine(out.context);
  out.alsoPostedAt = cleanUrls(card.alsoPostedAt);
  if (Number.isFinite(card.preScore)) out.preScore = card.preScore;
  // "Reddit r/formula1 (via Apify)" → "Reddit" for filtering, whichever provider found it.
  out.platform = sourceLabel(card).replace(/ \(via [^)]*\)$/, "").replace(/ r\/.*$/, "");
  out.label = sourceLabel(card); // full display name
  return out;
}

/**
 * Load one run's cards. Prefers cards.json (written by report.js, same numbers as
 * report.md). For older runs, rebuilds the numbering from scored.json the same way.
 * Returns null if the run doesn't exist or can't be read.
 */
export function loadRun(reportsDir, app, run) {
  if (!APP_NAME.test(app) || !RUN_NAME.test(run)) return null;
  const dir = path.join(reportsDir, app, run);
  try {
    const cardsFile = readJsonFile(path.join(dir, "cards.json"), null);
    if (cardsFile && Array.isArray(cardsFile.cards)) {
      return { app, run, ranAt: cardsFile.ranAt ?? "", lookbackDays: cardsFile.lookbackDays, prefilter: prefilterLine(cardsFile.prefilter), keywordHealth: cleanKeywordHealth(cardsFile.keywordHealth), cards: cardsFile.cards.map(pick) };
    }
    const raw = readJsonFile(path.join(dir, "raw.json"), {});
    const scored = readJsonFile(path.join(dir, "scored.json"), null);
    if (!scored) return null;
    const posts = sortPosts(validateScored(scored).filter((p) => p.intent !== "irrelevant"));
    return { app, run, ranAt: raw.ranAt ?? "", lookbackDays: raw.lookbackDays, cards: posts.map((p, i) => pick({ ...p, number: i + 1 })) };
  } catch {
    return null; // a broken or half-written run is just skipped
  }
}

/** Plain single-line text, at most `max` characters (for keyword-health strings). */
const shortText = (v, max) => String(v ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const HEALTH_FLAGS = ["productive", "noisy", "dead", "ok", "new"];

/**
 * Re-check cards.json's keywordHealth field by field (the file could have been edited), and
 * add each keyword's one-line detail for the Keywords panel. Returns null if absent.
 */
export function cleanKeywordHealth(kh) {
  if (!kh || typeof kh !== "object" || !Array.isArray(kh.keywords)) return null;
  const keywords = kh.keywords.slice(0, 10).filter((k) => k && typeof k === "object").map((k) => {
    const reasons = {};
    for (const code of Object.keys(REASON_LABELS)) if (count(k.reasons?.[code])) reasons[code] = count(k.reasons[code]);
    const clean = {
      keyword: shortText(k.keyword, 100),
      flag: HEALTH_FLAGS.includes(k.flag) ? k.flag : "new",
      shown: count(k.shown),
      replied: count(k.replied),
      skipped: count(k.skipped),
      agentIrrelevant: count(k.agentIrrelevant),
      reasons,
      candidatesRecent: Number.isInteger(k.candidatesRecent) ? k.candidatesRecent : null,
    };
    return { ...clean, detail: healthDetail(clean) };
  }).filter((k) => k.keyword);
  const suggestions = (Array.isArray(kh.suggestions) ? kh.suggestions : []).slice(0, 8).filter((s) => s && typeof s === "object").map((s) => ({
    keyword: shortText(s.keyword, 100),
    replacements: (Array.isArray(s.replacements) ? s.replacements : []).slice(0, 3).map((r) => shortText(r, 100)).filter(Boolean),
    why: shortText(s.why, 200),
  })).filter((s) => s.keyword && s.replacements.length);
  return { keywords, suggestions };
}

/** Keyword health from one run's cards.json (null for runs made before it existed). */
export function runKeywordHealth(reportsDir, app, run) {
  return loadRun(reportsDir, app, run)?.keywordHealth ?? null;
}

/** The prefilter summary line for one run ("" for runs made before candidates.js). */
export function runPrefilter(reportsDir, app, run) {
  return loadRun(reportsDir, app, run)?.prefilter ?? "";
}

/** The newest run that can actually be read ("" if none). Stops at the first good one. */
export function latestRun(reportsDir, app) {
  for (const run of listRunNames(reportsDir, app)) if (loadRun(reportsDir, app, run)) return run;
  return "";
}

/** Runs for an app (newest first) with small summaries for the run picker. */
export function listRuns(reportsDir, app) {
  return listRunNames(reportsDir, app)
    .map((run) => loadRun(reportsDir, app, run))
    .filter(Boolean)
    .map((r) => ({
      run: r.run,
      ranAt: r.ranAt,
      lookbackDays: r.lookbackDays,
      total: r.cards.length,
      high: r.cards.filter((c) => c.priority === "high").length,
      medium: r.cards.filter((c) => c.priority === "medium").length,
      low: r.cards.filter((c) => c.priority === "low").length,
    }));
}

/**
 * Cards for an app: one run, or every run ("all"). Each card is tagged with its run and its
 * Replied/Skipped status. When the same post appears in several runs, the newest run wins.
 */
export function loadCards(reportsDir, app, run, statusMap = {}) {
  const runs = run === "all" ? listRunNames(reportsDir, app) : [run];
  const seen = new Set();
  const cards = [];
  for (const name of runs) {
    const r = loadRun(reportsDir, app, name);
    if (!r) continue;
    for (const card of r.cards) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      const mark = statusMap[card.id];
      // reason/note only for skipped/replied cards; the reason as both its code and its label.
      cards.push({ ...card, app, run: r.run, ranAt: r.ranAt, status: mark?.status ?? "open", reason: mark?.reason ?? "", reasonLabel: REASON_LABELS[mark?.reason] ?? "", note: mark?.note ?? "" });
    }
  }
  return cards;
}

/**
 * Your decisions as { id: { status, updatedAt, reason, note } }, read from feedback.json
 * (or imported from the old status.json). Missing or broken file → empty.
 */
export function readStatus(feedbackFile, legacyStatusFile) {
  try {
    return statusMapFrom(readFeedback(feedbackFile, { legacyStatusFile }));
  } catch {
    return {};
  }
}

/** A warning for the page when feedback.json can't be read ("" when it's fine). */
export function feedbackWarning(feedbackFile, legacyStatusFile) {
  return tryReadFeedback(feedbackFile, { legacyStatusFile }).broken ? BROKEN_FEEDBACK : "";
}

/**
 * Find a card by post id in the reports folder (newest run first). The dashboard only sends
 * an id, so this is where the card's details for feedback.json come from. Returns
 * { app, card } or null.
 */
export function findCard(reportsDir, id) {
  for (const app of listApps(reportsDir)) {
    for (const run of listRunNames(reportsDir, app)) {
      const card = loadRun(reportsDir, app, run)?.cards.find((c) => c.id === id);
      if (card) return { app, card };
    }
  }
  return null;
}

/**
 * Validate a status update from the browser. Accepts ONLY { id, status, reason?, note? }:
 *   id      a string that looks like a marKit post id
 *   status  replied | skipped | open
 *   reason  skipped only, one of the fixed codes (not_my_audience, already_solved,
 *           wrong_meaning, too_promotional, bans_promotion, other)
 *   note    optional text; HTML is stripped, then it's trimmed and cut to 140 characters
 * Any other field, type, or value is refused.
 *
 * @returns {{ ok: true, id, status, reason, note } | { ok: false, error }}
 */
export function validateStatusUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(body);
  if (!keys.includes("id") || !keys.includes("status") || keys.some((k) => !STATUS_FIELDS.includes(k))) {
    return { ok: false, error: "body must be { id, status, reason?, note? }" };
  }
  if (typeof body.id !== "string" || !POST_ID.test(body.id)) return { ok: false, error: "invalid id" };
  if (typeof body.status !== "string" || !STATUSES.includes(body.status)) return { ok: false, error: `status must be one of: ${STATUSES.join(", ")}` };
  const check = validateDecision({ status: body.status, reason: body.reason, note: body.note });
  if (!check.ok) return check;
  return { ok: true, id: body.id, status: check.status, reason: check.reason, note: check.note };
}

/**
 * Save one card's decision to feedback.json. "open" removes it. The card must exist in the
 * reports folder (so nothing can fill feedback.json with made-up ids).
 *
 * @returns {object|null} the saved { status, reason, note, ... }, null if the card is unknown,
 *   or { error } if feedback.json is broken (it's left untouched so nothing is lost)
 */
export function writeStatus({ feedbackFile, legacyStatusFile, reportsDir }, { id, status, reason = "", note = "" }, now = new Date()) {
  const found = findCard(reportsDir, id);
  if (!found) return null;
  if (tryReadFeedback(feedbackFile, { legacyStatusFile }).broken) return { error: BROKEN_FEEDBACK };
  const saved = recordDecision(feedbackFile, { card: found.card, app: found.app, status, reason, note, now, legacyStatusFile });
  return { status: saved.status, reason: saved.reason ?? "", reasonLabel: SKIP_REASONS[saved.reason] ?? "", note: saved.note ?? "", updatedAt: saved.decidedAt };
}

/**
 * Small numbers for the stats bar.
 *   perPlatform       opportunities per platform in the given cards
 *   repliesThisWeek   cards marked Replied in the last 7 days (across all apps)
 *   replied, skipped, open   counts within the given cards
 */
export function computeStats(cards, statusMap = {}, now = new Date()) {
  const perPlatform = {};
  for (const c of cards) perPlatform[c.platform] = (perPlatform[c.platform] ?? 0) + 1;
  const weekAgo = now.getTime() - 7 * 86400000;
  const repliesThisWeek = Object.values(statusMap).filter((s) => s.status === "replied" && new Date(s.updatedAt).getTime() >= weekAgo).length;
  const count = (status) => cards.filter((c) => c.status === status).length;
  return { total: cards.length, perPlatform, repliesThisWeek, replied: count("replied"), skipped: count("skipped"), open: count("open") };
}
