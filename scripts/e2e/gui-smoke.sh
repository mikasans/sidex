#!/usr/bin/env bash
#
# SideX native GUI end-to-end smoke.
#
# Boots the real Tauri binary under Xvfb (with openbox so the webview gets
# focus), drives it with xdotool, screenshots every step, and asserts on
# observable results — the strongest being that Ctrl+S actually writes the
# typed text to disk.
#
# Usage:
#   SIDEX_BIN=/path/to/SideX scripts/e2e/gui-smoke.sh
#
# Env:
#   SIDEX_BIN     path to the release binary (default src-tauri/target/release/SideX)
#   E2E_OUT       evidence directory (default smoke-artifacts/e2e-native)
#   E2E_DISPLAY   X display to use (default :99)
#   E2E_KEEP      set to 1 to leave the app running for inspection
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${E2E_OUT:-$ROOT/smoke-artifacts/e2e-native}"
DISPLAY_NUM="${E2E_DISPLAY:-:99}"
MARKER="GUI_E2E_MARKER_$(date +%s)"

# Resolve the release binary: env override, then the two cargo target layouts.
BIN="${SIDEX_BIN:-}"
if [ -z "$BIN" ]; then
  for candidate in \
    "$ROOT/target/release/SideX" \
    "$ROOT/src-tauri/target/release/SideX" \
    "$ROOT/release-artifacts/linux-staging/SideX"; do
    if [ -x "$candidate" ]; then BIN="$candidate"; break; fi
  done
fi

mkdir -p "$OUT"
: > "$OUT/steps.tsv"

PASS=0
FAIL=0
GAPS=0
step() { # step <name> <ok|fail> <detail>
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "ok" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
  printf '%s\t%s\t%s\n' "$name" "$ok" "$detail" >> "$OUT/steps.tsv"
  printf '%s  %s%s\n' "$([ "$ok" = ok ] && echo PASS || echo FAIL)" "$name" "${detail:+ — $detail}"
}
# A known divergence from VS Code: the underlying command is missing from the
# SideX port, so no keystroke or menu entry can reach it. Tracked separately from
# PASS/FAIL so a genuine regression still turns the run red while a documented
# gap stays visible without failing the suite.
gap() { # gap <name> <reason>
  local name="$1" reason="${2:-}"
  GAPS=$((GAPS + 1))
  printf '%s\t%s\t%s\n' "$name" "gap" "$reason" >> "$OUT/steps.tsv"
  printf 'GAP   %s — %s\n' "$name" "$reason"
}

require() {
  for c in "$@"; do
    if ! command -v "$c" >/dev/null 2>&1; then
      echo "missing required tool: $c" >&2
      exit 2
    fi
  done
}

require Xvfb openbox xdotool scrot wmctrl identify compare

if [ ! -x "$BIN" ]; then
  echo "SideX binary not found or not executable: $BIN" >&2
  echo "build it with: npm run build && npx tauri build --no-bundle" >&2
  echo "(a plain 'cargo build --release' produces a binary that still loads the dev URL)" >&2
  exit 2
fi

WORKSPACE="$(mktemp -d /tmp/sidex-e2e-ws.XXXXXX)"
# Plain text on purpose: once the built-in extension catalog is installed a
# `.md` file has both a text editor and the Markdown preview registered as
# default, which pops a "multiple default editors" prompt and makes quick open
# ambiguous. `.txt` keeps this step about Ctrl+S, not about editor selection.
NOTE="$WORKSPACE/note.txt"
printf '# e2e note\n\noriginal line\n' > "$NOTE"

XVFB_PID=""
OB_PID=""
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  sleep 0.5
  [ -n "$APP_PID" ] && kill -9 "$APP_PID" 2>/dev/null
  [ -n "$OB_PID" ] && kill "$OB_PID" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
}
trap cleanup EXIT

echo "== SideX native GUI e2e =="
echo "binary   : $BIN"
echo "display  : $DISPLAY_NUM"
echo "workspace: $WORKSPACE"

# --- 1. display + window manager -------------------------------------------
# Clear a stale X lock/socket from an interrupted previous run (best effort;
# needs root — if not permitted, Xvfb will simply pick up the leftover lock).
DISP_NUM="${DISPLAY_NUM#:}"
rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}" 2>/dev/null || true
Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp > "$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 50); do
  timeout 5 env DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 && break
  sleep 0.2
