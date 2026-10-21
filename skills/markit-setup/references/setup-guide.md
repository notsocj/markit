# Getting API keys for marKit

Every key goes into marKit's `.env` file (`/markit-setup` tells you the exact path; usually `~/.config/markit/.env`, or `%APPDATA%\markit\.env` on Windows). Two ways to add one:

- **Dashboard → Settings (easiest):** run `/markit-dashboard`, open **Settings**, paste the key, and press Save. It's written straight into `.env` on your computer (owner-only permissions), tested right away, and never shown again: the page only says "Set". Your AI agent never sees it.
- **Your own editor:** open `.env`, paste the value right after the `=` sign on the matching line, and save. Leave a line empty to turn that source off.

**Check your keys any time with `/markit-usage`:** it shows ✓ / ✗ per source (never the key) plus notes such as a Threads token that's about to expire or is missing a permission.

**Stuck on a platform's screen?** Send your agent a screenshot (without keys on it) and it can tell you which button to press. It can't fill in sign-up forms or accept agreements for you.

**Never paste keys into your AI agent's chat.** When a step below says to run a command that contains a key (Threads), run it in **your own terminal window**, not through the agent.

Checked against each platform's docs on 2026-10-21 (Threads token steps re-checked on a real setup 2026-10-22). Platforms change their menus often; if a step looks different, follow the closest match.

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

Limits: 2,200 searches per rolling 24 hours, shared by all apps using your Threads account (searches with no results don't count; checked on Meta's keyword-search docs 2026-10-22). Tokens last **60 days** and must be refreshed; `/markit-usage` warns you before yours expires, and also says if the token is missing the search permission.

1. Go to https://developers.facebook.com/apps and **Create app**. Don't put "Meta", "Threads", "Facebook" or "Instagram" in the app name. Choose the use case **Access the Threads API**, and "I don't want to connect a business portfolio yet" if asked.
   - If verification says your phone "must be added through Accounts Center first" even though it's there, re-add the number in Accounts Center → Personal details → Contact info, or verify with a card instead.
