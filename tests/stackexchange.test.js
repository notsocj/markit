// Tests for adapters/stackexchange.js, using a fake fetch (no real network calls).
// The fake responses copy the field names seen from the live API on 2026-10-21.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import stackexchange, { _resetBackoff, MAX_SITES } from "../skills/markit-find/scripts/adapters/stackexchange.js";

const KEY = "se_key_SECRET_123";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function fakeFetch(handler) {
  const fn = async (url) => {
    const u = new URL(url);
    fn.urls.push(u);
    return handler(u, fn.urls.length);
  };
  fn.urls = [];
  return fn;
}

const question = (id, site, created, extra = {}) => ({
  question_id: id,
  title: "Best app to organize a Grand Prix trip? It&#39;s my first",
  link: `https://${site}.stackexchange.com/questions/${id}/slug`,
  body: "<p>I have tickets &amp; a hotel. What do you use?</p>",
  owner: { display_name: "Jos&#233;", user_id: 1 },
  creation_date: created,
  score: 3,
  answer_count: 1,
  view_count: 40,
  tags: ["travel"],
  ...extra,
});

const wrap = (items, extra = {}) => ({ items, has_more: false, quota_max: 300, quota_remaining: 290, ...extra });
const since = new Date("2026-10-14T00:00:00Z");
const fast = { retryDelayMs: 0 };

beforeEach(() => _resetBackoff());

test("searches each profile site with the core query, newest first, closed excluded", async () => {
  const fetchImpl = fakeFetch((u) =>
    json(wrap(u.searchParams.get("site") === "travel" ? [question(7, "travel", 1792600000)] : [question(7, "softwarerecs", 1792500000)]))
  );
  const meter = {};
  const posts = await stackexchange.search("how to organize Grand Prix trip", {
    since,
    profile: { stackexchangeSites: ["softwarerecs", "travel"] },
    meter,
    http: { fetchImpl },
  });

  assert.equal(fetchImpl.urls.length, 2);
  const p = fetchImpl.urls[0].searchParams;
  assert.equal(fetchImpl.urls[0].pathname, "/2.3/search/advanced");
  assert.equal(p.get("q"), "Grand Prix trip");
  assert.equal(p.get("sort"), "creation");
  assert.equal(p.get("order"), "desc");
  assert.equal(p.get("fromdate"), String(since.getTime() / 1000));
  assert.equal(p.get("closed"), "False");
  assert.equal(p.get("filter"), "withbody");
  assert.equal(p.get("key"), null, "no key param when no key is set");

  // Same question_id on two sites must NOT collide.
  assert.deepEqual(posts.map((x) => x.id), ["se-travel-7", "se-softwarerecs-7"]);
  assert.equal(posts[0].title, "Best app to organize a Grand Prix trip? It's my first");
  assert.equal(posts[0].excerpt, "I have tickets & a hotel. What do you use?");
  assert.equal(posts[0].author, "José");
  assert.deepEqual(posts[0].engagement, { score: 3, answers: 1, views: 40 });
  assert.equal(meter.requests, 2);
  assert.equal(meter.quotaRemaining, 290);
});

test("defaults to softwarerecs and caps the number of sites", async () => {
  const fetchImpl = fakeFetch(() => json(wrap([])));
  await stackexchange.search("x y", { since, http: { fetchImpl } });
  assert.equal(fetchImpl.urls[0].searchParams.get("site"), "softwarerecs");

  const many = fakeFetch(() => json(wrap([])));
  await stackexchange.search("x y", { since, profile: { stackexchangeSites: ["a", "b", "c", "d", "e"] }, http: { fetchImpl: many } });
  assert.equal(many.urls.length, MAX_SITES);
});

