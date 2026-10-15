import fs from 'fs';
import path from 'path';

const DIST_DIR = 'dist';
const ASSETS_DIR = path.join(DIST_DIR, 'assets');

function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} kB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileSizes(dir, extension) {
	if (!fs.existsSync(dir)) return { total: 0, files: [] };

	const files = fs
		.readdirSync(dir)
		.filter(f => f.endsWith(extension))
		.map(f => ({
			name: f,
			size: fs.statSync(path.join(dir, f)).size
		}))
		.sort((a, b) => b.size - a.size);

	return {
		total: files.reduce((sum, f) => sum + f.size, 0),
		files
	};
}

// Webview host page ships from public/webview-pre (Vite publicDir), but the
// editable source of truth is src/vs/workbench/contrib/webview/browser/pre/.
// Keep dist (and public) in sync so macOS/Tauri builds pick up WKWebView fixes.
const WEBVIEW_PRE_SRC = path.join('src', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre');
const WEBVIEW_PRE_PUBLIC = path.join('public', 'webview-pre');
const WEBVIEW_PRE_DIST = path.join(DIST_DIR, 'webview-pre');
if (fs.existsSync(WEBVIEW_PRE_SRC)) {
	fs.cpSync(WEBVIEW_PRE_SRC, WEBVIEW_PRE_PUBLIC, { recursive: true, force: true });
	fs.cpSync(WEBVIEW_PRE_SRC, WEBVIEW_PRE_DIST, { recursive: true, force: true });
	console.log('Post-build: synced webview-pre (src → public + dist)\n');
} else {
	console.warn('Post-build: webview-pre source missing — packaged webviews may be stale\n');
}

// Copy extensions
if (fs.existsSync('extensions')) {
	fs.cpSync('extensions', path.join(DIST_DIR, 'extensions'), { recursive: true, force: true });
}
if (fs.existsSync('extensions-meta.json')) {
	fs.copyFileSync('extensions-meta.json', path.join(DIST_DIR, 'extensions-meta.json'));
}
console.log('Post-build: copied extensions\n');

const mdEditorJs = path.join(DIST_DIR, 'extensions', 'markdown-language-features', 'markdown-editor-out', 'editor.js');
if (!fs.existsSync(mdEditorJs)) {
	console.error(
		'Post-build: markdown-editor-out/editor.js missing — Markdown Editor (WYSIWYG) would stay blank. Run bash scripts/setup-extensions.sh'
	);
	process.exit(1);
}
console.log('Post-build: markdown-editor-out present\n');


// File icons require theme-seti under dist/extensions (E2E + packaged builds).
const setiWoff = path.join(DIST_DIR, 'extensions', 'theme-seti', 'icons', 'seti.woff');
const setiJson = path.join(DIST_DIR, 'extensions', 'theme-seti', 'icons', 'vs-seti-icon-theme.json');
if (!fs.existsSync(setiWoff) || !fs.existsSync(setiJson)) {
	console.error('Post-build: theme-seti missing under dist/extensions — run npm run setup');
	process.exit(1);
}
const builtinJs = path.join(DIST_DIR, 'builtin-extensions.js');
if (fs.existsSync(builtinJs)) {
	const builtin = fs.readFileSync(builtinJs, 'utf8');
	if (!builtin.includes('theme-seti')) {
		console.error('Post-build: dist/builtin-extensions.js does not list theme-seti');
		process.exit(1);
	}
}


// EmbedPDF (LAB-707) needs PDFium WASM next to the app. public/ copies on Vite
// build, but keep an explicit fallback from node_modules for cloud/CI caches.
const PDFIUM_CANDIDATES = [
	path.join('public', 'pdfium.wasm'),
	path.join('node_modules', '@embedpdf', 'snippet', 'dist', 'pdfium.wasm'),
	path.join('node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm'),
];
const pdfiumDest = path.join(DIST_DIR, 'pdfium.wasm');
let copiedPdfium = false;
for (const src of PDFIUM_CANDIDATES) {
	if (fs.existsSync(src)) {
		fs.copyFileSync(src, pdfiumDest);
		console.log(`Post-build: copied ${src} → ${pdfiumDest}\n`);
		copiedPdfium = true;
		break;
	}
}
if (!copiedPdfium) {
	console.warn('Post-build: pdfium.wasm not found — EmbedPDF PDF preview will fail\n');
}


// The markdown preview renders KaTeX itself (it is bundled), but the
// stylesheet and the fonts it pulls in are fetched at runtime. Vite serves
// those from the project in dev; a build has to copy them next to the app.
// Deliberately NOT into `dist/node_modules`: Tauri's bundler refuses to bundle
// a frontendDist that contains a top-level `node_modules` folder, which is what
// broke the macOS `.app` build.
const KATEX_SRC = path.join('node_modules', 'katex', 'dist');
const KATEX_DEST = path.join(DIST_DIR, 'katex');
if (fs.existsSync(KATEX_SRC)) {
	fs.cpSync(KATEX_SRC, KATEX_DEST, { recursive: true, force: true });
	console.log(`Post-build: copied the katex stylesheet + fonts to ${KATEX_DEST}\n`);

	// Prefer block display so first paint waits for KaTeX metrics (fewer superscript overlaps).
	try {
		const katexCss = path.join(KATEX_DEST, 'katex.min.css');
		if (fs.existsSync(katexCss)) {
			let css = fs.readFileSync(katexCss, 'utf8');
			if (!css.includes('font-display')) {
				css = css.replace(/@font-face\s*\{/g, '@font-face{font-display:block;');
				fs.writeFileSync(katexCss, css);
				console.log('Post-build: injected font-display:block into katex.min.css');
			}
		}
	} catch (e) {
		console.warn('Post-build: could not patch katex font-display', e);
	}

} else {
	console.warn('Post-build: node_modules/katex not found — markdown math will not render in this build\n');
}

// Calculate bundle sizes
const js = getFileSizes(ASSETS_DIR, '.js');
const css = getFileSizes(ASSETS_DIR, '.css');
const wasm = getFileSizes(ASSETS_DIR, '.wasm');
const other = getFileSizes(ASSETS_DIR, '.ttf');

console.log('═══════════════════════════════════════════════════════════');
console.log('                    BUNDLE SIZE SUMMARY                     ');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  JavaScript:  ${formatSize(js.total).padStart(12)}`);
console.log(`  CSS:         ${formatSize(css.total).padStart(12)}`);
console.log(`  Fonts:       ${formatSize(other.total).padStart(12)}`);
console.log(`  WASM:        ${formatSize(wasm.total).padStart(12)}`);
console.log('───────────────────────────────────────────────────────────');
console.log(`  TOTAL:       ${formatSize(js.total + css.total + other.total + wasm.total).padStart(12)}`);
console.log('═══════════════════════════════════════════════════════════');

// Show top 5 largest JS files
console.log('\nTop 5 largest JS chunks:');
js.files.slice(0, 5).forEach((f, i) => {
	console.log(`  ${i + 1}. ${f.name.padEnd(50)} ${formatSize(f.size).padStart(10)}`);
});
console.log('');
