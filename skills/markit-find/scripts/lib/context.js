// context.js — "thread context": what's already happening in a post's comments.
//
// A great-looking post is a bad place to reply if it's already solved, locked, or full of
// people suggesting apps. candidates.js asks each adapter's optional context() method for
// the top candidates, and every adapter builds its answer with buildContext() below, so
// the stored shape is always the same:
//
//   {
//     commentCount: 12,            // replies/comments/answers the platform reports
//     solved: false,               // accepted answer, or the author says it's solved
//     locked: false,               // can't reply any more (locked, closed, archived)
//     topComments: [               // at most 5, in the platform's own ranking order
//       { author: "jane", excerpt: "I use TripIt but…", score: 4 }
//     ],
//     appsAlreadySuggested: 2,     // comments that seem to recommend a tool (heuristic)
//     mentionsYourApp: false       // someone already named the user's app
//   }
//
// SAFETY: comment text is UNTRUSTED (written by strangers). We strip HTML, cut excerpts to
// ~200 characters, and keep only the username, the excerpt, and the score: no profile
// data, no links followed. Nothing here ever treats comment text as instructions.

import { stripHtml, excerpt, collapseWhitespace } from "./normalize.js";

export const MAX_TOP_COMMENTS = 5;
export const COMMENT_EXCERPT = 200;
// The heuristics below only look at this many comments (big threads have hundreds).
export const MAX_COMMENTS_SCANNED = 50;

// ---------------------------------------------------------------------------
// Heuristics. Simple on purpose, and imperfect:
//   - They only see the comments we fetched (the top few dozen), not the whole thread.
//   - "Suggests a tool" is guessed from wording and links, so a comment saying "I tried
//     TripIt and hated it" counts as a suggestion, and "Notion!" alone doesn't.
//   - "Solved" from the author's own words only works when the platform tells us who the
//     author is (X results don't).
// They nudge the agent's scoring (scoring.md); the agent still reads the comments.
// ---------------------------------------------------------------------------

// Wording that usually means "here's a tool you could use".
const SUGGESTION = /(https?:\/\/|www\.|\b(i use|i've been using|ive been using|i have been using|we use|i recommend|i'd recommend|i would recommend|recommend|try|check out|switched to|i went with|go with|there's an app|there is an app|app called|tool called)\b)/i;

// The original author saying their question is answered.
const AUTHOR_SOLVED = /\b(solved|found it|figured it out|went with|ended up (using|with|going with)|that worked|this worked|perfect,? thanks?|thanks[^.!?]{0,30}(worked|perfect|exactly))\b/i;

/** Does this comment look like it recommends a tool or app? */
export function looksLikeSuggestion(text) {
  return SUGGESTION.test(String(text ?? ""));
}

/** Clean one username: plain text, no line breaks, at most 60 characters. */
function cleanAuthor(author) {
  return collapseWhitespace(stripHtml(author)).slice(0, 60);
}

/**
 * Build the stored context from what an adapter fetched.
 *
 * @param {object} raw
 * @param {number} [raw.commentCount] - total the platform reports (falls back to comments.length)
 * @param {boolean} [raw.solved] - platform-level "solved" (e.g. an accepted answer)
 * @param {boolean} [raw.locked] - can't reply any more
 * @param {{ author?: string, text?: string, score?: number }[]} [raw.comments] - best first
 * @param {object} [opts]
 * @param {object} [opts.post] - the post (its `author` is used to spot "solved, thanks!")
 * @param {string[]} [opts.appNames] - the user's app name(s), to spot existing mentions
 */
export function buildContext({ commentCount, solved = false, locked = false, comments = [] } = {}, { post = {}, appNames = [] } = {}) {
  const scanned = comments.slice(0, MAX_COMMENTS_SCANNED).map((c) => ({
    author: cleanAuthor(c.author ?? ""),
    text: collapseWhitespace(stripHtml(c.text ?? "")),
    score: Number.isFinite(c.score) ? c.score : null,
  })).filter((c) => c.text);

  const postAuthor = String(post.author ?? "").toLowerCase();
  const authorSaysSolved = Boolean(postAuthor) && scanned.some((c) => c.author.toLowerCase() === postAuthor && AUTHOR_SOLVED.test(c.text));

  // Whole-word, case-insensitive match of the app's name(s), e.g. "gridpeek".
  const names = appNames.map((n) => String(n).trim()).filter((n) => n.length >= 3);
  const nameRe = names.length ? new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i") : null;

  return {
    commentCount: Number.isFinite(commentCount) && commentCount >= 0 ? commentCount : scanned.length,
    solved: Boolean(solved || authorSaysSolved),
    locked: Boolean(locked),
    topComments: scanned.slice(0, MAX_TOP_COMMENTS).map((c) => ({ author: c.author, excerpt: excerpt(c.text, COMMENT_EXCERPT), score: c.score })),
    // The original author's own comments ("I went with X") aren't suggestions to them.
    appsAlreadySuggested: scanned.filter((c) => c.author.toLowerCase() !== postAuthor && looksLikeSuggestion(c.text)).length,
    mentionsYourApp: nameRe ? scanned.some((c) => nameRe.test(c.text)) : false,
  };
}

/**
 * Check and tidy a context object read back from a file (cards.json, candidates.json),
 * keeping only the known fields with the right types. Returns null if it isn't usable.
 */
export function cleanContext(ctx) {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return null;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const topComments = Array.isArray(ctx.topComments)
    ? ctx.topComments.slice(0, MAX_TOP_COMMENTS).filter((c) => c && typeof c === "object").map((c) => ({
        author: collapseWhitespace(String(c.author ?? "")).slice(0, 60),
        excerpt: excerpt(collapseWhitespace(String(c.excerpt ?? "")), COMMENT_EXCERPT),
        score: Number.isFinite(c.score) ? c.score : null,
      })).filter((c) => c.excerpt)
    : [];
  return {
    commentCount: num(ctx.commentCount),
    solved: ctx.solved === true,
    locked: ctx.locked === true,
    topComments,
    appsAlreadySuggested: num(ctx.appsAlreadySuggested),
    mentionsYourApp: ctx.mentionsYourApp === true,
  };
}

/** The one-line summary: "Thread: 12 comments · 2 apps already suggested · not solved". */
export function contextLine(ctx) {
  const c = cleanContext(ctx);
  if (!c) return "";
  const parts = [`${c.commentCount} ${c.commentCount === 1 ? "comment" : "comments"}`];
  if (c.appsAlreadySuggested) parts.push(`${c.appsAlreadySuggested} ${c.appsAlreadySuggested === 1 ? "app" : "apps"} already suggested`);
  if (c.mentionsYourApp) parts.push("your app already mentioned");
  parts.push(c.solved ? "solved" : "not solved");
  if (c.locked) parts.push("locked");
  return "Thread: " + parts.join(" · ");
}