done
if timeout 5 env DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
  step "xvfb.ready" ok "$DISPLAY_NUM"
else
  step "xvfb.ready" fail "Xvfb did not come up"
  exit 1
fi

DISPLAY="$DISPLAY_NUM" openbox > "$OUT/openbox.log" 2>&1 &
OB_PID=$!
sleep 1
step "openbox.ready" ok "pid=$OB_PID"

# --- 2. launch the app ------------------------------------------------------
export DISPLAY="$DISPLAY_NUM"
export SIDEX_CHAT_ENABLED=false
export SIDEX_STARTUP_TRACE=1
# Xvfb has no GPU. WebKitGTK needs compositing off and a software GL stack,
# otherwise the window maps but never paints (a blank rectangle).
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe

"$BIN" "$WORKSPACE" > "$OUT/app.log" 2>&1 &
APP_PID=$!
step "app.spawned" ok "pid=$APP_PID"

WIN=""
for _ in $(seq 1 120); do
  WIN="$(xdotool search --onlyvisible --name 'SideX' 2>/dev/null | head -1)"
  [ -n "$WIN" ] && break
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    step "app.window" fail "process exited early; see $OUT/app.log"
    tail -20 "$OUT/app.log" >&2
    exit 1
  fi
  sleep 0.5
done

if [ -n "$WIN" ]; then
  step "app.window" ok "window=$WIN title=$(xdotool getwindowname "$WIN" 2>/dev/null)"
else
  step "app.window" fail "no SideX window after 60s"
  exit 1
fi

xdotool windowactivate --sync "$WIN" 2>/dev/null || xdotool windowfocus "$WIN" 2>/dev/null
sleep 1

shot() { timeout 15 scrot -o "$OUT/$1" >/dev/null 2>&1 || timeout 15 import -window root "$OUT/$1" >/dev/null 2>&1; }

# Number of distinct colours on screen — a cheap "did the UI actually paint?"
# probe. A blank window is a handful of colours; a mounted workbench is hundreds.
ui_colors() {
  local probe="$OUT/.probe.png"
  timeout 15 scrot -o "$probe" >/dev/null 2>&1 || timeout 15 import -window root "$probe" >/dev/null 2>&1
  identify -format '%k' "$probe" 2>/dev/null || echo 0
}

# --- 2b. wait for the workbench to actually render --------------------------
WORKBENCH_OK=0
for _ in $(seq 1 60); do
  if grep -q 'setup complete' "$OUT/app.log" 2>/dev/null; then WORKBENCH_OK=1; break; fi
  sleep 1
done
step "app.workbench" "$([ "$WORKBENCH_OK" = 1 ] && echo ok || echo fail)" "startup trace 'setup complete'"

# Splash alone is ~150–180 distinct colours ("SideX / Loading workbench...").
# A mounted workbench under Xvfb software GL is typically ~240+; on a real
# display it is often 1000+. Threshold must clear the splash false-positive.
PAINTED=0
COLORS=0
for _ in $(seq 1 90); do
  COLORS="$(ui_colors)"
  if [ "${COLORS:-0}" -gt 220 ] 2>/dev/null; then PAINTED=1; break; fi
  sleep 1
done
shot "01-startup.png"
step "app.painted" "$([ "$PAINTED" = 1 ] && echo ok || echo fail)" "distinct colours on screen=$COLORS (need >220 to clear splash)"
if [ "$PAINTED" != 1 ]; then
  echo "workbench never painted past splash; see $OUT/01-startup.png and $OUT/app.log" >&2
  exit 1
fi

# --- 3. quick open the note -------------------------------------------------
# Do this before the palette check: with a real file loaded the editor content
# is static, so a before/after pixel diff later can only be the palette. While
# the welcome editor is showing, its rotating hint text ("Show All Commands" /
# "Find in Files" / ...) changes on its own and makes any diff meaningless.
#
# Warm-up first. Right after startup the very first keystroke is swallowed —
# the window is mapped but the webview has not taken keyboard focus yet. In the
# old script that cost us the palette check (the rotating hint text faked the
# diff); with quick open first it silently dropped the Ctrl+P instead. Click,
# open and close the palette once, and only then drive the real steps.
eval "$(xdotool getwindowgeometry --shell "$WIN")"
xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2))
xdotool click 1
sleep 1
xdotool key --clearmodifiers ctrl+shift+p
sleep 1.5
xdotool key --clearmodifiers Escape
sleep 1