test("the optional key is sent, but never appears in errors", async () => {
  const ok = fakeFetch(() => json(wrap([])));
  await stackexchange.search("x y", { since, env: { STACKEXCHANGE_KEY: KEY }, http: { fetchImpl: ok } });
  assert.equal(ok.urls[0].searchParams.get("key"), KEY);

  const failing = fakeFetch(() => json({ error_id: 400, error_message: `bad key ${KEY}` }, 400));
  await assert.rejects(stackexchange.search("x y", { since, env: { STACKEXCHANGE_KEY: KEY }, http: { fetchImpl: failing, ...fast } }), (err) => {
    assert.equal(err.message, "stackexchange: HTTP 400");
    assert.ok(!`${err.message}${err.stack}`.includes(KEY));
    return true;
  });
});

test("one failing site doesn't lose the other site's results", async () => {
  const fetchImpl = fakeFetch((u) => (u.searchParams.get("site") === "typo" ? json({ error_id: 400 }, 400) : json(wrap([question(1, "travel", 1792600000)]))));
  const posts = await stackexchange.search("x y", { since, profile: { stackexchangeSites: ["typo", "travel"] }, http: { fetchImpl, ...fast } });
  assert.deepEqual(posts.map((x) => x.id), ["se-travel-1"]);
});

test("respects the backoff Stack Exchange asks for", async () => {
  // First reply asks for a 0.15s backoff; the second call must wait for it.
  const times = [];
  const fetchImpl = fakeFetch((u, n) => {
    times.push(Date.now());
    return json(wrap([], n === 1 ? { backoff: 0.15 } : {}));
  });
  await stackexchange.search("x y", { since, profile: { stackexchangeSites: ["a", "b"] }, http: { fetchImpl } });
  assert.ok(times[1] - times[0] >= 140, `second call came ${times[1] - times[0]}ms after the first`);
});

test("HTTP 502 (throttled): one request, no retries, no other sites, no more calls this run", async () => {
  const fetchImpl = fakeFetch(() => json({ error_id: 502, error_name: "throttle_violation" }, 502));
  const opts = { since, profile: { stackexchangeSites: ["a", "b", "c"] }, http: { fetchImpl, retryDelayMs: 0 } };
  await assert.rejects(stackexchange.search("x y", opts), { message: "stackexchange: HTTP 502" });
  await assert.rejects(stackexchange.search("z w", opts), { message: "stackexchange: HTTP 502" }, "the next keyword fails at once");
  assert.equal(fetchImpl.urls.length, 1, "only the first request was ever sent");
});

test("a 502 after some sites worked keeps their posts", async () => {
  const fetchImpl = fakeFetch((u) => (u.searchParams.get("site") === "a" ? json(wrap([question(1, "a", 1792500000)])) : json({}, 502)));
  const posts = await stackexchange.search("x y", { since, profile: { stackexchangeSites: ["a", "b", "c"] }, http: { fetchImpl, retryDelayMs: 0 } });
  assert.deepEqual(posts.map((p) => p.id), ["se-a-1"]);
  assert.equal(fetchImpl.urls.length, 2, "stopped at the first 502");
});

test("respects the limit across sites", async () => {
  const items = Array.from({ length: 10 }, (_, i) => question(i, "s", 1792500000 + i));
  const posts = await stackexchange.search("x y", { since, limit: 4, profile: { stackexchangeSites: ["s", "t"] }, http: { fetchImpl: fakeFetch(() => json(wrap(items))) } });
  assert.equal(posts.length, 4);
});

test("check(): ok, quota, invalid (with key), error", async () => {
  const check = (env, handler) => stackexchange.check(env, { http: { fetchImpl: fakeFetch(handler) } });
  assert.equal(await check({}, () => json(wrap([{ total_questions: 1 }]))), "ok");
  assert.equal(await check({}, () => json(wrap([], { quota_remaining: 0 }))), "quota");
  assert.equal(await check({}, () => json({}, 429)), "quota");
  assert.equal(await check({ STACKEXCHANGE_KEY: KEY }, () => json({}, 400)), "invalid");
  assert.equal(await check({}, () => json({}, 400)), "error", "no key set, so a 400 can't mean 'invalid key'");
  assert.equal(await check({}, () => { throw new TypeError("fetch failed"); }), "error");
});
