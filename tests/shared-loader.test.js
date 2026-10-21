// Tests for the sibling-folder check in markit-setup/scripts/shared.js and
// markit-usage/scripts/shared.js: if markit-find isn't installed next to them, scripts
// must print the "install all four skills together" message instead of crashing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const EXPECTED = "marKit: install all four skills together (markit-setup, markit-find, markit-usage, markit-dashboard): npx skills add notsocj/markit -g --skill '*'  (see README).";

for (const skill of ["markit-setup", "markit-usage", "markit-dashboard"]) {
  test(`${skill}: finds markit-find when all four skills are installed`, async () => {
    const { siblingsInstalled, loadShared } = await import(`../skills/${skill}/scripts/shared.js`);
    assert.equal(siblingsInstalled(), true);
    const config = await loadShared("lib/config.js");
    assert.equal(typeof config.getPaths, "function");
  });

  test(`${skill}: prints the install message when markit-find is missing`, () => {
    // Build a fake skills folder that contains ONLY this skill.
    const skills = mkdtempSync(join(tmpdir(), "markit-lonely-"));
    const scripts = join(skills, skill, "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(skills, skill, "package.json"), '{ "type": "module" }');
    copyFileSync(join(repo, "skills", skill, "scripts", "shared.js"), join(scripts, "shared.js"));
    writeFileSync(join(scripts, "probe.js"), 'import { loadShared } from "./shared.js";\nawait loadShared("lib/config.js");\n');

    const result = spawnSync(process.execPath, [join(scripts, "probe.js")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), EXPECTED);
  });
}
