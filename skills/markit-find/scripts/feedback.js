#!/usr/bin/env node
// feedback.js — record what you did with a card, from chat (no dashboard needed).
//
//   node feedback.js <run-folder> --card <n> --status replied|skipped|open
//                    [--reason <reason>] [--note "<text>"]
//   node feedback.js --app <name> --card <n> ...     same, using that app's latest run
//
// So when you tell your agent "skip #3, wrong meaning", it runs:
//   node feedback.js ~/markit-reports/gridpeek/2026-10-22-0900 --card 3 --status skipped --reason "wrong meaning"
//
// Reasons (for skipped only; codes or the labels both work):
//   not_my_audience · already_solved · wrong_meaning · too_promotional · bans_promotion · other
// "open" clears your decision (back to To do).
//
// The card is looked up by its number in that run's cards.json (the same numbers as
// report.md and the dashboard). The decision goes to feedback.json, the same file the
// dashboard writes, so both always agree.
//
// SECURITY: never reads .env. The note is stripped of HTML and cut to 140 characters.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { getPaths, loadSettings, validateAppName } from "./lib/config.js";
import { readJsonFile } from "./lib/files.js";
import { recordDecision, normalizeReason, validateDecision, SKIP_REASONS, REASON_LABELS } from "./lib/feedback.js";

const RUN_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}(-\d{1,3})?$/;

/** The newest run folder of an app that has a cards.json ("" if none). */
export function latestRunDir(reportsDir, app) {
  const dir = path.join(reportsDir, validateAppName(app));
  if (!existsSync(dir)) return "";
  const run = readdirSync(dir).filter((n) => RUN_NAME.test(n) && existsSync(path.join(dir, n, "cards.json"))).sort().pop();
  return run ? path.join(dir, run) : "";
}

/**
 * Check the arguments and find the card. Pure apart from reading cards.json.
 *
 * @returns {{ card, app, status, reason, note }}
 * @throws {Error} a "marKit: ..." message that's safe to show
 */
export function prepareDecision({ runDir, card: cardArg, status, reason: reasonArg, note }) {
  const cards = readJsonFile(path.join(runDir, "cards.json"), null);
  if (!cards || !Array.isArray(cards.cards)) throw new Error(`marKit: no cards.json in ${runDir}. Run report.js for that run first.`);

  const number = Number(cardArg);
  if (!Number.isInteger(number) || number < 1) throw new Error("marKit: --card must be a card number like 3 (as in report.md).");
  const card = cards.cards.find((c) => c.number === number);
  if (!card) throw new Error(`marKit: there's no card #${number} in this run (it has ${cards.cards.length}).`);

  const reason = normalizeReason(reasonArg);
  if (reason === null) {
    throw new Error(`marKit: unknown reason "${String(reasonArg).slice(0, 40)}". Use one of: ${Object.entries(SKIP_REASONS).map(([code, label]) => `${code} (${label})`).join(", ")}.`);
  }
  const check = validateDecision({ status, reason, note });
  if (!check.ok) throw new Error(`marKit: ${check.error}.`);
  return { card, app: cards.app, status: check.status, reason: check.reason, note: check.note };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      app: { type: "string" },
      card: { type: "string" },
      status: { type: "string" },
      reason: { type: "string" },
      note: { type: "string" },
    },
  });
  const paths = getPaths();
  let runDir = positionals[0] ? path.resolve(positionals[0]) : "";
  if (!runDir && values.app) runDir = latestRunDir(loadSettings(paths).reportsDir, values.app);
  if (!runDir) throw new Error("marKit: usage: node feedback.js <run-folder> --card <n> --status replied|skipped|open [--reason <reason>] [--note \"<text>\"]  (or --app <name> for its latest run)");

  const d = prepareDecision({ runDir, ...values });
  const saved = recordDecision(paths.feedbackFile, { ...d, legacyStatusFile: paths.statusFile });

  // Safe to print: a number, the status, and a fixed label (no post text).
  const why = saved.reason ? ` (${REASON_LABELS[saved.reason]})` : "";
  console.log(saved.status === "open" ? `marKit: card #${d.card.number} is back to To do.` : `marKit: card #${d.card.number} marked ${saved.status}${why}${saved.note ? ", with your note" : ""}.`);
}

// Run main() only when executed directly, not when imported by tests.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (runDirectly) {
  try {
    main();
  } catch (err) {
    const safe = err.message?.startsWith("marKit:") || String(err.code).startsWith("ERR_PARSE_ARGS");
    console.error(safe ? err.message.replace(/^(?!marKit:)/, "marKit: ") : `marKit: unexpected error (${err.name})`);
    process.exitCode = 1;
  }
}
