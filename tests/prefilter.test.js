// Tests for the prefilter (lib/filters.js steps) and candidates.js (merge web.json,
// drop summary, thread context with caps). Fake adapters only: no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  dropTooOld, dropExcluded, dropSeen, dropLanguages, dedupeCrossPosts, normalizeText, jaccard,
  engagementTotal, preScore, preScoreAll, keepTop, droppedSummary, prefilterLine, PRESCORE,
} from "../skills/markit-find/scripts/lib/filters.js";
import { readWebPosts, keywordForQuery, buildCandidates, paidContextBudget, formatSummary } from "../skills/markit-find/scripts/candidates.js";
import { webIdFor } from "../skills/markit-find/scripts/lib/scored.js";
import { DEFAULT_SETTINGS } from "../skills/markit-find/scripts/lib/config.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const ago = (hours) => new Date(NOW.getTime() - hours * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
const post = (id, extra = {}) => ({ id, source: id.split("-")[0] === "web" ? "web" : "hackernews", url: `https://example.com/${id}`, title: "", excerpt: "", author: "someone", createdAt: ago(5), engagement: {}, matchedKeyword: "", ...extra });

const profile = {
  name: "gridpeek",
  keywords: ["app for planning F1 race weekend", "alternative to TripIt"],
  competitors: ["TripIt"],
  exclude: ["hiring"],
  languages: ["en"],
};

// --- each step ------------------------------------------------------------------

test("dropTooOld keeps posts in the window and posts with unknown dates", () => {
  const since = new Date(ago(24 * 7));
  const r = dropTooOld([post("hn-1", { createdAt: ago(2) }), post("hn-2", { createdAt: ago(24 * 8) }), post("hn-3", { createdAt: "" })], since);
  assert.deepEqual(r.kept.map((p) => p.id), ["hn-1", "hn-3"]);
  assert.equal(r.dropped, 1);
});

test("dropExcluded uses whole words", () => {
  const r = dropExcluded([post("hn-1", { title: "We're hiring a dev" }), post("hn-2", { title: "Any app for this?" })], ["hiring"]);
  assert.deepEqual(r.kept.map((p) => p.id), ["hn-2"]);
  assert.equal(r.dropped, 1);
});

test("dropSeen removes posts reported in earlier runs", () => {
  const r = dropSeen([post("hn-1"), post("hn-2")], new Set(["hn-1"]));
  assert.deepEqual(r.kept.map((p) => p.id), ["hn-2"]);
});

test("dropLanguages uses only platform-reported languages; unknown and 'und' are kept", () => {
  const posts = [post("x-1", { lang: ["en-us"] }), post("x-2", { lang: ["pt"] }), post("x-3"), post("x-4", { lang: ["und"] }), post("x-5", { lang: ["es", "en"] })];
  const r = dropLanguages(posts, ["en"]);
  assert.deepEqual(r.kept.map((p) => p.id), ["x-1", "x-3", "x-4", "x-5"]);
  assert.equal(r.dropped, 1);
  assert.equal(dropLanguages(posts, ["en", "pt"]).dropped, 0);
});

test("normalizeText strips URLs, punctuation, case, and extra spaces", () => {
  assert.equal(normalizeText("Any APP for F1?!  https://x.co/abc  www.y.com Café—ok"), "any app for f1 café ok");
});

test("jaccard measures shared words", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
});

test("engagementTotal counts talk double and ignores junk", () => {
  assert.equal(engagementTotal(post("a", { engagement: { score: 10, comments: 5 } })), 20);
  assert.equal(engagementTotal(post("a", { engagement: { likes: 3, replies: 2, reposts: 1 } })), 8);
  assert.equal(engagementTotal(post("a", { engagement: { score: -4, comments: "x" } })), 0);
});

