// fake-fetch.js — test helper: a fake fetch() that never touches the network.
//
// Pass a handler (url, init, callNumber) => Response, or a list of Responses returned in
// order. The fake remembers every call (`fn.calls`: { url: URL, init }) so tests can
// check exactly what an adapter sent: endpoint, query params, headers, body.
//
// (This folder isn't picked up as tests: node --test only runs *.test.js files here.)

export function fakeFetch(handlerOrResponses) {
  const fn = async (url, init = {}) => {
    const call = { url: new URL(url), init };
    fn.calls.push(call);
    const n = fn.calls.length;
    let result;
    if (typeof handlerOrResponses === "function") result = await handlerOrResponses(call.url, init, n);
    else result = handlerOrResponses[Math.min(n - 1, handlerOrResponses.length - 1)];
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = [];
  return fn;
}

/** A JSON Response, e.g. json({ posts: [] }) or json({ error: "x" }, 401). */
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Options that make safeFetch fast in tests (no waiting between retries). */
export const fast = { retryDelayMs: 0 };
