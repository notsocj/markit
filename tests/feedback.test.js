// Tests for the feedback loop's capture side: lib/feedback.js (validation, storage, 180-day
// pruning, agent verdicts) and feedback.js (recording a decision by card number from chat).
// Temp folders only; no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateDecision, normalizeReason, cleanNote, communityOf, entryFrom, readFeedback, writeFeedback,
  recordDecision, mergeAgentVerdicts, statusMapFrom, prune, KEEP_DAYS, NOTE_MAX, TITLE_MAX, AGENT_REASON,
} from "../skills/markit-find/scripts/lib/feedback.js";
import { prepareDecision, latestRunDir } from "../skills/markit-find/scripts/feedback.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const SECRET = "sk_live_FEEDBACK_MUST_NEVER_STORE_THIS";
const FEEDBACK_CLI = fileURLToPath(new URL("../skills/markit-find/scripts/feedback.js", import.meta.url));

const card = (number, extra = {}) => ({
  number, id: `hn-${number}`, source: "hackernews", url: `https://example.com/${number}`, title: `Title ${number}`,
  matchedKeyword: "alternative to TripIt", intent: "asking_for_recommendation", score: 80, priority: "high", preScore: 60, ...extra,
});

const tempFile = () => join(mkdtempSync(join(tmpdir(), "markit-fb-")), "feedback.json");

// --- validation --------------------------------------------------------------------------

test("validateDecision: only known statuses and reasons; reasons only with skipped", () => {
  assert.equal(validateDecision({ status: "deleted" }).ok, false, "bad status");
  assert.equal(validateDecision({ status: ["replied"] }).ok, false, "status must be a string");
  assert.equal(validateDecision({ status: "skipped", reason: "boring" }).ok, false, "bad reason");
  assert.equal(validateDecision({ status: "skipped", reason: AGENT_REASON }).ok, false, "users can't pick the agent's reason");
  assert.equal(validateDecision({ status: "replied", reason: "other" }).ok, false, "Replied needs no reason");
  assert.equal(validateDecision({ status: "skipped", note: 42 }).ok, false, "note must be text");
  assert.deepEqual(validateDecision({ status: "skipped", reason: "wrong_meaning" }), { ok: true, status: "skipped", reason: "wrong_meaning", note: "" });
  assert.deepEqual(validateDecision({ status: "replied" }), { ok: true, status: "replied", reason: "", note: "" });
  assert.equal(validateDecision({ status: "open" }).ok, true);
});

test("notes: HTML stripped (even escaped HTML), control characters removed, trimmed, cut to 140", () => {
  assert.equal(cleanNote("  <b>mods</b> remove <a href='x'>links</a>  "), "mods remove links");
  assert.equal(cleanNote("&lt;script&gt;alert(1)&lt;/script&gt; hi"), "scriptalert(1)/script hi");
  assert.equal(cleanNote("line\u0000one\u001b[31m\nline two"), "line one [31m line two");
  const long = cleanNote("word ".repeat(100));
  assert.ok(long.length <= NOTE_MAX);
  assert.equal(validateDecision({ status: "skipped", note: "x".repeat(500) }).note.length, NOTE_MAX);
});

test("normalizeReason accepts codes and the visible labels, rejects anything else", () => {
  assert.equal(normalizeReason("wrong meaning"), "wrong_meaning");
  assert.equal(normalizeReason("Community bans promotion"), "bans_promotion");
  assert.equal(normalizeReason("too-promotional"), "too_promotional");
  assert.equal(normalizeReason("Too promotional to reply"), "too_promotional");
  assert.equal(normalizeReason("NOT_MY_AUDIENCE"), "not_my_audience");
  assert.equal(normalizeReason(""), "");
  assert.equal(normalizeReason(undefined), "");
  assert.equal(normalizeReason("agent_irrelevant"), null);
  assert.equal(normalizeReason("boring"), null);
});

test("communityOf: subreddit, Stack Exchange site, web site, platform", () => {
  assert.equal(communityOf({ source: "socialcrawl", site: "Reddit r/formula1" }), "r/formula1");
  assert.equal(communityOf({ source: "stackexchange", id: "se-softwarerecs-123" }), "Stack Exchange softwarerecs");
  assert.equal(communityOf({ source: "web", site: "Autosport Forums" }), "Autosport Forums");
  assert.equal(communityOf({ source: "hackernews" }), "Hacker News");
});

