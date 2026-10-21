// Tests for lib/profile.js: app profile validation and cleanup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProfile, DEFAULT_SOURCES } from "../skills/markit-find/scripts/lib/profile.js";

const good = () => ({
  url: "https://example.com",
  oneLiner: "F1 companion app for planning race weekends",
  audience: "Formula 1 fans who follow every session",
  keywords: ["app for F1 race weekend", "F1 schedule app", "how do you track F1 sessions"],
});

test("a minimal profile gets sensible defaults", () => {
  const { profile, warnings } = validateProfile(good(), "gridpeek");
  assert.deepEqual(warnings, []);
  assert.equal(profile.name, "gridpeek");
  assert.equal(profile.url, "https://example.com");
  assert.equal(profile.description, "");
  assert.deepEqual(profile.competitors, []);
  assert.deepEqual(profile.exclude, []);
  assert.deepEqual(profile.sources, DEFAULT_SOURCES);
  assert.ok(!profile.sources.includes("x") && !profile.sources.includes("socialcrawl"), "paid sources are opt-in");
  assert.deepEqual(profile.stackexchangeSites, ["softwarerecs"]);
  assert.equal(profile.replyTone, "casual, friendly, short");
  assert.equal("lookbackDays" in profile, false, "missing lookbackDays falls back to settings.json");
});

test("lists are trimmed and de-duplicated (ignoring case)", () => {
  const input = { ...good(), keywords: ["  F1 schedule app ", "f1 SCHEDULE app", "best app for F1", "", "alternative to Foo"] };
  const { profile } = validateProfile(input, "gridpeek");
  assert.deepEqual(profile.keywords, ["F1 schedule app", "best app for F1", "alternative to Foo"]);
});

test("every problem is reported at once", () => {
  assert.throws(
    () => validateProfile({ url: "ftp://nope", keywords: "not a list", sources: ["hackernews", "myspace"], lookbackDays: 99 }, "Bad Name"),
    (err) => {
      for (const part of ["not allowed", '"url" must be', '"oneLiner" is required', '"audience" is required', '"keywords" is required', "Unknown source(s): myspace", '"lookbackDays"']) {
        assert.ok(err.message.includes(part), `missing: ${part}\n${err.message}`);
      }
      return true;
    }
  );
});

test("more than 8 keywords is an error", () => {
  const keywords = Array.from({ length: 9 }, (_, i) => `best app number ${i}`);
  assert.throws(() => validateProfile({ ...good(), keywords }, "gridpeek"), /use 8 at most/);
});

test("too few or single-word keywords produce warnings, not errors", () => {
  const { warnings } = validateProfile({ ...good(), keywords: ["F1"] }, "gridpeek");
  assert.ok(warnings.some((w) => w.includes("Only 1 keyword")));
  assert.ok(warnings.some((w) => w.includes('"F1" is a single word')));
});

