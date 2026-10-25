// Tests that EVERY adapter copes with answers that are valid HTTP but useless: an empty
// list/object, or JSON that is just null, a number, or a string (what a broken proxy or an
// API outage page can produce). Each call must either return results or fail with a
// SourceError ("<source>: invalid response"), never crash with a TypeError, and never
// print the key. A fake fetch only: no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS } from "../skills/markit-find/scripts/adapters/index.js";
import { DEFAULT_SETTINGS } from "../skills/markit-find/scripts/lib/config.js";

const KEY = "KEY_that_must_never_show_up_777";
const env = {
  YOUTUBE_API_KEY: KEY, THREADS_ACCESS_TOKEN: KEY, X_BEARER_TOKEN: KEY, SOCIALCRAWL_API_KEY: KEY,
  SCRAPECREATORS_API_KEY: KEY, APIFY_API_TOKEN: KEY, BLUESKY_HANDLE: "me.example", BLUESKY_APP_PASSWORD: KEY,
};

// Bodies that are JSON-valid but useless. safeFetch refuses `null`, `42` and `"x"` itself;
// adapters that catch per-request errors (Stack Exchange, Bluesky) may then return no posts.
const BAD = ["null", "42", '"x"'];
const EMPTY = ["[]", "{}"];

function options(text) {
  const fetchImpl = async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  return {
    since: new Date(Date.now() - 7 * 86400000), now: new Date(), env, settings: { ...DEFAULT_SETTINGS },
    meter: {}, http: { fetchImpl, retryDelayMs: 0 }, limit: 10, platforms: ["reddit", "threads"],
    budget: { posts: 50, credits: 500, usd: 5, unit: "posts" }, appNames: ["gridpeek"],
  };
}
const post = { id: "hn-1", platformId: "1", url: "https://example.com/1", author: "u", uri: "at://did:plc:x/app.bsky.feed.post/y" };

// Every call an adapter offers that reads an API answer.
function calls(adapter, o) {
  const list = [["search", () => adapter.search("a b", o)]];
  if (adapter.searchAll) list.push(["searchAll", () => adapter.searchAll(["a b"], o)]);
  if (adapter.context) list.push(["context", () => adapter.context({ ...post, source: adapter.name }, o)]);
  return list;
}

// Run one call. Passing means: it returned something, or it threw a SourceError. A TypeError
// (or anything else) means the adapter trusted the shape of the answer.
async function settle(label, run) {
  try {
    return { result: await run() };
  } catch (err) {
    assert.equal(err.name, "SourceError", `${label}: ${err.name}: ${err.message}`);
    assert.ok(!String(err.stack).includes(KEY), `${label}: key in error`);
    return { error: err };
  }
}

for (const adapter of ADAPTERS) {
  test(`${adapter.name}: null/number/string/empty answers never crash or leak the key`, async () => {
    for (const text of [...BAD, ...EMPTY]) {
      for (const [fn, run] of calls(adapter, options(text))) {
        const { result } = await settle(`${adapter.name}.${fn} on ${text}`, run);
        // Whatever came back for a search is a (usually empty) list of posts.
        if (fn !== "context" && result !== undefined) assert.ok(Array.isArray(result), `${adapter.name}.${fn} on ${text} returned a non-list`);
      }
    }
  });
}
