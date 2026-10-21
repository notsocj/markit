#!/usr/bin/env node
// candidates.js — narrows a run down to the posts worth the agent's attention.
//
//   node candidates.js <run-folder>
//
// The run folder is the one search.js created (it holds raw.json). Before running this,
// the agent saves its web search results there as web.json:
//
//   [ { "url": "https://…", "title": "…", "excerpt": "…", "site": "Autosport Forums",
//       "createdAt": "2026-10-20T08:00:00Z" }, … ]          (or { "posts": [ … ] })
//
// What happens, in order (each step lives in lib/filters.js):
//   1. Merge raw.json posts + web.json results (web results get a stable id from their URL).
//   2. Drop posts older than the lookback window (unknown dates are kept).
//   3. Drop posts containing the profile's exclude words.
//   4. Drop posts already reported in an earlier run (seen.json).
//   5. Drop posts the platform says are in another language (profile "languages").
//   6. Merge cross-posts (same question posted twice): keep the most engaged copy and list
//      the others in "alsoPostedAt".
//   7. Pre-score every post 0–100 (a cheap, documented formula; no AI).
//   8. Keep the top maxCandidates (settings.json, default 40).
//   9. Fetch thread context (comments, solved, locked…) for the top maxContext (default 15)
//      through each adapter's optional context() method. Paid sources only if
//      settings.contextForPaidSources is true, and always within their caps.
//  10. Write candidates.json (+ a summary of how many posts each step dropped: counts only)
//      and record every API call in usage.json.
//
// The agent then scores ONLY candidates.json.
//
// SECURITY: keys stay in memory and only go to adapters. web.json and all comment text are
// UNTRUSTED: we only clean and store them (stripped, truncated), never act on them.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPaths, loadEnv, loadSettings, loadApp } from "./lib/config.js";
import { validateProfile } from "./lib/profile.js";
import { readJsonFile, writeJsonFile } from "./lib/files.js";
import { loadSeen } from "./lib/seen.js";
import { loadUsage, recordUsage } from "./lib/usage.js";
import { sinceDate, excerpt, stripHtml, collapseWhitespace, toIsoDate } from "./lib/normalize.js";
import { webIdFor } from "./lib/scored.js";
import { dropTooOld, dropExcluded, dropSeen, dropLanguages, dedupeCrossPosts, preScoreAll, keepTop, droppedSummary } from "./lib/filters.js";
import { paidBudget, quotaBudget, safeReason } from "./search.js";
import { ADAPTERS } from "./adapters/index.js";

export const MAX_WEB_RESULTS = 100;

/**
 * Turn the agent's web.json into Posts. Anything malformed is skipped and counted.
 * Web results are untrusted text: HTML is stripped and lengths are capped.
 *
 * @returns {{ posts: object[], invalid: number }}
 */
export function readWebPosts(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.posts) ? data.posts : [];
  const posts = [];
  let invalid = 0;
  for (const item of list.slice(0, MAX_WEB_RESULTS)) {
    let url;
    try {
      url = new URL(String(item?.url ?? ""));
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    } catch {
      invalid++;
      continue;
    }
    const title = collapseWhitespace(stripHtml(item.title ?? "")).slice(0, 300);
    const text = excerpt(stripHtml(item.excerpt ?? ""));
    if (!title && !text) {
      invalid++;
      continue;
    }
    const post = {
      id: webIdFor(url.href),
      source: "web",
      site: collapseWhitespace(stripHtml(item.site ?? "")).slice(0, 60) || url.hostname.replace(/^www\./, ""),
      url: url.href,
      title,
      excerpt: text,
      author: collapseWhitespace(stripHtml(item.author ?? "")).slice(0, 60),
      createdAt: toIsoDate(item.createdAt),
      engagement: {},
      matchedKeyword: typeof item.matchedKeyword === "string" ? item.matchedKeyword.slice(0, 100) : "",
    };
    posts.push(post);
  }
  return { posts, invalid };
}

/** A fresh usage counter for one source (same fields as usage.json). */
const newMeter = () => ({ requests: 0, posts: 0, credits: 0, context: 0 });

