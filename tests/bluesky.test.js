// Tests for adapters/bluesky.js (fake fetch; field names from the live API, 2026-10-21).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bluesky, { _resetSession, postUrl } from "../skills/markit-find/scripts/adapters/bluesky.js";
import { fakeFetch, json, fast } from "./helpers/fake-fetch.js";

const PASSWORD = "app-pass-SECRET-1234";
const login = { BLUESKY_HANDLE: "me.bsky.social", BLUESKY_APP_PASSWORD: PASSWORD };
const since = new Date("2026-10-14T00:00:00Z");

const apiPost = {
  uri: "at://did:plc:abc123/app.bsky.feed.post/3kxyz",
  cid: "bafy",
  author: { did: "did:plc:abc123", handle: "racefan.bsky.social", displayName: "Race Fan" },
  record: { text: "Going to my first Grand Prix, how do you keep tickets & hotel together?", createdAt: "2026-10-20T10:00:00.000Z" },
  indexedAt: "2026-10-20T10:00:05.000Z",
  likeCount: 3,
  replyCount: 2,
  repostCount: 1,
  quoteCount: 0,
};

beforeEach(() => _resetSession());

test("searches the public API without logging in", async () => {
  const fetchImpl = fakeFetch([json({ posts: [apiPost, { uri: "at://x/app.bsky.feed.post/1", record: {} }] })]);
  const meter = {};
  const posts = await bluesky.search("going to my first Grand Prix", { since, limit: 10, meter, http: { fetchImpl } });

  const u = fetchImpl.calls[0].url;
  assert.equal(u.origin + u.pathname, "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts");
  assert.equal(u.searchParams.get("q"), '"first Grand Prix"', "quoted for an exact-phrase match");
  assert.equal(u.searchParams.get("sort"), "latest");
  assert.equal(u.searchParams.get("since"), since.toISOString());
  assert.equal(u.searchParams.get("limit"), "10");
  assert.equal(fetchImpl.calls[0].init.headers, undefined, "no auth header on public search");

  assert.equal(posts.length, 1, "posts without text are skipped");
  assert.deepEqual(posts[0], {
    id: "bsky-did:plc:abc123-3kxyz",
    source: "bluesky",
    url: "https://bsky.app/profile/racefan.bsky.social/post/3kxyz",
    title: "",
    excerpt: "Going to my first Grand Prix, how do you keep tickets & hotel together?",
    author: "racefan.bsky.social",
    createdAt: "2026-10-20T10:00:00Z",
    engagement: { likes: 3, replies: 2, reposts: 1 },
    matchedKeyword: "going to my first Grand Prix",
  });
  assert.equal(meter.requests, 1);
});

test("if public search is refused and a login is set, logs in ONCE and searches via the PDS", async () => {
  const fetchImpl = fakeFetch((u) => {
    if (u.hostname === "api.bsky.app") return json({ error: "AuthMissing" }, 403);
    if (u.pathname.endsWith("createSession")) return json({ accessJwt: "jwt-1", refreshJwt: "r", did: "did:plc:me", handle: "me.bsky.social" });
    return json({ posts: [apiPost] });
  });
  const meter = {};
  await bluesky.search("first Grand Prix", { since, env: login, meter, http: { fetchImpl, ...fast } });
  await bluesky.search("race weekend tips", { since, env: login, meter, http: { fetchImpl, ...fast } });

  const logins = fetchImpl.calls.filter((c) => c.url.pathname.endsWith("createSession"));
  assert.equal(logins.length, 1, "the session is reused within a run");
  assert.deepEqual(JSON.parse(logins[0].init.body), { identifier: "me.bsky.social", password: PASSWORD });
  const pdsSearch = fetchImpl.calls.find((c) => c.url.hostname === "bsky.social" && c.url.pathname.endsWith("searchPosts"));
  assert.equal(pdsSearch.init.headers.authorization, "Bearer jwt-1");
});

test("without a login, a refused public search is an error (no login attempt)", async () => {
  const fetchImpl = fakeFetch([json({}, 403)]);
  await assert.rejects(bluesky.search("a b", { since, http: { fetchImpl, ...fast } }), { message: "bluesky: HTTP 403" });
  assert.equal(fetchImpl.calls.length, 1);
});

test("a wrong app password never shows up in errors", async () => {
  const fetchImpl = fakeFetch((u) => (u.hostname === "api.bsky.app" ? json({}, 401) : json({ error: "AuthenticationRequired", message: PASSWORD }, 401)));
  await assert.rejects(bluesky.search("a b", { since, env: login, http: { fetchImpl, ...fast } }), (err) => {
    assert.equal(err.message, "bluesky: HTTP 401");
    assert.ok(!`${err.message}${err.stack}`.includes(PASSWORD));
    return true;
  });
});

test("postUrl builds the bsky.app link from the post URI", () => {
  assert.equal(postUrl("at://did:plc:x/app.bsky.feed.post/abc", "a.bsky.social"), "https://bsky.app/profile/a.bsky.social/post/abc");
});

test("check(): public ok; with a login, a bad password is 'invalid'", async () => {
  assert.equal(await bluesky.check({}, { http: { fetchImpl: fakeFetch([json({ posts: [] })]) } }), "ok");
  assert.equal(await bluesky.check({}, { http: { fetchImpl: fakeFetch([json({}, 429)]) } }), "quota");
  assert.equal(await bluesky.check({}, { http: { fetchImpl: fakeFetch([new TypeError("fetch failed")]) } }), "error");
  const badLogin = fakeFetch((u) => (u.pathname.endsWith("createSession") ? json({ error: "AuthenticationRequired" }, 401) : json({ posts: [] })));
  assert.equal(await bluesky.check(login, { http: { fetchImpl: badLogin } }), "invalid");
  const goodLogin = fakeFetch((u) => (u.pathname.endsWith("createSession") ? json({ accessJwt: "j" }) : json({ posts: [] })));
  assert.equal(await bluesky.check(login, { http: { fetchImpl: goodLogin } }), "ok");
});

test("shape: free, enabled without any key", () => {
  assert.equal(bluesky.paid, false);
  assert.equal(bluesky.isEnabled({}), true);
});
