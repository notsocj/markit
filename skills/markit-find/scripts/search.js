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
//   4. Paid sources (X, the Reddit provider, SocialCrawl) stop once their per-run OR monthly
//      cap is reached, checked against usage.json. A source over its monthly cap is skipped.
//      REDDIT: the "reddit" source runs through the ONE provider chosen in settings.json
//      ("reddit": { "provider": "scrapecreators" | "apify" | "socialcrawl" | "none" }), so a
//      Reddit search is never paid for twice. Two jobs on the same paid account (SocialCrawl
//      as Reddit provider AND the "socialcrawl" Threads source) run one after the other and
//      share one budget, so together they stay inside that account's caps.
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
import { redditProvider, redditLabel } from "./lib/reddit.js";
import { ADAPTERS } from "./adapters/index.js";

const label = (name) => SOURCE_LABELS[name] ?? name;

// The units paid sources are billed in, and how their caps are named in settings.json
// (x.maxPostsPerRun, scrapecreators.maxCreditsPerMonth, apify.maxResultsPerRun, ...).
const UNIT_WORD = { posts: "Posts", credits: "Credits", results: "Results" };

/**
 * A paid source's caps: { perRun, monthly } in its own unit. Most read
 * settings[<name>].max<Unit>PerRun / max<Unit>PerMonth; an adapter whose monthly cap is in
 * dollars (Apify) supplies its own caps() instead.
 */
export function paidCaps(adapter, settings) {
  if (typeof adapter.caps === "function") return adapter.caps(settings);
  const Unit = UNIT_WORD[adapter.costUnit ?? "posts"] ?? "Posts";
  const caps = settings[adapter.name] ?? {};
  return { perRun: caps[`max${Unit}PerRun`], monthly: caps[`max${Unit}PerMonth`] };
}

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
  // Apify's monthly cap is an estimated dollar amount, so it works out its own budget.
  if (typeof adapter.budget === "function") return adapter.budget(settings, usage, now);
  const unit = adapter.costUnit ?? "posts";
  const { perRun, monthly } = paidCaps(adapter, settings);

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
 * Run one job (a source, searched through one adapter) for every keyword and return its
 * status, kept posts, and usage meter.
 *
 * job: { name, label, adapter, platforms?, provider? }
 *   name      the profile source ("reddit", "hackernews", ...), used in raw.json
 *   label     display name, e.g. "Reddit (via ScrapeCreators)"
 *   platforms what a multi-platform adapter should search (SocialCrawl: ["reddit"] or ["threads"])
 *   provider  for "reddit": which provider adapter did the searching
 */
