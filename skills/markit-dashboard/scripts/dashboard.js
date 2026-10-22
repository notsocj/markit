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
//   GET  /favicon.ico, /apple-touch-icon.png   the app icon (bundled copies of docs/brand/app-icon;
//                          Safari ignores the page's SVG favicon and needs one of these)
//   GET  /api/apps         app names that have reports
//   GET  /api/runs?app=    that app's runs, newest first
//   GET  /api/cards?app=&run=latest|all|<run>   cards (with Replied/Skipped status) + stats
//                          + prefilter line + keyword health (for the Keywords panel)
//   POST /api/status       { id, status, reason?, note? }: status in replied, skipped, open;
//                          reason (skipped only) from a fixed list; note ≤ 140 chars, plain text
//   GET  /api/settings     Settings page: which keys are SET (true/false, never values), and
//                          each app's sources (dashboard-settings.js)
//   POST /api/settings/key   { name, value }: write one key into .env (write-only)
//   POST /api/settings/test  { source }: test that source's key with one small API call
//   POST /api/settings/app   { app, sources }: change an app's sources
//
// SECURITY (this is a web server, so it gets extra care):
//   - Binds to 127.0.0.1 only: other computers on your network can't reach it.
//   - Rejects any request whose Host header isn't localhost:<port> or 127.0.0.1:<port>.
//     This blocks "DNS rebinding", where a malicious website points its own domain at
//     127.0.0.1 to talk to servers on your machine.
//   - POST /api/status also requires: an Origin header from this same page (blocks other
//     websites from submitting to it), Content-Type application/json, a body under 1 KB,
//     only the fields { id, status, reason?, note? }, values from fixed lists, and an id
//     that belongs to a card in the reports folder. The note is stripped of HTML.
//   - The /api/settings POSTs also need the per-start page token (header x-markit-token),
//     which only this page has: it's put into the page when the server starts.
//   - API keys are WRITE-ONLY: a key goes browser → this server → .env, and is never sent
//     back, logged, or printed (so it can't appear in an agent's chat or the task output).
//     The Settings page only learns "set" / "not set" and test results.
//   - Read-only everywhere else. Serves data from the REPORTS folder. From the config folder
//     it touches feedback.json (Replied/Skipped), and through Settings: .env (write-only),
//     app profiles (only "sources", validated like /markit-setup),
//     and usage.json (counting key tests). It never serves .env or usage.
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
const settingsLib = await import("./dashboard-settings.js");

export const DEFAULT_PORT = 4321;
export const PORT_TRIES = 10; // 4321, 4322, ... 4330
export const IDLE_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_BODY_BYTES = 1024;
// Settings requests can carry an API key (a Threads token is a few hundred characters).
export const MAX_SETTINGS_BODY_BYTES = 4096;
const BIND_ADDRESS = "127.0.0.1";

// The page is read once at startup; __NONCE__ is filled in per server start.
const PAGE_TEMPLATE = readFileSync(new URL("./dashboard-page.html", import.meta.url), "utf8");

// The page's font, Poppins (SIL Open Font License 1.1, see fonts/OFL.txt), bundled so the
// page never contacts a font CDN. Read into memory once; only these exact names are served,
// so a request can't name any other file.
export const FONT_FILES = ["poppins-400.woff2", "poppins-500.woff2", "poppins-600.woff2", "poppins-700.woff2"];
const FONTS = new Map(FONT_FILES.map((name) => [name, readFileSync(new URL(`./fonts/${name}`, import.meta.url))]));

// The app icon, for browser tabs and bookmarks. Same idea as the fonts: read once, served only
// by these exact paths. The page also has an SVG favicon (Chrome, Firefox); Safari doesn't
// use SVG favicons, so it falls back to /favicon.ico.
export const ICON_FILES = { "/favicon.ico": ["favicon.ico", "image/x-icon"], "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"] };
const ICONS = new Map(Object.entries(ICON_FILES).map(([route, [file, type]]) => [route, { body: readFileSync(new URL(`./icons/${file}`, import.meta.url)), type }]));

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
 * @param {string} opts.feedbackFile - ~/.config/markit/feedback.json (Replied/Skipped + reasons)
 * @param {string} [opts.legacyStatusFile] - the old status.json, imported if feedback.json is new
 * @param {string} [opts.envFile] - .env, for the Settings page (no Settings without it)
 * @param {string} [opts.appsDir] - apps/, for the Settings page's sources switches
 * @param {string} [opts.usageFile] - usage.json, to count key tests like /markit-usage does
 * @param {string} [opts.settingsFile] - settings.json, read for the Reddit provider shown in Settings
 * @param {object[]} [opts.adapters] - for key tests (tests pass fakes)
 * @param {number} [opts.idleMs] - shut down after this long without requests
 * @param {(reason: string) => void} [opts.onStop] - called once after shutdown
 */
