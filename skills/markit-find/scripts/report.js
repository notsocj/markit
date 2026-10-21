#!/usr/bin/env node
// report.js — turns the agent's scored.json into report.md.
//
//   node report.js <path-to-scored.json>
//
// scored.json must sit next to the raw.json that search.js wrote (same run folder).
// raw.json supplies the app name, run time, lookback, and source statuses.
//
// What happens:
//   1. Validate scored.json (lib/scored.js). Any problem → list them all and stop.
//   2. Skip posts first reported in an EARLIER run (e.g. a web result found again).
//      Re-running report.js for the SAME run keeps everything, so after the agent rewrites
//      a draft in scored.json, re-running gives the same report with the same numbers.
//   3. Write report.md next to scored.json (lib/render-report.js), plus cards.json: the
//      same numbered cards as data, which /markit-dashboard reads (so its card numbers
//      always match report.md).
//   4. Add every post's id to seen.json (including "irrelevant" ones, so they aren't
//      scored again next time), and record this run in usage.json's lastRun.
//   5. Print a 3-line summary.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPaths } from "./lib/config.js";
import { readJsonFile, writeTextFile, writeJsonFile } from "./lib/files.js";
import { validateScored } from "./lib/scored.js";
import { cleanContext } from "./lib/context.js";
import { renderReport, sourceLabel } from "./lib/render-report.js";
import { loadSeenDates, addSeen } from "./lib/seen.js";
import { setLastRun } from "./lib/usage.js";

/**
 * Text for the TERMINAL. Post titles are untrusted, and a terminal interprets escape
 * codes (\x1b...), which could recolor, hide, or rewrite what you see. Strip them all.
 */
function plain(text, max = 45) {
  const clean = String(text ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/**
 * Everything except file writes, so tests can call it directly.
 *
 * @returns {{ markdown, numbered, fresh, skippedSeen, unscored }}
 *   fresh       posts to mark as seen (reported + irrelevant)
 *   skippedSeen posts dropped because an earlier run already reported them
 *   unscored    raw.json posts the agent left out of scored.json
 */
export function buildReport({ raw, scored, seenDates = {}, now = new Date(), timeZone, candidates = null }) {
  // Ids the agent may use: everything search.js found, plus candidates.js's list (which
  // includes the web results it gave ids to).
  const pool = candidates?.candidates ?? [];
  const rawIds = new Set([...(raw.posts ?? []), ...pool].map((p) => p.id));
  const posts = validateScored(scored, rawIds);

  // Thread context, cross-posts, and pre-score come from candidates.js (the script), not
  // from the agent's copy, so they can't be altered along the way.
  const fromScript = new Map(pool.map((c) => [c.id, c]));
  for (const post of posts) {
    const c = fromScript.get(post.id);
    post.context = cleanContext(c ? c.context : post.context);
    if (c?.alsoPostedAt) post.alsoPostedAt = c.alsoPostedAt;
    if (Number.isFinite(c?.preScore)) post.preScore = c.preScore;
  }

  const ranAt = new Date(raw.ranAt).getTime();
  const reportedEarlier = (id) => seenDates[id] && new Date(seenDates[id]).getTime() < ranAt;
  const fresh = posts.filter((p) => !reportedEarlier(p.id));

  // With candidates.json, the agent is meant to score exactly those; without it (older
  // runs), every raw.json post.
  const scoredIds = new Set(posts.map((p) => p.id));
  const unscored = (candidates ? pool : raw.posts ?? []).filter((p) => !scoredIds.has(p.id)).length;

  const prefilter = candidates?.prefilter;
  const { markdown, numbered } = renderReport({ raw, posts: fresh, now, timeZone, prefilter });
  return { markdown, numbered, fresh, skippedSeen: posts.length - fresh.length, unscored, prefilter };
}

// The fields a card needs, and nothing else (cards.json is read by the dashboard).
const CARD_FIELDS = ["id", "source", "site", "url", "title", "excerpt", "author", "createdAt", "engagement", "matchedKeyword", "intent", "score", "priority", "why", "draftReply", "caution", "mention", "context", "alsoPostedAt", "preScore"];

/** cards.json content: run info plus the numbered cards exactly as report.md shows them. */
export function buildCards(raw, numbered, prefilter) {
  return {
    app: raw.app,
    ranAt: raw.ranAt,
    lookbackDays: raw.lookbackDays,
    sources: raw.sources ?? [],
    prefilter: prefilter ?? null,
    cards: numbered.map(({ number, post }) => {
      const card = { number };
      for (const field of CARD_FIELDS) if (post[field] !== undefined && post[field] !== "" && post[field] !== null) card[field] = post[field];
      return card;
    }),
  };
}

/** The 3-line terminal summary (plus a note line if something needs attention). */
export function formatSummary({ app, numbered, reportPath, skippedSeen = 0, unscored = 0 }) {
  const count = (p) => numbered.filter((n) => n.post.priority === p).length;
  const total = numbered.length;
  const lines = [
    total
      ? `marKit report · ${plain(app)} · ${total} ${total === 1 ? "opportunity" : "opportunities"}: ${count("high")} high · ${count("medium")} medium · ${count("low")} low`
      : `marKit report · ${plain(app)} · no new opportunities`,
    total
      ? "Top: " + numbered.slice(0, 3).map((n) => `#${n.number} "${plain(n.post.title || n.post.excerpt)}" (${plain(sourceLabel(n.post), 20)}, ${n.post.score})`).join(" · ")
      : "Nothing new to reply to this run.",
    `report.md: ${reportPath}`,
  ];
  const notes = [];
  if (skippedSeen) notes.push(`${skippedSeen} already reported in an earlier run (left out)`);
  if (unscored) notes.push(`${unscored} post(s) from raw.json weren't in scored.json (they'll show up again next run)`);
  if (notes.length) lines.push(`Note: ${notes.join("; ")}.`);
  return lines.join("\n");
}

function main() {
  const scoredArg = process.argv[2];
  if (!scoredArg) throw new Error("marKit: usage: node report.js <path-to-scored.json>");
  const scoredPath = path.resolve(scoredArg);
  if (!existsSync(scoredPath)) throw new Error(`marKit: ${scoredPath} not found.`);

  const runDir = path.dirname(scoredPath);
  const rawPath = path.join(runDir, "raw.json");
  const raw = readJsonFile(rawPath, null);
  if (!raw) throw new Error(`marKit: raw.json not found next to scored.json (${runDir}). Write scored.json into the same folder as raw.json.`);

  const paths = getPaths();
  const { markdown, numbered, fresh, skippedSeen, unscored, prefilter } = buildReport({
    raw,
    scored: readJsonFile(scoredPath, null),
    seenDates: loadSeenDates(paths.seenFile),
    candidates: readJsonFile(path.join(runDir, "candidates.json"), null),
  });

  const reportPath = path.join(runDir, "report.md");
  writeTextFile(reportPath, markdown);
  writeJsonFile(path.join(runDir, "cards.json"), buildCards(raw, numbered, prefilter));
  addSeen(fresh.map((p) => p.id), paths.seenFile);
  setLastRun({ app: raw.app, ranAt: raw.ranAt, opportunities: numbered.length }, paths.usageFile);

  console.log(formatSummary({ app: raw.app, numbered, reportPath, skippedSeen, unscored }));
}

// Run main() only when executed directly, not when imported by tests.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (runDirectly) {
  try {
    main();
  } catch (err) {
    // Our errors start with "marKit:" and are safe to show. Anything else: type only.
    console.error(err.message?.startsWith("marKit:") ? err.message : `marKit: unexpected error (${err.name})`);
    process.exitCode = 1;
  }
}
