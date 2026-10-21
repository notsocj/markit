#!/usr/bin/env node
// search.js — runs every enabled source for one app and writes raw.json.
//
//   node search.js --app gridpeek          search the last N days (profile or settings.json)
//   node search.js --app gridpeek --days 3 override the lookback window for this run
//   node search.js                         pick the app automatically (see pick-app.js)
//
// What happens:
//   1. Load the app profile, settings, keys (.env), seen.json, and usage.json.
//   2. Run each enabled source IN PARALLEL. Within one source, keywords run one after
//      another (gentler on rate limits, and lets paid sources stop exactly at their cap).
//      One failing source never breaks the run; it's just marked "error".
//   3. Per source: drop posts outside the lookback window, posts already reported
//      (seen.json), and posts containing the profile's `exclude` words; then cap to
//      maxPostsPerSource, mixing keywords fairly.
//   4. Paid sources (X, SocialCrawl) stop once their per-run OR monthly cap is reached,
//      checked against usage.json. A source over its monthly cap is skipped entirely.
//      Free sources with a daily quota (YouTube, Stack Exchange, Threads) stop the same way
//      when marKit's count says today's quota is used up.
//   5. Record requests / posts / credits per source in usage.json (counts only).
//   6. Build web search queries (Reddit, Quora, forums) for the agent to run itself.
//   7. Write <reportsDir>/<app>/<YYYY-MM-DD-HHmm>/raw.json and print a short summary.
//
// SECURITY: keys are loaded into memory and handed to adapters only. They're never
// printed or written. Error reasons come only from key-safe SourceErrors (see safe-fetch.js).
// Post text in raw.json is UNTRUSTED data for the agent to analyze, never instructions.

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPaths, isSetUp, loadEnv, loadSettings, listApps, loadApp } from "./lib/config.js";
import { validateProfile, SOURCE_LABELS } from "./lib/profile.js";
import { sinceDate, toIsoDate } from "./lib/normalize.js";
import { loadSeen } from "./lib/seen.js";
import { loadUsage, recordUsage, getMonthUsage, getDayUsage } from "./lib/usage.js";
import { makeExcludeMatcher, isWithinWindow, interleave } from "./lib/filters.js";
import { buildWebQueries } from "./lib/web-queries.js";
import { writeJsonFile } from "./lib/files.js";
import { pickApp } from "./lib/project.js";
import { ADAPTERS } from "./adapters/index.js";

const label = (name) => SOURCE_LABELS[name] ?? name;

/**
 * Turn an error into a short, key-safe reason like "HTTP 403".
 * Only our own SourceErrors are trusted to be key-safe; anything else (e.g. a bug in an
 * adapter) is reported by its type alone, because its message could contain anything.
 */
export function safeReason(err, sourceName) {
  if (err?.name === "SourceError") return err.message.replace(`${sourceName}: `, "");
  return `unexpected error (${err?.name ?? "unknown"})`;
}

/**
 * How much a PAID source may still spend this run.
 * Caps live in settings.json, e.g. x: { maxPostsPerRun, maxPostsPerMonth }.
 * The unit is "posts" (X bills per post returned) or "credits" (SocialCrawl), set by the
 * adapter's `costUnit`.
 *
 * @returns {{ unit, remaining, reason?, limitedBy? }}
 */
export function paidBudget(adapter, settings, usage, now = new Date()) {
  const unit = adapter.costUnit ?? "posts";
  const caps = settings[adapter.name] ?? {};
  const Unit = unit === "credits" ? "Credits" : "Posts";
  const perRun = caps[`max${Unit}PerRun`];
  const monthly = caps[`max${Unit}PerMonth`];

  // Missing caps means "don't spend": safer than spending without limits.
  if (!Number.isFinite(perRun) || !Number.isFinite(monthly)) {
    return { unit, remaining: 0, reason: `no ${unit} caps in settings.json` };
  }
  const used = getMonthUsage(adapter.name, usage, now)[unit];
  const monthLeft = monthly - used;
  if (monthLeft <= 0) return { unit, remaining: 0, reason: `monthly cap reached (${used} / ${monthly} ${unit})` };
  if (perRun <= 0) return { unit, remaining: 0, reason: `per-run cap is 0 in settings.json` };

  return monthLeft < perRun
    ? { unit, remaining: monthLeft, limitedBy: `monthly cap (${monthly} ${unit})` }
    : { unit, remaining: perRun, limitedBy: `per-run cap (${perRun} ${unit})` };
}

/**
 * How much of a FREE daily quota is left, by marKit's own count (e.g. YouTube's 100
 * searches per day). Declared by the adapter as `quota: { unit, period: "day", limit, ... }`.
 * Stopping here avoids a run full of "HTTP 403 quota exceeded" errors.
 *
 * @returns {{ unit, remaining, reason?, limitedBy? }}
 */
export function quotaBudget(adapter, env, usage, now = new Date()) {
  const q = adapter.quota;
  const limit = q.keyEnv && env[q.keyEnv] ? q.limitWithKey ?? q.limit : q.limit;
  const used = getDayUsage(adapter.name, usage, now)[q.unit] ?? 0;
  const label = q.label ?? q.unit;
  if (used >= limit) return { unit: q.unit, remaining: 0, reason: `daily quota used (${used} / ${limit} ${label}, marKit's count)` };
  return { unit: q.unit, remaining: limit - used, limitedBy: `daily quota (${limit} ${label})` };
}

