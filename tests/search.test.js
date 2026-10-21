// Tests for search.js (runSearch orchestration + the CLI), lib/filters.js, and
// lib/web-queries.js. Sources are FAKE adapters, so nothing touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSearch, paidBudget, safeReason, makeRunFolder, formatSummary } from "../skills/markit-find/scripts/search.js";
import { makeExcludeMatcher, interleave, isWithinWindow } from "../skills/markit-find/scripts/lib/filters.js";
import { buildWebQueries, MAX_WEB_QUERIES } from "../skills/markit-find/scripts/lib/web-queries.js";
import { SourceError } from "../skills/markit-find/scripts/lib/safe-fetch.js";
import { DEFAULT_SETTINGS } from "../skills/markit-find/scripts/lib/config.js";

const NOW = new Date("2026-10-21T13:00:00Z");
const SECRET = "sk_SECRET_should_never_show";

// A Post in the shared shape. `hoursAgo` sets createdAt relative to NOW.
const post = (id, hoursAgo = 1, title = "Any app for this?", excerpt = "Looking for help") => ({
  id,
  source: id.split("-")[0],
  url: `https://example.com/${id}`,
  title,
  excerpt,
  author: "someone",
  createdAt: new Date(NOW.getTime() - hoursAgo * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z"),
  engagement: {},
  matchedKeyword: "",
});

/**
 * A fake adapter. `results` maps keyword → posts. `fail(keyword)` may return an error to throw.
 * It records every call so tests can check limits and budgets.
 */
function fakeAdapter(name, { paid = false, costUnit, enabled = true, results = {}, fail } = {}) {
  const adapter = {
    name,
    label: name,
    paid,
    costUnit,
    requiredEnv: [],
    calls: [],
    isEnabled: () => enabled,
    async search(keyword, opts) {
      adapter.calls.push({ keyword, limit: opts.limit, budget: opts.budget });
      opts.meter.requests++;
      if (costUnit === "credits") opts.meter.credits++;
      const err = fail?.(keyword);
      if (err) throw err;
      return (results[keyword] ?? []).slice(0, opts.limit);
    },
  };
  return adapter;
}

const profile = (extra = {}) => ({
  name: "gridpeek",
  keywords: ["kw one", "kw two"],
  competitors: ["TripIt"],
  exclude: [],
  sources: ["hackernews"],
  ...extra,
});
const settings = (extra = {}) => ({ ...DEFAULT_SETTINGS, reportsDir: "/unused", ...extra });

// --- runSearch -----------------------------------------------------------------

test("runs enabled sources, skips missing adapters and missing keys", async () => {
  const hn = fakeAdapter("hackernews", { results: { "kw one": [post("hn-1")] } });
  const yt = fakeAdapter("youtube", { enabled: false });
  const { raw, meters } = await runSearch({
    profile: profile({ sources: ["hackernews", "youtube", "bluesky"] }),
    settings: settings(),
    adapters: [hn, yt],
    now: NOW,
  });
  assert.deepEqual(
    raw.sources.map((s) => [s.name, s.status, s.reason]),
    [["hackernews", "ok", undefined], ["youtube", "skipped", "no key"], ["bluesky", "skipped", "not available yet"]]
  );
  assert.deepEqual(raw.posts.map((p) => p.id), ["hn-1"]);
  assert.equal(yt.calls.length, 0, "a source without its key is never called");
  assert.deepEqual(meters, [{ name: "hackernews", meter: { requests: 2, posts: 1, credits: 0 } }]);
});

test("one failing source doesn't break the others; reasons are key-safe", async () => {
  const hn = fakeAdapter("hackernews", { results: { "kw one": [post("hn-1")] } });
  const se = fakeAdapter("stackexchange", { fail: () => new SourceError("stackexchange", "HTTP 403", 403) });
  const bad = fakeAdapter("bluesky", { fail: () => new TypeError(`boom ${SECRET}`) });
  const { raw } = await runSearch({ profile: profile({ sources: ["hackernews", "stackexchange", "bluesky"] }), settings: settings(), adapters: [hn, se, bad], now: NOW });
  const byName = Object.fromEntries(raw.sources.map((s) => [s.name, s]));
  assert.equal(byName.hackernews.status, "ok");
  assert.equal(byName.stackexchange.status, "error");
  assert.equal(byName.stackexchange.reason, "HTTP 403");
  assert.equal(byName.bluesky.reason, "unexpected error (TypeError)");
  assert.ok(!JSON.stringify(raw).includes(SECRET));
});

test("partial keyword failures keep the results that worked", async () => {
  const hn = fakeAdapter("hackernews", {
    results: { "kw two": [post("hn-2")] },
    fail: (kw) => (kw === "kw one" ? new SourceError("hackernews", "HTTP 500", 500) : null),
  });
  const { raw } = await runSearch({ profile: profile(), settings: settings(), adapters: [hn], now: NOW });
  assert.equal(raw.sources[0].status, "ok");
  assert.equal(raw.sources[0].reason, "1 of 2 searches failed (HTTP 500)");
  assert.deepEqual(raw.posts.map((p) => p.id), ["hn-2"]);
});

test("drops seen posts, excluded words, and posts outside the window, and counts them", async () => {
  const hn = fakeAdapter("hackernews", {
    results: {
      "kw one": [post("hn-1"), post("hn-2"), post("hn-3", 1, "We're hiring engineers"), post("hn-4", 24 * 30)],
      "kw two": [post("hn-1"), post("hn-5", 2, "Jobs board", "")],
    },
  });
  const { raw } = await runSearch({
    profile: profile({ exclude: ["hiring", "job"] }),
    settings: settings(),
    adapters: [hn],
    seen: new Set(["hn-2"]),
    now: NOW,
  });
  assert.deepEqual(raw.posts.map((p) => p.id), ["hn-1"]);
  assert.deepEqual(raw.sources[0].removed, { seen: 1, excluded: 2, outsideWindow: 1 });
  assert.equal(raw.sources[0].fetched, 5, "duplicates across keywords are counted once");
  assert.equal(raw.sources[0].count, 1);
});

test("caps each source to maxPostsPerSource, mixing keywords fairly", async () => {
  const many = (prefix, n) => Array.from({ length: n }, (_, i) => post(`hn-${prefix}${i}`, i + 1));
  const hn = fakeAdapter("hackernews", { results: { "kw one": many("a", 10), "kw two": many("b", 10) } });
  const { raw } = await runSearch({ profile: profile(), settings: settings({ maxPostsPerSource: 4 }), adapters: [hn], now: NOW });
  assert.equal(raw.posts.length, 4);
  assert.deepEqual(raw.posts.map((p) => p.id).sort(), ["hn-a0", "hn-a1", "hn-b0", "hn-b1"]);
});

test("posts from all sources are merged newest first", async () => {
  const hn = fakeAdapter("hackernews", { results: { "kw one": [post("hn-old", 10)] } });
  const se = fakeAdapter("stackexchange", { results: { "kw one": [post("se-new", 1)] } });
  const { raw } = await runSearch({ profile: profile({ sources: ["hackernews", "stackexchange"] }), settings: settings(), adapters: [hn, se], now: NOW });
  assert.deepEqual(raw.posts.map((p) => p.id), ["se-new", "hn-old"]);
});

test("lookback: --days beats the profile, which beats settings.json", async () => {
  const hn = fakeAdapter("hackernews");
  const run = (opts) => runSearch({ adapters: [hn], now: NOW, settings: settings({ lookbackDays: 7 }), ...opts }).then((r) => r.raw);
  assert.equal((await run({ profile: profile() })).lookbackDays, 7);
  assert.equal((await run({ profile: profile({ lookbackDays: 3 }) })).lookbackDays, 3);
  const raw = await run({ profile: profile({ lookbackDays: 3 }), lookbackDays: 1 });
  assert.equal(raw.lookbackDays, 1);
  assert.equal(raw.since, "2026-10-20T13:00:00Z");
});

test("web queries are added only when 'web' is a source", async () => {
  const withWeb = await runSearch({ profile: profile({ sources: ["web"] }), settings: settings(), adapters: [], now: NOW });
  assert.ok(withWeb.raw.webQueries.length > 0);
  assert.deepEqual(withWeb.raw.sources, [{ name: "web", label: "Web search", status: "agent", count: 0, reason: `${withWeb.raw.webQueries.length} queries for the agent to run` }]);
  const without = await runSearch({ profile: profile({ sources: ["hackernews"] }), settings: settings(), adapters: [fakeAdapter("hackernews")], now: NOW });
  assert.deepEqual(without.raw.webQueries, []);
});

// --- Paid caps -----------------------------------------------------------------

const usageWith = (source, counts) => ({ months: { "2026-10": { [source]: { requests: 0, posts: 0, credits: 0, ...counts } } }, days: {} });

test("paid (posts): stops calling once the per-run cap is reached", async () => {
  const fifteen = (p) => Array.from({ length: 15 }, (_, i) => post(`x-${p}${i}`, i + 1));
  const x = fakeAdapter("x", { paid: true, costUnit: "posts", results: { "kw one": fifteen("a"), "kw two": fifteen("b"), "kw three": fifteen("c") } });
  const { raw, meters } = await runSearch({
    profile: profile({ sources: ["x"], keywords: ["kw one", "kw two", "kw three"] }),
    settings: settings({ x: { maxPostsPerRun: 20, maxPostsPerMonth: 900 } }),
    adapters: [x],
    now: NOW,
  });
  assert.deepEqual(x.calls.map((c) => c.limit), [20, 5], "second call only asks for what's left; third is never made");
  assert.deepEqual(x.calls.map((c) => c.budget), [{ posts: 20 }, { posts: 5 }]);
  assert.equal(meters[0].meter.posts, 20);
  assert.equal(raw.sources[0].reason, "stopped at per-run cap (20 posts)");
});

test("paid (posts): the monthly cap limits the run, and a spent cap skips the source", async () => {
  const x = fakeAdapter("x", { paid: true, costUnit: "posts", results: { "kw one": Array.from({ length: 30 }, (_, i) => post(`x-${i}`)) } });
  const caps = settings({ x: { maxPostsPerRun: 30, maxPostsPerMonth: 900 } });

  await runSearch({ profile: profile({ sources: ["x"] }), settings: caps, adapters: [x], usage: usageWith("x", { posts: 890 }), now: NOW });
  assert.equal(x.calls[0].limit, 10, "only 10 posts left this month");

  x.calls.length = 0;
  const { raw } = await runSearch({ profile: profile({ sources: ["x"] }), settings: caps, adapters: [x], usage: usageWith("x", { posts: 900 }), now: NOW });
  assert.equal(x.calls.length, 0);
  assert.deepEqual([raw.sources[0].status, raw.sources[0].reason], ["skipped", "monthly cap reached (900 / 900 posts)"]);
});

test("paid (credits): stops at the credit cap", async () => {
  const sc = fakeAdapter("socialcrawl", { paid: true, costUnit: "credits", results: {} });
  const { meters } = await runSearch({
    profile: profile({ sources: ["socialcrawl"], keywords: ["a b", "c d", "e f", "g h"] }),
    settings: settings({ socialcrawl: { maxCreditsPerRun: 2, maxCreditsPerMonth: 1500 } }),
    adapters: [sc],
    now: NOW,
  });
  assert.equal(sc.calls.length, 2);
  assert.equal(meters[0].meter.credits, 2);
});

test("paidBudget refuses to spend when caps are missing", () => {
  const b = paidBudget({ name: "x", costUnit: "posts" }, { x: {} }, { months: {}, days: {} }, NOW);
  assert.deepEqual(b, { unit: "posts", remaining: 0, reason: "no posts caps in settings.json" });
});

test("safeReason only trusts SourceErrors", () => {
  assert.equal(safeReason(new SourceError("youtube", "HTTP 403", 403), "youtube"), "HTTP 403");
  assert.equal(safeReason(new Error(SECRET), "youtube"), "unexpected error (Error)");
});

// --- filters -------------------------------------------------------------------

test("exclude matcher: whole words, case-insensitive, simple plurals", () => {
  const isExcluded = makeExcludeMatcher(["job", "bet", "c++"]);
  const p = (title) => ({ title, excerpt: "" });
  assert.equal(isExcluded(p("New JOB opening")), true);
  assert.equal(isExcluded(p("Remote jobs list")), true);
  assert.equal(isExcluded(p("You'd better plan ahead")), false);
  assert.equal(isExcluded(p("I'm jobless")), false);
  assert.equal(makeExcludeMatcher([])(p("anything")), false);
});

test("interleave takes one per list in turn and skips duplicates", () => {
  const a = [{ id: "1" }, { id: "2" }, { id: "3" }];
  const b = [{ id: "1" }, { id: "9" }];
  assert.deepEqual(interleave([a, b], 4).map((x) => x.id), ["1", "2", "9", "3"]);
  assert.deepEqual(interleave([a, b], 2).map((x) => x.id), ["1", "2"]);
});

test("isWithinWindow keeps undated posts", () => {
  const since = new Date("2026-10-14T00:00:00Z");
  assert.equal(isWithinWindow({ createdAt: "2026-10-15T00:00:00Z" }, since), true);
  assert.equal(isWithinWindow({ createdAt: "2026-10-13T00:00:00Z" }, since), false);
  assert.equal(isWithinWindow({ createdAt: "" }, since), true);
});

// --- web queries ---------------------------------------------------------------

test("web queries: Reddit per keyword, competitor alternatives, Quora, forums", () => {
  const q = buildWebQueries({ keywords: ["app for planning F1 race weekend", "going to my first Grand Prix", "third keyword here"], competitors: ["TripIt", "official F1 app"] });
  assert.deepEqual(q, [
    "site:reddit.com app for planning F1 race weekend",
    "site:reddit.com going to my first Grand Prix",
    "site:reddit.com third keyword here",
    'site:reddit.com "TripIt" alternative',
    'site:reddit.com "official F1 app" alternative',
    "site:quora.com app for planning F1 race weekend",
    "site:quora.com going to my first Grand Prix",
    "F1 race weekend forum",
    "first Grand Prix forum",
  ]);
});

test("web queries are de-duplicated and capped", () => {
  const keywords = Array.from({ length: 8 }, (_, i) => `best app for thing ${i}`);
  const q = buildWebQueries({ keywords, competitors: ["A", "B", "C", "D"] });
  // 8 Reddit + 3 competitors (4th dropped) + 2 Quora + 2 forums = 15, within the cap.
  assert.equal(q.length, 15);
  assert.ok(q.length <= MAX_WEB_QUERIES);
  assert.equal(new Set(q.map((s) => s.toLowerCase())).size, q.length);
});

// --- run folder + summary ------------------------------------------------------

test("makeRunFolder uses local time and adds -2 when the minute is taken", () => {
  const reports = mkdtempSync(join(tmpdir(), "markit-reports-"));
  const now = new Date(2026, 9, 21, 21, 5); // Oct 21, 2026 9:05 PM local time
  assert.equal(makeRunFolder(reports, "gridpeek", now), join(reports, "gridpeek", "2026-10-21-2105"));
  assert.equal(makeRunFolder(reports, "gridpeek", now), join(reports, "gridpeek", "2026-10-21-2105-2"));
});

test("formatSummary shows each source and the raw.json path", () => {
  const raw = {
    app: "gridpeek",
    lookbackDays: 7,
    posts: [{}, {}],
    sources: [
      { name: "hackernews", label: "Hacker News", status: "ok", count: 2, removed: { seen: 3, excluded: 1, outsideWindow: 0 } },
      { name: "youtube", label: "YouTube", status: "error", count: 0, reason: "HTTP 403" },
      { name: "bluesky", label: "Bluesky", status: "skipped", count: 0, reason: "no key" },
      { name: "web", label: "Web search", status: "agent", count: 0, reason: "9 queries for the agent to run" },
    ],
  };
  const text = formatSummary(raw, "/r/raw.json", 'Using app profile "gridpeek" (your only app).');
  assert.match(text, /Using app profile "gridpeek"/);
  assert.match(text, /✓ Hacker News {5}2 new/);
  assert.match(text, /✗ YouTube {9}error: HTTP 403/);
  assert.match(text, /– Bluesky {9}skipped: no key/);
  assert.match(text, /… Web search {6}9 queries for the agent to run/);
  assert.match(text, /2 new posts from APIs \(skipped: 3 already reported, 1 excluded\)/);
  assert.match(text, /raw\.json: \/r\/raw\.json$/);
});

// --- CLI (web-only profile, so no network) -------------------------------------

const SETUP = fileURLToPath(new URL("../skills/markit-setup/scripts/setup.js", import.meta.url));
const SEARCH = fileURLToPath(new URL("../skills/markit-find/scripts/search.js", import.meta.url));

function cliEnv() {
  const base = mkdtempSync(join(tmpdir(), "markit-cli-"));
  const configDir = join(base, "config");
  const reportsDir = join(base, "reports");
  const run = (script, args, input = "", cwd = base) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: configDir } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  run(SETUP, ["init"]);
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ reportsDir }));
  const addApp = (name) =>
    run(SETUP, ["app", "--name", name], JSON.stringify({ url: "https://x.app", oneLiner: "x", audience: "y", keywords: ["app for planning trips", "best trip tool", "alternative to Foo"], sources: ["web"] }));
  return { base, configDir, reportsDir, run, addApp };
}

