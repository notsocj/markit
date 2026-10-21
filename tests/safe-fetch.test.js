// Tests for lib/safe-fetch.js. The most important thing checked here: errors NEVER
// contain the request URL, headers, or key, no matter how the request fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFetch, SourceError } from "../skills/markit-find/scripts/lib/safe-fetch.js";

const SECRET = "sk_SUPER_SECRET_123";
const URL_WITH_KEY = `https://api.example.com/search?q=f1&key=${SECRET}`;
const HEADERS = { Authorization: `Bearer ${SECRET}` };

// A fake fetch that returns a queue of responses (or throws errors), one per call,
// and remembers how many times it was called.
function fakeFetch(...steps) {
  const fn = async (url, init) => {
    fn.calls.push({ url, init });
    const step = steps[Math.min(fn.calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  fn.calls = [];
  return fn;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Fail the test if the secret or URL shows up anywhere in the error.
function assertNoLeak(err) {
  const everything = [err.message, err.stack, String(err), JSON.stringify(err), String(err.cause ?? "")].join("\n");
  assert.ok(!everything.includes(SECRET), "error leaked the key");
  assert.ok(!everything.includes("api.example.com"), "error leaked the URL/host");
  assert.equal(err.cause, undefined, "error must not carry a cause (it could hold the URL)");
}

const fast = { retryDelayMs: 0 };

test("returns parsed JSON on success and passes headers through", async () => {
  const fetchImpl = fakeFetch(json({ hits: [1, 2] }));
  const data = await safeFetch("hackernews", URL_WITH_KEY, { headers: HEADERS, fetchImpl, ...fast });
  assert.deepEqual(data, { hits: [1, 2] });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
});

test("HTTP error → '<source>: HTTP <status>' with status, no URL or key", async () => {
  const fetchImpl = fakeFetch(json({ error: `bad key ${SECRET}` }, 403));
  await assert.rejects(
    safeFetch("youtube", URL_WITH_KEY, { headers: HEADERS, fetchImpl, ...fast }),
    (err) => {
      assert.ok(err instanceof SourceError);
      assert.equal(err.message, "youtube: HTTP 403");
      assert.equal(err.status, 403);
      assertNoLeak(err);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1, "403 must not be retried");
});

test("network error whose message contains the URL is replaced with a safe one", async () => {
  // Node's real fetch errors can mention the URL or host. Simulate the worst case.
  const nodeError = new TypeError(`fetch failed for ${URL_WITH_KEY}`);
  nodeError.cause = new Error(`getaddrinfo ENOTFOUND api.example.com ${SECRET}`);
  const fetchImpl = fakeFetch(nodeError);
  await assert.rejects(safeFetch("bluesky", URL_WITH_KEY, { fetchImpl, ...fast }), (err) => {
    assert.equal(err.message, "bluesky: network error");
    assertNoLeak(err);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 3, "network errors are retried (1 try + 2 retries)");
});

test("timeouts are reported as '<source>: timeout'", async () => {
  const timeout = new DOMException(`The operation timed out (${URL_WITH_KEY})`, "TimeoutError");
  await assert.rejects(safeFetch("threads", URL_WITH_KEY, { fetchImpl: fakeFetch(timeout), ...fast }), (err) => {
    assert.equal(err.message, "threads: timeout");
    assertNoLeak(err);
    return true;
  });
});

test("a real timeout fires when the server is too slow", async () => {
  // This fake fetch never answers on its own; it only stops when the abort signal fires.
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  // AbortSignal.timeout()'s timer deliberately doesn't keep Node's event loop alive. With
  // nothing else pending (no real socket, unlike a real request), Node 20/22 conclude this
  // test can never finish and cancel it, plus every test after it. A plain timer keeps the
  // loop running until the abort fires; it's cleared as soon as the test is done.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(
      safeFetch("x", URL_WITH_KEY, { fetchImpl: hang, timeoutMs: 20, retries: 0 }),
      { message: "x: timeout" }
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("429 and 5xx are retried, then succeed", async () => {
  const fetchImpl = fakeFetch(json({}, 429), json({}, 503), json({ ok: true }));
  const data = await safeFetch("stackexchange", URL_WITH_KEY, { fetchImpl, ...fast });
  assert.deepEqual(data, { ok: true });
  assert.equal(fetchImpl.calls.length, 3);
});

test("gives up after the retries and reports the last status", async () => {
  const fetchImpl = fakeFetch(json({}, 500));
  await assert.rejects(safeFetch("socialcrawl", URL_WITH_KEY, { fetchImpl, retries: 1, ...fast }), (err) => {
    assert.equal(err.message, "socialcrawl: HTTP 500");
    assertNoLeak(err);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2);
});

test("a 200 with a non-JSON body → '<source>: invalid response'", async () => {
  const fetchImpl = fakeFetch(new Response(`<html>${URL_WITH_KEY}</html>`, { status: 200 }));
  await assert.rejects(safeFetch("hackernews", URL_WITH_KEY, { fetchImpl, ...fast }), (err) => {
    assert.equal(err.message, "hackernews: invalid response");
    assertNoLeak(err);
    return true;
  });
});

test("responseType 'text' returns the raw body", async () => {
  const fetchImpl = fakeFetch(new Response("plain text", { status: 200 }));
  assert.equal(await safeFetch("web", "https://example.com", { fetchImpl, responseType: "text" }), "plain text");
});
