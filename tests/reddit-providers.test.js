// Tests for Reddit providers working together (lib/reddit.js + search.js + candidates.js):
// the provider choice, cross-provider dedupe, caps, and key safety. The REAL adapters run
// against a fake fetch, so nothing touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSearch } from "../skills/markit-find/scripts/search.js";
import { paidContextBudget, contextAdapterFor } from "../skills/markit-find/scripts/candidates.js";
import { DEFAULT_SETTINGS } from "../skills/markit-find/scripts/lib/config.js";
import { recordUsage } from "../skills/markit-find/scripts/lib/usage.js";
import { redditProvider, redditPostId, redditUrl, redditLabel } from "../skills/markit-find/scripts/lib/reddit.js";
import { sourceLabel } from "../skills/markit-find/scripts/lib/render-report.js";
import { ADAPTERS } from "../skills/markit-find/scripts/adapters/index.js";
import scrapecreators, { toPost as scToPost } from "../skills/markit-find/scripts/adapters/scrapecreators.js";
import apify, { toPost as apifyToPost } from "../skills/markit-find/scripts/adapters/apify.js";
import socialcrawl, { toPost as socialToPost } from "../skills/markit-find/scripts/adapters/socialcrawl.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

const NOW = new Date("2026-10-21T13:00:00Z");
const KEYS = { SCRAPECREATORS_API_KEY: "SC_SECRET_scrapecreators_1", APIFY_API_TOKEN: "APIFY_SECRET_token_2", SOCIALCRAWL_API_KEY: "sc_SECRET_socialcrawl_3" };
const URL_1 = "https://www.reddit.com/r/formula1/comments/1abcde/first_gp/";

const profile = (extra = {}) => ({ name: "gridpeek", keywords: ["going to my first Grand Prix", "alternative to TripIt"], competitors: [], exclude: [], sources: ["reddit"], ...extra });
const settings = (provider, extra = {}) => ({ ...DEFAULT_SETTINGS, reportsDir: "/unused", reddit: { provider }, ...extra });

// One fake fetch that answers like each provider's API, and records every call.
function providerFetch({ status = 200 } = {}) {
  return fakeFetch((url, init) => {
    if (status !== 200) return json({ error: { message: JSON.stringify(init.headers) } }, status);
    if (url.hostname === "api.scrapecreators.com") {
      return json({ success: true, credits_charged: 1, posts: [{ id: "1abcde", title: "First GP?", selftext: "How do you plan it?", author: "racefan", subreddit: "formula1", permalink: "/r/formula1/comments/1abcde/first_gp/", created_utc: Date.UTC(2026, 9, 20) / 1000, score: 3, num_comments: 2 }] });
    }
    if (url.hostname === "api.apify.com") {
      const input = JSON.parse(init.body);
      return json(input.searchTerms.map((term) => ({ dataType: "post", parsedId: "1abcde", title: "First GP?", body: "How do you plan it?", authorName: "racefan", parsedCommunityName: "formula1", postUrl: URL_1, createdAt: "2026-10-20T00:00:00Z", upVotes: 3, commentsCount: 2, searchTerm: term })), 201);
    }
    if (url.hostname === "www.socialcrawl.dev") {
      const threads = url.pathname.includes("/threads/");
      const items = threads
        ? [{ id: "999", url: "https://www.threads.com/@a/post/X", content: { text: "Threads post" }, published_at: "2026-10-20T00:00:00Z", engagement: {} }]
        : [{ id: "1abcde", url: URL_1, author: { username: "racefan" }, content: { text: "How do you plan it?" }, published_at: "2026-10-20T00:00:00Z", engagement: { likes: 3, comments: 2 }, ext: { title: "First GP?", subreddit: "formula1" } }];
      return json({ success: true, credits_used: 1, data: { items } });
    }
    throw new Error("unexpected host");
  });
}

const hosts = (fetchImpl) => [...new Set(fetchImpl.calls.map((c) => c.url.hostname))];

// --- provider choice -------------------------------------------------------------------

