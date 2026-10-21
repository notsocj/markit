// dashboard-settings.js — the Settings page: API keys and which sources each app uses.
//
// API KEYS are WRITE-ONLY here. You paste a key in your browser, it goes straight to this
// local server, and the server writes it into ~/.config/markit/.env (lib/env-file.js). The
// server never sends a key back, never logs it, and never prints it, so it can't show up in
// your agent's chat or in the background task's output. The page only ever learns "set" or
// "not set", and the result of a test call ("ok", "invalid", ...).
//
// SOURCES: the page can switch each source on or off for an app, and choose what
// SocialCrawl searches (Reddit, Threads). Only those two profile fields can change, and the
// profile goes through the same validateProfile() as /markit-setup before it's saved.
//
// This module imports shared code with plain imports, like dashboard-data.js: dashboard.js
// loads it only after shared.js has confirmed the sibling markit-find folder exists.

import { existsSync } from "node:fs";
import path from "node:path";
import { KNOWN_KEYS, loadEnv, listApps, validateAppName } from "../../markit-find/scripts/lib/config.js";
import { keyStatus, writeEnvValue, validateKeyValue } from "../../markit-find/scripts/lib/env-file.js";
import { readJsonFile, writeJsonFile } from "../../markit-find/scripts/lib/files.js";
import { validateProfile, ALL_SOURCES, SOURCE_LABELS, SOCIALCRAWL_PLATFORMS, DEFAULT_SOURCES } from "../../markit-find/scripts/lib/profile.js";
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
  { source: "socialcrawl", cost: "paid", keys: [{ env: "SOCIALCRAWL_API_KEY", label: "API key" }], help: "socialcrawl.dev dashboard → API key (starts with sc_). 100 free credits. Covers Reddit, and Threads if you switch it on below.", link: "https://www.socialcrawl.dev" },
];

/** Everything the Settings page shows. Key VALUES are never included. */
export function getSettings({ envFile, appsDir }) {
  const set = keyStatus(envFile);
  const sources = SOURCE_INFO.map((info) => ({
    ...info,
    label: SOURCE_LABELS[info.source] ?? info.source,
    keys: info.keys.map((k) => ({ ...k, set: set[k.env] })),
    // Ready = has every required key (sources with only optional keys are always ready).
    ready: info.keys.filter((k) => !k.optional).every((k) => set[k.env]),
  }));
  const apps = listApps({ appsDir }).map((name) => {
    try {
      const profile = readJsonFile(path.join(appsDir, `${name}.json`), {});
      return {
        name,
        sources: Array.isArray(profile.sources) ? profile.sources : [...DEFAULT_SOURCES],
        socialcrawlPlatforms: Array.isArray(profile.socialcrawlPlatforms) ? profile.socialcrawlPlatforms : ["reddit"],
      };
    } catch {
      return null; // a broken profile is left for /markit-setup to fix
    }
  }).filter(Boolean);
  return { sources, apps, allSources: ALL_SOURCES.map((s) => ({ source: s, label: SOURCE_LABELS[s] ?? s })), platforms: SOCIALCRAWL_PLATFORMS };
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
      recordUsage(source, { requests: 1 }, usageFile);
    } catch {
      // counting is best-effort; the test result still stands
    }
  }
  return ["ok", "invalid", "quota", "error"].includes(result) ? result : "error";
}

/**
 * Validate an app sources update: { app, sources?, socialcrawlPlatforms? } and nothing else.
 * @returns {{ ok: true, app, sources?, socialcrawlPlatforms? } | { ok: false, error }}
 */
export function validateAppUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const allowed = ["app", "sources", "socialcrawlPlatforms"];
  if (!("app" in body) || Object.keys(body).some((k) => !allowed.includes(k)) || Object.keys(body).length < 2) {
    return { ok: false, error: "body must be { app, sources?, socialcrawlPlatforms? }" };
  }
  try {
    validateAppName(body.app);
  } catch {
    return { ok: false, error: "invalid app" };
  }
  const list = (v, known) => Array.isArray(v) && v.length <= known.length && v.every((s) => typeof s === "string" && known.includes(s));
  if ("sources" in body && !list(body.sources, ALL_SOURCES)) return { ok: false, error: "sources must be a list of known sources" };
  if ("socialcrawlPlatforms" in body && !list(body.socialcrawlPlatforms, SOCIALCRAWL_PLATFORMS)) return { ok: false, error: "socialcrawlPlatforms must be a list of: reddit, threads" };
  return { ok: true, ...body };
}

/**
 * Change an app's sources and/or SocialCrawl platforms. Everything else in the profile stays
 * as it was, and the result is checked by validateProfile() before it's written.
 * @throws {Error} a "marKit: ..." message if the profile doesn't exist or doesn't validate
 */
export function saveAppSources({ appsDir }, { app, sources, socialcrawlPlatforms }) {
  const file = path.join(appsDir, `${validateAppName(app)}.json`);
  if (!existsSync(file)) throw new Error(`marKit: no app named "${app}".`);
  const current = readJsonFile(file, null);
  const next = { ...current };
  if (sources) next.sources = sources;
  if (socialcrawlPlatforms) next.socialcrawlPlatforms = socialcrawlPlatforms;
  const { profile } = validateProfile(next, app); // throws a readable list of problems
  writeJsonFile(file, profile);
  return { app, sources: profile.sources, socialcrawlPlatforms: profile.socialcrawlPlatforms };
}
