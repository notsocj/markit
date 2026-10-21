#!/usr/bin/env node
// dashboard.js — a small local web page for working through marKit's cards.
//
//   node dashboard.js              start on http://127.0.0.1:4321 (or the next free port)
//   node dashboard.js --port 5000  try a different starting port
//   node dashboard.js --no-open    don't open the browser automatically
//
// What it serves:
//   GET  /                 one self-contained HTML page (inline CSS + JS, no CDN, no frameworks)
//   GET  /fonts/<file>     the bundled Poppins font files (exact names only; see FONT_FILES)
//   GET  /api/apps         app names that have reports
//   GET  /api/runs?app=    that app's runs, newest first
//   GET  /api/cards?app=&run=latest|all|<run>   cards (with Replied/Skipped status) + stats
//   POST /api/status       { id, status } with status in: replied, skipped, open
//
// SECURITY (this is a web server, so it gets extra care):
//   - Binds to 127.0.0.1 only: other computers on your network can't reach it.
//   - Rejects any request whose Host header isn't localhost:<port> or 127.0.0.1:<port>.
//     This blocks "DNS rebinding", where a malicious website points its own domain at
//     127.0.0.1 to talk to servers on your machine.
//   - POST /api/status also requires: an Origin header from this same page (blocks other
//     websites from submitting to it), Content-Type application/json, a body under 1 KB,
//     and exactly { id, status } with a status from a fixed list.
//   - Read-only everywhere else. Serves data from the REPORTS folder only. From the config
//     folder it only ever touches status.json. It never serves .env, profiles, or usage.
//   - Strict Content-Security-Policy: only this page's own inline script/style (with a
//     random nonce per start) may run; no external requests, no framing.
//   - The page shows post text with textContent (never as HTML), because post text is
//     untrusted and could contain script tags.
//   - Shuts down after 30 minutes with no requests, and on Ctrl+C.
//
// Zero dependencies: node:http and friends only.

import http from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadShared } from "./shared.js";

// Shared code from the sibling markit-find folder (exits with a clear message if missing).
// dashboard-data.js imports shared code too, so it's loaded only after this check.
const config = await loadShared("lib/config.js");
const data = await import("./dashboard-data.js");

export const DEFAULT_PORT = 4321;
export const PORT_TRIES = 10; // 4321, 4322, ... 4330
export const IDLE_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_BODY_BYTES = 1024;
const BIND_ADDRESS = "127.0.0.1";

// The page is read once at startup; __NONCE__ is filled in per server start.
const PAGE_TEMPLATE = readFileSync(new URL("./dashboard-page.html", import.meta.url), "utf8");

// The page's font, Poppins (SIL Open Font License 1.1, see fonts/OFL.txt), bundled so the
// page never contacts a font CDN. Read into memory once; only these exact names are served,
// so a request can't name any other file.
export const FONT_FILES = ["poppins-400.woff2", "poppins-500.woff2", "poppins-600.woff2", "poppins-700.woff2"];
const FONTS = new Map(FONT_FILES.map((name) => [name, readFileSync(new URL(`./fonts/${name}`, import.meta.url))]));

/** True only for Host headers that name this server on this computer. */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== "string" || !port) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

