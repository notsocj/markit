// Tests for report.js, lib/scored.js (validation), and lib/render-report.js (markdown).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateScored, webIdFor, priorityFor } from "../skills/markit-find/scripts/lib/scored.js";
import { renderReport, escapeMd, softEscape, sortPosts } from "../skills/markit-find/scripts/lib/render-report.js";
import { buildReport, formatSummary } from "../skills/markit-find/scripts/report.js";

const NOW = new Date("2026-10-21T13:00:00Z");

const raw = () => ({
  app: "gridpeek",
  ranAt: "2026-10-21T12:00:00Z",
  lookbackDays: 7,
  since: "2026-10-14T12:00:00Z",
  sources: [
    { name: "hackernews", label: "Hacker News", status: "ok", count: 2 },
    { name: "stackexchange", label: "Stack Exchange", status: "ok", count: 1, reason: "1 of 7 searches failed (HTTP 500)" },
    { name: "bluesky", label: "Bluesky", status: "skipped", count: 0, reason: "no key" },
    { name: "youtube", label: "YouTube", status: "error", count: 0, reason: "HTTP 403" },
    { name: "web", label: "Web search", status: "agent", count: 0, reason: "13 queries for the agent to run" },
  ],
  webQueries: [],
  posts: [
    { id: "hn-1", source: "hackernews" },
    { id: "hn-2", source: "hackernews" },
    { id: "se-travel-3", source: "stackexchange" },
    { id: "hn-9", source: "hackernews" },
  ],
});

const base = (id, source, extra) => ({
  id,
  source,
  url: `https://example.com/${id}`,
  title: `Title ${id}`,
  excerpt: `Excerpt ${id}`,
  author: "someone",
  createdAt: "2026-10-21T10:00:00Z",
  ...extra,
});

const scored = () => ({
  posts: [
    base("hn-1", "hackernews", { intent: "asking_for_recommendation", score: 92, priority: "high", why: "Asks for exactly this.", draftReply: "Line one.\nLine two." }),
    base("hn-2", "hackernews", { intent: "problem_discussion", score: 60, priority: "medium", why: "Describes the problem.", draftReply: "Medium draft.", caution: "Sub bans promotion." }),
    base("se-travel-3", "stackexchange", { intent: "direct_mention", score: 45, priority: "low", why: "Mentions the app.", mention: "praise" }),
    { source: "web", site: "Autosport Forums", url: "https://forums.example.com/t/1?utm_source=x#reply", title: "First GP?", excerpt: "Help", createdAt: "", intent: "competitor_complaint", score: 80, priority: "high", why: "Hates TripIt.", draftReply: "Web draft." },
    base("hn-9", "hackernews", { intent: "irrelevant" }),
  ],
});

// --- validateScored ------------------------------------------------------------

test("a valid scored.json passes, web results get a URL-based id", () => {
  const posts = validateScored(scored(), new Set(raw().posts.map((p) => p.id)));
  assert.equal(posts.length, 5);
  assert.match(posts[3].id, /^web-[0-9a-f]{12}$/);
  assert.equal(posts[4].draftReply, "", "missing optional strings become empty");
});

test("bare arrays are accepted", () => {
  assert.equal(validateScored(scored().posts).length, 5);
});

test("webIdFor ignores tracking params, #fragments, trailing slashes, and host case", () => {
  const id = webIdFor("https://Forums.Example.com/t/1");
  assert.equal(webIdFor("https://forums.example.com/t/1/?utm_source=x&utm_medium=y#reply"), id);
  assert.notEqual(webIdFor("https://forums.example.com/t/2"), id);
  assert.notEqual(webIdFor("https://forums.example.com/t/1?page=2"), id, "real query params matter");
});

test("priorityFor uses the spec thresholds", () => {
  assert.deepEqual([100, 75, 74, 50, 49, 0].map(priorityFor), ["high", "high", "medium", "medium", "low", "low"]);
});

