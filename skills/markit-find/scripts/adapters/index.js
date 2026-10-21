// index.js — the list of every script-based source marKit can search.
//
// search.js runs adapter.search() for each enabled source; usage.js runs adapter.check().
// To add a source: write adapters/<name>.js with the shared shape (see hackernews.js),
// then add it here. ("web" isn't listed: it's the agent's own web search, not a script.)

import hackernews from "./hackernews.js";
import stackexchange from "./stackexchange.js";
import bluesky from "./bluesky.js";
import youtube from "./youtube.js";
import threads from "./threads.js";
import x from "./x.js";
import socialcrawl from "./socialcrawl.js";
import scrapecreators from "./scrapecreators.js";
import apify from "./apify.js";

// The last three are Reddit providers (lib/reddit.js): settings.json picks which one searches
// the "reddit" source. SocialCrawl also serves the "socialcrawl" source (Threads).
export const ADAPTERS = [hackernews, stackexchange, bluesky, youtube, threads, x, socialcrawl, scrapecreators, apify];
