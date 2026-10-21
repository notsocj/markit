// End-to-end tests for markit-setup/scripts/setup.js. Each test runs the real script in a
// child process, pointed at a temporary config folder with MARKIT_CONFIG_DIR, so the
// real ~/.config/markit is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SETUP = fileURLToPath(new URL("../skills/markit-setup/scripts/setup.js", import.meta.url));
const IS_WINDOWS = process.platform === "win32";

// Run setup.js with arguments (and optional stdin) against a given config folder.
function run(dir, args, input) {
  const result = spawnSync(process.execPath, [SETUP, ...args], {
    encoding: "utf8",
    input: input ?? "",
    env: { ...process.env, MARKIT_CONFIG_DIR: dir },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const freshDir = () => join(mkdtempSync(join(tmpdir(), "markit-setup-")), "markit");

const profile = {
  url: "https://example.com",
  oneLiner: "F1 companion app for planning race weekends",
  audience: "Formula 1 fans",
  keywords: ["app for F1 race weekend", "F1 schedule app", "how do you track F1 sessions"],
  competitors: ["CompetitorA"],
  exclude: ["hiring"],
};

test("init creates folder, apps/, .env (600) and settings.json", () => {
  const dir = freshDir();
  const { code, out } = run(dir, ["init"]);
  assert.equal(code, 0);
  assert.match(out, /Created blank \.env/);

  const env = readFileSync(join(dir, ".env"), "utf8");
  for (const key of ["STACKEXCHANGE_KEY=", "YOUTUBE_API_KEY=", "BLUESKY_HANDLE=", "BLUESKY_APP_PASSWORD=", "THREADS_ACCESS_TOKEN=", "X_BEARER_TOKEN=", "SOCIALCRAWL_API_KEY="]) {
    assert.ok(env.includes(`\n${key}\n`), `template should have an empty ${key} line`);
  }
  if (!IS_WINDOWS) assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);

  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(settings.reportsDir, "~/markit-reports");
  assert.deepEqual(settings.x, { maxPostsPerRun: 30, maxPostsPerMonth: 900 });
  assert.ok(existsSync(join(dir, "apps")));
});

test("init never overwrites an existing .env or settings.json", () => {
  const dir = freshDir();
  run(dir, ["init"]);
  writeFileSync(join(dir, ".env"), "YOUTUBE_API_KEY=my-real-key\n");
  writeFileSync(join(dir, "settings.json"), '{ "lookbackDays": 3 }');
  const { code, out } = run(dir, ["init"]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "YOUTUBE_API_KEY=my-real-key\n");
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), '{ "lookbackDays": 3 }');
  assert.ok(!out.includes("my-real-key"), "init must never print .env contents");
});

test("init tightens .env permissions if they are too open", { skip: IS_WINDOWS }, () => {
  const dir = freshDir();
  run(dir, ["init"]);
  chmodSync(join(dir, ".env"), 0o644);
  const { out } = run(dir, ["init"]);
  assert.match(out, /fixed its permissions/);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
});

test("app saves a validated profile from stdin", () => {
  const dir = freshDir();
  run(dir, ["init"]);
  const { code, out } = run(dir, ["app", "--name", "gridpeek"], JSON.stringify(profile));
  assert.equal(code, 0, out);
  const saved = JSON.parse(readFileSync(join(dir, "apps", "gridpeek.json"), "utf8"));
  assert.equal(saved.name, "gridpeek");
  assert.deepEqual(saved.competitors, ["CompetitorA"]);
  assert.ok(saved.sources.includes("web"));
});

test("app refuses to overwrite unless --overwrite is given", () => {
  const dir = freshDir();
  run(dir, ["init"]);
  run(dir, ["app", "--name", "gridpeek"], JSON.stringify(profile));
  const again = run(dir, ["app", "--name", "gridpeek"], JSON.stringify({ ...profile, oneLiner: "Changed" }));
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists. Add --overwrite/);

  const forced = run(dir, ["app", "--name", "gridpeek", "--overwrite"], JSON.stringify({ ...profile, oneLiner: "Changed" }));
  assert.equal(forced.code, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, "apps", "gridpeek.json"), "utf8")).oneLiner, "Changed");
});

test("app reports validation problems and bad JSON clearly", () => {
  const dir = freshDir();
  run(dir, ["init"]);
  const invalid = run(dir, ["app", "--name", "gridpeek"], JSON.stringify({ url: "nope" }));
  assert.equal(invalid.code, 1);
  assert.match(invalid.err, /the app profile has problems/);
  assert.ok(!existsSync(join(dir, "apps", "gridpeek.json")));

  const notJson = run(dir, ["app", "--name", "gridpeek"], "{ not json");
  assert.equal(notJson.code, 1);
  assert.match(notJson.err, /not valid JSON/);

  const noName = run(dir, ["app"], JSON.stringify(profile));
  assert.match(noName.err, /--name is required/);

  const badName = run(dir, ["app", "--name", "../evil"], JSON.stringify(profile));
  assert.match(badName.err, /not allowed/);
});

test("app requires init first", () => {
  const { code, err } = run(freshDir(), ["app", "--name", "gridpeek"], JSON.stringify(profile));
  assert.equal(code, 1);
  assert.match(err, /not set up yet/);
});

test("status reports setup state, .env path, and apps as JSON", () => {
  const dir = freshDir();
  assert.equal(JSON.parse(run(dir, ["status"]).out).setUp, false);
  run(dir, ["init"]);
  run(dir, ["app", "--name", "gridpeek"], JSON.stringify(profile));
  const status = JSON.parse(run(dir, ["status"]).out);
  assert.deepEqual(status, { setUp: true, configDir: dir, envFile: join(dir, ".env"), envFileExists: true, apps: ["gridpeek"] });
});

test("unknown command prints usage and fails", () => {
  const { code, out } = run(freshDir(), ["bogus"]);
  assert.equal(code, 1);
  assert.match(out, /Usage:/);
});
