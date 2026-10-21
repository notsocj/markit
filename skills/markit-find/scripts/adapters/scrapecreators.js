// scrapecreators.js — searches Reddit through ScrapeCreators. OPTIONAL and PAID (credits).
//
// One of the three Reddit providers (see lib/reddit.js). It only runs when settings.json says
// "reddit": { "provider": "scrapecreators" }. It's the cheapest per search: 1 credit per
// request, and credits never expire.
//
// API: https://api.scrapecreators.com, header `x-api-key: <key>` (never in the URL).
// Checked 2026-10-22 on docs.scrapecreators.com (and its openapi.json):
//   - GET /v1/reddit/search: query, sort (relevance|new|top|comment_count),
//     timeframe (all|day|week|month|year), after (next-page token), trim.
//     No page-size parameter: we read one page per keyword.
//     Response: { success, credits_remaining, credits_charged, posts: [...], after }.
//     Post fields are Reddit's own: id ("1flgwup"), title, selftext, author, subreddit,
//     permalink (relative), url, created_utc (Unix SECONDS), score, num_comments.
//     We never send trim=true: the trimmed response has no selftext (the post body).
//   - GET /v1/reddit/post/comments?url=<post url>: { post, comments: [...], more }.
//     Each comment: author, body, score, depth, replies: { items: [...], more }.
//   - GET /v1/account/credit-balance: { creditCount }. The docs list it at 1 credit like
//     other requests, so the key check pays 1 credit and /markit-usage counts it.
//   - PRICE: 1 credit per request for Reddit search and for comments. Every response says
//     what it actually cost in `credits_charged`, which is what we record. 100 free credits
//     on signup; packs from $47 for 25,000 credits; credits never expire.
//   - errors: 401 bad/missing key, 402 out of credits, 400 bad parameters, 500 server.
//     Some errors come back as HTTP 200 with `success: false`, so we check that too.
//   - No rate limit and no spending limit on their side: marKit's caps in settings.json
//     (scrapecreators.maxCreditsPerRun / maxCreditsPerMonth) are what keep costs down.
//
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch, SourceError } from "../lib/safe-fetch.js";
import { searchQuery, stripHtml } from "../lib/normalize.js";
import { buildContext } from "../lib/context.js";
import { makeRedditPost } from "../lib/reddit.js";

const BASE = "https://api.scrapecreators.com/v1";
const NAME = "scrapecreators";

// What one request costs, used when a response doesn't say (credits_charged missing).
export const SEARCH_COST = 1;
export const COMMENTS_COST = 1;
export const BALANCE_COST = 1;

// The balance from the last check() in this process (a number, not secret). /markit-usage
// runs check() first and notes() right after, so this saves a paid call.
let lastBalance = null;

// The key goes in this header and nowhere else (not in the URL, not in errors).
const headers = (env) => ({ "x-api-key": env.SCRAPECREATORS_API_KEY ?? "" });

/**
 * Reddit's "timeframe" filter that covers the lookback window. Reddit only offers these
 * fixed windows, so we pick the smallest one that's big enough; search.js then drops
 * anything older than the exact lookback date.
 */
export function timeframeFor(since, now = new Date()) {
  const days = (now.getTime() - since.getTime()) / 86400000;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  return "year";
}

/**
 * Read the JSON body. ScrapeCreators sometimes answers HTTP 200 with `success: false`
 * (and an `errorStatus`); treat that like the HTTP error it describes. The message only
 * ever holds a status number, never anything from the request.
 */
function checked(data) {
  if (data && data.success === false) {
    const status = Number(data.errorStatus) || null;
    throw new SourceError(NAME, status ? `HTTP ${status}` : "API error", status);
  }
  return data ?? {};
}

/** Add what a call actually cost (or our assumed price if the response doesn't say). */
function charge(meter, data, assumed) {
  meter.credits = (meter.credits ?? 0) + (typeof data.credits_charged === "number" ? data.credits_charged : assumed);
}

/** Convert one ScrapeCreators search result into a marKit Post. */
export function toPost(raw, matchedKeyword) {
  return makeRedditPost({
    provider: NAME,
    id: raw.id ?? raw.name,
    // permalink is the discussion itself; `url` can be an external link for link posts.
    url: raw.permalink ?? raw.url,
    title: stripHtml(raw.title ?? ""),
    // The docs show HTML entities (&#039;) in selftext, so decode them.
    text: stripHtml(raw.selftext ?? ""),
    author: raw.author,
    createdAt: raw.created_utc ?? raw.created_at_iso ?? raw.created,
    score: raw.score ?? raw.ups,
    comments: raw.num_comments,
    subreddit: typeof raw.subreddit === "string" ? raw.subreddit : raw.subreddit?.name,
    matchedKeyword,
  });
}