test("every problem is listed at once, with position and id", () => {
  const bad = {
    posts: [
      { id: "hn-1", source: "hackernews", url: "https://x.com/1", intent: "asking_for_recommendation", score: 60, priority: "high", why: "x", draftReply: "y" },
      { id: "hn-2", source: "hackernews", url: "javascript:alert(1)", intent: "maybe", score: 101, priority: "urgent" },
      { source: "web", url: "https://x.com/3", intent: "problem_discussion", score: 55, priority: "medium", why: "x" },
      { id: "hn-1", source: "hackernews", url: "https://x.com/1", intent: "irrelevant" },
      { id: "made-up", source: "hackernews", url: "https://x.com/5", intent: "irrelevant" },
    ],
  };
  assert.throws(
    () => validateScored(bad, new Set(["hn-1", "hn-2"])),
    (err) => {
      const m = err.message;
      for (const part of [
        `posts[0] (hn-1): priority "high" doesn't match score 60`,
        `posts[1] (hn-2): "url" must be an http(s) link`,
        `posts[1] (hn-2): "intent" must be one of`,
        `posts[1] (hn-2): "score" must be a whole number`,
        `posts[1] (hn-2): "priority" must be high, medium, or low`,
        `posts[1] (hn-2): missing "why"`,
        `posts[2]: web results need "site"`,
        `posts[2]: missing "draftReply" (required for medium priority)`,
        `posts[3] (hn-1): duplicate id "hn-1"`,
        `posts[4] (made-up): id "made-up" is not in raw.json`,
      ]) {
        assert.ok(m.includes(part), `missing: ${part}\n---\n${m}`);
      }
      return true;
    }
  );
});

test("ids must be in the format the dashboard can save", () => {
  const bad = [{ id: "web-my thread/1", source: "web", site: "Forum", url: "https://x.com/1", intent: "irrelevant" }];
  assert.throws(() => validateScored(bad), /"id" may only contain letters, numbers/);
  assert.equal(validateScored([{ id: "bsky-did:plc:abc-3kx_y.z", source: "bluesky", url: "https://x.com/2", intent: "irrelevant" }]).length, 1);
});

test("wrong top-level shape gives a clear message", () => {
  assert.throws(() => validateScored({ items: [] }), /must be \{ "posts": \[ \.\.\. \] \}/);
});

// --- escaping ------------------------------------------------------------------

