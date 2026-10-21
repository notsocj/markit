#!/usr/bin/env bash
# install.sh — installs marKit's four skills (markit-setup, markit-find, markit-usage,
# markit-dashboard).
#
# marKit's skills share code, so all four folders are always installed side by side.
# This script only copies files: it doesn't download anything, and it never touches your
# marKit config or keys (~/.config/markit), which live outside the skills folder.
#
# Usage:
#   ./install.sh                 Claude Code, for your user  (~/.claude/skills)
#   ./install.sh --codex         Codex, for your user         (~/.agents/skills)
#   ./install.sh --claude --codex   both
#   ./install.sh --project       Claude Code, this project only (./.claude/skills)
#   ./install.sh --dir <path>    any skills folder
#   ./install.sh --link          symlink instead of copy (for marKit development:
#                                edits in this repo show up immediately)
#   ./install.sh --uninstall     remove the four skill folders from the chosen place(s)
#
# Written for the bash that ships with macOS (3.2), so no newer bash features.

set -euo pipefail

SKILLS="markit-setup markit-find markit-usage markit-dashboard"
# The folder this script is in (the repo root), even if run from somewhere else.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

targets=""
mode="copy"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

# --- Read the options -----------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --claude)    targets="$targets $HOME/.claude/skills" ;;
    --codex)     targets="$targets $HOME/.agents/skills" ;;
    --project)   targets="$targets $(pwd)/.claude/skills" ;;
    --dir)
      [ $# -ge 2 ] || { echo "install.sh: --dir needs a path" >&2; exit 1; }
      targets="$targets $2"; shift ;;
    --link)      mode="link" ;;
    --uninstall) mode="uninstall" ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "install.sh: unknown option '$1' (try --help)" >&2; exit 1 ;;
  esac
  shift
done
# Default: Claude Code, user-level.
[ -n "$targets" ] || targets="$HOME/.claude/skills"

# --- Uninstall -----------------------------------------------------------------
if [ "$mode" = "uninstall" ]; then
  for target in $targets; do
    for name in $SKILLS; do
      # -L catches symlinks (from --link), -d catches copied folders.
      if [ -L "$target/$name" ] || [ -d "$target/$name" ]; then
        rm -rf "${target:?}/$name"
        echo "Removed $target/$name"
      fi
    done
  done
  echo "Your marKit config and keys (~/.config/markit) were left in place. Delete that folder yourself if you want them gone."
  exit 0
fi

# --- Checks before installing --------------------------------------------------
for name in $SKILLS; do
  if [ ! -f "$REPO/skills/$name/SKILL.md" ]; then
    echo "install.sh: $REPO/skills/$name is missing. Run this script from the marKit repo." >&2
    exit 1
  fi
done

# marKit needs Node.js 20.12+ (for process.loadEnvFile). Warn, but still install.
if command -v node >/dev/null 2>&1; then
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)'; then
    echo "Warning: marKit needs Node.js 20.12 or newer (you have $(node --version)). Please update Node." >&2
  fi
else
  echo "Warning: Node.js not found. marKit needs Node.js 20.12 or newer: https://nodejs.org" >&2
fi

# --- Install -------------------------------------------------------------------
for target in $targets; do
  mkdir -p "$target"
  for name in $SKILLS; do
    dest="$target/$name"
    # Replace an older marKit install of this folder (only these four names, ever).
    if [ -L "$dest" ] || [ -e "$dest" ]; then rm -rf "${dest:?}"; fi
    if [ "$mode" = "link" ]; then
      ln -s "$REPO/skills/$name" "$dest"
    else
      cp -R "$REPO/skills/$name" "$dest"
      # macOS Finder litter has no place in an installed skill.
      find "$dest" -name .DS_Store -delete 2>/dev/null || true
    fi
  done
  # Check all four made it, side by side (the shared code depends on it).
  for name in $SKILLS; do
    [ -f "$target/$name/SKILL.md" ] || { echo "install.sh: $target/$name didn't install correctly." >&2; exit 1; }
  done
  verb="Installed"; [ "$mode" = "link" ] && verb="Linked"
  echo "✓ $verb marKit into $target (markit-setup, markit-find, markit-usage, markit-dashboard)"
done

cat <<'EOF'

Next:
  1. Start a new Claude Code or Codex session (so it sees the new skills).
  2. Run /markit-setup   (Codex: $markit-setup)
Then /markit-find to find posts to reply to, /markit-dashboard to work through them,
and /markit-usage to check keys and limits.
Your config and keys live in ~/.config/markit and were not touched.
EOF
