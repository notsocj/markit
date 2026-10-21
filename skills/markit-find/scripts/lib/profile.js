// profile.js — checks and cleans up an app profile (apps/<name>.json).
//
// A profile describes one app: what it is, who it's for, and which keywords to search.
// setup.js runs every profile through validateProfile() before saving it, and search.js
// runs it again when loading (in case someone hand-edited the file).
//
// validateProfile() collects EVERY problem before failing, so the user can fix them all
// in one go instead of one error at a time.

import { validateAppName } from "./config.js";

// Every source marKit knows about. "web" isn't a script: it means the agent runs its
// own web searches (Reddit, Quora, forums) using queries search.js generates.
export const ALL_SOURCES = ["hackernews", "stackexchange", "bluesky", "youtube", "threads", "x", "socialcrawl", "web"];

// Display names, used in terminal output, reports, and /markit-usage.
export const SOURCE_LABELS = {
  hackernews: "Hacker News",
  stackexchange: "Stack Exchange",
  bluesky: "Bluesky",
  youtube: "YouTube",
  threads: "Threads",
  x: "X",
  socialcrawl: "SocialCrawl",
  web: "Web search",
};

// Used when a profile doesn't list sources. Only the free ones: paid sources (x,
// socialcrawl) must be switched on deliberately, so nobody gets billed by accident.
// Threads is left out too: until Meta approves your app in App Review, its search only
// finds your OWN posts, so it would look broken to most people. Add "threads" if approved.
export const DEFAULT_SOURCES = ["hackernews", "stackexchange", "bluesky", "youtube", "web"];

export const DEFAULT_REPLY_TONE = "casual, friendly, short";

// softwarerecs.stackexchange.com exists exactly for "recommend me software" questions.
export const DEFAULT_STACKEXCHANGE_SITES = ["softwarerecs"];

const KNOWN_FIELDS = new Set([
  "name", "url", "oneLiner", "description", "audience", "features", "keywords", "competitors",
  "exclude", "sources", "replyTone", "lookbackDays", "stackexchangeSites", "languages",
]);

/**
 * Clean a list of strings: trim each one, drop empties, and drop duplicates
 * (ignoring upper/lower case). Returns null if `value` isn't an array of strings.
 */
function cleanList(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const trimmed = item.trim().replace(/\s+/g, " ");
    const lower = trimmed.toLowerCase();
    if (trimmed && !seen.has(lower)) {
      seen.add(lower);
      out.push(trimmed);
    }
  }
  return out;
}

const isText = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Check a profile and return a cleaned copy plus any warnings.
 *
 * @param {object} input - the profile as parsed from JSON
 * @param {string} [name] - the app name from the command line (wins over input.name)
 * @returns {{ profile: object, warnings: string[] }}
 * @throws {Error} listing every problem, if the profile isn't usable
 */
