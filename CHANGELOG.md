## Unreleased

### Fixed
- **macOS Markdown Editor (WYSIWYG) blank / broken after open**: webview host injected `acquireVsCodeApi` as an un-nonced inline script while the editor CSP used `script-src 'nonce-…'`, so the bridge was blocked (Preview uses `'unsafe-inline'` and was fine). Host now copies the document nonce onto `_vscodeApiScript`; editor bootstrap also installs an `acquireVsCodeApi` fallback before `import(editor.js)`.

### Improved
- **Diagnosable Markdown/webview blank hangs**: Markdown Editor bootstrap/import failures post `bootstrapFailed` to the host (`_logService.warn`); relative-image data-URI inline misses warn once per resource; Preview logs when HTML is set / model defer; webview host `console.warn`s Safari SW skip (existing), SW ready timeout, and 8s content-never-arrived.


### Fixed
- **macOS Markdown Preview relative images**: Strict sanitizer no longer strips workspace-relative `img src` before rewrite; on Tauri, small local images are inlined as `data:` URIs (WKWebView nested iframes often fail custom schemes). Also prefer Tauri `convertFileSrc` / `asset.localhost` when available.
- **macOS Markdown Editor (WYSIWYG) blank pane**: load `markdown-editor-out` via classic-script `import()` instead of `<script type="module" src>` after `document.write` (WKWebView), and use the asset pack as `<base>` instead of `file://`.
- **Product defaults**: `.md` opens the text editor (not WYSIWYG); `.pdf` opens `sidex.pdf.preview`. WYSIWYG remains available via Open With.

### Changed
- Minor KaTeX display CSS to reduce overlap when fonts settle late on WKWebView.

### Fixed / Improved
- Markdown Preview default `markdown.preview.fontSize` raised to **16**; macOS `editor.fontSize` default raised to **14** for readability.
- Webview host and Markdown Editor show a bilingual empty/loading hint instead of a pure black pane when content is slow or fails to load.
- Markdown Preview relative image `src` encoding uses `toString(true)` for safer `sidex-asset` URLs.

# Changelog

## Unreleased — macOS Markdown Preview blank fix

### Fixed
- **macOS Markdown Preview relative images** after the WKWebView service-worker
  skip: `asWebviewUri(file://…)` now returns `sidex-asset://…` under Tauri so
  local images load without the vscode-resource SW; CSP allows `sidex-asset:`.
- **macOS: built-in Markdown Preview stayed blank.** Tauri on Mac uses WKWebView.
  After restoring `useHttpsScheme` (so the origin is `https://tauri.localhost`), the
  webview host tried to register a service worker and waited forever for
  `controllerchange`, which WKWebView often never fires for that host. `setHtml`
  content was never written, so Preview / Markdown Editor panes stayed empty.
  The host now **skips the service worker on Safari/WKWebView**, times out SW
  readiness elsewhere, and continues rendering even if SW setup fails.
- **KaTeX stylesheet in Preview** now uses a same-origin `/katex/...` URL so math
  CSS loads without the vscode-resource service worker (needed on Mac after the
  SW skip).
- **`public/webview-pre` drifted from source** — packaged builds serve `public/`.
  Synced and `postbuild` now copies `src/.../webview/browser/pre` → `public` + `dist`.

### Tests
- `npm run smoke:macos-md-preview` (also part of `npm test`)


## 0.1.13 — 2026-10-14

### Fixed
- **A user-installed extension only ever got its themes registered.**
  `_applyExtensionPointContributions()` (previously `_applyThemeExtensionPoints`)
  filtered the extension points down to `themes` / `iconThemes` /
  `productIconThemes`, so a marketplace extension's `commands`, `menus`,
  `keybindings`, `grammars`, `configuration`, … never reached the workbench.
  The extension activated and its language server ran, but none of its commands
  were in the command palette and its editor-title actions were missing — it
  looked installed yet could not actually be driven. Every extension point is
  now fed from the disk extensions as well, each wrapped so that one point
  rejecting the users cannot skip the rest.

