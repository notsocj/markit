// render-report.js — turns validated, scored posts into report.md (spec section 11).
//
// The report must be easy to scan in any editor or GitHub preview:
//   header → counts → source table → High cards → Medium cards → Low list (collapsed)
// Cards are numbered across the whole report, so the user can say "rewrite draft #3".
//
// SAFETY: titles, excerpts, site names, and authors come from strangers' posts. Markdown
// is a tiny language, so a post could try to inject links, images, HTML, or fake headings
// into the report. We escape everything that came from a post (escapeMd), and neutralize
// HTML tags in text the agent wrote (softEscape), since the agent may have quoted a post.

import { SOURCE_LABELS } from "./profile.js";
import { relativeTime } from "./normalize.js";
import { contextLine } from "./context.js";
import { prefilterLine } from "./filters.js";

/** Escape untrusted text so markdown shows it literally, on a single line. */
export function escapeMd(text) {
  return String(text ?? "")
    // Control characters (except tab/newline) can hide text or confuse editors.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Backslash-escape characters that format text anywhere in a line: emphasis (* _ ~),
    // code (`), links/images ([ ] — without brackets, ( ) and ! do nothing), tables (|),
    // and headings (#).
    .replace(/([\\`*_\[\]|~#])/g, "\\$1")
    // "-", "+", and "1." only start a list at the very beginning of a line.
    .replace(/^([+-])/, "\\$1")
    .replace(/^(\d+)\./, "$1\\.");
}

/**
 * Lighter escaping for text the AGENT wrote (why, caution, draft replies): keep it readable
 * when copied from the raw file, but stop HTML tags and remove control characters.
 */
export function softEscape(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/<(?=[a-zA-Z/!?])/g, "&lt;");
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/** Sort: priority, then score (highest first), then newest first. */
export function sortPosts(posts) {
  return [...posts].sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      b.score - a.score ||
      (b.createdAt || "").localeCompare(a.createdAt || "")
  );
}

/**
 * Display name for where a post came from: "Hacker News", or its `site` when it has one
 * ("Autosport Forums" for a web result, "Reddit r/formula1" for SocialCrawl).
 */
export function sourceLabel(post) {
  if (post.site) return post.site;
  if (post.source === "web") return "Web";
  return SOURCE_LABELS[post.source] ?? post.source;
}

/** A post's title for display, falling back to the start of its text. */
function displayTitle(post) {
  const title = post.title?.trim() || post.excerpt?.trim().slice(0, 80) || "(untitled)";
  return escapeMd(title);
}

/** Quote multi-line text as a markdown blockquote ("> " on every line). */
function blockquote(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** Only valid http(s) links, as their normalized form, at most 5. */
function safeUrls(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const value of list.slice(0, 5)) {
    try {
      const u = new URL(String(value));
      if (u.protocol === "https:" || u.protocol === "http:") out.push(u.href);
    } catch {}
  }
  return out;
}

/** One full card for a high or medium post. */
function card(post, number, now) {
  const age = post.createdAt ? relativeTime(post.createdAt, now) : "date unknown";
  const lines = [
    `### ${number}. "${displayTitle(post)}" · ${escapeMd(sourceLabel(post))} · ${age} · score ${post.score}`,
    // URLs were validated as http(s); new URL().href percent-encodes anything odd.
    `<${new URL(post.url).href}>`,
    "",
  ];
  if (post.excerpt?.trim()) lines.push(`> ${escapeMd(post.excerpt)}`, "");
  // One line about the comments, e.g. "12 comments · 2 apps already suggested · not solved".
  const thread = contextLine(post.context);
  if (thread) lines.push(`**Thread:** ${escapeMd(thread.replace(/^Thread: /, ""))}`, "");
  // Other places the same question was posted (merged by the prefilter).
  const also = safeUrls(post.alsoPostedAt);
  if (also.length) lines.push(`**Also posted at:** ${also.map((u) => `<${u}>`).join(", ")}`, "");
  lines.push(`**Why it fits:** ${softEscape(post.why).replace(/\s+/g, " ").trim()}`, "");
  if (post.caution?.trim()) lines.push(`**Caution:** ${softEscape(post.caution).replace(/\s+/g, " ").trim()}`, "");
  if (post.mention === "praise") lines.push("**Testimonial:** praise worth saving (ask before quoting it publicly).", "");
  if (post.mention === "bug") lines.push("**Bug report:** someone hit a problem with your app; worth following up.", "");
  lines.push("**Draft reply:**", "", blockquote(softEscape(post.draftReply).trim()), "", "- [ ] Replied", "", "---", "");
  return lines.join("\n");
}

/** One line in the collapsed low-priority list. */
function lowLine(post, number) {
  const why = softEscape(post.why).replace(/\s+/g, " ").trim();
  return `- **${number}.** "${displayTitle(post)}" · ${escapeMd(sourceLabel(post))} · <${new URL(post.url).href}> · ${why}`;
}

/** The "Source | Found | Status" table rows, from raw.json's statuses plus the scored posts. */
function sourceRows(rawSources, reported) {
  const countBy = (pred) => reported.filter(pred).length;
  const rows = [];
  const covered = new Set();

  for (const s of rawSources) {
    if (s.name === "web") {
      // One row per site the agent found results on, e.g. "Autosport Forums (web search)".
      const sites = [...new Set(reported.filter((p) => p.source === "web").map(sourceLabel))].sort();
      if (sites.length) for (const site of sites) rows.push([`${escapeMd(site)} (web search)`, countBy((p) => p.source === "web" && sourceLabel(p) === site), "✓"]);
      else rows.push(["Web search", 0, `✓ (${s.reason ?? "searched"})`]);
      covered.add("web");
      continue;
    }
    covered.add(s.name);
    const label = s.label ?? SOURCE_LABELS[s.name] ?? s.name;
    if (s.status === "ok") rows.push([label, countBy((p) => p.source === s.name), s.reason ? `✓ (${s.reason})` : "✓"]);
    else if (s.status === "error") rows.push([label, "–", `✗ ${s.reason}, run /markit-usage`]);
    else rows.push([label, "–", `skipped (${s.reason})`]);
  }

  // Posts from a source raw.json didn't list (e.g. web results when "web" wasn't enabled).
  for (const p of reported) {
    if (covered.has(p.source)) continue;
    covered.add(p.source);
    rows.push([escapeMd(sourceLabel(p)), countBy((x) => x.source === p.source), "✓"]);
  }
  return rows;
}

/**
 * Build the report.
 *
 * @param {object} args
 * @param {object} args.raw - raw.json (app, ranAt, lookbackDays, sources)
 * @param {object[]} args.posts - validated scored posts (irrelevant ones are left out here)
 * @param {Date} [args.now] - for "2h ago"
 * @param {string} [args.timeZone] - for the header date (defaults to this computer's)
 * @param {object} [args.prefilter] - candidates.json's prefilter summary (counts only)
 * @returns {{ markdown: string, numbered: { number: number, post: object }[] }}
 */
export function renderReport({ raw, posts, now = new Date(), timeZone, prefilter }) {
  const reported = sortPosts(posts.filter((p) => p.intent !== "irrelevant"));
  const numbered = reported.map((post, i) => ({ number: i + 1, post }));
  const high = numbered.filter((n) => n.post.priority === "high");
  const medium = numbered.filter((n) => n.post.priority === "medium");
  const low = numbered.filter((n) => n.post.priority === "low");

  const ranAt = new Date(raw.ranAt);
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(ranAt);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(ranAt);

  const out = [`# marKit report: ${escapeMd(raw.app)}`, `${date} · ${time} · last ${raw.lookbackDays} days`, ""];

  const total = reported.length;
  out.push(
    total
      ? `**${total} ${total === 1 ? "opportunity" : "opportunities"}**: ${high.length} high · ${medium.length} medium · ${low.length} low`
      : "**No new opportunities this run.** Try again in a few days, or add keywords with /markit-setup.",
    ""
  );
  const filterLine = prefilterLine(prefilter);
  if (filterLine) out.push(`_${escapeMd(filterLine)}_`, "");

  out.push("| Source | Found | Status |", "|---|---|---|");
  for (const [label, found, status] of sourceRows(raw.sources ?? [], reported)) out.push(`| ${label} | ${found} | ${status} |`);
  out.push("", "---", "");

  if (high.length) {
    out.push("## High priority, reply to these first", "");
    for (const { number, post } of high) out.push(card(post, number, now));
  }
  if (medium.length) {
    out.push("## Medium priority", "");
    for (const { number, post } of medium) out.push(card(post, number, now));
  }
  if (low.length) {
    out.push("<details>", `<summary>Low priority (${low.length})</summary>`, "");
    for (const { number, post } of low) out.push(lowLine(post, number));
    out.push("", "</details>", "");
  }

  out.push("_marKit only drafts. Read each thread and its community rules before replying, and always disclose that you made the app._", "");
  return { markdown: out.join("\n"), numbered };
}