test("dedupeCrossPosts merges identical and near-identical posts, keeps the most engaged", () => {
  const a = post("hn-1", { title: "Best app to plan my first F1 race weekend at Silverstone?", engagement: { score: 3 } });
  const b = post("web-2", { url: "https://forum.example/t/9", title: "best app to plan my FIRST f1 race weekend at Silverstone", engagement: { score: 40 } });
  // Near duplicate: one word different out of ten (Jaccard ≈ 0.82).
  const c = post("hn-3", { title: "Best app to plan my first F1 race weekend at Monza?", engagement: { score: 1 } });
  const d = post("hn-4", { title: "Totally different question about hotel booking sites" });
  const r = dedupeCrossPosts([a, b, c, d]);
  assert.equal(r.dropped, 2);
  const keeper = r.kept.find((p) => p.id === "web-2");
  assert.ok(keeper, "the most-engaged copy is kept");
  assert.deepEqual(keeper.alsoPostedAt.sort(), [a.url, c.url].sort());
  assert.ok(r.kept.some((p) => p.id === "hn-4"));
  assert.equal(a.alsoPostedAt, undefined, "input posts aren't modified");
});

test("short posts are only duplicates when identical", () => {
  const r = dedupeCrossPosts([post("hn-1", { title: "TripIt alternative?" }), post("hn-2", { title: "TripIt alternatives?" })]);
  assert.equal(r.dropped, 0);
});

// --- the pre-score formula ---------------------------------------------------------

test("preScore: exact keyword + question + intent + competitor + recency + engagement", () => {
  const p = post("hn-1", { title: "Looking for an app for planning F1 race weekend, alternative to TripIt?", createdAt: ago(3), engagement: { score: 9 } });
  const { preScore: score, preScoreReasons } = preScore(p, profile, NOW);
  // 30 exact + 8 question + 16 intent (2 phrases) + 15 competitor + 12 recency + 4 engagement
  assert.equal(score, 30 + 8 + 16 + 15 + 12 + 4);
  assert.ok(preScoreReasons.includes('exact keyword "app for planning F1 race weekend"'));
  assert.ok(preScoreReasons.includes("names TripIt"));
  assert.ok(preScoreReasons.includes("posted today"));
});

test("preScore: partial keyword match scales with the share of topic words", () => {
  const p = post("hn-1", { title: "F1 weekend thoughts", createdAt: "" });
  // "app for planning F1 race weekend" → topic words: f1, race, weekend; 2 of 3 present
  const { preScore: score } = preScore(p, { ...profile, competitors: [] }, NOW);
  assert.equal(score, Math.round(PRESCORE.keywordPartialMax * (2 / 3)) + PRESCORE.unknownDate);
});

test("preScore: a post with no date starts a little lower (it may be a years-old thread)", () => {
  const dated = preScore(post("hn-1", { title: "alternative to TripIt?", createdAt: ago(24 * 10) }), profile, NOW);
  const undated = preScore(post("hn-1", { title: "alternative to TripIt?", createdAt: "" }), profile, NOW);
  assert.equal(undated.preScore, dated.preScore + PRESCORE.unknownDate);
  assert.ok(undated.preScoreReasons.includes("date unknown"));
});

test("preScore: penalties for job/sale posts and self-promotion, clamped at 0", () => {
  // 10 days old: no recency points and no "date unknown" penalty, so only the keyword and promo count.
  const promo = post("hn-1", { title: "Show HN: I built an app for planning F1 race weekend", createdAt: ago(24 * 10) });
  assert.equal(preScore(promo, profile, NOW).preScore, 30 - 25);
  const job = post("hn-2", { title: "Now hiring", createdAt: "" });
  assert.equal(preScore(job, profile, NOW).preScore, 0);
});

test("preScore: engagement is capped so viral posts don't dominate", () => {
  const viral = post("hn-1", { title: "x", createdAt: "", engagement: { score: 1_000_000, comments: 50_000 } });
  assert.equal(preScore(viral, profile, NOW).preScore, PRESCORE.engagementMax + PRESCORE.unknownDate);
});

test("keepTop keeps the best N and counts the rest", () => {
  const scored = preScoreAll([post("hn-1", { title: "alternative to TripIt?" }), post("hn-2", { title: "unrelated" }), post("hn-3", { title: "any app for planning F1 race weekend?" })], profile, NOW);
  const r = keepTop(scored, 2);
  // hn-1: exact keyword + "?" + intent + names TripIt + recency = 73; hn-3: 58; hn-2: 12.
  assert.deepEqual(r.kept.map((p) => p.id), ["hn-1", "hn-3"]);
  assert.equal(r.dropped, 1);
});