/** True only when a request comes from this dashboard's own page. */
export function isAllowedOrigin(origin, port) {
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

/** Read a request body, refusing anything over `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { code: "TOO_LARGE" }));
        req.removeAllListeners("data");
        req.resume(); // drain and ignore the rest
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Create the dashboard server (not started yet).
 *
 * @param {object} opts
 * @param {string} opts.reportsDir - where search.js/report.js write runs
 * @param {string} opts.statusFile - ~/.config/markit/status.json
 * @param {number} [opts.idleMs] - shut down after this long without requests
 * @param {(reason: string) => void} [opts.onStop] - called once after shutdown
 */
export function createDashboard({ reportsDir, statusFile, idleMs = IDLE_MS, onStop = () => {} }) {
  let port = null;
  let idleTimer = null;
  let stopped = false;

  // A fresh random nonce each start: only scripts/styles carrying it may run on the page.
  const nonce = randomBytes(16).toString("base64");
  const page = PAGE_TEMPLATE.replaceAll("__NONCE__", nonce);

  const baseHeaders = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "cross-origin-resource-policy": "same-origin",
  };
  const pageHeaders = {
    ...baseHeaders,
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };

  function send(req, res, status, body, headers) {
    res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  const sendJson = (req, res, status, value) =>
    send(req, res, status, JSON.stringify(value), { ...baseHeaders, "content-type": "application/json; charset=utf-8" });

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop("idle"), idleMs);
  }

  async function handle(req, res) {
    resetIdleTimer();

    // 1. Only requests addressed to this server on this computer (blocks DNS rebinding).
    if (!isAllowedHost(req.headers.host, port)) return sendJson(req, res, 403, { error: "forbidden" });

    const url = new URL(req.url, `http://${BIND_ADDRESS}:${port}`);
    const q = (name) => url.searchParams.get(name) ?? "";

    if (req.method === "GET" || req.method === "HEAD") {
      if (url.pathname === "/") return send(req, res, 200, page, { ...pageHeaders, "content-type": "text/html; charset=utf-8" });

      if (url.pathname.startsWith("/fonts/")) {
        const font = FONTS.get(url.pathname.slice("/fonts/".length));
        if (!font) return sendJson(req, res, 404, { error: "not found" });
        res.writeHead(200, { ...baseHeaders, "content-type": "font/woff2", "content-length": font.length, "cache-control": "max-age=86400" });
        return res.end(req.method === "HEAD" ? undefined : font);
      }

      if (url.pathname === "/api/apps") return sendJson(req, res, 200, { apps: data.listApps(reportsDir) });

      if (url.pathname === "/api/runs") {
        if (!data.APP_NAME.test(q("app"))) return sendJson(req, res, 400, { error: "invalid app" });
        return sendJson(req, res, 200, { runs: data.listRuns(reportsDir, q("app")) });
      }

      if (url.pathname === "/api/cards") {
        const app = q("app");
        let run = q("run") || "latest";
        if (!data.APP_NAME.test(app)) return sendJson(req, res, 400, { error: "invalid app" });
        if (run !== "latest" && run !== "all" && !data.RUN_NAME.test(run)) return sendJson(req, res, 400, { error: "invalid run" });
        if (run === "latest") run = data.latestRun(reportsDir, app);
        const statusMap = data.readStatus(statusFile);
        const cards = run ? data.loadCards(reportsDir, app, run, statusMap) : [];
        const prefilter = run && run !== "all" ? data.runPrefilter(reportsDir, app, run) : "";
        return sendJson(req, res, 200, { app, run, cards, prefilter, stats: data.computeStats(cards, statusMap) });
      }
      return sendJson(req, res, 404, { error: "not found" });
    }

    if (req.method === "POST" && url.pathname === "/api/status") {
      // 2. Only from this dashboard's own page (blocks other websites submitting here).
      if (!isAllowedOrigin(req.headers.origin, port)) return sendJson(req, res, 403, { error: "forbidden origin" });
      // 3. JSON only. (A JSON content type also forces browsers to ask permission first for
      //    cross-site requests, which this server never grants.)
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return sendJson(req, res, 415, { error: "content-type must be application/json" });
      }
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return sendJson(req, res, 413, { error: "body too large" });

      let body;
      try {
        body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
      } catch (err) {
        if (err.code === "TOO_LARGE") return sendJson(req, res, 413, { error: "body too large" });
        return sendJson(req, res, 400, { error: "body must be valid JSON" });
      }
      // 4. Exactly { id, status }, with a status from the fixed list.
      const check = data.validateStatusUpdate(body);
      if (!check.ok) return sendJson(req, res, 400, { error: check.error });
      const saved = data.writeStatus(statusFile, check.id, check.status);
      return sendJson(req, res, 200, { id: check.id, ...saved });
    }

    const known = ["/", "/api/apps", "/api/runs", "/api/cards", "/api/status"].includes(url.pathname);
    return sendJson(req, res, known ? 405 : 404, { error: known ? "method not allowed" : "not found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      // Never send error details (they could include file paths).
      if (!res.headersSent) sendJson(req, res, 500, { error: "internal error" });
    });
  });

  /** Listen on 127.0.0.1, trying the next port if one is busy. Resolves { port, url }. */
  function start({ port: firstPort = DEFAULT_PORT, tries = PORT_TRIES } = {}) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryPort = (p) => {
        const onError = (err) => {
          server.off("listening", onListening);
          // Port 0 means "any free port" (tests); otherwise try the next one up.
          if (err.code === "EADDRINUSE" && firstPort !== 0 && ++attempt < tries && p < 65535) return tryPort(p + 1);
          reject(new Error(err.code === "EADDRINUSE" ? `marKit: ports ${firstPort}–${firstPort + tries - 1} are all busy. Try --port <number>.` : `marKit: couldn't start the dashboard (${err.code ?? "error"}).`));
        };
        const onListening = () => {
          server.off("error", onError);
          port = server.address().port;
          resetIdleTimer();
          resolve({ port, url: `http://${BIND_ADDRESS}:${port}` });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        // The second argument is the key line: only this computer can connect.
        server.listen(p, BIND_ADDRESS);
      };
      tryPort(firstPort);
    });
  }

  function stop(reason = "stopped") {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    server.close();
    server.closeAllConnections?.(); // don't wait for open browser connections
    onStop(reason);
  }

  return { server, start, stop, get port() { return port; } };
}

/** Open a URL in the default browser. Failures are ignored (the URL is printed anyway). */
export function openBrowser(url, platform = process.platform) {
  const [cmd, args] =
    platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["cmd", ["/c", "start", "", url]] // "" is start's window title
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // no browser opener available: the user can click the printed URL
  }
}

async function main() {
  const { values } = parseArgs({ options: { port: { type: "string" }, "no-open": { type: "boolean", default: false } } });
  const paths = config.getPaths();
  if (!config.isSetUp(paths)) throw new Error("marKit: not set up yet. Run /markit-setup first.");

  let firstPort = DEFAULT_PORT;
  if (values.port !== undefined) {
    firstPort = Number(values.port);
    if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort > 65535) throw new Error("marKit: --port must be a number from 1024 to 65535.");
  }

  const { reportsDir } = config.loadSettings(paths);
  const dashboard = createDashboard({
    reportsDir,
    statusFile: paths.statusFile,
    onStop: (reason) => {
      console.log(reason === "idle" ? "marKit dashboard stopped after 30 minutes without use." : "marKit dashboard stopped.");
      process.exit(0);
    },
  });

  const { url } = await dashboard.start({ port: firstPort });
  console.log(`marKit dashboard: ${url}\nStops after 30 minutes without use, or press Ctrl+C.`);
  if (!values["no-open"]) openBrowser(url);

  process.on("SIGINT", () => dashboard.stop("ctrl-c"));
  process.on("SIGTERM", () => dashboard.stop("terminated"));
}

// Run main() only when executed directly, not when imported by tests.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (runDirectly) {
  main().catch((err) => {
    const safe = err.message?.startsWith("marKit:") || String(err.code).startsWith("ERR_PARSE_ARGS");
    console.error(safe ? err.message.replace(/^(?!marKit:)/, "marKit: ") : `marKit: unexpected error (${err.name})`);
    process.exitCode = 1;
  });
}
