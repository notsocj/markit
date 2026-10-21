// config.js — where marKit keeps its files, and how it loads them.
//
// All user config lives OUTSIDE the skill folders (so it's never copied, shared, or
// committed along with the skill):
//
//   macOS / Linux:  ~/.config/markit/
//   Windows:        %APPDATA%\markit\
//
// Inside that folder:
//   .env           API keys (chmod 600). Only scripts read it, never the agent.
//   apps/*.json    one profile per app
//   settings.json  reports folder, lookback days, paid-source caps
//   seen.json      IDs of posts already reported
//   usage.json     API call counts per source
//   status.json    which cards you marked Replied / Skipped in the dashboard
//
// Every function takes an optional `opts` object so tests can pretend to be on another
// platform or use a temporary folder. Real scripts just call them with no arguments.

import { homedir } from "node:os";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { readJsonFile } from "./files.js";

// The only environment variables marKit reads from .env. Anything else in the file is
// ignored, so a stray line can't change how marKit behaves.
export const KNOWN_KEYS = [
  "STACKEXCHANGE_KEY",
  "YOUTUBE_API_KEY",
  "BLUESKY_HANDLE",
  "BLUESKY_APP_PASSWORD",
  "THREADS_ACCESS_TOKEN",
  "X_BEARER_TOKEN",
  "SOCIALCRAWL_API_KEY",
];

// Defaults used when settings.json is missing a value (or doesn't exist yet).
// The caps protect users from surprise bills on the two paid sources.
export const DEFAULT_SETTINGS = {
  reportsDir: "~/markit-reports",
  lookbackDays: 7,
  maxPostsPerSource: 25,
  x: { maxPostsPerRun: 30, maxPostsPerMonth: 900 },
  socialcrawl: { maxCreditsPerRun: 50, maxCreditsPerMonth: 1500 },
};

/**
 * Turn "~/something" into "/Users/you/something". Other paths are returned unchanged.
 */
export function expandHome(p, home = homedir()) {
  if (p === "~") return home;
  // Accept both "~/" and "~\" so Windows users can write paths their way.
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/**
 * The folder that holds all of marKit's config.
 *
 * MARKIT_CONFIG_DIR overrides the default. Tests use it to work in a temp folder,
 * and advanced users can use it to keep config somewhere else.
 */
export function getConfigDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.MARKIT_CONFIG_DIR) return expandHome(env.MARKIT_CONFIG_DIR, home);

  if (platform === "win32") {
    // We use path.win32 explicitly so the result has backslashes even when a test
    // running on macOS asks "what would this be on Windows?".
    // APPDATA is almost always set on Windows; the fallback is its usual location.
    const appData = env.APPDATA || path.win32.join(home, "AppData", "Roaming");
    return path.win32.join(appData, "markit");
  }

  return path.posix.join(home, ".config", "markit");
}

/**
 * Every file and folder marKit uses, in one object.
 */
export function getPaths(opts = {}) {
  const dir = getConfigDir(opts);
  const join = (opts.platform ?? process.platform) === "win32" ? path.win32.join : path.posix.join;
  return {
    dir,
    envFile: join(dir, ".env"),
    appsDir: join(dir, "apps"),
    settingsFile: join(dir, "settings.json"),
    seenFile: join(dir, "seen.json"),
    usageFile: join(dir, "usage.json"),
    statusFile: join(dir, "status.json"),
  };
}

/** True once `setup.js init` has created the config folder. */
export function isSetUp(paths = getPaths()) {
  return existsSync(paths.dir) && existsSync(paths.settingsFile);
}

/**
 * Clean up one value from .env.
 *
 * Newer Node versions strip "  # comment" after a value, but Node 20.12 may not.
 * Doing it ourselves means `YOUTUBE_API_KEY=   # Google Cloud...` is read as empty
 * (source disabled) on every Node version, instead of the comment being used as a key.
 */
export function cleanEnvValue(value) {
  if (typeof value !== "string") return "";
  let v = value.trim();
  if (v.startsWith("#")) return "";
  // A space or tab followed by # starts a comment. API keys never contain " #".
  const comment = v.search(/\s#/);
  if (comment !== -1) v = v.slice(0, comment).trim();
  return v;
}

/**
 * Load API keys from the .env file and return ONLY marKit's known keys.
 *
 * The returned object holds secrets. Pass it to adapters, but never print it,
 * log it, or write it to a file.
 */
export function loadEnv(envFile = getPaths().envFile) {
  // process.loadEnvFile is built into Node 20.12+, so we need no dotenv package.
  // It copies the file's values into process.env (without overwriting values that
  // were already set in the shell).
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const env = {};
  for (const key of KNOWN_KEYS) env[key] = cleanEnvValue(process.env[key]);
  return env;
}

/**
 * Load settings.json merged on top of DEFAULT_SETTINGS, with "~" expanded in reportsDir.
 */
export function loadSettings(paths = getPaths(), home = homedir()) {
  const saved = readJsonFile(paths.settingsFile, {});
  const settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    // The nested cap objects are merged separately so a settings.json that only sets
    // x.maxPostsPerRun still keeps the default x.maxPostsPerMonth.
    x: { ...DEFAULT_SETTINGS.x, ...(saved.x ?? {}) },
    socialcrawl: { ...DEFAULT_SETTINGS.socialcrawl, ...(saved.socialcrawl ?? {}) },
  };
  settings.reportsDir = expandHome(settings.reportsDir, home);
  return settings;
}

/**
 * App names become file names (apps/<name>.json) and folder names in reports, so they
 * must be simple: lowercase letters, numbers, and hyphens. This also blocks tricks like
 * "../../something" that would point outside the config folder.
 */
export function validateAppName(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    throw new Error(
      `marKit: app name "${name}" is not allowed. Use 1–40 lowercase letters, numbers, or hyphens (e.g. "gridpeek").`
    );
  }
  return name;
}

/** Path of one app's profile file. */
export function appPath(name, paths = getPaths()) {
  validateAppName(name);
  return path.join(paths.appsDir, `${name}.json`);
}

/** Names of all app profiles, sorted alphabetically. */
export function listApps(paths = getPaths()) {
  if (!existsSync(paths.appsDir)) return [];
  return readdirSync(paths.appsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** Load one app profile, with a helpful error if it doesn't exist. */
export function loadApp(name, paths = getPaths()) {
  const file = appPath(name, paths);
  const profile = readJsonFile(file, null);
  if (!profile) {
    const apps = listApps(paths);
    const hint = apps.length ? `Your apps: ${apps.join(", ")}.` : "Run /markit-setup to create one.";
    throw new Error(`marKit: no app named "${name}". ${hint}`);
  }
  return profile;
}