test("droppedSummary and prefilterLine show non-zero counts only", () => {
  assert.equal(droppedSummary({ duplicate: 3, tooOld: 0, belowCutoff: 2 }), "3 duplicates · 2 below the cutoff");
  assert.equal(prefilterLine({ found: 50, candidates: 40, dropped: { duplicate: 10 } }), "Prefilter: 50 found → 40 candidates · dropped 10 duplicates");
  assert.equal(prefilterLine(null), "");
});

// --- web.json ------------------------------------------------------------------------

test("readWebPosts validates, cleans untrusted text, and gives stable ids", () => {
  const { posts, invalid } = readWebPosts({
    posts: [
      { url: "https://forum.example/t/1?utm_source=x", title: "<b>First GP</b> tips?", excerpt: "<script>x</script>Help me plan", site: "Autosport Forums", createdAt: "2026-10-21T10:00:00Z" },
      { url: "javascript:alert(1)", title: "bad" },
      { url: "https://forum.example/t/2" }, // no text
      { title: "no url" },
    ],
  });
  assert.equal(invalid, 3);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, webIdFor("https://forum.example/t/1"));
  assert.equal(posts[0].source, "web");
  assert.equal(posts[0].title, "First GP tips?");
  assert.ok(!posts[0].excerpt.includes("<"));
  assert.equal(posts[0].site, "Autosport Forums");
  assert.equal(readWebPosts([{ url: "https://www.site.example/x", title: "t" }]).posts[0].site, "site.example", "site falls back to the domain");
});

// --- buildCandidates --------------------------------------------------------------------

const settings = (extra = {}) => ({ ...DEFAULT_SETTINGS, ...extra });

function fakeContextAdapter(name, { paid = false, costUnit, quota, contextUsesQuota, spend = {}, result } = {}) {
  const a = {
    name, paid, costUnit, quota, contextUsesQuota, calls: [],
    isEnabled: () => true,
    async context(p, opts) {
      a.calls.push({ id: p.id, budget: opts.budget });
      for (const [k, v] of Object.entries(spend)) opts.meter[k] = (opts.meter[k] ?? 0) + v;
      return result ?? { commentCount: 2, solved: false, locked: false, topComments: [], appsAlreadySuggested: 0, mentionsYourApp: false };
    },
  };
  return a;
}

const rawWith = (posts, sources = []) => ({ app: "gridpeek", ranAt: ago(0), lookbackDays: 7, since: ago(24 * 7), sources, webQueries: [], posts });

test("buildCandidates merges web.json, runs every step, and summarizes drops (incl. search.js's)", async () => {
  const raw = rawWith(
    [
      post("hn-1", { title: "Any app for planning F1 race weekend?" }),
      post("hn-2", { title: "Old question", createdAt: ago(24 * 30) }),
      post("hn-3", { title: "We're hiring" }),
      post("hn-4", { title: "Already reported" }),
      post("hn-5", { title: "Pergunta em português", lang: ["pt"] }),
    ],
    [{ name: "hackernews", status: "ok", fetched: 9, removed: { seen: 2, excluded: 1, outsideWindow: 1 } }]
  );
  const web = [
    { url: "https://forum.example/t/1", title: "Any app for planning F1 race weekend?", site: "Forum" }, // cross-post of hn-1
    { url: "https://forum.example/t/2", title: "TripIt alternative for race trips?", site: "Forum" },
  ];
  const { output } = await buildCandidates({ raw, web, profile, settings: settings({ maxCandidates: 10 }), seen: new Set(["hn-4"]), adapters: [], now: NOW });
  const ids = output.candidates.map((c) => c.id);
  assert.deepEqual(ids.length, 2);
  assert.ok(ids.includes(webIdFor("https://forum.example/t/2")));
  const p = output.prefilter;
  assert.equal(p.fromApis, 9);
  assert.equal(p.fromWeb, 2);
  assert.equal(p.found, 11);
  assert.deepEqual(p.dropped, { tooOld: 2, excluded: 2, alreadyReported: 3, language: 1, duplicate: 1, belowCutoff: 0 });
  assert.ok(output.candidates.every((c) => typeof c.preScore === "number" && Array.isArray(c.preScoreReasons)));
  assert.ok(!JSON.stringify(p).includes("hiring"), "the summary holds counts only, no post content");
});

