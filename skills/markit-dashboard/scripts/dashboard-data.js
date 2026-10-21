// dashboard-data.js — everything the dashboard reads and writes, kept away from HTTP code.
//
// READS (read-only) from the reports folder (settings.json → reportsDir, e.g. ~/markit-reports):
//   <reportsDir>/<app>/<run>/cards.json     numbered cards, written by report.js
//   <reportsDir>/<app>/<run>/scored.json    fallback for runs made before cards.json existed
//   <reportsDir>/<app>/<run>/raw.json       run info for that fallback
//
// READS AND WRITES exactly one file in the config folder:
//   ~/.config/markit/status.json   { "ids": { "<post id>": { "status": "replied", "updatedAt": "..." } } }
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
import { readJsonFile, writeJsonFile } from "../../markit-find/scripts/lib/files.js";
import { validateScored } from "../../markit-find/scripts/lib/scored.js";
import { sortPosts, sourceLabel } from "../../markit-find/scripts/lib/render-report.js";

// App names follow the same rule as profiles (lib/config.js validateAppName).
export const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Run folders are named by search.js: 2026-10-21-2105, or 2026-10-21-2105-2 for a second run.
export const RUN_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}(-\d{1,3})?$/;
// Post ids look like "hn-123", "se-travel-9", "bsky-did:plc:abc-3kxyz", "web-3f2a9c1b7d0e".
export const POST_ID = /^[a-z0-9][a-z0-9:._-]{0,199}$/i;
// The only statuses the dashboard can set. "open" means "clear the mark".
export const STATUSES = ["replied", "skipped", "open"];

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
const CARD_FIELDS = ["number", "id", "source", "site", "url", "title", "excerpt", "author", "createdAt", "matchedKeyword", "intent", "score", "priority", "why", "draftReply", "caution", "mention"];

/** Engagement as plain numbers/booleans only (e.g. { score: 12, comments: 4 }). */
function cleanEngagement(engagement) {
  const out = {};
  if (!engagement || typeof engagement !== "object") return out;
  for (const [key, value] of Object.entries(engagement)) {
    if (/^[a-zA-Z]{1,20}$/.test(key) && (Number.isFinite(value) || typeof value === "boolean")) out[key] = value;
  }
  return out;
}

function pick(card) {
  const out = {};
  for (const field of CARD_FIELDS) if (card[field] !== undefined) out[field] = card[field];
  out.engagement = cleanEngagement(card.engagement);
  out.platform = sourceLabel(card).replace(/ r\/.*$/, ""); // "Reddit r/formula1" → "Reddit" for filtering
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
      return { app, run, ranAt: cardsFile.ranAt ?? "", lookbackDays: cardsFile.lookbackDays, cards: cardsFile.cards.map(pick) };
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
      cards.push({ ...card, app, run: r.run, ranAt: r.ranAt, status: statusMap[card.id]?.status ?? "open" });
    }
  }
  return cards;
}

/** status.json as { id: { status, updatedAt } }. Missing or broken file → empty. */
export function readStatus(statusFile) {
  try {
    const data = readJsonFile(statusFile, { ids: {} });
    return data && typeof data.ids === "object" && data.ids !== null ? data.ids : {};
  } catch {
    return {};
  }
}

/**
 * Validate a status update from the browser. Accepts ONLY { id, status }: a string id that
 * looks like a marKit post id, and a status from the fixed list. Anything else is refused.
 *
 * @returns {{ ok: true, id, status } | { ok: false, error }}
 */
export function validateStatusUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "id" || keys[1] !== "status") return { ok: false, error: "body must be exactly { id, status }" };
  if (typeof body.id !== "string" || !POST_ID.test(body.id)) return { ok: false, error: "invalid id" };
  if (typeof body.status !== "string" || !STATUSES.includes(body.status)) return { ok: false, error: `status must be one of: ${STATUSES.join(", ")}` };
  return { ok: true, id: body.id, status: body.status };
}

/** Save one card's status. "open" removes the mark. */
export function writeStatus(statusFile, id, status, now = new Date()) {
  const ids = readStatus(statusFile);
  if (status === "open") delete ids[id];
  else ids[id] = { status, updatedAt: now.toISOString() };
  writeJsonFile(statusFile, { ids });
  return ids[id] ?? { status: "open" };
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
