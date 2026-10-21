// Tests for the dashboard's Settings page: lib/env-file.js (writing one key into .env) and
// the /api/settings endpoints (keys are write-only, sources switches). Temp folders and fake
// adapters only: no network, never the real ~/.config/markit.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEnvValue, validateKeyValue, writeEnvValue, keyStatus } from "../skills/markit-find/scripts/lib/env-file.js";
import { parseEnv } from "../skills/markit-find/scripts/lib/config.js";
import { createDashboard } from "../skills/markit-dashboard/scripts/dashboard.js";

const SECRET = "sk_live_SETTINGS_MUST_NEVER_RETURN_THIS";
const NEW_KEY = "AIzaNEWKEY_also_never_returned_123";

// --- lib/env-file.js ------------------------------------------------------------------

test("setEnvValue replaces one key, keeps every other line, and removes duplicates", () => {
  const before = "# marKit keys\n\n# YouTube\nYOUTUBE_API_KEY=\nX_BEARER_TOKEN=old\nexport X_BEARER_TOKEN=dupe\n# end\n";
  const after = setEnvValue(before, "X_BEARER_TOKEN", "new");
  assert.equal(after, "# marKit keys\n\n# YouTube\nYOUTUBE_API_KEY=\nX_BEARER_TOKEN=new\n# end\n");
  assert.equal(setEnvValue("A_COMMENT=1\n", "YOUTUBE_API_KEY", "k"), "A_COMMENT=1\nYOUTUBE_API_KEY=k\n", "appended when missing");
  assert.equal(setEnvValue("", "YOUTUBE_API_KEY", "k"), "YOUTUBE_API_KEY=k\n");
  assert.equal(parseEnv(setEnvValue(before, "X_BEARER_TOKEN", "")).X_BEARER_TOKEN, "", "empty value removes the key");
});

test("validateKeyValue only accepts known names and key-like values", () => {
  assert.equal(validateKeyValue("YOUTUBE_API_KEY", "  AIza-abc_123  ").value, "AIza-abc_123");
  assert.equal(validateKeyValue("X_BEARER_TOKEN", "AAAA%2BBBB%3D").ok, true, "URL-encoded bearer tokens are fine");
  assert.equal(validateKeyValue("BLUESKY_HANDLE", "me.bsky.social").ok, true);
  assert.equal(validateKeyValue("YOUTUBE_API_KEY", "").ok, true, "empty = remove");
  for (const bad of ["two words", 'quo"te', "has#hash", "line\nOTHER_KEY=evil", "tab\tkey", "x".repeat(1001)]) {
    assert.equal(validateKeyValue("YOUTUBE_API_KEY", bad).ok, false, JSON.stringify(bad.slice(0, 20)));
  }
  assert.equal(validateKeyValue("PATH", "x").ok, false, "only marKit's own keys");
  assert.equal(validateKeyValue("YOUTUBE_API_KEY", 42).ok, false);
});

test("writeEnvValue writes atomically with owner-only permissions and reports only set/not set", () => {
  const dir = mkdtempSync(join(tmpdir(), "markit-env-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, "# keep me\nYOUTUBE_API_KEY=\n", { mode: 0o644 });
  assert.deepEqual(writeEnvValue(envFile, "YOUTUBE_API_KEY", NEW_KEY), { set: true });
  assert.equal(readFileSync(envFile, "utf8"), `# keep me\nYOUTUBE_API_KEY=${NEW_KEY}\n`);
  if (process.platform !== "win32") assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.equal(keyStatus(envFile).YOUTUBE_API_KEY, true);
  assert.equal(keyStatus(envFile).X_BEARER_TOKEN, false);
  assert.throws(() => writeEnvValue(envFile, "YOUTUBE_API_KEY", "bad value"), (err) => !err.message.includes("bad value"));
});

// --- /api/settings ---------------------------------------------------------------------

const servers = [];
after(() => servers.forEach((d) => d.stop("test done")));

const PROFILE = { name: "gridpeek", url: "https://x.example", oneLiner: "o", audience: "a", keywords: ["a b c", "d e f", "g h i"], sources: ["hackernews", "web"] };

function fakeAdapter(name, result) {
  return { name, label: name, requiredEnv: [], isEnabled: (env) => Boolean(env.SOCIALCRAWL_API_KEY || env.X_BEARER_TOKEN || env.YOUTUBE_API_KEY), check: async () => result, checkUsesQuota: false };
}

async function start() {
  const home = mkdtempSync(join(tmpdir(), "markit-settings-"));
  const configDir = join(home, "config");
  mkdirSync(join(configDir, "apps"), { recursive: true });
  mkdirSync(join(home, "reports"), { recursive: true });
  const envFile = join(configDir, ".env");
  writeFileSync(envFile, `# my keys\nX_BEARER_TOKEN=${SECRET}\nYOUTUBE_API_KEY=\n`, { mode: 0o600 });
  writeFileSync(join(configDir, "apps", "gridpeek.json"), JSON.stringify(PROFILE));
  const dash = createDashboard({
    reportsDir: join(home, "reports"),
    feedbackFile: join(configDir, "feedback.json"),
    envFile,
    appsDir: join(configDir, "apps"),
    usageFile: join(configDir, "usage.json"),
    adapters: [fakeAdapter("x", "ok"), fakeAdapter("youtube", "invalid")],
  });
  servers.push(dash);
  const { port } = await dash.start({ port: 0 });
  const page = (await request(port, { path: "/" })).text;
  const token = /const PAGE_TOKEN = "([0-9a-f]{48})"/.exec(page)?.[1];
  return { port, envFile, configDir, token };
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const post = (port, path, body, token, extra = {}) =>
  request(port, { method: "POST", path, body: JSON.stringify(body), headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...(token ? { "x-markit-token": token } : {}), ...extra } });

test("the page carries a per-start token; GET /api/settings says which keys are set but never their values", async () => {
  const { port, token } = await start();
  assert.ok(token, "token is in the page");
  const r = await request(port, { path: "/api/settings" });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(SECRET), "no key value in the response");
  const x = r.json().sources.find((s) => s.source === "x");
  assert.deepEqual([x.ready, x.keys[0].set], [true, true]);
  assert.equal(r.json().sources.find((s) => s.source === "youtube").ready, false);
  assert.deepEqual(r.json().apps, [{ name: "gridpeek", sources: ["hackernews", "web"], socialcrawlPlatforms: ["reddit"] }]);
});

test("POST /api/settings/key writes .env (write-only), keeping other lines; needs origin + token", async () => {
  const { port, envFile, token } = await start();
  assert.equal((await post(port, "/api/settings/key", { name: "YOUTUBE_API_KEY", value: NEW_KEY })).status, 403, "no token");
  assert.equal((await post(port, "/api/settings/key", { name: "YOUTUBE_API_KEY", value: NEW_KEY }, "f".repeat(48))).status, 403, "wrong token");
  assert.equal((await post(port, "/api/settings/key", { name: "YOUTUBE_API_KEY", value: NEW_KEY }, token, { origin: "https://evil.example" })).status, 403, "foreign origin");
  assert.ok(!readFileSync(envFile, "utf8").includes(NEW_KEY), "nothing written so far");

  const ok = await post(port, "/api/settings/key", { name: "YOUTUBE_API_KEY", value: NEW_KEY }, token);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { name: "YOUTUBE_API_KEY", set: true });
  assert.ok(!ok.text.includes(NEW_KEY), "the key is not echoed back");
  assert.equal(readFileSync(envFile, "utf8"), `# my keys\nX_BEARER_TOKEN=${SECRET}\nYOUTUBE_API_KEY=${NEW_KEY}\n`);
  if (process.platform !== "win32") assert.equal(statSync(envFile).mode & 0o777, 0o600);

  const removed = await post(port, "/api/settings/key", { name: "X_BEARER_TOKEN", value: "" }, token);
  assert.deepEqual(removed.json(), { name: "X_BEARER_TOKEN", set: false });
  assert.ok(!readFileSync(envFile, "utf8").includes(SECRET));
});

