// project.js — looks at the user's current folder to learn about their app.
//
// Two jobs:
//
// 1. scanProject(dir) — used by `/markit-setup` to draft an app profile automatically.
//    It does NOT read file contents (except a few metadata fields, see below). It builds
//    a short, SAFE reading list: README, store listing copy, landing page, translation
//    files, plus screen/route NAMES. The agent then reads only files on that list.
//
//    Safety is enforced here in code, not left to the agent's judgment:
//      - .env files, keys, certificates, credentials, and anything secret-sounding are
//        never listed (isSensitiveFile).
//      - node_modules, build/dist output, .git and other tool folders are never entered.
//      - Lock files are never listed.
//    The walk is also kept light: limited depth, limited number of files.
//
// 2. pickApp() — used by `/markit-find` with no app name. If the current folder's name or
//    package name matches a saved profile, that profile is used.
//
// The only files whose contents this module reads are package.json, app.json,
// pubspec.yaml, Info.plist, and Android strings.xml, and only to pull out the app's name,
// description, and homepage. findAppIcon() also opens image files at the usual icon spots,
// but only to check they're real images (lib/app-icon.js); /markit-setup copies the one it
// picks next to the profile for the dashboard.

import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { readIconFile } from "./app-icon.js";

// --- What to never touch ---------------------------------------------------

// Folders we never walk into: dependencies, build output, caches, and tool folders.
// (All folders starting with "." are skipped too, e.g. .git, .next, .expo.)
export const EXCLUDED_DIRS = new Set([
  "node_modules", "bower_components", "vendor", "Pods", "Carthage",
  "build", "dist", "out", "output", "target", "bin", "obj", "release", "debug",
  "coverage", "DerivedData", "tmp", "temp", "logs",
  "venv", "env", "__pycache__", "site-packages",
]);

// File names that may hold secrets. Checked against the lowercase file name.
const SENSITIVE_PATTERNS = [
  /^\.env/,                         // .env, .env.local, .env.production...
  /\.env$/,                         // production.env
  /secret/, /credential/, /password/, /passwd/, /token/, /private/,
  /(^|[-_.])keys?([-_.]|$)/,        // keys.json, api-key.txt (but NOT keywords.txt)
  /apikey/, /auth\.json$/,
  /\.(pem|key|p8|p12|pfx|jks|keystore|mobileprovision|provisionprofile|cer|crt|der|csr|asc|gpg|kdbx|tfvars|tfstate)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,    // SSH keys
  /^google-services\.json$/, /^googleservice-info\.plist$/, // Firebase app configs (hold API keys)
  /adminsdk/, /service[-_]?account/,
  /^\.(npmrc|netrc|pypirc|htpasswd|pgpass)$/,
];

// Lock files: huge, useless for describing an app.
const LOCK_PATTERNS = [/\.lock$/, /\.lockb$/, /-lock\.(json|ya?ml)$/, /^npm-shrinkwrap\.json$/];

/** True if a file name looks like it could contain secrets. */
export function isSensitiveFile(name) {
  const lower = path.basename(name).toLowerCase();
  return SENSITIVE_PATTERNS.some((re) => re.test(lower));
}

/** True for package-lock.json, yarn.lock, Podfile.lock, etc. */
export function isLockFile(name) {
  const lower = path.basename(name).toLowerCase();
  return LOCK_PATTERNS.some((re) => re.test(lower));
}

/** True for folders we never enter. */
export function isExcludedDir(name) {
  return name.startsWith(".") || EXCLUDED_DIRS.has(name) || name.endsWith(".xcassets");
}

// Images, video, audio, fonts, archives: never read, so don't even count them. This keeps
// asset-heavy projects from hitting MAX_FILES before we reach the useful files.
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|heic|ico|icns|svg|psd|sketch|fig|mp4|mov|webm|m4v|mp3|wav|m4a|aac|ogg|ttf|otf|woff2?|pdf|zip|gz|tgz|rar|7z|ipa|apk|aab|dmg|bin|riv|lottie)$/i;

// --- Walking the folder ----------------------------------------------------

// Deep enough for monorepos like apps/mobile/app/(tabs)/settings/index.tsx.
const MAX_DEPTH = 6;        // how many folders deep to look
const MAX_FILES = 5000;     // stop after this many files, to stay fast in big repos
const MAX_FILE_KB = 256;    // skip files bigger than this from the reading list

/**
 * List files under `dir` (relative paths with "/"), skipping excluded folders,
 * sensitive files, lock files, and symlinks (which could point anywhere).
 */
