// youtube.js — searches recent YouTube videos. Free daily quota; needs a Google API key.
//
// API: YouTube Data API v3 `search.list`. Checked 2026-10-21:
//   - GET https://www.googleapis.com/youtube/v3/search
//     part=snippet, q, type=video, order=date (newest first), publishedAfter (RFC 3339),
//     maxResults (0–50), key
//   - fields: items[].id.videoId, snippet.title, snippet.description, snippet.channelTitle,
//     snippet.publishedAt. Titles are HTML-encoded ("&#39;"), so we decode them.
//   - QUOTA: since June 1, 2026, search.list has its own bucket: 1 unit per call,
//     100 calls per day by default (separate from the 10,000-unit pool for other methods).
//     It resets at midnight Pacific time. marKit makes 1 call per keyword, so a run with
//     8 keywords uses 8 of the 100.
//   - errors: invalid key → 400 (API_KEY_INVALID); quota used up → 403 (quotaExceeded);
//     API not enabled or key restricted to another API → 403.
//   - search.list can't search comments (only videos, channels, playlists), so "posts" here
//     are videos. Replying means commenting on the video.
//
// The key should be restricted to "YouTube Data API v3" in Google Cloud (least privilege).
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch } from "../lib/safe-fetch.js";
import { makePost, stripHtml, searchQuery } from "../lib/normalize.js";

const BASE = "https://www.googleapis.com/youtube/v3";

/** Convert one search result into a marKit Post. */
export function toPost(item, matchedKeyword) {
  const id = item.id?.videoId;
  return makePost({
    source: "youtube",
    platformId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: stripHtml(item.snippet?.title ?? ""),
    text: stripHtml(item.snippet?.description ?? ""),
    author: stripHtml(item.snippet?.channelTitle ?? ""),
    createdAt: item.snippet?.publishedAt,
    // search.list returns no view/comment counts (that would cost extra calls).
    engagement: {},
    matchedKeyword,
  });
}

export default {
  name: "youtube",
  label: "YouTube",
  requiredEnv: ["YOUTUBE_API_KEY"],
  paid: false,
  // /markit-usage shows "8 / 100 searches today". marKit counts days in UTC; YouTube resets
  // at midnight Pacific, so near the day boundary marKit's count is an approximation.
  quota: { unit: "requests", label: "searches", period: "day", limit: 100 },
  // check() uses a 1-unit call from the OTHER pool, so it doesn't eat search quota.
  checkUsesQuota: false,

  isEnabled(env = {}) {
    return Boolean(env.YOUTUBE_API_KEY);
  },

  async search(keyword, { since, limit = 25, env = {}, meter = {}, http = {} } = {}) {
    const params = new URLSearchParams({
      part: "snippet",
      q: searchQuery(keyword),
      type: "video",
      order: "date",
      publishedAfter: since.toISOString(),
      maxResults: String(Math.min(limit, 50)),
      key: env.YOUTUBE_API_KEY, // in the URL, as this API requires; safeFetch never logs URLs
    });
    meter.requests = (meter.requests ?? 0) + 1;
    // No retries: a 403 here usually means the daily search quota is used up, and
    // retrying would only waste time.
    const data = await safeFetch("youtube", `${BASE}/search?${params}`, { retries: 0, ...http });
    return (data.items ?? [])
      .filter((item) => item.id?.videoId)
      .map((item) => toPost(item, keyword))
      .slice(0, limit);
  },

  /**
   * Cheapest possible call (i18nLanguages.list: 1 unit from the 10,000-unit pool, not the
   * search bucket). 400 = bad key; 403 = API not enabled or key restricted to another API.
   */
  async check(env = {}, { http = {} } = {}) {
    const params = new URLSearchParams({ part: "snippet", hl: "en_US", key: env.YOUTUBE_API_KEY ?? "" });
    try {
      await safeFetch("youtube", `${BASE}/i18nLanguages?${params}`, { retries: 0, ...http });
      return "ok";
    } catch (err) {
      if (err.status === 400 || err.status === 403) return "invalid";
      if (err.status === 429) return "quota";
      return "error";
    }
  },
};