test("entryFrom copies only allow-listed fields and cuts the title to 120", () => {
  const e = entryFrom(card(1, { title: "<i>Any</i> app " + "x".repeat(300), draftReply: "secret draft", engagement: { score: 9 }, author: "alice", token: SECRET }), { app: "gridpeek", status: "replied", decidedAt: NOW.toISOString() });
  assert.deepEqual(Object.keys(e).sort(), ["app", "community", "decidedAt", "id", "intent", "matchedKeyword", "note", "preScore", "reason", "score", "source", "status", "title"].sort());
  assert.ok(e.title.startsWith("Any app "));
  assert.ok(e.title.length <= TITLE_MAX);
  assert.ok(!JSON.stringify(e).includes(SECRET));
});

// --- storage -----------------------------------------------------------------------------

test("recordDecision: one entry per card, 'open' removes it, statusMapFrom feeds the dashboard", () => {
  const file = tempFile();
  recordDecision(file, { card: card(1), app: "gridpeek", status: "skipped", reason: "already_solved", note: "fixed", now: NOW });
  recordDecision(file, { card: card(1), app: "gridpeek", status: "replied", reason: "other", now: NOW });
  const entries = readFeedback(file, { now: NOW });
  assert.equal(entries.length, 1, "the newer decision replaced the old one");
  assert.equal(entries[0].status, "replied");
  assert.equal(entries[0].reason, "", "Replied never stores a reason");
  assert.deepEqual(statusMapFrom(entries), { "hn-1": { status: "replied", updatedAt: NOW.toISOString(), reason: "", note: "" } });
  recordDecision(file, { card: card(1), app: "gridpeek", status: "open", now: NOW });
  assert.deepEqual(readFeedback(file, { now: NOW }), []);
});

test("entries older than 180 days are pruned on read and on write", () => {
  const file = tempFile();
  const keep = entryFrom(card(1), { app: "a", status: "replied", decidedAt: daysAgo(KEEP_DAYS - 1) });
  const old = entryFrom(card(2), { app: "a", status: "skipped", decidedAt: daysAgo(KEEP_DAYS + 1) });
  writeFileSync(file, JSON.stringify({ version: 1, entries: [keep, old, { junk: true }] }));
  assert.deepEqual(readFeedback(file, { now: NOW }).map((e) => e.id), ["hn-1"]);
  writeFeedback(file, [keep, old], NOW);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries.map((e) => e.id), ["hn-1"]);
  assert.equal(prune([old], NOW).length, 0);
});

test("the old status.json is imported when feedback.json doesn't exist yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "markit-fb-"));
  const legacy = join(dir, "status.json");
  writeFileSync(legacy, JSON.stringify({ ids: { "hn-7": { status: "skipped", updatedAt: daysAgo(3) }, "../x": { status: "replied" } } }));
  const entries = readFeedback(join(dir, "feedback.json"), { legacyStatusFile: legacy, now: NOW });
  assert.deepEqual(entries.map((e) => [e.id, e.status]), [["hn-7", "skipped"]]);
});

test("mergeAgentVerdicts: adds irrelevant posts, never overrides the user, removes changed verdicts", () => {
  const user = entryFrom(card(2), { app: "gridpeek", status: "replied", decidedAt: daysAgo(1) });
  const stale = entryFrom(card(3), { app: "gridpeek", status: "skipped", reason: AGENT_REASON, decidedAt: daysAgo(1) });
  const out = mergeAgentVerdicts([user, stale], {
    app: "gridpeek",
    now: NOW,
    posts: [card(1, { intent: "irrelevant", score: undefined }), card(2, { intent: "irrelevant" }), card(3, { intent: "problem_discussion" })],
  });
  const byId = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.equal(byId["hn-1"].reason, AGENT_REASON);
  assert.equal(byId["hn-1"].status, "skipped");
  assert.equal(byId["hn-1"].score, null);
  assert.equal(byId["hn-2"].status, "replied", "the user's decision wins");
  assert.equal(byId["hn-3"], undefined, "the agent changed its mind");
  assert.deepEqual(Object.keys(statusMapFrom(out)), ["hn-2"], "agent verdicts aren't dashboard marks");
});

