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

const failed = evidence.steps.filter((s) => !s.ok).length;
evidence.failed = failed;
evidence.passed = evidence.steps.length - failed;
fs.writeFileSync(path.join(outDir, 'macos-md-preview-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.steps.length} passed`);
process.exit(failed ? 1 : 0);