async function runSource(job, { keywords, since, perKeywordLimit, maxPosts, env, profile, settings, http, budget, seen, isExcluded, now }) {
  const { adapter } = job;
  // Adapters add to `requests` and `credits` (Apify also to `results` and `usd`); we
  // count `posts` here.
  const meter = { requests: 0, posts: 0, credits: 0 };
  const lists = [];
  const errors = [];
  let capped = false;
  let attempts = keywords.length;

  // What's left to spend right now: the run's budget minus this job's spending so far.
  // `usd` is passed along for adapters with a dollar cap (Apify).
  const budgetLeft = () => {
    if (!budget) return undefined;
    const left = { [budget.unit]: budget.remaining - (meter[budget.unit] ?? 0) };
    if (Number.isFinite(budget.usd)) left.usd = budget.usd - (meter.usd ?? 0);
    return left;
  };
  const common = { since, env, profile, settings, meter, http, now, platforms: job.platforms };

  if (typeof adapter.searchAll === "function") {
    // Adapters that pay a fee per call (Apify charges per actor run) search every keyword in
    // ONE call and tag each post with the keyword that found it.
    attempts = 1;
    const left = budgetLeft();
    if (budget && left[budget.unit] <= 0) capped = true;
    else {
      try {
        const posts = await adapter.searchAll(keywords, { ...common, limit: perKeywordLimit, budget: left });
        meter.posts += posts.length;
        for (const keyword of keywords) lists.push(posts.filter((p) => p.matchedKeyword === keyword));
        // Posts the adapter couldn't tie to a keyword still count (kept in a list of their own).
        const untagged = posts.filter((p) => !keywords.includes(p.matchedKeyword));
        if (untagged.length) lists.push(untagged);
      } catch (err) {
        errors.push(err);
      }
    }
  } else {
    for (const [i, keyword] of keywords.entries()) {
      let limit = perKeywordLimit;
      let left;
      if (budget) {
        left = budget.remaining - (meter[budget.unit] ?? 0);
        if (left <= 0) {
          capped = true;
          break; // cap reached: no more calls to this paid source
        }
        if (budget.unit === "posts") {
          // Share what's left across the keywords still to search, so the first keyword can't
          // use the whole per-run cap (found on a real run: X's first keyword took 25 of 30
          // posts and the other 7 keywords were never searched). Never below the adapter's
          // minimum per request (X: 10), so with 30 posts and 8 keywords, 3 keywords get 10.
          const fairShare = Math.floor(left / (keywords.length - i));
          limit = Math.min(limit, left, Math.max(fairShare, adapter.minResults ?? 1));
        }
      }
      try {
        const posts = await adapter.search(keyword, {
          ...common,
          limit,
          // Paid adapters use this to avoid overspending inside one call.
          budget: budgetLeft(),
        });
        meter.posts += posts.length;
        lists.push(posts);
      } catch (err) {
        errors.push(err);
      }
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

  const status = { name: job.name, label: job.label, status: "ok", count: kept.length, fetched: unique.size, removed };
  if (job.provider) status.provider = job.provider;
  const reasons = [];
  if (errors.length && errors.length === attempts) {
    status.status = "error";
    reasons.push(safeReason(errors[0], adapter.name));
  } else if (errors.length) {
    reasons.push(`${errors.length} of ${attempts} searches failed (${safeReason(errors[0], adapter.name)})`);
  }
  if (capped) reasons.push(`stopped at ${budget.limitedBy}`);
  if (reasons.length) status.reason = reasons.join("; ");
  if (typeof meter.quotaRemaining === "number") status.quotaRemaining = meter.quotaRemaining;
  // Results the adapter dropped for missing an id or link (ScrapeCreators counts these).
  if (meter.skipped) status.skippedIncomplete = meter.skipped;
  // What this job spent during the search (counts only). candidates.js uses it so the
  // per-run cap of a paid source covers search AND thread context together.
  status.used = { requests: meter.requests, posts: meter.posts, credits: meter.credits };
  for (const field of ["results", "usd"]) if (meter[field]) status.used[field] = meter[field];

  return { status, posts: kept, meter };
}

/**
 * Turn the profile's sources into jobs: which adapter searches each source, and how.
 * Returns { job } for each source to run, or { skip: reason } when it can't run.
 */
export function planJobs(profile, settings, adapters, env) {
  const provider = redditProvider(settings);
  return profile.sources
    .filter((name) => name !== "web")
    .map((name) => {
      if (name === "reddit") {
        if (provider === "none") return { name, label: label(name), skip: "no Reddit provider chosen (run /markit-setup, or set reddit.provider in settings.json)" };
        const adapter = adapters.find((a) => a.name === provider);
        const job = { name, label: redditLabel(provider), adapter, platforms: ["reddit"], provider };
        if (!adapter) return { ...job, skip: "not available yet" };
        if (!adapter.isEnabled(env)) return { ...job, skip: `no ${adapter.label ?? provider} key` };
        return { job };
      }
      const adapter = adapters.find((a) => a.name === name);
      // The "socialcrawl" source is Threads through SocialCrawl (Reddit comes from the
      // Reddit provider, so it's never searched twice).
      const job = { name, label: label(name), adapter, platforms: name === "socialcrawl" ? ["threads"] : undefined };
      if (!adapter) return { ...job, skip: "not available yet" };
      if (!adapter.isEnabled(env)) return { ...job, skip: "no key" };
      return { job };
    });
}

/**
 * The whole search, without touching any files (so tests can call it directly).
 *
 * @returns {Promise<{ raw: object, meters: { name: string, meter: object }[] }>}
 *   raw    — the raw.json content
 *   meters — what each paid account / source used, for usage.json (by adapter name, so a
 *            Reddit provider's spending counts against that provider's caps)
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
    settings,
    http,
    seen,
    isExcluded,
    now,
  };

  const skipped = ({ name, label: shown, provider }, reason) => {
    const status = { name, label: shown, status: "skipped", count: 0, reason };
    if (provider) status.provider = provider;
    return { status, posts: [], meter: null };
  };

  // Jobs that bill the same account run one after another in a group, sharing ONE budget
  // (the second job gets what the first left). Different accounts run in parallel.
  const plan = planJobs(profile, settings, adapters, env);
  const groups = new Map();
  for (const [i, entry] of plan.entries()) {
    const key = entry.job ? entry.job.adapter.name : `skip-${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const runGroup = async (entries) => {
    const out = [];
    let budget;
    const first = entries.find((e) => e.job)?.job.adapter;
    if (first?.paid) budget = paidBudget(first, settings, usage, now);
    else if (first?.quota?.period === "day") budget = quotaBudget(first, env, usage, now);

    for (const entry of entries) {
      if (!entry.job) {
        out.push(skipped(entry, entry.skip));
        continue;
      }
      const { job } = entry;
      if (budget && budget.remaining <= 0) {
        out.push(skipped(job, budget.reason ?? `stopped at ${budget.limitedBy}`));
        continue;
      }
      try {
        const result = await runSource(job, { ...shared, budget });
        out.push({ ...result, billedTo: job.adapter.name });
        if (budget) {
          // Hand what's left to the next job on this account.
          budget = { ...budget, remaining: budget.remaining - (result.meter[budget.unit] ?? 0) };
          if (Number.isFinite(budget.usd)) budget.usd -= result.meter.usd ?? 0;
          if (budget.remaining <= 0) budget.reason = `stopped at ${budget.limitedBy}`;
        }
      } catch (err) {
        // Belt and braces: runSource already catches adapter errors per keyword, but if
        // anything else throws, this keeps one source from breaking the whole run.
        out.push({ status: { name: job.name, label: job.label, status: "error", count: 0, reason: safeReason(err, job.adapter.name) }, posts: [], meter: null });
      }
    }
    return out;
  };

  // Keep the profile's order in raw.json, whatever order the groups finish in.
  const finished = await Promise.all([...groups.values()].map(runGroup));
  const byEntry = new Map();
  [...groups.values()].forEach((entries, g) => entries.forEach((entry, i) => byEntry.set(entry, finished[g][i])));
  const results = plan.map((entry) => byEntry.get(entry));

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
  const meters = results.filter((r) => r.meter).map((r) => ({ name: r.billedTo ?? r.status.name, meter: r.meter }));
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
  // Column as wide as the longest label ("Threads (via SocialCrawl)"), plus two spaces, so a
  // long name never runs into its count.
  const width = Math.max(16, ...raw.sources.map((s) => s.label.length + 2));
  for (const s of raw.sources) {
    const name = s.label.padEnd(width);
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
