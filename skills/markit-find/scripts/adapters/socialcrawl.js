// socialcrawl.js — searches Reddit and/or Threads through SocialCrawl. OPTIONAL and PAID (credits).
//
// Two jobs, both through the same SocialCrawl account and credit caps:
//   - REDDIT: SocialCrawl is one of the three Reddit providers (lib/reddit.js). It searches
//     Reddit only when settings.json says "reddit": { "provider": "socialcrawl" }.
//     Results are ordinary Reddit posts: source "reddit", provider "socialcrawl", id
//     "reddit-<post id>", the same as from ScrapeCreators or Apify.
//   - THREADS: the "socialcrawl" profile source means Threads through SocialCrawl.
// search.js tells search() which platforms to search (opts.platforms) and runs both jobs
// one after the other with ONE shared credit budget, so together they never pass the caps.
//
// Why Reddit needs a paid API: agents' web search almost never returns Reddit threads
// (tested 2026-10-21), and Reddit is where many "what app do you use for X?" conversations happen.
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
// THREADS (the "socialcrawl" profile source). Checked 2026-10-22
// on socialcrawl.dev/platforms/threads/search.md:
//   - GET /v1/threads/search: query, start_date (YYYY-MM-DD, enforced by SocialCrawl), expand
//   - 1 credit per result window (~15–20 posts). Threads only matches phrases it already
//     knows, so an unknown multi-word phrase returns nothing unless SocialCrawl "relaxes" it
//     into word pairs (expand=true), which can bill up to 4 more credits (only for pairs that
//     found posts). So we allow relaxing only when at least THREADS_MAX_COST credits are left
//     under the caps; otherwise expand=false (exactly 1 credit, exact phrase only).
//   - rows use the same unified shape as Reddit (id, url, content.text, author.username,
//     published_at, engagement.*). No subreddit, no title.
//   - GET /v1/threads/post/comments: 1 credit for ~20 replies (thread context).
// Unlike the "threads" source (Meta's own API), this needs no Meta app or App Review.
//
// Cost control (with search.js): settings.json caps credits per run and per month;
// search.js stops calling once the cap is reached, and passes what's left as
// budget.credits so this file never starts a call it can't pay for.
//
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch } from "../lib/safe-fetch.js";
import { makePost, searchQuery } from "../lib/normalize.js";
import { buildContext } from "../lib/context.js";
import { makeRedditPost } from "../lib/reddit.js";

// Reddit comments cost 5 credits per page (checked 2026-10-22).
export const COMMENTS_COST = 5;
// Threads: comments cost 1 credit per window; a search costs 1, or up to 5 when relaxed.
export const THREADS_COMMENTS_COST = 1;
export const THREADS_MAX_COST = 5;

const BASE = "https://www.socialcrawl.dev/v1";

const headers = (env) => ({ "x-api-key": env.SOCIALCRAWL_API_KEY ?? "" });

/** Convert one Reddit result into a marKit Reddit Post (reading fields defensively). */
export function toPost(raw, matchedKeyword) {
  const item = raw.post ?? raw; // some responses may wrap the post
  const ext = item.ext ?? {};
  return makeRedditPost({
    provider: "socialcrawl",
    id: item.id,
    url: item.url ?? ext.permalink ?? "",
    title: ext.title ?? item.title ?? "",
    text: item.content?.text ?? ext.selftext ?? item.text ?? "",
    author: item.author?.username ?? (typeof item.author === "string" ? item.author : ""),
    createdAt: item.published_at ?? item.created_at,
    score: item.engagement?.likes,
    comments: item.engagement?.comments,
    subreddit: ext.subreddit ?? item.subreddit ?? "",
    matchedKeyword,
  });
}

/** Convert one Threads result into a marKit Post. Ids get a "th-" prefix so they can't clash with Reddit's. */
export function toThreadsPost(raw, matchedKeyword) {
  const item = raw.post ?? raw;
  return makePost({
    source: "socialcrawl",
    platformId: `th-${item.id ?? item.ext?.shortcode ?? ""}`,
    url: item.url ?? "",
    title: "", // Threads posts have no title
    text: item.content?.text ?? item.text ?? "",
    author: item.author?.username ?? (typeof item.author === "string" ? item.author : ""),
    createdAt: item.published_at ?? item.created_at,
    engagement: {
      likes: item.engagement?.likes ?? 0,
      replies: item.engagement?.comments ?? 0,
      reposts: item.engagement?.shares ?? 0,
    },
    matchedKeyword,
    site: "Threads",
  });
}

/** Is this Post a Threads result from SocialCrawl (as opposed to Reddit)? */
const isThreadsPost = (post) => post.site === "Threads" || String(post.id ?? "").startsWith("sc-th-");