xdotool key --clearmodifiers ctrl+p
sleep 1.5
xdotool type --delay 60 "note.txt"
sleep 1.6
shot "03-quick-open.png"
# The quick-open widget must be on screen: the welcome editor is static, so any
# real change against the startup shot is the widget (or its result list).
QO_DIFF="$(compare -metric AE "$OUT/01-startup.png" "$OUT/03-quick-open.png" null: 2>&1 | tr -d '\n' || true)"
QO_CHANGED="$(awk -v d="${QO_DIFF:-0}" 'BEGIN { print (d + 0 > 2000) ? "yes" : "no" }')"
if [ "$QO_CHANGED" = "yes" ]; then
  step "ui.quickOpen" ok "screen changed by ${QO_DIFF} px after ctrl+p + 'note.txt'"
else
  step "ui.quickOpen" fail "screen barely changed (${QO_DIFF:-0} px); quick open did not show"
fi
xdotool key --clearmodifiers Return
sleep 2.5
shot "04-opened.png"

TITLE="$(xdotool getwindowname "$WIN" 2>/dev/null)"
# SideX keeps a static window title ("SideX"), so the title is recorded as
# evidence rather than asserted on. The real proof that the file opened is the
# save check below: the marker must land in note.txt while its original line
# survives — that can only happen if quick open loaded this file into the editor.
step "editor.opened" ok "window title: $TITLE (informational; save check below is authoritative)"

# --- 4. command palette -----------------------------------------------------
# Focus the editor, then check that Ctrl+Shift+P changes what is on screen. The
# editor content is static here, so a large diff means the palette rendered.
eval "$(xdotool getwindowgeometry --shell "$WIN")"
xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2))
xdotool click 1
sleep 1
shot "04a-before-palette.png"

xdotool key --clearmodifiers ctrl+shift+p
sleep 2
xdotool type --delay 40 "markdown"
sleep 1
shot "04b-command-palette.png"
PIXDIFF="$(compare -metric AE "$OUT/04a-before-palette.png" "$OUT/04b-command-palette.png" null: 2>&1 | tr -d '\n' || true)"
# ImageMagick prints this in scientific notation once it gets large, so let awk
# do the numeric comparison.
PALETTE_CHANGED="$(awk -v d="${PIXDIFF:-0}" 'BEGIN { print (d + 0 > 2000) ? "yes" : "no" }')"
if [ "$PALETTE_CHANGED" = "yes" ]; then
  step "ui.commandPalette" ok "screen changed by ${PIXDIFF} px after ctrl+shift+p"
else
  step "ui.commandPalette" fail "screen barely changed (${PIXDIFF:-0} px); palette did not open"
fi
xdotool key --clearmodifiers Escape
sleep 0.8

# --- 5. edit + save (the hard assertion) ------------------------------------
# Click into the middle of the editor so keystrokes land there.
eval "$(xdotool getwindowgeometry --shell "$WIN")"
xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2))
xdotool click 1
sleep 1
xdotool key --clearmodifiers ctrl+End
sleep 0.5
xdotool type --delay 30 "$MARKER"
sleep 1
shot "05-typed.png"

BEFORE="$(cat "$NOTE")"
xdotool key --clearmodifiers ctrl+s
sleep 3
AFTER="$(cat "$NOTE")"
shot "06-saved.png"

if printf '%s' "$AFTER" | grep -q "$MARKER" && printf '%s' "$AFTER" | grep -q 'original line'; then
  step "editor.saveWroteToDisk" ok "Ctrl+S persisted '$MARKER' into $NOTE (original line intact)"
else
  step "editor.saveWroteToDisk" fail "marker not on disk. before=$(printf '%s' "$BEFORE" | tr '\n' '|') after=$(printf '%s' "$AFTER" | tr '\n' '|')"
fi

