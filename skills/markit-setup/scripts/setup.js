#!/usr/bin/env node
// setup.js — creates marKit's config and app profiles.
//
// Commands:
//   node setup.js init                  Create the config folder, a blank .env (chmod 600),
//                                       settings.json, and apps/. Safe to run again: it never
//                                       overwrites anything that already exists.
//   node setup.js app --name <name>     Save an app profile. Reads the profile as JSON from
//                                       stdin, checks it, and writes apps/<name>.json.
//                                       Add --overwrite to replace an existing profile (editing).
//                                       Add --dry-run to check and print it without saving
//                                       (used to show a drafted profile before confirming).
//                                       Run from the app's project folder, it also copies the
//                                       app's icon to apps/<name>.png (or .jpg/.webp/.ico) for
//                                       the dashboard's app picker.
//   node setup.js scan [--dir <path>]   Look at the current folder (or --dir) and print what
//                                       it says about the app, plus a SAFE reading list the
//                                       agent may open to draft a profile. Secrets, .env files,
//                                       node_modules, build output, and lock files are never
//                                       listed. See lib/project.js.
//   node setup.js status                Print whether marKit is set up, where the .env file is,
//                                       which apps exist, and the Reddit provider.
//   node setup.js reddit --provider <p> Choose who searches Reddit: scrapecreators, apify,
//                                       socialcrawl, or none. Saves settings.json
//                                       reddit.provider (keeping every other setting) and
//                                       switches the "reddit" source on for every app (off
//                                       does nothing to apps: with "none" it's just skipped).
//
// SECURITY: this script WRITES the .env template but never READS it. Keys are added by the
// user in their own editor. Nothing here prints key values.

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync, statSync, chmodSync } from "node:fs";
import path from "node:path";
import { loadShared } from "./shared.js";

// Load shared code from the sibling markit-find folder (exits with a clear message if missing).
const config = await loadShared("lib/config.js");
const { writeJsonFile, readJsonFile } = await loadShared("lib/files.js");
const { validateProfile } = await loadShared("lib/profile.js");
const { REDDIT_PROVIDERS, PROVIDER_LABELS, redditProvider, redditLabel } = await loadShared("lib/reddit.js");
const { scanProject, projectNames, normalizeName } = await loadShared("lib/project.js");
const { saveAppIcon } = await loadShared("lib/app-icon.js");

// Windows doesn't use Unix-style permissions (chmod 600 does nothing useful there).
// The %APPDATA% folder is already private to the user account.
const IS_WINDOWS = process.platform === "win32";

