// dashboard-settings.js — the Settings page: API keys and which sources each app uses.
//
// API KEYS are WRITE-ONLY here. You paste a key in your browser, it goes straight to this
// local server, and the server writes it into ~/.config/markit/.env (lib/env-file.js). The
// server never sends a key back, never logs it, and never prints it, so it can't show up in
// your agent's chat or in the background task's output. The page only ever learns "set" or
// "not set", and the result of a test call ("ok", "invalid", ...).
//
// SOURCES: the page can switch each source on or off for an app. Only the profile's
// "sources" can change, and the profile goes through the same validateProfile() as
// /markit-setup before it's saved. The Reddit provider (settings.json reddit.provider) is
// shown but not changed here: /markit-setup explains the options and changes it.
//
// This module imports shared code with plain imports, like dashboard-data.js: dashboard.js
// loads it only after shared.js has confirmed the sibling markit-find folder exists.

import { existsSync } from "node:fs";
import path from "node:path";
import { KNOWN_KEYS, loadEnv, listApps, validateAppName } from "../../markit-find/scripts/lib/config.js";
import { keyStatus, writeEnvValue, validateKeyValue } from "../../markit-find/scripts/lib/env-file.js";
import { readJsonFile, writeJsonFile } from "../../markit-find/scripts/lib/files.js";
import { validateProfile, upgradeSocialcrawlSources, ALL_SOURCES, SOURCE_LABELS, DEFAULT_SOURCES, SOCIALCRAWL_PLATFORMS } from "../../markit-find/scripts/lib/profile.js";
import { redditProvider, redditLabel, PROVIDER_LABELS } from "../../markit-find/scripts/lib/reddit.js";
import { recordUsage } from "../../markit-find/scripts/lib/usage.js";
import { ADAPTERS } from "../../markit-find/scripts/adapters/index.js";

/**
 * What the Settings page shows for each source. `keys` lists the .env names (optional ones
 * aren't needed for the source to work). `help` and `link` say where to get the key; the
 * full steps are in markit-setup/references/setup-guide.md.
 */
export const SOURCE_INFO = [
  { source: "hackernews", cost: "free", keys: [], help: "No key needed." },
  { source: "stackexchange", cost: "free", keys: [{ env: "STACKEXCHANGE_KEY", label: "Key", optional: true }], help: "Optional: a free key raises the daily quota from 300 to 10,000 requests.", link: "https://stackapps.com/apps/oauth/register" },
  { source: "bluesky", cost: "free", keys: [{ env: "BLUESKY_HANDLE", label: "Handle", optional: true }, { env: "BLUESKY_APP_PASSWORD", label: "App password", optional: true }], help: "No key needed. Only add a login (an app password, never your main password) if Bluesky search stops working." },
  { source: "youtube", cost: "free", keys: [{ env: "YOUTUBE_API_KEY", label: "API key" }], help: "Google Cloud → enable YouTube Data API v3 → Credentials → API key (restrict it to that API).", link: "https://console.cloud.google.com/apis/library/youtube.googleapis.com" },
  { source: "threads", cost: "free", keys: [{ env: "THREADS_ACCESS_TOKEN", label: "Access token" }], help: "Meta app → Access the Threads API → User Token Generator. Only finds your own posts until Meta approves App Review; Threads through SocialCrawl needs no review.", link: "https://developers.facebook.com/apps" },
  { source: "x", cost: "paid", keys: [{ env: "X_BEARER_TOKEN", label: "Bearer token" }], help: "X console → your app → Keys & Tokens → Bearer Token. Add credits and set a spending limit there.", link: "https://console.x.com" },
  // The three Reddit providers. Only the one chosen in settings.json searches Reddit.
  { source: "scrapecreators", label: PROVIDER_LABELS.scrapecreators, cost: "paid", keys: [{ env: "SCRAPECREATORS_API_KEY", label: "API key" }], help: "Reddit provider, cheapest per search: 1 credit each, credits never expire, 100 free. Sign up at scrapecreators.com and copy the API key from your dashboard. Testing the key uses 1 credit.", link: "https://scrapecreators.com" },
  { source: "apify", label: PROVIDER_LABELS.apify, cost: "paid", keys: [{ env: "APIFY_API_TOKEN", label: "API token" }], help: "Reddit provider that can stay at $0: Apify includes $5 of usage every month. Console → Settings → API & Integrations → API token.", link: "https://console.apify.com/settings/integrations" },
  { source: "socialcrawl", label: PROVIDER_LABELS.socialcrawl, cost: "paid", keys: [{ env: "SOCIALCRAWL_API_KEY", label: "API key" }], help: "socialcrawl.dev dashboard → API key (starts with sc_). 100 free credits. A Reddit provider, and it can search Threads with no Meta App Review.", link: "https://www.socialcrawl.dev" },
];

