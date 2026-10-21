// Tests for thread context: lib/context.js helpers and each adapter's context() method
// (mocked fetch; response shapes from the docs/live checks on 2026-10-22).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, cleanContext, contextLine, looksLikeSuggestion, MAX_TOP_COMMENTS } from "../skills/markit-find/scripts/lib/context.js";
import hackernews from "../skills/markit-find/scripts/adapters/hackernews.js";
import stackexchange, { _resetBackoff } from "../skills/markit-find/scripts/adapters/stackexchange.js";
import bluesky from "../skills/markit-find/scripts/adapters/bluesky.js";
import youtube from "../skills/markit-find/scripts/adapters/youtube.js";
import threads from "../skills/markit-find/scripts/adapters/threads.js";
import x, { _resetFieldsParam } from "../skills/markit-find/scripts/adapters/x.js";
import socialcrawl from "../skills/markit-find/scripts/adapters/socialcrawl.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

// --- shared helpers ----------------------------------------------------------------

test("buildContext cleans untrusted comments: HTML stripped, excerpts cut, only author/excerpt/score kept", () => {
  const long = "word ".repeat(100);
  const ctx = buildContext({
    commentCount: 9,
    comments: [
      { author: "<b>jane</b>", text: "<p>I use <a href='x'>TripIt</a></p>", score: 4, email: "jane@example.com", avatar: "https://x" },
      { author: "bob", text: long, score: "nope" },
      ...Array.from({ length: 6 }, (_, i) => ({ author: `u${i}`, text: `comment ${i}` })),
    ],
  });
  assert.equal(ctx.commentCount, 9);
  assert.equal(ctx.topComments.length, MAX_TOP_COMMENTS);
  assert.deepEqual(ctx.topComments[0], { author: "jane", excerpt: "I use TripIt", score: 4 });
  assert.ok(ctx.topComments[1].excerpt.length <= 201);
  assert.equal(ctx.topComments[1].score, null);
  assert.ok(!JSON.stringify(ctx).includes("jane@example.com"), "no profile data is kept");
});

test("appsAlreadySuggested, author-says-solved, and mentionsYourApp heuristics", () => {
  const ctx = buildContext(
    {
      comments: [
        { author: "a", text: "Try TripIt, it's great" },
        { author: "b", text: "I recommend Wanderlog" },
        { author: "c", text: "https://someapp.example works" },
        { author: "d", text: "Same question here" },
        { author: "OP", text: "Thanks all, I went with gridpeek in the end. Solved!" },
      ],
    },
    { post: { author: "op" }, appNames: ["gridpeek"] }
  );
  assert.equal(ctx.appsAlreadySuggested, 3);
  assert.equal(ctx.solved, true, "the original author said it's solved");
  assert.equal(ctx.mentionsYourApp, true);
  assert.equal(looksLikeSuggestion("Same question here"), false);
  // "solved" from someone else doesn't count.
  assert.equal(buildContext({ comments: [{ author: "x", text: "solved it for me" }] }, { post: { author: "op" } }).solved, false);
});

test("looksLikeSuggestion ignores thanks, troubleshooting, and questions", () => {
  for (const text of [
    "I will try that, thanks",
    "Did you try restarting?",
    "Can anyone recommend one too?",
    "Have you tried TripIt?",
    "I'd recommend it too?",
    "try it and see",
    "Try This one weird trick",
    "Any recommendations",
    "",
  ]) {
    assert.equal(looksLikeSuggestion(text), false, `should be false: "${text}"`);
  }
});

test("looksLikeSuggestion catches real tool suggestions", () => {
  for (const text of [
    "I use Notion for this",
    "check out https://example.com/app",
    "I switched to TripIt",
    "Try TripIt, it's great",
    "you could try Wanderlog",
    "try out Notion",
    "try https://someapp.example",
    "I recommend Wanderlog",
    "I’d recommend Wanderlog", // curly apostrophe, as typed on phones
    "I would recommend Notion for this.",
  ]) {
    assert.equal(looksLikeSuggestion(text), true, `should be true: "${text}"`);
  }
});

test("questions and thanks don't make a thread look crowded", () => {
  const ctx = buildContext({ comments: [
    { author: "a", text: "I will try that, thanks" },
    { author: "b", text: "Did you try restarting?" },
    { author: "c", text: "Can anyone recommend one too?" },
  ] }, { post: { author: "op" } });
  assert.equal(ctx.appsAlreadySuggested, 0);
});

