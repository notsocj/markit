// reddit.js — what all Reddit providers share: the provider choice and one Post shape.
//
// marKit can read Reddit through three paid services ("providers"): ScrapeCreators, Apify,
// and SocialCrawl. The user picks ONE in settings.json:
//
//   "reddit": { "provider": "scrapecreators" }      // or "apify", "socialcrawl", "none"
//
// Only that provider searches Reddit, so the same search is never paid for twice.
//
// Every provider turns its results into the SAME kind of Post:
//   - source "reddit" (not the provider's name), plus provider: "scrapecreators" etc.
//   - id "reddit-<post id>", where the post id is Reddit's own short id ("1abcde"), taken
//     from the post's link when possible. So if you switch providers, a post you already
//     saw (seen.json) or marked Replied/Skipped (feedback.json) is recognized as the same post.

import { makePost } from "./normalize.js";

// The providers marKit supports, in the order /markit-setup explains them.
export const REDDIT_PROVIDERS = ["scrapecreators", "apify", "socialcrawl"];

export const PROVIDER_LABELS = {
  scrapecreators: "ScrapeCreators",
  apify: "Apify",
  socialcrawl: "SocialCrawl",
};

/**
 * The provider chosen in settings.json, or "none".
 * Anything unexpected (a typo, an old settings file without "reddit") counts as "none",
 * because guessing could bill an account the user didn't choose.
 */
export function redditProvider(settings = {}) {
  const chosen = String(settings.reddit?.provider ?? "none").trim().toLowerCase();
  return REDDIT_PROVIDERS.includes(chosen) ? chosen : "none";
}

/** "Reddit (via ScrapeCreators)" — how reports, the terminal, and the dashboard name it. */
export function redditLabel(provider) {
  const name = PROVIDER_LABELS[provider];
  return name ? `Reddit (via ${name})` : "Reddit";
}

/**
 * Reddit's own short id for a post, the same whichever provider found it.
 *
 * The link is the most reliable place: every Reddit post URL contains
 * "/comments/<id>/" (e.g. https://www.reddit.com/r/formula1/comments/1abcde/first_gp/).
 * Otherwise we use the id the provider gave us, without Reddit's "t3_" type prefix
 * ("t3_1abcde" → "1abcde"). Returns "" if neither looks like a Reddit id.
 */
export function redditPostId(id, url) {
  const fromUrl = /\/comments\/([a-z0-9]{2,12})(?:[/?#]|$)/i.exec(String(url ?? ""));
  if (fromUrl) return fromUrl[1].toLowerCase();
  const plain = String(id ?? "").trim().replace(/^t3_/i, "").toLowerCase();
  // Reddit ids are short base-36 strings (letters and digits only).
  return /^[a-z0-9]{2,12}$/.test(plain) ? plain : "";
}

/**
 * Turn a link that may be relative ("/r/x/comments/1abc/…") into a full reddit.com URL.
 * Non-Reddit or malformed links come back as "" so a card never points somewhere odd.
 */
export function redditUrl(link) {
  const value = String(link ?? "").trim();
  if (!value) return "";
  try {
    const u = new URL(value, "https://www.reddit.com");
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    if (host !== "reddit.com" && !host.endsWith(".reddit.com") && host !== "redd.it") return "";
    return u.href;
  } catch {
    return "";
  }
}

/**
 * Build a Reddit Post in the shared shape. Each provider adapter reads its own field names
 * and passes plain values here, so the result looks identical whoever found the post.
 * Throws (via makePost) when there is no usable id; adapters skip such items.
 */
export function makeRedditPost({ provider, id, url, title, text, author, createdAt, score, comments, subreddit, matchedKeyword }) {
  const link = redditUrl(url);
  const postId = redditPostId(id, link);
  const sub = String(subreddit ?? "").trim().replace(/^\/?r\//i, "");
  const post = makePost({
    source: "reddit",
    platformId: postId,
    url: link,
    title,
    text,
    // Reddit shows deleted accounts as "[deleted]"; keep that, but drop a "u/" prefix.
    author: String(author ?? "").replace(/^\/?u\//i, ""),
    createdAt,
    engagement: { score: Number(score) || 0, comments: Number(comments) || 0 },
    matchedKeyword,
    site: sub ? `Reddit r/${sub}` : "Reddit",
  });
  post.provider = provider;
  return post;
}
