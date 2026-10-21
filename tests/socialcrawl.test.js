// Tests for adapters/socialcrawl.js (fake fetch; field names from the API docs, 2026-10-21).

import { test } from "node:test";
import assert from "node:assert/strict";
import socialcrawl from "../skills/markit-find/scripts/adapters/socialcrawl.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

const KEY = "sc_SECRET_KEY_123";
const env = { SOCIALCRAWL_API_KEY: KEY };
const since = new Date("2026-10-14T00:00:00Z");

const item = {
  id: "1abcde",
  url: "https://www.reddit.com/r/formula1/comments/1abcde/first_gp/",
  author: { username: "racefan" },
  content: { text: "Going to Austin, how do you all keep tickets, hotel and the schedule straight?" },
  published_at: "2026-10-20T09:00:00Z",
  engagement: { likes: 15, comments: 9 },
  ext: { title: "First GP: how do you stay organized?", subreddit: "formula1" },
};

const envelope = (items, extra = {}) => ({ success: true, platform: "reddit", data: { items, dropped: 0 }, pagination: { has_more: false }, credits_used: 1, credits_remaining: 99, cached: false, ...extra });

test("Reddit search: quoted topic, newest, one page, x-api-key header, credits counted", async () => {
  const fetchImpl = fakeFetch([json(envelope([item, { id: "no-url" }]))]);
  const meter = {};
  const posts = await socialcrawl.search("going to my first Grand Prix", { since, env, meter, budget: { credits: 5 }, http: { fetchImpl } });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.origin + url.pathname, "https://www.socialcrawl.dev/v1/reddit/search");
  assert.equal(url.searchParams.get("query"), '"first Grand Prix"');
  assert.equal(url.searchParams.get("sort"), "new");
  assert.equal(url.searchParams.get("since"), "2026-10-14");
  assert.equal(url.searchParams.get("max_pages"), "1");
  assert.equal(init.headers["x-api-key"], KEY);
  assert.deepEqual(meter, { requests: 1, credits: 1 });

  assert.deepEqual(posts, [
    {
      id: "sc-1abcde",
      source: "socialcrawl",
      url: "https://www.reddit.com/r/formula1/comments/1abcde/first_gp/",
      title: "First GP: how do you stay organized?",
      excerpt: "Going to Austin, how do you all keep tickets, hotel and the schedule straight?",
      author: "racefan",
      createdAt: "2026-10-20T09:00:00Z",
      engagement: { score: 15, comments: 9 },
      matchedKeyword: "going to my first Grand Prix",
      site: "Reddit r/formula1",
    },
  ]);
});

test("cached results cost 0 credits; wrapped items are unwrapped", async () => {
  const meter = {};
  const posts = await socialcrawl.search("a b", { since, env, meter, http: { fetchImpl: fakeFetch([json(envelope([{ post: item }], { credits_used: 0, cached: true }))]) } });
  assert.equal(meter.credits, 0);
  assert.equal(posts[0].id, "sc-1abcde");
});

test("no call when the credit budget is spent; errors never leak the key", async () => {
  const none = fakeFetch([json(envelope([]))]);
  assert.deepEqual(await socialcrawl.search("a b", { since, env, budget: { credits: 0 }, http: { fetchImpl: none } }), []);
  assert.equal(none.calls.length, 0);

  const failing = fakeFetch([json({ success: false, error: { type: "INVALID_API_KEY", message: KEY } }, 401)]);
  await assert.rejects(socialcrawl.search("a b", { since, env, http: { fetchImpl: failing } }), (err) => {
    assert.equal(err.message, "socialcrawl: HTTP 401");
    assert.ok(!`${err.message}${err.stack}`.includes(KEY));
    return true;
  });
});

test("check() and notes() use the free balance endpoint", async () => {
  const balance = (b) => json({ success: true, data: { balance: b, recent_deductions: {} } });
  const ok = fakeFetch([balance(1234)]);
  assert.equal(await socialcrawl.check(env, { http: { fetchImpl: ok } }), "ok");
  assert.equal(ok.calls[0].url.pathname, "/v1/credits/balance");
  assert.equal(await socialcrawl.check(env, { http: { fetchImpl: fakeFetch([balance(0)]) } }), "quota");
  assert.equal(await socialcrawl.check(env, { http: { fetchImpl: fakeFetch([json({}, 401)]) } }), "invalid");
  assert.equal(await socialcrawl.check(env, { http: { fetchImpl: fakeFetch([json({}, 402)]) } }), "quota");
  assert.deepEqual(await socialcrawl.notes(env, { http: { fetchImpl: fakeFetch([balance(1234)]) } }), ["1,234 credits left"]);
});

test("shape: paid in credits", () => {
  assert.equal(socialcrawl.paid, true);
  assert.equal(socialcrawl.costUnit, "credits");
  assert.equal(socialcrawl.isEnabled({}), false);
});