test("buildCandidates caps to maxCandidates and fetches context for the top maxContext only", async () => {
  const posts = Array.from({ length: 6 }, (_, i) => post(`hn-${i}`, { title: `question ${i}`, engagement: { score: i * 10 } }));
  const hn = fakeContextAdapter("hackernews");
  const { output } = await buildCandidates({ raw: rawWith(posts), profile, settings: settings({ maxCandidates: 4, maxContext: 2 }), adapters: [hn], now: NOW });
  assert.equal(output.candidates.length, 4);
  assert.equal(output.prefilter.dropped.belowCutoff, 2);
  assert.equal(hn.calls.length, 2);
  assert.deepEqual(output.candidates.filter((c) => c.context).map((c) => c.id), hn.calls.map((c) => c.id));
  assert.equal(output.prefilter.context.fetched, 2);
});

test("paid context is OFF by default", async () => {
  const x = fakeContextAdapter("x", { paid: true, costUnit: "posts" });
  const { output, meters } = await buildCandidates({ raw: rawWith([post("x-1", { source: "x", title: "any app?" })]), profile, settings: settings(), adapters: [x], now: NOW });
  assert.equal(x.calls.length, 0);
  assert.equal(output.prefilter.context.paidOff, 1);
  assert.equal(meters.x.posts, 0);
});

test("paid context, when enabled, stays within the per-run cap (after search's spend) and the monthly cap", async () => {
  const caps = settings({ contextForPaidSources: true, x: { maxPostsPerRun: 30, maxPostsPerMonth: 900 } });
  const posts = [post("x-1", { source: "x", title: "any app? one" }), post("x-2", { source: "x", title: "any app? two" }), post("x-3", { source: "x", title: "any app? three" })];
  const x = fakeContextAdapter("x", { paid: true, costUnit: "posts", spend: { posts: 10 } });
  // search.js already spent 15 of the 30 this run → 15 left → one 10-post call fits, then 5 left.
  const raw = rawWith(posts, [{ name: "x", status: "ok", fetched: 3, used: { requests: 2, posts: 15, credits: 0 } }]);
  const { output, meters } = await buildCandidates({ raw, profile, settings: caps, adapters: [x], now: NOW });
  assert.deepEqual(x.calls.map((c) => c.budget), [{ posts: 15 }, { posts: 5 }, ]);
  assert.equal(meters.x.posts, 20, "the fake spends 10 per call; candidates.js passes what's left each time");
  assert.equal(output.prefilter.context.capped, 1);

  // Monthly cap: 895 of 900 already used this month → only 5 left.
  const usage = { months: { "2026-10": { x: { requests: 0, posts: 895, credits: 0 } } }, days: {} };
  assert.deepEqual(paidContextBudget({ name: "x", costUnit: "posts" }, { settings: caps, usage, raw, meter: { posts: 0 }, now: NOW }), { unit: "posts", remaining: 5 });
});

test("free daily quota shared with search is respected; YouTube's separate pool isn't", async () => {
  const se = fakeContextAdapter("stackexchange", { quota: { unit: "requests", period: "day", limit: 300 }, spend: { requests: 2 } });
  const yt = fakeContextAdapter("youtube", { quota: { unit: "requests", period: "day", limit: 100 }, contextUsesQuota: false, spend: { context: 2 } });
  const usage = { months: {}, days: { "2026-10-22": { stackexchange: { requests: 299 }, youtube: { requests: 100 } } } };
  const posts = [post("se-a-1", { source: "stackexchange", title: "q1?" }), post("yt-2", { source: "youtube", title: "q2?" })];
  const { output, meters } = await buildCandidates({ raw: rawWith(posts), profile, settings: settings(), usage, adapters: [se, yt], now: NOW });
  assert.equal(se.calls.length, 0, "only 1 SE request left; context needs 2");
  assert.equal(yt.calls.length, 1, "YouTube context uses the 10,000-unit pool, not its search quota");
  assert.equal(meters.youtube.context, 2);
  assert.equal(output.prefilter.context.capped, 1);
});