# --- 6. common editing operations (VS Code parity) --------------------------
# The steps above only prove "the workbench boots, quick open works, Ctrl+S
# saves". The ask here is broader: do the everyday editor gestures feel and
# behave like VS Code? Each op below drives one real keystroke sequence through
# xdotool into the webview and asserts on an observable result:
#   * editing ops assert on the file on disk after Ctrl+S (ground truth), and
#   * overlay ops assert the screen actually changed (the widget rendered).
# Every op uses its own freshly written file, so the assertions are absolute and
# one failure cannot poison the next.
OPS="$WORKSPACE"
mk() { printf '%b' "$2" > "$OPS/$1"; }
file_has() { grep -qF "$2" "$1"; }
file_lacks() { ! grep -qF "$2" "$1"; }
first_line() { sed -n '1p' "$1"; }
line_n() { sed -n "${2}p" "$1"; }

open_doc() { # open a workspace file through quick open
  xdotool key --clearmodifiers ctrl+p; sleep 1.2
  xdotool type --delay 40 "$1"; sleep 1.0
  xdotool key --clearmodifiers Return; sleep 2.2
}
# Click into the middle of the editor and drop any stray overlay first.
focus_editor() {
  xdotool key --clearmodifiers Escape; sleep 0.3
  eval "$(xdotool getwindowgeometry --shell "$WIN")"
  xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2)); sleep 0.2
  xdotool click 1; sleep 0.6
}

mk op-undo.js    'alpha\nbravo\ncharlie\n'
mk op-move.js    'alpha\nbravo\ncharlie\n'
mk op-del.js     'alpha\nbravo\ncharlie\n'
mk op-dup.js     'alpha\nbravo\n'
mk op-comment.js 'alpha\nbravo\n'
mk op-cut.js     'cutme\nkeepme\n'
mk op-ui.js      'alpha\nbravo\ncharlie\ndelta\n'

# 6.1 undo — type, Ctrl+Z, save; the typed text must be gone from disk.
focus_editor; open_doc op-undo.js; focus_editor
xdotool key --clearmodifiers ctrl+End; sleep 0.4
xdotool type --delay 30 "UNDO_MARK"; sleep 0.6
xdotool key --clearmodifiers ctrl+z; sleep 0.6
xdotool key --clearmodifiers ctrl+s; sleep 2.5
if file_lacks "$OPS/op-undo.js" "UNDO_MARK"; then
  step "ops.undo" ok "Ctrl+Z reverted the typed text (no UNDO_MARK on disk)"
else
  step "ops.undo" fail "Ctrl+Z did not revert; file=$(tr '\n' '|' < "$OPS/op-undo.js")"
fi

# 6.2 redo — Ctrl+Y must bring it back and save.
xdotool key --clearmodifiers ctrl+y; sleep 0.6
xdotool key --clearmodifiers ctrl+s; sleep 2.5
if file_has "$OPS/op-undo.js" "UNDO_MARK"; then
  step "ops.redo" ok "Ctrl+Y re-applied the edit (UNDO_MARK back on disk)"
else
  step "ops.redo" fail "Ctrl+Y did not redo; file=$(tr '\n' '|' < "$OPS/op-undo.js")"
fi
xdotool key --clearmodifiers ctrl+z; sleep 0.4
xdotool key --clearmodifiers ctrl+s; sleep 1.2

# 6.3 move line down — Alt+Down on the first line.
focus_editor; open_doc op-move.js; focus_editor
xdotool key --clearmodifiers ctrl+Home; sleep 0.4
xdotool key --clearmodifiers alt+Down; sleep 0.6
xdotool key --clearmodifiers ctrl+s; sleep 2.5
if [ "$(first_line "$OPS/op-move.js")" = "bravo" ] && [ "$(line_n "$OPS/op-move.js" 2)" = "alpha" ]; then
  step "ops.moveLineDown" ok "Alt+Down moved 'alpha' below 'bravo'"
else
  step "ops.moveLineDown" fail "Alt+Down did not move the line; file=$(tr '\n' '|' < "$OPS/op-move.js")"
fi

# 6.4 delete line — Ctrl+Shift+K.
focus_editor; open_doc op-del.js; focus_editor
xdotool key --clearmodifiers ctrl+Home; sleep 0.4
xdotool key --clearmodifiers ctrl+shift+k; sleep 0.6
xdotool key --clearmodifiers ctrl+s; sleep 2.5
if file_lacks "$OPS/op-del.js" "alpha" && [ "$(first_line "$OPS/op-del.js")" = "bravo" ]; then
  step "ops.deleteLine" ok "Ctrl+Shift+K removed the line under the cursor"