function walk(dir) {
  const files = [];
  const dirs = [];
  const visit = (rel, depth) => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return; // unreadable folder (permissions): just skip it
    }
    // Sort so results are the same on every machine.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;
        dirs.push(childRel);
        // Xcode project bundles only matter as "this is an iOS app" markers; their
        // insides are build settings, so we note the folder but don't walk into it.
        if (/\.(xcodeproj|xcworkspace)$/.test(entry.name)) continue;
        if (depth < MAX_DEPTH) visit(childRel, depth + 1);
      } else if (entry.isFile()) {
        if (isSensitiveFile(entry.name) || isLockFile(entry.name) || MEDIA_FILE.test(entry.name)) continue;
        files.push(childRel);
        if (files.length >= MAX_FILES) return;
      }
    }
  };
  visit("", 0);
  return { files, dirs };
}

// --- Reading metadata (names, description, homepage only) -------------------

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

// Turn "@acme/grid-peek" into "grid-peek". Scoped npm names include the org.
const stripScope = (name) => String(name).replace(/^@[^/]+\//, "");

// Build-time placeholders like "$(PRODUCT_NAME)" aren't real names.
const isRealValue = (v) => typeof v === "string" && v.trim() !== "" && !v.includes("$(") && !v.includes("${");

/** Read one value like `name: gridpeek` from the top level of a simple YAML file. */
function yamlValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

/** Read one <key>X</key><string>Y</string> pair from an XML Info.plist. */
function plistValue(text, key) {
  const match = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return match ? match[1].trim() : "";
}

/**
 * Pull the app's name(s), description, homepage, and keywords from metadata files.
 * `metadataFiles` are relative paths inside `dir`.
 */
export function readMetadata(dir, metadataFiles) {
  const names = [];
  let description = "";
  let url = "";
  let keywords = [];
  const addName = (n) => {
    if (isRealValue(n) && !names.includes(n.trim())) names.push(n.trim());
  };

  for (const rel of metadataFiles) {
    const file = path.join(dir, rel);
    const base = path.basename(rel);

    if (base === "package.json") {
      const pkg = readJson(file);
      if (!pkg) continue;
      if (pkg.name) addName(stripScope(pkg.name));
      if (pkg.productName) addName(pkg.productName);
      description ||= isRealValue(pkg.description) ? pkg.description.trim() : "";
      url ||= isRealValue(pkg.homepage) ? pkg.homepage.trim() : "";
      if (Array.isArray(pkg.keywords) && !keywords.length) keywords = pkg.keywords.filter((k) => typeof k === "string");
    } else if (base === "app.json") {
      // Expo apps keep their settings under "expo".
      const app = readJson(file);
      const expo = app?.expo ?? app ?? {};
      addName(expo.name);
      addName(expo.slug);
      description ||= isRealValue(expo.description) ? expo.description.trim() : "";
    } else if (base === "pubspec.yaml") {
      const text = readText(file);
      addName(yamlValue(text, "name"));
      description ||= yamlValue(text, "description");
      url ||= yamlValue(text, "homepage");
    } else if (base === "Info.plist") {
      const text = readText(file);
      addName(plistValue(text, "CFBundleDisplayName"));
      addName(plistValue(text, "CFBundleName"));
    } else if (base === "strings.xml") {
      const match = readText(file).match(/<string name="app_name">([^<]*)<\/string>/);
      if (match) addName(match[1]);
    }
  }

  // Only keep a homepage that is a real web address (not "." or a GitHub-relative path).
  if (!/^https?:\/\//.test(url)) url = "";
  return { names, description, url, keywords };
}

// --- Classifying files into the reading list -------------------------------

const CODE_EXT = /\.(tsx|jsx|ts|js|mjs|vue|svelte|astro|dart|swift|kt|java|html)$/i;
const I18N_EXT = /\.(json|ya?ml|arb|po|strings|xcstrings|xml)$/i;
const I18N_DIR = /(^|\/)(locales?|i18n|l10n|lang|languages|translations|messages|intl)(\/|$)/i;
const STORE_FILE = /^(name|title|subtitle|description|full_description|short_description|promotional_text|keywords|release_notes)\.txt$/i;

// Prefer English files: paths with an "en", "en-US", "en_GB", "base", etc. segment.
const isEnglish = (rel) => /(^|[\/._-])(en|en[-_][a-z]{2}|base|english)([\/._-]|$)/i.test(rel);
const englishFirst = (list) => [...list.filter(isEnglish), ...list.filter((f) => !isEnglish(f))];

/**
 * A readable name for a screen/route file:
 *   Next.js      "app/settings/page.tsx"           → "/settings"
 *   Expo Router  "app/(tabs)/settings/index.tsx"   → "/settings"
 *   pages/       "pages/about.tsx"                 → "/about"
 *   other        "src/screens/HomeScreen.tsx"      → "HomeScreen"
 * `expoAppDirs` are the app/ folders that use Expo Router (they contain _layout.tsx).
 */
function screenName(rel, expoAppDirs = []) {
  const noExt = rel.replace(/\.[^./]+$/, "");
  const parts = noExt.split("/");
  const base = parts.at(-1);
  // "(tabs)" style folders are route GROUPS: they organize files but aren't in the URL.
  const notGroup = (p) => !p.startsWith("(");

  // Next.js app router: the folder path IS the route.
  if (base === "page" && parts.includes("app")) {
    const route = parts.slice(parts.lastIndexOf("app") + 1, -1).filter(notGroup);
    return "/" + route.join("/");
  }

  // Expo Router: every file under app/ is a route, except _layout and +special files.
  const expoDir = expoAppDirs.find((d) => rel.startsWith(d + "/"));
  if (expoDir) {
    if (base.startsWith("_") || base.startsWith("+")) return "";
    const route = noExt.slice(expoDir.length + 1).split("/").filter(notGroup);
    if (route.at(-1) === "index") route.pop();
    return "/" + route.join("/");
  }
  // pages/ routers (Next.js pages, Nuxt, SvelteKit-ish): path under pages/ is the route.
  const pagesAt = parts.lastIndexOf("pages");
  if (pagesAt !== -1 && pagesAt < parts.length - 1) {
    const route = parts.slice(pagesAt + 1).filter((p) => p !== "index");
    return "/" + route.join("/");
  }
  return base;
}

/**
 * Scan a folder and return what's known about the app, plus a safe reading list.
 * Paths in the result are absolute so the agent can open them directly.
 */
export function scanProject(dir = process.cwd()) {
  const root = path.resolve(dir);
  const { files, dirs } = walk(root);
  const depth = (rel) => rel.split("/").length - 1;
  const base = (rel) => path.basename(rel);
  const small = (rel) => {
    try {
      return statSync(path.join(root, rel)).size <= MAX_FILE_KB * 1024;
    } catch {
      return false;
    }
  };

  // --- Is this an app project at all? ---
  // Marker files may sit up to 2 folders down, for monorepos like apps/mobile/package.json.
  const markerFiles = ["package.json", "app.json", "pubspec.yaml", "build.gradle", "build.gradle.kts", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "composer.json", "Package.swift"];
  const markers = files.filter((f) => depth(f) <= 2 && markerFiles.includes(base(f)));
  const xcodeProjects = dirs.filter((d) => depth(d) <= 3 && d.endsWith(".xcodeproj"));
  markers.push(...xcodeProjects);
  const isProject = markers.length > 0;

  // --- Metadata files (contents read for name/description/homepage) ---
  // Shallowest first, so the root package.json beats apps/mobile/package.json.
  const byDepth = (a, b) => depth(a) - depth(b) || a.localeCompare(b);
  const metadata = [
    ...files.filter((f) => depth(f) <= 2 && ["package.json", "app.json", "pubspec.yaml"].includes(base(f))).sort(byDepth),
    // Only the MAIN iOS app's Info.plist: the one in a folder named like the .xcodeproj
    // (ios/Gridpeek/Info.plist next to ios/Gridpeek.xcodeproj), not widgets or extensions.
    ...xcodeProjects.map((d) => d.replace(/\.xcodeproj$/, "/Info.plist")).filter((f) => files.includes(f)),
    ...files.filter((f) => f.endsWith("src/main/res/values/strings.xml")),
  ];

  // --- Reading list for the agent ---
  // The root README, plus READMEs of app folders in a monorepo (e.g. apps/mobile/README.md).
  // "App folders" are the folders holding a marker file; other READMEs (docs/x/README.md)
  // describe something else.
  const appDirs = new Set(["", ...markers.map((m) => (m.includes("/") ? m.slice(0, m.lastIndexOf("/")) : ""))]);
  const readme = files
    .filter((f) => /^readme(\.(md|markdown|txt|rst))?$/i.test(base(f)))
    .filter((f) => appDirs.has(f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""))
    .sort(byDepth)
    .slice(0, 3);

  // Product docs written in plain words, often the best description of the app.
  const docs = files
    .filter((f) => depth(f) <= 1 && /^(product|about|overview|pitch|features|vision|one-?pager)\.(md|txt)$/i.test(base(f)))
    .filter(small)
    .slice(0, 3);

  const storeListing = englishFirst([
    ...files.filter((f) => /(^|\/)fastlane\/metadata\//.test(f) && STORE_FILE.test(base(f))),
    ...files.filter((f) => /^metadata\//.test(f) && /\.(txt|json|md)$/.test(f)),
    ...files.filter((f) => depth(f) <= 2 && /(app-?store|play-?store|store-?listing|listing|marketing)/i.test(base(f)) && /\.(md|txt)$/i.test(f)),
    // store/ or marketing/ folders: screenshot captions and promo pages. Skip App Review
    // sample files, which are fake test documents, not marketing copy.
    ...files.filter((f) => /(^|\/)(store|marketing)\//.test(f) && /\.(md|txt|html)$/i.test(f) && !/(sample|review)/i.test(f)),
  ]).filter(small).slice(0, 8);

  const landing = files
    .filter((f) =>
      /^(.+\/)?(public\/|web\/|site\/)?index\.html$/.test(f) && depth(f) <= 3 && !/(^|\/)(store|marketing|docs?)\//.test(f) ||
      /(^|\/)(src\/)?app\/page\.(tsx|jsx|js|ts)$/.test(f) ||
      /(^|\/)(src\/)?pages\/index\.(tsx|jsx|js|ts|vue|astro|svelte)$/.test(f) ||
      /(^|\/)(src\/)?routes\/\+page\.svelte$/.test(f) ||
      (depth(f) <= 2 && /^landing/i.test(base(f)) && CODE_EXT.test(f))
    )
    .filter(small)
    .slice(0, 3);

  const translations = englishFirst(
    files.filter(
      (f) =>
        (I18N_DIR.test(f) && I18N_EXT.test(f)) ||
        /\.arb$/i.test(f) ||
        /(^|\/)Localizable\.(strings|xcstrings)$/.test(f) ||
        /\.lproj\/[^/]+\.strings$/.test(f)
    )
  )
    .filter(small)
    .slice(0, 2);

  // Expo Router apps keep every screen in an app/ folder that has a _layout file.
  const expoAppDirs = files
    .filter((f) => /(^|\/)app\/_layout\.(tsx|jsx|ts|js)$/.test(f))
    .map((f) => f.slice(0, f.lastIndexOf("/")));

  // Screen / page / route NAMES only (we list them; nobody needs to open these files).
  const screenFiles = files.filter(
    (f) =>
      CODE_EXT.test(f) &&
      !/\.(test|spec|stories)\./i.test(f) &&
      (expoAppDirs.some((d) => f.startsWith(d + "/")) ||
        /(^|\/)(screens?|views?|pages|routes)\//i.test(f) ||
        /(^|\/)app\/(.+\/)?page\.(tsx|jsx|js|ts)$/.test(f) ||
        /(Screen|View|Page)\.(tsx|jsx|ts|js|dart|swift|kt|vue|svelte)$/.test(base(f)))
  );
  // Developer-only screens say nothing about the app, so they're left out.
  const devOnly = /(^|\/)(dev|debug|_sitemap|storybook|playground)(\/|$)/i;
  const screens = [...new Set(screenFiles.map((f) => screenName(f, expoAppDirs)))]
    .filter((n) => n && !n.startsWith("_") && !devOnly.test(n))
    .slice(0, 60);

  const abs = (list) => list.map((rel) => path.join(root, rel));
  const icon = isProject ? findAppIcon(root, { appDirs: [...appDirs], dirs }) : null;

  return {
    dir: root,
    isProject,
    markers,
    metadata: readMetadata(root, metadata),
    readingList: {
      readme: abs(readme),
      docs: abs(docs),
      storeListing: abs(storeListing),
      landing: abs(landing),
      translations: abs(translations),
    },
    screens,
    icon,
    truncated: files.length >= MAX_FILES,
  };
}

// --- The app's icon --------------------------------------------------------

// Images are left out of the walk, so the usual icon spots are checked by exact path.
const ICON_FOLDERS = ["", "assets", "assets/images", "src/assets", "public", "static", "app", "src/app", "web", "images"];
// Best first: favicon.ico is often a framework's default, so it comes last.
const ICON_NAMES = ["icon.png", "app-icon.png", "appicon.png", "apple-icon.png", "apple-touch-icon.png", "icon-512.png", "logo.png", "favicon.png", "icon.webp", "logo.webp", "icon.jpg", "favicon.ico"];

/**
 * Find the app's icon in a project: the full path of a real PNG/JPEG/WebP/ICO image inside
 * `root`, or null. Best first: the icon Expo's app.json names, the biggest image in the iOS
 * AppIcon set, Android's launcher icon, then common web/asset spots in each app folder.
 *
 * @param {string} root - the project folder (already resolved)
 * @param {{ appDirs?: string[], dirs?: string[] }} where - app folders and walked folders (relative)
 */
export function findAppIcon(root, { appDirs = [""], dirs = [] } = {}) {
  const shallow = ["", ...dirs.filter((d) => d.split("/").length <= 3)];
  const candidates = [];

  for (const dir of appDirs) {
    const json = readJson(path.join(root, dir, "app.json"));
    const named = json?.expo?.icon ?? json?.icon;
    if (typeof named === "string") candidates.push(path.join(dir, named));
  }
  // Xcode asset catalogs aren't walked (isExcludedDir), so look inside AppIcon sets here.
  for (const set of shallow.flatMap((dir) => ["Assets", "Images"].map((n) => path.join(dir, `${n}.xcassets`, "AppIcon.appiconset")))) {
    let names;
    try {
      names = readdirSync(path.join(root, set)).filter((n) => /\.(png|jpe?g)$/i.test(n));
    } catch {
      continue;
    }
    const size = (n) => {
      try {
        return statSync(path.join(root, set, n)).size;
      } catch {
        return 0;
      }
    };
    // The biggest file is the 1024px store icon.
    const biggest = names.sort((a, b) => size(b) - size(a))[0];
    if (biggest) candidates.push(path.join(set, biggest));
  }
  for (const res of dirs.filter((d) => /(^|\/)src\/main\/res$/.test(d))) {
    for (const density of ["xxxhdpi", "xxhdpi"]) {
      candidates.push(path.join(res, `mipmap-${density}`, "ic_launcher.png"), path.join(res, `mipmap-${density}`, "ic_launcher.webp"));
    }
  }
  // Name first, then folder, so a real icon.png anywhere beats a favicon.ico.
  for (const name of ICON_NAMES) {
    for (const dir of appDirs) for (const folder of ICON_FOLDERS) candidates.push(path.join(dir, folder, name));
  }

  // realpath: a symlinked folder inside the project could point anywhere, so the real
  // location must still be inside the project.
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  for (const rel of candidates) {
    const file = path.resolve(root, rel);
    try {
      if (!realpathSync(file).startsWith(realRoot + path.sep)) continue;
    } catch {
      continue; // doesn't exist
    }
    if (readIconFile(file)) return file;
  }
  return null;
}

// --- Picking an app for /markit-find ---------------------------------------

/** "Grid Peek", "grid-peek" and "@acme/gridpeek" all become "gridpeek". */
export function normalizeName(name) {
  return stripScope(String(name ?? "")).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Names that identify the current folder's project: just the root metadata files,
 * so this stays instant (no folder walk).
 */
export function projectNames(dir = process.cwd()) {
  const root = path.resolve(dir);
  const rootMeta = ["package.json", "app.json", "pubspec.yaml"].filter((f) => existsSync(path.join(root, f)));
  return readMetadata(root, rootMeta).names;
}

/**
 * Decide which app profile /markit-find should use.
 *
 * Order: the app the user named → a profile matching the folder name → a profile matching
 * the project's package/app name → the only profile → ask the user.
 *
 * @returns {{ app: string|null, reason: string, apps: string[] }}
 *   reason is one of: "requested", "folder", "package", "only", "ask", "none"
 */
export function pickApp({ requested, apps, cwd = process.cwd() }) {
  if (requested) {
    if (!apps.includes(requested)) {
      const hint = apps.length ? `Your apps: ${apps.join(", ")}.` : "Run /markit-setup to create one.";
      throw new Error(`marKit: no app named "${requested}". ${hint}`);
    }
    return { app: requested, reason: "requested", apps, matched: requested };
  }
  if (apps.length === 0) return { app: null, reason: "none", apps };

  const byNormalized = new Map(apps.map((a) => [normalizeName(a), a]));

  const folder = path.basename(path.resolve(cwd));
  const folderMatch = byNormalized.get(normalizeName(folder));
  if (folderMatch) return { app: folderMatch, reason: "folder", apps, matched: folder };

  for (const name of projectNames(cwd)) {
    const match = byNormalized.get(normalizeName(name));
    if (match) return { app: match, reason: "package", apps, matched: name };
  }

  if (apps.length === 1) return { app: apps[0], reason: "only", apps };
  return { app: null, reason: "ask", apps };
}