/** Items from a SocialCrawl envelope, as Posts (malformed items are skipped). */
function itemsToPosts(data, convert, keyword) {
  const items = Array.isArray(data.data?.items) ? data.data.items : Array.isArray(data.data) ? data.data : [];
  return items
    .map((raw) => {
      try {
        return convert(raw, keyword);
      } catch {
        return null; // skip a malformed item instead of failing the whole search
      }
    })
    .filter((p) => p && p.url);
}

export default {
  name: "socialcrawl",
  label: "SocialCrawl",
  requiredEnv: ["SOCIALCRAWL_API_KEY"],
  paid: true,
  costUnit: "credits",
  // No costPerUnit: credits are sold in GBP packs, so /markit-usage shows the balance instead.
  checkUsesQuota: false,
  // Also a Reddit provider: search.js runs it for the "reddit" source when chosen.
  redditProvider: true,

  isEnabled(env = {}) {
    return Boolean(env.SOCIALCRAWL_API_KEY);
  },

  /**
   * Search the given platforms (search.js passes ["reddit"] for the Reddit provider job and
   * ["threads"] for the "socialcrawl" source) for one keyword. Before each call we check the
   * credits left (budget.credits from search.js minus what this keyword already spent), so a
   * run never goes over its caps.
   */
  async search(keyword, { since, limit = 25, env = {}, meter = {}, http = {}, budget, platforms = ["reddit"] } = {}) {
    const spentBefore = meter.credits ?? 0;
    const left = () => (budget?.credits === undefined ? Infinity : budget.credits - ((meter.credits ?? 0) - spentBefore));
    const day = since.toISOString().slice(0, 10); // YYYY-MM-DD
    const charge = (data, assumed) => {
      // Count what was actually charged (0 for cached results); assume the price if not reported.
      meter.credits = (meter.credits ?? 0) + (typeof data.credits_used === "number" ? data.credits_used : assumed);
    };
    const posts = [];

    if (platforms.includes("reddit") && left() >= 1) {
      const params = new URLSearchParams({
        // Quoted so Reddit matches the phrase, not any single word of it.
        query: `"${searchQuery(keyword).replace(/"/g, "")}"`,
        sort: "new",
        since: day,
        max_pages: "1", // 1 page = 1 credit
      });
      meter.requests = (meter.requests ?? 0) + 1;
      const data = await safeFetch("socialcrawl", `${BASE}/reddit/search?${params}`, { ...http, headers: headers(env) });
      charge(data, 1);
      posts.push(...itemsToPosts(data, toPost, keyword).slice(0, limit));
    }

    if (platforms.includes("threads") && left() >= 1) {
      const relax = left() >= THREADS_MAX_COST; // see the THREADS note at the top
      const params = new URLSearchParams({
        query: searchQuery(keyword), // Threads has no quoted-phrase search
        start_date: day,
        expand: relax ? "true" : "false",
      });
      meter.requests = (meter.requests ?? 0) + 1;
      const data = await safeFetch("socialcrawl", `${BASE}/threads/search?${params}`, { ...http, headers: headers(env) });
      charge(data, 1);
      posts.push(...itemsToPosts(data, toThreadsPost, keyword).slice(0, limit));
    }
    return posts;
  },

  /**
   * Thread context (PAID: 5 credits per page of Reddit comments; cached pages are free).
   * Only called when settings.contextForPaidSources is on, and only if `budget.credits`
   * (what's left under the caps) covers a page. GET /v1/reddit/post/comments?url=…
   * returns data.items[].comment with author.username, text, engagement.likes.
   * The API has no locked/archived flag, so `locked` stays false.
   */
  async context(post, { env = {}, meter = {}, http = {}, budget, appNames = [] } = {}) {
    // Threads results use the Threads comments endpoint (1 credit), Reddit the Reddit one (5).
    const threads = isThreadsPost(post);
    const cost = threads ? THREADS_COMMENTS_COST : COMMENTS_COST;
    if ((budget?.credits ?? 0) < cost || !post.url) return null;
    meter.requests = (meter.requests ?? 0) + 1;
    const endpoint = threads ? "threads/post/comments" : "reddit/post/comments";
    const data = await safeFetch("socialcrawl", `${BASE}/${endpoint}?${new URLSearchParams({ url: post.url })}`, { ...http, headers: headers(env) });
    meter.credits = (meter.credits ?? 0) + (typeof data.credits_used === "number" ? data.credits_used : cost);
    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    const comments = items
      .map((raw) => raw.comment ?? raw)
      .map((c) => c && { ...c, text: c.text ?? c.content?.text })
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