test("CLI writes raw.json into <reportsDir>/<app>/<timestamp>/ and prints the summary", () => {
  const { reportsDir, run, addApp } = cliEnv();
  addApp("gridpeek");
  const r = run(SEARCH, ["--app", "gridpeek"]);
  assert.equal(r.code, 0, r.err);
  const rawPath = r.out.match(/raw\.json: (.+)$/m)[1];
  assert.ok(rawPath.startsWith(join(reportsDir, "gridpeek")));
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  assert.equal(raw.app, "gridpeek");
  assert.equal(raw.lookbackDays, 7);
  assert.ok(raw.webQueries.includes("site:reddit.com app for planning trips"));
  assert.deepEqual(raw.posts, []);
});

test("CLI picks the only app automatically and says so; asks when there are several", () => {
  const { run, addApp } = cliEnv();
  addApp("gridpeek");
  assert.match(run(SEARCH, []).out, /Using app profile "gridpeek" \(your only app\)/);
  addApp("keepr");
  const several = run(SEARCH, []);
  assert.equal(several.code, 1);
  assert.match(several.err, /which app\? Run again with --app <name>\. Your apps: gridpeek, keepr\./);
});

test("CLI validates --days and requires setup", () => {
  const { run, addApp } = cliEnv();
  addApp("gridpeek");
  assert.match(run(SEARCH, ["--app", "gridpeek", "--days", "99"]).err, /--days must be a whole number from 1 to 30/);
  const fresh = spawnSync(process.execPath, [SEARCH, "--app", "x"], { encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: join(tmpdir(), "markit-nope-" + Date.now()) } });
  assert.match(fresh.stderr, /not set up yet/);
});

