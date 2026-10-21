// Tests for markit-usage/scripts/usage.js (the /markit-usage screen), with fake adapters
// so nothing touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runChecks, buildScreen, redditLine } from "../skills/markit-usage/scripts/usage.js";
import { DEFAULT_SETTINGS } from "../skills/markit-find/scripts/lib/config.js";
import apify from "../skills/markit-find/scripts/adapters/apify.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

const NOW = new Date("2026-10-21T13:00:00Z");
const SECRET = "SUPER_SECRET_KEY_VALUE_123";

// A fake adapter with a fixed check() answer. `env` decides whether it's enabled.
function fake(name, { enabledBy, result = "ok", paid = false, ...extra } = {}) {
  const adapter = {
    name,
    paid,
    requiredEnv: enabledBy ? [enabledBy] : [],
    isEnabled: (env) => !enabledBy || Boolean(env[enabledBy]),
    checkedWith: null,
    async check(env, opts) {
      adapter.checkedWith = opts;
      if (result instanceof Error) throw result;
      return result;
    },
    ...extra,
  };
  return adapter;
}

const usage = {
  months: { "2026-10": { x: { requests: 7, posts: 760, credits: 0 }, socialcrawl: { requests: 3, posts: 0, credits: 12 } } },
  days: {
    "2026-10-21": { stackexchange: { requests: 142, posts: 0, credits: 0 }, threads: { requests: 20, posts: 0, credits: 0 } },
    "2026-10-18": { threads: { requests: 18, posts: 0, credits: 0 } },
    "2026-10-10": { threads: { requests: 99, posts: 0, credits: 0 } }, // outside the 7-day window
  },
  lastRun: { app: "gridpeek", ranAt: "2026-10-21T13:00:00Z", opportunities: 12 },
};

const adapters = () => [
  fake("hackernews"),
  fake("stackexchange", { quota: { unit: "requests", period: "day", limit: 300, limitWithKey: 10000, keyEnv: "STACKEXCHANGE_KEY" } }),
  fake("youtube", { enabledBy: "YOUTUBE_API_KEY", result: "invalid" }),
  fake("threads", {
    enabledBy: "THREADS_ACCESS_TOKEN",
    quota: { unit: "requests", period: "rolling7", limit: 500 },
    notes: async () => ["token expires in 12 days"],
  }),
  fake("x", { enabledBy: "X_BEARER_TOKEN", paid: true, costUnit: "posts", costPerUnit: 0.005 }),
  fake("socialcrawl", { enabledBy: "SOCIALCRAWL_API_KEY", paid: true, costUnit: "credits", result: "quota" }),
  // bluesky deliberately missing: "not available yet"
];

const env = { YOUTUBE_API_KEY: SECRET, THREADS_ACCESS_TOKEN: SECRET, X_BEARER_TOKEN: SECRET, SOCIALCRAWL_API_KEY: SECRET };

test("runChecks checks only enabled sources, with a short timeout, and survives a throwing check", async () => {
  const list = [fake("hackernews"), fake("youtube", { enabledBy: "YOUTUBE_API_KEY" }), fake("threads", { result: new Error(SECRET) })];
  const checks = await runChecks(list, {});
  assert.deepEqual(checks, { hackernews: "ok", threads: "error" });
  assert.equal(list[0].checkedWith.http.timeoutMs, 8000);
  assert.equal(list[0].checkedWith.http.retries, 0);
});

test("full screen matches the spec format", async () => {
  const list = adapters();
  const checks = await runChecks(list, env);
  const text = await buildScreen({ adapters: list, env, checks, settings: DEFAULT_SETTINGS, usage, apps: ["gridpeek", "keepr"], now: NOW });
  const lines = text.split("\n");

  assert.equal(lines[0], "marKit · October 2026");
  assert.equal(lines[2], "Sources");
  for (const row of [
    "  ✓ Hacker News       free",
    "  ✓ Stack Exchange    free      142 / 300 requests today",
    "  – Bluesky           not available yet",
    "  ✗ YouTube           invalid key → run /markit-setup",
    "  ✓ Threads           free      38 / 500 requests (rolling 7 days) · token expires in 12 days",
    "  ✓ X                 paid      760 / 900 posts this month · ~$3.80 · near cap",
    "  ✗ SocialCrawl       quota used up (check your plan or spending limit)",
  ]) {
    assert.ok(lines.includes(row), `missing row:\n${row}\n---\n${text}`);
  }
  assert.ok(text.includes("marKit's own count"));
  assert.ok(lines.includes("Apps: gridpeek, keepr"));
  assert.ok(/^Last run: gridpeek · Oct 21, \d{1,2}:00 (AM|PM) · 12 opportunities$/m.test(text));
  assert.ok(text.includes("  /markit-dashboard   work through them in your browser"));
  assert.ok(text.endsWith("  /markit-usage       this screen"));
});

test("the key raises Stack Exchange's shown limit", async () => {
  const list = [fake("stackexchange", { quota: { unit: "requests", period: "day", limit: 300, limitWithKey: 10000, keyEnv: "STACKEXCHANGE_KEY" } })];
  const withKey = { STACKEXCHANGE_KEY: SECRET };
  const text = await buildScreen({ adapters: list, env: withKey, checks: await runChecks(list, withKey), settings: DEFAULT_SETTINGS, usage, now: NOW });
  assert.match(text, /142 \/ 10,000 requests today/);
});