test("POST /api/settings/key refuses anything that could break or inject into .env", async () => {
  const { port, envFile, token } = await start();
  const before = readFileSync(envFile, "utf8");
  const cases = [
    { name: "YOUTUBE_API_KEY", value: "abc\nSOCIALCRAWL_API_KEY=evil" },
    { name: "YOUTUBE_API_KEY", value: "has space" },
    { name: "PATH", value: "x" },
    { name: "YOUTUBE_API_KEY" },
    { name: "YOUTUBE_API_KEY", value: "x", extra: 1 },
    { name: "YOUTUBE_API_KEY", value: ["x"] },
  ];
  for (const body of cases) assert.equal((await post(port, "/api/settings/key", body, token)).status, 400, JSON.stringify(body));
  const huge = await post(port, "/api/settings/key", { name: "YOUTUBE_API_KEY", value: "x".repeat(5000) }, token);
  assert.equal(huge.status, 413);
  assert.equal(readFileSync(envFile, "utf8"), before, "file untouched");
});

test("POST /api/settings/test runs that source's check() and returns only the result", async () => {
  const { port, token } = await start();
  const x = await post(port, "/api/settings/test", { source: "x" }, token);
  assert.deepEqual(x.json(), { source: "x", result: "ok" });
  assert.ok(!x.text.includes(SECRET));
  assert.deepEqual((await post(port, "/api/settings/test", { source: "socialcrawl" }, token)).json().result, "error", "no adapter in this test = error, never a crash");
  assert.equal((await post(port, "/api/settings/test", { source: "../etc" }, token)).status, 400);
  assert.equal((await post(port, "/api/settings/test", { source: "x" })).status, 403, "token needed");
});

test("POST /api/settings/app changes only sources / socialcrawlPlatforms, validated like /markit-setup", async () => {
  const { port, configDir, token } = await start();
  const file = join(configDir, "apps", "gridpeek.json");
  const r = await post(port, "/api/settings/app", { app: "gridpeek", sources: ["hackernews", "web", "socialcrawl"], socialcrawlPlatforms: ["reddit", "threads"] }, token);
  assert.equal(r.status, 200, r.text);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.sources, ["hackernews", "web", "socialcrawl"]);
  assert.deepEqual(saved.socialcrawlPlatforms, ["reddit", "threads"]);
  assert.deepEqual(saved.keywords, PROFILE.keywords, "everything else kept");

  const bad = [
    { app: "gridpeek", sources: ["hackernews", "evil"] },
    { app: "gridpeek", sources: [] },
    { app: "gridpeek", socialcrawlPlatforms: ["tiktok"] },
    { app: "gridpeek", keywords: ["x"] },
    { app: "../gridpeek", sources: ["web"] },
    { app: "nope", sources: ["web"] },
    { app: "gridpeek" },
  ];
  for (const body of bad) assert.equal((await post(port, "/api/settings/app", body, token)).status, 400, JSON.stringify(body));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).sources, ["hackernews", "web", "socialcrawl"], "unchanged by bad requests");
});

test("without envFile/appsDir the Settings endpoints don't exist", async () => {
  const home = mkdtempSync(join(tmpdir(), "markit-settings-off-"));
  const dash = createDashboard({ reportsDir: home, feedbackFile: join(home, "feedback.json") });
  servers.push(dash);
  const { port } = await dash.start({ port: 0 });
  assert.equal((await request(port, { path: "/api/settings" })).status, 404);
});
