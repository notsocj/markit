// threads.js — searches recent Threads posts. Free; needs a Meta access token.
//
// API: Threads API `keyword_search`. Checked 2026-10-21 (docs now use graph.threads.com):
//   - GET https://graph.threads.com/v1.0/keyword_search
//     q, search_type=RECENT, since (unix seconds), limit (max 100), fields, access_token
//   - fields used: id, text, permalink, timestamp, username, has_replies, is_reply
//     (search results include NO like/reply counts)
//   - Permissions: threads_basic + threads_keyword_search.
//     IMPORTANT: until Meta approves the app for threads_keyword_search in App Review,
//     "the search will be performed only on posts owned by the authenticated user".
//     So an unreviewed personal app only finds YOUR OWN posts. Public search needs an
//     approved, published app. marKit says this in setup and in /markit-usage.
//   - Rate limit: 2,200 queries per user per rolling 24 hours (shared across apps);
//     queries that return nothing don't count.
//   - Tokens: long-lived tokens last 60 days and must be refreshed before they expire.
//     Errors for bad/expired tokens: HTTP 400 with OAuthException code 190.
//   - debug_token (with the same token as both input and access token) returns expires_at
//     and scopes, which /markit-usage uses to warn before the token expires.
//
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch } from "../lib/safe-fetch.js";
import { makePost, searchQuery } from "../lib/normalize.js";

const BASE = "https://graph.threads.com/v1.0";
const FIELDS = "id,text,permalink,timestamp,username,has_replies,is_reply";

/** Convert one search result into a marKit Post. */
export function toPost(p, matchedKeyword) {
  return makePost({
    source: "threads",
    platformId: p.id,
    url: p.permalink ?? `https://www.threads.com/@${p.username}`,
    title: "", // Threads posts have no titles
    text: p.text ?? "",
    author: p.username ?? "",
    createdAt: p.timestamp, // e.g. "2026-10-20T05:42:03+0000"
    engagement: { hasReplies: Boolean(p.has_replies) },
    matchedKeyword,
  });
}

export default {
  name: "threads",
  label: "Threads",
  requiredEnv: ["THREADS_ACCESS_TOKEN"],
  paid: false,
  // Threads counts a ROLLING 24 hours; marKit shows its own count for today (UTC),
  // which is close enough to warn before the limit.
  quota: { unit: "requests", label: "searches", period: "day", limit: 2200 },
  // check() and notes() call /me and debug_token, which aren't keyword searches.
  checkUsesQuota: false,

  isEnabled(env = {}) {
    return Boolean(env.THREADS_ACCESS_TOKEN);
  },

  async search(keyword, { since, limit = 25, env = {}, meter = {}, http = {} } = {}) {
    const params = new URLSearchParams({
      q: searchQuery(keyword),
      search_type: "RECENT",
      since: String(Math.floor(since.getTime() / 1000)),
      limit: String(Math.min(limit, 100)),
      fields: FIELDS,
      access_token: env.THREADS_ACCESS_TOKEN, // safeFetch never logs URLs
    });
    meter.requests = (meter.requests ?? 0) + 1;
    const data = await safeFetch("threads", `${BASE}/keyword_search?${params}`, http);
    return (data.data ?? [])
      .filter((p) => p.id && p.text)
      .map((p) => toPost(p, keyword))
      .slice(0, limit);
  },

  /** Is the token valid? /me answers 400 (OAuthException 190) for bad or expired tokens. */
  async check(env = {}, { http = {} } = {}) {
    const params = new URLSearchParams({ fields: "id", access_token: env.THREADS_ACCESS_TOKEN ?? "" });
    try {
      await safeFetch("threads", `${BASE}/me?${params}`, { retries: 0, ...http });
      return "ok";
    } catch (err) {
      if ([400, 401, 403].includes(err.status)) return "invalid";
      if (err.status === 429) return "quota";
      return "error";
    }
  },

  /**
   * Extra facts for /markit-usage: days until the token expires, a missing search
   * permission, and the App Review reminder. Never includes the token itself.
   */
  async notes(env = {}, { http = {}, now = new Date() } = {}) {
    const notes = [];
    const token = env.THREADS_ACCESS_TOKEN ?? "";
    try {
      const params = new URLSearchParams({ input_token: token, access_token: token });
      const { data = {} } = await safeFetch("threads", `${BASE}/debug_token?${params}`, { retries: 0, ...http });
      // expires_at is unix seconds; 0 means "doesn't expire".
      if (data.expires_at) {
        const days = Math.floor((data.expires_at * 1000 - now.getTime()) / 86400000);
        notes.push(days < 0 ? "token expired → renew it" : `token expires in ${days} day${days === 1 ? "" : "s"}${days <= 7 ? " → renew soon" : ""}`);
      }
      if (Array.isArray(data.scopes) && !data.scopes.includes("threads_keyword_search")) {
        notes.push("token lacks threads_keyword_search");
      }
    } catch {
      // debug_token isn't essential; skip the expiry note if it fails.
    }
    notes.push("public search needs Meta App Review (otherwise only your own posts)");
    return notes;
  },
};
