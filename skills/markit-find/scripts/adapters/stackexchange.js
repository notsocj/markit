// stackexchange.js — searches Stack Exchange questions. Free; an optional key raises the quota.
//
// API: Stack Exchange API 2.3, endpoint /search/advanced. Checked 2026-10-21 against the
// live API:
//   - params used: q, site, sort=creation, order=desc, fromdate (unix seconds), closed,
//     pagesize, filter=withbody (adds the question body), key (optional)
//   - every response is wrapped: { items, has_more, quota_max, quota_remaining, backoff? }
//   - question fields: question_id, title, link, body, owner.display_name, creation_date,
//     score, answer_count, view_count, tags
//   - titles, bodies, and names are HTML-encoded ("&#39;"), so we decode them
// Quota: 300 requests/day per IP without a key, 10,000/day with a free key from
// stackapps.com. If a response includes `backoff: N`, we MUST wait N seconds before calling
// the same method again, or Stack Exchange may block the IP.
//
// Sites come from the app profile's `stackexchangeSites` (default ["softwarerecs"], the site
// made for "recommend me software" questions). Question ids are only unique within one site,
// so post ids include the site: "se-softwarerecs-12345".
//
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch, SourceError } from "../lib/safe-fetch.js";
import { makePost, stripHtml, searchQuery } from "../lib/normalize.js";
import { buildContext } from "../lib/context.js";

const BASE = "https://api.stackexchange.com/2.3";
// Each site costs one request per keyword. Capping sites keeps a run well inside the
// 300/day free quota (8 keywords × 3 sites = 24 requests).
export const MAX_SITES = 3;

// When Stack Exchange asks us to back off, this holds the time we may call again.
// It lives at module level so it applies across keywords within the same run.
let waitUntil = 0;
// Set when Stack Exchange answers HTTP 502 ("throttle_violation": too many requests). It asks
// clients to stop, so the rest of this run makes no more calls instead of piling on.
let throttled = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reset the backoff timer (tests only). */
export function _resetBackoff() {
  waitUntil = 0;
  throttled = false;
}

/** Make one API call, honoring any backoff, and remember the next backoff if given. */
async function call(path, params, { env, meter, http }) {
  if (throttled) throw new SourceError("stackexchange", "HTTP 502", 502);
  const delay = waitUntil - Date.now();
  if (delay > 0) await sleep(delay);

  // The key goes in the URL (that's how this API works). safeFetch never logs or
  // returns URLs, so it can't leak from here.
  if (env?.STACKEXCHANGE_KEY) params.set("key", env.STACKEXCHANGE_KEY);
  meter.requests = (meter.requests ?? 0) + 1;
  let data;
  try {
    // 502 is never retried: retrying while throttled only makes the throttling worse.
    data = await safeFetch("stackexchange", `${BASE}${path}?${params}`, { noRetryStatuses: [502], ...http });
  } catch (err) {
    if (err.status === 502) throttled = true;
    throw err;
  }

  if (data.backoff) waitUntil = Date.now() + data.backoff * 1000;
  // Remember the platform's own quota count; it's just a number, safe to show.
  if (typeof data.quota_remaining === "number") meter.quotaRemaining = data.quota_remaining;
  return data;
}

/** Convert one question into a marKit Post. */
export function toPost(q, site, matchedKeyword) {
  return makePost({
    source: "stackexchange",
    platformId: `${site}-${q.question_id}`,
    url: q.link,
    title: stripHtml(q.title),
    text: stripHtml(q.body),
    author: stripHtml(q.owner?.display_name ?? ""),
    createdAt: q.creation_date,
    engagement: { score: q.score ?? 0, answers: q.answer_count ?? 0, views: q.view_count ?? 0 },
    matchedKeyword,
  });
}