2. Customize the use case and add the **threads_keyword_search** permission (next to `threads_basic`). Do this **before** generating a token: a token only carries the permissions the app had when it was made. If `/markit-usage` says "token lacks threads_keyword_search", add the permission and generate a new token.
3. **App roles → Roles → Add People → Threads Tester**, and add your own Threads account.
4. Accept the invite in Threads: **Settings → Account → Website permissions** (or https://www.threads.com/settings/account).
5. Get a **long-lived** (60-day) token: open **Use cases → Access the Threads API → Customize → Settings**, scroll to **User Token Generator**, and click **Generate Access Token** next to your account. Approve the permissions and copy the token. It's already long-lived, so no exchange step is needed. (Tokens can only be generated for **public** Threads accounts.)
6. *(Only if you got a short-lived token some other way, e.g. the Graph API Explorer.)* Exchange it for a 60-day one in **your own terminal** (not through your agent). Use the **Threads app secret** from that same Settings page, not the Facebook app secret under App settings → Basic, which gives "Invalid client secret":
   ```
   curl "https://graph.threads.com/access_token?grant_type=th_exchange_token&client_secret=YOUR_THREADS_APP_SECRET&access_token=YOUR_SHORT_TOKEN"
   ```
   Copy the `access_token` value from the reply.
7. `.env`: `THREADS_ACCESS_TOKEN=<long-lived token>`
8. For public search: submit **threads_keyword_search** for **App Review** in the app dashboard, then publish the app once approved (see **App Review** below).

**Refreshing (before 60 days):** in your own terminal, with the current token (it must be at least 24 hours old and not yet expired):
```
curl "https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token&access_token=YOUR_CURRENT_TOKEN"
```
Put the new `access_token` in `.env`.

Finally, add `"threads"` to the app's `sources` (ask `/markit-setup` to edit the app). It isn't on by default. Wait until App Review is approved: before that it only finds your own posts.

### App Review for threads_keyword_search

**How long:** Meta doesn't publish a fixed time. Reports range from **2–7 working days** for a clean submission to **several weeks**, and Meta itself has warned developers to allow up to about 20 days in busy periods. First submissions are often rejected, and each resubmission restarts the clock. Plan for **1–4 weeks**. (Third-party reports, checked 2026-10-22; your dashboard shows the real status.)

**Before you submit:**
- **Make a successful call first.** Meta expects at least one successful API call with each requested permission in the last 30 days. Running `/markit-find` once with `"threads"` in your sources does this (it searches your own posts).
- **Become a Tech Provider** if the dashboard asks (Dashboard → "Become a Tech Provider"). It may also ask for business or access verification.
- **Privacy policy URL.** A simple public page that says what you read (public Threads posts matching your search keywords), that results stay on your own computer, that nothing is shared or sold, and that local data is deleted after 180 days.
- **App icon** (1024×1024) and a **category** under App settings → Basic.

**What to write (use case description), adjust to your app:**
> I'm an indie developer. My app uses `threads_keyword_search` to find recent public Threads posts where people ask for app recommendations or describe a problem my product solves, using a small open-source tool I run on my own computer. It only reads posts; it never posts, replies, likes, or follows. I read each post myself and reply manually from my own account when it genuinely helps. Results are stored only locally and are never shared, sold, or used to train models.

**Screencast** (the most common rejection reason is an unclear one): record your screen showing (1) running the search with your Threads account connected, (2) the results appearing in the report or dashboard, and (3) you opening a post on Threads to reply by hand. Say or caption what each step shows.

## X: Bearer token (paid)

X charges about **$0.005 per post** returned by search (pricing checked 2026-10-21; no free tier). marKit never requests author details (those cost $0.010 each) and stops at your caps:

- `x.maxPostsPerRun` (default 30 → about $0.15 per run)
- `x.maxPostsPerMonth` (default 900 → about $4.50 per month)

1. Go to https://console.x.com and sign up for the Developer Program. It asks for an **Account Name** and to **describe your use cases**. Be accurate, for example:
   > Personal, read-only use for one indie developer. I use the X API v2 recent search endpoint, through a small open-source tool I run on my own computer, to find public posts from the last 7 days where people ask for app recommendations or describe a problem my app solves. The tool never posts, replies, likes, follows, or sends DMs; I reply manually from my own account. Results stay on my computer and are never shared, resold, or used to train models. Usage is capped at about 900 posts per month.
2. Open your app (a "Default Project (Pay Per Use)" app is created for you) and keep its permissions **Read** only.
3. **Keys & Tokens → App-Only Authentication → Bearer Token → Generate.** Copy it right away (it's shown once; regenerate if you lose it). You don't need the Consumer Key, Access Token, or OAuth 2.0 settings: those are for posting or logging in as a user.
4. **Billing → Credits:** add credits (pay-per-use won't return posts without them), and **set a spending limit**. This is your hard safety net on top of marKit's caps.
5. `.env`: `X_BEARER_TOKEN=<bearer token>`
6. Add `"x"` to the app's `sources` (paid sources are never on by default; ask `/markit-setup` to edit the app, or tell your agent "add X to my sources").

X only searches the last 7 days.

## SocialCrawl: API key (paid credits; covers Reddit, and Threads if you want)

The reliable way to find Reddit threads. **1 credit per keyword** per run (cached results are free), so about 5–8 credits per run. New accounts get **100 free credits**, no card needed; packs start at £15 for 2,500 credits, and credits don't expire.

marKit stops at your caps: `socialcrawl.maxCreditsPerRun` (default 50) and `socialcrawl.maxCreditsPerMonth` (default 1,500).

1. Sign up at https://www.socialcrawl.dev
2. Copy your API key from the dashboard (it starts with `sc_`). If the dashboard lets you set a per-key budget, set one.
3. `.env`: `SOCIALCRAWL_API_KEY=sc_...`
4. Add `"socialcrawl"` to the app's `sources` (dashboard → Settings → Sources, ask `/markit-setup` to edit the app, or tell your agent "add SocialCrawl to my sources").

**Threads through SocialCrawl (optional):** SocialCrawl can also search public Threads posts, with **no Meta app, token, or App Review**. Switch it on in dashboard → Settings → Sources → SocialCrawl → "Search Threads", or set `"socialcrawlPlatforms": ["reddit", "threads"]` in the profile. Cost (checked 2026-10-22): 1 credit per keyword for an exact-phrase search; Threads only matches phrases it already knows, so marKit lets SocialCrawl split an unknown phrase into word pairs (up to 5 credits per keyword) **only when at least 5 credits are left** under your caps. Reading a Threads post's replies (thread context, only if `contextForPaidSources` is on) costs 1 credit.

`/markit-usage` shows your remaining credit balance.