export function validateProfile(input, name = input?.name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("marKit: the app profile must be a JSON object.");
  }

  const errors = [];
  const warnings = [];

  // --- name ---
  try {
    validateAppName(name);
  } catch (err) {
    errors.push(err.message.replace(/^marKit: /, ""));
  }
  if (input.name !== undefined && input.name !== name) {
    errors.push(`"name" in the JSON ("${input.name}") doesn't match --name ("${name}").`);
  }

  // --- url ---
  let url = "";
  if (!isText(input.url)) {
    errors.push(`"url" is required (e.g. "https://example.com").`);
  } else {
    try {
      const parsed = new URL(input.url.trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
      // Keep what the user typed (parsed.href would add a trailing "/" they didn't write).
      url = input.url.trim();
    } catch {
      errors.push(`"url" must be a full web address starting with https:// (got "${input.url}").`);
    }
  }

  // --- required text fields ---
  if (!isText(input.oneLiner)) errors.push(`"oneLiner" is required: one sentence saying what the app does.`);
  else if (input.oneLiner.length > 200) errors.push(`"oneLiner" should be one sentence (200 characters max).`);
  if (!isText(input.audience)) errors.push(`"audience" is required: who the app is for.`);

  // --- optional text fields ---
  for (const field of ["description", "replyTone"]) {
    if (input[field] !== undefined && typeof input[field] !== "string") errors.push(`"${field}" must be text.`);
  }

  // --- keywords ---
  const keywords = cleanList(input.keywords);
  if (keywords === null || keywords.length === 0) {
    errors.push(`"keywords" is required: a list of 3–8 search phrases.`);
  } else {
    if (keywords.length > 8) errors.push(`"keywords" has ${keywords.length} phrases; use 8 at most (each one costs API quota).`);
    if (keywords.length < 3) warnings.push(`Only ${keywords.length} keyword(s). 3–8 intent phrases usually find more.`);
    for (const kw of keywords) {
      if (kw.length > 100) errors.push(`Keyword "${kw.slice(0, 40)}…" is too long (100 characters max).`);
      // One-word keywords like "F1" match far too much and burn through quota.
      else if (!kw.includes(" ")) warnings.push(`Keyword "${kw}" is a single word, which is usually too broad. Intent phrases like "best app for ${kw}" work better.`);
    }
  }

  // --- optional lists ---
  // features: the app's main features, in a few words each. The agent uses them to judge
  // whether a post really fits and to write accurate replies.
  const features = input.features === undefined ? [] : cleanList(input.features);
  if (features === null) errors.push(`"features" must be a list of short phrases.`);
  else {
    if (features.length > 10) errors.push(`"features" has ${features.length} items; list the 10 most important at most.`);
    if (features.some((f) => f.length > 150)) errors.push(`Each feature should be a short phrase (150 characters max).`);
  }
  const competitors = input.competitors === undefined ? [] : cleanList(input.competitors);
  if (competitors === null) errors.push(`"competitors" must be a list of names.`);
  const exclude = input.exclude === undefined ? [] : cleanList(input.exclude);
  if (exclude === null) errors.push(`"exclude" must be a list of words.`);

  // --- sources ---
  let sources = input.sources === undefined ? [...DEFAULT_SOURCES] : cleanList(input.sources);
  if (sources === null) {
    errors.push(`"sources" must be a list, e.g. ${JSON.stringify(DEFAULT_SOURCES)}.`);
  } else {
    sources = sources.map((s) => s.toLowerCase());
    const unknown = sources.filter((s) => !ALL_SOURCES.includes(s));
    if (unknown.length) errors.push(`Unknown source(s): ${unknown.join(", ")}. Choose from: ${ALL_SOURCES.join(", ")}.`);
    if (sources.length === 0) errors.push(`"sources" can't be empty.`);
  }

  // --- Stack Exchange sites ---
  let stackexchangeSites = input.stackexchangeSites === undefined ? [...DEFAULT_STACKEXCHANGE_SITES] : cleanList(input.stackexchangeSites);
  if (stackexchangeSites === null) {
    errors.push(`"stackexchangeSites" must be a list of site names, e.g. ["softwarerecs", "android"].`);
  } else {
    stackexchangeSites = stackexchangeSites.map((s) => s.toLowerCase());
    // Site names are API parameters like "softwarerecs" or "android.stackexchange".
    const bad = stackexchangeSites.filter((s) => !/^[a-z0-9.]+$/.test(s));
    if (bad.length) errors.push(`Invalid Stack Exchange site name(s): ${bad.join(", ")}.`);
    // Each site costs one request per keyword (see adapters/stackexchange.js MAX_SITES).
    if (stackexchangeSites.length > 3) warnings.push(`Only the first 3 Stack Exchange sites are searched, to save quota: ${stackexchangeSites.slice(0, 3).join(", ")}.`);
  }

  // --- languages (optional, default ["en"]): posts the platform reports in another language
  //     are dropped by candidates.js. Posts with no language info are always kept. ---
  let languages = input.languages === undefined ? ["en"] : cleanList(input.languages);
  if (languages === null || languages.length === 0) {
    errors.push(`"languages" must be a list of language codes, e.g. ["en"] or ["en", "es"].`);
  } else {
    languages = languages.map((l) => l.toLowerCase());
    const badLangs = languages.filter((l) => !/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(l));
    if (badLangs.length) errors.push(`Invalid language code(s): ${badLangs.join(", ")}. Use codes like "en", "es", "pt-br".`);
  }

  // --- lookbackDays (optional: settings.json's value is used if it's missing) ---
  if (input.lookbackDays !== undefined && !(Number.isInteger(input.lookbackDays) && input.lookbackDays >= 1 && input.lookbackDays <= 30)) {
    errors.push(`"lookbackDays" must be a whole number from 1 to 30.`);
  }

  // Unknown fields are dropped (not an error), but we say so in case it's a typo.
  for (const field of Object.keys(input)) {
    if (!KNOWN_FIELDS.has(field)) warnings.push(`Ignored unknown field "${field}".`);
  }

  if (errors.length) {
    throw new Error(`marKit: the app profile has problems:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  // Build the clean profile in a fixed field order, so saved files look tidy and consistent.
  const profile = {
    name,
    url,
    oneLiner: input.oneLiner.trim(),
    description: (input.description ?? "").trim(),
    audience: input.audience.trim(),
    features,
    keywords,
    competitors,
    exclude,
    sources,
    stackexchangeSites,
    languages,
    replyTone: isText(input.replyTone) ? input.replyTone.trim() : DEFAULT_REPLY_TONE,
  };
  if (input.lookbackDays !== undefined) profile.lookbackDays = input.lookbackDays;

  return { profile, warnings };
}
