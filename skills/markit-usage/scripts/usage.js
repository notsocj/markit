#!/usr/bin/env node
// usage.js — marKit's status screen (/markit-usage).
//
//   node usage.js               full screen: sources, usage, apps, last run, commands
//   node usage.js --check-only  just the source check table (used at the end of /markit-setup)
//
// Example:
//
//   marKit · October 2026
//
//   Sources
//     ✓ Hacker News       free
//     ✓ Stack Exchange    free      142 / 300 requests today
//     – Bluesky           not set up
//     ✗ YouTube           invalid key → run /markit-setup
//     ✓ X                 paid      210 / 900 posts this month · ~$1.05
//
//   Apps: gridpeek
//   Last run: gridpeek · Oct 21, 9:00 PM · 12 opportunities
//   ...
//
// How the check works: each enabled source's adapter makes one tiny test call (check())
// and answers "ok" | "invalid" | "quota" | "error". Nothing else is shown.
//
// SECURITY: this script loads keys only to hand them to check(). It prints source names
// and ✓ / ✗ / – only: never key values, never partial keys, never error details.
// Usage numbers come from usage.json, i.e. marKit's OWN count of what it did, not the
// platforms' numbers, and the screen says so.

import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadShared } from "./shared.js";

// Shared code from the sibling markit-find folder (exits with a clear message if missing).
const config = await loadShared("lib/config.js");
const usageLib = await loadShared("lib/usage.js");
const { ALL_SOURCES, SOURCE_LABELS } = await loadShared("lib/profile.js");
const { ADAPTERS } = await loadShared("adapters/index.js");

// Every API source, in a fixed order. ("web" is the agent's own search: nothing to check.)
const SOURCES = ALL_SOURCES.filter((name) => name !== "web");

const NAME_WIDTH = 18;
const TIER_WIDTH = 10;

/**
 * Run check() for every enabled source, in parallel.
 * @returns {Promise<Record<string, "ok"|"invalid"|"quota"|"error">>}
 */
export async function runChecks(adapters, env, { http } = {}) {
  const enabled = adapters.filter((a) => a.isEnabled(env));
  const results = await Promise.all(
    enabled.map(async (adapter) => {
      try {
        // Short timeout and no retries: this is a quick health check, not a search.
        return [adapter.name, await adapter.check(env, { http: { timeoutMs: 8000, retries: 0, ...http } })];
      } catch (err) {
        // check() should never throw, but if one does, show it as unreachable. We never
        // print the error itself (it could contain anything).
        return [adapter.name, "error"];
      }
    })
  );
  return Object.fromEntries(results);
}

/** Text after the tier column, e.g. "142 / 300 requests today". */
function usageText(adapter, { env, settings, usage, now }) {
  const parts = [];

  // Free quotas declared by the adapter (e.g. Stack Exchange's daily request quota).
  const q = adapter.quota;
  if (q) {
    const limit = q.keyEnv && env[q.keyEnv] ? q.limitWithKey ?? q.limit : q.limit;
    let used;
    let label;
    if (q.period === "day") {
      used = usageLib.getDayUsage(adapter.name, usage, now)[q.unit];
      label = "today";
    } else if (q.period === "rolling7") {
      used = usageLib.getRollingUsage(adapter.name, usage, 7, now)[q.unit];
      label = "(rolling 7 days)";
    } else {
      used = usageLib.getMonthUsage(adapter.name, usage, now)[q.unit];
      label = "this month";
    }
    parts.push(`${used} / ${limit.toLocaleString("en-US")} ${q.label ?? q.unit} ${label}${used >= limit * 0.8 ? " · near limit" : ""}`);
  }

  // Paid sources: this month's spend against the monthly cap in settings.json.
  if (adapter.paid) {
    const unit = adapter.costUnit ?? "posts";
    const Unit = unit === "credits" ? "Credits" : "Posts";
    const cap = settings[adapter.name]?.[`max${Unit}PerMonth`];
    const used = usageLib.getMonthUsage(adapter.name, usage, now)[unit];
    let text = Number.isFinite(cap) ? `${used} / ${cap} ${unit} this month` : `${used} ${unit} this month`;
    // costPerUnit is an ESTIMATE in USD, from the platform's published pricing.
    if (typeof adapter.costPerUnit === "number") text += ` · ~$${(used * adapter.costPerUnit).toFixed(2)}`;
    if (Number.isFinite(cap) && used >= cap * 0.8) text += " · near cap";
    parts.push(text);
  }
  return parts;
}