### Tests
- `npm run e2e:typst` now exercises the extension's real flows end to end:
  language resolution, LSP activation, live edits, `Export … as PDF` (asserts
  the PDF lands next to the file), `Typst Preview` (asserts the webview panel is
  created and receives the rendered document) and diagnostics.

## 0.1.12 — 2026-10-14

### Fixed
- **macOS: the main window silently lost its entire configuration.** Tauri
  merges `tauri.macos.conf.json` into `tauri.conf.json` with JSON Merge Patch
  (RFC 7396), where an array is replaced wholesale. The macOS override declared
  `app.windows[0]` only to switch on native decorations, so on macOS the window
  lost its title, size, `visible: false`, the background colour, drag-and-drop
  and `useHttpsScheme`. Dropping `useHttpsScheme` moves the webview origin from
  `https://tauri.localhost` to `tauri://localhost`, which changes how
  custom-scheme subresources are treated — the likely cause of icons not
  rendering on macOS, since extension icon fonts are loaded through
  `sidex-asset://`. The override now carries the complete window config.
- Guarded by a new `npm run test:platform-config`, which re-applies Tauri's own
  merge to `tauri.conf.json` plus each platform override and asserts the
  resulting window and bundle configuration (including `icons/icon.icns` and
  the bundled resources), so an override can no longer clobber them.

## 0.1.11 — 2026-10-14

### Added
- **Node extensions can run.** Real VS Code extensions now activate and reach the
  workbench: the extension host derives the implicit `onLanguage:*` /
  `onCommand:*` / `onView:*` / `onDebug*` / … activation events from
  `contributes` (VS Code semantics) instead of only honouring an explicit
  `activationEvents` list, and the workbench registers a user-installed
  extension's `contributes.languages` so its files open with the right language
  id instead of Plain Text.
- **Tinymist (Typst) works end to end.** With `myriad-dreamin.tinymist` installed
  (plus the `tinymist` server binary on `PATH` or `tinymist.serverPath`), a
  `.typ` file gets the `typst` language, the language server starts, edits sync
  live and diagnostics show up. Covered by `npm run e2e:typst`.
- `vscode.DocumentDropOrPasteEditKind` in the extension-host `vscode` shim; its
  absence aborted activation of tinymist and markdown-language-features.

### Fixed
- **Release builds now log.** `tauri-plugin-log` was only installed in debug
  builds, so every `log::` record — including the extension host's forwarded
  stderr — was dropped. Setting `SIDEX_LOG` raises the level to debug.

### Notes
- Node-based extensions need a system `node` (>= 18) on `PATH`; SideX does not
  bundle one yet, and without it the extension host fails to start.

## 0.1.10 — 2026-10-14

### Fixed
- **Go to Line/Column (Ctrl+G) did nothing.** `workbench.action.gotoLine` was
  never registered: the only thing importing
  `contrib/codeEditor/browser/quickaccess/gotoLineQuickAccess.ts` was the
  `codeEditor.contribution` barrel, and that file had been removed. Restored the
  quick-access provider, the `GotoLineAction` / `GotoOffsetAction` actions and
  the `Ctrl+G` keybinding, and wired the module back into `workbench.common.main`.
- **Zoom (Ctrl+= / Ctrl+- / Ctrl+0) did nothing.** The workbench runs in a system
  webview now, so the Electron native zoom was gone and nothing replaced it. Added
  `browser/actions/zoomActions.ts`: `workbench.action.zoomIn` / `zoomOut` /
  `zoomReset`, the `window.zoomLevel` setting, and a CSS `zoom` on the workbench
  container that follows the setting on startup and on change.
- **No language support — every file opened as Plain Text.** `npm run build` never
  ran `scripts/setup-extensions.sh`, so the built-in extension catalog was empty
  in the shipped artifacts (only `release.yml` populated it). `build` now runs it,
  so `.js` / `.ts` / `.py` / `.md` and the rest open with a real language mode,
  file icons and grammar.
- **Toggle Line Comment (Ctrl+/) was a no-op.** `languageConfigurationExtensionPoint.ts`
  had been replaced by a 10-line stub, so no comment token / indentation rule was
  ever registered for any language. Restored the real `LanguageConfigurationFileHandler`.