/** Everything the Settings page shows. Key VALUES are never included. */
export function getSettings({ envFile, appsDir, settingsFile }) {
  const set = keyStatus(envFile);
  const sources = SOURCE_INFO.map((info) => ({
    ...info,
    label: info.label ?? SOURCE_LABELS[info.source] ?? info.source,
    keys: info.keys.map((k) => ({ ...k, set: set[k.env] })),
    // Ready = has every required key (sources with only optional keys are always ready).
    ready: info.keys.filter((k) => !k.optional).every((k) => set[k.env]),
  }));
  const apps = listApps({ appsDir }).map((name) => {
    try {
      const profile = readJsonFile(path.join(appsDir, `${name}.json`), {});
      // Old profiles that used "socialcrawl" for Reddit are shown the way search.js reads them.
      const sources = Array.isArray(profile.sources) ? upgradeSocialcrawlSources(profile.sources, profile.socialcrawlPlatforms) : [...DEFAULT_SOURCES];
      return { name, sources };
    } catch {
      return null; // a broken profile is left for /markit-setup to fix
    }
  }).filter(Boolean);
  // The Reddit provider is a setting, not a secret: the page shows "Reddit (via Apify)".
  const provider = settingsFile ? redditProvider(readJsonFile(settingsFile, {})) : "none";
  return {
    sources,
    apps,
    allSources: ALL_SOURCES.map((s) => ({ source: s, label: s === "reddit" ? redditLabel(provider) : SOURCE_LABELS[s] ?? s })),
    reddit: { provider, label: redditLabel(provider) },
  };
}

/**
 * Validate a key update from the browser: exactly { name, value }.
 * @returns {{ ok: true, name, value } | { ok: false, error }}
 */
export function validateKeyUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "value") return { ok: false, error: "body must be exactly { name, value }" };
  if (typeof body.name !== "string" || !KNOWN_KEYS.includes(body.name)) return { ok: false, error: "unknown key name" };
  const check = validateKeyValue(body.name, body.value);
  return check.ok ? { ok: true, name: body.name, value: check.value } : check;
}

/** Save (or with "" remove) one key. Returns { name, set } and nothing else. */
export function saveKey({ envFile }, { name, value }) {
  return { name, ...writeEnvValue(envFile, name, value) };
}

/**
 * Test one source's key with its adapter's check() (one small real API call).
 * Returns "ok" | "invalid" | "quota" | "error" | "not-set". Like /markit-usage, the call is
 * recorded in usage.json when it counts against a quota marKit shows.
 */
export async function testSource({ envFile, usageFile }, source, { adapters = ADAPTERS, http } = {}) {
  const adapter = adapters.find((a) => a.name === source);
  if (!adapter) return "error";
  const env = loadEnv(envFile);
  if (!adapter.isEnabled(env)) return "not-set";
  let result;
  try {
    result = await adapter.check(env, { http: { timeoutMs: 8000, retries: 0, ...http } });
  } catch {
    result = "error"; // never pass the error itself on (it could contain anything)
  }
  if (usageFile && adapter.checkUsesQuota !== false) {
    try {
      // checkCost: a check that costs credits (ScrapeCreators' balance call) counts as spent.
      recordUsage(source, { requests: 1, ...(adapter.checkCost ?? {}) }, usageFile);
    } catch {
      // counting is best-effort; the test result still stands
    }
  }
  return ["ok", "invalid", "quota", "error"].includes(result) ? result : "error";
}

/**
 * Validate an app sources update: exactly { app, sources }.
 * @returns {{ ok: true, app, sources } | { ok: false, error }}
 */
export function validateAppUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "app" || keys[1] !== "sources") {
    return { ok: false, error: "body must be { app, sources }" };
  }
  try {
    validateAppName(body.app);
  } catch {
    return { ok: false, error: "invalid app" };
  }
  const list = (v, known) => Array.isArray(v) && v.length <= known.length && v.every((s) => typeof s === "string" && known.includes(s));
  if (!list(body.sources, ALL_SOURCES)) return { ok: false, error: "sources must be a list of known sources" };
  return { ok: true, app: body.app, sources: body.sources };
}

/**
 * Change an app's sources. Everything else in the profile stays as it was, and the result
 * is checked by validateProfile() before it's written.
 * @throws {Error} a "marKit: ..." message if the profile doesn't exist or doesn't validate
 */
export function saveAppSources({ appsDir }, { app, sources }) {
  const file = path.join(appsDir, `${validateAppName(app)}.json`);
  if (!existsSync(file)) throw new Error(`marKit: no app named "${app}".`);
  const current = readJsonFile(file, null);
  // The page sends sources in today's meaning ("socialcrawl" = Threads), so mark the profile
  // as upgraded; otherwise an old profile would have its Threads switch turned into Reddit.
  const { profile } = validateProfile({ ...current, sources, socialcrawlPlatforms: SOCIALCRAWL_PLATFORMS }, app); // throws a readable list of problems
  writeJsonFile(file, profile);
  return { app, sources: profile.sources };
}
