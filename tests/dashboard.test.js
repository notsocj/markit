// Tests for the /markit-dashboard server (dashboard.js) and its data layer (dashboard-data.js).
// Every server test starts a real server on a random free port (port 0) and talks to it
// over HTTP with node:http, so we can send any Host/Origin header we like.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboard, isAllowedHost, isAllowedOrigin, DEFAULT_PORT } from "../skills/markit-dashboard/scripts/dashboard.js";
import { validateStatusUpdate, computeStats, loadCards, readStatus, writeStatus, listApps, listRuns } from "../skills/markit-dashboard/scripts/dashboard-data.js";

const SECRET = "sk_live_DASHBOARD_MUST_NEVER_SERVE_THIS";

// --- fixtures ---------------------------------------------------------------------

/** A temp "home" with a config folder (incl. a secret .env) and a reports folder with 2 runs. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "markit-dash-"));
  const configDir = join(home, "config");
  const reportsDir = join(home, "reports");
  mkdirSync(join(configDir, "apps"), { recursive: true });
  writeFileSync(join(configDir, ".env"), `X_BEARER_TOKEN=${SECRET}\n`);
  writeFileSync(join(configDir, "apps", "gridpeek.json"), JSON.stringify({ name: "gridpeek", secretish: SECRET }));

  // New-style run with cards.json (written by report.js).
  const newRun = join(reportsDir, "gridpeek", "2026-10-21-2100");
  mkdirSync(newRun, { recursive: true });
  writeFileSync(join(newRun, "cards.json"), JSON.stringify({
    app: "gridpeek", ranAt: "2026-10-21T13:00:00Z", lookbackDays: 7, sources: [],
    cards: [
      { number: 1, id: "sc-1", source: "socialcrawl", site: "Reddit r/formula1", url: "https://example.com/1", title: "<script>alert(1)</script>", excerpt: "x", intent: "asking_for_recommendation", score: 95, priority: "high", why: "fits", draftReply: "draft", extraField: SECRET },
      { number: 2, id: "hn-2", source: "hackernews", url: "https://example.com/2", title: "Ask HN", excerpt: "y", intent: "problem_discussion", score: 60, priority: "medium", why: "fits", draftReply: "d2" },
    ],
  }));

  // Older run without cards.json (falls back to scored.json + raw.json).
  const oldRun = join(reportsDir, "gridpeek", "2026-10-20-0900");
  mkdirSync(oldRun, { recursive: true });
  writeFileSync(join(oldRun, "raw.json"), JSON.stringify({ app: "gridpeek", ranAt: "2026-10-20T01:00:00Z", lookbackDays: 7, sources: [], posts: [] }));
  writeFileSync(join(oldRun, "scored.json"), JSON.stringify({ posts: [
    { id: "bsky-3", source: "bluesky", url: "https://example.com/3", intent: "problem_discussion", score: 55, priority: "medium", why: "w", draftReply: "d" },
    { id: "hn-2", source: "hackernews", url: "https://example.com/2", intent: "asking_for_recommendation", score: 80, priority: "high", why: "w", draftReply: "d" },
    { id: "hn-9", source: "hackernews", url: "https://example.com/9", intent: "irrelevant" },
  ] }));
  // Junk that must be ignored: a folder that isn't a run name, and a non-app folder.
  mkdirSync(join(reportsDir, "gridpeek", "notes"), { recursive: true });
  mkdirSync(join(reportsDir, "..hidden"), { recursive: true });

  return { home, configDir, reportsDir, feedbackFile: join(configDir, "feedback.json"), statusFile: join(configDir, "status.json") };
}

const servers = [];
after(() => servers.forEach((d) => d.stop("test done")));

async function startDashboard(opts = {}) {
  const f = fixture();
  const dash = createDashboard({ reportsDir: f.reportsDir, feedbackFile: f.feedbackFile, legacyStatusFile: f.statusFile, ...opts });
  servers.push(dash);
  const { port } = await dash.start({ port: 0 });
  return { ...f, dash, port };
}

/** Raw HTTP request so tests control every header (fetch won't let us fake Host). */
function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const post = (port, body, headers = {}) =>
  request(port, {
    method: "POST",
    path: "/api/status",
    headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// --- Host check -------------------------------------------------------------------

test("isAllowedHost accepts only localhost:<port> and 127.0.0.1:<port>", () => {
  for (const ok of ["localhost:4321", "127.0.0.1:4321", "LOCALHOST:4321", " localhost:4321 "]) assert.equal(isAllowedHost(ok, 4321), true, ok);
  for (const bad of ["evil.com", "evil.com:4321", "localhost", "127.0.0.1", "localhost:4322", "127.0.0.1.evil.com:4321", "localhost:4321.evil.com", "[::1]:4321", "0.0.0.0:4321", "", undefined, null]) {
    assert.equal(isAllowedHost(bad, 4321), false, String(bad));
  }
  assert.equal(isAllowedHost("localhost:4321", null), false, "no port yet → nothing allowed");
});

test("isAllowedOrigin accepts only this dashboard's own origin", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:4321", 4321), true);
  assert.equal(isAllowedOrigin("http://localhost:4321", 4321), true);
  for (const bad of ["https://evil.com", "http://localhost:9999", "null", "http://127.0.0.1:4321/x", undefined]) assert.equal(isAllowedOrigin(bad, 4321), false, String(bad));
});

test("requests with a foreign Host header are rejected (DNS rebinding defense)", async () => {
  const { port } = await startDashboard();
  assert.equal((await request(port, { headers: { host: "evil.example:" + port } })).status, 403);
  assert.equal((await request(port, { path: "/api/apps", headers: { host: "attacker.com" } })).status, 403);
  assert.equal((await request(port, { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await request(port)).status, 200);
});

// --- Binding ----------------------------------------------------------------------

test("the server binds to 127.0.0.1 only", async () => {
  const { dash } = await startDashboard();
  const address = dash.server.address();
  assert.equal(address.address, "127.0.0.1");
  assert.equal(address.family, "IPv4");
  assert.equal(DEFAULT_PORT, 4321);
});

test("if the port is busy, it tries the next one", async () => {
  const blocker = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const busy = blocker.address().port;
  const f = fixture();
  const dash = createDashboard({ reportsDir: f.reportsDir, feedbackFile: f.feedbackFile, legacyStatusFile: f.statusFile });
  servers.push(dash);
  const { port } = await dash.start({ port: busy, tries: 10 });
  assert.ok(port > busy && port < busy + 10, `got ${port}, busy was ${busy}`);
  blocker.close();
});

// --- Page and read-only API --------------------------------------------------------

test("GET / serves the self-contained page with a strict CSP and nonce", async () => {
  const { port } = await startDashboard();
  const r = await request(port);
  assert.match(r.headers["content-type"], /text\/html/);
  const csp = r.headers["content-security-policy"];
  assert.match(csp, /default-src 'none'/);
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(r.text.includes(`<script nonce="${nonce}">`) && r.text.includes(`<style nonce="${nonce}">`));
  assert.ok(!r.text.includes("__NONCE__"));
  assert.ok(!/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(r.text), "no external resources");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.ok(!r.text.includes(".innerHTML"), "post text is never inserted as HTML");
});

test("apps, runs, and cards come from the reports folder", async () => {
  const { port } = await startDashboard();
  assert.deepEqual((await request(port, { path: "/api/apps" })).json(), { apps: ["gridpeek"] });

  const { runs } = (await request(port, { path: "/api/runs?app=gridpeek" })).json();
  assert.deepEqual(runs.map((r) => [r.run, r.total, r.high]), [["2026-10-21-2100", 2, 1], ["2026-10-20-0900", 2, 1]]);

  const latest = (await request(port, { path: "/api/cards?app=gridpeek&run=latest" })).json();
  assert.equal(latest.run, "2026-10-21-2100");
  assert.deepEqual(latest.cards.map((c) => [c.number, c.id, c.platform, c.label]), [[1, "sc-1", "Reddit", "Reddit r/formula1"], [2, "hn-2", "Hacker News", "Hacker News"]]);
  assert.equal(latest.cards[0].extraField, undefined, "unknown fields are dropped");

  const old = (await request(port, { path: "/api/cards?app=gridpeek&run=2026-10-20-0900" })).json();
  assert.deepEqual(old.cards.map((c) => [c.number, c.id]), [[1, "hn-2"], [2, "bsky-3"]], "legacy runs are numbered like report.md (irrelevant left out)");

  const all = (await request(port, { path: "/api/cards?app=gridpeek&run=all" })).json();
  assert.deepEqual(all.cards.map((c) => c.id), ["sc-1", "hn-2", "bsky-3"], "a post in two runs appears once (newest run)");
});

test("bad or sneaky app/run names are refused before touching the disk", async () => {
  const { port } = await startDashboard();
  for (const path of [
    "/api/runs?app=../config",
    "/api/runs?app=..%2F..%2Fconfig",
    "/api/cards?app=gridpeek&run=../../config",
    "/api/cards?app=gridpeek&run=2026-10-21-2100/../../x",
    "/api/cards?app=GRIDPEEK",
    "/api/cards?app=",
  ]) {
    assert.equal((await request(port, { path })).status, 400, path);
  }
});

test("nothing from the config folder is ever served (except status via the API)", async () => {
  const { port } = await startDashboard();
  const responses = await Promise.all(
    ["/", "/api/apps", "/api/runs?app=gridpeek", "/api/cards?app=gridpeek&run=all", "/.env", "/../config/.env", "/config/.env", "/apps/gridpeek.json", "/settings.json", "/status.json"].map((path) => request(port, { path }))
  );
  for (const r of responses) assert.ok(!r.text.includes(SECRET), "a secret leaked");
  assert.equal((await request(port, { path: "/.env" })).status, 404);
  assert.equal((await request(port, { path: "/status.json" })).status, 404, "status.json is only reachable through /api/status");
});

test("unknown methods get 405, unknown paths 404", async () => {
  const { port } = await startDashboard();
  assert.equal((await request(port, { method: "PUT", path: "/api/status" })).status, 405);
  assert.equal((await request(port, { method: "DELETE", path: "/" })).status, 405);
  assert.equal((await request(port, { method: "POST", path: "/api/cards" })).status, 405);
  assert.equal((await request(port, { path: "/nope" })).status, 404);
});

// --- Status endpoint: input validation ---------------------------------------------

const feedbackEntry = (file, id) => JSON.parse(readFileSync(file, "utf8")).entries.find((e) => e.id === id);

test("POST /api/status saves a valid { id, status } to feedback.json, with the card's details", async () => {
  const { port, feedbackFile } = await startDashboard();
  const r = await post(port, { id: "sc-1", status: "replied" });
  assert.equal(r.status, 200);
  assert.equal(r.json().status, "replied");
  const entry = feedbackEntry(feedbackFile, "sc-1");
  assert.equal(entry.status, "replied");
  assert.equal(entry.app, "gridpeek");
  assert.equal(entry.community, "r/formula1");
  assert.equal(entry.title, "alert(1)", "HTML stripped from the stored title");

  const cards = (await request(port, { path: "/api/cards?app=gridpeek&run=latest" })).json();
  assert.equal(cards.cards[0].status, "replied");
  assert.equal(cards.stats.replied, 1);
  assert.equal(cards.stats.repliesThisWeek, 1);

  assert.equal((await post(port, { id: "sc-1", status: "open" })).status, 200);
  assert.equal(feedbackEntry(feedbackFile, "sc-1"), undefined, "'open' clears the mark");
});

test("POST /api/status: skip with a reason and a note (HTML stripped, trimmed, cut to 140)", async () => {
  const { port, feedbackFile } = await startDashboard();
  const note = "  <b>mods</b> remove <script>alert(1)</script>app links " + "x".repeat(300);
  const r = await post(port, { id: "hn-2", status: "skipped", reason: "bans_promotion", note });
  assert.equal(r.status, 200);
  assert.equal(r.json().reasonLabel, "Community bans promotion");
  const entry = feedbackEntry(feedbackFile, "hn-2");
  assert.equal(entry.reason, "bans_promotion");
  assert.ok(entry.note.startsWith("mods remove alert(1)app links"), entry.note);
  assert.ok(entry.note.length <= 140);
  assert.ok(!/[<>]/.test(entry.note));
  const card = (await request(port, { path: "/api/cards?app=gridpeek&run=latest" })).json().cards.find((c) => c.id === "hn-2");
  assert.deepEqual([card.status, card.reason, card.reasonLabel], ["skipped", "bans_promotion", "Community bans promotion"]);
});

test("POST /api/status: an id that isn't a card in the reports folder → 404, nothing saved", async () => {
  const { port, feedbackFile } = await startDashboard();
  assert.equal((await post(port, { id: "hn-404", status: "replied" })).status, 404);
  assert.ok(!existsSync(feedbackFile));
});

test("an old status.json is imported into feedback.json", async () => {
  const f = fixture();
  writeFileSync(f.statusFile, JSON.stringify({ ids: { "hn-2": { status: "skipped", updatedAt: new Date().toISOString() } } }));
  assert.equal(readStatus(f.feedbackFile, f.statusFile)["hn-2"].status, "skipped");
  // The next save writes feedback.json, keeping the imported mark.
  writeStatus({ feedbackFile: f.feedbackFile, legacyStatusFile: f.statusFile, reportsDir: f.reportsDir }, { id: "sc-1", status: "replied" });
  assert.deepEqual(Object.keys(readStatus(f.feedbackFile, f.statusFile)).sort(), ["hn-2", "sc-1"]);
});

test("POST /api/status rejects everything else", async () => {
  const { port, feedbackFile } = await startDashboard();
  const cases = [
    ["no Origin", post(port, { id: "sc-1", status: "replied" }, { origin: "" }), 403],
    ["foreign Origin", post(port, { id: "sc-1", status: "replied" }, { origin: "https://evil.example" }), 403],
    ["wrong content type", post(port, { id: "sc-1", status: "replied" }, { "content-type": "text/plain" }), 415],
    ["form content type", post(port, "id=sc-1&status=replied", { "content-type": "application/x-www-form-urlencoded" }), 415],
    ["too large (declared)", post(port, { id: "sc-1", status: "replied", pad: "x".repeat(2000) }), 413],
    ["not JSON", post(port, "{ nope"), 400],
    ["array", post(port, [{ id: "sc-1", status: "replied" }]), 400],
    ["extra key", post(port, { id: "sc-1", status: "replied", path: "/etc/passwd" }), 400],
    ["missing status", post(port, { id: "sc-1" }), 400],
    ["status not in list", post(port, { id: "sc-1", status: "deleted" }), 400],
    ["status not a string", post(port, { id: "sc-1", status: ["replied"] }), 400],
    ["id with path chars", post(port, { id: "../../.env", status: "replied" }), 400],
    ["id with spaces/HTML", post(port, { id: "<img src=x>", status: "replied" }), 400],
    ["id too long", post(port, { id: "a".repeat(300), status: "replied" }), 400],
    ["id not a string", post(port, { id: 42, status: "replied" }), 400],
    ["reason not in list", post(port, { id: "sc-1", status: "skipped", reason: "boring" }), 400],
    ["agent-only reason", post(port, { id: "sc-1", status: "skipped", reason: "agent_irrelevant" }), 400],
    ["reason with replied", post(port, { id: "sc-1", status: "replied", reason: "other" }), 400],
    ["reason not a string", post(port, { id: "sc-1", status: "skipped", reason: ["other"] }), 400],
    ["note not a string", post(port, { id: "sc-1", status: "skipped", note: { html: "<b>" } }), 400],
  ];
  for (const [name, promise, expected] of cases) assert.equal((await promise).status, expected, name);
  assert.ok(!existsSync(feedbackFile), "nothing was written");
});

test("POST /api/status: a large chunked body (no Content-Length) is also refused", async () => {
  const { port } = await startDashboard();
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/status", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write('{"id":"sc-1","status":"replied","pad":"' + "x".repeat(4000) + '"}');
    req.end();
  });
  assert.equal(r, 413);
});

test("validateStatusUpdate unit checks", () => {
  assert.deepEqual(validateStatusUpdate({ id: "bsky-did:plc:abc-3kx", status: "skipped" }), { ok: true, id: "bsky-did:plc:abc-3kx", status: "skipped", reason: "", note: "" });
  assert.deepEqual(validateStatusUpdate({ id: "a", status: "skipped", reason: "wrong_meaning", note: " <i>meh</i> " }), { ok: true, id: "a", status: "skipped", reason: "wrong_meaning", note: "meh" });
  assert.equal(validateStatusUpdate({ id: "a", status: "skipped", reason: "Wrong meaning" }).ok, false, "the API takes codes only");
  assert.equal(validateStatusUpdate(null).ok, false);
  assert.equal(validateStatusUpdate("x").ok, false);
  assert.equal(validateStatusUpdate({ status: "replied", id: "a", x: 1 }).ok, false);
});

// --- Idle shutdown -----------------------------------------------------------------

test("the server stops itself after the idle time", async () => {
  let reason = null;
  const { dash } = await startDashboard({ idleMs: 60, onStop: (r) => (reason = r) });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(reason, "idle");
  assert.equal(dash.server.listening, false);
});

test("requests keep it alive", async () => {
  let reason = null;
  // 4 requests 150 ms apart (600 ms total) against a 500 ms idle limit: it only survives if
  // each request resets the timer. Wide margins so a busy test machine can't make it flaky.
  const { port } = await startDashboard({ idleMs: 500, onStop: (r) => (reason = r) });
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 150));
    await request(port, { path: "/api/apps" });
  }
  assert.equal(reason, null);
});