### Tests
- **`scripts/e2e/gui-smoke.sh`** now covers the everyday editor gestures in
  addition to boot + quick open + save: undo, redo, move / delete / duplicate
  line, toggle comment, cut and paste assert on the file on disk; find,
  find+replace, go-to-line, settings, sidebar, panel and zoom assert on a real
  before/after pixel delta. 25 checks, all green on Linux.

## 0.1.9 — 2026-10-14

### Added
- **Extension host: custom document lifecycle** (`host.cjs`). `openCustomDocument`
  results are tracked by panel and by resource; `onDidChangeCustomDocument` is
  forwarded to the workbench as `customDocumentDirty`; new protocol handlers
  `saveCustomDocument` / `saveCustomDocumentAs` / `revertCustomDocument` /
  `backupCustomDocument` / `deleteCustomDocumentBackup`; closing an editor
  unsubscribes, disposes the document and clears the indexes.
- **Workbench: custom editor module** (`contrib/customEditor`). The whole module
  had been reduced to four stubs, so `contributes.customEditors` had nowhere to
  land. Restored and registered in `workbench.common.main` — `CustomEditorInput`,
  the input serializer, the working-copy handler, the capability registry and the
  `contributes.customEditors` extension point.
- **Node unit suite** `scripts/test-ext-host.mjs` (12 cases) and a CI job for it.
- **Native GUI e2e** `scripts/e2e/gui-smoke.sh`: Xvfb + openbox + xdotool + scrot,
  asserting on observable results (workbench painted, quick open shown, command
  palette shown, Ctrl+S persisted to disk with the original line intact), plus a
  `Native GUI e2e` workflow.
- `docs/SIDEX-DEVELOPMENT-PLAN.md` — batched plan with per-batch acceptance
  criteria and test method.

### Fixed
- **Disk extension theme contributions.** `_syncDiskThemeExtensions` and
  `_registerDiskExtensionWithWorkbench` were called but never defined, so every
  call threw and was swallowed. They now read installed manifests over the bridge
  (new `extension_read_manifest_json` command) and feed the `themes` /
  `iconThemes` / `productIconThemes` extension points with the union of the
  extension service's descriptions and the disk ones, re-applying on
  `onDidChangeExtensions`.
- Native e2e command-palette assertion was a false positive (the welcome editor
  rotates its hint text); it now diffs a static editor.

### Notes
- Known debt, unchanged: `prettier --check` (178 files), `cargo fmt` (141 files),
  and 7 pre-existing `tsc` errors in unrelated files.


## 0.1.15 — 2026-10-13

### Fixed
- **Cross-platform terminal:** Windows `profiles`/`env`, drop hardcoded defaultProfile so `$SHELL`/pwsh detection wins; path basename works on `\\` paths.
- **Fish:** Rust no longer forces `-l` when args are unset (VS Code profile align + SI inject).
- **CLI `--install-cli`:** Windows uses `%LOCALAPPDATA%\\SideX\\bin` and `;` PATH checks.
- **Keybinding sensing:** chord timeout **5s** (was 3); `cmdorctrl`/`option` aliases; META labels Cmd/Win; Win/Linux **Ctrl+Y** redo.

### Verification
- `smoke:compat` 18/18, `smoke:terminal` 13/13, `smoke:ux` 30/30
- `sidex-keymap` 88 tests; terminal 4; cli 9


## 0.1.13 — 2026-10-13

### Added
- **UX / VS Code 1.141:** editor tab styles (`connected` / `pill`) via `workbench.experimental.modernUIEditorTabStyle` + Command Palette actions.
- **UX:** View → Appearance → **Layout Density** toggle (`sidex.ux.toggleLayoutDensity`).
- **UX:** compact editor tab height class when `window.density.layout` or `window.density.editorTabHeight` is compact.

### Fixed
- **Empty editor watermark:** shortcut labels use theme tokens (were near-invisible `#303030` on SideX dark).
- **Version sync:** `tauri.conf.json` caught up with package / Cargo / lock (**0.1.13**).

### Notes
- Perf work stays secondary; no speculative cold-path changes this tag.
- CI workflows unchanged (cloud-build + release only).


## 0.1.12 — 2026-10-13