// --- Free daily quotas (milestone 8) ---------------------------------------------

test("free daily quota: stops at what's left today, skips when used up", async () => {
  const yt = fakeAdapter("youtube", { results: {} });
  yt.quota = { unit: "requests", label: "searches", period: "day", limit: 100 };
  const today = (n) => ({ months: {}, days: { "2026-10-21": { youtube: { requests: n, posts: 0, credits: 0 } } } });

  const { raw } = await runSearch({ profile: profile({ sources: ["youtube"], keywords: ["a b", "c d", "e f"] }), settings: settings(), adapters: [yt], usage: today(98), now: NOW });
  assert.equal(yt.calls.length, 2, "only 2 searches left today");
  assert.equal(raw.sources[0].reason, "stopped at daily quota (100 searches)");

  yt.calls.length = 0;
  const spent = await runSearch({ profile: profile({ sources: ["youtube"] }), settings: settings(), adapters: [yt], usage: today(100), now: NOW });
  assert.equal(yt.calls.length, 0);
  assert.deepEqual([spent.raw.sources[0].status, spent.raw.sources[0].reason], ["skipped", "daily quota used (100 / 100 searches, marKit's count)"]);
});

test("free daily quota uses the higher limit when its key is set", async () => {
  const { quotaBudget } = await import("../skills/markit-find/scripts/search.js");
  const se = { name: "stackexchange", quota: { unit: "requests", period: "day", limit: 300, limitWithKey: 10000, keyEnv: "STACKEXCHANGE_KEY" } };
  const usage = { months: {}, days: { "2026-10-21": { stackexchange: { requests: 300, posts: 0, credits: 0 } } } };
  assert.equal(quotaBudget(se, {}, usage, NOW).remaining, 0);
  assert.equal(quotaBudget(se, { STACKEXCHANGE_KEY: "k" }, usage, NOW).remaining, 9700);
});
