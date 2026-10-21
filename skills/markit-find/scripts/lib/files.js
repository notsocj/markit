// files.js — tiny helpers for reading and writing JSON files safely.
//
// Used by config.js, seen.js, and usage.js so they all handle files the same way:
// - A missing file is not an error; you get a default value instead.
// - Writes go to a temporary file first and are then renamed into place.
//   Renaming is atomic, so if the script crashes halfway, the old file is still intact
//   instead of being left half-written (which would break the next run).

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Read and parse a JSON file.
 * @param {string} path - file to read
 * @param {*} fallback - returned if the file doesn't exist yet
 */
export function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    // Only the file path goes in the message. marKit's JSON files never hold secrets,
    // but we still don't echo file contents into errors.
    throw new Error(`marKit: ${path} is not valid JSON. Fix or delete it, then try again.`);
  }
}

/**
 * Write a value as pretty-printed JSON, creating parent folders if needed.
 * @param {string} path - file to write
 * @param {*} value - anything JSON.stringify can handle
 * @param {{ mode?: number }} [options] - optional file permissions (e.g. 0o600)
 */
export function writeJsonFile(path, value, { mode } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  // The temp file sits next to the real one so the rename stays on the same disk
  // (renames across disks aren't atomic). process.pid keeps two runs from colliding.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : undefined);
  renameSync(tmp, path);
}

/**
 * Write a text file (e.g. report.md) the same safe way: temp file, then rename.
 */
export function writeTextFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
