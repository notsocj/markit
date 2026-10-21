// usage.js (lib) — counts how much marKit has used each source.
//
// These are marKit's OWN counts (what it recorded while running), not numbers from the
// platforms. They power two things:
//   - search.js stops calling a PAID source once its per-run or monthly cap is hit.
//   - /markit-usage shows "142 / 300 requests today", "210 / 900 posts this month", etc.
//
// usage.json stores COUNTS ONLY: never keys, never post text. Its shape:
//   {
//     "months":  { "2026-10":    { "x": { "requests": 3, "posts": 30, "credits": 0 } } },
//     "days":    { "2026-10-21": { "x": { "requests": 3, "posts": 30, "credits": 0 } } },
//     "lastRun": { "app": "gridpeek", "ranAt": "2026-10-21T21:00:00Z", "opportunities": 12 }
//   }
//
// "months" is kept forever (it's tiny). "days" is only needed for daily and rolling
// 7-day quotas, so entries older than KEEP_DAYS are dropped.
//
// Dates are in UTC, because that's when most API quotas reset (e.g. Stack Exchange's
// daily quota resets at midnight UTC).

import { readJsonFile, writeJsonFile } from "./files.js";
import { getPaths } from "./config.js";

export const KEEP_DAYS = 35;

const EMPTY = () => ({ requests: 0, posts: 0, credits: 0 });

/** "2026-10" for a date, in UTC. */
export function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

/** "2026-10-21" for a date, in UTC. */
export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Load usage.json, filling in any missing sections. */
export function loadUsage(file = getPaths().usageFile) {
  const data = readJsonFile(file, {});
  return { months: data.months ?? {}, days: data.days ?? {}, lastRun: data.lastRun ?? null };
}

// Add one set of counts onto another: target.requests += counts.requests, etc.
function addCounts(target, counts) {
  for (const field of ["requests", "posts", "credits"]) {
    // Number(...) || 0 guards against undefined or garbage being passed in.
    target[field] = (Number(target[field]) || 0) + (Number(counts[field]) || 0);
  }
}

// Add counts into a bucket like usage.months["2026-10"]["x"], creating it if needed.
function addInto(bucket, source, counts) {
  bucket[source] ??= EMPTY();
  addCounts(bucket[source], counts);
}

/**
 * Record what one source used during a run.
 * @param {string} source - adapter name
 * @param {{ requests?: number, posts?: number, credits?: number }} counts
 */
export function recordUsage(source, counts, file = getPaths().usageFile, now = new Date()) {
  const usage = loadUsage(file);
  addInto((usage.months[monthKey(now)] ??= {}), source, counts);
  addInto((usage.days[dayKey(now)] ??= {}), source, counts);

  // Forget daily entries we no longer need. Day keys sort correctly as plain strings.
  const oldest = dayKey(new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000));
  for (const day of Object.keys(usage.days)) {
    if (day < oldest) delete usage.days[day];
  }

  writeJsonFile(file, usage);
}

/** Remember the last run, for the "Last run:" line in /markit-usage. */
export function setLastRun({ app, ranAt, opportunities }, file = getPaths().usageFile) {
  const usage = loadUsage(file);
  usage.lastRun = { app, ranAt, opportunities };
  writeJsonFile(file, usage);
}

/** This month's counts for one source. */
export function getMonthUsage(source, usage, now = new Date()) {
  return { ...EMPTY(), ...(usage.months[monthKey(now)]?.[source] ?? {}) };
}

/** Today's counts for one source. */
export function getDayUsage(source, usage, now = new Date()) {
  return { ...EMPTY(), ...(usage.days[dayKey(now)]?.[source] ?? {}) };
}

/** Counts for one source over the last `days` days, including today (e.g. Threads' 7-day window). */
export function getRollingUsage(source, usage, days, now = new Date()) {
  const total = EMPTY();
  for (let i = 0; i < days; i++) {
    const day = dayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    const counts = usage.days[day]?.[source];
    if (counts) addCounts(total, counts);
  }
  return total;
}