test("only the chosen provider searches Reddit; the source is named after it", async () => {
  for (const [provider, host] of [["scrapecreators", "api.scrapecreators.com"], ["apify", "api.apify.com"], ["socialcrawl", "www.socialcrawl.dev"]]) {
    const fetchImpl = providerFetch();
    const { raw, meters } = await runSearch({ profile: profile(), settings: settings(provider), env: KEYS, now: NOW, http: { fetchImpl } });
    assert.deepEqual(hosts(fetchImpl), [host], `${provider} only`);
    assert.equal(raw.sources[0].name, "reddit");
    assert.equal(raw.sources[0].provider, provider);
    assert.equal(raw.sources[0].label, redditLabel(provider));
    assert.equal(raw.posts[0].id, "reddit-1abcde");
    assert.equal(raw.posts[0].provider, provider);
    // Spending is counted against the provider's own account (its caps).
    assert.deepEqual(meters.map((m) => m.name), [provider]);
  }
});

test('provider "none" (the default) searches nothing and says why', async () => {
  const fetchImpl = providerFetch();
  const { raw, meters } = await runSearch({ profile: profile(), settings: { ...DEFAULT_SETTINGS }, env: KEYS, now: NOW, http: { fetchImpl } });
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(meters, []);
  assert.equal(raw.sources[0].status, "skipped");
  assert.match(raw.sources[0].reason, /no Reddit provider chosen/);
  // Unknown values count as "none" too: never guess which account to bill.
  assert.equal(redditProvider({ reddit: { provider: "pushshift" } }), "none");
  assert.equal(redditProvider({}), "none");
  assert.equal(redditProvider({ reddit: { provider: " Apify " } }), "apify");
});

test("a chosen provider without a key is skipped, not swapped for another one", async () => {
  const fetchImpl = providerFetch();
  const { raw } = await runSearch({ profile: profile(), settings: settings("apify"), env: { SCRAPECREATORS_API_KEY: "k" }, now: NOW, http: { fetchImpl } });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(raw.sources[0].status, "skipped");
  assert.equal(raw.sources[0].reason, "no Apify key");
});

test("the socialcrawl source is Threads only, so Reddit is never searched twice", async () => {
  const fetchImpl = providerFetch();
  const { raw } = await runSearch({ profile: profile({ sources: ["reddit", "socialcrawl"] }), settings: settings("scrapecreators"), env: KEYS, now: NOW, http: { fetchImpl } });
  const paths = fetchImpl.calls.map((c) => c.url.hostname + c.url.pathname);
  assert.ok(paths.every((p) => !p.startsWith("www.socialcrawl.dev/v1/reddit")), paths.join("\n"));
  assert.ok(paths.some((p) => p === "www.socialcrawl.dev/v1/threads/search"));
  assert.deepEqual(raw.sources.map((s) => s.label), ["Reddit (via ScrapeCreators)", "Threads (via SocialCrawl)"]);
});

// --- dedupe across providers -----------------------------------------------------------

test("the same Reddit post gets the same id from every provider", () => {
  const fromSc = scToPost({ id: "1abcde", name: "t3_1abcde", title: "T", permalink: "/r/formula1/comments/1abcde/first_gp/", created_utc: 1 }, "k");
  const fromApify = apifyToPost({ dataType: "post", id: "t3_1abcde", parsedId: "1abcde", title: "T", postUrl: URL_1 }, "k");
  const fromSocial = socialToPost({ id: "1abcde", url: URL_1, ext: { title: "T" } }, "k");
  assert.deepEqual([fromSc.id, fromApify.id, fromSocial.id], ["reddit-1abcde", "reddit-1abcde", "reddit-1abcde"]);
  assert.deepEqual([fromSc.url, fromApify.url, fromSocial.url], [URL_1, URL_1, URL_1]);
  // The link wins over whatever id a provider sends; "t3_" prefixes are removed.
  assert.equal(redditPostId("t3_ZZZ999", URL_1), "1abcde");
  assert.equal(redditPostId("t3_1AbCdE", ""), "1abcde");
  assert.equal(redditPostId("not a reddit id!", "https://example.com/x"), "");
  assert.equal(redditUrl("https://evil.example/r/x/comments/1abcde/"), "", "only reddit.com links");
});