test("cleanContext keeps known fields only, and contextLine summarizes in one line", () => {
  assert.equal(cleanContext(null), null);
  const c = cleanContext({ commentCount: 12.7, solved: "yes", locked: true, appsAlreadySuggested: 2, extra: "x", topComments: [{ author: "a", excerpt: "hi", score: 1, url: "bad" }] });
  assert.deepEqual(c, { commentCount: 12, solved: false, locked: true, topComments: [{ author: "a", excerpt: "hi", score: 1 }], appsAlreadySuggested: 2, mentionsYourApp: false });
  assert.equal(contextLine({ commentCount: 12, appsAlreadySuggested: 2 }), "Thread: 12 comments · 2 apps already suggested · not solved");
  assert.equal(contextLine({ commentCount: 1, solved: true, locked: true, mentionsYourApp: true }), "Thread: 1 comment · your app already mentioned · solved · locked");
  assert.equal(contextLine(undefined), "");
});

// --- adapters ------------------------------------------------------------------------

test("hackernews.context: walks the item tree, top-level comments first", async () => {
  const item = { id: 1, children: [
    { author: "a", text: "<p>Top one, I use TripIt</p>", children: [{ author: "c", text: "reply", children: [] }] },
    { author: "b", text: "Top two", children: [] },
    { author: "dead", text: null, children: [] },
  ] };
  const fetchImpl = fakeFetch([json(item)]);
  const meter = {};
  const ctx = await hackernews.context({ id: "hn-1", author: "op" }, { meter, http: { fetchImpl } });
  assert.equal(fetchImpl.calls[0].url.pathname, "/api/v1/items/1");
  assert.equal(ctx.commentCount, 3);
  assert.deepEqual(ctx.topComments.map((c) => c.author), ["a", "b", "c"]);
  assert.equal(ctx.topComments[0].excerpt, "Top one, I use TripIt");
  assert.equal(ctx.appsAlreadySuggested, 1);
  assert.equal(meter.requests, 1);
});

test("stackexchange.context: accepted answer → solved, closed → locked, answers as comments", async () => {
  _resetBackoff();
  const fetchImpl = fakeFetch((u) =>
    u.pathname.endsWith("/answers")
      ? json({ items: [{ owner: { display_name: "Jos&#233;" }, body: "<p>Try MGit</p>", score: 5, is_accepted: true }], quota_remaining: 100 })
      : json({ items: [{ question_id: 42, answer_count: 3, accepted_answer_id: 7, closed_date: 1700000000 }], quota_remaining: 101 })
  );
  const meter = {};
  const ctx = await stackexchange.context({ id: "se-softwarerecs-42", author: "op" }, { meter, http: { fetchImpl } });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url.pathname), ["/2.3/questions/42", "/2.3/questions/42/answers"]);
  assert.equal(fetchImpl.calls[0].url.searchParams.get("site"), "softwarerecs");
  assert.deepEqual([ctx.commentCount, ctx.solved, ctx.locked], [3, true, true]);
  assert.deepEqual(ctx.topComments[0], { author: "José", excerpt: "Try MGit", score: 5 });
  assert.equal(meter.requests, 2, "both calls count against the shared daily quota");
  assert.equal(await stackexchange.context({ id: "se-bad" }, { http: { fetchImpl } }), null);
});

test("bluesky.context: rebuilds the at:// uri, ranks replies by likes", async () => {
  const thread = { thread: { post: { replyCount: 4 }, replies: [
    { post: { author: { handle: "low.bsky.social" }, record: { text: "meh" }, likeCount: 1 } },
    { post: { author: { handle: "top.bsky.social" }, record: { text: "check out gridpeek" }, likeCount: 9 } },
  ] } };
  const fetchImpl = fakeFetch([json(thread)]);
  const ctx = await bluesky.context({ id: "bsky-did:plc:abc123-3kxyz", author: "op" }, { http: { fetchImpl }, appNames: ["gridpeek"] });
  const u = fetchImpl.calls[0].url;
  assert.equal(u.pathname, "/xrpc/app.bsky.feed.getPostThread");
  assert.equal(u.searchParams.get("uri"), "at://did:plc:abc123/app.bsky.feed.post/3kxyz");
  assert.equal(ctx.commentCount, 4);
  assert.deepEqual(ctx.topComments.map((c) => c.author), ["top.bsky.social", "low.bsky.social"]);
  assert.equal(ctx.mentionsYourApp, true);
});