/** One row of the Sources table. */
async function sourceRow(name, { adapters, env, checks, settings, usage, now, full, http }) {
  const label = (SOURCE_LABELS[name] ?? name).padEnd(NAME_WIDTH);
  const adapter = adapters.find((a) => a.name === name);
  if (!adapter) return `  – ${label}not available yet`;
  const tier = (adapter.paid ? "paid" : "free").padEnd(TIER_WIDTH);
  if (!adapter.isEnabled(env)) return `  – ${label}not set up`;

  const result = checks[name];
  if (result === "invalid") return `  ✗ ${label}invalid key → run /markit-setup`;
  if (result === "quota") return `  ✗ ${label}quota used up${adapter.paid ? " (check your plan or spending limit)" : " (try again tomorrow)"}`;
  if (result === "error") return `  ✗ ${label}unreachable (network problem or outage; try again later)`;

  const parts = full ? usageText(adapter, { env, settings, usage, now }) : [];
  // Optional adapter hook for extra facts, e.g. Threads: "token expires in 12 days".
  if (full && typeof adapter.notes === "function") {
    try {
      parts.push(...(await adapter.notes(env, { http })));
    } catch {
      // A failing note never breaks the screen.
    }
  }
  return `  ✓ ${label}${parts.length ? tier + parts.join(" · ") : tier.trimEnd()}`;
}

/** "Oct 21, 9:00 PM" in local time. */
function shortDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
  return `${date}, ${time}`;
}

export const COMMANDS = [
  "Commands",
  "  /markit-setup   add apps, keys, or sources",
  "  /markit-find    find opportunities and draft replies",
  "  /markit-usage   this screen",
].join("\n");

/**
 * Build the screen text. No file writes; network only through check()/notes().
 *
 * @param {object} args
 * @param {boolean} [args.full=true] - false for --check-only
 */
export async function buildScreen({ adapters = ADAPTERS, env, checks, settings, usage, apps = [], now = new Date(), full = true, http }) {
  const rows = [];
  for (const name of SOURCES) rows.push(await sourceRow(name, { adapters, env, checks, settings, usage, now, full, http }));

  if (!full) return ["Sources", ...rows].join("\n");

  const month = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(now);
  const lastRun = usage.lastRun
    ? `${usage.lastRun.app} · ${shortDateTime(usage.lastRun.ranAt)} · ${usage.lastRun.opportunities} ${usage.lastRun.opportunities === 1 ? "opportunity" : "opportunities"}`
    : "none yet";

  return [
    `marKit · ${month}`,
    "",
    "Sources",
    ...rows,
    "  (usage numbers are marKit's own count, not the platforms')",
    "",
    `Apps: ${apps.length ? apps.join(", ") : "none yet → run /markit-setup"}`,
    `Last run: ${lastRun}`,
    "",
    COMMANDS,
  ].join("\n");
}

async function main() {
  const { values } = parseArgs({ options: { "check-only": { type: "boolean", default: false } } });
  const paths = config.getPaths();

  if (!config.isSetUp(paths)) {
    console.log(["marKit isn't set up yet. Run /markit-setup to start.", "", COMMANDS].join("\n"));
    return;
  }

  const env = config.loadEnv(paths.envFile);
  const checks = await runChecks(ADAPTERS, env);

  // Each check made one real API call. Record it when it counts against a quota marKit
  // shows (e.g. Stack Exchange's 300/day). Adapters whose check uses a different, unshown
  // allowance set checkUsesQuota: false (e.g. YouTube's check doesn't touch search quota).
  const now = new Date();
  for (const name of Object.keys(checks)) {
    const adapter = ADAPTERS.find((a) => a.name === name);
    if (adapter?.checkUsesQuota !== false) usageLib.recordUsage(name, { requests: 1 }, paths.usageFile, now);
  }

  console.log(
    await buildScreen({
      env,
      checks,
      settings: config.loadSettings(paths),
      usage: usageLib.loadUsage(paths.usageFile),
      apps: config.listApps(paths),
      now,
      full: !values["check-only"],
    })
  );
}

// Run main() only when executed directly, not when imported by tests.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (runDirectly) {
  main().catch((err) => {
    const safe = err.message?.startsWith("marKit:") || String(err.code).startsWith("ERR_PARSE_ARGS");
    console.error(safe ? err.message.replace(/^(?!marKit:)/, "marKit: ") : `marKit: unexpected error (${err.name})`);
    process.exitCode = 1;
  });
}
