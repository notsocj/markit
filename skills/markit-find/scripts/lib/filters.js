// filters.js — small rules that decide which posts are worth the agent's attention.
//
// Two users:
//   - search.js applies the first few per source, BEFORE capping to maxPostsPerSource,
//     so a cap never wastes space on posts that would be filtered out anyway.
//   - candidates.js runs the full PREFILTER on raw.json + web.json, so the agent (the
//     expensive part) only judges the best ~40 posts. Each step is its own function:
//       dropTooOld → dropExcluded → dropSeen → dropLanguages → dedupeCrossPosts
//       → preScoreAll → penalizeCommunities → keepTop
//     Every "drop" step returns { kept, dropped } so the run can report how many posts
//     each rule removed (counts only, never post content).
//
// None of this uses AI: it's plain, predictable rules a learner can read and adjust.

import { searchQuery } from "./normalize.js";
import { communityOf, SKIP_REASONS } from "./feedback.js";

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

// =============================================================================
// Prefilter steps (used by candidates.js)
// =============================================================================

/** Split posts into kept/dropped by a test. `keep(post)` returns true to keep. */
function split(posts, keep) {
  const kept = [];
  let dropped = 0;
  for (const post of posts) {
    if (keep(post)) kept.push(post);
    else dropped++;
  }
  return { kept, dropped };
}

/** 1. Drop posts older than the lookback window (posts with unknown dates are kept). */
export function dropTooOld(posts, since) {
  return split(posts, (post) => isWithinWindow(post, since));
}

/** 2. Drop posts containing any of the profile's `exclude` words (whole words). */
export function dropExcluded(posts, words = []) {
  const isExcluded = makeExcludeMatcher(words);
  return split(posts, (post) => !isExcluded(post));
}

/** 3. Drop posts already reported in an earlier run (ids in seen.json). */
export function dropSeen(posts, seen = new Set()) {
  return split(posts, (post) => !seen.has(post.id));
}

/**
 * 4. Drop posts the PLATFORM says are in a language the profile doesn't list.
 * Only some platforms report a language (X "lang", Bluesky "langs"); posts without one,
 * or marked "und" (undetermined), are kept: we never guess a language from the text.
 * Codes are compared by their main part, so "en-US" matches "en".
 */
export function dropLanguages(posts, languages = ["en"]) {
  const wanted = new Set(languages.map((l) => l.toLowerCase().split("-")[0]));
  return split(posts, (post) => {
    const langs = Array.isArray(post.lang) ? post.lang : [];
    if (!langs.length || langs.includes("und")) return true;
    return langs.some((l) => wanted.has(String(l).toLowerCase().split("-")[0]));
  });
}

/**
 * Text prepared for comparing posts: lowercase, links removed, punctuation and symbols
 * turned into spaces, runs of spaces collapsed. "Any APP for F1?! https://x.co" → "any app for f1".
 */
export function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, " ")
    // \p{L} = any letter, \p{N} = any digit, in any alphabet (not just English).
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity of two word sets: shared words ÷ all distinct words (0 to 1). */
export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * One number for "how much attention did this post get", from whatever the platform
 * provides. Talk (comments/replies/answers) counts double: it means a live conversation.
 */
export function engagementTotal(post) {
  const e = post.engagement || {};
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const up = num(e.score ?? e.likes);
  const talk = num(e.comments ?? e.replies ?? e.answers);
  return up + 2 * talk + num(e.reposts);
}

export const DUPLICATE_SIMILARITY = 0.8;
// Below this many words, Jaccard is too jumpy ("best F1 app?" vs "best F1 apps?"), so short
// posts only count as duplicates when their normalized text is identical.
const MIN_WORDS_FOR_SIMILARITY = 5;

/**
 * 5. Cross-post dedupe. People often post the same question in several places (two
 * subreddits, Reddit + a forum). Two posts are duplicates if their normalized
 * title + excerpt is identical, or if they share at least 80% of their words (Jaccard).
 * We keep the copy with the most engagement and list the others' URLs in `alsoPostedAt`.
 */
