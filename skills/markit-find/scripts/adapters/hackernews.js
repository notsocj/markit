// hackernews.js — searches Hacker News stories and comments. Free, no key.
//
// API: Algolia's HN Search API (https://hn.algolia.com/api), endpoint /search_by_date,
// which returns the newest matches first. Checked 2026-10-21 against the live API:
//   - params: query, tags, numericFilters, hitsPerPage
//   - tags "(story,comment)" means "stories OR comments"
//   - numericFilters "created_at_i>UNIX_SECONDS" limits results to the lookback window
//   - typoTolerance=false so only real word matches count (see search() below)
//   - story hits have: objectID, title, url, story_text, author, created_at_i, points, num_comments
//   - comment hits have: objectID, story_title, comment_text, author, created_at_i, story_id, children
// Rate limit: Algolia allows 10,000 requests per hour per IP, far more than marKit uses.
//
// Every adapter exports the same shape (see spec section 12):
//   { name, requiredEnv, paid, isEnabled(env), search(keyword, opts), check(env) }
//
// search() options:
//   since   Date: only posts newer than this
//   limit   max posts to return for this keyword
//   env     API keys (unused here: HN needs none)
//   meter   { requests, credits }: we add 1 to `requests` per API call, for usage.json
//   http    extra options for safeFetch (tests pass a fake fetchImpl here)

import { safeFetch } from "../lib/safe-fetch.js";
import { makePost, stripHtml, searchQuery } from "../lib/normalize.js";
import { buildContext } from "../lib/context.js";

const BASE = "https://hn.algolia.com/api/v1";
// Algolia returns at most 1000 hits per page; we never want anywhere near that many.
const MAX_PER_REQUEST = 50;

/** Convert one Algolia hit (a story or a comment) into a marKit Post. */
export function toPost(hit, matchedKeyword) {
  const isComment = Array.isArray(hit._tags) ? hit._tags.includes("comment") : Boolean(hit.comment_text);
  return makePost({
    source: "hackernews",
    platformId: hit.objectID,
    // Always link to the HN discussion itself (not the story's external link), because
    // that's where the user would reply.
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    title: isComment ? `Re: ${hit.story_title ?? ""}` : hit.title,
    // HN text is HTML (e.g. "I&#x27;m" and <p> tags), so clean it up for the excerpt.
    text: stripHtml(isComment ? hit.comment_text : hit.story_text),
    author: hit.author,
    createdAt: hit.created_at_i,
    engagement: isComment
      ? { replies: Array.isArray(hit.children) ? hit.children.length : 0 }
      : { score: hit.points ?? 0, comments: hit.num_comments ?? 0 },
    matchedKeyword,
  });
}

export default {
  name: "hackernews",
  label: "Hacker News",
  requiredEnv: [],
  paid: false,

  isEnabled() {
    return true; // no key needed
  },

  async search(keyword, { since, limit = 25, meter = {}, http = {} } = {}) {
    const params = new URLSearchParams({
      query: searchQuery(keyword),
      tags: "(story,comment)",
      numericFilters: `created_at_i>${Math.floor(since.getTime() / 1000)}`,
      hitsPerPage: String(Math.min(limit, MAX_PER_REQUEST)),
      // Algolia's typo tolerance lets "prix" match "price"/"print". Tested 2026-10-21:
      // "first Grand Prix" gave 21 unrelated comments with typos on, 0 junk with them off.
      typoTolerance: "false",
    });
    meter.requests = (meter.requests ?? 0) + 1;
    const data = await safeFetch("hackernews", `${BASE}/search_by_date?${params}`, http);

    return (data.hits ?? [])
      // Skip hits with nothing to read (rare: deleted text, or a link-only story with no title).
      .filter((hit) => hit.objectID && (hit.title || hit.story_title || hit.comment_text || hit.story_text))
      .map((hit) => toPost(hit, keyword))
      .slice(0, limit);
  },

  /**
   * Thread context (free): GET /items/:id returns the whole comment tree (checked
   * 2026-10-21). Comments have no score on HN (`points` is null), and HN has no
   * "accepted answer", so `solved` only comes from the author's own words (see context.js).
   * Top-level comments come first (in HN's order), then deeper replies.
   */
  async context(post, { limit = 5, meter = {}, http = {}, appNames = [] } = {}) {
    const id = String(post.id).replace(/^hn-/, "");
    meter.requests = (meter.requests ?? 0) + 1;
    const item = await safeFetch("hackernews", `${BASE}/items/${encodeURIComponent(id)}`, http);
    const topLevel = item.children ?? [];
    let total = 0;
    const deeper = [];
    // Walk the tree to count every comment and collect replies below the top level.
    const walk = (nodes, depth) => {
      for (const node of nodes ?? []) {
        if (node.text) total++;
        if (depth > 0 && node.text) deeper.push(node);
        walk(node.children, depth + 1);
      }
    };
    walk(topLevel, 0);
    const comments = [...topLevel, ...deeper]
      .filter((c) => c.text)
      .map((c) => ({ author: c.author, text: c.text, score: null }));
    return buildContext({ commentCount: total, comments }, { post, appNames });
  },

  /** Tiny test call. HN has no key, so the only possible problems are rate limits or outages. */
  async check(env = {}, { http = {} } = {}) {
    try {
      await safeFetch("hackernews", `${BASE}/search?query=test&hitsPerPage=1`, { retries: 0, ...http });
      return "ok";
    } catch (err) {
      return err.status === 429 ? "quota" : "error";
    }
  },
};
