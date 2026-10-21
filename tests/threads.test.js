// Tests for adapters/threads.js (fake fetch; field names from the API docs, 2026-10-21).

import { test } from "node:test";
import assert from "node:assert/strict";
import threads from "../skills/markit-find/scripts/adapters/threads.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

const TOKEN = "THAA_SECRET_TOKEN_123";
const env = { THREADS_ACCESS_TOKEN: TOKEN };
const since = new Date("2026-10-14T00:00:00Z");
const NOW = new Date("2026-10-21T00:00:00Z");

const result = {
  id: "18000000000000001",
  text: "Any app that keeps race weekend tickets and plans together offline?",
  media_type: "TEXT_POST",
  permalink: "https://www.threads.com/@racefan/post/ABC123",
  timestamp: "2026-10-20T05:42:03+0000",
  username: "racefan",
  has_replies: true,
  is_reply: false,
};

test("keyword_search request: RECENT, since as unix seconds, fields, token", async () => {
  const fetchImpl = fakeFetch([json({ data: [result, { id: "2" }] })]);
  const meter = {};
  const posts = await threads.search("app for planning F1 race weekend", { since, limit: 25, env, meter, http: { fetchImpl } });
  const u = fetchImpl.calls[0].url;
  assert.equal(u.origin + u.pathname, "https://graph.threads.com/v1.0/keyword_search");
  assert.equal(u.searchParams.get("q"), "F1 race weekend");
  assert.equal(u.searchParams.get("search_type"), "RECENT");
  assert.equal(u.searchParams.get("since"), String(since.getTime() / 1000));
  assert.equal(u.searchParams.get("limit"), "25");
  assert.match(u.searchParams.get("fields"), /permalink/);
  assert.equal(u.searchParams.get("access_token"), TOKEN);
  assert.equal(meter.requests, 1);

  assert.deepEqual(posts, [
    {
      id: "th-18000000000000001",
      source: "threads",
      url: "https://www.threads.com/@racefan/post/ABC123",
      title: "",
      excerpt: "Any app that keeps race weekend tickets and plans together offline?",
      author: "racefan",
      createdAt: "2026-10-20T05:42:03Z",
      engagement: { hasReplies: true },
      matchedKeyword: "app for planning F1 race weekend",
    },
  ]);
});

test("check(): /me ok; OAuth errors (HTTP 400, code 190) mean an invalid or expired token", async () => {
  const ok = fakeFetch([json({ id: "1" })]);
  assert.equal(await threads.check(env, { http: { fetchImpl: ok } }), "ok");
  assert.equal(ok.calls[0].url.pathname, "/v1.0/me");
  const expired = json({ error: { message: "Invalid OAuth 2.0 Access Token", type: "OAuthException", code: 190 } }, 400);
  assert.equal(await threads.check(env, { http: { fetchImpl: fakeFetch([expired]) } }), "invalid");
  assert.equal(await threads.check(env, { http: { fetchImpl: fakeFetch([json({}, 429)]) } }), "quota");
});

test("notes(): days until expiry, missing permission, and the App Review reminder", async () => {
  const in12days = NOW.getTime() / 1000 + 12 * 86400 + 60;
  const debug = fakeFetch([json({ data: { is_valid: true, expires_at: in12days, scopes: ["threads_basic"] } })]);
  const notes = await threads.notes(env, { http: { fetchImpl: debug }, now: NOW });
  assert.deepEqual(notes, ["token expires in 12 days", "token lacks threads_keyword_search", "public search needs Meta App Review (otherwise only your own posts)"]);
  const u = debug.calls[0].url;
  assert.equal(u.pathname, "/v1.0/debug_token");
  assert.equal(u.searchParams.get("input_token"), TOKEN);
  assert.ok(!notes.join(" ").includes(TOKEN));

  const soon = fakeFetch([json({ data: { expires_at: NOW.getTime() / 1000 + 3 * 86400 + 60, scopes: ["threads_basic", "threads_keyword_search"] } })]);
  assert.equal((await threads.notes(env, { http: { fetchImpl: soon }, now: NOW }))[0], "token expires in 3 days → renew soon");
  const past = fakeFetch([json({ data: { expires_at: NOW.getTime() / 1000 - 100 } })]);
  assert.equal((await threads.notes(env, { http: { fetchImpl: past }, now: NOW }))[0], "token expired → renew it");
  const failing = fakeFetch([json({}, 500)]);
  assert.deepEqual(await threads.notes(env, { http: { fetchImpl: failing, retryDelayMs: 0 }, now: NOW }), ["public search needs Meta App Review (otherwise only your own posts)"]);
});

test("shape: needs a token, 2,200 searches/day, not a default source", async () => {
  assert.equal(threads.isEnabled({}), false);
  assert.equal(threads.quota.limit, 2200);
  const { DEFAULT_SOURCES } = await import("../skills/markit-find/scripts/lib/profile.js");
  assert.ok(!DEFAULT_SOURCES.includes("threads"));
});
