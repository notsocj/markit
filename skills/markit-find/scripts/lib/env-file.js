// env-file.js — safely change ONE key in marKit's .env file (used by the dashboard's
// Settings page, so you can paste a key in your browser instead of editing the file).
//
// Rules this file keeps:
//   - It never returns, prints, or logs a key value. The only thing it reports about the
//     file is which keys are set (true/false).
//   - Only marKit's known keys (config.js KNOWN_KEYS) can be written, and values must look
//     like an API key (no spaces, quotes, "#", or line breaks), so nothing written here can
//     break the file or sneak in another line.
//   - Every other line (comments, other keys, blank lines) is kept exactly as it was.
//   - Writes go to a temp file first and are renamed into place (atomic), with owner-only
//     permissions (chmod 600), like `setup.js init` creates the file.

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { KNOWN_KEYS, parseEnv } from "./config.js";

export const MAX_KEY_LENGTH = 1000;
// Characters real API keys and tokens use: letters, digits, and . _ ~ + / = % : @ -
// (X bearer tokens can contain %, Bluesky handles contain dots, app passwords hyphens).
const KEY_CHARS = /^[A-Za-z0-9._~+/=%:@-]+$/;

/**
 * Check a value before it's written. Empty means "remove this key".
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateKeyValue(name, value) {
  if (!KNOWN_KEYS.includes(name)) return { ok: false, error: "unknown key name" };
  if (typeof value !== "string") return { ok: false, error: "the key must be text" };
  const v = value.trim();
  if (v.length > MAX_KEY_LENGTH) return { ok: false, error: `that's longer than any API key (max ${MAX_KEY_LENGTH} characters)` };
  if (v && !KEY_CHARS.test(v)) return { ok: false, error: "that doesn't look like an API key (spaces, quotes, # and line breaks aren't allowed). Copy just the key itself." };
  return { ok: true, value: v };
}

/**
 * Return new .env text with `name` set to `value` (pure: no file access).
 * The first `NAME=` line (also `export NAME=`) is replaced and any later duplicates are
 * removed, so there's exactly one. If the key isn't there yet, it's added at the end.
 */
export function setEnvValue(text, name, value) {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const isKeyLine = (line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line);
  const out = [];
  let done = false;
  for (const line of lines) {
    if (!isKeyLine(line)) out.push(line);
    else if (!done) {
      out.push(`${name}=${value}`);
      done = true;
    }
  }
  if (!done) {
    while (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${name}=${value}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

/** Which known keys have a value: { YOUTUBE_API_KEY: true, X_BEARER_TOKEN: false, ... }. */
export function keyStatus(envFile) {
  const env = parseEnv(existsSync(envFile) ? readFileSync(envFile, "utf8") : "");
  return Object.fromEntries(KNOWN_KEYS.map((k) => [k, Boolean(env[k])]));
}

/**
 * Set (or with "" remove) one key in the .env file. Returns { set: boolean } only.
 * @throws {Error} a safe message (never containing the value) if the value is refused
 */
export function writeEnvValue(envFile, name, value) {
  const check = validateKeyValue(name, value);
  if (!check.ok) throw new Error(`marKit: ${check.error}`);
  const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  mkdirSync(dirname(envFile), { recursive: true });
  const tmp = `${envFile}.${process.pid}.tmp`;
  writeFileSync(tmp, setEnvValue(before, name, check.value), { mode: 0o600 });
  renameSync(tmp, envFile);
  try {
    chmodSync(envFile, 0o600); // keep it owner-only even if it was more open before
  } catch {
    // Windows: permissions work differently; %APPDATA% is already private to the user
  }
  return { set: Boolean(check.value) };
}
