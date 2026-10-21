// Tests for adapters/apify.js (fake fetch; API fields from docs.apify.com, actor fields from
// the harshmaur~reddit-scraper Store page and build, checked 2026-10-22). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import apify, { estimateUsd, actorPath } from "../skills/markit-find/scripts/adapters/apify.js";
import { DEFAULT_SETTINGS } from "../skills/markit-find/scripts/lib/config.js";
import { fakeFetch, json, fast } from "./helpers/fake-fetch.js";

const TOKEN = "apify_api_SECRET_TOKEN_123";
const env = { APIFY_API_TOKEN: TOKEN };
const NOW = new Date("2026-10-21T13:00:00Z");
const since = new Date("2026-10-14T13:00:00Z");
const settings = { ...DEFAULT_SETTINGS };

// Two results, shaped like the actor's output (dataType, parsedId, authorName, ...).
const item = (id, term, extra = {}) => ({
  dataType: "post",
  id: `t3_${id}`,
  parsedId: id,
  title: `Any app for race weekends? ${id}`,
  body: "Tickets, hotel, schedule: all over the place",
  authorName: "racefan",
  communityName: "r/formula1",
  parsedCommunityName: "formula1",
  upVotes: 9,
  commentsCount: 3,
  postUrl: `https://www.reddit.com/r/formula1/comments/${id}/any_app/`,
  createdAt: "2026-10-20T09:00:00.000Z",
  searchTerm: term,
  ...extra,
});

test("one actor run for ALL keywords: token in the header, never the URL; charge capped", async () => {
  const fetchImpl = fakeFetch([json([item("1aaaaa", '"F1 race weekend"'), item("1bbbbb", '"TripIt"'), { dataType: "community", title: "r/formula1" }], 201)]);
  const meter = {};
  const posts = await apify.searchAll(["best app for planning F1 race weekend", "alternative to TripIt"], {
    since, now: NOW, env, settings, meter, limit: 25, budget: { results: 50, usd: 4.5 }, http: { fetchImpl },
  });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.origin + url.pathname, "https://api.apify.com/v2/actors/harshmaur~reddit-scraper/run-sync-get-dataset-items");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!url.href.includes(TOKEN), "the token is never in the URL");
  assert.equal(url.searchParams.get("token"), null);
  assert.equal(url.searchParams.get("timeout"), "240", "under the endpoint's 300 s limit");
  // 2 terms × 25 results = 50 results: $0.02 run fee + 50 × $2 / 1000 = $0.12
  assert.equal(url.searchParams.get("maxTotalChargeUsd"), "0.12");

  const input = JSON.parse(init.body);
  assert.deepEqual(input.searchTerms, ['"F1 race weekend"', '"TripIt"']);
  assert.equal(input.searchSort, "new");
  assert.equal(input.postedAfter, "7 days");
  assert.equal(input.maxPostsCount, 25);
  assert.equal(input.crawlCommentsPerPost, false);

  assert.deepEqual(posts.map((p) => [p.id, p.source, p.provider, p.matchedKeyword, p.site]), [
    ["reddit-1aaaaa", "reddit", "apify", "best app for planning F1 race weekend", "Reddit r/formula1"],
    ["reddit-1bbbbb", "reddit", "apify", "alternative to TripIt", "Reddit r/formula1"],
  ]);
  // Every returned item is billed, even ones that aren't posts.
  assert.equal(meter.results, 3);
  assert.equal(meter.requests, 1);
  assert.ok(Math.abs(meter.usd - (0.02 + 3 * 0.002)) < 1e-9);
});

test("shares the results left across keywords, and shrinks to what the money left can pay for", async () => {
  const fetchImpl = fakeFetch(() => json([], 201));
  // 9 results left for 3 keywords → 3 each.
  await apify.searchAll(["k one a", "k two b", "k three c"], { since, now: NOW, env, settings, budget: { results: 9, usd: 4.5 }, http: { fetchImpl } });
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).maxPostsCount, 3);
  // Only $0.03 left: after the $0.02 run fee that pays for 5 results → 5 keywords' worth at most.
  await apify.searchAll(["k one a", "k two b"], { since, now: NOW, env, settings, budget: { results: 50, usd: 0.03 }, http: { fetchImpl } });
  const input = JSON.parse(fetchImpl.calls[1].init.body);
  assert.ok(input.maxPostsCount * input.searchTerms.length <= 5, JSON.stringify(input));
  assert.equal(fetchImpl.calls[1].url.searchParams.get("maxTotalChargeUsd"), "0.03");
  // Not even one result affordable → no run at all.
  const none = fakeFetch(() => json([], 201));
  assert.deepEqual(await apify.searchAll(["k one a"], { since, now: NOW, env, settings, budget: { results: 50, usd: 0.02 }, http: { fetchImpl: none } }), []);
  assert.equal(none.calls.length, 0);
});