/**
 * How much a PAID source may still spend on context in this run: the smaller of
 * (per-run cap − what search.js already spent this run) and what's left this month,
 * minus what context has spent so far. Returns 0 when nothing is left.
 */
export function paidContextBudget(adapter, { settings, usage, raw, meter, now }) {
  const unit = adapter.costUnit ?? "posts";
  const Unit = unit === "credits" ? "Credits" : "Posts";
  const perRun = settings[adapter.name]?.[`max${Unit}PerRun`];
  const base = paidBudget(adapter, settings, usage, now); // already counts this month's search spend
  if (!Number.isFinite(perRun) || base.remaining <= 0) return { unit, remaining: 0 };
  const searchSpent = raw.sources?.find((s) => s.name === adapter.name)?.used?.[unit] ?? 0;
  const remaining = Math.min(base.remaining, perRun - searchSpent) - (meter[unit] ?? 0);
  return { unit, remaining: Math.max(0, remaining) };
}

/**
 * The whole step, without reading or writing files (so tests can call it directly).
 *
 * @returns {Promise<{ output: object, meters: Record<string, object> }>}
 *   output — candidates.json content; meters — API usage per source, for usage.json
 */
export async function buildCandidates({ raw, web = null, profile, settings, env = {}, seen = new Set(), usage = { months: {}, days: {} }, adapters = ADAPTERS, now = new Date(), http }) {
  const lookback = raw.lookbackDays ?? profile.lookbackDays ?? settings.lookbackDays;
  const since = raw.since ? new Date(raw.since) : sinceDate(lookback, now);

  // 1. Merge API posts and web results (the same id twice → keep the first).
  const { posts: webPosts, invalid: invalidWeb } = readWebPosts(web);
  const byId = new Map();
  for (const post of [...(raw.posts ?? []), ...webPosts]) if (post?.id && !byId.has(post.id)) byId.set(post.id, post);
  let posts = [...byId.values()];
  const considered = posts.length;

  // 2–8. The prefilter. Each step reports how many it dropped.
  const dropped = { tooOld: 0, excluded: 0, alreadyReported: 0, language: 0, duplicate: 0, belowCutoff: 0 };
  let step;
  step = dropTooOld(posts, since); posts = step.kept; dropped.tooOld += step.dropped;
  step = dropExcluded(posts, profile.exclude); posts = step.kept; dropped.excluded += step.dropped;
  step = dropSeen(posts, seen); posts = step.kept; dropped.alreadyReported += step.dropped;
  step = dropLanguages(posts, profile.languages ?? ["en"]); posts = step.kept; dropped.language += step.dropped;
  step = dedupeCrossPosts(posts); posts = step.kept; dropped.duplicate += step.dropped;
  posts = preScoreAll(posts, profile, now);
  step = keepTop(posts, settings.maxCandidates ?? 40); posts = step.kept; dropped.belowCutoff += step.dropped;

  // search.js already dropped some posts per source before writing raw.json (too old,
  // excluded words, already reported). Add those in, so the summary covers the whole run.
  for (const s of raw.sources ?? []) {
    dropped.tooOld += s.removed?.outsideWindow ?? 0;
    dropped.excluded += s.removed?.excluded ?? 0;
    dropped.alreadyReported += s.removed?.seen ?? 0;
  }
  // Posts the APIs returned before search.js's own filtering. Older raw.json files have no
  // per-source "fetched" totals, so never report fewer than the posts actually in the file.
  const foundByApis = Math.max((raw.sources ?? []).reduce((sum, s) => sum + (s.fetched ?? 0), 0), (raw.posts ?? []).length);

  // 9. Thread context for the best few.
  const meters = {};
  const contextStats = { fetched: 0, failed: 0, paidOff: 0, capped: 0, unsupported: 0 };
  const appNames = [profile.name];
  for (const post of posts.slice(0, settings.maxContext ?? 15)) {
    if (post.source === "web") continue; // the agent may open web pages itself
    const adapter = adapters.find((a) => a.name === post.source);
    if (!adapter || typeof adapter.context !== "function" || !adapter.isEnabled(env)) {
      contextStats.unsupported++;
      continue;
    }
    const meter = (meters[adapter.name] ??= newMeter());
    let budget;
    if (adapter.paid) {
      if (!settings.contextForPaidSources) {
        contextStats.paidOff++;
        continue;
      }
      const b = paidContextBudget(adapter, { settings, usage, raw, meter, now });
      if (b.remaining <= 0) {
        contextStats.capped++;
        continue;
      }
      budget = { [b.unit]: b.remaining };
    } else if (adapter.quota?.period === "day" && adapter.contextUsesQuota !== false) {
      // Free daily quota shared with search (e.g. Stack Exchange): leave room for 2 calls.
      const left = quotaBudget(adapter, env, usage, now).remaining - meter.requests;
      if (left < 2) {
        contextStats.capped++;
        continue;
      }
    }
    try {
      const ctx = await adapter.context(post, { env, limit: 5, meter, http, budget, appNames });
      if (ctx) {
        post.context = ctx;
        contextStats.fetched++;
      } else if (adapter.paid) {
        contextStats.capped++; // e.g. X needs at least 10 posts of budget
      }
    } catch (err) {
      contextStats.failed++;
      contextStats.lastError = safeReason(err, adapter.name);
    }
  }

  const output = {
    app: raw.app,
    ranAt: raw.ranAt,
    builtAt: toIsoDate(now),
    lookbackDays: lookback,
    since: toIsoDate(since),
    sources: raw.sources ?? [],
    webQueries: raw.webQueries ?? [],
    prefilter: {
      found: foundByApis + webPosts.length,
      fromApis: foundByApis,
      fromWeb: webPosts.length,
      invalidWeb,
      considered,
      candidates: posts.length,
      maxCandidates: settings.maxCandidates ?? 40,
      dropped,
      context: contextStats,
    },
    candidates: posts,
  };
  return { output, meters };
}