// --- data helpers --------------------------------------------------------------------

test("computeStats counts per platform and replies this week", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const cards = [{ platform: "Reddit", status: "replied" }, { platform: "Reddit", status: "open" }, { platform: "Bluesky", status: "skipped" }];
  const statusMap = { a: { status: "replied", updatedAt: "2026-10-20T00:00:00Z" }, b: { status: "replied", updatedAt: "2026-10-01T00:00:00Z" }, c: { status: "skipped", updatedAt: "2026-10-21T00:00:00Z" } };
  assert.deepEqual(computeStats(cards, statusMap, now), { total: 3, perPlatform: { Reddit: 2, Bluesky: 1 }, repliesThisWeek: 1, replied: 1, skipped: 1, open: 1 });
});

test("feedback round trip and data listing ignore junk folders", () => {
  const f = fixture();
  const files = { feedbackFile: f.feedbackFile, reportsDir: f.reportsDir };
  assert.deepEqual(readStatus(f.feedbackFile), {});
  const now = new Date();
  writeStatus(files, { id: "hn-2", status: "skipped", reason: "other" }, now);
  assert.deepEqual(readStatus(f.feedbackFile), { "hn-2": { status: "skipped", updatedAt: now.toISOString(), reason: "other", note: "" } });
  assert.equal(loadCards(f.reportsDir, "gridpeek", "2026-10-21-2100", readStatus(f.feedbackFile))[1].status, "skipped");
  assert.deepEqual(listApps(f.reportsDir), ["gridpeek"]);
  assert.equal(listRuns(f.reportsDir, "gridpeek").length, 2, "'notes' isn't a run");
});

