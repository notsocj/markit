// app-icon.js — the app's own icon, saved next to its profile (apps/<name>.png) so the
// dashboard's app picker can show it instead of the first letter.
//
// /markit-setup copies the icon it finds in the project (lib/project.js findAppIcon) when
// it saves the profile. Only real raster images are accepted, checked by their first bytes
// (not the file name): PNG, JPEG, WebP, ICO. SVG is refused on purpose, because an SVG
// file can carry scripts.

import { readFileSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import path from "node:path";

// File extension → Content-Type, for the formats we accept.
export const ICON_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", ico: "image/x-icon" };

// A 1024×1024 store icon is usually well under this.
export const MAX_ICON_BYTES = 2 * 1024 * 1024;

/** The image format from a file's first bytes ("png", "jpg", "webp", "ico"), or null. */
export function iconType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "ico";
  return null;
}

/**
 * Read a file only if it's a usable icon: a regular file (not a symlink, which could point
 * anywhere), small enough, and a real image. Returns { body, ext } or null.
 */
export function readIconFile(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > MAX_ICON_BYTES) return null;
    const body = readFileSync(file);
    const ext = iconType(body);
    return ext ? { body, ext } : null;
  } catch {
    return null;
  }
}

/**
 * Copy an icon into the apps folder as <name>.<ext>, replacing any older icon of that app.
 * `name` must already be a valid app name. Returns the saved path, or null if not an icon.
 */
export function saveAppIcon(appsDir, name, sourceFile) {
  const icon = readIconFile(sourceFile);
  if (!icon) return null;
  for (const ext of Object.keys(ICON_TYPES)) rmSync(path.join(appsDir, `${name}.${ext}`), { force: true });
  const dest = path.join(appsDir, `${name}.${icon.ext}`);
  writeFileSync(dest, icon.body);
  return dest;
}

/** The saved icon of one app as { body, type }, or null. `name` must be a valid app name. */
export function readAppIcon(appsDir, name) {
  for (const ext of Object.keys(ICON_TYPES)) {
    const icon = readIconFile(path.join(appsDir, `${name}.${ext}`));
    // The bytes must match the extension, so a file renamed by hand can't change its type.
    if (icon?.ext === ext) return { body: icon.body, type: ICON_TYPES[ext] };
  }
  return null;
}