export function createDashboard({ reportsDir, feedbackFile, legacyStatusFile, envFile, appsDir, usageFile, settingsFile, adapters, idleMs = IDLE_MS, onStop = () => {} }) {
  const files = { feedbackFile, legacyStatusFile, reportsDir };
  const settingsOn = Boolean(envFile && appsDir);
  let port = null;
  let idleTimer = null;
  let stopped = false;

  // A fresh random nonce each start: only scripts/styles carrying it may run on the page.
  const nonce = randomBytes(16).toString("base64");
  // A second random value the page sends back on Settings requests (x-markit-token), so
  // only this page, loaded from this server, can change keys or sources.
  const pageToken = randomBytes(24).toString("hex");
  const page = PAGE_TEMPLATE.replaceAll("__NONCE__", nonce).replaceAll("__TOKEN__", pageToken);

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

  /**
   * Shared checks for a JSON POST: same-origin page, JSON content type, size limit, valid
   * JSON, and (when given) the page token. Returns the parsed body, or undefined after
   * sending the error response.
   */
  async function readJsonPost(req, res, limit, { token } = {}) {
    if (!isAllowedOrigin(req.headers.origin, port)) return void sendJson(req, res, 403, { error: "forbidden origin" });
    if (token && req.headers["x-markit-token"] !== token) return void sendJson(req, res, 403, { error: "missing or wrong page token (reload the page)" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return void sendJson(req, res, 415, { error: "content-type must be application/json" });
    }
    if (Number(req.headers["content-length"] ?? 0) > limit) return void sendJson(req, res, 413, { error: "body too large" });
    try {
      return JSON.parse(await readBody(req, limit));
    } catch (err) {
      if (err.code === "TOO_LARGE") return void sendJson(req, res, 413, { error: "body too large" });
      return void sendJson(req, res, 400, { error: "body must be valid JSON" });
    }
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

      const iconFile = ICONS.get(url.pathname);
      if (iconFile) {
        res.writeHead(200, { ...baseHeaders, "content-type": iconFile.type, "content-length": iconFile.body.length, "cache-control": "max-age=86400" });
        return res.end(req.method === "HEAD" ? undefined : iconFile.body);
      }

      if (url.pathname === "/api/apps") return sendJson(req, res, 200, { apps: data.listApps(reportsDir) });

      if (url.pathname === "/api/settings") {
        if (!settingsOn) return sendJson(req, res, 404, { error: "not found" });
        return sendJson(req, res, 200, settingsLib.getSettings({ envFile, appsDir, settingsFile }));
      }

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
        const statusMap = data.readStatus(feedbackFile, legacyStatusFile);
        const cards = run ? data.loadCards(reportsDir, app, run, statusMap) : [];
        const prefilter = run && run !== "all" ? data.runPrefilter(reportsDir, app, run) : "";
        // Keyword health: from the chosen run, or the newest run when showing all of them.
        const healthRun = run === "all" ? data.latestRun(reportsDir, app) : run;
        const keywordHealth = healthRun ? data.runKeywordHealth(reportsDir, app, healthRun) : null;
        const warning = data.feedbackWarning(feedbackFile, legacyStatusFile); // "" unless feedback.json is broken
        return sendJson(req, res, 200, { app, run, cards, prefilter, keywordHealth, warning, stats: data.computeStats(cards, statusMap) });
      }
      return sendJson(req, res, 404, { error: "not found" });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/settings/") && settingsOn) {
      const body = await readJsonPost(req, res, MAX_SETTINGS_BODY_BYTES, { token: pageToken });
      if (body === undefined) return; // an error was already sent

      if (url.pathname === "/api/settings/key") {
        const check = settingsLib.validateKeyUpdate(body);
        if (!check.ok) return sendJson(req, res, 400, { error: check.error });
        return sendJson(req, res, 200, settingsLib.saveKey({ envFile }, check)); // { name, set } only
      }
      if (url.pathname === "/api/settings/test") {
        const names = Object.keys(body ?? {});
        const sources = settingsLib.SOURCE_INFO.map((i) => i.source);
        if (names.length !== 1 || names[0] !== "source" || !sources.includes(body.source)) return sendJson(req, res, 400, { error: "body must be exactly { source } with a known source" });
        return sendJson(req, res, 200, { source: body.source, result: await settingsLib.testSource({ envFile, usageFile }, body.source, { adapters }) });
      }
      if (url.pathname === "/api/settings/app") {
        const check = settingsLib.validateAppUpdate(body);
        if (!check.ok) return sendJson(req, res, 400, { error: check.error });
        try {
          return sendJson(req, res, 200, settingsLib.saveAppSources({ appsDir }, check));
        } catch (err) {
          // validateProfile's messages list what's wrong with the profile (no secrets in it).
          return sendJson(req, res, 400, { error: err.message?.startsWith("marKit:") ? err.message.replace(/^marKit: /, "") : "couldn't save the profile" });
        }
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
      // 4. Only { id, status, reason?, note? }, with values from the fixed lists.
      const check = data.validateStatusUpdate(body);
      if (!check.ok) return sendJson(req, res, 400, { error: check.error });
      // 5. The id must be a card in the reports folder (its details go into feedback.json).
      const saved = data.writeStatus(files, check);
      if (!saved) return sendJson(req, res, 404, { error: "unknown card" });
      if (saved.error) return sendJson(req, res, 500, { error: saved.error });
      return sendJson(req, res, 200, { id: check.id, ...saved });
    }

    const known = ["/", "/api/apps", "/api/runs", "/api/cards", "/api/status", ...(settingsOn ? ["/api/settings"] : [])].includes(url.pathname);
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
    feedbackFile: paths.feedbackFile,
    legacyStatusFile: paths.statusFile,
    envFile: paths.envFile,
    appsDir: paths.appsDir,
    usageFile: paths.usageFile,
    settingsFile: paths.settingsFile,
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