test("a post seen through one provider isn't reported again through another", async () => {
  const fetchImpl = providerFetch();
  // Last week SocialCrawl found reddit-1abcde; today ScrapeCreators finds the same post.
  const { raw } = await runSearch({ profile: profile(), settings: settings("scrapecreators"), env: KEYS, now: NOW, seen: new Set(["reddit-1abcde"]), http: { fetchImpl } });
  assert.equal(raw.posts.length, 0);
  assert.equal(raw.sources[0].removed.seen, 1);
});

test("within one run, a post found by several keywords becomes one card", async () => {
  const fetchImpl = providerFetch();
  const { raw } = await runSearch({ profile: profile(), settings: settings("apify"), env: KEYS, now: NOW, http: { fetchImpl } });
  assert.equal(fetchImpl.calls.length, 1, "one Apify run for both keywords");
  assert.deepEqual(raw.posts.map((p) => p.id), ["reddit-1abcde"]);
  assert.equal(raw.sources[0].fetched, 1);
});

test("labels name the provider: 'Reddit r/formula1 (via Apify)'", () => {
  assert.equal(sourceLabel({ source: "reddit", provider: "apify", site: "Reddit r/formula1" }), "Reddit r/formula1 (via Apify)");
  assert.equal(sourceLabel({ source: "reddit", provider: "scrapecreators" }), "Reddit (via ScrapeCreators)");
  assert.equal(sourceLabel({ source: "socialcrawl", site: "Threads" }), "Threads", "Threads via SocialCrawl stays Threads");
});

// --- caps ------------------------------------------------------------------------------

test("ScrapeCreators: stops at the per-run credit cap, and a spent monthly cap skips it", async () => {
  const fetchImpl = providerFetch();
  const capped = settings("scrapecreators", { scrapecreators: { maxCreditsPerRun: 1, maxCreditsPerMonth: 1000 } });
  const { raw, meters } = await runSearch({ profile: profile(), settings: capped, env: KEYS, now: NOW, http: { fetchImpl } });
  assert.equal(fetchImpl.calls.length, 1, "1 credit per run: one keyword only");
  assert.match(raw.sources[0].reason, /stopped at per-run cap \(1 credits\)/);
  assert.equal(meters[0].meter.credits, 1);

  const usage = { months: { "2026-10": { scrapecreators: { requests: 1000, posts: 0, credits: 1000 } } }, days: {} };
  const none = providerFetch();
  const skipped = await runSearch({ profile: profile(), settings: settings("scrapecreators"), env: KEYS, now: NOW, usage, http: { fetchImpl: none } });
  assert.equal(none.calls.length, 0);
  assert.match(skipped.raw.sources[0].reason, /monthly cap reached \(1000 \/ 1000 credits\)/);
});

