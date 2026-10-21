// scored.js — checks the agent's scored.json before report.js turns it into a report.
//
// The agent reads raw.json, runs web searches, scores every post, drafts replies, and
// writes scored.json. Agents make mistakes (a missing field, priority not matching the
// score), so we validate EVERYTHING and list every problem at once, with the post's
// position and id, so the agent can fix them all in one pass.
//
// scored.json is either { "posts": [ ... ] } or a bare array [ ... ]. Each post:
//
//   id            "<source>-<id>" from raw.json. Web results may omit it (we make one from the URL).
//   source        adapter name from raw.json, or "web" for the agent's own web search results
//   site          web results only: where it was found, e.g. "Reddit", "Autosport Forums"
//   url           http(s) link to the post
//   title         may be "" for short posts
//   excerpt       the post's text (may be "")
//   createdAt     ISO date, or "" if unknown
//   intent        asking_for_recommendation | competitor_complaint | problem_discussion | direct_mention | irrelevant
//   score         whole number 0–100
//   priority      high (≥ 75) | medium (50–74) | low (< 50); must match the score
//   why           one sentence: why this fits the app (required unless irrelevant)
//   draftReply    required for high and medium; ignored for low and irrelevant
//   caution       optional: e.g. "r/formula1 bans self-promotion"
//   mention       optional, direct_mention only: "praise" | "bug" | "question"

import { createHash } from "node:crypto";

export const INTENTS = ["asking_for_recommendation", "competitor_complaint", "problem_discussion", "direct_mention", "irrelevant"];
export const PRIORITIES = ["high", "medium", "low"];
export const MENTIONS = ["praise", "bug", "question"];

/** The priority a score belongs to (spec section 10). */
export function priorityFor(score) {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

/**
 * A stable id for a web result, from its URL: "web-3f2a9c1b7d0e".
 * The URL is tidied first (lowercase host, no #fragment, no utm_ tracking, no trailing /)
 * so the same thread found twice gets the same id and isn't reported again next run.
 */
export function webIdFor(url) {
  const u = new URL(url);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
  }
  const normalized = `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  // SHA-1 is fine here: this is a short fingerprint for de-duplication, not security.
  return "web-" + createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

const isText = (v) => typeof v === "string";
const isFilled = (v) => typeof v === "string" && v.trim() !== "";

function isHttpUrl(v) {
  if (!isFilled(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate scored.json content.
 *
 * @param {*} data - parsed scored.json
 * @param {Set<string>} [rawIds] - ids in raw.json; non-web posts must be one of these
 *   (catches ids the agent mistyped or made up)
 * @returns {object[]} posts, each with an id (web ids filled in) and clean string fields
 * @throws {Error} listing every problem
 */
export function validateScored(data, rawIds) {
  const posts = Array.isArray(data) ? data : data?.posts;
  if (!Array.isArray(posts)) {
    throw new Error('marKit: scored.json must be { "posts": [ ... ] } or an array of posts.');
  }

  const errors = [];
  const ids = new Set();
  const out = [];

  posts.forEach((p, i) => {
    const where = `posts[${i}]${p?.id ? ` (${p.id})` : ""}`;
    const problem = (msg) => errors.push(`${where}: ${msg}`);
    if (!p || typeof p !== "object" || Array.isArray(p)) return problem("must be an object");

    if (!isFilled(p.source)) problem('missing "source" (adapter name from raw.json, or "web")');
    if (!isHttpUrl(p.url)) problem('"url" must be an http(s) link');
    if (p.source === "web" && !isFilled(p.site)) problem('web results need "site", e.g. "Reddit" or "Autosport Forums"');

    // Web results may come without an id; make one from the URL.
    let id = p.id;
    if (!isFilled(id)) {
      if (p.source === "web" && isHttpUrl(p.url)) id = webIdFor(p.url);
      else problem('missing "id" (copy it from raw.json)');
    }
    if (id && ids.has(id)) problem(`duplicate id "${id}"`);
    if (id && rawIds && p.source !== "web" && !rawIds.has(id)) problem(`id "${id}" is not in raw.json (copy ids exactly; use source "web" for web results)`);
    if (id) ids.add(id);

    for (const field of ["title", "excerpt"]) {
      if (p[field] !== undefined && !isText(p[field])) problem(`"${field}" must be text`);
    }
    if (p.createdAt && Number.isNaN(new Date(p.createdAt).getTime())) problem('"createdAt" must be an ISO date or ""');

    if (!INTENTS.includes(p.intent)) problem(`"intent" must be one of: ${INTENTS.join(", ")}`);
    const irrelevant = p.intent === "irrelevant";

    if (!irrelevant) {
      if (!Number.isInteger(p.score) || p.score < 0 || p.score > 100) problem('"score" must be a whole number from 0 to 100');
      if (!PRIORITIES.includes(p.priority)) problem('"priority" must be high, medium, or low');
      else if (Number.isInteger(p.score) && priorityFor(p.score) !== p.priority) {
        problem(`priority "${p.priority}" doesn't match score ${p.score} (high ≥ 75, medium 50–74, low < 50)`);
      }
      if (!isFilled(p.why)) problem('missing "why" (one sentence on why it fits)');
      if ((p.priority === "high" || p.priority === "medium") && !isFilled(p.draftReply)) {
        problem(`missing "draftReply" (required for ${p.priority} priority)`);
      }
    }
    if (p.caution !== undefined && !isText(p.caution)) problem('"caution" must be text');
    if (p.mention !== undefined && !MENTIONS.includes(p.mention)) problem(`"mention" must be one of: ${MENTIONS.join(", ")}`);

    out.push({
      ...p,
      id,
      title: p.title ?? "",
      excerpt: p.excerpt ?? "",
      createdAt: p.createdAt ?? "",
      why: p.why ?? "",
      draftReply: p.draftReply ?? "",
      caution: p.caution ?? "",
    });
  });

  if (errors.length) {
    const shown = errors.slice(0, 25);
    const more = errors.length > shown.length ? `\n  …and ${errors.length - shown.length} more` : "";
    throw new Error(`marKit: scored.json has ${errors.length} problem(s):\n${shown.map((e) => `  - ${e}`).join("\n")}${more}`);
  }
  return out;
}
