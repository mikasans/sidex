#!/usr/bin/env node
/**
 * Smoke: macOS Markdown Preview must not hang on webview service worker.
 * Packaged Tauri on Mac uses WKWebView; with useHttpsScheme the origin is
 * https://tauri.localhost. Waiting forever for SW controllerchange blanks the
 * preview. Assert the host page skips SW on Safari and that public/ matches src.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'smoke-artifacts');
fs.mkdirSync(outDir, { recursive: true });

const evidence = { at: new Date().toISOString(), zone: 'Asia/Shanghai (UTC+8)', steps: [] };
const step = (name, ok, detail) => {
  evidence.steps.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

const srcPre = read('src/vs/workbench/contrib/webview/browser/pre/index.html');
const pubPre = read('public/webview-pre/index.html');

step('webviewPre.publicMatchesSrc', srcPre === pubPre, `src=${sha(srcPre)} public=${sha(pubPre)}`);
step('webviewPre.skipSwOnSafari', srcPre.includes('disableServiceWorkerRuntime = disableServiceWorker || !serviceWorkerProtocolSupported || isSafari'));
step('webviewPre.safariComment', srcPre.includes('WKWebView') && srcPre.includes('Markdown Preview'));
step('webviewPre.swTimeoutFallback', srcPre.includes('service worker ready timed out'));
step('webviewPre.swFailureContinues', srcPre.includes('still render HTML') || srcPre.includes('continuing so preview content can render') || srcPre.includes('Webview service worker issue (continuing)'));
step('webviewPre.useHttpsSchemeMac', read('src-tauri/tauri.macos.conf.json').includes('"useHttpsScheme": true'));

const preview = read('src/vs/workbench/contrib/markdown/browser/markdownPreview.ts');
step('mdPreview.katexSameOrigin', preview.includes('katexStylesheetHref()') && !preview.includes('asWebviewUri(katexStylesheetUri())'));
step('mdPreview.localResourceRootsOrigin', preview.includes('URI.parse(window.location.origin)'));

const katex = read('src/vs/workbench/contrib/markdown/browser/markedKatexSupport.ts');
step('katex.prodOriginUrl', katex.includes('${origin}/katex/katex.min.css') || katex.includes('`/${origin}/katex') || katex.includes('/katex/katex.min.css'));

// Relative images: without SW, asWebviewUri must not force vscode-cdn on Tauri file://.
const asWebview = read('src/vs/workbench/contrib/webview/common/webview.ts');
step(
  'asWebviewUri.tauriFileUsesSidexAsset',
  asWebview.includes("__SIDEX_TAURI__") &&
    asWebview.includes('sidex-asset://localhost/') &&
    asWebview.includes('Schemas.file')
);
step(
  'asWebviewUri.tauriPrefersConvertFileSrc',
  asWebview.includes('convertFileSrc') && asWebview.includes('asset.localhost')
);
step(
  'csp.sidexAssetAllowed',
  preview.includes('sidex-asset:') &&
    srcPre.includes('sidex-asset:') &&
    asWebview.includes('sidex-asset:')
);
step(
  'mdPreview.allowsRelativeMediaByDefault',
  preview.includes('allowRelativeMediaPaths: true') &&
    preview.includes('rewriteImageSrcsForTauri')
);
const editor = read('src/vs/workbench/contrib/markdown/browser/markdownEditor.ts');
step(
  'mdEditor.dynamicImportBootstrap',
  editor.includes('import(scriptUri)') &&
    editor.includes('`${assetBase}/`') &&
    !editor.includes('type="module" src="${scriptUri}"')
);
const contrib = read('src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts');
step(
  'mdDefaults.textEditorNotWysiwyg',
  contrib.includes("registerDefaultConfigurations") &&
    contrib.includes("'*.md': DEFAULT_EDITOR_ASSOCIATION.id") &&
    contrib.includes("'*.pdf': 'sidex.pdf.preview'") &&
    !contrib.includes("'*.md': MARKDOWN_EDITOR_VIEW_TYPE")
);
step(
  'mdEditor.bootstrapFailedHostWarn',
  editor.includes("type: 'bootstrapFailed'") &&
    editor.includes("bootstrap/import failed") &&
    editor.includes('reportBootstrapFail')
);
step(
  'webviewPre.nonceApiScriptForCsp',
  srcPre.includes('vscode-markdown-editor-script-nonce') &&
    srcPre.includes("defaultScript.setAttribute('nonce', nonce)") &&
    pubPre.includes("defaultScript.setAttribute('nonce', nonce)")
);
step(
  'mdEditor.acquireVsCodeApiFallback',
  editor.includes("installed acquireVsCodeApi fallback") &&
    editor.includes("__vscode_post_message__") &&
    editor.includes('allowMultipleAPIAcquire: true')
);
step(
  'mdEditor.defaultEditable',
  /private _readonly = false/.test(editor) &&
    /getBoolean\(READONLY_STATE_KEY, StorageScope\.PROFILE, false\)/.test(editor)
);
step(
  'mdPreview.inlineImageWarnOnce',
  preview.includes('warnInlineImageOnce') &&
    preview.includes('Could not inline relative image as data URI')
);
step(
  'webviewPre.contentNeverArrivedWarn',
  srcPre.includes('Content never arrived after 8s') &&
    srcPre.includes('service worker ready timed out after 2500ms')
);

const postbuild = read('scripts/postbuild.js');
step('postbuild.syncWebviewPre', postbuild.includes('webview-pre') && postbuild.includes('WEBVIEW_PRE_SRC'));
step(
  'postbuild.katexFontDisplayBlock',
  postbuild.includes('font-display:block') || postbuild.includes("font-display:block")
);

// --- Handfeel guards (UX-03/04/05/06/07/08/11 + editable/icons) ---
step(
  'mdPreview.chordEmptyStateNotify',
  preview.includes("markdownPreviewNeedFile") &&
    preview.includes('Open a Markdown file first') &&
    preview.includes('_notificationService.info')
);
step(
  'mdPreview.katexSuperscriptCss',
  preview.includes('.katex {') &&
    preview.includes('vertical-align: baseline') &&
    preview.includes('.katex-display')
);
step(
  'mdPreview.taskListCheckboxCss',
  preview.includes('input[type="checkbox"]') &&
    preview.includes('list-style: none') &&
    preview.includes('appearance: checkbox')
);
step(
  'mdDefaults.previewEditorOptionPriority',
  contrib.includes('RegisteredEditorPriority.option') &&
    contrib.includes('MARKDOWN_PREVIEW_VIEW_TYPE') &&
    contrib.includes('MARKDOWN_EDITOR_VIEW_TYPE') &&
    !contrib.includes('priority: RegisteredEditorPriority.default')
);
const chordMarker = contrib.indexOf('No `when` on these chords');
const chordSlice = chordMarker >= 0 ? contrib.slice(chordMarker, chordMarker + 700) : '';
step(
  'mdChord.previewToSideNoWhenGate',
  chordMarker >= 0 &&
    chordSlice.includes("id: 'markdown.showPreviewToSide'") &&
    chordSlice.includes('KeybindingsRegistry.registerCommandAndKeybindingRule') &&
    !chordSlice.includes('when: MARKDOWN_LANG_WHEN'),
  chordSlice.slice(0, 160).replace(/\s+/g, ' ')
);
step(
  'mdMigration.clearStaleWysiwygAssociation',
  contrib.includes('MarkdownStaleAssociationMigration') &&
    contrib.includes('sidex.markdown.clearedWysiwygAssociation.v1') &&
    contrib.includes('stale.has(viewType)') &&
    contrib.includes('DEFAULT_EDITOR_ASSOCIATION.id')
);
step(
  'mdFrontMatter.commandRegistered',
  contrib.includes("'_markdown.openFrontMatterSettings'") &&
    contrib.includes('markdown.preview.frontMatter')
);
const setupExt = read('scripts/setup-extensions.sh');
step(
  'mdFrontMatter.paletteHiddenInSetup',
  setupExt.includes('hide_broken_markdown_palette_commands') &&
    setupExt.includes('"_markdown.openFrontMatterSettings"') &&
    setupExt.includes('"when": "false"')
);
const mdPkg = path.join(root, 'extensions/markdown-language-features/package.json');
if (fs.existsSync(mdPkg)) {
  const pkg = JSON.parse(fs.readFileSync(mdPkg, 'utf8'));
  const menus = pkg?.contributes?.menus?.commandPalette || [];
  const fm = menus.find((m) => m.command === '_markdown.openFrontMatterSettings');
  step('mdFrontMatter.paletteWhenFalse', !!(fm && fm.when === 'false'), JSON.stringify(fm || null));
} else {
  step('mdFrontMatter.paletteWhenFalse', false, 'package.json missing');
}
step(
  'mdEditor.hostKatexCheckboxCss',
  editor.includes('.katex { font-size: 1.05em') &&
    editor.includes('.md-checkbox') &&
    editor.includes('border-radius: 3px !important')
);
step(
  'mdEditor.initialStateReadonlyFalse',
  editor.includes('readonly: this._readonly') &&
    /private _readonly = false/.test(editor)
);
const docRenderer = read('src/vs/workbench/contrib/markdown/browser/markdownDocumentRenderer.ts');
step(
  'mdStyles.gfmTaskListInDefaultStyles',
  docRenderer.includes('GFM task lists') &&
    docRenderer.includes('appearance: checkbox')
);
const extHost = read('src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts');
step(
  'pdfNag.skipMathematicActivate',
  extHost.includes('SKIP_ACTIVATE_EXTENSION_IDS') &&
    extHost.includes('mathematic.vscode-pdf') &&
    extHost.includes('Skip activate')
);
// Brand icon ≠ known Tauri placeholder face (byte size + sha of tip brand mark)
const iconPng = path.join(root, 'src-tauri/icons/icon.png');
const iconIcns = path.join(root, 'src-tauri/icons/icon.icns');
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'));
const iconList = tauriConf?.bundle?.icon || [];
const knownPlaceholderSha = '39c7140e774a6ac6836c4a9236d7863de474a5f68ec3e579bf8a46cd6f707fe0'; // 00-source-icon.png (Tauri face)
const brandSha = '549154e1edd89543ff91d63ea1695088c1b4304e341a559cc126bc4a19db5bb7'; // tip SideX brand
let iconOk = false;
let iconDetail = '';
if (fs.existsSync(iconPng) && fs.existsSync(iconIcns)) {
  const buf = fs.readFileSync(iconPng);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const icnsInBundle = iconList.some((i) => String(i).includes('icon.icns'));
  iconOk = sha === brandSha && sha !== knownPlaceholderSha && icnsInBundle;
  iconDetail = `sha=${sha.slice(0, 12)} size=${buf.length} icnsInBundle=${icnsInBundle}`;
} else {
  iconDetail = 'icon.png or icon.icns missing';
}
step('brandIcon.packagingTreeNotTauriPlaceholder', iconOk, iconDetail);

const failed = evidence.steps.filter((s) => !s.ok).length;
evidence.failed = failed;
evidence.passed = evidence.steps.length - failed;
fs.writeFileSync(path.join(outDir, 'macos-md-preview-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.steps.length} passed`);
process.exit(failed ? 1 : 0);