// --- Redesign (fonts, engagement) ----------------------------------------------------

test("bundled Poppins fonts are served by exact name only", async () => {
  const { port } = await startDashboard();
  const ok = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/fonts/poppins-600.woff2", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], bytes: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.type, "font/woff2");
  assert.equal(ok.bytes.subarray(0, 4).toString("latin1"), "wOF2", "a real woff2 file");
  for (const path of ["/fonts/OFL.txt", "/fonts/poppins-600.woff2.bak", "/fonts/../dashboard.js", "/fonts/%2e%2e%2fdashboard.js", "/fonts/", "/fonts/Poppins-600.woff2"]) {
    assert.equal((await request(port, { path })).status, 404, path);
  }
  const csp = (await request(port)).headers["content-security-policy"];
  assert.match(csp, /font-src 'self'/);
});

test("cards carry engagement as numbers only", () => {
  const f = fixture();
  const cardsFile = join(f.reportsDir, "gridpeek", "2026-10-21-2100", "cards.json");
  const data = JSON.parse(readFileSync(cardsFile, "utf8"));
  data.cards[0].engagement = { score: 524, comments: 278, evil: "<script>", nested: { x: 1 }, "bad key!": 3, hasReplies: true };
  writeFileSync(cardsFile, JSON.stringify(data));
  const card = loadCards(f.reportsDir, "gridpeek", "2026-10-21-2100")[0];
  assert.deepEqual(card.engagement, { score: 524, comments: 278, hasReplies: true });
});