test("a failed run is never retried; a timeout counts the whole charge cap as spent", async () => {
  const timeout = fakeFetch([json({ error: { type: "run-timeout-exceeded", message: `t ${TOKEN}` } }, 408)]);
  const meter = {};
  await assert.rejects(apify.searchAll(["k one a"], { since, now: NOW, env, settings, meter, budget: { results: 10, usd: 4.5 }, http: { fetchImpl: timeout, ...fast } }), (err) => {
    assert.equal(err.message, "apify: HTTP 408");
    assert.ok(!`${err.message}${err.stack}`.includes(TOKEN));
    return true;
  });
  assert.equal(timeout.calls.length, 1, "no retry: a retry would be a second bill");
  assert.equal(meter.usd, 0.04, "$0.02 fee + 10 × $0.002, counted as spent to stay safe");

  // 401/402: the run never started, so nothing is counted.
  const meter2 = {};
  await assert.rejects(apify.searchAll(["k one a"], { since, now: NOW, env, settings, meter: meter2, budget: { results: 10, usd: 4.5 }, http: { fetchImpl: fakeFetch([json({}, 402)]) } }));
  assert.equal(meter2.usd ?? 0, 0);
});

test("budget(): per-run results, and the monthly cap is the estimated dollar cost", () => {
  const usage = (usd) => ({ months: { "2026-10": { apify: { requests: 1, results: 100, usd } } }, days: {} });
  assert.deepEqual(apify.budget(settings, usage(0), NOW), { unit: "results", remaining: 50, usd: 4.5, limitedBy: "per-run cap (50 results)" });
  // $4.40 used: $0.10 left → after the $0.02 fee, 40 results.
  const near = apify.budget(settings, usage(4.4), NOW);
  assert.equal(near.remaining, 40);
  assert.match(near.limitedBy, /monthly cost cap/);
  const spent = apify.budget(settings, usage(4.5), NOW);
  assert.equal(spent.remaining, 0);
  assert.match(spent.reason, /monthly cost cap reached \(~\$4\.50 \/ \$4\.50, marKit's estimate\)/);
  assert.equal(apify.budget({ apify: { pricePerThousandResults: 0 } }, usage(0), NOW).remaining, 0, "no price → don't spend");
});

test("estimate and actor id", () => {
  assert.equal(estimateUsd(0, settings), 0.02);
  assert.ok(Math.abs(estimateUsd(1000, settings) - 2.02) < 1e-9);
  assert.equal(actorPath({ apify: { redditActor: "someone~other-actor" } }), "someone~other-actor");
  for (const bad of ["../users/me", "a/b", "x~y?token=1", ""]) {
    assert.throws(() => actorPath({ apify: { redditActor: bad } }), /must look like/);
  }
});

test("check(): free account-limits call; valid, invalid, usage limit reached", async () => {
  const ok = fakeFetch([json({ data: { current: { monthlyUsageUsd: 1.25 }, limits: { maxMonthlyUsageUsd: 5 } } })]);
  assert.equal(await apify.check(env, { http: { fetchImpl: ok } }), "ok");
  assert.equal(ok.calls[0].url.pathname, "/v2/users/me/limits");
  assert.equal(ok.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!ok.calls[0].url.href.includes(TOKEN));
  assert.deepEqual(await apify.notes(env), ["Apify says $1.25 of $5.00 used this billing cycle"]);

  assert.equal(await apify.check(env, { http: { fetchImpl: fakeFetch([json({ data: { current: { monthlyUsageUsd: 5 }, limits: { maxMonthlyUsageUsd: 5 } } })]) } }), "quota");
  assert.equal(await apify.check(env, { http: { fetchImpl: fakeFetch([json({}, 401)]) } }), "invalid");
  assert.deepEqual(await apify.notes(env), []);
  assert.equal(await apify.check(env, { http: { fetchImpl: fakeFetch([json({}, 402)]) } }), "quota");
  assert.equal(await apify.check(env, { http: { fetchImpl: fakeFetch([json({}, 500)]) } }), "error");
});

test("context(): comments for one post, within the budget, deleted ones dropped", async () => {
  const fetchImpl = fakeFetch([
    json([
      item("1aaaaa", undefined, { commentsCount: 6 }),
      { dataType: "comment", authorName: "fan2", body: "I use TripIt", commentUpVotes: 4 },
      { dataType: "comment", authorName: "[deleted]", body: "[deleted]" },
    ], 201),
  ]);
  const meter = {};
  const post = { id: "reddit-1aaaaa", source: "reddit", provider: "apify", url: "https://www.reddit.com/r/formula1/comments/1aaaaa/any_app/", engagement: { comments: 3 } };
  const ctx = await apify.context(post, { env, settings, meter, budget: { results: 20, usd: 1 }, http: { fetchImpl } });
  const input = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(input.startUrls, [{ url: post.url }]);
  assert.equal(input.crawlCommentsPerPost, true);
  assert.equal(input.maxCommentsPerPost, 10);
  assert.equal(ctx.commentCount, 6);
  assert.deepEqual(ctx.topComments, [{ author: "fan2", excerpt: "I use TripIt", score: 4 }]);
  assert.equal(meter.results, 3);

  const none = fakeFetch([json([], 201)]);
  assert.equal(await apify.context(post, { env, settings, budget: { results: 1, usd: 1 }, http: { fetchImpl: none } }), null, "the post itself would use the last result");
  assert.equal(none.calls.length, 0);
});

test("shape: paid per result, a Reddit provider whose key check is free", () => {
  assert.equal(apify.paid, true);
  assert.equal(apify.costUnit, "results");
  assert.equal(apify.redditProvider, true);
  assert.equal(apify.checkUsesQuota, false);
  assert.equal(apify.isEnabled({}), false);
  assert.equal(apify.isEnabled(env), true);
  assert.deepEqual(apify.caps(settings), { perRun: 50, monthly: 4.5, monthlyUnit: "usd" });
});
