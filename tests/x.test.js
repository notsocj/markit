// Tests for adapters/x.js (fake fetch; field names from the API docs, 2026-10-21).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import x, { _resetFieldsParam } from "../skills/markit-find/scripts/adapters/x.js";
import { fakeFetch, json, fast } from "./helpers/fake-fetch.js";

const TOKEN = "AAAA_BEARER_SECRET_123";
const env = { X_BEARER_TOKEN: TOKEN };
const recent = () => new Date(Date.now() - 2 * 86400000);

const tweet = (id) => ({ id, text: "TripIt keeps losing my race weekend bookings, alternatives?", created_at: "2026-10-20T08:00:00.000Z", public_metrics: { like_count: 4, reply_count: 2, retweet_count: 1 } });

beforeEach(() => _resetFieldsParam());

test("recent search: topic + -is:retweet, bearer header, no paid author expansion", async () => {
  const fetchImpl = fakeFetch([json({ data: [tweet("1"), tweet("2")], meta: { result_count: 2 } })]);
  const since = recent();
  const meter = {};
  const posts = await x.search("alternative to TripIt", { since, limit: 25, env, meter, budget: { posts: 30 }, http: { fetchImpl } });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.origin + url.pathname, "https://api.x.com/2/tweets/search/recent");
  assert.equal(url.searchParams.get("query"), "TripIt -is:retweet");
  assert.equal(url.searchParams.get("max_results"), "25");
  assert.equal(url.searchParams.get("start_time"), since.toISOString());
  assert.equal(url.searchParams.get("tweet.fields"), "created_at,public_metrics");
  assert.equal(url.searchParams.get("expansions"), null, "author expansion would be billed per user");
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(meter.requests, 1);
  assert.deepEqual(posts[0], {
    id: "x-1",
    source: "x",
    url: "https://x.com/i/status/1",
    title: "",
    excerpt: "TripIt keeps losing my race weekend bookings, alternatives?",
    author: "",
    createdAt: "2026-10-20T08:00:00Z",
    engagement: { likes: 4, replies: 2, reposts: 1 },
    matchedKeyword: "alternative to TripIt",
  });
});

test("never asks for more posts than the budget allows, and skips when under X's minimum of 10", async () => {
  const fetchImpl = fakeFetch([json({ data: [] })]);
  await x.search("a b", { since: recent(), limit: 25, env, budget: { posts: 12 }, http: { fetchImpl } });
  assert.equal(fetchImpl.calls[0].url.searchParams.get("max_results"), "12");

  const none = fakeFetch([json({ data: [] })]);
  const posts = await x.search("a b", { since: recent(), limit: 25, env, budget: { posts: 9 }, http: { fetchImpl: none } });
  assert.deepEqual(posts, []);
  assert.equal(none.calls.length, 0, "no paid call when fewer than 10 posts are left");
});

test("start_time is clamped to X's 7-day window", async () => {
  const fetchImpl = fakeFetch([json({ data: [] })]);
  await x.search("a b", { since: new Date(Date.now() - 30 * 86400000), env, budget: { posts: 30 }, http: { fetchImpl } });
  const start = new Date(fetchImpl.calls[0].url.searchParams.get("start_time")).getTime();
  assert.ok(Date.now() - start < 7 * 86400000);
});

test("switches to post.fields once if tweet.fields is rejected", async () => {
  const fetchImpl = fakeFetch((u) => (u.searchParams.has("tweet.fields") ? json({ title: "Invalid Request" }, 400) : json({ data: [tweet("9")] })));
  const posts = await x.search("a b", { since: recent(), env, budget: { posts: 30 }, http: { fetchImpl, ...fast } });
  assert.equal(posts[0].id, "x-9");
  await x.search("c d", { since: recent(), env, budget: { posts: 30 }, http: { fetchImpl, ...fast } });
  assert.equal(fetchImpl.calls.length, 3, "remembers post.fields for the next keyword");
});

test("errors are key-safe; check() maps 401/403 → invalid, 402/429 → quota", async () => {
  await assert.rejects(x.search("a b", { since: recent(), env, budget: { posts: 30 }, http: { fetchImpl: fakeFetch([json({ detail: TOKEN }, 401)]), ...fast } }), (err) => {
    assert.equal(err.message, "x: HTTP 401");
    assert.ok(!`${err.message}${err.stack}`.includes(TOKEN));
    return true;
  });
  const check = (status) => x.check(env, { http: { fetchImpl: fakeFetch([status === 200 ? json({ data: {} }) : json({}, status)]) } });
  assert.equal(await check(200), "ok");
  assert.equal(await check(401), "invalid");
  assert.equal(await check(403), "invalid");
  assert.equal(await check(402), "quota");
  assert.equal(await check(429), "quota");
});

test("shape: paid per post at ~$0.005", () => {
  assert.equal(x.paid, true);
  assert.equal(x.costUnit, "posts");
  assert.equal(x.costPerUnit, 0.005);
  assert.equal(x.isEnabled({}), false);
});
