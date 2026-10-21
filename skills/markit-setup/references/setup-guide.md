# Getting API keys for marKit

Every key goes into marKit's `.env` file (`/markit-setup` tells you the exact path; usually `~/.config/markit/.env`, or `%APPDATA%\markit\.env` on Windows). Open it in **your own editor**, paste the value right after the `=` sign on the matching line, and save. Leave a line empty to turn that source off.

**Never paste keys into your AI agent's chat.** When a step below says to run a command that contains a key (Threads), run it in **your own terminal window**, not through the agent.

Checked against each platform's docs on 2026-10-21. Platforms change their menus often; if a step looks different, follow the closest match.

| Source | Cost | Key | What it finds |
|---|---|---|---|
| Hacker News | free | none | stories and comments |
| Stack Exchange | free | optional | questions (e.g. softwarerecs, travel) |
| Bluesky | free | none (optional login) | public posts |
| YouTube | free (100 searches/day) | Google API key | videos (reply = comment) |
| Threads | free | Meta token + **App Review** | public posts, only after Meta approves your app |
| X | **paid**, ~$0.005 per post | Bearer token | posts (last 7 days) |
| SocialCrawl | **paid** credits (100 free) | API key | **Reddit** posts |
| Web search | free | none | forums, Q&A (your agent runs it) |

---

## Hacker News: no key

Searched through Algolia's free HN Search API.

## Web search: no key

Your agent runs the searches itself. Agents' web search rarely returns Reddit threads; for reliable Reddit coverage use SocialCrawl (below).

## Stack Exchange: optional key

Works without a key at 300 requests per day. A free key raises that to 10,000 per day. A run uses about one request per keyword per site (up to 3 sites), so most people never need one.

1. Log in to any Stack Exchange site (e.g. stackoverflow.com).
2. Go to https://stackapps.com/apps/oauth/register
3. Fill in **Application Name** (e.g. "marKit for me"), **Description** ("Personal search tool"), **OAuth Domain** `localhost`, and **Application Website** (any page of yours). Leave "Enable Client Side OAuth Flow" unchecked.
4. Submit. You'll see a Client Id, a Client Secret, and a **Key**. marKit only needs the **Key**.
5. `.env`: `STACKEXCHANGE_KEY=<your key>`

## Bluesky: no key needed

Bluesky's public search works without logging in, so marKit searches it automatically.

**Optional fallback login:** some Bluesky servers may require a login for search. If `/markit-usage` ever shows Bluesky as failing, add a login. Use an **app password**, never your main password:

1. In the Bluesky app: **Settings → Privacy and security → App passwords → Add App Password**.
2. Name it "marKit". Don't allow access to direct messages.
3. Copy the password (it looks like `abcd-efgh-ijkl-mnop`). You can't see it again later.
4. `.env`:
   ```
   BLUESKY_HANDLE=yourname.bsky.social
   BLUESKY_APP_PASSWORD=abcd-efgh-ijkl-mnop
   ```

marKit only logs in when public search is refused, at most once per run, and never stores the session.

## YouTube: Google API key (free)

YouTube's search allows **100 searches per day** for free (since June 2026, search has its own daily quota). marKit uses one per keyword, so about 5–8 per run. It resets at midnight Pacific time.

1. Go to https://console.cloud.google.com and create a project (e.g. "marKit").
2. **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Click the new key. Under **API restrictions** choose **Restrict key**, select **YouTube Data API v3**, and **Save**. (Least privilege: the key can't be used for anything else.)
5. `.env`: `YOUTUBE_API_KEY=<your key>`

No billing account is needed for the free quota.

## Threads: Meta access token (free, but read this first)

> **Important:** until Meta approves your app for the `threads_keyword_search` permission in **App Review**, Threads search only returns **your own posts**, not anyone else's. That makes it useless for marKit until your app is approved and published. If you don't want to go through App Review, skip Threads.

Limits: 2,200 searches per rolling 24 hours (searches with no results don't count). Tokens last **60 days** and must be refreshed; `/markit-usage` warns you before yours expires.

1. Go to https://developers.facebook.com/apps and **Create app**. Choose the use case **Access the Threads API**.
2. Customize the use case and add the **threads_keyword_search** permission (next to `threads_basic`).
3. **App roles → Roles → Add People → Threads Tester**, and add your own Threads account.
4. Accept the invite in Threads: **Settings → Account → Website permissions** (or https://www.threads.com/settings/account).
5. Get a token with `threads_basic` and `threads_keyword_search`. The quickest way while testing is the **Graph API Explorer** (switch it to Threads and generate a Threads access token). If that option isn't there, use the OAuth steps in Meta's Threads "Get started" docs.
6. Exchange it for a **long-lived** (60-day) token. In **your own terminal** (not through your agent), replace the two placeholders and run:
   ```
   curl "https://graph.threads.com/access_token?grant_type=th_exchange_token&client_secret=YOUR_THREADS_APP_SECRET&access_token=YOUR_SHORT_TOKEN"
   ```
   Copy the `access_token` value from the reply. (The Threads app secret is under the app's Settings; Threads apps have their own ID and secret.)
7. `.env`: `THREADS_ACCESS_TOKEN=<long-lived token>`
8. For public search: submit **threads_keyword_search** for **App Review** in the app dashboard, then publish the app once approved.

**Refreshing (before 60 days):** in your own terminal, with the current token (it must be at least 24 hours old and not yet expired):
```
curl "https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token&access_token=YOUR_CURRENT_TOKEN"
```
Put the new `access_token` in `.env`.

Finally, add `"threads"` to the app's `sources` (ask `/markit-setup` to edit the app). It isn't on by default.

## X: Bearer token (paid)

X charges about **$0.005 per post** returned by search (pricing checked 2026-10-21; no free tier). marKit never requests author details (those cost $0.010 each) and stops at your caps:

- `x.maxPostsPerRun` (default 30 → about $0.15 per run)
- `x.maxPostsPerMonth` (default 900 → about $4.50 per month)

1. Go to https://console.x.com and create a project and app.
2. Set the app to **Read** only (least privilege).
3. Under **Keys and tokens**, generate the **Bearer Token** (app-only).
4. Add credits, and **set a spending limit** for the billing cycle in the console. This is your hard safety net on top of marKit's caps.
5. `.env`: `X_BEARER_TOKEN=<bearer token>`
6. Add `"x"` to the app's `sources` (paid sources are never on by default).

X only searches the last 7 days.

## SocialCrawl: API key (paid credits; covers Reddit)

The reliable way to find Reddit threads. **1 credit per keyword** per run (cached results are free), so about 5–8 credits per run. New accounts get **100 free credits**, no card needed; packs start at £15 for 2,500 credits, and credits don't expire.

marKit stops at your caps: `socialcrawl.maxCreditsPerRun` (default 50) and `socialcrawl.maxCreditsPerMonth` (default 1,500).

1. Sign up at https://www.socialcrawl.dev
2. Copy your API key from the dashboard (it starts with `sc_`). If the dashboard lets you set a per-key budget, set one.
3. `.env`: `SOCIALCRAWL_API_KEY=sc_...`
4. Add `"socialcrawl"` to the app's `sources`.

`/markit-usage` shows your remaining credit balance.