/**
 * Flatten the nested comment tree (comment → replies.items → …) into one list, in the
 * order Reddit returned it, so the top-level comments come first. Stops at `max`.
 */
export function flattenComments(list, max = 50, out = []) {
  for (const c of Array.isArray(list) ? list : []) {
    if (out.length >= max) break;
    if (c && typeof c === "object") {
      out.push({ author: c.author ?? "", text: c.body ?? "", score: Number.isFinite(c.score) ? c.score : c.ups });
      flattenComments(c.replies?.items, max, out);
    }
  }
  return out;
}

export default {
  name: NAME,
  label: "ScrapeCreators",
  requiredEnv: ["SCRAPECREATORS_API_KEY"],
  paid: true,
  costUnit: "credits",
  // Like SocialCrawl, it's a Reddit provider: search.js runs it for the "reddit" source.
  redditProvider: true,
  // The key check calls the balance endpoint, which costs a credit: /markit-usage and the
  // dashboard record it, so marKit's count matches the bill.
  checkCost: { credits: BALANCE_COST },

  isEnabled(env = {}) {
    return Boolean(env.SCRAPECREATORS_API_KEY);
  },

  /**
   * One request per keyword: the newest Reddit posts that contain the topic phrase, within
   * the lookback timeframe. Skips the call when the credits left under the caps
   * (budget.credits, from search.js) can't pay for it.
   */
  async search(keyword, { since, limit = 25, env = {}, meter = {}, http = {}, budget, now = new Date() } = {}) {
    if (budget?.credits !== undefined && budget.credits < SEARCH_COST) return [];
    const params = new URLSearchParams({
      // Quoted so Reddit matches the phrase, not just some of its words.
      query: `"${searchQuery(keyword).replace(/"/g, "")}"`,
      sort: "new",
      timeframe: timeframeFor(since, now),
    });
    meter.requests = (meter.requests ?? 0) + 1;
    const data = checked(await safeFetch(NAME, `${BASE}/reddit/search?${params}`, { ...http, headers: headers(env) }));
    charge(meter, data, SEARCH_COST);
    const posts = [];
    for (const raw of Array.isArray(data.posts) ? data.posts : []) {
      try {
        posts.push(toPost(raw, keyword));
      } catch {
        // An item without a usable Reddit id is skipped instead of failing the search.
      }
    }
    return posts.filter((p) => p.url).slice(0, limit);
  },

  /**
   * Thread context (PAID: 1 credit per page of comments). Only called when
   * settings.contextForPaidSources is on, and only if `budget.credits` covers it.
   * The API has no locked flag, so `locked` stays false.
   */
  async context(post, { env = {}, meter = {}, http = {}, budget, appNames = [] } = {}) {
    if ((budget?.credits ?? 0) < COMMENTS_COST || !post.url) return null;
    meter.requests = (meter.requests ?? 0) + 1;
    const data = checked(await safeFetch(NAME, `${BASE}/reddit/post/comments?${new URLSearchParams({ url: post.url })}`, { ...http, headers: headers(env) }));
    charge(meter, data, COMMENTS_COST);
    const comments = flattenComments(data.comments).filter((c) => c.text && c.text !== "[deleted]" && c.text !== "[removed]");
    const total = Number(data.post?.num_comments ?? post.engagement?.comments);
    return buildContext({ commentCount: Number.isFinite(total) ? total : comments.length, comments }, { post, appNames });
  },

  /**
   * Key check through the balance endpoint (costs 1 credit, see checkCost). Remembers the
   * balance so notes() can show it without paying for a second call.
   */
  async check(env = {}, { http = {} } = {}) {
    lastBalance = null;
    try {
      const data = checked(await safeFetch(NAME, `${BASE}/account/credit-balance`, { retries: 0, ...http, headers: headers(env) }));
      const balance = typeof data.creditCount === "number" ? data.creditCount : data.credits_remaining;
      if (typeof balance === "number") lastBalance = balance;
      return balance === 0 ? "quota" : "ok";
    } catch (err) {
      if (err.status === 401 || err.status === 403) return "invalid";
      if (err.status === 402 || err.status === 429) return "quota";
      return "error";
    }
  },

  /** "1,234 credits left" for /markit-usage, from the balance check() just read. */
  async notes() {
    return typeof lastBalance === "number" ? [`${lastBalance.toLocaleString("en-US")} credits left (never expire)`] : [];
  },
};