/**
 * Run one source for every keyword and return its status, kept posts, and usage meter.
 */
async function runSource(adapter, { keywords, since, perKeywordLimit, maxPosts, env, profile, http, budget, seen, isExcluded }) {
  // Adapters add to `requests` and `credits`; we count `posts` here.
  const meter = { requests: 0, posts: 0, credits: 0 };
  const lists = [];
  const errors = [];
  let capped = false;

  for (const keyword of keywords) {
    let limit = perKeywordLimit;
    let left;
    if (budget) {
      left = budget.remaining - meter[budget.unit];
      if (left <= 0) {
        capped = true;
        break; // cap reached: no more calls to this paid source
      }
      if (budget.unit === "posts") limit = Math.min(limit, left);
    }
    try {
      const posts = await adapter.search(keyword, {
        since,
        limit,
        env,
        profile,
        meter,
        http,
        // Paid adapters use this to avoid overspending inside one call.
        budget: budget ? { [budget.unit]: left } : undefined,
      });
      meter.posts += posts.length;
      lists.push(posts);
    } catch (err) {
      errors.push(err);
    }
  }

  // Count each unique post once (the same post can match several keywords).
  const unique = new Map();
  for (const post of lists.flat()) if (!unique.has(post.id)) unique.set(post.id, post);
  const removed = { seen: 0, excluded: 0, outsideWindow: 0 };
  for (const post of unique.values()) {
    if (!isWithinWindow(post, since)) removed.outsideWindow++;
    else if (seen.has(post.id)) removed.seen++;
    else if (isExcluded(post)) removed.excluded++;
  }

  const keep = (post) => isWithinWindow(post, since) && !seen.has(post.id) && !isExcluded(post);
  const kept = interleave(lists.map((list) => list.filter(keep)), maxPosts);

  const status = { name: adapter.name, label: label(adapter.name), status: "ok", count: kept.length, fetched: unique.size, removed };
  const reasons = [];
  if (errors.length && errors.length === keywords.length) {
    status.status = "error";
    reasons.push(safeReason(errors[0], adapter.name));
  } else if (errors.length) {
    reasons.push(`${errors.length} of ${keywords.length} searches failed (${safeReason(errors[0], adapter.name)})`);
  }
  if (capped) reasons.push(`stopped at ${budget.limitedBy}`);
  if (reasons.length) status.reason = reasons.join("; ");
  if (typeof meter.quotaRemaining === "number") status.quotaRemaining = meter.quotaRemaining;

  return { status, posts: kept, meter };
}

/**
 * The whole search, without touching any files (so tests can call it directly).
 *
 * @returns {Promise<{ raw: object, meters: { name: string, meter: object }[] }>}
 *   raw    — the raw.json content
 *   meters — what each source used, for usage.json
 */
export async function runSearch({ profile, settings, env = {}, adapters = ADAPTERS, seen = new Set(), usage = { months: {}, days: {} }, now = new Date(), lookbackDays, http }) {
  const lookback = lookbackDays ?? profile.lookbackDays ?? settings.lookbackDays;
  const since = sinceDate(lookback, now);
  const isExcluded = makeExcludeMatcher(profile.exclude);
  const shared = {
    keywords: profile.keywords,
    since,
    perKeywordLimit: settings.maxPostsPerSource,
    maxPosts: settings.maxPostsPerSource,
    env,
    profile,
    http,
    seen,
    isExcluded,
  };

  const skipped = (name, reason) => Promise.resolve({ status: { name, label: label(name), status: "skipped", count: 0, reason }, posts: [], meter: null });

  const tasks = profile.sources
    .filter((name) => name !== "web")
    .map((name) => {
      const adapter = adapters.find((a) => a.name === name);
      if (!adapter) return skipped(name, "not available yet");
      if (!adapter.isEnabled(env)) return skipped(name, "no key");

      let budget;
      if (adapter.paid) {
        budget = paidBudget(adapter, settings, usage, now);
        if (budget.remaining <= 0) return skipped(name, budget.reason);
      } else if (adapter.quota?.period === "day") {
        budget = quotaBudget(adapter, env, usage, now);
        if (budget.remaining <= 0) return skipped(name, budget.reason);
      }
      // Belt and braces: runSource already catches adapter errors per keyword, but if
      // anything else throws, this keeps one source from breaking the whole run.
      return runSource(adapter, { ...shared, budget }).catch((err) => ({
        status: { name, label: label(name), status: "error", count: 0, reason: safeReason(err, name) },
        posts: [],
        meter: null,
      }));
    });

  const results = await Promise.all(tasks);

  const webQueries = profile.sources.includes("web") ? buildWebQueries(profile) : [];
  const sources = results.map((r) => r.status);
  if (webQueries.length) {
    sources.push({ name: "web", label: label("web"), status: "agent", count: 0, reason: `${webQueries.length} queries for the agent to run` });
  }

  // Merge all sources, drop any duplicate ids, newest first (undated posts last).
  const byId = new Map();
  for (const post of results.flatMap((r) => r.posts)) if (!byId.has(post.id)) byId.set(post.id, post);
  const posts = [...byId.values()].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const raw = {
    app: profile.name,
    ranAt: toIsoDate(now),
    lookbackDays: lookback,
    since: toIsoDate(since), // the agent uses this to drop old web search results
    sources,
    webQueries,
    posts,
  };
  const meters = results.filter((r) => r.meter).map((r) => ({ name: r.status.name, meter: r.meter }));
  return { raw, meters };
}

