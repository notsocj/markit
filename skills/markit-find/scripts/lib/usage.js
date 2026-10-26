// usage.js (lib) — counts how much marKit has used each source.
//
// These are marKit's OWN counts (what it recorded while running), not numbers from the
// platforms. They power two things:
//   - search.js stops calling a PAID source once its per-run or monthly cap is hit.
//   - /markit-usage shows "142 / 300 requests today", "210 / 900 posts this month", etc.
//
// usage.json stores COUNTS ONLY: never keys, never post text. Its shape:
//   {
//     "months":  { "2026-10":    { "x": { "requests": 3, "posts": 30, "credits": 0, "context": 0 } } },
//                (Apify also gets "results": items the actor returned, and "usd": marKit's
//                 ESTIMATE of their cost from the prices in settings.json)
//     "days":    { "2026-10-21": { "x": { "requests": 3, "posts": 30, "credits": 0, "context": 0 } } },
//     "lastRun": { "app": "gridpeek", "ranAt": "2026-10-21T21:00:00Z", "opportunities": 12 }
//   }
//
// "months" is kept forever (it's tiny). "days" is only needed for daily and rolling
// 7-day quotas, so entries older than KEEP_DAYS are dropped.
//
// Dates are in UTC, because that's when most API quotas reset (e.g. Stack Exchange's
// daily quota resets at midnight UTC).

import { readJsonObject, writeJsonFile } from "./files.js";
import { getPaths } from "./config.js";

export const KEEP_DAYS = 35;

// "context" counts thread-context calls that DON'T draw from the quota marKit shows for
// that source (e.g. YouTube comment calls use a different pool than its 100 searches/day).
// Context calls that do share the quota (e.g. Stack Exchange) are counted as "requests".
const FIELDS = ["requests", "posts", "credits", "context", "results", "usd"];
// "results" and "usd" only appear for sources that use them (Apify), so they're not here.
const EMPTY = () => ({ requests: 0, posts: 0, credits: 0, context: 0 });

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
  const data = readJsonObject(file, {});
  return { months: data.months ?? {}, days: data.days ?? {}, lastRun: data.lastRun ?? null };
}

// Add one set of counts onto another: target.requests += counts.requests, etc.
function addCounts(target, counts) {
  for (const field of FIELDS) {
    // A damaged stored count ("abc", null, negative) is left alone, so it keeps counting as
    // "used up" (see trusted()) until the user fixes the file, instead of quietly restarting at 0.
    if (field in target && !(Number.isFinite(target[field]) && target[field] >= 0)) continue;
    // Number(...) || 0 guards against undefined or garbage being passed in.
    target[field] = (Number(target[field]) || 0) + (Number(counts[field]) || 0);
  }
  // Dollar estimates are fractions: round to 1/10,000 of a dollar so adding many small
  // amounts doesn't leave long tails like 0.30000000000000004 in the file.
  if (Number.isFinite(target.usd)) target.usd = Math.round(target.usd * 1e4) / 1e4;
  for (const field of ["results", "usd"]) {
    if (target[field] === 0) delete target[field]; // keep entries for other sources tidy
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
 * @param {{ requests?: number, posts?: number, credits?: number, context?: number }} counts
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

/**
 * Stored counts that can't be trusted (a hand-edited or damaged usage.json: "abc", null,
 * a negative number) are read as Infinity, i.e. "used up". The caps then stop paid sources,
 * instead of treating the garbage as zero and spending past the monthly cap.
 */
function trusted(counts) {
  return Object.fromEntries(Object.entries(counts ?? {}).map(([field, n]) => [field, Number.isFinite(n) && n >= 0 ? n : Infinity]));
}

/** This month's counts for one source. */
export function getMonthUsage(source, usage, now = new Date()) {
  return { ...EMPTY(), ...trusted(usage.months[monthKey(now)]?.[source]) };
}

/** Today's counts for one source. */
export function getDayUsage(source, usage, now = new Date()) {
  return { ...EMPTY(), ...trusted(usage.days[dayKey(now)]?.[source]) };
}

/** Counts for one source over the last `days` days, including today (e.g. Threads' 7-day window). */
export function getRollingUsage(source, usage, days, now = new Date()) {
  const total = EMPTY();
  for (let i = 0; i < days; i++) {
    const day = dayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    const counts = usage.days[day]?.[source];
    if (counts) addCounts(total, trusted(counts));
  }
  return total;
}