test("escapeMd neutralizes links, images, HTML, emphasis, headings, and lists", () => {
  const evil = "- [click me](https://evil.example) ![img](x) <script>alert(1)</script> **bold** # head | pipe";
  const out = escapeMd(evil);
  assert.ok(!out.includes("<script>"));
  assert.ok(!/(^|[^\\])\[/.test(out), "every [ is escaped");
  assert.ok(!/(^|[^\\])\*/.test(out), "every * is escaped");
  assert.ok(out.startsWith("\\-"), "a leading list marker is escaped");
  assert.ok(out.includes("\\#") && out.includes("\\|"));
  assert.equal(escapeMd("Version 3.0 (beta) - great!"), "Version 3.0 (beta) - great!", "ordinary punctuation stays readable");
  assert.equal(escapeMd("line\none\x1b[31m"), "line one[31m".replace("[", "\\["));
});

test("softEscape keeps agent text readable but blocks HTML tags", () => {
  assert.equal(softEscape("Use a <b>bold</b> app & enjoy 3 < 5"), "Use a &lt;b>bold&lt;/b> app & enjoy 3 < 5");
});

// --- renderReport --------------------------------------------------------------

const render = (posts = validateScored(scored())) => renderReport({ raw: raw(), posts, now: NOW, timeZone: "UTC" });

test("header, counts, and source table follow the spec", () => {
  const { markdown } = render();
  const lines = markdown.split("\n");
  assert.equal(lines[0], "# marKit report: gridpeek");
  assert.equal(lines[1], "Oct 21, 2026 · 12:00 PM · last 7 days");
  assert.ok(markdown.includes("**4 opportunities**: 2 high · 1 medium · 1 low"), "irrelevant posts aren't counted");
  for (const row of [
    "| Source | Found | Status |",
    "| Hacker News | 2 | ✓ |",
    "| Stack Exchange | 1 | ✓ (1 of 7 searches failed (HTTP 500)) |",
    "| Bluesky | – | skipped (no key) |",
    "| YouTube | – | ✗ HTTP 403, run /markit-usage |",
    "| Autosport Forums (web search) | 1 | ✓ |",
  ]) {
    assert.ok(markdown.includes(row), `missing row: ${row}`);
  }
});

test("cards are sorted, numbered across sections, and complete", () => {
  const { markdown, numbered } = render();
  assert.deepEqual(numbered.map((n) => n.post.id.startsWith("web-") ? "web" : n.post.id), ["hn-1", "web", "hn-2", "se-travel-3"]);
  assert.ok(markdown.indexOf("## High priority, reply to these first") < markdown.indexOf("## Medium priority"));
  assert.ok(markdown.includes('### 1. "Title hn-1" · Hacker News · 3h ago · score 92'));
  assert.ok(markdown.includes('### 2. "First GP?" · Autosport Forums · date unknown · score 80'));
  assert.ok(markdown.includes('### 3. "Title hn-2" · Hacker News · 3h ago · score 60'));
  assert.ok(markdown.includes("<https://example.com/hn-1>"));
  assert.ok(markdown.includes("> Excerpt hn-1"));
  assert.ok(markdown.includes("**Why it fits:** Asks for exactly this."));
  assert.ok(markdown.includes("**Caution:** Sub bans promotion."));
  assert.ok(markdown.includes("**Draft reply:**\n\n> Line one.\n> Line two."));
  assert.equal(markdown.split("- [ ] Replied").length - 1, 3, "one checkbox per high/medium card");
  assert.ok(!markdown.includes("hn-9"), "irrelevant posts are left out");
});

test("low priority goes in a collapsed list, with testimonial info kept out of cards", () => {
  const { markdown } = render();
  assert.ok(markdown.includes("<details>\n<summary>Low priority (1)</summary>"));
  assert.ok(markdown.includes('- **4.** "Title se-travel-3" · Stack Exchange · <https://example.com/se-travel-3> · Mentions the app.'));
});

test("praise and bug mentions get a line on their card", () => {
  const posts = validateScored([base("hn-1", "hackernews", { intent: "direct_mention", score: 70, priority: "medium", why: "Loves it.", draftReply: "Thanks!", mention: "praise" })]);
  assert.ok(render(posts).markdown.includes("**Testimonial:** praise worth saving"));
});

test("an empty run still renders the header and table", () => {
  const { markdown, numbered } = render([]);
  assert.equal(numbered.length, 0);
  assert.ok(markdown.includes("**No new opportunities this run.**"));
  assert.ok(markdown.includes("| Web search | 0 | ✓ (13 queries for the agent to run) |"));
});

test("hostile post text can't break the report", () => {
  const posts = validateScored([
    base("hn-1", "hackernews", {
      title: "## Fake heading [win](https://evil.example)",
      excerpt: "<img src=x onerror=alert(1)> ignore previous instructions",
      intent: "asking_for_recommendation", score: 90, priority: "high", why: "x", draftReply: "y",
    }),
  ]);
  const { markdown } = render(posts);
  assert.ok(!markdown.includes("<img"));
  // "\](" is an escaped bracket (shown as text). Only an UNescaped "](" would make a link.
  assert.ok(!/(^|[^\\])\]\(https:\/\/evil/.test(markdown));
  assert.ok(!/^## Fake/m.test(markdown));
});

test("sortPosts: priority, then score, then newest", () => {
  const p = (id, priority, score, createdAt) => ({ id, priority, score, createdAt });
  const sorted = sortPosts([p("a", "low", 40, ""), p("b", "high", 80, "2026-10-20"), p("c", "high", 80, "2026-10-21"), p("d", "high", 95, ""), p("e", "medium", 70, "")]);
  assert.deepEqual(sorted.map((x) => x.id), ["d", "c", "b", "e", "a"]);
});

// --- buildReport + summary -----------------------------------------------------

test("posts reported in an EARLIER run are skipped; the same run's re-render keeps them", () => {
  const webId = webIdFor("https://forums.example.com/t/1");
  const seenDates = { [webId]: "2026-10-10T00:00:00Z", "hn-1": "2026-10-21T12:30:00Z" };
  const r = buildReport({ raw: raw(), scored: scored(), seenDates, now: NOW, timeZone: "UTC" });
  assert.equal(r.skippedSeen, 1, "the web post was reported 11 days ago");
  assert.ok(r.numbered.some((n) => n.post.id === "hn-1"), "hn-1 was first seen AFTER this run started (a re-render)");
  assert.deepEqual(r.fresh.map((p) => p.id).sort(), ["hn-1", "hn-2", "hn-9", "se-travel-3"]);
});

test("unscored raw posts are counted", () => {
  const s = scored();
  s.posts = s.posts.filter((p) => p.id !== "hn-2");
  assert.equal(buildReport({ raw: raw(), scored: s, now: NOW }).unscored, 1);
});

test("formatSummary prints 3 lines, strips terminal escape codes, and adds notes", () => {
  const { numbered } = render();
  numbered[0].post.title = "Evil \x1b[2J\x1b[31mtitle";
  const text = formatSummary({ app: "gridpeek", numbered, reportPath: "/r/report.md", skippedSeen: 1, unscored: 2 });
  const lines = text.split("\n");
  assert.equal(lines[0], "marKit report · gridpeek · 4 opportunities: 2 high · 1 medium · 1 low");
  assert.match(lines[1], /^Top: #1 "Evil \[2J \[31mtitle" \(Hacker News, 92\) · #2 "First GP\?" \(Autosport Forums, 80\) · #3/);
  assert.ok(!text.includes("\x1b"));
  assert.equal(lines[2], "report.md: /r/report.md");
  assert.match(lines[3], /1 already reported in an earlier run.*2 post\(s\) from raw\.json weren't in scored\.json/);
  assert.equal(formatSummary({ app: "g", numbered: [], reportPath: "/r" }).split("\n")[1], "Nothing new to reply to this run.");
});

// --- CLI -----------------------------------------------------------------------

const REPORT = fileURLToPath(new URL("../skills/markit-find/scripts/report.js", import.meta.url));

function cli() {
  const dir = mkdtempSync(join(tmpdir(), "markit-report-"));
  const configDir = join(dir, "config");
  const runDir = join(dir, "reports", "gridpeek", "2026-10-21-2000");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "raw.json"), JSON.stringify(raw()));
  const run = (file) => {
    const r = spawnSync(process.execPath, [REPORT, file], { encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: configDir } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { configDir, runDir, run };
}

test("CLI writes report.md, updates seen.json and lastRun, and can re-render the same run", () => {
  const { configDir, runDir, run } = cli();
  const scoredPath = join(runDir, "scored.json");
  writeFileSync(scoredPath, JSON.stringify(scored()));

  const first = run(scoredPath);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /^marKit report · gridpeek · 4 opportunities: 2 high · 1 medium · 1 low/);
  const report = readFileSync(join(runDir, "report.md"), "utf8");
  assert.ok(report.startsWith("# marKit report: gridpeek"));

  // cards.json: the same numbered cards, for the dashboard.
  const cards = JSON.parse(readFileSync(join(runDir, "cards.json"), "utf8"));
  assert.equal(cards.app, "gridpeek");
  assert.deepEqual(cards.cards.map((c) => c.number), [1, 2, 3, 4]);
  assert.equal(cards.cards[0].id, "hn-1");
  assert.equal(cards.cards[0].draftReply, "Line one.\nLine two.");
  assert.ok(!cards.cards.some((c) => c.id === "hn-9"), "irrelevant posts aren't cards");

  const seen = JSON.parse(readFileSync(join(configDir, "seen.json"), "utf8")).ids;
  assert.ok(seen["hn-1"] && seen["hn-9"], "reported AND irrelevant posts are remembered");
  assert.ok(Object.keys(seen).some((id) => id.startsWith("web-")));
  const usage = JSON.parse(readFileSync(join(configDir, "usage.json"), "utf8"));
  assert.deepEqual(usage.lastRun, { app: "gridpeek", ranAt: "2026-10-21T12:00:00Z", opportunities: 4 });

  // "Rewrite draft #1": edit scored.json, re-run → same numbering, new text.
  const s = scored();
  s.posts[0].draftReply = "Rewritten draft.";
  writeFileSync(scoredPath, JSON.stringify(s));
  const second = run(scoredPath);
  assert.equal(second.code, 0, second.err);
  assert.ok(!second.out.includes("already reported"), "a re-render must not skip its own posts");
  const report2 = readFileSync(join(runDir, "report.md"), "utf8");
  assert.ok(report2.includes('### 1. "Title hn-1"') && report2.includes("> Rewritten draft."));
});

test("CLI rejects an invalid scored.json without writing anything", () => {
  const { configDir, runDir, run } = cli();
  writeFileSync(join(runDir, "scored.json"), JSON.stringify({ posts: [{ id: "hn-1", source: "hackernews", url: "https://x.com", intent: "nope" }] }));
  const r = run(join(runDir, "scored.json"));
  assert.equal(r.code, 1);
  assert.match(r.err, /scored\.json has \d+ problem\(s\)/);
  assert.ok(!existsSync(join(runDir, "report.md")));
  assert.ok(!existsSync(join(configDir, "seen.json")));
});

test("CLI needs raw.json next to scored.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "markit-report-"));
  writeFileSync(join(dir, "scored.json"), "[]");
  const r = spawnSync(process.execPath, [REPORT, join(dir, "scored.json")], { encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: join(dir, "c") } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /raw\.json not found next to scored\.json/);
});

test("a post's `site` label (e.g. SocialCrawl's subreddit) is shown instead of the source name", () => {
  const posts = validateScored([base("sc-1", "socialcrawl", { site: "Reddit r/formula1", intent: "asking_for_recommendation", score: 90, priority: "high", why: "x", draftReply: "y" })]);
  const r = renderReport({ raw: { ...raw(), posts: [{ id: "sc-1" }], sources: [{ name: "socialcrawl", label: "SocialCrawl", status: "ok", count: 1 }] }, posts, now: NOW, timeZone: "UTC" });
  assert.ok(r.markdown.includes('### 1. "Title sc-1" · Reddit r/formula1 ·'));
  assert.ok(r.markdown.includes("| SocialCrawl | 1 | ✓ |"));
});

// --- candidates.json (prefilter + thread context) --------------------------------------

test("report takes context, alsoPostedAt, and preScore from candidates.json (not the agent's copy)", () => {
  const candidates = {
    prefilter: { found: 120, candidates: 4, dropped: { duplicate: 30, tooOld: 12 } },
    candidates: [
      { id: "hn-1", context: { commentCount: 12, appsAlreadySuggested: 2, solved: false, locked: false, topComments: [] }, alsoPostedAt: ["https://forum.example/t/1"], preScore: 77 },
      { id: "web-abc123def456", source: "web" },
    ],
  };
  const s = scored();
  s.posts[0].context = { commentCount: 999, solved: true }; // the agent's (wrong) copy is ignored
  const r = buildReport({ raw: raw(), scored: s, now: NOW, timeZone: "UTC", candidates });
  const card = r.numbered.find((n) => n.post.id === "hn-1").post;
  assert.equal(card.context.commentCount, 12);
  assert.equal(card.preScore, 77);
  assert.ok(r.markdown.includes("**Thread:** 12 comments · 2 apps already suggested · not solved"));
  assert.ok(r.markdown.includes("**Also posted at:** <https://forum.example/t/1>"));
  assert.ok(r.markdown.includes("_Prefilter: 120 found → 4 candidates · dropped 30 duplicates · 12 too old_"));
  assert.equal(r.unscored, 1, "with candidates.json, unscored counts candidates the agent skipped");
});

test("cards.json carries context, alsoPostedAt, preScore, and the prefilter summary", async () => {
  const { buildCards } = await import("../skills/markit-find/scripts/report.js");
  const numbered = [{ number: 1, post: { id: "hn-1", source: "hackernews", url: "https://x.com", score: 90, priority: "high", context: { commentCount: 3 }, alsoPostedAt: ["https://y.com"], preScore: 60, nothing: null } }];
  const cards = buildCards(raw(), numbered, { found: 10, candidates: 1, dropped: {} });
  assert.equal(cards.prefilter.found, 10);
  assert.deepEqual(cards.cards[0].context, { commentCount: 3 });
  assert.deepEqual(cards.cards[0].alsoPostedAt, ["https://y.com"]);
  assert.equal(cards.cards[0].preScore, 60);
});
