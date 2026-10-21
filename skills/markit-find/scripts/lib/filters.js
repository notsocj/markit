// filters.js — small rules that decide which posts make it into raw.json.
//
// search.js applies them per source, BEFORE capping to maxPostsPerSource, so a cap never
// wastes space on posts that would be filtered out anyway.

/** Escape a word so it can be used safely inside a regular expression. */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build a function that says whether a post contains any of the profile's `exclude` words.
 *
 * Matching is case-insensitive and whole-word: "job" matches "Job" and "jobs" (plurals
 * ending in s/es count) but not "jobless", and "bet" does NOT match "better".
 */
export function makeExcludeMatcher(words = []) {
  const clean = words.map((w) => w.trim()).filter(Boolean);
  if (!clean.length) return () => false;
  // \b = word boundary. (?:s|es)? lets "job" also catch "jobs".
  const re = new RegExp(`\\b(?:${clean.map(escapeRegex).join("|")})(?:s|es)?\\b`, "i");
  return (post) => re.test(`${post.title} ${post.excerpt}`);
}

/**
 * True if the post is inside the lookback window. APIs are asked for recent posts only,
 * but we double-check in case one ignores the date filter. Posts with no date are kept
 * (the agent can still judge them).
 */
export function isWithinWindow(post, since) {
  if (!post.createdAt) return true;
  return new Date(post.createdAt).getTime() >= since.getTime();
}

/**
 * Merge per-keyword result lists into one list of at most `max` posts, taking one post
 * from each keyword in turn (round-robin) and skipping duplicates.
 *
 * Why not just "newest first"? One busy keyword could fill the whole cap and hide every
 * other keyword's results. Round-robin keeps the mix fair.
 */
export function interleave(lists, max) {
  const out = [];
  const seenIds = new Set();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < max; i++) {
    for (const list of lists) {
      const post = list[i];
      if (!post || seenIds.has(post.id)) continue;
      seenIds.add(post.id);
      out.push(post);
      if (out.length >= max) break;
    }
  }
  return out;
}
