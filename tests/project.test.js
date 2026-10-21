// Tests for lib/project.js (project scanning + app picking), `setup.js scan`,
// `setup.js app --dry-run`, and pick-app.js.
//
// The most important checks: secrets, .env files, node_modules, build output, and lock
// files NEVER appear in the scan output, and no file contents leak into it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  scanProject,
  pickApp,
  normalizeName,
  isSensitiveFile,
  isLockFile,
  projectNames,
} from "../skills/markit-find/scripts/lib/project.js";

const SECRET = "sk_live_DO_NOT_LEAK_42";

// Create files from a { "relative/path": "contents" } map inside a new temp folder.
function makeProject(files, folderName = "gridpeek") {
  const root = join(mkdtempSync(join(tmpdir(), "markit-proj-")), folderName);
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const sampleApp = () =>
  makeProject({
    "README.md": "# GridPeek\nPlan your F1 race weekend.",
    "package.json": JSON.stringify({ name: "@acme/grid-peek", description: "F1 weekend planner", homepage: "https://gridpeek.app", keywords: ["f1"] }),
    "app.json": JSON.stringify({ expo: { name: "GridPeek", slug: "gridpeek" } }),
    "ios/GridPeek/Info.plist": "<plist><dict><key>CFBundleDisplayName</key><string>GridPeek</string><key>CFBundleName</key><string>$(PRODUCT_NAME)</string></dict></plist>",
    "app/page.tsx": "export default function Home() {}",
    "app/settings/page.tsx": "x",
    "app/(auth)/login/page.tsx": "x",
    "src/screens/SessionTimerScreen.tsx": "x",
    "src/screens/SessionTimerScreen.test.tsx": "x",
    "locales/en.json": '{"hello":"Hello"}',
    "locales/fr.json": '{"hello":"Bonjour"}',
    "fastlane/metadata/en-US/description.txt": "Never miss a session.",
    "fastlane/metadata/de-DE/description.txt": "Verpasse keine Session.",
    // --- Things that must NEVER show up ---
    ".env": `API_KEY=${SECRET}`,
    ".env.local": `API_KEY=${SECRET}`,
    "config/production.env": SECRET,
    "src/config/secrets.json": SECRET,
    "src/config/credentials.ts": SECRET,
    "keys.json": SECRET,
    "api-key.txt": SECRET,
    "android/app/google-services.json": SECRET,
    "ios/GridPeek/GoogleService-Info.plist": SECRET,
    "certs/AuthKey_ABC.p8": SECRET,
    "certs/dist.p12": SECRET,
    ".npmrc": `//registry.npmjs.org/:_authToken=${SECRET}`,
    "node_modules/some-lib/README.md": "nope",
    "node_modules/some-lib/index.html": "nope",
    "dist/index.html": "nope",
    "build/index.html": "nope",
    ".git/config": "nope",
    ".next/server/app/page.js": "nope",
    "package-lock.json": "{}",
    "yarn.lock": "",
    "ios/Podfile.lock": "",
  });

test("isSensitiveFile flags secret-looking names but not normal ones", () => {
  for (const name of [".env", ".env.production", "prod.env", "secrets.yml", "client_secret.json", "credentials.json", "keys.json", "api-key.txt", "apikey.js", "AuthKey_X.p8", "dist.p12", "release.keystore", "server.pem", "id_rsa", "google-services.json", "GoogleService-Info.plist", "firebase-adminsdk-abc.json", "service-account.json", ".npmrc", "tokens.json", "private.key"]) {
    assert.equal(isSensitiveFile(name), true, name);
  }
  for (const name of ["README.md", "package.json", "keywords.txt", "keyboard.tsx", "monkey.js", "description.txt", "en.json", "privacy.md"]) {
    assert.equal(isSensitiveFile(name), false, name);
  }
});

test("isLockFile flags lock files", () => {
  for (const name of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Podfile.lock", "pubspec.lock", "Cargo.lock", "npm-shrinkwrap.json"]) {
    assert.equal(isLockFile(name), true, name);
  }
  assert.equal(isLockFile("package.json"), false);
});

test("scan never lists or leaks secrets, deps, build output, or lock files", () => {
  const root = sampleApp();
  const result = scanProject(root);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(SECRET), "a secret value leaked into the scan output");
  for (const bad of [".env", "production.env", "secrets.json", "credentials.ts", "keys.json", "api-key.txt", "google-services", "GoogleService-Info", ".p8", ".p12", ".npmrc", "node_modules", "dist/", "build/", ".git/", ".next", "package-lock", "yarn.lock", "Podfile.lock"]) {
    assert.ok(!text.includes(bad), `scan output mentions ${bad}`);
  }
});

