#!/usr/bin/env bash
set -euo pipefail

VSCODE_VERSION="1.141.0"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSIONS_DIR="$REPO_ROOT/extensions"

# Copilot is not part of a SideX install: the upstream built-in expects a
# Microsoft account and a hosted service, and SideX ships no model provider of
# its own. Dropping it here keeps `npm run setup` from silently installing an
# extension that can only show "sign in to use Copilot".
EXCLUDED_EXTENSIONS=("copilot" "copilot-chat" "github-copilot" "copilot-chat-prerelease")


# File icons: workbench.iconTheme defaults to vs-seti (theme-seti builtin).
ensure_theme_seti() {
  bash "$REPO_ROOT/scripts/ensure-file-icon-theme.sh"
}

prune_excluded_extensions() {
  local removed=0
  local name
  for name in "${EXCLUDED_EXTENSIONS[@]}"; do
    if [[ -e "$EXTENSIONS_DIR/$name" ]]; then
      rm -rf "$EXTENSIONS_DIR/$name"
      removed=$((removed + 1))
    fi
  done
  if [[ "$removed" -gt 0 ]]; then
    echo "Removed $removed Copilot extension(s) from the bundle (off by default in SideX)."
  fi
}


hide_broken_markdown_palette_commands() {
  local md_pkg="$EXTENSIONS_DIR/markdown-language-features/package.json"
  [[ -f "$md_pkg" ]] || return 0
  python3 - "$md_pkg" <<'HIDEPY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
menus = d.setdefault("contributes", {}).setdefault("menus", {}).setdefault("commandPalette", [])
found = False
for m in menus:
    if m.get("command") == "_markdown.openFrontMatterSettings":
        m["when"] = "false"
        found = True
if not found:
    menus.insert(0, {"command": "_markdown.openFrontMatterSettings", "when": "false"})
json.dump(d, open(p, "w"), indent="\t")
open(p, "a").write("\n")
HIDEPY
}

ensure_markdown_editor_assets() {
  local editor_js="$EXTENSIONS_DIR/markdown-language-features/markdown-editor-out/editor.js"
  if [[ -f "$editor_js" ]]; then
    echo "Markdown Editor webview present ($(du -sh "$EXTENSIONS_DIR/markdown-language-features/markdown-editor-out" | cut -f1))."
    hide_broken_markdown_palette_commands
    return 0
  fi
  echo "Markdown Editor webview missing — fetching from VS Code ${VSCODE_VERSION}…"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -L --progress-bar     "https://update.code.visualstudio.com/${VSCODE_VERSION}/linux-x64/stable"     -o "$tmp/code.tar.gz"
  tar -xzf "$tmp/code.tar.gz" -C "$tmp"     --wildcards 'VSCode-linux-x64/resources/app/extensions/markdown-*'     --wildcards 'VSCode-linux-x64/resources/app/extensions/mermaid-markdown-features'     2>/dev/null || tar -xzf "$tmp/code.tar.gz" -C "$tmp"     "VSCode-linux-x64/resources/app/extensions/markdown-language-features"     "VSCode-linux-x64/resources/app/extensions/markdown-basics"     "VSCode-linux-x64/resources/app/extensions/markdown-math"     "VSCode-linux-x64/resources/app/extensions/mermaid-markdown-features"
  local src="$tmp/VSCode-linux-x64/resources/app/extensions"
  for name in markdown-language-features markdown-basics markdown-math mermaid-markdown-features; do
    if [[ -d "$src/$name" ]]; then
      rm -rf "$EXTENSIONS_DIR/$name"
      cp -a "$src/$name" "$EXTENSIONS_DIR/"
      echo "Installed $name from VS Code ${VSCODE_VERSION}."
    fi
  done
  hide_broken_markdown_palette_commands
}


if [[ -d "$EXTENSIONS_DIR" && "$(ls -A "$EXTENSIONS_DIR" 2>/dev/null | wc -l)" -gt 10 ]]; then
  prune_excluded_extensions
  ensure_theme_seti
  ensure_markdown_editor_assets
  echo "extensions/ already populated ($(ls "$EXTENSIONS_DIR" | wc -l | tr -d ' ') entries) — skipping."
  exit 0
fi

mkdir -p "$EXTENSIONS_DIR"

VSCODE_CANDIDATES=(
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions"
  "/Applications/Cursor.app/Contents/Resources/app/extensions"
  "/usr/share/code/resources/app/extensions"
  "/usr/lib/code/extensions"
  "/opt/visual-studio-code/resources/app/extensions"
  "$HOME/.vscode/extensions"
)

for candidate in "${VSCODE_CANDIDATES[@]}"; do
  if [[ -d "$candidate" && "$(ls -A "$candidate" 2>/dev/null | wc -l)" -gt 10 ]]; then
    echo "Found VSCode extensions at: $candidate"
    echo "Copying built-in extensions..."
    cp -r "$candidate"/. "$EXTENSIONS_DIR/"
    prune_excluded_extensions
    ensure_theme_seti
    ensure_markdown_editor_assets
    echo "Copied $(ls "$EXTENSIONS_DIR" | wc -l | tr -d ' ') extensions."
    exit 0
  fi
done

echo "No local VSCode installation found. Downloading from GitHub..."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -L --progress-bar \
  "https://github.com/microsoft/vscode/archive/refs/tags/${VSCODE_VERSION}.tar.gz" \
  -o "$TMP_DIR/vscode.tar.gz"

echo "Extracting extensions..."
tar -xzf "$TMP_DIR/vscode.tar.gz" -C "$TMP_DIR" "vscode-${VSCODE_VERSION}/extensions"
cp -r "$TMP_DIR/vscode-${VSCODE_VERSION}/extensions/." "$EXTENSIONS_DIR/"
prune_excluded_extensions
ensure_theme_seti
ensure_markdown_editor_assets

echo "Done — $(ls "$EXTENSIONS_DIR" | wc -l | tr -d ' ') extensions installed."
