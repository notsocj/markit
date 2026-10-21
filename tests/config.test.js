// Tests for lib/config.js: where config lives on each platform, settings defaults,
// .env cleanup, and app-name safety.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigDir,
  getPaths,
  expandHome,
  cleanEnvValue,
  loadSettings,
  loadEnv,
  validateAppName,
  listApps,
  loadApp,
  DEFAULT_SETTINGS,
} from "../skills/markit-find/scripts/lib/config.js";

test("config dir on macOS/Linux is ~/.config/markit", () => {
  assert.equal(getConfigDir({ platform: "darwin", env: {}, home: "/Users/sam" }), "/Users/sam/.config/markit");
  assert.equal(getConfigDir({ platform: "linux", env: {}, home: "/home/sam" }), "/home/sam/.config/markit");
});

test("config dir on Windows is %APPDATA%\\markit", () => {
  const env = { APPDATA: "C:\\Users\\sam\\AppData\\Roaming" };
  assert.equal(getConfigDir({ platform: "win32", env, home: "C:\\Users\\sam" }), "C:\\Users\\sam\\AppData\\Roaming\\markit");
});

test("Windows falls back to AppData\\Roaming if APPDATA is missing", () => {
  assert.equal(getConfigDir({ platform: "win32", env: {}, home: "C:\\Users\\sam" }), "C:\\Users\\sam\\AppData\\Roaming\\markit");
});

test("MARKIT_CONFIG_DIR overrides the default (and expands ~)", () => {
  assert.equal(getConfigDir({ platform: "darwin", env: { MARKIT_CONFIG_DIR: "/tmp/mk" }, home: "/Users/sam" }), "/tmp/mk");
  assert.equal(getConfigDir({ platform: "darwin", env: { MARKIT_CONFIG_DIR: "~/mk" }, home: "/Users/sam" }), "/Users/sam/mk");
});

test("getPaths lists every config file inside the config dir", () => {
  const paths = getPaths({ platform: "linux", env: {}, home: "/home/sam" });
  assert.deepEqual(paths, {
    dir: "/home/sam/.config/markit",
    envFile: "/home/sam/.config/markit/.env",
    appsDir: "/home/sam/.config/markit/apps",
    settingsFile: "/home/sam/.config/markit/settings.json",
    seenFile: "/home/sam/.config/markit/seen.json",
    usageFile: "/home/sam/.config/markit/usage.json",
    statusFile: "/home/sam/.config/markit/status.json",
  });
});

test("getPaths uses backslashes on Windows", () => {
  const paths = getPaths({ platform: "win32", env: { APPDATA: "C:\\AD" }, home: "C:\\Users\\sam" });
  assert.equal(paths.envFile, "C:\\AD\\markit\\.env");
  assert.equal(paths.appsDir, "C:\\AD\\markit\\apps");
});

test("expandHome only touches paths starting with ~", () => {
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~/markit-reports", "/h"), "/h/markit-reports");
  assert.equal(expandHome("/abs/path", "/h"), "/abs/path");
  assert.equal(expandHome("not~home", "/h"), "not~home");
});

test("cleanEnvValue strips inline comments and treats comment-only values as empty", () => {
  assert.equal(cleanEnvValue(undefined), "");
  assert.equal(cleanEnvValue(""), "");
  assert.equal(cleanEnvValue("   # Google Cloud → YouTube Data API v3"), "");
  assert.equal(cleanEnvValue("abc123   # my key"), "abc123");
  assert.equal(cleanEnvValue("  abc123  "), "abc123");
  // A # with no space before it is part of the value, not a comment.
  assert.equal(cleanEnvValue("abc#123"), "abc#123");
});

// A fresh temp config folder for tests that read or write real files.
function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "markit-test-"));
  return getPaths({ platform: process.platform === "win32" ? "win32" : "linux", env: { MARKIT_CONFIG_DIR: dir } });
}

test("loadSettings returns defaults when settings.json is missing", () => {
  const settings = loadSettings(tempPaths(), "/h");
  assert.equal(settings.reportsDir, "/h/markit-reports");
  assert.equal(settings.lookbackDays, DEFAULT_SETTINGS.lookbackDays);
  assert.deepEqual(settings.x, DEFAULT_SETTINGS.x);
});

test("loadSettings merges nested caps instead of replacing them", () => {
  const paths = tempPaths();
  writeFileSync(paths.settingsFile, JSON.stringify({ lookbackDays: 3, x: { maxPostsPerRun: 10 } }));
  const settings = loadSettings(paths, "/h");
  assert.equal(settings.lookbackDays, 3);
  assert.equal(settings.x.maxPostsPerRun, 10);
  assert.equal(settings.x.maxPostsPerMonth, DEFAULT_SETTINGS.x.maxPostsPerMonth);
});

test("loadEnv returns only known keys, cleaned", () => {
  const paths = tempPaths();
  // Use a key name that is unlikely to already exist in the test runner's environment.
  delete process.env.SOCIALCRAWL_API_KEY;
  writeFileSync(paths.envFile, "SOCIALCRAWL_API_KEY=sc_test_123  # note\nSOMETHING_ELSE=nope\n");
  const env = loadEnv(paths.envFile);
  assert.equal(env.SOCIALCRAWL_API_KEY, "sc_test_123");
  assert.equal(env.SOMETHING_ELSE, undefined);
  delete process.env.SOCIALCRAWL_API_KEY;
});

test("loadEnv works when there is no .env file yet", () => {
  const env = loadEnv(join(tmpdir(), "definitely-missing-markit.env"));
  assert.equal(typeof env.YOUTUBE_API_KEY, "string");
});

test("validateAppName accepts simple names and rejects unsafe ones", () => {
  assert.equal(validateAppName("gridpeek"), "gridpeek");
  assert.equal(validateAppName("my-app-2"), "my-app-2");
  for (const bad of ["", "GridPeek", "../etc", "a/b", "-start", "has space", "a".repeat(41), undefined]) {
    assert.throws(() => validateAppName(bad), /not allowed/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("listApps and loadApp read profiles from apps/", () => {
  const paths = tempPaths();
  assert.deepEqual(listApps(paths), []);
  mkdirSync(paths.appsDir, { recursive: true });
  writeFileSync(join(paths.appsDir, "keepr.json"), JSON.stringify({ name: "keepr" }));
  writeFileSync(join(paths.appsDir, "gridpeek.json"), JSON.stringify({ name: "gridpeek" }));
  assert.deepEqual(listApps(paths), ["gridpeek", "keepr"]);
  assert.equal(loadApp("keepr", paths).name, "keepr");
  assert.throws(() => loadApp("nope", paths), /no app named "nope". Your apps: gridpeek, keepr/);
});