### Fixed
- **CI / cloud-build:** sync workspace `Cargo.lock` after the 0.1.11 package version bump so Linux/Windows `cargo build --locked` succeeds again.
- **CI / attach to release:** `gh release` commands now pass `-R $GITHUB_REPOSITORY` because the attach job has no git checkout (was: `fatal: not a git repository`).

## 0.1.11

### Fixed
- **PDF Preview:** EmbedPDF pages actually paint (was empty dark canvas). Root cause: `page-width` zoom against a zero-sized host. Now uses `fit-page`, ArrayBuffer `documentManager` open, wasm probe, and layout resize nudge.
- **File icons:** Packaged builds must ship `extensions/theme-seti` + non-empty `builtin-extensions.js` (postbuild guard). E2E validates explorer icon pixels, not smoke-only.


## 0.1.10 — 2026-10-13

### Fixed
- **E2E:** cargo-built Linux/Windows SideX opened a blank window unless Vite was on `:1420`. Added `scripts/ensure-frontend-server.sh`, wired it into `scripts/sidex`, and wrap cloud-build Linux `SideX` so packaged `dist/` is served automatically. Documented in `docs/CLOUD-BUILD.md` + `docs/DEV_NOTES_E2E_STARTUP.md`.

### Verification
- Native Xvfb E2E: startup trace, explorer, terminal, palette, markdown open; PDF toolbar/assets load (canvas paint under software GL still partial).
- `smoke:startup` 9/9, `smoke:pdf` 8/8, `smoke:remote-ssh` 39/39, interactive web 5/5.

## 0.1.9 — 2026-10-13

### Fixed
- **PDF / EmbedPDF:** seed `public/pdfium.wasm` via `scripts/ensure-pdfium-wasm.sh` (setup + cloud-build) so `/pdfium.wasm` is same-origin; stop relying on EmbedPDF’s jsDelivr default. Safe Uint8Array→Blob copy for WebKit/Tauri.
- **Cloud build `--locked`:** regenerate workspace `Cargo.lock` (syn / aws-lc bumps) so Linux/Windows `cargo build --locked` succeeds.
- **CLI:** `sidex --version` / `--help` never open a GUI (shell fast-path); `--install-cli` prefers a binary with early-CLI.
- **Smoke:** startup `windowMark` recorded when setup+window arrive in one chunk.

### Perf
- PDF open path prefers cached `/pdfium.wasm` (no CDN RTT / no HEAD probe). Native startup markers documented in `docs/DEV_NOTES_ISSUES_PERF.md`.



## 0.1.6 — 2026-10-13

### Added
- **Remote SSH behavior matrix** (`DEV_NOTES_REMOTE_SSH.md`) with pass/fixed/unsupported coverage modeled on open-remote-ssh + russh.
- Multi-sshd lab (`scripts/remote-ssh-lab.sh`) and live suite `cargo test -p sidex-remote --test live_ssh` (44 tests).
- SSH config parser: Include, wildcards, ProxyJump/ProxyCommand, Match, tokens.
- Coded errors `[SIDEX_*]` (timeout, refused, host key, auth, FS errno, unsupported).
- `remote_cancel_connect`, `remote_reconnect`, `remote_detect_platform`, `remote_forward_port`.
- Commands: **Close Remote Connection**, **Open SSH Remote Authority**; passphrase prompt; friendly host-key errors.
- host.cjs: real `registerRemoteAuthorityResolver`; route ssh-remote openFolder → SideX connector.

### Fixed
- Host key verification (TOFU / strict / changed).
- Real ssh-agent auth + default identity files; encrypted keys.
- Password → keyboard-interactive (kbd-first, empty PAM prompts).
- ProxyJump via `direct-tcpip` + `connect_stream`; ProxyCommand via child stdio.
- Connect timeout; parallel hosts (Arc transport, no lock across await).
- Fish/zsh-safe remote scripts (base64 env wrap); binary/large file write via stdin `cat >`.
- Safe path quoting; symlink-aware stat/readdir; PTY resize; local forward port 0.
- Keepalive via russh Config (no leaking session channels).

