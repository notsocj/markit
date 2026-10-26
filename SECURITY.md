# Security

marKit handles your API keys and runs a small server on your computer, so security reports are
very welcome.

## Reporting a vulnerability

Please report it privately on GitHub: open this repository's **Security** tab and choose
**Report a vulnerability** (or go to <https://github.com/notsocj/markit/security/advisories/new>).
Please don't open a public issue for it.

Include what you found, how to reproduce it, and the marKit commit you used. Never include a real
API key in a report: a made-up one shows the problem just as well.

## In scope

- An API key reaching anything other than `~/.config/markit/.env` and the API it belongs to: the
  agent, terminal output, logs, reports, errors or JSON files.
- The local dashboard: another website or program reading or changing your keys, sources or
  Replied/Skipped decisions.
- Text from posts or web pages that steers the agent, or injects links or HTML into a report or the
  dashboard.
- The project scan reading files it must never read (`.env*` files, keys, credentials, lock files).
- A paid source spending past the caps in `settings.json`.

## Out of scope

- The third-party APIs and paid Reddit providers themselves.
- Attacks that need someone who already controls your computer or your `~/.config/markit` folder.