test("scan detects the project and reads only name/description/homepage metadata", () => {
  const result = scanProject(sampleApp());
  assert.equal(result.isProject, true);
  assert.deepEqual(result.metadata, {
    // app.json is read before package.json (files are visited alphabetically).
    names: ["GridPeek", "gridpeek", "grid-peek"],
    description: "F1 weekend planner",
    url: "https://gridpeek.app",
    keywords: ["f1"],
  });
});

test("scan builds a short, English-first reading list and lists screen names", () => {
  const root = sampleApp();
  const { readingList, screens } = scanProject(root);
  assert.deepEqual(readingList.readme, [join(root, "README.md")]);
  assert.equal(readingList.storeListing[0], join(root, "fastlane/metadata/en-US/description.txt"));
  assert.deepEqual(readingList.landing, [join(root, "app/page.tsx")]);
  assert.deepEqual(readingList.translations, [join(root, "locales/en.json"), join(root, "locales/fr.json")]);
  assert.deepEqual(screens.sort(), ["/", "/login", "/settings", "SessionTimerScreen"].sort());
});

test("monorepo with an Expo Router app in apps/mobile", () => {
  const root = makeProject({
    "README.md": "# Gridpeek",
    "product.md": "What the app is.",
    "docs/APP-STORE.md": "Store copy.",
    "docs/circuits/README.md": "About the circuit SVGs (not the app).",
    "apps/mobile/package.json": JSON.stringify({ name: "gridpeek-mobile" }),
    "apps/mobile/app.json": JSON.stringify({ expo: { name: "Gridpeek", slug: "gridpeek" } }),
    "apps/mobile/app.config.js": `export default { extra: { key: process.env.SECRET } }`,
    "apps/mobile/ios/Gridpeek.xcodeproj/project.pbxproj": "build settings",
    "apps/mobile/ios/Gridpeek/Info.plist": "<key>CFBundleDisplayName</key><string>Gridpeek</string>",
    "apps/mobile/ios/NextUpWidget/Info.plist": "<key>CFBundleDisplayName</key><string>Next Up</string>",
    "apps/mobile/app/_layout.tsx": "x",
    "apps/mobile/app/onboarding.tsx": "x",
    "apps/mobile/app/dev.tsx": "x",
    "apps/mobile/app/+not-found.tsx": "x",
    "apps/mobile/app/(tabs)/_layout.tsx": "x",
    "apps/mobile/app/(tabs)/index.tsx": "x",
    "apps/mobile/app/(tabs)/settings/index.tsx": "x",
    "apps/mobile/app/(tabs)/settings/document/[id].tsx": "x",
    "apps/mobile/store/screenshots/index.html": "<h1>Never miss a session</h1>",
    "apps/mobile/store/review/sample-ticket.html": "fake ticket for App Review",
    "apps/mobile/store/screenshots/export/01-home.png": "",
  });
  const result = scanProject(root);
  assert.equal(result.isProject, true);
  assert.deepEqual(result.markers, ["apps/mobile/app.json", "apps/mobile/package.json", "apps/mobile/ios/Gridpeek.xcodeproj"]);
  assert.deepEqual(result.metadata.names, ["Gridpeek", "gridpeek", "gridpeek-mobile"], "main app plist only, not the widget's");
  assert.deepEqual(result.readingList.readme, [join(root, "README.md")], "docs/circuits/README.md is not the app's README");
  assert.deepEqual(result.readingList.docs, [join(root, "product.md")]);
  assert.deepEqual(result.readingList.storeListing, [join(root, "docs/APP-STORE.md"), join(root, "apps/mobile/store/screenshots/index.html")]);
  assert.deepEqual(result.screens.sort(), ["/", "/onboarding", "/settings", "/settings/document/[id]"].sort());
  const text = JSON.stringify(result);
  assert.ok(!text.includes("app.config.js") && !text.includes("project.pbxproj") && !text.includes(".png"));
});

test("scan of a non-project folder says so", () => {
  const root = makeProject({ "notes.txt": "hello", "photos/a.jpg": "" }, "Documents");
  const result = scanProject(root);
  assert.equal(result.isProject, false);
  assert.deepEqual(result.metadata.names, []);
});

test("Flutter pubspec.yaml metadata is read", () => {
  const root = makeProject({ "pubspec.yaml": "name: keepr\ndescription: Keep receipts tidy.\nhomepage: https://keepr.app\n", "lib/l10n/app_en.arb": "{}" }, "keepr");
  const result = scanProject(root);
  assert.equal(result.isProject, true);
  assert.deepEqual(result.metadata.names, ["keepr"]);
  assert.equal(result.metadata.description, "Keep receipts tidy.");
  assert.deepEqual(result.readingList.translations, [join(root, "lib/l10n/app_en.arb")]);
});

test("normalizeName ignores case, scope, and punctuation", () => {
  assert.equal(normalizeName("@acme/Grid-Peek"), "gridpeek");
  assert.equal(normalizeName("Grid Peek"), "gridpeek");
});

