// Tests for lib/normalize.js: the shared Post shape and text/date helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makePost,
  excerpt,
  stripHtml,
  collapseWhitespace,
  toIsoDate,
  sinceDate,
  relativeTime,
} from "../skills/markit-find/scripts/lib/normalize.js";

test("makePost builds the shared shape with a prefixed id", () => {
  const post = makePost({
    source: "hackernews",
    platformId: 41234567,
    url: "https://news.ycombinator.com/item?id=41234567",
    title: "  Ask HN:\n  F1 apps? ",
    text: "Looking   for\nan app",
    author: "pg",
    createdAt: 1760000000,
    engagement: { score: 12, comments: 4 },
    matchedKeyword: "F1 schedule app",
  });
  assert.deepEqual(post, {
    id: "hn-41234567",
    source: "hackernews",
    url: "https://news.ycombinator.com/item?id=41234567",
    title: "Ask HN: F1 apps?",
    excerpt: "Looking for an app",
    author: "pg",
    createdAt: "2025-10-09T08:53:20Z",
    engagement: { score: 12, comments: 4 },
    matchedKeyword: "F1 schedule app",
  });
});

test("makePost requires source and platformId", () => {
  assert.throws(() => makePost({ source: "hackernews" }), /required/);
});

test("excerpt keeps short text and cuts long text at a word with …", () => {
  assert.equal(excerpt("short text"), "short text");
  const long = "word ".repeat(200);
  const cut = excerpt(long);
  assert.ok(cut.length <= 501);
  assert.ok(cut.endsWith("word…"));
});

test("stripHtml removes tags and decodes entities", () => {
  assert.equal(collapseWhitespace(stripHtml("<p>I&#x27;m stuck</p><p>Any &quot;app&quot; &amp; tips?</p>")), "I'm stuck Any \"app\" & tips?");
  assert.equal(stripHtml("a<br>b"), "a b");
  assert.equal(stripHtml("&#128512;"), "😀");
  assert.equal(stripHtml("&bogus;"), "&bogus;");
});

test("toIsoDate handles seconds, milliseconds, strings, and junk", () => {
  assert.equal(toIsoDate(1760000000), "2025-10-09T08:53:20Z");
  assert.equal(toIsoDate(1760000000000), "2025-10-09T08:53:20Z");
  assert.equal(toIsoDate("2026-10-21T08:00:00.000Z"), "2026-10-21T08:00:00Z");
  assert.equal(toIsoDate("not a date"), "");
  assert.equal(toIsoDate(undefined), "");
});

test("sinceDate goes back N days", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  assert.equal(sinceDate(7, now).toISOString(), "2026-10-14T12:00:00.000Z");
});

test("relativeTime gives short human ages", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  assert.equal(relativeTime("2026-10-21T11:59:50Z", now), "just now");
  assert.equal(relativeTime("2026-10-21T11:55:00Z", now), "5m ago");
  assert.equal(relativeTime("2026-10-21T10:00:00Z", now), "2h ago");
  assert.equal(relativeTime("2026-10-18T12:00:00Z", now), "3d ago");
  assert.equal(relativeTime("2026-09-01T12:00:00Z", now), "7w ago");
  assert.equal(relativeTime("", now), "unknown date");
});

test("searchQuery keeps the topic and drops filler/intent words", async () => {
  const { searchQuery } = await import("../skills/markit-find/scripts/lib/normalize.js");
  assert.equal(searchQuery("app for planning F1 race weekend"), "F1 race weekend");
  assert.equal(searchQuery("going to my first Grand Prix"), "first Grand Prix");
  assert.equal(searchQuery("how to organize Grand Prix trip"), "Grand Prix trip");
  assert.equal(searchQuery("alternative to TripIt"), "TripIt");
  assert.equal(searchQuery("What app do you use?"), "What app do you use?", "all filler → keep the original");
});

test("makePost keeps platform-reported languages, normalized", async () => {
  const { makePost, normalizeLangs } = await import("../skills/markit-find/scripts/lib/normalize.js");
  assert.deepEqual(makePost({ source: "x", platformId: 1, url: "u", lang: "en-US" }).lang, ["en-us"]);
  assert.equal(makePost({ source: "x", platformId: 1, url: "u" }).lang, undefined, "unknown language → no field");
  assert.deepEqual(normalizeLangs(["EN", "not a code!", 5, "pt"]), ["en", "pt"]);
});
