// bluesky.js — searches public Bluesky posts. Free; usually no key needed.
//
// API: AT Protocol `app.bsky.feed.searchPosts`. Checked 2026-10-21:
//   - https://api.bsky.app answers searchPosts WITHOUT logging in (HTTP 200, real posts).
//     (public.api.bsky.app, the cached host the docs suggest for public reads, returned 403
//     for search, so we don't use it.)
//   - params: q, sort=latest, since (inclusive datetime), limit (1–100), cursor
//   - post fields: uri, author.handle, record.text, record.createdAt, indexedAt,
//     likeCount, replyCount, repostCount, quoteCount
//   - The docs warn search "may require authentication" on some servers. So if the public
//     call is refused (401/403) AND the user set BLUESKY_HANDLE + BLUESKY_APP_PASSWORD, we
//     log in (com.atproto.server.createSession on bsky.social) and search through their
//     server instead.
//   - Logging in is strictly rate-limited (documented 30 per 5 min / 300 per day per
//     account; a FAILED login showed 10 per day). So we log in at most once per run, keep
//     the session in memory only (never on disk), and never log in unless we must.
//
// Use an APP PASSWORD (Settings → Privacy and security → App passwords), never the main one.
//
// See hackernews.js for the shared adapter shape and search() options.

import { safeFetch } from "../lib/safe-fetch.js";
import { makePost, searchQuery } from "../lib/normalize.js";
import { buildContext } from "../lib/context.js";

const PUBLIC_API = "https://api.bsky.app/xrpc";
const PDS = "https://bsky.social/xrpc"; // the user's server, for logged-in requests

const hasLogin = (env) => Boolean(env?.BLUESKY_HANDLE && env?.BLUESKY_APP_PASSWORD);

// The logged-in session for this run: { handle, accessJwt }. In memory only.
let session = null;

/** Forget the cached session (tests only). */
export function _resetSession() {
  session = null;
}

/** Log in with the app password, once per run. Returns the access token. */
async function login(env, { meter, http }) {
  if (session?.handle === env.BLUESKY_HANDLE) return session.accessJwt;
  meter.requests = (meter.requests ?? 0) + 1;
  const data = await safeFetch("bluesky", `${PDS}/com.atproto.server.createSession`, {
    ...http,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }),
    // A failed login won't succeed on retry, and retries burn the strict login limit.
    retries: 0,
  });
  session = { handle: env.BLUESKY_HANDLE, accessJwt: data.accessJwt };
  return session.accessJwt;
}

/**
 * Turn "at://did:plc:abc/app.bsky.feed.post/3kxyz" into its web page:
 * "https://bsky.app/profile/<handle>/post/3kxyz" (the last part of the URI is the post key).
 */
