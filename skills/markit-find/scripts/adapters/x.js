// x.js — searches recent posts on X. OPTIONAL and PAID (pay per post returned).
//
// API: X API v2 `GET /2/tweets/search/recent`. Checked 2026-10-21:
//   - https://api.x.com/2/tweets/search/recent, app-only Bearer token (read-only)
//   - params: query (max 512 chars on pay-per-use), max_results (10–100), start_time
//     (RFC 3339, within the last 7 days), tweet.fields
//   - "-is:retweet" must sit next to a normal keyword (it does: we add it to the topic)
//   - PRICE: $0.005 per post read, charged per resource returned. Users returned via
//     expansions are billed too ($0.010 each), so we DON'T ask for author details: links
//     use https://x.com/i/status/<id>, which works without the username.
//   - No free tier. Users should set a spending limit in the X developer console.
//   - errors: 401 bad token, 403 app not enrolled/allowed, 429 rate limit OR usage cap,
//     402 reported by some users when credits run out.
//   - The live API spec now lists `post.fields`; older docs say `tweet.fields`. We send
//     tweet.fields and switch to post.fields once if the API rejects it (400).
//
// Cost control (with search.js): settings.json caps posts per run and per month. search.js
// passes `budget.posts` (what's left); we never ask for more. Since X's minimum is 10 posts
// per request, we stop when fewer than 10 are left rather than risk going over the cap.
//
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch } from "../lib/safe-fetch.js";
import { makePost, searchQuery } from "../lib/normalize.js";
import { buildContext } from "../lib/context.js";

const BASE = "https://api.x.com/2";
const MIN_RESULTS = 10;

// Which field-parameter name the API accepts. Starts with the documented one; flips once.
let fieldsParam = "tweet.fields";
export function _resetFieldsParam() {
  fieldsParam = "tweet.fields";
}

/** Convert one post into a marKit Post. */
export function toPost(t, matchedKeyword) {
  const m = t.public_metrics ?? {};
  return makePost({
    source: "x",
    platformId: t.id,
    url: `https://x.com/i/status/${t.id}`,
    title: "",
    text: t.text ?? "",
    author: "", // not requested: author lookups cost extra
    createdAt: t.created_at,
    engagement: { likes: m.like_count ?? 0, replies: m.reply_count ?? 0, reposts: m.retweet_count ?? 0 },
    matchedKeyword,
    lang: t.lang, // BCP47 tag X detected, e.g. "en" (used by the language filter)
  });
}

export default {
  name: "x",
  label: "X",
  requiredEnv: ["X_BEARER_TOKEN"],
  paid: true,
  costUnit: "posts",
  costPerUnit: 0.005, // USD per post read (pricing page, checked 2026-10-21); an estimate
  checkUsesQuota: false,

  isEnabled(env = {}) {
    return Boolean(env.X_BEARER_TOKEN);
  },

  async search(keyword, { since, limit = 25, env = {}, meter = {}, http = {}, budget } = {}) {
    // How many posts we may pay for in this call.
    const allowed = Math.min(limit, budget?.posts ?? limit, 100);
    if (allowed < MIN_RESULTS) return []; // can't ask for fewer than 10 without overspending

    // X only searches the last 7 days.
    const weekAgo = new Date(Date.now() - 7 * 86400000 + 60000);
    const start = since > weekAgo ? since : weekAgo;
    const query = `${searchQuery(keyword)} -is:retweet`.slice(0, 512);

    const request = (param) => {
      const params = new URLSearchParams({
        query,
        max_results: String(allowed),
        start_time: start.toISOString(),
        [param]: "created_at,public_metrics,lang",
      });
      meter.requests = (meter.requests ?? 0) + 1;
      return safeFetch("x", `${BASE}/tweets/search/recent?${params}`, {
        ...http,
        headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` },
      });
    };

    let data;
    try {
      data = await request(fieldsParam);
    } catch (err) {
      if (err.status !== 400 || fieldsParam !== "tweet.fields") throw err;
      fieldsParam = "post.fields"; // the newer name; remember it for the rest of the run
      data = await request(fieldsParam);
    }

    return (data.data ?? []).filter((t) => t.id).map((t) => toPost(t, keyword)).slice(0, allowed);
  },

  /**
   * Thread context (PAID: every reply returned is a billed post read). Only called when the
   * user enabled settings.contextForPaidSources, and candidates.js passes `budget.posts`
   * (what's left under the per-run and monthly caps). X's minimum is 10 posts per search, so
   * we skip when fewer than 10 are left. Replies come from recent search with
   * `conversation_id:<id>` (last 7 days only; checked 2026-10-22).
   */
  async context(post, { env = {}, meter = {}, http = {}, budget, appNames = [] } = {}) {
    const allowed = Math.min(budget?.posts ?? 0, 10);
    if (allowed < MIN_RESULTS) return null;
    const id = String(post.id).replace(/^x-/, "");
    const params = new URLSearchParams({ query: `conversation_id:${id} -is:retweet`, max_results: String(allowed), [fieldsParam]: "created_at,public_metrics" });
    meter.requests = (meter.requests ?? 0) + 1;
    const data = await safeFetch("x", `${BASE}/tweets/search/recent?${params}`, { ...http, headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` } });
    const replies = (data.data ?? []).filter((t) => t.id !== id);
    meter.posts = (meter.posts ?? 0) + (data.data ?? []).length; // billed per post returned
    return buildContext(
      {
        commentCount: post.engagement?.replies ?? replies.length,
        comments: replies
          .sort((a, b) => (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0))
          .map((t) => ({ author: "", text: t.text, score: t.public_metrics?.like_count ?? 0 })),
      },
      { post, appNames }
    );
  },

  /** Key check with the usage endpoint (doesn't read posts, so it doesn't bill post reads). */
  async check(env = {}, { http = {} } = {}) {
    try {
      await safeFetch("x", `${BASE}/usage/tweets?days=1`, {
        retries: 0,
        ...http,
        headers: { authorization: `Bearer ${env.X_BEARER_TOKEN ?? ""}` },
      });
      return "ok";
    } catch (err) {
      if (err.status === 401 || err.status === 403) return "invalid";
      if (err.status === 402 || err.status === 429) return "quota";
      return "error";
    }
  },
};