test("pickApp: requested app wins, unknown requested app fails", () => {
  assert.deepEqual(pickApp({ requested: "keepr", apps: ["gridpeek", "keepr"], cwd: tmpdir() }).app, "keepr");
  assert.throws(() => pickApp({ requested: "nope", apps: ["gridpeek"], cwd: tmpdir() }), /no app named "nope"/);
});

test("pickApp: folder name match", () => {
  const cwd = makeProject({ "README.md": "x" }, "GridPeek");
  const result = pickApp({ apps: ["gridpeek", "keepr"], cwd });
  assert.equal(result.app, "gridpeek");
  assert.equal(result.reason, "folder");
});

test("pickApp: package name match when the folder name differs", () => {
  const cwd = makeProject({ "package.json": JSON.stringify({ name: "@acme/keepr" }) }, "my-code");
  assert.deepEqual(projectNames(cwd), ["keepr"]);
  const result = pickApp({ apps: ["gridpeek", "keepr"], cwd });
  assert.equal(result.app, "keepr");
  assert.equal(result.reason, "package");
});

test("pickApp: falls back to the only profile, otherwise asks", () => {
  const cwd = makeProject({ "README.md": "x" }, "unrelated");
  assert.equal(pickApp({ apps: ["gridpeek"], cwd }).reason, "only");
  assert.deepEqual(pickApp({ apps: ["gridpeek", "keepr"], cwd }), { app: null, reason: "ask", apps: ["gridpeek", "keepr"] });
  assert.equal(pickApp({ apps: [], cwd }).reason, "none");
});

// --- The CLI scripts ---

const SETUP = fileURLToPath(new URL("../skills/markit-setup/scripts/setup.js", import.meta.url));
const PICK = fileURLToPath(new URL("../skills/markit-find/scripts/pick-app.js", import.meta.url));

function run(script, args, { cwd, configDir, input = "" }) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: "utf8", env: { ...process.env, MARKIT_CONFIG_DIR: configDir } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("setup.js scan scans the current folder by default and --dir when given", () => {
  const root = sampleApp();
  const configDir = join(mkdtempSync(join(tmpdir(), "markit-cfg-")), "markit");
  const fromCwd = JSON.parse(run(SETUP, ["scan"], { cwd: root, configDir }).out);
  // realpath: on macOS the temp folder /var/... is really /private/var/..., and a child
  // process started there reports the real path as its current folder.
  assert.equal(fromCwd.dir, realpathSync(root));
  const fromDir = JSON.parse(run(SETUP, ["scan", "--dir", root], { cwd: tmpdir(), configDir }).out);
  assert.equal(fromDir.isProject, true);
  assert.ok(!JSON.stringify(fromDir).includes(SECRET));
});

test("setup.js app --dry-run validates and prints without saving", () => {
  const configDir = join(mkdtempSync(join(tmpdir(), "markit-cfg-")), "markit");
  run(SETUP, ["init"], { cwd: tmpdir(), configDir });
  const draft = { url: "https://gridpeek.app", oneLiner: "F1 weekend planner", audience: "F1 fans", features: ["session timers", "weekend schedule"], keywords: ["app to track F1 sessions", "F1 schedule app", "alternative to Foo"] };
  const r = run(SETUP, ["app", "--name", "gridpeek", "--dry-run"], { cwd: tmpdir(), configDir, input: JSON.stringify(draft) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /is valid \(not saved yet\)/);
  assert.match(r.out, /"session timers"/);
  assert.ok(!existsSync(join(configDir, "apps", "gridpeek.json")));
});

test("pick-app.js prints the choice and a message", () => {
  const configDir = join(mkdtempSync(join(tmpdir(), "markit-cfg-")), "markit");
  run(SETUP, ["init"], { cwd: tmpdir(), configDir });
  const profile = (n) => JSON.stringify({ url: "https://x.app", oneLiner: n, audience: "people", keywords: ["app for this thing", "best tool for that", "alternative to Foo"] });
  run(SETUP, ["app", "--name", "gridpeek"], { cwd: tmpdir(), configDir, input: profile("a") });
  run(SETUP, ["app", "--name", "keepr"], { cwd: tmpdir(), configDir, input: profile("b") });

  const inProject = JSON.parse(run(PICK, [], { cwd: makeProject({ "README.md": "x" }, "gridpeek"), configDir }).out);
  assert.equal(inProject.app, "gridpeek");
  assert.equal(inProject.message, `Using app profile "gridpeek" (matches this folder's name, "gridpeek").`);

  const elsewhere = JSON.parse(run(PICK, [], { cwd: makeProject({ "README.md": "x" }, "other"), configDir }).out);
  assert.equal(elsewhere.app, null);
  assert.equal(elsewhere.message, "Which app should I search for? Your apps: gridpeek, keepr.");

  const unknown = run(PICK, ["--app", "nope"], { cwd: tmpdir(), configDir });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no app named "nope"/);
});
