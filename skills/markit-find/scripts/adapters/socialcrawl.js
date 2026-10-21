// socialcrawl.js — searches Reddit through SocialCrawl. OPTIONAL and PAID (credits).
//
// Why: agents' web search almost never returns Reddit threads (tested 2026-10-21), and
// Reddit is where many "what app do you use for X?" conversations happen. SocialCrawl is a
// paid REST API that reads Reddit (and other platforms) for us.
//
// API: https://www.socialcrawl.dev/v1, header `x-api-key: sc_...`. Checked 2026-10-21:
//   - GET /v1/reddit/search: query, sort=new, since (date), max_pages=1
//     Words match ANY word unless quoted, so we quote the topic phrase.
//   - envelope: { success, data: { items[] }, credits_used, credits_remaining, cached }
//   - post fields: id, url, ext.title, ext.subreddit, content.text (or ext.selftext),
//     author.username, published_at, engagement.likes, engagement.comments.
//     Docs leave some details open, so we read fields defensively.
//   - PRICE: 1 credit per page for Reddit search; cached results cost 0; failed calls are
//     refunded. 100 free credits on signup; packs from £15 for 2,500 credits.
//   - GET /v1/credits/balance costs 0 credits: used for the key check and balance note.
//   - errors: 401 bad/missing key, 402 out of credits or per-key budget, 429 rate limit.
//
// Cost control (with search.js): settings.json caps credits per run and per month;
// search.js stops calling once the cap is reached. Each call here is 1 page = 1 credit.
//
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch } from "../lib/safe-fetch.js";
import { makePost, searchQuery } from "../lib/normalize.js";
import { buildContext } from "../lib/context.js";

// Reddit comments cost 5 credits per page (checked 2026-10-22).
export const COMMENTS_COST = 5;

const BASE = "https://www.socialcrawl.dev/v1";

const headers = (env) => ({ "x-api-key": env.SOCIALCRAWL_API_KEY ?? "" });

/** Convert one Reddit result into a marKit Post (reading fields defensively). */
export function toPost(raw, matchedKeyword) {
  const item = raw.post ?? raw; // some responses may wrap the post
  const ext = item.ext ?? {};
  const subreddit = ext.subreddit ?? item.subreddit ?? "";
  return makePost({
    source: "socialcrawl",
    platformId: item.id,
    url: item.url ?? ext.permalink ?? "",
    title: ext.title ?? item.title ?? "",
    text: item.content?.text ?? ext.selftext ?? item.text ?? "",
    author: item.author?.username ?? (typeof item.author === "string" ? item.author : ""),
    createdAt: item.published_at ?? item.created_at,
    engagement: {
      score: item.engagement?.likes ?? 0,
      comments: item.engagement?.comments ?? 0,
    },
    matchedKeyword,
    // Shown in the report instead of "SocialCrawl", e.g. "Reddit r/formula1".
    site: subreddit ? `Reddit r/${String(subreddit).replace(/^r\//, "")}` : "Reddit",
  });
}

export default {
  name: "socialcrawl",
  label: "SocialCrawl",
  requiredEnv: ["SOCIALCRAWL_API_KEY"],
  paid: true,
  costUnit: "credits",
  // No costPerUnit: credits are sold in GBP packs, so /markit-usage shows the balance instead.
  checkUsesQuota: false,

  isEnabled(env = {}) {
    return Boolean(env.SOCIALCRAWL_API_KEY);
  },

  async search(keyword, { since, limit = 25, env = {}, meter = {}, http = {}, budget } = {}) {
    if (budget && budget.credits !== undefined && budget.credits < 1) return [];
    const params = new URLSearchParams({
      // Quoted so Reddit matches the phrase, not any single word of it.
      query: `"${searchQuery(keyword).replace(/"/g, "")}"`,
      sort: "new",
      since: since.toISOString().slice(0, 10), // YYYY-MM-DD
      max_pages: "1", // 1 page = 1 credit
    });
    meter.requests = (meter.requests ?? 0) + 1;
    const data = await safeFetch("socialcrawl", `${BASE}/reddit/search?${params}`, { ...http, headers: headers(env) });
    // Count what was actually charged (0 for cached results); assume 1 if not reported.
    meter.credits = (meter.credits ?? 0) + (typeof data.credits_used === "number" ? data.credits_used : 1);

    const items = Array.isArray(data.data?.items) ? data.data.items : Array.isArray(data.data) ? data.data : [];
    return items
      .map((raw) => {
        try {
          return toPost(raw, keyword);
        } catch {
          return null; // skip a malformed item instead of failing the whole search
        }
      })
      .filter((p) => p && p.url)
      .slice(0, limit);
  },

  /**
   * Thread context (PAID: 5 credits per page of Reddit comments; cached pages are free).
   * Only called when settings.contextForPaidSources is on, and only if `budget.credits`
   * (what's left under the caps) covers a page. GET /v1/reddit/post/comments?url=…
   * returns data.items[].comment with author.username, text, engagement.likes.
   * The API has no locked/archived flag, so `locked` stays false.
   */
  async context(post, { env = {}, meter = {}, http = {}, budget, appNames = [] } = {}) {
    if ((budget?.credits ?? 0) < COMMENTS_COST || !post.url) return null;
    meter.requests = (meter.requests ?? 0) + 1;
    const data = await safeFetch("socialcrawl", `${BASE}/reddit/post/comments?${new URLSearchParams({ url: post.url })}`, { ...http, headers: headers(env) });
    meter.credits = (meter.credits ?? 0) + (typeof data.credits_used === "number" ? data.credits_used : COMMENTS_COST);
    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    const comments = items
      .map((raw) => raw.comment ?? raw)
      .filter((c) => c && c.text)
      .map((c) => ({ author: c.author?.username ?? "", text: c.text, score: c.engagement?.likes ?? 0 }));
    const total = Number(data.data?.ext?.post_comment_count ?? data.ext?.post_comment_count ?? post.engagement?.comments);
    return buildContext({ commentCount: Number.isFinite(total) ? total : comments.length, comments }, { post, appNames });
  },

  /** Key check via the free balance endpoint. */
  async check(env = {}, { http = {} } = {}) {
    try {
      const data = await safeFetch("socialcrawl", `${BASE}/credits/balance`, { retries: 0, ...http, headers: headers(env) });
      return data.data?.balance === 0 ? "quota" : "ok";
    } catch (err) {
      if (err.status === 401 || err.status === 403) return "invalid";
      if (err.status === 402 || err.status === 429) return "quota";
      return "error";
    }
  },

  /** "1,234 credits left" for /markit-usage (free call). */
  async notes(env = {}, { http = {} } = {}) {
    try {
      const data = await safeFetch("socialcrawl", `${BASE}/credits/balance`, { retries: 0, ...http, headers: headers(env) });
      const balance = data.data?.balance;
      return typeof balance === "number" ? [`${balance.toLocaleString("en-US")} credits left`] : [];
    } catch {
      return [];
    }
  },
};
