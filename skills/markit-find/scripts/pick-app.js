#!/usr/bin/env node
// pick-app.js — decides which app profile /markit-find should use.
//
//   node pick-app.js                 → pick automatically
//   node pick-app.js --app gridpeek  → just confirm that profile exists
//
// Automatic order (see pickApp in lib/project.js):
//   1. A profile whose name matches the current folder's name   ("folder")
//   2. A profile matching the project's package/app name         ("package")
//   3. The only profile, if there's exactly one                  ("only")
//   4. Otherwise the agent must ask the user                     ("ask")
//
// Prints JSON like:
//   { "app": "gridpeek", "reason": "folder", "matched": "gridpeek", "apps": [...],
//     "profilePath": "/Users/you/.config/markit/apps/gridpeek.json", "message": "..." }
// "message" is a ready-to-say sentence for the user.

import { parseArgs } from "node:util";
import { getPaths, isSetUp, listApps, appPath } from "./lib/config.js";
import { pickApp } from "./lib/project.js";

const MESSAGES = {
  requested: (r) => `Using app profile "${r.app}".`,
  folder: (r) => `Using app profile "${r.app}" (matches this folder's name, "${r.matched}").`,
  package: (r) => `Using app profile "${r.app}" (matches this project's name, "${r.matched}").`,
  only: (r) => `Using app profile "${r.app}" (your only app).`,
  ask: (r) => `Which app should I search for? Your apps: ${r.apps.join(", ")}.`,
  none: () => "No app profiles yet. Run /markit-setup to create one.",
};

try {
  const { values } = parseArgs({ options: { app: { type: "string" } } });
  const paths = getPaths();
  if (!isSetUp(paths)) throw new Error("marKit: not set up yet. Run /markit-setup first.");

  const result = pickApp({ requested: values.app, apps: listApps(paths), cwd: process.cwd() });
  // profilePath lets the agent read the profile (not secret) to judge which posts fit.
  const profilePath = result.app ? appPath(result.app, paths) : null;
  console.log(JSON.stringify({ ...result, profilePath, message: MESSAGES[result.reason](result) }, null, 2));
} catch (err) {
  console.error(err.message.startsWith("marKit:") ? err.message : `marKit: ${err.message}`);
  process.exitCode = 1;
}
