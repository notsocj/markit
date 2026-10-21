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

// --- Threads through SocialCrawl (profile "socialcrawlPlatforms") --------------------------
// Shapes from socialcrawl.dev/platforms/threads/search.md (checked 2026-10-22).

const threadsItem = {
  id: "3712345678901234567",
  url: "https://www.threads.com/@racefan/post/DZpPDXbCeTt",
  author: { username: "racefan" },
  content: { text: "First Grand Prix next month, how do you keep tickets and hotel stuff in one place?" },
  published_at: "2026-10-20T10:00:00Z",
  engagement: { likes: 7, comments: 3, shares: 1 },
};

test("Threads is off by default: only Reddit is searched", async () => {
  const fetchImpl = fakeFetch([json(envelope([]))]);
  await socialcrawl.search("first Grand Prix", { since, env, budget: { credits: 10 }, http: { fetchImpl }, profile: {} });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url.pathname), ["/v1/reddit/search"]);
});

test("Threads on: searches both, Threads posts get their own ids and site, credits counted", async () => {
  const fetchImpl = fakeFetch((u) => (u.pathname.endsWith("/threads/search") ? json(envelope([threadsItem], { credits_used: 2 })) : json(envelope([item]))));
  const meter = {};
  const posts = await socialcrawl.search("first Grand Prix trip advice", { since, env, meter, budget: { credits: 10 }, http: { fetchImpl }, profile: { socialcrawlPlatforms: ["reddit", "threads"] } });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url.pathname), ["/v1/reddit/search", "/v1/threads/search"]);
  const t = fetchImpl.calls[1].url.searchParams;
  assert.equal(t.get("query"), "first Grand Prix trip", "shortened like the other APIs (searchQuery)");
  assert.equal(t.get("start_date"), "2026-10-14");
  assert.equal(t.get("expand"), "true", "enough credits left to let SocialCrawl relax unknown phrases");
  assert.deepEqual(meter, { requests: 2, credits: 3 });
  const th = posts.find((p) => p.site === "Threads");
  assert.equal(th.id, "sc-th-3712345678901234567");
  assert.equal(th.title, "");
  assert.deepEqual(th.engagement, { likes: 7, replies: 3, reposts: 1 });
  assert.equal(posts.filter((p) => p.site !== "Threads").length, 1);
});

test("Threads never overspends: exact phrase only when < 5 credits left, skipped at 0", async () => {
  const fetchImpl = fakeFetch([json(envelope([])), json(envelope([], { credits_used: 1 }))]);
  await socialcrawl.search("a b", { since, env, budget: { credits: 3 }, http: { fetchImpl }, profile: { socialcrawlPlatforms: ["reddit", "threads"] } });
  assert.equal(fetchImpl.calls[1].url.searchParams.get("expand"), "false", "2 credits left after Reddit: no relaxing");

  const oneLeft = fakeFetch([json(envelope([]))]);
  await socialcrawl.search("a b", { since, env, budget: { credits: 1 }, http: { fetchImpl: oneLeft }, profile: { socialcrawlPlatforms: ["reddit", "threads"] } });
  assert.deepEqual(oneLeft.calls.map((c) => c.url.pathname), ["/v1/reddit/search"], "Reddit used the last credit, so no Threads call");

  const threadsOnly = fakeFetch([json(envelope([]))]);
  await socialcrawl.search("a b", { since, env, budget: { credits: 1 }, http: { fetchImpl: threadsOnly }, profile: { socialcrawlPlatforms: ["threads"] } });
  assert.deepEqual(threadsOnly.calls.map((c) => c.url.pathname), ["/v1/threads/search"]);
  assert.equal(threadsOnly.calls[0].url.searchParams.get("expand"), "false");
});

test("Threads context uses the Threads comments endpoint (1 credit)", async () => {
  const fetchImpl = fakeFetch([json({ success: true, credits_used: 1, data: { items: [{ comment: { author: { username: "fan2" }, content: { text: "I use Apple Wallet" }, engagement: { likes: 2 } } }] } })]);
  const meter = {};
  const ctx = await socialcrawl.context({ id: "sc-th-1", site: "Threads", url: threadsItem.url, engagement: { replies: 3 } }, { env, budget: { credits: 1 }, meter, http: { fetchImpl } });
  assert.equal(fetchImpl.calls[0].url.pathname, "/v1/threads/post/comments");
  assert.deepEqual(ctx.topComments, [{ author: "fan2", excerpt: "I use Apple Wallet", score: 2 }]);
  assert.deepEqual(meter, { requests: 1, credits: 1 });
});