else
  step "ops.deleteLine" fail "Ctrl+Shift+K did not delete; file=$(tr '\n' '|' < "$OPS/op-del.js")"
fi

# 6.5 duplicate line — Ctrl+Shift+Alt+Down (the Linux default; the Windows
# default Shift+Alt+Down is overridden on Linux by linesOperations.ts).
focus_editor; open_doc op-dup.js; focus_editor
xdotool key --clearmodifiers ctrl+Home; sleep 0.4
xdotool key --clearmodifiers ctrl+shift+alt+Down; sleep 0.6
xdotool key --clearmodifiers ctrl+s; sleep 2.5
NDUP="$(grep -c '^alpha' "$OPS/op-dup.js" || true)"
if [ "${NDUP:-0}" -ge 2 ]; then
  step "ops.duplicateLine" ok "Ctrl+Shift+Alt+Down duplicated the line ('alpha' x${NDUP})"
else
  step "ops.duplicateLine" fail "line not duplicated; file=$(tr '\n' '|' < "$OPS/op-dup.js")"
fi

# 6.6 toggle line comment — Ctrl+/. Needs a real language mode (the built-in
# extension catalog provides `javascript`), so the model has a line-comment
# token to insert.
focus_editor; open_doc op-comment.js; focus_editor
xdotool key --clearmodifiers ctrl+Home; sleep 0.4
xdotool key --clearmodifiers ctrl+slash; sleep 0.7
xdotool key --clearmodifiers ctrl+s; sleep 2.5
if printf '%s' "$(first_line "$OPS/op-comment.js")" | grep -q '^//'; then
  step "ops.toggleComment" ok "Ctrl+/ commented the line ($(first_line "$OPS/op-comment.js"))"
else
  step "ops.toggleComment" fail "Ctrl+/ did not comment; file=$(tr '\n' '|' < "$OPS/op-comment.js")"
fi

# 6.7 cut then paste — Ctrl+X / Ctrl+V.
focus_editor; open_doc op-cut.js; focus_editor
xdotool key --clearmodifiers ctrl+Home; sleep 0.3
xdotool key --clearmodifiers shift+Down; sleep 0.3
xdotool key --clearmodifiers ctrl+x; sleep 0.5
xdotool key --clearmodifiers ctrl+s; sleep 2.2
if file_lacks "$OPS/op-cut.js" "cutme" && file_has "$OPS/op-cut.js" "keepme"; then
  step "ops.cut" ok "Ctrl+X removed the selected line ('cutme' gone, 'keepme' kept)"
else
  step "ops.cut" fail "Ctrl+X failed; file=$(tr '\n' '|' < "$OPS/op-cut.js")"
fi
xdotool key --clearmodifiers ctrl+End; sleep 0.3
xdotool key --clearmodifiers ctrl+v; sleep 0.6
xdotool key --clearmodifiers ctrl+s; sleep 2.2
if file_has "$OPS/op-cut.js" "cutme" && [ "$(first_line "$OPS/op-cut.js")" = "keepme" ]; then
  step "ops.paste" ok "Ctrl+V pasted the cut text back (now after 'keepme')"
else
  step "ops.paste" fail "Ctrl+V failed; file=$(tr '\n' '|' < "$OPS/op-cut.js")"
fi

# 6.8 overlay widgets — a large before/after pixel delta means the widget drew.
ui_changed() { # ui_changed <step> <label> <keys...>
  local name="$1" label="$2"; shift 2
  shot "$name-before.png"
  xdotool key --clearmodifiers "$@"
  sleep 2
  shot "$name-after.png"
  local d
  d="$(compare -metric AE "$OUT/$name-before.png" "$OUT/$name-after.png" null: 2>&1 | tr -d '\n' || true)"
  if awk -v d="${d:-0}" 'BEGIN{exit !(d+0>2000)}'; then
    step "$name" ok "$label — screen changed by ${d} px"
  else
    step "$name" fail "$label — screen barely changed (${d:-0} px)"
  fi
  xdotool key --clearmodifiers Escape; sleep 0.6
}
focus_editor; open_doc op-ui.js; focus_editor
ui_changed ops.findWidget    "Ctrl+F opens the find widget"      ctrl+f
ui_changed ops.replaceWidget "Ctrl+H opens find+replace"         ctrl+h
ui_changed ops.gotoLine      "Ctrl+G opens Go to Line/Column"    ctrl+g
ui_changed ops.settings      "Ctrl+, opens the Settings editor"  ctrl+comma
# Ctrl+, opens Settings as a full editor tab; close it so it cannot swallow the
# keystrokes of the steps that follow.
xdotool key --clearmodifiers ctrl+w; sleep 1