test("a failing context call doesn't break the run and never leaks error details", async () => {
  const bad = fakeContextAdapter("hackernews");
  bad.context = async () => { throw new Error("secret-token-123 in some message"); };
  const { output } = await buildCandidates({ raw: rawWith([post("hn-1", { title: "q?" })]), profile, settings: settings(), adapters: [bad], now: NOW });
  assert.equal(output.prefilter.context.failed, 1);
  assert.equal(output.candidates.length, 1);
  assert.ok(!JSON.stringify(output).includes("secret-token-123"));
});

test("formatSummary prints found / dropped / candidates", async () => {
  const { output } = await buildCandidates({ raw: rawWith([post("hn-1", { title: "q?" })]), web: [], profile, settings: settings(), adapters: [], now: NOW });
  const text = formatSummary(output, "/run/candidates.json");
  assert.match(text, /^marKit candidates · gridpeek/);
  assert.match(text, /Found 1 posts \(1 from APIs, 0 from web search\)/);
  assert.match(text, /1 candidates · thread context for 0/);
  assert.match(text, /candidates\.json: \/run\/candidates\.json$/);
});

// --- CLI (web-only data, so no network) --------------------------------------------------

test("candidates.js CLI writes candidates.json next to raw.json", () => {
  const home = mkdtempSync(join(tmpdir(), "markit-cand-"));
  const configDir = join(home, "config");
  const runDir = join(home, "reports", "gridpeek", "2026-10-22-1200");
  mkdirSync(join(configDir, "apps"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ reportsDir: join(home, "reports") }));
  writeFileSync(join(configDir, "apps", "gridpeek.json"), JSON.stringify({ name: "gridpeek", url: "https://x.app", oneLiner: "x", audience: "y", keywords: ["app for planning F1 race weekend", "alternative to TripIt", "first Grand Prix tips"], sources: ["web"] }));
  writeFileSync(join(runDir, "raw.json"), JSON.stringify({ app: "gridpeek", ranAt: new Date().toISOString(), lookbackDays: 7, since: new Date(Date.now() - 7 * 864e5).toISOString(), sources: [], webQueries: [], posts: [] }));
  writeFileSync(join(runDir, "web.json"), JSON.stringify([{ url: "https://forum.example/t/1", title: "Any app for planning F1 race weekend?", site: "Forum" }]));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../skills/markit-find/scripts/candidates.js", import.meta.url)), runDir], { encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: configDir } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(readFileSync(join(runDir, "candidates.json"), "utf8"));
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].source, "web");
  assert.match(r.stdout, /candidates\.json: /);

  const missing = spawnSync(process.execPath, [fileURLToPath(new URL("../skills/markit-find/scripts/candidates.js", import.meta.url)), home], { encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: configDir } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /raw\.json not found/);
});

test("web results get their keyword from the query that found them", () => {
  const keywords = ["F1 trip planner app", "trip planner app", "first time going to a Grand Prix tips"];
  assert.equal(keywordForQuery("site:reddit.com F1 trip planner app", keywords), "F1 trip planner app", "the longest match wins");
  assert.equal(keywordForQuery('site:reddit.com "TripIt" alternative', keywords), '"TripIt" alternative', "competitor queries keep the query");
  assert.equal(keywordForQuery("", keywords), "");
  const { posts } = readWebPosts([
    { url: "https://f.example/1", title: "a", site: "F", query: "site:quora.com first time going to a Grand Prix tips" },
    { url: "https://f.example/2", title: "b", site: "F", matchedKeyword: "F1 trip planner app", query: "ignored" },
  ], { keywords, now: NOW });
  assert.deepEqual(posts.map((p) => p.matchedKeyword), ["first time going to a Grand Prix tips", "F1 trip planner app"]);
});

test("web results dated in the future count as undated", () => {
  const { posts } = readWebPosts([
    { url: "https://f.example/1", title: "a", createdAt: "2099-01-01T00:00:00Z" },
    { url: "https://f.example/2", title: "b", createdAt: ago(-12) }, // 12h ahead: time zones, fine
  ], { now: NOW });
  assert.deepEqual(posts.map((p) => p.createdAt), ["", ago(-12)]);
});

test("collapseWhitespace removes invisible direction overrides from post text", async () => {
  const { collapseWhitespace } = await import("../skills/markit-find/scripts/lib/normalize.js");
  assert.equal(collapseWhitespace("Any app\u202E?\u200B  for F1"), "Any app? for F1");
});