test("youtube.context: comment threads + statistics, counted as `context` (not search quota)", async () => {
  const fetchImpl = fakeFetch((u) =>
    u.pathname.endsWith("/commentThreads")
      ? json({ items: [{ snippet: { totalReplyCount: 0, topLevelComment: { snippet: { authorDisplayName: "Viewer", textOriginal: "I use TripIt for this", likeCount: 12 } } } }] })
      : json({ items: [{ statistics: { commentCount: "57" } }] })
  );
  const meter = {};
  const ctx = await youtube.context({ id: "yt-abc", author: "Channel" }, { env: { YOUTUBE_API_KEY: "k" }, meter, http: { fetchImpl } });
  assert.equal(fetchImpl.calls[0].url.searchParams.get("videoId"), "abc");
  assert.equal(fetchImpl.calls[0].url.searchParams.get("textFormat"), "plainText");
  assert.equal(ctx.commentCount, 57);
  assert.deepEqual(ctx.topComments[0], { author: "Viewer", excerpt: "I use TripIt for this", score: 12 });
  assert.deepEqual(meter, { context: 2 }, "no `requests`, so the 100 searches/day count stays honest");
  assert.equal(youtube.contextUsesQuota, false);
});

test("youtube.context: comments disabled (403) → locked", async () => {
  const ctx = await youtube.context({ id: "yt-abc" }, { env: { YOUTUBE_API_KEY: "k" }, http: { fetchImpl: fakeFetch([json({}, 403)]) } });
  assert.equal(ctx.locked, true);
  assert.equal(ctx.commentCount, 0);
});

test("threads has no context() (Meta only allows reading replies on your own posts)", () => {
  assert.equal(threads.context, undefined);
});

test("x.context: conversation search, billed per post, skipped under X's 10-post minimum", async () => {
  _resetFieldsParam();
  const none = fakeFetch([json({ data: [] })]);
  assert.equal(await x.context({ id: "x-9" }, { env: { X_BEARER_TOKEN: "t" }, budget: { posts: 9 }, http: { fetchImpl: none } }), null);
  assert.equal(none.calls.length, 0);

  const fetchImpl = fakeFetch([json({ data: [{ id: "9", text: "the post itself" }, { id: "10", text: "Try TripIt", public_metrics: { like_count: 3 } }] })]);
  const meter = {};
  const ctx = await x.context({ id: "x-9", engagement: { replies: 6 } }, { env: { X_BEARER_TOKEN: "t" }, budget: { posts: 25 }, meter, http: { fetchImpl } });
  const u = fetchImpl.calls[0].url;
  assert.equal(u.searchParams.get("query"), "conversation_id:9 -is:retweet");
  assert.equal(u.searchParams.get("max_results"), "10");
  assert.equal(ctx.commentCount, 6);
  assert.equal(ctx.topComments.length, 1, "the original post isn't counted as a reply");
  assert.deepEqual(meter, { requests: 1, posts: 2 });
});

test("socialcrawl.context: 5-credit comment page, only with enough budget", async () => {
  const none = fakeFetch([json({})]);
  assert.equal(await socialcrawl.context({ id: "sc-1", url: "https://reddit.com/r/f1/comments/1" }, { env: { SOCIALCRAWL_API_KEY: "k" }, budget: { credits: 4 }, http: { fetchImpl: none } }), null);
  assert.equal(none.calls.length, 0);

  const fetchImpl = fakeFetch([json({ success: true, credits_used: 5, data: { items: [{ comment: { author: { username: "racefan" }, text: "I use TripIt", engagement: { likes: 8 } } }, { comment: { author: null, text: null } }], ext: { post_comment_count: 31 } } })]);
  const meter = {};
  const ctx = await socialcrawl.context({ id: "sc-1", url: "https://reddit.com/r/f1/comments/1" }, { env: { SOCIALCRAWL_API_KEY: "k" }, budget: { credits: 10 }, meter, http: { fetchImpl } });
  assert.equal(fetchImpl.calls[0].url.pathname, "/v1/reddit/post/comments");
  assert.equal(fetchImpl.calls[0].url.searchParams.get("url"), "https://reddit.com/r/f1/comments/1");
  assert.equal(ctx.commentCount, 31);
  assert.deepEqual(ctx.topComments, [{ author: "racefan", excerpt: "I use TripIt", score: 8 }]);
  assert.deepEqual(meter, { requests: 1, credits: 5 });
});