# 6.12 sidebar toggle — Ctrl+B, then toggle back.
shot "ops.sidebar-before.png"
xdotool key --clearmodifiers ctrl+b; sleep 2
shot "ops.sidebar-after.png"
SB="$(compare -metric AE "$OUT/ops.sidebar-before.png" "$OUT/ops.sidebar-after.png" null: 2>&1 | tr -d '\n' || true)"
if awk -v d="${SB:-0}" 'BEGIN{exit !(d+0>2000)}'; then
  step "ops.toggleSidebar" ok "Ctrl+B toggled the sidebar — screen changed by ${SB} px"
else
  step "ops.toggleSidebar" fail "Ctrl+B did not change the sidebar (${SB:-0} px)"
fi
xdotool key --clearmodifiers ctrl+b; sleep 1.2

# 6.13 panel toggle — Ctrl+J.
shot "ops.panel-before.png"
xdotool key --clearmodifiers ctrl+j; sleep 2
shot "ops.panel-after.png"
PJ="$(compare -metric AE "$OUT/ops.panel-before.png" "$OUT/ops.panel-after.png" null: 2>&1 | tr -d '\n' || true)"
if awk -v d="${PJ:-0}" 'BEGIN{exit !(d+0>2000)}'; then
  step "ops.togglePanel" ok "Ctrl+J toggled the panel — screen changed by ${PJ} px"
else
  step "ops.togglePanel" fail "Ctrl+J did not change the panel (${PJ:-0} px)"
fi
xdotool key --clearmodifiers ctrl+j; sleep 1.2

# 6.14 zoom in — Ctrl+= scales the workbench, Ctrl+0 restores it.
focus_editor
shot "ops.zoom-before.png"
xdotool key --clearmodifiers ctrl+equal; sleep 2
shot "ops.zoom-after.png"
ZM="$(compare -metric AE "$OUT/ops.zoom-before.png" "$OUT/ops.zoom-after.png" null: 2>&1 | tr -d '\n' || true)"
if awk -v d="${ZM:-0}" 'BEGIN{exit !(d+0>2000)}'; then
  step "ops.zoom" ok "Ctrl+= scaled the workbench — screen changed by ${ZM} px"
else
  step "ops.zoom" fail "Ctrl+= did not zoom (${ZM:-0} px)"
fi
xdotool key --clearmodifiers ctrl+0; sleep 1.5

# --- 7. wrap up -------------------------------------------------------------
if [ "${E2E_KEEP:-0}" != "1" ]; then
  kill "$APP_PID" 2>/dev/null
  sleep 1
fi

cat > "$OUT/evidence.json" <<JSON
{
  "at": "$(date -Iseconds)",
  "binary": "$BIN",
  "display": "$DISPLAY_NUM",
  "workspace": "$WORKSPACE",
  "windowTitle": "$TITLE",
  "marker": "$MARKER",
  "passed": $PASS,
  "failed": $FAIL,
  "gaps": $GAPS,
  "screenshots": [
    "01-startup.png",
    "03-quick-open.png",
    "04-opened.png",
    "04a-before-palette.png",
    "04b-command-palette.png",
    "05-typed.png",
    "06-saved.png",
    "ops.findWidget-after.png",
    "ops.replaceWidget-after.png",
    "ops.gotoLine-after.png",
    "ops.settings-after.png",
    "ops.sidebar-after.png",
    "ops.panel-after.png",
    "ops.zoom-after.png"
  ]
}
JSON

echo
echo "$PASS passed, $FAIL failed, $GAPS known VS Code parity gap(s)  (evidence: $OUT)"
[ "$FAIL" -eq 0 ]
