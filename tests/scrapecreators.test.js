// Tests for adapters/scrapecreators.js (fake fetch; field names from docs.scrapecreators.com
// and its openapi.json, checked 2026-10-22). Nothing touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import scrapecreators, { timeframeFor, flattenComments } from "../skills/markit-find/scripts/adapters/scrapecreators.js";
import { fakeFetch, json, fast } from "./helpers/fake-fetch.js";

const KEY = "sc-SECRET-KEY-scrapecreators-123";
const env = { SCRAPECREATORS_API_KEY: KEY };
const NOW = new Date("2026-10-21T13:00:00Z");
const since = new Date("2026-10-14T13:00:00Z");

// One search result, shaped like the docs' example (Reddit's own field names).
const redditPost = {
  id: "1flgwup",
  name: "t3_1flgwup",
  title: "Best app to plan a race weekend?",
  selftext: "Don&#039;t want 5 apps for tickets, hotel and the schedule",
  author: "racefan",
  subreddit: "formula1",
  permalink: "/r/formula1/comments/1flgwup/best_app_to_plan_a_race_weekend/",
  url: "https://www.reddit.com/r/formula1/comments/1flgwup/best_app_to_plan_a_race_weekend/",
  created_utc: 1792486800, // seconds: 2026-10-20T09:00:00Z
  score: 12,
  num_comments: 4,
};

test("search: quoted topic, newest first, lookback timeframe, key only in the x-api-key header", async () => {
  const fetchImpl = fakeFetch([json({ success: true, credits_remaining: 99, credits_charged: 1, posts: [redditPost, { id: "" }], after: "t3_x" })]);
  const meter = {};
  const posts = await scrapecreators.search("best app for planning F1 race weekend", { since, now: NOW, env, meter, budget: { credits: 5 }, http: { fetchImpl } });

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.origin + url.pathname, "https://api.scrapecreators.com/v1/reddit/search");
  assert.equal(url.searchParams.get("query"), '"F1 race weekend"');
  assert.equal(url.searchParams.get("sort"), "new");
  assert.equal(url.searchParams.get("timeframe"), "week");
  assert.equal(url.searchParams.get("trim"), null, "never trimmed: trimmed results have no post body");
  assert.equal(init.headers["x-api-key"], KEY);
  assert.ok(!url.href.includes(KEY), "the key is never in the URL");
  assert.deepEqual(meter, { requests: 1, credits: 1 });

  assert.deepEqual(posts, [
    {
      id: "reddit-1flgwup",
      source: "reddit",
      url: "https://www.reddit.com/r/formula1/comments/1flgwup/best_app_to_plan_a_race_weekend/",
      title: "Best app to plan a race weekend?",
      excerpt: "Don't want 5 apps for tickets, hotel and the schedule",
      author: "racefan",
      createdAt: "2026-10-20T09:00:00Z",
      engagement: { score: 12, comments: 4 },
      matchedKeyword: "best app for planning F1 race weekend",
      site: "Reddit r/formula1",
      provider: "scrapecreators",
    },
  ]);
});

test("records what the API says it charged; no call when no credit is left", async () => {
  const meter = {};
  await scrapecreators.search("a b", { since, now: NOW, env, meter, http: { fetchImpl: fakeFetch([json({ success: true, credits_charged: 0, posts: [] })]) } });
  assert.equal(meter.credits, 0);

  const none = fakeFetch([json({ success: true, posts: [] })]);
  assert.deepEqual(await scrapecreators.search("a b", { since, now: NOW, env, budget: { credits: 0 }, http: { fetchImpl: none } }), []);
  assert.equal(none.calls.length, 0);
});

test("timeframe covers the lookback window", () => {
  const ago = (days) => new Date(NOW.getTime() - days * 86400000);
  assert.equal(timeframeFor(ago(1), NOW), "day");
  assert.equal(timeframeFor(ago(7), NOW), "week");
  assert.equal(timeframeFor(ago(14), NOW), "month");
  assert.equal(timeframeFor(ago(60), NOW), "year");
});

