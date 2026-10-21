// shared.js — loads marKit's shared code from the sibling markit-find folder.
//
// marKit ships as four skills installed side by side:
//
//   skills/
//   ├── markit-setup/
//   ├── markit-find/    ← holds the shared lib/ and adapters/
//   ├── markit-usage/
//   └── markit-dashboard/   ← this skill
//
// This skill reuses markit-find's code instead of keeping its own copy. If someone
// installed only this folder, the import would fail with a confusing Node error, so we
// check first and print a clear message instead.
//
// Why a function instead of a normal `import` at the top of the file? Normal imports
// run BEFORE any of our code, so we'd never get the chance to check. `await import()`
// runs only when we call it, after the check.
//
// (markit-setup/scripts/shared.js and markit-usage/scripts/shared.js are identical
// copies. This file can't itself be shared, for the same reason it exists.)

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SIBLING_MESSAGE =
  "marKit: install all four skills together (markit-setup, markit-find, markit-usage, markit-dashboard). See README.";

// ../../markit-find/scripts/ relative to THIS file (not to wherever the user ran node from).
const SHARED_ROOT = new URL("../../markit-find/scripts/", import.meta.url);

/** True if the sibling markit-find folder (with its shared code) is installed. */
export function siblingsInstalled(root = SHARED_ROOT) {
  return existsSync(fileURLToPath(new URL("lib/config.js", root)));
}

/**
 * Import a shared module, e.g. await loadShared("lib/config.js").
 * Exits with the install message if markit-find is missing.
 */
export async function loadShared(relativePath) {
  if (!siblingsInstalled()) {
    console.error(SIBLING_MESSAGE);
    process.exit(1);
  }
  return import(new URL(relativePath, SHARED_ROOT).href);
}
