// Tests for adapters/hackernews.js, using a fake fetch (no real network calls).
// The fake responses copy the field names seen from the live API on 2026-10-21.

import { test } from "node:test";
import assert from "node:assert/strict";
import hackernews from "../skills/markit-find/scripts/adapters/hackernews.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// A fake fetch that records requested URLs and replies with the given responses in order.
function fakeFetch(...responses) {
  const fn = async (url) => {
    fn.urls.push(new URL(url));
    const r = responses[Math.min(fn.urls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.urls = [];
  return fn;
}

const story = {
  objectID: "50100001",
  _tags: ["story", "author_alice", "story_50100001", "ask_hn"],
  title: "Ask HN: How do you plan a Grand Prix trip?",
  url: null,
  story_text: "<p>Going to my first Grand Prix &amp; I&#x27;m lost.</p>",
  author: "alice",
  created_at_i: 1792500000,
  points: 12,
  num_comments: 4,
};
const comment = {
  objectID: "50100002",
  _tags: ["comment", "author_bob", "story_50100001"],
  story_title: "Ask HN: How do you plan a Grand Prix trip?",
  comment_text: "I use TripIt but it&#x27;s clunky for race weekends.",
  author: "bob",
  created_at_i: 1792500600,
  story_id: 50100001,
  parent_id: 50100001,
  children: [50100003],
};
const empty = { objectID: "50100009", _tags: ["story"], title: null, story_text: null, author: "x", created_at_i: 1792500000 };

const since = new Date("2026-10-14T00:00:00Z");
const fast = { retryDelayMs: 0 };

test("builds the search_by_date request with core query, tags, and lookback filter", async () => {
  const fetchImpl = fakeFetch(json({ hits: [] }));
  await hackernews.search("app for planning F1 race weekend", { since, limit: 10, http: { fetchImpl } });
  const url = fetchImpl.urls[0];
  assert.equal(url.origin + url.pathname, "https://hn.algolia.com/api/v1/search_by_date");
  assert.equal(url.searchParams.get("query"), "F1 race weekend");
  assert.equal(url.searchParams.get("tags"), "(story,comment)");
  assert.equal(url.searchParams.get("numericFilters"), `created_at_i>${since.getTime() / 1000}`);
  assert.equal(url.searchParams.get("hitsPerPage"), "10");
  assert.equal(url.searchParams.get("typoTolerance"), "false");
});

test("maps stories and comments to Posts, linking to the HN discussion", async () => {
  const fetchImpl = fakeFetch(json({ hits: [story, comment, empty] }));
  const meter = {};
  const posts = await hackernews.search("going to my first Grand Prix", { since, meter, http: { fetchImpl } });

  assert.equal(posts.length, 2, "the hit with no text is skipped");
  assert.deepEqual(posts[0], {
    id: "hn-50100001",
    source: "hackernews",
    url: "https://news.ycombinator.com/item?id=50100001",
    title: "Ask HN: How do you plan a Grand Prix trip?",
    excerpt: "Going to my first Grand Prix & I'm lost.",
    author: "alice",
    createdAt: "2026-10-20T12:40:00Z",
    engagement: { score: 12, comments: 4 },
    matchedKeyword: "going to my first Grand Prix",
  });
  assert.equal(posts[1].id, "hn-50100002");
  assert.equal(posts[1].title, "Re: Ask HN: How do you plan a Grand Prix trip?");
  assert.equal(posts[1].excerpt, "I use TripIt but it's clunky for race weekends.");
  assert.deepEqual(posts[1].engagement, { replies: 1 });
  assert.equal(meter.requests, 1, "one API call is counted");
});

test("respects the limit", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...story, objectID: String(i) }));
  const posts = await hackernews.search("first Grand Prix", { since, limit: 5, http: { fetchImpl: fakeFetch(json({ hits: many })) } });
  assert.equal(posts.length, 5);
});

test("errors are key-safe '<source>: HTTP <status>'", async () => {
  await assert.rejects(
    hackernews.search("first Grand Prix", { since, http: { fetchImpl: fakeFetch(json({}, 500)), ...fast } }),
    (err) => err.message === "hackernews: HTTP 500" && !err.message.includes("algolia")
  );
});

test("check(): ok, quota, error", async () => {
  assert.equal(await hackernews.check({}, { http: { fetchImpl: fakeFetch(json({ hits: [] })) } }), "ok");
  assert.equal(await hackernews.check({}, { http: { fetchImpl: fakeFetch(json({}, 429)) } }), "quota");
  assert.equal(await hackernews.check({}, { http: { fetchImpl: fakeFetch(new TypeError("fetch failed")) } }), "error");
});

test("adapter shape matches the shared interface", () => {
  assert.equal(hackernews.name, "hackernews");
  assert.deepEqual(hackernews.requiredEnv, []);
  assert.equal(hackernews.paid, false);
  assert.equal(hackernews.isEnabled({}), true);
});