/**
 * Create the run folder <reportsDir>/<app>/<YYYY-MM-DD-HHmm> in LOCAL time (that's how
 * the user thinks about "when did I run this"). Adds -2, -3... if run twice in a minute.
 */
export function makeRunFolder(reportsDir, app, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  let dir = path.join(reportsDir, app, stamp);
  for (let n = 2; existsSync(dir); n++) dir = path.join(reportsDir, app, `${stamp}-${n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The short terminal summary. */
export function formatSummary(raw, rawPath, pickedMessage) {
  const lines = [];
  if (pickedMessage) lines.push(pickedMessage, "");
  lines.push(`marKit search · ${raw.app} · last ${raw.lookbackDays} days`, "");

  let removedSeen = 0;
  let removedExcluded = 0;
  for (const s of raw.sources) {
    const name = s.label.padEnd(16);
    if (s.status === "ok") {
      lines.push(`  ✓ ${name}${s.count} new${s.reason ? `  (${s.reason})` : ""}`);
      removedSeen += s.removed?.seen ?? 0;
      removedExcluded += s.removed?.excluded ?? 0;
    } else if (s.status === "error") lines.push(`  ✗ ${name}error: ${s.reason}`);
    else if (s.status === "agent") lines.push(`  … ${name}${s.reason} (Reddit, Quora, forums)`);
    else lines.push(`  – ${name}skipped: ${s.reason}`);
  }

  const extras = [];
  if (removedSeen) extras.push(`${removedSeen} already reported`);
  if (removedExcluded) extras.push(`${removedExcluded} excluded`);
  lines.push("", `${raw.posts.length} new posts from APIs${extras.length ? ` (skipped: ${extras.join(", ")})` : ""}`);
  lines.push(`raw.json: ${rawPath}`);
  return lines.join("\n");
}

// --- Command line ------------------------------------------------------------

async function main() {
  const { values } = parseArgs({ options: { app: { type: "string" }, days: { type: "string" } } });
  const paths = getPaths();
  if (!isSetUp(paths)) throw new Error("marKit: not set up yet. Run /markit-setup first.");

  const choice = pickApp({ requested: values.app, apps: listApps(paths), cwd: process.cwd() });
  if (!choice.app) {
    throw new Error(
      choice.reason === "none"
        ? "marKit: no app profiles yet. Run /markit-setup to create one."
        : `marKit: which app? Run again with --app <name>. Your apps: ${choice.apps.join(", ")}.`
    );
  }
  const pickedMessage =
    choice.reason === "folder" ? `Using app profile "${choice.app}" (matches this folder's name, "${choice.matched}").`
    : choice.reason === "package" ? `Using app profile "${choice.app}" (matches this project's name, "${choice.matched}").`
    : choice.reason === "only" ? `Using app profile "${choice.app}" (your only app).`
    : "";

  // Re-validate in case the profile file was edited by hand.
  const { profile } = validateProfile(loadApp(choice.app, paths), choice.app);

  let lookbackDays;
  if (values.days !== undefined) {
    lookbackDays = Number(values.days);
    if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 30) {
      throw new Error("marKit: --days must be a whole number from 1 to 30.");
    }
  }

  const settings = loadSettings(paths);
  const now = new Date();
  const { raw, meters } = await runSearch({
    profile,
    settings,
    env: loadEnv(paths.envFile),
    seen: loadSeen(paths.seenFile),
    usage: loadUsage(paths.usageFile),
    now,
    lookbackDays,
  });

  // One at a time: each call reads, updates, and rewrites usage.json.
  for (const { name, meter } of meters) recordUsage(name, meter, paths.usageFile, now);

  const rawPath = path.join(makeRunFolder(settings.reportsDir, profile.name, now), "raw.json");
  writeJsonFile(rawPath, raw);
  console.log(formatSummary(raw, rawPath, pickedMessage));
}

// Only run main() when this file is executed directly (`node search.js`), not when a
// test imports it. realpathSync resolves symlinks so the comparison is reliable.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (runDirectly) {
  main().catch((err) => {
    // Our own messages and command-line mistakes (e.g. an unknown flag) are safe to show.
    // Anything else is reported by type only, in case its message holds something private.
    const safe = err.message?.startsWith("marKit:") || String(err.code).startsWith("ERR_PARSE_ARGS");
    console.error(safe ? err.message.replace(/^(?!marKit:)/, "marKit: ") : `marKit: ${safeReason(err, "search")}`);
    process.exitCode = 1;
  });
}