test("--check-only shows just the ✓ / ✗ table", async () => {
  const list = adapters();
  const text = await buildScreen({ adapters: list, env, checks: await runChecks(list, env), settings: DEFAULT_SETTINGS, usage, now: NOW, full: false });
  const lines = text.split("\n");
  assert.equal(lines[0], "Sources");
  // 6 sources + 3 Reddit providers (ScrapeCreators, Apify, SocialCrawl), then the Reddit line.
  assert.equal(lines.filter((l) => /^  [✓✗–] /.test(l)).length, 9);
  assert.equal(lines.at(-1), "Reddit: no provider chosen, so only web search covers it → run /markit-setup to pick one");
  assert.ok(lines.includes("  ✓ Stack Exchange    free"), "no usage numbers in check-only mode");
  assert.ok(!text.includes("Apps:") && !text.includes("Commands"));
});

test("Reddit providers: one row each, the chosen provider, and Apify's dollar estimate", async () => {
  const usageNow = { months: { "2026-10": { apify: { requests: 3, posts: 30, credits: 0, results: 120, usd: 3.9 }, scrapecreators: { requests: 9, posts: 40, credits: 9 } } }, days: {}, lastRun: null };
  // The real Apify adapter's check() and notes(), with Apify's usage endpoint faked.
  const limits = fakeFetch([json({ data: { current: { monthlyUsageUsd: 1.25 }, limits: { maxMonthlyUsageUsd: 5 } } })]);
  const realApify = { ...apify, check: (e) => apify.check(e, { http: { fetchImpl: limits } }) };
  const list = [
    fake("scrapecreators", { enabledBy: "SCRAPECREATORS_API_KEY", paid: true, costUnit: "credits", notes: async () => ["91 credits left (never expire)"] }),
    realApify,
    fake("socialcrawl", { enabledBy: "SOCIALCRAWL_API_KEY", paid: true, costUnit: "credits" }),
  ];
  const keys = { SCRAPECREATORS_API_KEY: SECRET, APIFY_API_TOKEN: SECRET };
  const settings = { ...DEFAULT_SETTINGS, reddit: { provider: "apify" } };
  const text = await buildScreen({ adapters: list, env: keys, checks: await runChecks(list, keys), settings, usage: usageNow, now: NOW });
  const lines = text.split("\n");
  for (const row of [
    "  ✓ ScrapeCreators    paid      9 / 1000 credits this month · 91 credits left (never expire)",
    "  ✓ Apify             paid      120 results · ~$3.90 / $4.50 this month (marKit's estimate) · near cap · Apify says $1.25 of $5.00 used this billing cycle",
    "  – SocialCrawl       not set up",
  ]) {
    assert.ok(lines.includes(row), `missing row:\n${row}\n---\n${text}`);
  }
  assert.ok(lines.includes("Reddit: via Apify"));
  assert.ok(!text.includes(SECRET));
  assert.equal(limits.calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.ok(!limits.calls[0].url.href.includes(SECRET), "the token is never in the URL");

  // The Reddit line flags a chosen provider without a key.
  assert.equal(redditLine({ reddit: { provider: "scrapecreators" } }, {}, list), "Reddit: via ScrapeCreators (no ScrapeCreators key yet → run /markit-setup)");
});

test("unreachable and not-set-up sources", async () => {
  const list = [fake("hackernews", { result: "error" }), fake("youtube", { enabledBy: "YOUTUBE_API_KEY" })];
  const text = await buildScreen({ adapters: list, env: {}, checks: await runChecks(list, {}), settings: DEFAULT_SETTINGS, usage: { months: {}, days: {}, lastRun: null }, now: NOW });
  assert.ok(text.includes("  ✗ Hacker News       unreachable"));
  assert.ok(text.includes("  – YouTube           not set up"));
  assert.ok(text.includes("Apps: none yet → run /markit-setup"));
  assert.ok(text.includes("Last run: none yet"));
});

test("the screen never contains key values", async () => {
  const list = adapters();
  const text = await buildScreen({ adapters: list, env, checks: await runChecks(list, env), settings: DEFAULT_SETTINGS, usage, now: NOW });
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes(SECRET.slice(0, 6)), "not even part of a key");
});

const USAGE = fileURLToPath(new URL("../skills/markit-usage/scripts/usage.js", import.meta.url));

test("CLI: not set up yet → friendly message and the command guide", () => {
  const r = spawnSync(process.execPath, [USAGE], { encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: join(mkdtempSync(join(tmpdir(), "markit-u-")), "none") } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^marKit isn't set up yet\. Run \/markit-setup to start\./);
  assert.match(r.stdout, /\/markit-find +find opportunities and draft replies/);
  assert.match(r.stdout, /\/markit-dashboard +work through them in your browser/);
});

test("CLI: unknown flags are reported clearly", () => {
  const r = spawnSync(process.execPath, [USAGE, "--bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /marKit: Unknown option '--bogus'/);
});
