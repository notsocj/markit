// apify.js — searches Reddit through an Apify Store actor. OPTIONAL and PAID, but it can
// stay at $0: Apify's free plan includes $5 of usage every month.
//
// One of the three Reddit providers (see lib/reddit.js). It only runs when settings.json says
// "reddit": { "provider": "apify" }.
//
// API (checked 2026-10-22 on docs.apify.com):
//   - Token in the `Authorization: Bearer <token>` header. Apify also accepts ?token= in the
//     URL, which we never use (URLs end up in logs).
//   - POST /v2/actors/<user>~<actor>/run-sync-get-dataset-items runs the actor with the JSON
//     body as its input, waits, and returns the results (an array) in one call.
//     Query params we use: timeout (seconds; this endpoint gives up after 300 s with HTTP 408),
//     maxTotalChargeUsd (the most this run may cost: Apify enforces it), format, clean.
//     Errors: 400 bad input, 401 bad token, 402 usage limit or credit used up, 403 no
//     permission, 404 unknown actor, 408 run took over 300 s, 429 too many requests.
//   - GET /v2/users/me/limits (free): this billing cycle's usage in USD and the account's
//     monthly limit, shown in /markit-usage. (We avoid /v2/users/me: it includes the
//     account's email and proxy password, which marKit has no reason to read.)
//
// THE ACTOR (settings.json apify.redditActor, default "harshmaur~reddit-scraper"), chosen
// 2026-10-22 from the Apify Store because it:
//   - searches Reddit by keyword, newest first ("searchSort": "new"), with a date filter
//     ("postedAfter": "7 days") that matches marKit's lookback window;
//   - takes many keywords in ONE run ("searchTerms"), so a run pays the start fee once;
//   - is priced per result: $2.00 per 1,000 results on the free plan (cheaper on paid plans),
//     plus about $0.02 per run, with comments priced the same as posts; platform usage
//     is included;
//   - is maintained (updated 2026-10-20) and well rated (about 4.6 from 42 reviews).
//   Apify moved Store actors from "pay per result" to "pay per event" pricing in 2026; for
//   this actor the event is still "one result", so the per-result price still applies.
//   Cheaper alternative: "fatihtahta~reddit-scraper-search-fast" ($1.49 / 1,000, no start fee)
//   takes different input fields, so it needs its own input mapping before it can be used.
//
// COST CONTROL. marKit can only ESTIMATE the bill: results × pricePerThousandResults / 1000
// + pricePerRun per actor run (prices from settings.json). Caps in settings.json:
//   apify.maxResultsPerRun (default 50) and apify.maxEstimatedCostPerMonth (default $4.50,
//   just under the $5 free credit). Every run also sends maxTotalChargeUsd, so Apify itself
//   stops the actor before it can cost more than what's left. usage.json records
//   "results" and "usd" (the estimate) under "apify".
//
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch, SourceError } from "../lib/safe-fetch.js";
import { searchQuery } from "../lib/normalize.js";
import { buildContext } from "../lib/context.js";
import { makeRedditPost } from "../lib/reddit.js";
import { DEFAULT_SETTINGS } from "../lib/config.js";
import { getMonthUsage } from "../lib/usage.js";

const BASE = "https://api.apify.com/v2";
const NAME = "apify";

// The sync endpoint gives up after 300 s; ask the actor to finish well before that.
export const RUN_TIMEOUT_SECONDS = 240;
// At most this many comments for thread context (each one is a paid result).
export const MAX_CONTEXT_COMMENTS = 10;

// The latest usage numbers read by check() in this process (not secret), for notes().
let lastLimits = null;

// The token goes in this header and nowhere else (not in the URL, not in errors).
const headers = (env) => ({ authorization: `Bearer ${env.APIFY_API_TOKEN ?? ""}`, "content-type": "application/json" });

/** Apify settings with defaults filled in (prices, caps, actor). */
export function apifySettings(settings = {}) {
  return { ...DEFAULT_SETTINGS.apify, ...(settings.apify ?? {}) };
}

/**
 * The actor id from settings.json, checked so it can only ever form a path on api.apify.com:
 * "username~actor-name" (or Apify's 17-character actor id).
 */