export default {
  name: "stackexchange",
  label: "Stack Exchange",
  requiredEnv: [], // STACKEXCHANGE_KEY is optional
  paid: false,
  // Shown by /markit-usage as "142 / 300 requests today" (marKit's own count).
  // "day" quotas reset at midnight UTC, matching usage.json's UTC day keys.
  quota: { unit: "requests", period: "day", limit: 300, limitWithKey: 10000, keyEnv: "STACKEXCHANGE_KEY" },

  isEnabled() {
    return true; // works without a key, just with a smaller daily quota
  },

  async search(keyword, { since, limit = 25, env = {}, profile = {}, meter = {}, http = {} } = {}) {
    const sites = (profile.stackexchangeSites?.length ? profile.stackexchangeSites : ["softwarerecs"]).slice(0, MAX_SITES);
    const posts = [];
    let firstError = null;
    let failures = 0;

    // One site at a time (not in parallel), so a backoff request is respected.
    for (const site of sites) {
      const params = new URLSearchParams({
        q: searchQuery(keyword),
        site,
        sort: "creation",
        order: "desc",
        fromdate: String(Math.floor(since.getTime() / 1000)),
        // Closed questions can't get new answers, so there's nothing to reply to.
        closed: "False",
        pagesize: String(Math.min(limit, 100)),
        filter: "withbody",
      });
      try {
        const data = await call("/search/advanced", params, { env, meter, http });
        for (const q of data.items ?? []) posts.push(toPost(q, site, keyword));
      } catch (err) {
        // One bad site name (HTTP 400) shouldn't throw away results from the others.
        failures++;
        firstError ??= err;
        if (err.status === 502) break; // throttled: don't try the other sites
      }
    }
    // Report the error when nothing came back (and keep partial results when something did).
    if (firstError && !posts.length && (failures === sites.length || firstError.status === 502)) throw firstError;

    // Newest first across all sites, then cap.
    return posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  },

  /**
   * Thread context (free, 2 requests of the daily quota): the question (answer_count, and
   * accepted_answer_id / closed_date / locked_date, which the API only includes when they
   * apply; checked 2026-10-22) plus its top answers by votes. Answers stand in for
   * "comments". A closed or locked question can't get new answers, so it counts as locked.
   */
  async context(post, { limit = 5, env = {}, meter = {}, http = {}, appNames = [] } = {}) {
    // Our ids look like "se-<site>-<question id>", e.g. "se-travel-93387".
    const match = String(post.id).match(/^se-(.+)-(\d+)$/);
    if (!match) return null;
    const [, site, questionId] = match;
    const question = (await call(`/questions/${questionId}`, new URLSearchParams({ site }), { env, meter, http })).items?.[0];
    if (!question) return null;
    const answers = (await call(`/questions/${questionId}/answers`, new URLSearchParams({ site, sort: "votes", order: "desc", pagesize: String(Math.max(limit, 10)), filter: "withbody" }), { env, meter, http })).items ?? [];
    return buildContext(
      {
        commentCount: question.answer_count ?? answers.length,
        solved: Boolean(question.accepted_answer_id) || answers.some((a) => a.is_accepted),
        locked: Boolean(question.closed_date || question.locked_date),
        comments: answers.map((a) => ({ author: stripHtml(a.owner?.display_name ?? ""), text: a.body, score: a.score })),
      },
      { post, appNames }
    );
  },

  /**
   * Tiny test call (costs 1 request of quota).
   *   "ok"      the API answered (and the key, if set, was accepted)
   *   "invalid" a key is set and Stack Exchange rejected the request
   *   "quota"   today's quota is used up, or we're being throttled
   *   "error"   network problem or outage
   */
  async check(env = {}, { http = {} } = {}) {
    const meter = {};
    try {
      const data = await call("/info", new URLSearchParams({ site: "softwarerecs" }), { env, meter, http: { retries: 0, ...http } });
      return data.quota_remaining === 0 ? "quota" : "ok";
    } catch (err) {
      if (err.status === 429 || err.status === 502 || err.status === 503) return "quota";
      // Stack Exchange answers a bad key with HTTP 400/401/403.
      if (env.STACKEXCHANGE_KEY && [400, 401, 403].includes(err.status)) return "invalid";
      return "error";
    }
  },
};
