// Tests for lib/seen.js (no repeat posts) and lib/usage.js (per-source counts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSeen, filterUnseen, addSeen } from "../skills/markit-find/scripts/lib/seen.js";
import {
  loadUsage,
  recordUsage,
  setLastRun,
  getMonthUsage,
  getDayUsage,
  getRollingUsage,
} from "../skills/markit-find/scripts/lib/usage.js";

const tempFile = (name) => join(mkdtempSync(join(tmpdir(), "markit-test-")), name);

test("seen: empty when the file doesn't exist", () => {
  assert.equal(loadSeen(tempFile("seen.json")).size, 0);
});

test("seen: addSeen + filterUnseen removes already-reported posts", () => {
  const file = tempFile("seen.json");
  addSeen(["hn-1", "hn-2"], file);
  const seen = loadSeen(file);
  const posts = [{ id: "hn-1" }, { id: "hn-3" }];
  assert.deepEqual(filterUnseen(posts, seen), [{ id: "hn-3" }]);
});

test("seen: keeps the first-seen date and prunes very old ids", () => {
  const file = tempFile("seen.json");
  addSeen(["old"], file, new Date("2026-01-01T00:00:00Z"));
  addSeen(["keep"], file, new Date("2026-10-01T00:00:00Z"));
  addSeen(["keep", "new"], file, new Date("2026-10-21T00:00:00Z"));
  const { ids } = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(ids).sort(), ["keep", "new"]);
  assert.equal(ids.keep, "2026-10-01T00:00:00.000Z");
});

test("usage: records requests/posts/credits per month and per day", () => {
  const file = tempFile("usage.json");
  const now = new Date("2026-10-21T12:00:00Z");
  recordUsage("x", { requests: 1, posts: 10 }, file, now);
  recordUsage("x", { requests: 2, posts: 5, credits: 0 }, file, now);
  recordUsage("socialcrawl", { requests: 1, credits: 3 }, file, now);
  const usage = loadUsage(file);
  assert.deepEqual(getMonthUsage("x", usage, now), { requests: 3, posts: 15, credits: 0, context: 0 });
  assert.deepEqual(getDayUsage("socialcrawl", usage, now), { requests: 1, posts: 0, credits: 3, context: 0 });
  assert.deepEqual(getMonthUsage("youtube", usage, now), { requests: 0, posts: 0, credits: 0, context: 0 });
  recordUsage("youtube", { context: 2 }, file, now);
  assert.deepEqual(getDayUsage("youtube", loadUsage(file), now), { requests: 0, posts: 0, credits: 0, context: 2 }, "context calls are counted separately");
});

test("usage: rolling 7-day window and old days are pruned", () => {
  const file = tempFile("usage.json");
  recordUsage("threads", { requests: 100 }, file, new Date("2026-09-01T12:00:00Z")); // way back
  recordUsage("threads", { requests: 5 }, file, new Date("2026-10-14T12:00:00Z")); // 7 days ago: outside
  recordUsage("threads", { requests: 3 }, file, new Date("2026-10-15T12:00:00Z")); // 6 days ago: inside
  recordUsage("threads", { requests: 2 }, file, new Date("2026-10-21T12:00:00Z")); // today
  const usage = loadUsage(file);
  const now = new Date("2026-10-21T18:00:00Z");
  assert.equal(getRollingUsage("threads", usage, 7, now).requests, 5);
  assert.equal(usage.days["2026-09-01"], undefined, "days older than 35 are dropped");
  assert.equal(usage.months["2026-09"].threads.requests, 100, "months are kept");
});

test("usage: lastRun is stored and the file holds counts only", () => {
  const file = tempFile("usage.json");
  recordUsage("hackernews", { requests: 4, posts: 6 }, file);
  setLastRun({ app: "gridpeek", ranAt: "2026-10-21T21:00:00Z", opportunities: 12 }, file);
  const usage = loadUsage(file);
  assert.deepEqual(usage.lastRun, { app: "gridpeek", ranAt: "2026-10-21T21:00:00Z", opportunities: 12 });
  assert.equal(getMonthUsage("hackernews", usage).posts, 6, "setLastRun must not wipe counts");
});
