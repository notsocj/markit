// seen.js — remembers which posts marKit has already shown you.
//
// report.js adds every reported post's id here. On the next run, search.js removes
// those ids, so each report only contains NEW posts.
//
// seen.json looks like this (the date is when the post was first reported):
//   { "ids": { "hn-41234567": "2026-10-21T13:00:00Z", ... } }
//
// Ids older than KEEP_DAYS are dropped on save. By then the post is far outside any
// lookback window, so it can't come back anyway, and the file stays small.

import { readJsonFile, writeJsonFile } from "./files.js";
import { getPaths } from "./config.js";

export const KEEP_DAYS = 180;

/** Load seen.json as a plain object of { id: firstSeenIso }. */
function loadSeenMap(file) {
  const data = readJsonFile(file, { ids: {} });
  // Be forgiving if the file was hand-edited into a slightly wrong shape.
  return data && typeof data.ids === "object" && data.ids !== null ? data.ids : {};
}

/**
 * Seen ids with the date each was first reported: { "hn-1": "2026-10-21T13:05:00.000Z" }.
 * report.js uses the dates to tell "reported in an EARLIER run" (skip it) apart from
 * "reported when this same report was generated before" (keep it, e.g. after a rewrite).
 */
export function loadSeenDates(file = getPaths().seenFile) {
  return { ...loadSeenMap(file) };
}

/** All seen ids, as a Set for fast "have we seen this?" checks. */
export function loadSeen(file = getPaths().seenFile) {
  return new Set(Object.keys(loadSeenMap(file)));
}

/** Keep only posts whose id is NOT in the seen set. */
export function filterUnseen(posts, seen) {
  return posts.filter((post) => !seen.has(post.id));
}

/**
 * Add ids to seen.json (keeping the original date for ids already there),
 * and drop ids older than KEEP_DAYS.
 */
export function addSeen(ids, file = getPaths().seenFile, now = new Date()) {
  const map = loadSeenMap(file);
  const nowIso = now.toISOString();
  for (const id of ids) {
    if (!map[id]) map[id] = nowIso;
  }

  const cutoff = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, firstSeen] of Object.entries(map)) {
    if (new Date(firstSeen).getTime() < cutoff) delete map[id];
  }

  writeJsonFile(file, { ids: map });
}