// The blank .env file. Each comment sits on its own line ABOVE its key, so it's obvious
// where to paste: right after the "=" with nothing else on the line.
const ENV_TEMPLATE = `# marKit API keys. Keep this file private. Never commit or share it.
# Paste each key right after its "=" sign. Leave a value empty to disable that source.
# Step-by-step instructions for every key: markit-setup/references/setup-guide.md

# ---------- Free sources ----------
# Hacker News needs no key.

# Optional: raises Stack Exchange's daily request quota.
STACKEXCHANGE_KEY=

# Google Cloud → YouTube Data API v3. Restrict the key to that API.
YOUTUBE_API_KEY=

# Bluesky search works WITHOUT a login. Only fill these in if Bluesky stops working.
# Your handle, e.g. yourname.bsky.social
BLUESKY_HANDLE=
# Bluesky → Settings → Privacy and security → App passwords. NOT your main password.
BLUESKY_APP_PASSWORD=

# Meta app with threads_basic + threads_keyword_search. Only finds YOUR OWN posts until
# Meta approves the app in App Review. Tokens last 60 days.
THREADS_ACCESS_TOKEN=

# ---------- Paid sources (optional) ----------
# X developer console, pay-per-use. Set a spending limit there!
X_BEARER_TOKEN=

# ---------- Reddit (optional, paid): fill in ONE, then run /markit-setup to choose it ----------
# ScrapeCreators: cheapest per search (1 credit), credits never expire. 100 free.
SCRAPECREATORS_API_KEY=

# Apify: can stay at $0 for light use (Apify includes $5 of usage every month).
APIFY_API_TOKEN=

# socialcrawl.dev credits: Reddit, and Threads with no Meta App Review. 100 free.
SOCIALCRAWL_API_KEY=
`;

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function init() {
  const paths = config.getPaths();
  const lines = [];

  // 0o700 = only the owner can open the folder. Ignored on Windows.
  if (!existsSync(paths.dir)) {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    lines.push(`✓ Created config folder   ${paths.dir}`);
  } else {
    lines.push(`✓ Config folder exists     ${paths.dir}`);
  }

  if (!existsSync(paths.appsDir)) {
    mkdirSync(paths.appsDir, { recursive: true });
    lines.push(`✓ Created apps folder     ${paths.appsDir}`);
  }

  // --- .env ---
  if (!existsSync(paths.envFile)) {
    // flag "wx" = create the file, but FAIL if it already exists. That makes it impossible
    // to wipe out someone's keys, even if two setups run at the same moment.
    // mode 0o600 = owner can read/write, nobody else can do anything.
    writeFileSync(paths.envFile, ENV_TEMPLATE, { mode: 0o600, flag: "wx" });
    // The mode above can be loosened by the system "umask" on some machines, so set it
    // again explicitly to be sure.
    if (!IS_WINDOWS) chmodSync(paths.envFile, 0o600);
    lines.push(`✓ Created blank .env      ${paths.envFile}  (private: chmod 600)`);
  } else {
    // Never touch the contents, but DO fix permissions if they're too open.
    // `mode & 0o077` picks out the "group" and "others" permission bits.
    if (!IS_WINDOWS && (statSync(paths.envFile).mode & 0o077) !== 0) {
      chmodSync(paths.envFile, 0o600);
      lines.push(`✓ .env exists, fixed its permissions to private (chmod 600)  ${paths.envFile}`);
    } else {
      lines.push(`✓ .env exists, left unchanged  ${paths.envFile}`);
    }
  }

  // --- settings.json ---
  if (!existsSync(paths.settingsFile)) {
    writeJsonFile(paths.settingsFile, config.DEFAULT_SETTINGS);
    lines.push(`✓ Created settings.json   ${paths.settingsFile}`);
  } else {
    lines.push(`✓ settings.json exists, left unchanged`);
  }

  console.log(["marKit setup", "", ...lines, "", `Add API keys by editing: ${paths.envFile}`].join("\n"));
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

/** Read everything piped into the script (the profile JSON). */
async function readStdin() {
  // If nobody piped anything in, stdin is the terminal and we'd wait forever.
  if (process.stdin.isTTY) {
    throw new Error(`marKit: pipe the profile JSON in, e.g.  echo '{"url": "..."}' | node setup.js app --name myapp`);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The icon of app `name` from the current folder, or null. Only when the folder IS that app's
 * project (folder or package name matches), so editing one app from another app's folder
 * can't give it the wrong icon.
 */
function projectIcon(name) {
  const cwd = process.cwd();
  const names = [path.basename(cwd), ...projectNames(cwd)].map(normalizeName);
  return names.includes(normalizeName(name)) ? scanProject(cwd).icon : null;
}

async function app({ name, overwrite, "dry-run": dryRun }) {
  if (!name) throw new Error("marKit: --name is required, e.g. node setup.js app --name gridpeek");
  const paths = config.getPaths();
  // A dry run saves nothing, so it works before init (handy for previewing a draft).
  if (!dryRun && !config.isSetUp(paths)) throw new Error("marKit: not set up yet. Run: node setup.js init");

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (err) {
    if (err.message.startsWith("marKit:")) throw err;
    throw new Error("marKit: the profile on stdin is not valid JSON.");
  }

  // Profiles written now use today's meaning of "socialcrawl" (Threads through SocialCrawl;
  // Reddit is the "reddit" source). Without this mark, validateProfile would read a new
  // profile's "socialcrawl" as an old Reddit setup and turn it into "reddit".
  if (input && typeof input === "object" && !Array.isArray(input) && input.socialcrawlPlatforms === undefined) {
    input.socialcrawlPlatforms = ["threads"];
  }
  const { profile, warnings } = validateProfile(input, name);
  const file = config.appPath(name, paths);

  const exists = existsSync(file);
  const icon = projectIcon(name);

  if (dryRun) {
    // Nothing is written. The agent shows this cleaned-up profile to the user to confirm.
    const out = [`✓ Profile "${name}" is valid (not saved yet${exists ? `; saving will need --overwrite` : ""})`];
    if (icon) out.push(`  App icon: ${icon} (saved with the profile, for the dashboard)`);
    if (warnings.length) out.push("", "Suggestions:", ...warnings.map((w) => `  - ${w}`));
    out.push("", JSON.stringify(profile, null, 2));
    console.log(out.join("\n"));
    return;
  }

  if (exists && !overwrite) {
    throw new Error(`marKit: an app named "${name}" already exists. Add --overwrite to replace it.`);
  }

  writeJsonFile(file, profile);

  const out = [`✓ Saved app profile "${name}"  ${file}`];
  const savedIcon = icon && saveAppIcon(paths.appsDir, name, icon);
  if (savedIcon) out.push(`✓ Saved app icon          ${savedIcon}  (from ${icon})`);
  if (warnings.length) out.push("", "Suggestions:", ...warnings.map((w) => `  - ${w}`));
  out.push("", JSON.stringify(profile, null, 2));
  console.log(out.join("\n"));
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

function scan({ dir }) {
  // JSON so the agent can use it directly. Contains paths, names, and a few metadata
  // fields (name, description, homepage). It never contains file contents.
  console.log(JSON.stringify(scanProject(dir ?? process.cwd()), null, 2));
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function status() {
  const paths = config.getPaths();
  const setUp = config.isSetUp(paths);
  const apps = setUp ? config.listApps(paths) : [];
  // JSON so the agent can read it reliably. Contains paths and app names only, no keys.
  const redditChoice = setUp ? redditProvider(config.loadSettings(paths)) : "none";
  console.log(
    JSON.stringify(
      { setUp, configDir: paths.dir, envFile: paths.envFile, envFileExists: existsSync(paths.envFile), apps, redditProvider: redditChoice },
      null,
      2
    )
  );
}

// ---------------------------------------------------------------------------
// reddit
// ---------------------------------------------------------------------------

function reddit({ provider }) {
  const choice = String(provider ?? "").trim().toLowerCase();
  if (![...REDDIT_PROVIDERS, "none"].includes(choice)) {
    throw new Error(`marKit: --provider must be one of: ${[...REDDIT_PROVIDERS, "none"].join(", ")}.`);
  }
  const paths = config.getPaths();
  if (!config.isSetUp(paths)) throw new Error("marKit: not set up yet. Run: node setup.js init");

  // Change only reddit.provider; keep everything else in settings.json exactly as it was.
  // The chosen provider's caps are written out too (if missing) so they're easy to find.
  const saved = readJsonFile(paths.settingsFile, {});
  const next = { ...saved, reddit: { ...(saved.reddit ?? {}), provider: choice } };
  if (choice !== "none" && !next[choice]) next[choice] = config.DEFAULT_SETTINGS[choice];
  writeJsonFile(paths.settingsFile, next);

  const lines = [choice === "none" ? "✓ Reddit provider: none (only the agent's web search covers Reddit)" : `✓ Reddit provider: ${PROVIDER_LABELS[choice]} (${redditLabel(choice)} in reports)`];
  if (choice !== "none") {
    // Every app searches Reddit from now on (the provider is one choice for all apps).
    for (const name of config.listApps(paths)) {
      const file = config.appPath(name, paths);
      const current = readJsonFile(file, null);
      if (!current) continue;
      const { profile } = validateProfile(current, name); // also upgrades old SocialCrawl-for-Reddit profiles
      if (!profile.sources.includes("reddit")) {
        profile.sources = [...profile.sources.filter((s) => s !== "web"), "reddit", ...(profile.sources.includes("web") ? ["web"] : [])];
        writeJsonFile(file, profile);
        lines.push(`✓ Added "reddit" to ${name}'s sources`);
      } else if (JSON.stringify(profile) !== JSON.stringify(current)) {
        writeJsonFile(file, profile);
      }
    }
    const caps = next[choice];
    lines.push(
      choice === "apify"
        ? `  Caps (settings.json apify): ${caps.maxResultsPerRun} results per run, about $${Number(caps.maxEstimatedCostPerMonth).toFixed(2)} per month (estimated from $${caps.pricePerThousandResults} per 1,000 results)`
        : `  Caps (settings.json ${choice}): ${caps.maxCreditsPerRun} credits per run, ${caps.maxCreditsPerMonth} per month`
    );
  }
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node setup.js init
  node setup.js app --name <name> [--overwrite] [--dry-run]   (profile JSON on stdin)
  node setup.js scan [--dir <path>]
  node setup.js status
  node setup.js reddit --provider <scrapecreators|apify|socialcrawl|none>`;

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      overwrite: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      dir: { type: "string" },
      provider: { type: "string" },
    },
  });
  const command = positionals[0];

  if (command === "init") init();
  else if (command === "app") await app(values);
  else if (command === "scan") scan(values);
  else if (command === "status") status();
  else if (command === "reddit") reddit(values);
  else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  // Our own errors start with "marKit:" and are written for the user. parseArgs errors
  // (like an unknown flag) get the usage text added.
  console.error(err.message.startsWith("marKit:") ? err.message : `marKit: ${err.message}\n\n${USAGE}`);
  process.exitCode = 1;
}
