// Tests for adapters/youtube.js (fake fetch; field names from the API docs, 2026-10-21).

import { test } from "node:test";
import assert from "node:assert/strict";
import youtube from "../skills/markit-find/scripts/adapters/youtube.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

const KEY = "AIza_SECRET_KEY_123";
const env = { YOUTUBE_API_KEY: KEY };
const since = new Date("2026-10-14T00:00:00Z");

const item = {
  kind: "youtube#searchResult",
  id: { kind: "youtube#video", videoId: "dQw4w9WgXcQ" },
  snippet: {
    publishedAt: "2026-10-19T15:00:00Z",
    channelId: "UC1",
    title: "My first Grand Prix: what I wish I&#39;d known",
    description: "Tickets, hotels &amp; shuttles at COTA…",
    channelTitle: "Pit Lane Vlogs",
  },
};

test("search.list request: newest videos in the window, key sent, one call per keyword", async () => {
  const fetchImpl = fakeFetch([json({ items: [item, { id: { kind: "youtube#channel", channelId: "x" } }] })]);
  const meter = {};
  const posts = await youtube.search("going to my first Grand Prix", { since, limit: 80, env, meter, http: { fetchImpl } });
  const p = fetchImpl.calls[0].url.searchParams;
  assert.equal(fetchImpl.calls[0].url.pathname, "/youtube/v3/search");
  assert.equal(p.get("part"), "snippet");
  assert.equal(p.get("q"), "first Grand Prix");
  assert.equal(p.get("type"), "video");
  assert.equal(p.get("order"), "date");
  assert.equal(p.get("publishedAfter"), since.toISOString());
  assert.equal(p.get("maxResults"), "50", "capped at the API maximum");
  assert.equal(p.get("key"), KEY);
  assert.equal(meter.requests, 1);

  assert.deepEqual(posts, [
    {
      id: "yt-dQw4w9WgXcQ",
      source: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "My first Grand Prix: what I wish I'd known",
      excerpt: "Tickets, hotels & shuttles at COTA…",
      author: "Pit Lane Vlogs",
      createdAt: "2026-10-19T15:00:00Z",
      engagement: {},
      matchedKeyword: "going to my first Grand Prix",
    },
  ]);
});

test("a quota error isn't retried and never leaks the key", async () => {
  const fetchImpl = fakeFetch([json({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403)]);
  await assert.rejects(youtube.search("a b", { since, env, http: { fetchImpl } }), (err) => {
    assert.equal(err.message, "youtube: HTTP 403");
    assert.ok(!`${err.message}${err.stack}`.includes(KEY));
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test("check() uses the cheap i18nLanguages call; 400/403 mean a bad or unusable key", async () => {
  const ok = fakeFetch([json({ items: [] })]);
  assert.equal(await youtube.check(env, { http: { fetchImpl: ok } }), "ok");
  assert.equal(ok.calls[0].url.pathname, "/youtube/v3/i18nLanguages");
  assert.equal(await youtube.check(env, { http: { fetchImpl: fakeFetch([json({}, 400)]) } }), "invalid");
  assert.equal(await youtube.check(env, { http: { fetchImpl: fakeFetch([json({}, 403)]) } }), "invalid");
  assert.equal(await youtube.check(env, { http: { fetchImpl: fakeFetch([new TypeError("x")]) } }), "error");
});

test("shape: needs a key, declares its 100 searches/day quota, check doesn't use it", () => {
  assert.equal(youtube.isEnabled({}), false);
  assert.equal(youtube.isEnabled(env), true);
  assert.deepEqual(youtube.quota, { unit: "requests", label: "searches", period: "day", limit: 100 });
  assert.equal(youtube.checkUsesQuota, false);
});