/** The short terminal summary. */
export function formatSummary(output, file) {
  const p = output.prefilter;
  const c = p.context;
  const ctxNotes = [];
  if (c.failed) ctxNotes.push(`${c.failed} failed`);
  if (c.paidOff) ctxNotes.push(`${c.paidOff} skipped (paid sources off)`);
  if (c.capped) ctxNotes.push(`${c.capped} skipped (quota or cap)`);
  return [
    `marKit candidates · ${output.app}`,
    `  Found ${p.found} posts (${p.fromApis} from APIs, ${p.fromWeb} from web search${p.invalidWeb ? `, ${p.invalidWeb} invalid web entries skipped` : ""})`,
    `  Dropped: ${droppedSummary(p.dropped) || "none"}`,
    `  ${p.candidates} candidates · thread context for ${c.fetched}${ctxNotes.length ? ` (${ctxNotes.join(", ")})` : ""}`,
    `candidates.json: ${file}`,
  ].join("\n");
}

async function main() {
  const runArg = process.argv[2];
  if (!runArg) throw new Error("marKit: usage: node candidates.js <run-folder>");
  const runDir = path.resolve(runArg);
  const raw = readJsonFile(path.join(runDir, "raw.json"), null);
  if (!raw) throw new Error(`marKit: raw.json not found in ${runDir}. Run search.js first and pass its run folder.`);

  const paths = getPaths();
  const { profile } = validateProfile(loadApp(raw.app, paths), raw.app);
  const webFile = path.join(runDir, "web.json");
  const now = new Date();
  const { output, meters } = await buildCandidates({
    raw,
    web: existsSync(webFile) ? readJsonFile(webFile, []) : null,
    profile,
    settings: loadSettings(paths),
    env: loadEnv(paths.envFile),
    seen: loadSeen(paths.seenFile),
    usage: loadUsage(paths.usageFile),
    now,
  });
  // One at a time: each call reads, updates, and rewrites usage.json.
  for (const [name, meter] of Object.entries(meters)) recordUsage(name, meter, paths.usageFile, now);

  const file = path.join(runDir, "candidates.json");
  writeJsonFile(file, output);
  console.log(formatSummary(output, file));
}

// Run main() only when executed directly, not when imported by tests.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (runDirectly) {
  main().catch((err) => {
    console.error(err.message?.startsWith("marKit:") ? err.message : `marKit: ${safeReason(err, "candidates")}`);
    process.exitCode = 1;
  });
}