test("the page credits its icons and fonts, and shows the current logo mark (not the old checkmark)", async () => {
  const { port } = await startDashboard();
  const page = (await request(port)).text;
  assert.match(page, /Solar by 480 Design \(CC BY 4\.0/);
  assert.match(page, /Simple Icons \(CC0\)/);
  assert.match(page, /Poppins \(SIL Open Font License 1\.1\)/);
  const sidebar = page.slice(page.indexOf('<aside class="side"'), page.indexOf("</aside>"));
  // The old violet speech-bubble checkmark was removed on request; the rebrand's highlighter
  // mark (docs/brand/logo-mark.svg) sits next to the wordmark instead.
  assert.ok(sidebar.includes('class="brand-mark"'), "sidebar shows the logo mark");
  assert.ok(!page.includes("M10.6 13.6l3.7 3.7 7.3-7.3"), "the old checkmark path is gone");
  // All pickers use the custom dropdown (the native <select> popup ignores the page design).
  assert.ok(!/<select[\s>]/.test(page), "no native <select> elements");
  for (const id of ["dd-app", "dd-run", "dd-platform", "dd-sort"]) {
    assert.ok(page.includes(`id="${id}"`), `custom dropdown ${id} exists`);
  }
  assert.match(page, /aria-haspopup="listbox"/);
});

test("dashboard cards carry the thread line, also-posted links, and the run's prefilter summary", async () => {
  const f = fixture();
  const cardsFile = join(f.reportsDir, "gridpeek", "2026-10-21-2100", "cards.json");
  const data = JSON.parse(readFileSync(cardsFile, "utf8"));
  data.prefilter = { found: 50, candidates: 2, dropped: { duplicate: 8 } };
  data.cards[0].context = { commentCount: 7, appsAlreadySuggested: 3, solved: false, locked: false, topComments: [{ author: "a", excerpt: "<b>hi</b>", score: 1, email: "x@y" }] };
  data.cards[0].alsoPostedAt = ["https://forum.example/t/1", "javascript:alert(1)"];
  writeFileSync(cardsFile, JSON.stringify(data));
  const dash = createDashboard({ reportsDir: f.reportsDir, feedbackFile: f.feedbackFile, legacyStatusFile: f.statusFile });
  servers.push(dash);
  const { port } = await dash.start({ port: 0 });
  const r = (await request(port, { path: "/api/cards?app=gridpeek&run=latest" })).json();
  assert.equal(r.prefilter, "Prefilter: 50 found → 2 candidates · dropped 8 duplicates");
  const c = r.cards[0];
  assert.equal(c.contextLine, "Thread: 7 comments · 3 apps already suggested · not solved");
  assert.deepEqual(c.alsoPostedAt, ["https://forum.example/t/1"], "only http(s) links pass");
  assert.ok(!JSON.stringify(c.context).includes("x@y"), "only author/excerpt/score are kept per comment");
  assert.equal((await request(port, { path: "/api/cards?app=gridpeek&run=all" })).json().prefilter, "", "no single summary for all runs");
});

test("a broken feedback.json: the page gets a warning, saves fail with a clear message, the file is kept", async () => {
  const { port, feedbackFile } = await startDashboard();
  writeFileSync(feedbackFile, "{broken");
  const cards = (await request(port, { path: "/api/cards?app=gridpeek&run=latest" })).json();
  assert.equal(cards.cards.length, 2);
  assert.match(cards.warning, /isn't valid JSON/);
  const r = await post(port, { id: "sc-1", status: "replied" });
  assert.equal(r.status, 500);
  assert.match(r.json().error, /feedback\.json .* isn't valid JSON/);
  assert.ok(!r.text.includes(feedbackFile) && !r.text.includes(tmpdir()), "no file path in the error");
  assert.equal(readFileSync(feedbackFile, "utf8"), "{broken");
});

test("the app icon is served for Safari (/favicon.ico) and bookmarks; other icon paths are 404", async () => {
  const { port } = await startDashboard();
  const ico = await request(port, { path: "/favicon.ico" });
  assert.equal(ico.status, 200);
  assert.equal(ico.headers["content-type"], "image/x-icon");
  const touch = await request(port, { path: "/apple-touch-icon.png" });
  assert.equal(touch.status, 200);
  assert.equal(touch.headers["content-type"], "image/png");
  assert.equal((await request(port, { path: "/icons/favicon.ico" })).status, 404, "only the exact routes");
  const page = (await request(port, { path: "/" })).text;
  assert.match(page, /<link rel="icon" href="\/favicon\.ico"/);
  assert.match(page, /<symbol id="logo-mark"/);
});
