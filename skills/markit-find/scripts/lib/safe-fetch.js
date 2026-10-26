// safe-fetch.js — the ONE way marKit talks to the network.
//
// It wraps Node's built-in fetch() and adds three things:
//   1. A timeout, so a slow API can't hang the whole run.
//   2. A couple of retries for temporary problems (rate limits, server hiccups).
//   3. Key-safe errors. Request URLs and headers can contain API keys
//      (e.g. YouTube puts the key in the URL as ?key=...). Node's own fetch errors
//      sometimes include the URL or host, so we never pass them along. Every error
//      that leaves this file says only "<source>: HTTP <status>" (or "timeout" /
//      "network error"), and nothing else.

/**
 * The only kind of error safeFetch throws.
 * `status` lets adapters tell "bad key" (401/403) apart from "out of quota" (429).
 * It deliberately has NO `cause`, because the original error could contain the URL.
 */
export class SourceError extends Error {
  constructor(source, detail, status = null) {
    super(`${source}: ${detail}`);
    this.name = "SourceError";
    this.source = source;
    this.status = status;
  }
}

// Status codes worth trying again: 429 = "slow down", 5xx = the server had a problem.
// Anything else (400 bad request, 401 bad key, 404...) won't fix itself on retry.
function isRetryable(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a URL and return the parsed body.
 *
 * @param {string} source - adapter name, used in error messages (e.g. "hackernews")
 * @param {string} url - full request URL (may contain a key, so it is never logged)
 * @param {object} [options]
 * @param {string} [options.method="GET"]
 * @param {object} [options.headers]
 * @param {string} [options.body]
 * @param {"json"|"text"} [options.responseType="json"]
 * @param {number} [options.timeoutMs=15000] - give up on one attempt after this long
 * @param {number} [options.retries=2] - extra attempts after the first one fails
 * @param {number} [options.retryDelayMs=500] - first wait between attempts (doubles each time)
 * @param {number[]} [options.noRetryStatuses] - statuses that must NOT be retried even though they
 *   normally would be (e.g. Stack Exchange's 502, which means "you are being throttled")
 * @param {Function} [options.fetchImpl] - swap in a fake fetch for tests
 */
export async function safeFetch(source, url, options = {}) {
  const {
    method = "GET",
    headers,
    body,
    responseType = "json",
    timeoutMs = 15000,
    retries = 2,
    retryDelayMs = 500,
    noRetryStatuses = [],
    fetchImpl = globalThis.fetch,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Wait before every retry: 500ms, then 1000ms, then 2000ms... ("exponential backoff").
    if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));

    let res;
    try {
      // AbortSignal.timeout() cancels the request automatically after timeoutMs.
      res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // We look at the error's NAME only, never its message (the message may hold the URL).
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      lastError = new SourceError(source, timedOut ? "timeout" : "network error");
      continue; // network problems are often temporary, so try again
    }

    if (!res.ok) {
      lastError = new SourceError(source, `HTTP ${res.status}`, res.status);
      // Throw away the unread body so Node can reuse the connection. Ignore any error.
      try {
        await res.body?.cancel();
      } catch {}
      if (isRetryable(res.status) && !noRetryStatuses.includes(res.status) && attempt < retries) continue;
      throw lastError;
    }

    try {
      if (responseType === "text") return await res.text();
      const data = await res.json();
      // Every API we call answers with a JSON object or list. A bare null/number/string
      // (a broken proxy, say) would crash adapters that read data.something.
      if (data === null || typeof data !== "object") throw new Error();
      return data;
    } catch {
      // The API answered 200 but sent something that isn't JSON (e.g. an HTML error page).
      throw new SourceError(source, "invalid response", res.status);
    }
  }

  throw lastError;
}