export function postUrl(uri, handle) {
  const rkey = String(uri).split("/").pop();
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

/** Convert one search result into a marKit Post. */
export function toPost(p, matchedKeyword) {
  // The post key alone isn't unique across accounts, so the id includes the author's DID.
  const [, , did, , rkey] = String(p.uri).split("/");
  return makePost({
    source: "bluesky",
    platformId: `${did}-${rkey}`,
    url: postUrl(p.uri, p.author?.handle ?? did),
    title: "", // Bluesky posts have no titles
    text: p.record?.text ?? "",
    author: p.author?.handle ?? "",
    createdAt: p.record?.createdAt ?? p.indexedAt,
    engagement: { likes: p.likeCount ?? 0, replies: p.replyCount ?? 0, reposts: p.repostCount ?? 0 },
    matchedKeyword,
    lang: p.record?.langs, // e.g. ["en"], set by the author's app (used by the language filter)
  });
}

export default {
  name: "bluesky",
  label: "Bluesky",
  requiredEnv: [], // BLUESKY_HANDLE + BLUESKY_APP_PASSWORD are an optional fallback
  paid: false,
  // check() doesn't count against anything shown in /markit-usage.
  checkUsesQuota: false,

  isEnabled() {
    return true; // public search works without a login
  },

  async search(keyword, { since, limit = 25, env = {}, meter = {}, http = {} } = {}) {
    const params = new URLSearchParams({
      // Quoted = exact phrase. Unquoted, Bluesky matches the words anywhere: tested
      // 2026-10-21, "Grand Prix trip" returned a gaming stream ("Road Trip Adventure");
      // quoted it returned nothing unrelated. Fewer but far more relevant posts.
      q: `"${searchQuery(keyword).replace(/"/g, "")}"`,
      sort: "latest",
      since: since.toISOString(),
      limit: String(Math.min(limit, 100)),
    });

    let data;
    try {
      meter.requests = (meter.requests ?? 0) + 1;
      data = await safeFetch("bluesky", `${PUBLIC_API}/app.bsky.feed.searchPosts?${params}`, http);
    } catch (err) {
      // Public search refused: fall back to a logged-in search, if the user set one up.
      if (!(err.status === 401 || err.status === 403) || !hasLogin(env)) throw err;
      const token = await login(env, { meter, http });
      meter.requests++;
      data = await safeFetch("bluesky", `${PDS}/app.bsky.feed.searchPosts?${params}`, {
        ...http,
        headers: { authorization: `Bearer ${token}` },
      });
    }

    return (data.posts ?? [])
      .filter((p) => p.uri && p.record?.text)
      .map((p) => toPost(p, keyword))
      .slice(0, limit);
  },

  /**
   * Thread context (free): app.bsky.feed.getPostThread on the public API with depth=1
   * returns the post and its direct replies (checked 2026-10-22, no login needed). We
   * rebuild the post's at:// address from our id ("bsky-<did>-<post key>").
   * Replies are ranked by likes. `locked` is only known when the API says replies are
   * disabled for the viewer, which it doesn't say without a login, so it's usually false.
   */
  async context(post, { meter = {}, http = {}, appNames = [] } = {}) {
    const match = String(post.id).match(/^bsky-(.+)-([^-]+)$/);
    if (!match) return null;
    const uri = `at://${match[1]}/app.bsky.feed.post/${match[2]}`;
    meter.requests = (meter.requests ?? 0) + 1;
    const params = new URLSearchParams({ uri, depth: "1", parentHeight: "0" });
    const data = await safeFetch("bluesky", `${PUBLIC_API}/app.bsky.feed.getPostThread?${params}`, http);
    const thread = data.thread ?? {};
    const replies = (thread.replies ?? [])
      .filter((r) => r?.post?.record?.text)
      .sort((a, b) => (b.post.likeCount ?? 0) - (a.post.likeCount ?? 0));
    return buildContext(
      {
        commentCount: thread.post?.replyCount ?? replies.length,
        locked: Boolean(thread.post?.viewer?.replyDisabled),
        comments: replies.map((r) => ({ author: r.post.author?.handle, text: r.post.record.text, score: r.post.likeCount ?? 0 })),
      },
      { post, appNames }
    );
  },

  /**
   * "ok" if public search answers. If a login is set up, it's checked too (one login),
   * so a wrong app password shows as "invalid" instead of failing silently later.
   */
  async check(env = {}, { http = {} } = {}) {
    try {
      await safeFetch("bluesky", `${PUBLIC_API}/app.bsky.feed.searchPosts?q=test&limit=1`, { retries: 0, ...http });
    } catch (err) {
      if (err.status === 429) return "quota";
      if (!((err.status === 401 || err.status === 403) && hasLogin(env))) return "error";
      // Public search refused; the login is what matters now, so check it below.
    }
    if (!hasLogin(env)) return "ok";
    try {
      _resetSession(); // always really test the credentials
      await login(env, { meter: {}, http });
      return "ok";
    } catch (err) {
      if (err.status === 429) return "quota";
      return err.status === 400 || err.status === 401 ? "invalid" : "error";
    }
  },
};