// --- feedback.js (chat) ------------------------------------------------------------------

/** A temp config + reports folder with one run that has cards.json, and a secret .env. */
function cliFixture() {
  const home = mkdtempSync(join(tmpdir(), "markit-fbcli-"));
  const configDir = join(home, "config");
  const reportsDir = join(home, "reports");
  mkdirSync(join(configDir, "apps"), { recursive: true });
  writeFileSync(join(configDir, ".env"), `X_BEARER_TOKEN=${SECRET}\nSOCIALCRAWL_API_KEY=${SECRET}\n`);
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ reportsDir }));
  const runDir = join(reportsDir, "gridpeek", "2026-10-22-0900");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "cards.json"), JSON.stringify({ app: "gridpeek", ranAt: NOW.toISOString(), cards: [card(1), card(2, { source: "socialcrawl", site: "Reddit r/formula1", id: "sc-2" }), card(3)] }));
  const run = (...args) => spawnSync(process.execPath, [FEEDBACK_CLI, ...args], { encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: configDir } });
  return { configDir, reportsDir, runDir, run, feedbackFile: join(configDir, "feedback.json") };
}

test("prepareDecision finds the card by number and checks everything", () => {
  const { runDir } = cliFixture();
  const d = prepareDecision({ runDir, card: "2", status: "skipped", reason: "Community bans promotion", note: "<b>no links</b>" });
  assert.deepEqual([d.card.id, d.app, d.status, d.reason, d.note], ["sc-2", "gridpeek", "skipped", "bans_promotion", "no links"]);
  assert.throws(() => prepareDecision({ runDir, card: "9", status: "skipped" }), /no card #9 in this run \(it has 3\)/);
  assert.throws(() => prepareDecision({ runDir, card: "two", status: "skipped" }), /--card must be a card number/);
  assert.throws(() => prepareDecision({ runDir, card: "1", status: "skipped", reason: "boring" }), /unknown reason "boring"/);
  assert.throws(() => prepareDecision({ runDir, card: "1", status: "maybe" }), /status must be one of/);
  assert.throws(() => prepareDecision({ runDir, card: "1", status: "replied", reason: "other" }), /only goes with status skipped/);
  assert.throws(() => prepareDecision({ runDir: join(runDir, "nope"), card: "1", status: "replied" }), /no cards\.json/);
});

test("feedback.js CLI: 'skip #2, bans promotion' by card number, then undo; never touches keys", () => {
  const { runDir, run, feedbackFile } = cliFixture();
  const r = run(runDir, "--card", "2", "--status", "skipped", "--reason", "bans promotion", "--note", "mods remove app links");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /card #2 marked skipped \(Community bans promotion\), with your note/);
  const saved = JSON.parse(readFileSync(feedbackFile, "utf8"));
  assert.deepEqual(saved.entries.map((e) => [e.id, e.community, e.reason, e.note]), [["sc-2", "r/formula1", "bans_promotion", "mods remove app links"]]);

  const undo = run(runDir, "--card", "2", "--status", "open");
  assert.equal(undo.status, 0);
  assert.match(undo.stdout, /back to To do/);
  assert.equal(JSON.parse(readFileSync(feedbackFile, "utf8")).entries.length, 0);

  for (const out of [r.stdout, r.stderr, undo.stdout, readFileSync(feedbackFile, "utf8")]) assert.ok(!out.includes(SECRET), "no key anywhere");
});

test("feedback.js CLI: --app uses the latest run; bad input exits 1 with a clear message", () => {
  const { reportsDir, run, feedbackFile } = cliFixture();
  assert.ok(latestRunDir(reportsDir, "gridpeek").endsWith("2026-10-22-0900"));
  const ok = run("--app", "gridpeek", "--card", "1", "--status", "replied");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(feedbackFile, "utf8")).entries[0].id, "hn-1");

  const bad = run("--app", "gridpeek", "--card", "1", "--status", "skipped", "--reason", "meh");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^marKit: unknown reason/);
  const none = run("--card", "1", "--status", "replied");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /usage: node feedback\.js/);
  assert.ok(existsSync(feedbackFile));
});