export function actorPath(settings) {
  const id = String(apifySettings(settings).redditActor ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,100}~[A-Za-z0-9._-]{1,100}$/.test(id) && !/^[A-Za-z0-9]{17}$/.test(id)) {
    throw new SourceError(NAME, "apify.redditActor in settings.json must look like \"username~actor-name\"");
  }
  return id;
}

/** Estimated cost in USD of one actor run returning `results` items. */
export function estimateUsd(results, settings) {
  const cfg = apifySettings(settings);
  return Number(cfg.pricePerRun || 0) + (results * Number(cfg.pricePerThousandResults || 0)) / 1000;
}

/**
 * How many results `usd` dollars can still pay for, after one run fee. The tiny 1e-9 stops
 * float rounding from losing one (0.08 * 1000 / 2 is 39.99999… in JavaScript, not 40).
 */
export function affordableResults(usd, settings) {
  const cfg = apifySettings(settings);
  const price = Number(cfg.pricePerThousandResults);
  if (!(price > 0)) return 0;
  if (!Number.isFinite(usd)) return Infinity;
  return Math.max(0, Math.floor(((usd - Number(cfg.pricePerRun || 0)) * 1000) / price + 1e-9));
}

/** Round a dollar amount UP to whole cents (the charge cap must never cut below the estimate). */
const centsUp = (usd) => Math.ceil(usd * 100 - 1e-9) / 100;

/** Reddit's fixed time windows; the smallest one that covers the lookback. */
function timeWindow(days) {
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  return "year";
}

/** Convert one actor result into a marKit Post. Field names vary a little, so read defensively. */
export function toPost(item, matchedKeyword) {
  return makeRedditPost({
    provider: NAME,
    id: item.parsedId ?? item.id,
    url: item.postUrl ?? item.url,
    title: item.title ?? "",
    text: item.body ?? item.text ?? "",
    author: item.authorName ?? item.username ?? item.author ?? "",
    createdAt: item.createdAt ?? item.created_utc,
    score: item.upVotes ?? item.score,
    comments: item.commentsCount ?? item.numberOfComments ?? item.num_comments,
    subreddit: item.parsedCommunityName ?? item.subredditName ?? item.communityName ?? item.subreddit ?? "",
    matchedKeyword,
  });
}

/**
 * Run the actor once and return its results. Counts the request, the results, and the
 * estimated cost in `meter`.
 *
 * Paid runs are NEVER retried (a retry would be a second bill). If the run fails in a way
 * where Apify may still have charged (timeout, network trouble, server error), we count the
 * whole charge cap as spent, so the monthly estimate errs on the safe side.
 */
async function runActor(input, { env, settings, meter, http, maxChargeUsd }) {
  const params = new URLSearchParams({
    timeout: String(RUN_TIMEOUT_SECONDS),
    maxTotalChargeUsd: maxChargeUsd.toFixed(2),
    format: "json",
    clean: "true",
  });
  meter.requests = (meter.requests ?? 0) + 1;
  let items;
  try {
    items = await safeFetch(NAME, `${BASE}/actors/${actorPath(settings)}/run-sync-get-dataset-items?${params}`, {
      ...http,
      method: "POST",
      headers: headers(env),
      body: JSON.stringify(input),
      timeoutMs: (RUN_TIMEOUT_SECONDS + 50) * 1000,
      retries: 0,
    });
  } catch (err) {
    // 400–404 and 429 mean the run never started, so nothing was charged.
    const notCharged = err.status >= 400 && err.status < 500 && err.status !== 408;
    if (!notCharged) meter.usd = (meter.usd ?? 0) + maxChargeUsd;
    throw err;
  }
  const list = Array.isArray(items) ? items : [];
  meter.results = (meter.results ?? 0) + list.length;
  meter.usd = (meter.usd ?? 0) + Math.min(estimateUsd(list.length, settings), maxChargeUsd);
  return list;
}

/** Is this result a post (not a comment, community, or user)? */
const isPost = (item) => item && typeof item === "object" && (item.dataType ? item.dataType === "post" : Boolean(item.title));

