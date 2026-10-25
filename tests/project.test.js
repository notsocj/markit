// Tests for lib/project.js (project scanning + app picking), `setup.js scan`,
// `setup.js app --dry-run`, and pick-app.js.
//
// The most important checks: secrets, .env files, node_modules, build output, and lock
// files NEVER appear in the scan output, and no file contents leak into it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync, symlinkSync } from "node:fs";
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
  findAppIcon,
} from "../skills/markit-find/scripts/lib/project.js";
import { iconType } from "../skills/markit-find/scripts/lib/app-icon.js";

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
  for (const name of [".env", ".env.production", "prod.env", "secrets.yml", "client_secret.json", "credentials.json", "keys.json", "api-key.txt", "apikey.js", "AuthKey_X.p8", "dist.p12", "release.keystore", "server.pem", "id_rsa", "google-services.json", "GoogleService-Info.plist", "firebase-adminsdk-abc.json", "service-account.json", ".npmrc", "tokens.json", "private.key", "prod.env.local", "app.env.production", ".ENV", "ID_RSA"]) {
    assert.equal(isSensitiveFile(name), true, name);
  }
  for (const name of ["README.md", "package.json", "keywords.txt", "keyboard.tsx", "monkey.js", "description.txt", "en.json", "privacy.md", "environment.ts", "app.environment.ts"]) {
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

test("folders are skipped whatever their casing, and secret-named folders are never walked", () => {
  // Each folder holds a store-listing file, which the scan would otherwise list.
  const listing = (dir) => `${dir}/fastlane/metadata/description.txt`;
  const hidden = ["Build", "DIST", "Node_Modules", "NODE_MODULES", "Release", "Vendor", "secrets", "Credentials", "Private", "keys", "Tokens", "a/b/node_modules", "src/Secrets"];
  const files = { "package.json": '{"name":"x"}', [listing("ok")]: "fine", [listing("password-manager")]: "a real app folder" };
  for (const dir of hidden) files[listing(dir)] = SECRET;
  const found = scanProject(makeProject(files)).readingList.storeListing.map((f) => f.split("/fastlane/")[0].replace(/^.*?gridpeek\//, ""));
  assert.deepEqual(found.sort(), ["ok", "password-manager"], "only the harmless folders are listed");
});

test("symlinked files and folders are never followed out of the project", () => {
  const root = makeProject({ "package.json": '{"name":"x"}', "README.md": "# x" });
  const outside = makeProject({ "fastlane/metadata/description.txt": SECRET, "README.md": SECRET }, "outside");
  symlinkSync(outside, join(root, "linked-folder"));
  symlinkSync(join(outside, "README.md"), join(root, "docs.md"));
  symlinkSync(join(outside, "fastlane"), join(root, "fastlane"));
  const result = scanProject(root);
  assert.ok(!JSON.stringify(result).includes("outside"), "scan mentions a path outside the project");
  assert.deepEqual(result.readingList.storeListing, []);
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

// --- App icon ---------------------------------------------------------------

// Smallest bytes that pass as each image type (the signature plus padding).
const PNG = (pad = 8) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(pad)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(12)]);

test("iconType reads the image format from the bytes, never the name", () => {
  assert.deepEqual([PNG(), JPG, WEBP, ICO].map(iconType), ["png", "jpg", "webp", "ico"]);
  assert.equal(iconType(Buffer.from('<svg onload="alert(1)"></svg>')), null);
  assert.equal(iconType(Buffer.from("not an image at all")), null);
});

test("findAppIcon: Expo's app.json icon first, real images only, never outside the project", () => {
  const root = makeProject({
    "package.json": "{}",
    "app.json": JSON.stringify({ expo: { icon: "./assets/brand/app.png" } }),
    "assets/brand/app.png": PNG(),
    "public/favicon.ico": ICO,
  });
  assert.equal(findAppIcon(root), join(root, "assets/brand/app.png"));

  // A .png that isn't really an image, an SVG, and a path that leaves the project are skipped.
  const outside = join(dirname(root), "outside.png");
  writeFileSync(outside, PNG());
  const tricky = makeProject({
    "package.json": "{}",
    "app.json": JSON.stringify({ expo: { icon: "../outside.png" } }),
    "assets/icon.png": SECRET,
    "public/icon.svg": "<svg/>",
    "public/favicon.ico": ICO,
  });
  assert.equal(findAppIcon(tricky), join(tricky, "public/favicon.ico"));

  // A symlinked folder pointing outside the project doesn't count either.
  const linked = makeProject({ "package.json": "{}" });
  mkdirSync(join(dirname(linked), "elsewhere"));
  writeFileSync(join(dirname(linked), "elsewhere", "icon.png"), PNG());
  symlinkSync(join(dirname(linked), "elsewhere"), join(linked, "assets"));
  assert.equal(findAppIcon(linked), null);
});

test("scan reports the icon: biggest iOS AppIcon, Android launcher, web icon over favicon.ico", () => {
  const ios = makeProject({
    "Package.swift": "",
    "ios/Gridpeek/Images.xcassets/AppIcon.appiconset/Contents.json": "{}",
    "ios/Gridpeek/Images.xcassets/AppIcon.appiconset/icon-60.png": PNG(10),
    "ios/Gridpeek/Images.xcassets/AppIcon.appiconset/icon-1024.png": PNG(500),
  });
  assert.equal(scanProject(ios).icon, join(ios, "ios/Gridpeek/Images.xcassets/AppIcon.appiconset/icon-1024.png"));

  const android = makeProject({ "build.gradle": "", "app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp": WEBP });
  assert.equal(scanProject(android).icon, join(android, "app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp"));

  const web = makeProject({ "package.json": "{}", "app/favicon.ico": ICO, "app/apple-icon.png": PNG() });
  assert.equal(scanProject(web).icon, join(web, "app/apple-icon.png"));

  assert.equal(scanProject(makeProject({ "icon.png": PNG() })).icon, null, "not a project: no icon");
});

test("setup.js app saves the icon only from that app's own project folder", () => {
  const configDir = join(mkdtempSync(join(tmpdir(), "markit-cfg-")), "markit");
  run(SETUP, ["init"], { cwd: tmpdir(), configDir });
  const draft = JSON.stringify({ url: "https://x.app", oneLiner: "a", audience: "people", keywords: ["app for this thing", "best tool for that", "alternative to Foo"] });
  const project = makeProject({ "package.json": JSON.stringify({ name: "gridpeek" }), "assets/icon.png": PNG() }, "gridpeek-app");

  const preview = run(SETUP, ["app", "--name", "gridpeek", "--dry-run"], { cwd: project, configDir, input: draft });
  assert.match(preview.out, /App icon: .*assets\/icon\.png/);
  assert.ok(!existsSync(join(configDir, "apps", "gridpeek.png")), "a dry run saves nothing");

  const saved = run(SETUP, ["app", "--name", "gridpeek"], { cwd: project, configDir, input: draft });
  assert.equal(saved.code, 0, saved.err);
  assert.match(saved.out, /Saved app icon/);
  assert.deepEqual(readFileSync(join(configDir, "apps", "gridpeek.png")), PNG());

  // Saving another app from this folder must not take gridpeek's icon.
  const other = run(SETUP, ["app", "--name", "keepr"], { cwd: project, configDir, input: draft });
  assert.equal(other.code, 0, other.err);
  assert.doesNotMatch(other.out, /icon/i);
  assert.ok(!existsSync(join(configDir, "apps", "keepr.png")));
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
