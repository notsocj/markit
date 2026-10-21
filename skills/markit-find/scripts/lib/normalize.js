// normalize.js — the shared "Post" shape, plus small text and date helpers.
//
// Every API returns posts in its own format. Each adapter converts them into this one
// shape with makePost(), so search.js, the agent, and report.js only ever deal with
// one kind of object:
//
//   {
//     id: "hn-41234567",          // "<source>-<platform id>", unique across all sources
//     source: "hackernews",       // adapter name
//     url: "https://...",         // direct link to the post
//     title: "Ask HN: ...",       // may be empty for short posts
//     excerpt: "...",             // first ~500 chars of text, whitespace collapsed
//     author: "username",
//     createdAt: "2026-10-21T08:00:00Z",
//     engagement: { score: 12, comments: 4 },
//     matchedKeyword: "F1 schedule app",
//     site: "Reddit r/formula1",  // optional: where it really lives, when the source is a
//                                 // go-between (SocialCrawl) or the agent's web search
//     lang: ["en"]                // optional: languages the PLATFORM reports (X "lang",
//   }                             // Bluesky "langs"); missing means unknown
//
// Reminder: post text is UNTRUSTED. We only clean it up for display here; nothing in
// marKit ever treats it as code or instructions.

export const EXCERPT_LENGTH = 500;

// Short ids for each source, used as the id prefix. Unknown sources use their full name.
const ID_PREFIX = {
  hackernews: "hn",
  stackexchange: "se",
  bluesky: "bsky",
  youtube: "yt",
  threads: "th",
  x: "x",
  socialcrawl: "sc",
  web: "web",
};

/** Turn runs of spaces, tabs, and newlines into single spaces. */
export function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// The HTML entities that actually show up in Hacker News and Stack Exchange text.
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#x27": "'", "#x2F": "/" };

/**
 * Remove HTML tags and decode entities, so "<p>I&#x27;m stuck</p>" becomes "I'm stuck".
 * This is for readable excerpts only, not a security filter: the report shows excerpts
 * as plain quoted text, and we never render post HTML.
 */
export function stripHtml(html) {
  return String(html ?? "")
    // Paragraph and line breaks become spaces so words don't run together.
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (NAMED_ENTITIES[code] !== undefined) return NAMED_ENTITIES[code];
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        // String.fromCodePoint throws on invalid numbers, so check the range first.
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
      }
      return match; // unknown entity: leave it as-is
    });
}

/**
 * The first ~500 characters of a post, cut at a word boundary, with "…" if it was cut.
 */
export function excerpt(text, max = EXCERPT_LENGTH) {
  const clean = collapseWhitespace(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only back up to the last space if it isn't too far back (very long "words" like URLs).
  return (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut) + "…";
}

/**
 * Convert any date an API might give us into an ISO string like "2026-10-21T08:00:00Z".
 * Accepts: a Date, an ISO string, or a number of seconds or milliseconds since 1970.
 * Returns "" if the date can't be understood.
 */
export function toIsoDate(value) {
  if (value === null || value === undefined || value === "") return "";
  let date;
  if (typeof value === "number") {
    // Unix timestamps in seconds are ~10 digits; in milliseconds ~13 digits.
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) return "";
  // Drop the milliseconds (".000") because no API gives us anything that precise.
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Words that carry no topic. Profiles use intent phrases like "app for planning F1 race
// weekend" (great for web search), but keyword APIs such as Hacker News and Stack Exchange
// require EVERY word to match, so the full phrase finds nothing. Tested 2026-10-21: that
// phrase had 0 hits all-time on both, while "F1 race weekend" style queries do match.
const FILLER_WORDS = new Set([
  // grammar words
  "a", "an", "the", "for", "to", "of", "in", "on", "at", "with", "and", "or", "my", "your", "our",
  "i", "you", "we", "me", "do", "does", "is", "are", "can", "that", "this", "any", "some",
  // question words
  "how", "what", "which", "where", "who", "why",
  // generic "looking for a tool" words: the intent we want, but not the topic
  "app", "apps", "application", "tool", "tools", "software", "best", "good", "great", "top",
  "alternative", "alternatives", "recommend", "recommendation", "recommendations", "suggestion",
  "suggestions", "advice", "tips", "help", "use", "using", "way", "ways", "need", "looking",
  "find", "get", "going", "keep", "track", "tracking", "plan", "planning", "organize", "organizing",
]);

/**
 * Turn a profile keyword into a short topical query for strict keyword-search APIs:
 *   "app for planning F1 race weekend" → "F1 race weekend"
 *   "alternative to TripIt"            → "TripIt"
 * If nothing topical is left (e.g. "best app"), the original keyword is used as-is.
 * Web search queries (Reddit, Quora) keep the full phrase; this is only for APIs.
 */
export function searchQuery(keyword) {
  const words = collapseWhitespace(keyword).split(" ");
  // Strip punctuation only for the filler check, so "app?" still counts as filler.
  const kept = words.filter((w) => !FILLER_WORDS.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")));
  return kept.length ? kept.join(" ") : collapseWhitespace(keyword);
}

/**
 * Language codes as a clean list: "en-US" → ["en-us"], ["EN", "pt"] → ["en", "pt"].
 * Returns [] for anything missing or malformed (unknown language).
 */
export function normalizeLangs(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .filter((v) => typeof v === "string" && /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(v.trim()))
    .map((v) => v.trim().toLowerCase())
    .slice(0, 5);
}

/** The Date that is `days` days before `now`. Used for the lookback window. */
export function sinceDate(days, now = new Date()) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** "just now", "5m ago", "2h ago", "3d ago", "6w ago" for the report. */
export function relativeTime(iso, now = new Date()) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown date";
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * Build a Post in the shared shape. Adapters call this for every result.
 *
 * @param {object} p
 * @param {string} p.source - adapter name, e.g. "hackernews"
 * @param {string|number} p.platformId - the post's id on that platform
 * @param {string} p.url
 * @param {string} [p.title]
 * @param {string} [p.text] - body text (plain text, already stripped of HTML)
 * @param {string} [p.author]
 * @param {*} [p.createdAt] - anything toIsoDate() understands
 * @param {object} [p.engagement] - e.g. { score, comments, likes }
 * @param {string} [p.matchedKeyword] - the profile keyword that found this post
 * @param {string} [p.site] - display name of where the post lives, if not the source itself
 * @param {string|string[]} [p.lang] - language code(s) the platform reports, if any
 */
export function makePost({ source, platformId, url, title = "", text = "", author = "", createdAt, engagement = {}, matchedKeyword = "", site, lang }) {
  if (!source || platformId === undefined || platformId === null || platformId === "") {
    throw new Error("makePost: source and platformId are required");
  }
  const prefix = ID_PREFIX[source] ?? source;
  const post = {
    id: `${prefix}-${platformId}`,
    source,
    url: String(url ?? ""),
    title: collapseWhitespace(title),
    excerpt: excerpt(text),
    author: String(author ?? ""),
    createdAt: toIsoDate(createdAt),
    engagement,
    matchedKeyword,
  };
  if (site) post.site = String(site);
  const langs = normalizeLangs(lang);
  if (langs.length) post.lang = langs;
  return post;
}