export function dedupeCrossPosts(posts) {
  const prepared = posts.map((post, order) => {
    const text = normalizeText(`${post.title} ${post.excerpt}`);
    return { post, order, text, words: new Set(text.split(" ").filter(Boolean)) };
  });
  // Most-engaged first, so the copy we keep is the one with the most attention.
  // (Ties keep their original order.)
  prepared.sort((a, b) => engagementTotal(b.post) - engagementTotal(a.post) || a.order - b.order);

  const kept = [];
  let dropped = 0;
  for (const item of prepared) {
    const twin = item.text
      ? kept.find(
          (k) =>
            k.text === item.text ||
            (k.words.size >= MIN_WORDS_FOR_SIMILARITY &&
              item.words.size >= MIN_WORDS_FOR_SIMILARITY &&
              jaccard(k.words, item.words) >= DUPLICATE_SIMILARITY)
        )
      : null;
    if (!twin) {
      kept.push({ ...item, post: { ...item.post } });
      continue;
    }
    dropped++;
    const also = new Set(twin.post.alsoPostedAt ?? []);
    for (const url of [item.post.url, ...(item.post.alsoPostedAt ?? [])]) {
      if (url && url !== twin.post.url) also.add(url);
    }
    twin.post.alsoPostedAt = [...also];
  }
  // Back to the original order, so results stay predictable.
  kept.sort((a, b) => a.order - b.order);
  return { kept: kept.map((k) => k.post), dropped };
}

// ---------------------------------------------------------------------------
// Pre-score: a cheap 0–100 guess at how promising a post is, BEFORE the agent reads it.
//
//   + 30   the post contains one of the profile's keywords as an exact phrase
//   + ≤15  or most of a keyword's topic words (e.g. "F1" + "race" + "weekend")
//   +  8   it asks a question ("?")
//   +  8   per intent phrase ("any app", "recommend", "looking for", "alternative to",
//          "how do you", "is there a", …), at most +24
//   + 15   it names one of the profile's competitors
//   + ≤12  it's recent: 12 if under 24h old, 8 under 3 days, 4 under 7 days
//   + ≤10  engagement, on a log scale so a viral post can't dominate
//   − 30   it's a job, sale, or giveaway post
//   − 25   it's itself a product promotion ("I built", "Show HN", "check out my", …)
//
// Clamped to 0–100. It only decides which posts the agent sees; the agent's own score
// (scoring.md) decides what goes in the report.
// ---------------------------------------------------------------------------

export const PRESCORE = {
  keywordExact: 30,
  keywordPartialMax: 15,
  question: 8,
  intentPhrase: 8,
  intentMax: 24,
  competitor: 15,
  recency: [[24, 12], [72, 8], [168, 4]], // [max hours old, points]
  // No date at all (mostly web results): it could be a years-old forum thread that's no
  // use replying to, so it starts a little lower. Tested 2026-10-22: a "first time British
  // Grand Prix" result with no visible date turned out to be from 2017.
  unknownDate: -8,
  engagementMax: 10,
  jobOrSale: -30,
  selfPromo: -25,
};

const INTENT_PHRASES = ["any app", "recommend", "recommendation", "looking for", "alternative to", "alternatives", "how do you", "is there a", "is there an", "what do you use", "which app", "best app", "suggestions"];
const JOB_OR_SALE = ["hiring", "now hiring", "job opening", "job posting", "for sale", "on sale", "discount", "coupon", "promo code", "giveaway"];
const SELF_PROMO = ["i built", "i made", "we built", "we launched", "just launched", "check out my", "my new app", "introducing", "show hn", "launching", "download my"];

/** True if `phrase` (already normalized) appears as whole words in normalized `text`. */
const hasPhrase = (text, phrase) => phrase && ` ${text} `.includes(` ${phrase} `);

/**
 * 6. Pre-score one post. Returns { preScore, preScoreReasons } (reasons are short notes
 * for the agent and the report, e.g. 'exact keyword "F1 schedule app"').
 */