test("Apify: per-run results cap and the monthly estimated-cost cap", async () => {
  const fetchImpl = providerFetch();
  const small = settings("apify", { apify: { ...DEFAULT_SETTINGS.apify, maxResultsPerRun: 4 } });
  await runSearch({ profile: profile(), settings: small, env: KEYS, now: NOW, http: { fetchImpl } });
  const input = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(input.maxPostsCount * input.searchTerms.length, 4, "4 results shared by 2 keywords");
  // $0.02 run fee + 4 × $0.002 = $0.028 → capped at $0.03
  assert.equal(fetchImpl.calls[0].url.searchParams.get("maxTotalChargeUsd"), "0.03");

  // $4.48 of $4.50 already used: what's left can't pay a run fee plus one result.
  const usage = { months: { "2026-10": { apify: { requests: 40, results: 2000, usd: 4.48 } } }, days: {} };
  const none = providerFetch();
  const { raw } = await runSearch({ profile: profile(), settings: settings("apify"), env: KEYS, now: NOW, usage, http: { fetchImpl: none } });
  assert.equal(none.calls.length, 0);
  assert.match(raw.sources[0].reason, /monthly cost cap reached \(~\$4\.48 \/ \$4\.50/);
});

test("SocialCrawl as Reddit provider AND the Threads source share ONE credit budget", async () => {
  const fetchImpl = providerFetch();
  // 3 credits per run: Reddit uses 2 (two keywords), Threads gets the 1 left.
  const tight = settings("socialcrawl", { socialcrawl: { maxCreditsPerRun: 3, maxCreditsPerMonth: 1500 } });
  const { raw, meters } = await runSearch({ profile: profile({ sources: ["reddit", "socialcrawl"] }), settings: tight, env: KEYS, now: NOW, http: { fetchImpl } });
  const total = meters.filter((m) => m.name === "socialcrawl").reduce((sum, m) => sum + m.meter.credits, 0);
  assert.equal(total, 3, "never more than the per-run cap across both jobs");
  assert.equal(raw.sources.find((s) => s.name === "socialcrawl").reason, "stopped at per-run cap (3 credits)");
});

test("thread context: Reddit posts use their provider, and its cap covers search + context", () => {
  assert.equal(contextAdapterFor({ source: "reddit", provider: "apify" }, ADAPTERS), apify);
  assert.equal(contextAdapterFor({ source: "reddit", provider: "scrapecreators" }, ADAPTERS), scrapecreators);
  assert.equal(contextAdapterFor({ source: "socialcrawl" }, ADAPTERS), socialcrawl);

  // SocialCrawl spent 2 on Reddit and 1 on Threads in this run: 50 − 3 = 47 left for context.
  const raw = { sources: [{ name: "reddit", provider: "socialcrawl", used: { credits: 2 } }, { name: "socialcrawl", used: { credits: 1 } }] };
  const b = paidContextBudget(socialcrawl, { settings: settings("socialcrawl"), usage: { months: {}, days: {} }, raw, meter: { credits: 0 }, now: NOW });
  assert.deepEqual(b, { unit: "credits", remaining: 47 });

  // Apify: results left this run, plus the dollars left this month.
  const rawA = { sources: [{ name: "reddit", provider: "apify", used: { results: 20, usd: 0.06 } }] };
  const usage = { months: { "2026-10": { apify: { results: 20, usd: 0.06 } } }, days: {} };
  const a = paidContextBudget(apify, { settings: settings("apify"), usage, raw: rawA, meter: { results: 0, usd: 0 }, now: NOW });
  assert.equal(a.remaining, 30);
  assert.ok(Math.abs(a.usd - 4.44) < 1e-9);
});

// --- key safety ------------------------------------------------------------------------

test("keys only ever go in headers: never in URLs, raw.json, usage.json, or errors", async () => {
  for (const provider of ["scrapecreators", "apify", "socialcrawl"]) {
    const fetchImpl = providerFetch();
    const { raw, meters } = await runSearch({ profile: profile(), settings: settings(provider), env: KEYS, now: NOW, http: { fetchImpl } });
    const usageFile = join(mkdtempSync(join(tmpdir(), "markit-reddit-")), "usage.json");
    for (const { name, meter } of meters) recordUsage(name, meter, usageFile, NOW);
    const written = JSON.stringify(raw) + readFileSync(usageFile, "utf8");
    for (const key of Object.values(KEYS)) {
      assert.ok(!written.includes(key), `${provider}: key in raw.json or usage.json`);
      assert.ok(fetchImpl.calls.every((c) => !c.url.href.includes(key)), `${provider}: key in a URL`);
    }
    const sent = JSON.stringify(fetchImpl.calls[0].init.headers);
    assert.ok(Object.values(KEYS).some((key) => sent.includes(key)), `${provider}: key sent in a header`);

    // The API's error body even echoes the headers back; the reason must still be key-free.
    const failing = providerFetch({ status: 401 });
    const bad = await runSearch({ profile: profile(), settings: settings(provider), env: KEYS, now: NOW, http: { fetchImpl: failing, retryDelayMs: 0 } });
    assert.equal(bad.raw.sources[0].status, "error");
    assert.equal(bad.raw.sources[0].reason, "HTTP 401");
    for (const key of Object.values(KEYS)) assert.ok(!JSON.stringify(bad.raw).includes(key));
  }
});
