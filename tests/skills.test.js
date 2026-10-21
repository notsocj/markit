// Tests for the three SKILL.md files and install.sh: the pieces an agent actually reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = ["markit-setup", "markit-find", "markit-usage", "markit-dashboard"];
const read = (skill) => readFileSync(join(repo, "skills", skill, "SKILL.md"), "utf8");

/** Split "---\nkey: value\n---\nbody" into { meta, body }. */
function parse(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "SKILL.md must start with --- frontmatter ---");
  const meta = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    })
  );
  return { meta, body: match[2] };
}

const securityBlock = (body) => body.match(/## Security rules \(always follow, before anything else\)\n(?:- .*\n)+/)?.[0];

for (const skill of SKILLS) {
  test(`${skill}: frontmatter follows the Agent Skills format`, () => {
    const { meta } = parse(read(skill));
    assert.equal(meta.name, skill, "name must match the folder name");
    assert.match(meta.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(meta.description && meta.description.length <= 1024, "description required, ≤ 1024 chars");
    assert.match(meta["disallowed-tools"] ?? "", /Read\(~\/\.config\/markit\/\.env\)/, "the agent is blocked from reading .env");
  });

  test(`${skill}: every script and reference it mentions exists`, () => {
    const text = read(skill);
    const paths = [...text.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+\.(?:js|md))/g)].map((m) => m[1]);
    assert.ok(paths.length > 0);
    for (const rel of paths) assert.ok(existsSync(join(repo, "skills", skill, rel)), `${skill}: ${rel} not found`);
  });
}

test("all four skills share the same security block, word for word", () => {
  const blocks = SKILLS.map((s) => securityBlock(parse(read(s)).body));
  assert.ok(blocks[0], "security block missing");
  assert.ok(blocks[0].includes("NEVER read, print, cat, or open the marKit .env file"));
  assert.equal(blocks[1], blocks[0]);
  assert.equal(blocks[2], blocks[0]);
});

test("install.sh copies all four skills side by side, and uninstall removes only them", () => {
  const dir = mkdtempSync(join(tmpdir(), "markit-install-"));
  const install = (...args) => spawnSync("bash", [join(repo, "install.sh"), ...args], { encoding: "utf8" });

  const r = install("--dir", dir);
  assert.equal(r.status, 0, r.stderr);
  for (const s of SKILLS) assert.ok(existsSync(join(dir, s, "SKILL.md")));
  assert.ok(existsSync(join(dir, "markit-find", "scripts", "lib", "config.js")), "shared code is included");
  assert.ok(!existsSync(join(dir, "tests")), "only the skill folders are installed");

  // An installed copy works on its own (sibling imports resolve inside the install).
  const usage = spawnSync(process.execPath, [join(dir, "markit-usage", "scripts", "usage.js")], {
    encoding: "utf8",
    env: { ...process.env, MARKIT_CONFIG_DIR: join(dir, "no-config") },
  });
  assert.match(usage.stdout, /marKit isn't set up yet/);

  const u = install("--dir", dir, "--uninstall");
  assert.equal(u.status, 0);
  for (const s of SKILLS) assert.ok(!existsSync(join(dir, s)));
});
