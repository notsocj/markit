// web-queries.js — builds the web search queries the AGENT runs itself.
//
// Reddit, Quora, and niche forums have no free API marKit can use, but the agent (Claude
// Code / Codex) has its own web search tool. search.js puts these queries in raw.json's
// `webQueries`, and the agent runs them and adds what it finds as candidates.
//
// Unlike the keyword APIs, web search engines understand natural language, so the full
// intent phrase is kept ("app for planning F1 race weekend"), not the trimmed version.
// Long phrases are NOT wrapped in quotes: an exact-match quote on a 6-word phrase finds
// almost nothing. Short names (competitors) are quoted so they match exactly.
//
// Web results lag hours to days behind live posts, and there's no reliable date filter,
// so the agent must check each result's date against the lookback window.
//
// Tested 2026-10-21 with Claude Code's web search: `site:reddit.com` was NOT honored and
// Reddit threads almost never appeared (Reddit restricts search crawlers). Results were
// forum threads (useful) mixed with articles (not repliable). We keep the site: queries
// because other agents' search tools may honor them; the find skill tells the agent to
// keep only real discussions and to label each by its actual domain.

import { searchQuery } from "./normalize.js";

// Keeps the agent's work (and time) reasonable on every run.
export const MAX_WEB_QUERIES = 16;

/**
 * @param {object} profile - a validated app profile
 * @returns {string[]} queries like 'site:reddit.com app for planning F1 race weekend'
 */
export function buildWebQueries(profile) {
  const keywords = profile.keywords ?? [];
  const competitors = (profile.competitors ?? []).slice(0, 3);
  const queries = [];

  // Reddit is where most "what app do you use for X?" threads live: one query per keyword.
  for (const kw of keywords) queries.push(`site:reddit.com ${kw}`);

  // People complaining about a competitor, or asking for something better.
  for (const name of competitors) queries.push(`site:reddit.com "${name}" alternative`);

  // Quora: fewer, older threads, so just the first two keywords.
  for (const kw of keywords.slice(0, 2)) queries.push(`site:quora.com ${kw}`);

  // Niche forums (no site: filter). The trimmed topic plus "forum" finds community boards.
  for (const kw of keywords.slice(0, 2)) queries.push(`${searchQuery(kw)} forum`);

  // Remove exact duplicates (case-insensitive), keep the order above, then cap.
  const seen = new Set();
  return queries
    .filter((q) => {
      const key = q.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_WEB_QUERIES);
}
