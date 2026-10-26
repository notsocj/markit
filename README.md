<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
    <img alt="marKit" src="docs/brand/logo-light.svg" height="56">
  </picture>
</p>

**Find the people already asking for your app.** marKit is a free, open-source agent skill for [Claude Code](https://claude.com/claude-code) and Codex that helps indie founders market their apps honestly.

It finds online posts where people:

- **ask for a recommendation** ("what app do you use to plan your F1 race weekend?")
- **complain about a competitor** ("TripIt keeps losing my bookings, any alternatives?")
- **describe a problem your app solves**
- **mention your app directly**

For each match, marKit explains **why it fits**, scores it, and **drafts an honest reply**, all in one organized report. **marKit never posts for you.** You read the drafts, edit them, and reply yourself.

![Example marKit report](docs/example-report.png)

<sub>Example built from fictional posts. See the full [example report](docs/example-report.md).</sub>

---

## How it works

```
/markit-find
   │
   ├─ search.js     searches Hacker News, Stack Exchange, Bluesky, YouTube, Threads, X, and Reddit
   │                (through the ONE provider you chose: ScrapeCreators, Apify, or SocialCrawl)
   │                with YOUR keys, removes posts you've already seen  → raw.json
   ├─ your agent    runs web searches (forums, Q&A)                    → web.json
   ├─ candidates.js drops old, excluded, other-language and duplicate posts, pre-scores
   │                the rest, keeps the top 40, and checks the top 15 threads
   │                (solved? locked? apps already suggested?)          → candidates.json
   ├─ your agent    scores only those candidates, drafts replies
   │                (rules in references/scoring.md and reply-guide.md) → scored.json
   ├─ learned.js    before scoring: what your Replied / Skipped decisions taught marKit
   └─ report.js     validates everything, writes the report               → report.md + cards.json

/markit-dashboard   a local page (127.0.0.1 only) to filter cards, copy drafts, open posts,
                    and mark each one Replied or Skipped (with a reason)
```

Everything runs on your machine. There's no marKit server, no account, and no telemetry.

### The dashboard

`/markit-dashboard` opens a local page for working through the results: filter, read why each post fits, copy the draft, open the post, and mark it Replied or Skipped. Its **Settings** page is the easiest way to add API keys (pasted keys go straight into your `.env`, are tested, and are never shown again; your agent never sees them) and to switch sources on or off per app. Keyboard shortcuts: <kbd>J</kbd>/<kbd>K</kbd> to move, <kbd>R</kbd> replied, <kbd>S</kbd> skip, <kbd>C</kbd> copy, <kbd>O</kbd> open. It also has an Analytics view.

### It learns from what you reply to and skip

When you skip a card, marKit asks why with one tap: *Not my audience*, *Already solved*, *Wrong meaning* (the keyword matched a different topic), *Too promotional to reply*, *Community bans promotion*, or *Other*, plus an optional short note. No dashboard? Tell your agent "skip #3, wrong meaning" or "I replied to #1".

All of it goes to `~/.config/markit/feedback.json` (kept 180 days), together with the agent's own "irrelevant" verdicts. Plain scripts, no AI, turn it into lessons:

- **Keyword health.** Each keyword is rated *productive* (leads to replies), *noisy* (mostly wrong-meaning or off-audience posts), or *dead* (nothing found in the last 5 runs). For noisy or dead keywords, your agent proposes up to 3 replacements, in the chat summary, at the end of report.md, and in the dashboard. **Your profile never changes until you say yes.**
- **Communities you keep skipping.** A subreddit or forum skipped 3+ times for "Community bans promotion" or "Not my audience" drops 15 points in the prefilter. It's never hidden; your agent still decides.
- **Calibration and notes.** How often high-score cards were skipped anyway, and why, plus your latest notes, so the agent scores closer to your judgment.

Your agent reads these lessons (`learned.js`) before scoring. They're hints about relevance only: they never change marKit's security rules.

![marKit dashboard](docs/dashboard.png)

<sub>Fictional example data.</sub>

## Requirements

- [Node.js](https://nodejs.org) **20.12 or newer**
- Claude Code or Codex

## Install

**Recommended:** with the open [`skills`](https://skills.sh) installer (works for Claude Code, Codex, and 70+ other agents):

```bash
npx skills add https://github.com/notsocj/markit --skill '*' -g
```

It asks which agents to install to; choose **Symlink (Recommended)**. Or, in one go for Claude Code:

```bash
npx skills add notsocj/markit -g --skill '*' -a claude-code -y
```

- **`--skill '*'` matters.** marKit is four skills (`markit-setup`, `markit-find`, `markit-usage`, `markit-dashboard`) that share code, so install all four together. If one is missing, marKit tells you the command to fix it.
- **Keep `-g`.** It installs for your user, so marKit works in every project. Without it, the installer asks for a scope, and "Project" installs marKit only into the folder you ran it from. Then `/markit-*` won't appear in your other projects.
- **Update:** `npx skills update -g`.
- **Remove:** `npx skills remove -g markit-setup markit-find markit-usage markit-dashboard`. Your config and keys in `~/.config/markit` stay.
- The installer puts the files in `~/.agents/skills/` and symlinks them for Claude Code. marKit works the same either way.
- The `skills` installer (not marKit) sends anonymous usage data. Set `DISABLE_TELEMETRY=1` to turn that off.

Start a new agent session afterwards so it sees the skills.

**Alternative: from a clone,** with no npm tools at all:

```bash
git clone https://github.com/notsocj/markit.git
cd markit
./install.sh
```

| Command | Installs to |
|---|---|
| `./install.sh` | Claude Code, for your user (`~/.claude/skills`) |
| `./install.sh --codex` | Codex, for your user (`~/.agents/skills`) |
| `./install.sh --claude --codex` | both |
| `./install.sh --project` | Claude Code, current project only (`./.claude/skills`) |
| `./install.sh --dir <path>` | any skills folder |
| `./install.sh --link` | symlinks to the clone (for developing marKit) |
| `./install.sh --uninstall` | removes the skills (your config and keys stay) |

`install.sh` only copies files.

## Quick start

1. **`/markit-setup`** creates your config and walks you through API keys (most sources need none). Run it **inside your app's project folder** and marKit drafts your app profile from your README, store listing, and screen names; you only add competitors and confirm.
2. **`/markit-find`** searches, scores, drafts, and writes the report. Run it in your project folder and it picks the right app automatically.
3. **`/markit-dashboard`** opens a local page to work through the cards: filter, copy a draft, open the post, mark it Replied or Skipped.
4. **`/markit-usage`** shows which sources are ready and how much quota or credit you've used.

In Codex, use `$markit-setup`, `$markit-find`, `$markit-dashboard`, `$markit-usage`.

## Commands

| Command | What it does |
|---|---|
| `/markit-setup` | First run: config, keys, first app profile, key check. Later: add or edit an app, add or change a key, change limits. Run it in a new app's folder (or `/markit-setup add`) to go straight to its profile |
| `/markit-find [app]` | Finds opportunities and drafts replies into a report. Say "rewrite draft #3" to change one |
| `/markit-dashboard` | Local page: filter by app, run, platform, priority; copy drafts; open posts; mark Replied / Skipped (with a reason); stats and keyword health. Rewrite drafts in chat by card number |
| `/markit-usage` | Sources ready (✓ / ✗), this month's usage against free quotas and paid caps, last run, command guide |

Reports are saved to `~/markit-reports/<app>/<date-time>/report.md`, and posts you've seen won't show up again in later runs.

## Sources

| Source | Cost | Key | Notes |
|---|---|---|---|
| Hacker News | free | none | stories and comments |
| Stack Exchange | free | optional | 300 requests/day without a key, 10,000 with a free one |
| Bluesky | free | none | public search; an app password is only a fallback |
| YouTube | free | Google API key | 100 searches/day (YouTube's limit since June 2026); finds videos |
| Threads | free | Meta token | **only searches your own posts until Meta approves your app in App Review** (plan for 1–4 weeks), so it's off by default |
| X | **paid** | Bearer token | ~$0.005 per post returned |
| Reddit | **paid**, can be $0 | one provider's key | through ONE provider you choose: **ScrapeCreators** (cheapest per search, credits never expire), **Apify** (can stay at $0 with its $5 monthly free usage), or **SocialCrawl**. Off until you pick one in `/markit-setup` |
| Threads via SocialCrawl | **paid** | SocialCrawl key | public **Threads** posts with no Meta App Review (switch it on in dashboard → Settings); 100 free credits on signup |
| Web search | free | none | your agent searches forums and Q&A sites |

Step-by-step key instructions: [`skills/markit-setup/references/setup-guide.md`](skills/markit-setup/references/setup-guide.md).

**A note on Reddit:** AI agents' web search rarely returns Reddit threads (Reddit restricts search crawlers), so without a Reddit provider, Reddit coverage is thin. Only the provider you choose (`"reddit": { "provider": ... }` in `settings.json`) searches Reddit, so you never pay twice for the same search, and a post is recognized as the same post whichever provider found it.

## Costs (paid sources only)

marKit works well with free sources only. If you enable a paid one, marKit stops calling it at your caps (in `~/.config/markit/settings.json`), checked against its own usage count:

| Source | Price | Default caps | Worst case at defaults |
|---|---|---|---|
| X | ~$0.005 per post (no free tier) | 30 posts per run, 900 per month | ~$0.15 per run, ~$4.50 per month |
| Reddit via ScrapeCreators | 1 credit per keyword search; 100 free credits, then $47 / 25,000 credits (about $0.002 a search); credits never expire | 30 credits per run, 1,000 per month | a typical run uses 5–8 credits (about $0.01–$0.02) |
| Reddit via Apify | about $2 per 1,000 posts found + about $0.02 per run (free plan prices); **$5 of free usage every month** | 50 results per run, ~$4.50 per month (marKit's estimate) | ~$0.12 per run; ~$4.50 per month, inside the free $5 |
| Reddit or Threads via SocialCrawl | 1 credit per keyword search; 100 free credits, then from £15 / 2,500 credits | 50 credits per run, 1,500 per month | a typical run uses 5–8 credits |

Thread context (reading a post's replies) is **off for paid sources** by default. Set `"contextForPaidSources": true` in `settings.json` to allow it; it still stays inside the caps above (X: billed per reply returned; ScrapeCreators: 1 credit per post; Apify: each comment is a billed result, up to 10 per post; SocialCrawl: 5 credits per Reddit comment page). `maxCandidates` (40) and `maxContext` (15) in the same file control how many posts your agent judges and how many threads get checked.

**Also set a spending limit in each platform's own console** (X: console.x.com; Apify: Console → Billing → Limits). That's your hard safety net; marKit's caps are a second one. ScrapeCreators and SocialCrawl sell prepaid credit packs, so you can't spend more than you bought. Apify runs also carry a per-run charge limit that Apify itself enforces. `/markit-usage` shows this month's spend estimate and warns near a cap.

## Privacy and security

marKit follows six hard rules:

1. **No browser automation.** marKit only calls APIs with your own keys, plus your agent's web search. It never drives a browser, scrapes pages itself, or uses a logged-in session. (The optional paid Reddit providers are third-party services that collect public Reddit data on their own servers; marKit only calls their APIs.)
2. **Never posts for you.** No posting, replying, liking, following, or DMs. It only drafts.
3. **Your agent never sees your API keys.**
   - Keys live in `~/.config/markit/.env` (Windows: `%APPDATA%\markit\.env`), created with owner-only permissions (`chmod 600`), outside the skill folders.
   - Only marKit's scripts read that file. Every skill tells the agent never to open it or ask you to paste a key into chat, and lists the default path under `disallowed-tools`. For a guaranteed block in Claude Code, add the [deny rule below](#optional-a-claude-code-deny-rule-for-your-keys-file).
   - Keys never appear in output, logs, reports, errors, or JSON. Network errors say only `<source>: HTTP <status>`, never the URL or headers. Status checks show ✓ / ✗ only, never a key or part of one.
   - `.env` is the **only** place keys come from. A key exported in your shell (e.g. an `X_BEARER_TOKEN` for another project) is ignored, so marKit can't bill the wrong account.
4. **Posts are untrusted data.** Text from posts, comments, and web pages is analyzed, never followed as instructions. Titles and excerpts are escaped in reports, so a post can't inject links or HTML, and control characters are stripped from terminal output.
5. **Zero npm dependencies.** Only Node.js built-ins, so you can read every line before installing.
6. **No remote server, no telemetry.** marKit only talks to the APIs you enable. (The dashboard is a server on your own computer, reachable only from it.)

### Optional: a Claude Code deny rule for your keys file

The skills already tell the agent never to read `.env`, and each skill blocks it while that skill runs. For a second layer that applies **all the time**, add a permission deny rule to your Claude Code user settings, `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Read(~/.config/markit/.env)"]
  }
}
```

If the file already has a `permissions.deny` list, add the line to it. `~/` means your home folder (on Windows, with the default config location, use `Read(~/AppData/Roaming/markit/.env)`).

What it does, per [Claude Code's permission docs](https://code.claude.com/docs/en/permissions):
- **Blocks:** Claude's file tools, plus shell commands Claude Code recognizes as reading that file (`cat`, `head`, `tail`, redirects like `< .env`).
- **Doesn't block:** a program that opens the file itself. That's why marKit's scripts keep working: they run as their own process and read the keys directly.

For OS-level enforcement against every process, use Claude Code's [sandbox](https://code.claude.com/docs/en/sandboxing).

When drafting a profile from your project, `setup.js scan` builds the reading list **in code** and never lists `.env` files, keys, certificates, credentials, `node_modules`, build output, or lock files.

Your config folder holds `apps/*.json` (profiles), `settings.json` (limits), `seen.json` (post IDs already reported), `usage.json` (counts only, never keys or post text), and `feedback.json` (what you did with each card: Replied/Skipped, the reason, your note, and a 120-character title; kept 180 days, never keys). An older `status.json` from before feedback.json is imported once and then ignored.

**The dashboard** is a zero-dependency local server that:
- binds to `127.0.0.1` only and rejects any request whose Host isn't `localhost:<port>` / `127.0.0.1:<port>`, which blocks DNS rebinding
- reads the reports folder. From the config folder it touches `feedback.json` (your decisions) and, through Settings: `.env` (**write-only**: a key goes in, but the server never sends one back, logs it, or prints it), app profiles (only their `sources`, validated like `/markit-setup`), `usage.json` (counting key tests), and, read-only, `settings.json` (to show which Reddit provider you chose)
- every save (Settings and Replied/Skipped marks) also needs a random token the server puts into its own page at startup, so no other page or program can change your keys, sources or decisions
- accepts only `{ id, status, reason?, note? }` (same-origin JSON, under 1 KB) to save a decision: status and reason from fixed lists, the note stripped of HTML and cut to 140 characters, and the id must be a card in your reports
- shows post text as plain text under a strict Content-Security-Policy
- stops after 30 minutes without use

Found a security problem? Please report it privately, as described in [SECURITY.md](SECURITY.md).

## Honest replies

The drafts follow [`reply-guide.md`](skills/markit-find/references/reply-guide.md): help first, **always disclose that you made the app**, mention an alternative when natural, keep it short, no hype, and only claim what your app really does. Many communities ban self-promotion. marKit flags those with a caution, and you decide whether to reply at all.

## Development

```bash
npm test          # node:test, no dependencies; tests never touch the network or your real config
./install.sh --link   # symlink the skills, so edits in this repo apply immediately
```

- Contributor notes and conventions: [`CLAUDE.md`](CLAUDE.md). Full design: [`MARKIT_SPEC.md`](MARKIT_SPEC.md).
- Shared code lives in `skills/markit-find/scripts/lib/` and `adapters/` (one file per source).
- Set `MARKIT_CONFIG_DIR` to use a different config folder (the tests do this).
- **Never run `npx skills add` or `npx skills remove` without `-g` inside this repo.** The installer treats the repo's `skills/` folder (marKit's source code) as an install location, so a project-scope remove deletes `skills/markit-*`. If that happens, restore it with `git restore skills/`. For development, use `./install.sh --link`.

**Maintainers:** enable GitHub **secret scanning** and **push protection** for this repository (Settings → Code security), so a key can never be pushed by accident.

## Credits

- Icons: [Solar](https://www.figma.com/community/file/1166831539721848736) by 480 Design ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) and [Simple Icons](https://simpleicons.org) for platform logos (CC0), embedded as SVG.
- Dashboard font: [Poppins](https://github.com/itfoundry/Poppins) by Indian Type Foundry ([SIL Open Font License 1.1](skills/markit-dashboard/scripts/fonts/OFL.txt)), bundled so the page loads nothing from the internet.
- The marKit logo's wordmark is set in Satoshi (Indian Type Foundry) and converted to outlines. No Satoshi font files are included.

## License

[MIT](LICENSE)