### Unchanged / still green
- Open With ↔ VS Code UX (421fc7e), preview plugins + MD Diff WYSIWYG, Tauri 2.12 startup smokes, AI default-off, EmbedPDF path.

### Unsupported (fail gracefully)
- Reverse port forward, OTP kbd-interactive, file watching, recent hosts, jeanp413 server install/websocket.


## Unreleased (post-0.1.5) — Open With ↔ VS Code UX

### Fixed
- **Open With / Reopen With hope = actual:** picker no longer double-lists workbench Markdown hosts from `markdown-language-features` contributes, and no longer shows fake marketplace PDF entries labeled "(via EmbedPDF)" that always opened EmbedPDF. Built-in options only where they work.
- **VS Code-shaped choices:** `.md` → Text Editor (default) + **Markdown Preview** (`vscode.markdown.preview.editor`) + **Markdown Editor** (`vscode.markdown.editor`, Diff via `createDiffEditorInput`); `.pdf` → Text Editor + **PDF Preview** (EmbedPDF, default). Marketplace non-PDF preview `customEditors` still appear and resolve via the webview bridge.

### Changed
- Markdown Preview viewType aligned to VS Code id `vscode.markdown.preview.editor` (was `sidex.markdown.preview`).
- PDF Open With label shortened to **PDF Preview** (detail: EmbedPDF).

## Unreleased (post-0.1.5) — Preview plugins + Markdown Diff WYSIWYG

### Fixed
- **Marketplace preview plugins actually run:** non-PDF `customEditors` were deferred after install. Extension host now implements `resolveCustomEditor` / `customEditorClosed`; workbench opens a webview and resolves CustomTextEditor / CustomReadonlyEditor providers (SVG/HTML/Markdown preview-style extensions). PDF still uses built-in EmbedPDF.

### Added
- **Markdown Diff Editor (WYSIWYG):** side-by-side original|modified via `SideBySideEditorInput` + standalone `markdown-editor-out` hosts. Command / title: `Markdown: Open Markdown Diff Editor`; resolver `createDiffEditorInput` for `vscode.markdown.editor` (Reopen With on diffs).
- `npm run smoke:preview-md-diff` — static + live host resolve smoke (`smoke-artifacts/preview-md-diff-evidence.json`).

### Note
- Inline `customEditorDiffs` change-highlight API not ported yet; AI default-off / EmbedPDF / MD WYSIWYG single editor unchanged. No release tag in this push.

## Unreleased (post-0.1.5) — Tauri pin + startup smoke

### Changed
- **Tauri 2.x pins** in `src-tauri/Cargo.toml` to latest stable 2.x (not 3.0 alpha): `tauri` **2.12.3**, `tauri-build` **2.7.2**, `tauri-plugin-{log,dialog,shell}` **2.10 / 2.8 / 2.5**, single-instance **2.5.3**, deep-link **2.6.1**. Compatible with rustc **1.99** (crates require ≥1.90).
- **Startup cold path:** document essential plugins (dialog/shell/single-instance/deep-link); `tauri-plugin-log` remains debug-only; Linux deep-link `register_all` moved off the critical path (background thread after window show).
- **`SIDEX_STARTUP_TRACE=1`:** stderr markers for builder / window restore / setup complete (AI server still not started).
- AI default-off + Wasmtime lazy engine **re-verified**.

### Added
- `scripts/smoke-startup.mjs` — web time-to-workbench + optional Xvfb native binary smoke; evidence in `smoke-artifacts/startup-evidence.json`.

### Note for next tag
- Box measured: native setup-complete **~515ms** (trace), web workbench **~2.3s** total; include in **0.1.6** release notes / cloud artifacts when tagging.

## 0.1.5 — 2026-10-12

Follow-up on the same day as 0.1.4 (Asia/Shanghai).

### Changed
- **Toolchain:** box/dev **rustc/cargo 1.99.0** (latest stable); workspace + `src-tauri` `rust-version` **1.99.0** (was 1.91).
- **Wasmtime 43 → 49.0.2** (needs Rust ≥1.96; now allowed). Engine still **lazy** on first WASM extension load.
- Synced `package-lock.json` so CI `npm ci` works (cloud-build on `v0.1.4` failed on lock drift).
- Cheap `dead_code` allows on unused TextMate/storage helpers; `cargo fix` unused imports.