export function preScore(post, profile, now = new Date()) {
  const text = normalizeText(`${post.title} ${post.excerpt}`);
  const raw = `${post.title} ${post.excerpt}`;
  let score = 0;
  const reasons = [];

  // Keywords: the best match among the profile's keywords.
  let best = { points: 0, reason: "" };
  for (const keyword of profile.keywords ?? []) {
    if (hasPhrase(text, normalizeText(keyword))) {
      best = { points: PRESCORE.keywordExact, reason: `exact keyword "${keyword}"` };
      break;
    }
    const topic = normalizeText(searchQuery(keyword)).split(" ").filter(Boolean);
    if (!topic.length) continue;
    const share = topic.filter((word) => hasPhrase(text, word)).length / topic.length;
    const points = share >= 0.5 ? Math.round(PRESCORE.keywordPartialMax * share) : 0;
    if (points > best.points) best = { points, reason: `partly matches "${keyword}"` };
  }
  if (best.points) {
    score += best.points;
    reasons.push(best.reason);
  }

  // Intent: a question, and phrases people use when they want a tool.
  if (raw.includes("?")) {
    score += PRESCORE.question;
    reasons.push("asks a question");
  }
  const intents = INTENT_PHRASES.filter((phrase) => hasPhrase(text, phrase));
  if (intents.length) {
    score += Math.min(PRESCORE.intentMax, intents.length * PRESCORE.intentPhrase);
    reasons.push(`intent: ${intents.slice(0, 3).map((i) => `"${i}"`).join(", ")}`);
  }

  // A competitor named in the post.
  const competitor = (profile.competitors ?? []).find((name) => hasPhrase(text, normalizeText(name)));
  if (competitor) {
    score += PRESCORE.competitor;
    reasons.push(`names ${competitor}`);
  }

  // Recency.
  if (!post.createdAt) {
    score += PRESCORE.unknownDate;
    reasons.push("date unknown");
  }
  const hours = post.createdAt ? (now.getTime() - new Date(post.createdAt).getTime()) / 3600000 : NaN;
  if (Number.isFinite(hours) && hours >= 0) {
    const bucket = PRESCORE.recency.find(([maxHours]) => hours <= maxHours);
    if (bucket) {
      score += bucket[1];
      reasons.push(hours < 24 ? "posted today" : `posted ${Math.floor(hours / 24)}d ago`);
    }
  }

  // Engagement, log scale: 1 → 1, 10 → 4, 100 → 8, 1000+ → 10 (the cap).
  const engagement = Math.min(PRESCORE.engagementMax, Math.round(4 * Math.log10(1 + engagementTotal(post))));
  if (engagement > 0) {
    score += engagement;
    reasons.push(`engagement +${engagement}`);
  }

  // Penalties.
  if (JOB_OR_SALE.some((phrase) => hasPhrase(text, phrase))) {
    score += PRESCORE.jobOrSale;
    reasons.push("job/sale post");
  }
  if (SELF_PROMO.some((phrase) => hasPhrase(text, phrase))) {
    score += PRESCORE.selfPromo;
    reasons.push("looks like self-promotion");
  }

  return { preScore: Math.max(0, Math.min(100, score)), preScoreReasons: reasons };
}

/** Pre-score every post (returns new objects with preScore + preScoreReasons added). */
export function preScoreAll(posts, profile, now = new Date()) {
  return posts.map((post) => ({ ...post, ...preScore(post, profile, now) }));
}

/**
 * Lower the pre-score of posts from communities you keep skipping (from your feedback, see
 * lib/learn.js communityPenalties). They are NEVER dropped here: a community you skip for
 * "bans promotion" can still have the one thread worth answering, so the agent decides.
 *
 * @param {object[]} posts - pre-scored posts
 * @param {Map<string, string>} penalties - community → reason code
 * @param {number} [points] - how much to subtract (learn.js COMMUNITY_PENALTY, 15)
 * @returns {{ posts: object[], penalized: number }}
 */
export function penalizeCommunities(posts, penalties = new Map(), points = 15) {
  if (!penalties.size) return { posts, penalized: 0 };
  let penalized = 0;
  const out = posts.map((post) => {
    const reason = penalties.get(communityOf(post));
    if (!reason) return post;
    penalized++;
    return {
      ...post,
      preScore: Math.max(0, post.preScore - points),
      preScoreReasons: [...(post.preScoreReasons ?? []), `often skipped: ${(SKIP_REASONS[reason] ?? reason).toLowerCase()}`],
    };
  });
  return { posts: out, penalized };
}

/** 7. Keep the best `max` posts by preScore (ties: newest first). */
export function keepTop(posts, max) {
  const sorted = [...posts].sort(
    (a, b) => b.preScore - a.preScore || String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  return { kept: sorted.slice(0, max), dropped: Math.max(0, sorted.length - max) };
}

const DROP_LABELS = {
  duplicate: "duplicates",
  tooOld: "too old",
  excluded: "excluded words",
  alreadyReported: "already reported",
  language: "other language",
  belowCutoff: "below the cutoff",
};

/** "30 duplicates · 12 too old · …" from a dropped-counts object (non-zero ones only). */
export function droppedSummary(dropped = {}) {
  return Object.entries(DROP_LABELS)
    .filter(([key]) => Number(dropped[key]) > 0)
    .map(([key, label]) => `${Number(dropped[key])} ${label}`)
    .join(" · ");
}

/** "Prefilter: 120 found → 40 candidates · dropped 30 duplicates · 12 too old", or "". */
export function prefilterLine(prefilter) {
  if (!prefilter || !Number.isFinite(prefilter.found)) return "";
  const dropped = droppedSummary(prefilter.dropped);
  return `Prefilter: ${prefilter.found} found → ${prefilter.candidates} candidates${dropped ? ` · dropped ${dropped}` : ""}`;
}