test("name in JSON must match --name", () => {
  assert.throws(() => validateProfile({ ...good(), name: "other" }, "gridpeek"), /doesn't match --name/);
  assert.equal(validateProfile({ ...good(), name: "gridpeek" }).profile.name, "gridpeek");
});

test("unknown fields are dropped with a warning", () => {
  const { profile, warnings } = validateProfile({ ...good(), colour: "red" }, "gridpeek");
  assert.equal("colour" in profile, false);
  assert.ok(warnings.some((w) => w.includes('"colour"')));
});

test("optional fields are kept when valid", () => {
  const input = { ...good(), lookbackDays: 3, sources: ["HackerNews", "x"], stackexchangeSites: ["softwarerecs", "android"], replyTone: "short" };
  const { profile } = validateProfile(input, "gridpeek");
  assert.equal(profile.lookbackDays, 3);
  assert.deepEqual(profile.sources, ["hackernews", "x"]);
  assert.deepEqual(profile.stackexchangeSites, ["softwarerecs", "android"]);
  assert.equal(profile.replyTone, "short");
});

test("non-object input is rejected", () => {
  assert.throws(() => validateProfile(null, "a"), /must be a JSON object/);
  assert.throws(() => validateProfile([], "a"), /must be a JSON object/);
});

test("features are optional, cleaned, and limited", () => {
  assert.deepEqual(validateProfile(good(), "gridpeek").profile.features, []);
  const { profile } = validateProfile({ ...good(), features: [" session timers ", "Session timers", "weekend schedule"] }, "gridpeek");
  assert.deepEqual(profile.features, ["session timers", "weekend schedule"]);
  assert.throws(() => validateProfile({ ...good(), features: "timers" }, "gridpeek"), /"features" must be a list/);
  assert.throws(() => validateProfile({ ...good(), features: Array.from({ length: 11 }, (_, i) => `feature ${i}`) }, "gridpeek"), /10 most important/);
});

test("languages defaults to English and validates codes", () => {
  assert.deepEqual(validateProfile(good(), "gridpeek").profile.languages, ["en"]);
  assert.deepEqual(validateProfile({ ...good(), languages: ["EN", "pt-BR"] }, "gridpeek").profile.languages, ["en", "pt-br"]);
  assert.throws(() => validateProfile({ ...good(), languages: ["english!"] }, "gridpeek"), /Invalid language code/);
  assert.throws(() => validateProfile({ ...good(), languages: [] }, "gridpeek"), /"languages" must be a list/);
});

test("old SocialCrawl-for-Reddit profiles are upgraded to the \"reddit\" source", async () => {
  const { validateProfile } = await import("../skills/markit-find/scripts/lib/profile.js");
  const base = { name: "gridpeek", url: "https://x.example", oneLiner: "o", audience: "a", keywords: ["a b c", "d e f", "g h i"] };
  const sources = (extra) => validateProfile({ ...base, ...extra }).profile.sources;
  // Before Reddit providers, "socialcrawl" alone meant Reddit (platforms defaulted to ["reddit"]).
  assert.deepEqual(sources({ sources: ["hackernews", "socialcrawl", "web"] }), ["hackernews", "reddit", "web"]);
  assert.deepEqual(sources({ sources: ["socialcrawl"], socialcrawlPlatforms: ["Reddit", "threads"] }), ["reddit", "socialcrawl"]);
  // Threads only: stays "socialcrawl" (which now means Threads through SocialCrawl).
  assert.deepEqual(sources({ sources: ["socialcrawl"], socialcrawlPlatforms: ["threads"] }), ["socialcrawl"]);
  // Already has "reddit": not added twice.
  assert.deepEqual(sources({ sources: ["reddit", "socialcrawl"], socialcrawlPlatforms: ["reddit"] }), ["reddit"]);
  // Saved profiles say ["threads"], which marks them as upgraded: validating again keeps
  // "socialcrawl" as Threads instead of turning it into Reddit a second time.
  const { profile, warnings } = validateProfile({ ...base, sources: ["socialcrawl"], socialcrawlPlatforms: ["reddit"] });
  assert.deepEqual(profile.socialcrawlPlatforms, ["threads"]);
  assert.deepEqual(warnings.filter((w) => /socialcrawlPlatforms/.test(w)), []);
  const resaved = validateProfile({ ...profile, sources: ["reddit", "socialcrawl"] }).profile;
  assert.deepEqual(resaved.sources, ["reddit", "socialcrawl"]);
});

test("\"reddit\" is a default source: it costs nothing until a provider is chosen", async () => {
  const { DEFAULT_SOURCES, ALL_SOURCES } = await import("../skills/markit-find/scripts/lib/profile.js");
  assert.ok(DEFAULT_SOURCES.includes("reddit"));
  assert.ok(ALL_SOURCES.includes("reddit"));
  assert.ok(!DEFAULT_SOURCES.includes("socialcrawl") && !DEFAULT_SOURCES.includes("x"), "paid sources stay opt-in");
});