### Build / release
- Local: `npm run build` + `cargo build --release` (relaxed profile OK for testing).
- Tag **v0.1.5**; unsigned multi-OS via `cloud-build.yml`.

## 0.1.4 — 2026-10-12

LAB-707 / Grok Bot box pass on `chocolatedesue/sidex` (Asia/Shanghai).

### Added
- **Markdown WYSIWYG (所见即所得):** hosts VS Code **1.141** `markdown-editor-out` webview (`Markdown: Open Markdown Editor`, title-bar icon, Reopen With). Side preview remains `Ctrl+K` then `V` (KeyChord).
- **EmbedPDF EditorPane** (`@embedpdf/snippet`): default for `.pdf` / Reopen With — replaces earlier pdf.js pane; worker off + fontFallback null to avoid init hang.
- Open VSX / siden marketplace: search fallback, gallery query, **install-by-id** resolves download URL then `install_extension_from_url`.
- Web smoke scripts: `scripts/smoke-marketplace-pdf.mjs`, `scripts/smoke-interactive-web.mjs`.
- Docs: `CROSS_VALIDATION_REPORT.md`, `DEV_NOTES_MD_WYSIWYG.md`, `docs/CLOUD-BUILD.md`.

### Changed
- AI chat **default off** (`sidex.chat.enabled` false); agent server not started unless enabled.
- `index.html` `__SIDEX_TAURI__` detects real Tauri (no longer hard-coded true on web).
- Toolchain: **rustc 1.91**; Wasmtime engine **lazy** on first WASM extension load; macOS PATH probe faster; PDF open path drops an extra buffer copy.
- npm patch bumps (vite 6.4.4, eslint/prettier/playwright, tauri plugins, …); cargo lock updates within wasmtime **43.x**.

### Known limits
- Full Tauri GUI / extension-host activate E2E prefers cloud-build or a desktop with display.
- Non-PDF extension `customEditors` still need webview `resolveCustomEditor` bridge.
- MD Diff Editor WYSIWYG not ported.

## 0.1.3

Prior fork baseline before the LAB-707 Markdown / EmbedPDF / marketplace pass.

## Unreleased (post-0.1.5) — Remote SSH plugin adaptation

### Added
- **Built-in Remote SSH (plugin-shaped):** after Connect to Host / Remote Explorer SSH connect, SideX binds `ssh-remote+user@host`, registers a `vscode-remote` FileSystemProvider over `sidex-remote`, resolves the authority (`ManagedRemoteConnection`), and offers **Open Remote Home / Other Folder**.
- **Remote FS Tauri commands:** `remote_read_dir` / `remote_read_file` / `remote_write_file` / `remote_stat` / `remote_home` / `remote_mkdir` / `remote_delete` / `remote_rename`.
- **Open VSX Remote SSH hooks:** `extensionEnabledApiProposals` for `jeanp413.open-remote-ssh` (`resolvers`, `tunnels`, `contribRemoteHelp`, `contribViewsRemote`) in bootstrap + product fallback.
- **Authority resolver:** deferred `resolveAuthority` + working `_setResolvedAuthority` (no longer stub-throws).
- Auth fallback: SSH agent → identity file from `~/.ssh/config` → password prompt.
- **SSH exec exit status:** `sidex-remote` `exec_inner` now reads `ChannelMsg::ExitStatus` (was stuck at `-1`, breaking `remote_home` / read_file checks).
- Live example: `cargo run -p sidex-remote --example ssh_localhost_smoke` (default `127.0.0.1:2222`).
- `npm run smoke:remote-ssh` (+ optional `SIDEX_SMOKE_SSH=user@host`).

### Note / limits
- Built-in path does **not** install Microsoft/VSCodium “VS Code Server” on the remote; it uses SideX’s Rust SSH transport for FS. Full `jeanp413.open-remote-ssh` server download still needs a healthy Node extension host + matching server build.
- Remote file watching and remote PTY terminal UI not wired in this pass.
- EmbedPDF / Markdown WYSIWYG / Open With / AI-off unchanged.