test("errors say only the status, never the key (HTTP errors and 200 + success:false)", async () => {
  const failing = fakeFetch([json({ success: false, message: KEY }, 401)]);
  await assert.rejects(scrapecreators.search("a b", { since, now: NOW, env, http: { fetchImpl: failing } }), (err) => {
    assert.equal(err.message, "scrapecreators: HTTP 401");
    assert.ok(!`${err.message}${err.stack}`.includes(KEY));
    return true;
  });
  const soft = fakeFetch([json({ success: false, error: "forbidden", errorStatus: 403, message: `bad ${KEY}` })]);
  await assert.rejects(scrapecreators.search("a b", { since, now: NOW, env, http: { fetchImpl: soft, ...fast } }), (err) => {
    assert.equal(err.message, "scrapecreators: HTTP 403");
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test("check(): valid, invalid, out of credits; notes() shows the balance without another call", async () => {
  const ok = fakeFetch([json({ success: true, credits_remaining: 91, credits_charged: 1, creditCount: 91 })]);
  assert.equal(await scrapecreators.check(env, { http: { fetchImpl: ok } }), "ok");
  assert.equal(ok.calls[0].url.pathname, "/v1/account/credit-balance");
  assert.equal(ok.calls[0].init.headers["x-api-key"], KEY);
  assert.deepEqual(await scrapecreators.notes(env), ["91 credits left (never expire)"]);
  assert.equal(ok.calls.length, 1, "notes() reused the balance");

  assert.equal(await scrapecreators.check(env, { http: { fetchImpl: fakeFetch([json({}, 401)]) } }), "invalid");
  assert.deepEqual(await scrapecreators.notes(env), [], "no stale balance after a failed check");
  assert.equal(await scrapecreators.check(env, { http: { fetchImpl: fakeFetch([json({}, 402)]) } }), "quota");
  assert.equal(await scrapecreators.check(env, { http: { fetchImpl: fakeFetch([json({ success: true, creditCount: 0 })]) } }), "quota");
  assert.equal(await scrapecreators.check(env, { http: { fetchImpl: fakeFetch([json({}, 500)]) } }), "error");
});

test("context(): 1 credit, nested replies flattened, deleted comments dropped", async () => {
  const fetchImpl = fakeFetch([
    json({
      success: true,
      credits_charged: 1,
      post: { id: "1flgwup", num_comments: 7 },
      comments: [
        { author: "a1", body: "I use TripIt for this", score: 5, replies: { items: [{ author: "a2", body: "Same here", score: 2, replies: { items: [] } }], more: { has_more: false, next_cursor: null } } },
        { author: "[deleted]", body: "[deleted]", score: 0 },
      ],
      more: { has_more: false },
    }),
  ]);
  const meter = {};
  const post = { id: "reddit-1flgwup", source: "reddit", provider: "scrapecreators", url: redditPost.url, author: "racefan", engagement: { comments: 4 } };
  const ctx = await scrapecreators.context(post, { env, meter, budget: { credits: 1 }, http: { fetchImpl } });
  assert.equal(fetchImpl.calls[0].url.pathname, "/v1/reddit/post/comments");
  assert.equal(fetchImpl.calls[0].url.searchParams.get("url"), redditPost.url);
  assert.equal(ctx.commentCount, 7);
  assert.deepEqual(ctx.topComments.map((c) => c.author), ["a1", "a2"]);
  assert.equal(ctx.appsAlreadySuggested, 1);
  assert.deepEqual(meter, { requests: 1, credits: 1 });

  const none = fakeFetch([json({})]);
  assert.equal(await scrapecreators.context(post, { env, budget: { credits: 0 }, http: { fetchImpl: none } }), null);
  assert.equal(none.calls.length, 0, "no budget, no call");
});

test("flattenComments keeps Reddit's order and stops at the limit", () => {
  const tree = [{ author: "a", body: "1", replies: { items: [{ author: "b", body: "1.1" }] } }, { author: "c", body: "2" }];
  assert.deepEqual(flattenComments(tree).map((c) => c.text), ["1", "1.1", "2"]);
  assert.equal(flattenComments(tree, 2).length, 2);
});

test("shape: paid in credits, a Reddit provider whose key check costs a credit", () => {
  assert.equal(scrapecreators.paid, true);
  assert.equal(scrapecreators.costUnit, "credits");
  assert.equal(scrapecreators.redditProvider, true);
  assert.deepEqual(scrapecreators.checkCost, { credits: 1 });
  assert.equal(scrapecreators.isEnabled({}), false);
  assert.equal(scrapecreators.isEnabled(env), true);
});