export default {
  name: NAME,
  label: "Apify",
  requiredEnv: ["APIFY_API_TOKEN"],
  paid: true,
  costUnit: "results",
  redditProvider: true,
  // The key check reads account usage, which is free.
  checkUsesQuota: false,

  isEnabled(env = {}) {
    return Boolean(env.APIFY_API_TOKEN);
  },

  /** Per-run cap in results, monthly cap in (estimated) dollars. */
  caps(settings) {
    const cfg = apifySettings(settings);
    return { perRun: cfg.maxResultsPerRun, monthly: cfg.maxEstimatedCostPerMonth, monthlyUnit: "usd" };
  },

  /**
   * What this run may spend: { unit: "results", remaining, usd } where `usd` is what's left
   * of this month's estimated-cost cap. remaining is also limited to the results that money
   * can still pay for (after one run fee).
   */
  budget(settings, usage, now = new Date()) {
    const cfg = apifySettings(settings);
    const perRun = cfg.maxResultsPerRun;
    const monthly = cfg.maxEstimatedCostPerMonth;
    const price = Number(cfg.pricePerThousandResults);
    if (!Number.isFinite(perRun) || !Number.isFinite(monthly) || !Number.isFinite(price) || price <= 0) {
      return { unit: "results", remaining: 0, reason: "no Apify caps or prices in settings.json" };
    }
    const used = getMonthUsage(NAME, usage, now).usd ?? 0;
    const usd = monthly - used;
    const affordable = affordableResults(usd, settings);
    if (usd <= 0 || affordable < 1) {
      return { unit: "results", remaining: 0, usd: Math.max(0, usd), reason: `monthly cost cap reached (~$${used.toFixed(2)} / $${monthly.toFixed(2)}, marKit's estimate)` };
    }
    if (perRun <= 0) return { unit: "results", remaining: 0, usd, reason: "per-run cap is 0 in settings.json" };
    return affordable < perRun
      ? { unit: "results", remaining: affordable, usd, limitedBy: `monthly cost cap (~$${monthly.toFixed(2)})` }
      : { unit: "results", remaining: perRun, usd, limitedBy: `per-run cap (${perRun} results)` };
  },

  /**
   * Search ALL keywords in ONE actor run (each run has a start fee), newest posts first,
   * within the lookback window. The results left under the caps are shared evenly across
   * the keywords; if there are fewer results left than keywords, only the first keywords run.
   */
  async searchAll(keywords, { since, limit = 25, env = {}, settings = {}, meter = {}, http = {}, budget, now = new Date() } = {}) {
    const cfg = apifySettings(settings);
    const resultsLeft = Math.floor(budget?.results ?? cfg.maxResultsPerRun);
    const usdLeft = budget?.usd ?? Infinity;
    if (resultsLeft < 1 || usdLeft < estimateUsd(1, settings)) return [];

    // Each keyword becomes one quoted search term (two keywords may trim to the same term).
    // Results name the term that found them, which we match loosely (without quotes or case).
    const termKey = (t) => String(t ?? "").replace(/"/g, "").trim().toLowerCase();
    const termToKeyword = new Map();
    const allTerms = [];
    for (const keyword of keywords) {
      const term = `"${searchQuery(keyword).replace(/"/g, "")}"`;
      if (!termToKeyword.has(termKey(term))) {
        termToKeyword.set(termKey(term), keyword);
        allTerms.push(term);
      }
    }
    let terms = allTerms.slice(0, resultsLeft);
    let perTerm = Math.min(limit, Math.floor(resultsLeft / terms.length));
    // Shrink further if the money left can't pay for that many results.
    const affordable = affordableResults(usdLeft, settings);
    if (perTerm * terms.length > affordable) {
      terms = terms.slice(0, Math.max(1, Math.min(terms.length, affordable)));
      perTerm = Math.max(1, Math.floor(affordable / terms.length));
    }
    const maxChargeUsd = Math.min(centsUp(estimateUsd(perTerm * terms.length, settings)), Number.isFinite(usdLeft) ? Math.floor(usdLeft * 100) / 100 : Infinity);
    if (!(maxChargeUsd > 0)) return [];

    const days = Math.max(1, Math.ceil((now.getTime() - since.getTime()) / 86400000));
    const input = {
      searchTerms: terms,
      searchSort: "new",
      searchTime: timeWindow(days),
      postedAfter: `${days} days`,
      maxPostsCount: perTerm,
      searchPosts: true,
      searchComments: false,
      crawlCommentsPerPost: false,
      includeNSFW: false,
    };
    const items = await runActor(input, { env, settings, meter, http, maxChargeUsd });

    const posts = [];
    for (const item of items.filter(isPost)) {
      try {
        // The actor tells us which search term found each post.
        const keyword = termToKeyword.get(termKey(item.searchTerm)) ?? (terms.length === 1 ? termToKeyword.get(termKey(terms[0])) : "");
        posts.push(toPost(item, keyword));
      } catch {
        // An item without a usable Reddit id is skipped instead of failing the search.
      }
    }
    return posts.filter((p) => p.url);
  },

  /** One keyword (the shared adapter shape): the same as searchAll with a single keyword. */
  async search(keyword, opts = {}) {
    return this.searchAll([keyword], opts);
  },

  /**
   * Thread context (PAID per comment returned, plus a run fee). Only called when
   * settings.contextForPaidSources is on and the caps leave room for it.
   */
  async context(post, { env = {}, settings = {}, meter = {}, http = {}, budget, appNames = [] } = {}) {
    const usdLeft = budget?.usd ?? 0;
    // The post itself comes back as a result too, so it costs one more.
    const affordable = affordableResults(usdLeft, settings) - 1;
    const comments = Math.min(MAX_CONTEXT_COMMENTS, (budget?.results ?? 0) - 1, affordable);
    if (comments < 1 || !post.url) return null;
    const maxChargeUsd = Math.min(centsUp(estimateUsd(comments + 1, settings)), Math.floor(usdLeft * 100) / 100);
    if (!(maxChargeUsd > 0)) return null;

    const items = await runActor(
      { startUrls: [{ url: post.url }], crawlCommentsPerPost: true, maxCommentsPerPost: comments, includeNSFW: false },
      { env, settings, meter, http, maxChargeUsd }
    );
    const thePost = items.find(isPost);
    const list = items
      .filter((i) => i && i.dataType === "comment")
      .map((c) => ({ author: c.authorName ?? c.username ?? "", text: c.body ?? "", score: c.commentUpVotes ?? c.upVotes ?? c.score }))
      .filter((c) => c.text && c.text !== "[deleted]" && c.text !== "[removed]");
    const total = Number(thePost?.commentsCount ?? thePost?.numberOfComments ?? post.engagement?.comments);
    return buildContext({ commentCount: Number.isFinite(total) ? total : list.length, comments: list }, { post, appNames });
  },

  /** Key check through the free account-limits endpoint. */
  async check(env = {}, { http = {} } = {}) {
    lastLimits = null;
    try {
      const data = await safeFetch(NAME, `${BASE}/users/me/limits`, { retries: 0, ...http, headers: headers(env) });
      const used = Number(data?.data?.current?.monthlyUsageUsd);
      const max = Number(data?.data?.limits?.maxMonthlyUsageUsd);
      if (Number.isFinite(used)) lastLimits = { used, max: Number.isFinite(max) ? max : null };
      return Number.isFinite(used) && Number.isFinite(max) && max > 0 && used >= max ? "quota" : "ok";
    } catch (err) {
      if (err.status === 401 || err.status === 403) return "invalid";
      if (err.status === 402 || err.status === 429) return "quota";
      return "error";
    }
  },

  /** Apify's own numbers for this billing cycle, next to marKit's estimate in /markit-usage. */
  async notes() {
    if (!lastLimits) return [];
    const max = lastLimits.max === null ? "" : ` of $${lastLimits.max.toFixed(2)}`;
    return [`Apify says $${lastLimits.used.toFixed(2)}${max} used this billing cycle`];
  },

  /** The paid-usage text for /markit-usage: results and estimated dollars against the cap. */
  usageSummary(month, settings) {
    const cfg = apifySettings(settings);
    const usd = Number(month.usd) || 0;
    const cap = Number(cfg.maxEstimatedCostPerMonth);
    const near = Number.isFinite(cap) && usd >= cap * 0.8 ? " · near cap" : "";
    return `${month.results ?? 0} results · ~$${usd.toFixed(2)} / $${Number.isFinite(cap) ? cap.toFixed(2) : "?"} this month (marKit's estimate)${near}`;
  },
};
