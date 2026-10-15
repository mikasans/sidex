/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  SideX port of VS Code's Markdown Editor (WYSIWYG / 所见即所得).
 *  Reuses the shipped `markdown-editor-out` webview from
 *  `extensions/markdown-language-features` (VS Code ≥ 1.135 / 1.141),
 *  talking the same postMessage protocol the built-in editor.js expects.
 *  The TextModel remains the source of truth (undo/redo, dirty, hot-exit).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { IWebviewService } from '../../webview/browser/webview.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { WebviewInitInfo } from '../../webview/browser/webview.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';

/** Same viewType as VS Code `MarkdownEditorProvider.viewType`. */
export const MARKDOWN_EDITOR_VIEW_TYPE = 'vscode.markdown.editor';

const READONLY_STATE_KEY = 'markdown.editor.readonly';
const HAS_SCHEME = /^\w[\w\d+.-]*:/;

interface MarkdownEditorHostMessage {
	readonly type?: string;
	readonly documentVersion?: number;
	readonly editEpoch?: number;
	readonly start?: number;
	readonly endExclusive?: number;
	readonly text?: string;
	readonly href?: string;
	readonly readonly?: boolean;
	readonly focused?: boolean;
	readonly command?: 'undo' | 'redo';
	readonly message?: string;
	readonly requestId?: number;
	readonly providerId?: string;
	readonly language?: string;
	readonly runtimeId?: string;
	readonly runtimeKey?: string;
	readonly id?: string;
}

function encodeInitialState(state: object): string {
	return encodeURIComponent(JSON.stringify(state));
}

function markdownEditorAssetBase(): string {
	// Absolute origin URL so srcdoc webviews can resolve ES module chunks.
	const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
	return `${origin}/extensions/markdown-language-features/markdown-editor-out`;
}

function offsetToPosition(text: string, offset: number): { lineNumber: number; column: number } {
	const clamped = Math.max(0, Math.min(offset, text.length));
	let lineNumber = 1;
	let lastBreak = -1;
	for (let i = 0; i < clamped; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			lineNumber++;
			lastBreak = i;
		}
	}
	return { lineNumber, column: clamped - lastBreak };
}

/**
 * Host for VS Code's Markdown Editor webview (`markdown-editor-out/editor.js`).
 * Opens via "Reopen Editor With… → Markdown Editor" or the command palette.
 */
export class MarkdownEditorManager extends Disposable {
	static readonly ID = 'workbench.contrib.markdownEditor';

	private _webviewInput: WebviewInput | undefined;
	private readonly _webviewDisposables = this._register(new DisposableStore());
	private readonly _contentDisposables = this._register(new DisposableStore());
	private readonly _modelListen = this._register(new MutableDisposable());
	private _currentResource: URI | undefined;
	private _messageSecret = generateUuid();
	private _editEpoch = 0;
	private _applyingWebviewEdit = false;
	private _readonly = false;
	private _ready = false;
	/** Standalone panes (e.g. Markdown Diff sides) keyed by instance id. */
	private readonly _standalone = new Map<
		string,
		{
			input: WebviewInput;
			resource: URI;
			readonly: boolean;
			messageSecret: string;
			editEpoch: number;
			ready: boolean;
			applying: boolean;
			store: DisposableStore;
		}
	>();

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ILogService private readonly _logService: ILogService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService
	) {
		super();
		this._readonly = this._storageService.getBoolean(READONLY_STATE_KEY, StorageScope.PROFILE, false);
	}

	hasActiveEditor(): boolean {
		return this._webviewInput !== undefined && !this._webviewInput.isDisposed();
	}

	isReadonly(): boolean {
		return this._readonly;
	}

	showEditor(side?: boolean, preserveFocus = false): void {
		const resource = this._activeMarkdownResource() ?? this._currentResource;
		if (!resource) {
			this._logService.warn('[Markdown Editor] Active editor is not a markdown file');
			this._notificationService.warn(
				localize('markdownEditorNoFile', 'Open a Markdown file first, then open the Markdown Editor.')
			);
			return;
		}
		this._currentResource = resource;
		this._openOrCreate(resource, true, side, preserveFocus);
	}

	async createEditorInputWhenReady(resource: URI): Promise<EditorInput | undefined> {
		this._currentResource = resource;
		if (!this._textFileService.files.get(resource)) {
			try {
				await this._textFileService.files.resolve(resource);
			} catch (err) {
				this._logService.warn('[Markdown Editor] Could not load', resource.toString(), err);
			}
		}
		return this._openOrCreate(resource, true);
	}

	/**
	 * Create an independent Markdown Editor webview for Diff / multi-pane use.
	 * Does not replace the singleton "active" Markdown Editor instance.
	 */
	async createStandaloneEditorInput(
		resource: URI,
		options?: { readonly?: boolean; titlePrefix?: string; open?: boolean }
	): Promise<WebviewInput | undefined> {
		if (!this._textFileService.files.get(resource)) {
			try {
				await this._textFileService.files.resolve(resource);
			} catch (err) {
				this._logService.warn('[Markdown Editor] Could not load', resource.toString(), err);
			}
		}
		const readonly = options?.readonly ?? true;
		const name = resource.path.split('/').pop() || resource.path;
		const title = options?.titlePrefix
			? `${options.titlePrefix}: ${name}`
			: readonly
				? localize('markdownEditorLockedTitle', 'Markdown Editor (locked): {0}', name)
				: localize('markdownEditorEditingTitle', 'Markdown Editor: {0}', name);
		const instanceId = generateUuid();
		const messageSecret = generateUuid();
		const store = new DisposableStore();
		const initInfo = this._initInfo(resource, title);
		const open = options?.open !== false;
		const input = open
			? this._webviewWorkbenchService.openWebview(initInfo, MARKDOWN_EDITOR_VIEW_TYPE, title, undefined, {
					preserveFocus: true
				})
			: this._instantiationService.createInstance(
					WebviewInput,
					{
						viewType: MARKDOWN_EDITOR_VIEW_TYPE,
						name: title,
						providedId: initInfo.providedViewType,
						iconPath: undefined
					},
					this._webviewService.createWebviewOverlay(initInfo)
				);

		const session = {
			input,
			resource,
			readonly,
			messageSecret,
			editEpoch: 0,
			ready: false,
			applying: false,
			store
		};
		this._standalone.set(instanceId, session);
		this._register(store);

		store.add(
			input.onWillDispose(() => {
				store.dispose();
				this._standalone.delete(instanceId);
			})
		);
		store.add(input.webview.onMessage(event => this._onStandaloneMessage(instanceId, event.message)));

		// Initial HTML
		const fileModel = this._textFileService.files.get(resource);
		const text = fileModel?.isResolved() ? fileModel.textEditorModel.getValue(EndOfLinePreference.LF) : '';
		const version = fileModel?.isResolved() ? fileModel.textEditorModel.getVersionId() : 0;
		// Temporarily swap secrets/readonly for build helpers
		const prevSecret = this._messageSecret;
		const prevReadonly = this._readonly;
		const prevEpoch = this._editEpoch;
		this._messageSecret = messageSecret;
		this._readonly = readonly;
		this._editEpoch = 0;
		input.webview.setHtml(this._buildHtml(text, version, resource));
		this._messageSecret = prevSecret;
		this._readonly = prevReadonly;
		this._editEpoch = prevEpoch;

		if (fileModel?.isResolved()) {
			store.add(
				fileModel.textEditorModel.onDidChangeContent(() => {
					const s = this._standalone.get(instanceId);
					if (!s || s.applying) {
						return;
					}
					s.editEpoch += 1;
					const content = fileModel.textEditorModel.getValue(EndOfLinePreference.LF);
					input.webview
						.postMessage({
							type: 'update',
							content,
							editEpoch: s.editEpoch,
							messageSecret: s.messageSecret
						})
						.catch(() => {
							/* gone */
						});
				})
			);
		}

		input.setWebviewTitle(title);
		return input;
	}

	private _onStandaloneMessage(instanceId: string, raw: unknown): void {
		const session = this._standalone.get(instanceId);
		if (!session) {
			return;
		}
		const message = raw as MarkdownEditorHostMessage;
		if (!message || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'ready':
				session.ready = true;
				if (typeof message.editEpoch === 'number') {
					session.editEpoch = message.editEpoch;
				}
				break;
			case 'edit':
				void this._applyStandaloneEdit(session, message);
				break;
			case 'history':
				session.editEpoch += 1;
				{
					const fileModel = this._textFileService.files.get(session.resource);
					if (fileModel?.isResolved()) {
						session.input.webview
							.postMessage({
								type: 'update',
								content: fileModel.textEditorModel.getValue(EndOfLinePreference.LF),
								editEpoch: session.editEpoch,
								messageSecret: session.messageSecret
							})
							.catch(() => {
								/* */
							});
					}
				}
				break;
			case 'openLink':
				void this._openLink(String(message.href ?? ''));
				break;
			default:
				break;
		}
	}

	private async _applyStandaloneEdit(
		session: {
			input: WebviewInput;
			resource: URI;
			readonly: boolean;
			messageSecret: string;
			editEpoch: number;
			ready: boolean;
			applying: boolean;
		},
		message: MarkdownEditorHostMessage
	): Promise<void> {
		if (session.readonly) {
			return;
		}
		const fileModel = this._textFileService.files.get(session.resource);
		if (!fileModel?.isResolved()) {
			return;
		}
		if (typeof message.editEpoch === 'number' && message.editEpoch !== session.editEpoch) {
			session.editEpoch += 1;
			session.input.webview
				.postMessage({
					type: 'update',
					content: fileModel.textEditorModel.getValue(EndOfLinePreference.LF),
					editEpoch: session.editEpoch,
					messageSecret: session.messageSecret
				})
				.catch(() => {
					/* */
				});
			return;
		}
		const model = fileModel.textEditorModel;
		const text = model.getValue(EndOfLinePreference.LF);
		const start = typeof message.start === 'number' ? message.start : 0;
		const endExclusive = typeof message.endExclusive === 'number' ? message.endExclusive : start;
		const insert = typeof message.text === 'string' ? message.text : '';
		const startPos = offsetToPosition(text, start);
		const endPos = offsetToPosition(text, endExclusive);
		session.applying = true;
		try {
			model.pushEditOperations(
				null,
				[
					{
						range: new Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
						text: insert
					}
				],
				() => null
			);
		} finally {
			session.applying = false;
		}
	}

	toggleReadonly(): boolean {
		this._readonly = !this._readonly;
		this._storageService.store(READONLY_STATE_KEY, this._readonly, StorageScope.PROFILE, StorageTarget.USER);
		this._postToWebview({ type: 'command', command: 'toggleReadonly' });
		this._updateTitle();
		this._notificationService.info(
			this._readonly
				? localize('markdownEditorLocked', 'Markdown Editor is locked (read-only). Unlock to edit WYSIWYG.')
				: localize('markdownEditorUnlocked', 'Markdown Editor unlocked — edit in the rendered view.')
		);
		return this._readonly;
	}

	async showSource(): Promise<void> {
		const resource = this._currentResource;
		if (!resource) {
			return;
		}
		const existing = this._editorService.findEditors(resource)[0];
		if (existing) {
			await this._editorService.openEditor(existing.editor, { preserveFocus: false }, existing.groupId);
			return;
		}
		await this._editorService.openEditor({ resource, options: { preserveFocus: false, pinned: true } });
	}

	refresh(): void {
		if (!this._ready) {
			return;
		}
		this._pushAuthoritativeUpdate();
	}

	private _openOrCreate(resource: URI, open: boolean, side?: boolean, preserveFocus = false): WebviewInput | undefined {
		const title = localize(
			'markdownEditorTitle',
			'Markdown Editor: {0}',
			resource.path.split('/').pop() || resource.path
		);

		if (this._webviewInput && !this._webviewInput.isDisposed()) {
			this._webviewInput.setWebviewTitle(title);
			this._reloadHtml();
			this._listenToContentChanges();
			return this._webviewInput;
		}

		const initInfo = this._initInfo(resource, title);
		const input = open
			? this._webviewWorkbenchService.openWebview(initInfo, MARKDOWN_EDITOR_VIEW_TYPE, title, undefined, {
					preserveFocus,
					group: side ? SIDE_GROUP : undefined
				})
			: this._instantiationService.createInstance(
					WebviewInput,
					{
						viewType: MARKDOWN_EDITOR_VIEW_TYPE,
						name: title,
						providedId: initInfo.providedViewType,
						iconPath: undefined
					},
					this._webviewService.createWebviewOverlay(initInfo)
				);

		this._webviewInput = input;
		this._webviewDisposables.clear();
		this._webviewDisposables.add(
			input.onWillDispose(() => {
				this._webviewDisposables.clear();
				this._contentDisposables.clear();
				this._modelListen.clear();
				this._webviewInput = undefined;
				this._currentResource = undefined;
				this._ready = false;
			})
		);
		this._webviewDisposables.add(input.webview.onMessage(event => this._onWebviewMessage(event.message)));
		this._reloadHtml();
		this._listenToContentChanges();
		return input;
	}

	private _initInfo(resource: URI, title: string): WebviewInitInfo {
		return {
			title,
			options: {
				enableFindWidget: true,
				retainContextWhenHidden: true
			},
			contentOptions: {
				allowScripts: true,
				// Host inject + our bootstrap may both define the API; avoid throw.
				allowMultipleAPIAcquire: true,
				localResourceRoots: (() => {
					const roots = [URI.joinPath(resource, '..')];
					try {
						if (typeof window !== 'undefined' && window.location?.origin) {
							roots.push(URI.parse(window.location.origin));
						}
					} catch {
						/* ignore */
					}
					return roots;
				})()
			},
			extension: undefined
		};
	}

	private _reloadHtml(): void {
		const input = this._webviewInput;
		const resource = this._currentResource;
		if (!input || !resource) {
			return;
		}
		const fileModel = this._textFileService.files.get(resource);
		const text = fileModel?.isResolved() ? fileModel.textEditorModel.getValue(EndOfLinePreference.LF) : '';
		const version = fileModel?.isResolved() ? fileModel.textEditorModel.getVersionId() : 0;
		this._messageSecret = generateUuid();
		this._editEpoch = 0;
		this._ready = false;
		input.webview.setHtml(this._buildHtml(text, version, resource));
		this._updateTitle();
	}

	private _buildHtml(content: string, documentVersion: number, resource: URI): string {
		const assetBase = markdownEditorAssetBase();
		const scriptUri = `${assetBase}/editor.js`;
		const styleUri = `${assetBase}/editor.css`;
		const nonce = generateUuid().replace(/-/g, '');
		const highlightActiveBlock =
			this._configurationService.getValue<boolean>('markdown.editor.highlightActiveBlock') ?? true;
		const editorFontSize =
			this._configurationService.getValue<number>('editor.fontSize') ?? 14;
		const initialState = encodeInitialState({
			highlightActiveBlock,
			taskProgressLabels: {
				title: localize('mdTaskProgress', 'Task Progress'),
				summary: localize('mdTaskProgressSummary', '{0} of {1} tasks completed'),
				language: 'en'
			},
			content,
			documentVersion,
			editEpoch: this._editEpoch,
			readonly: this._readonly,
			richLinksEnabled: false,
			linkPresentationRules: []
		});
		// Use the asset pack as <base>, not file:// — WKWebView/document.write
		// cannot load modules or images from a file:// document base, and a
		// file base also breaks relative chunk resolution after dynamic import.
		const baseHref = `${assetBase}/`;
		const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
		const cspHosts = [assetBase, origin, 'https://tauri.localhost', 'https://*.tauri.localhost', 'https://asset.localhost', 'http://asset.localhost']
			.filter(Boolean)
			.join(' ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src 'self' 'unsafe-inline' ${cspHosts} https: data:; font-src 'self' ${cspHosts} data:; img-src 'self' ${cspHosts} https: data: blob: sidex-asset: asset:; media-src 'self' ${cspHosts} https: data: blob: sidex-asset: asset:; script-src 'nonce-${nonce}' 'self' ${cspHosts}; worker-src 'self' ${cspHosts} blob:; connect-src 'self' ${cspHosts}; frame-src 'self';" />
	<meta name="vscode-markdown-editor-script-nonce" content="${nonce}" />
	<meta name="vscode-markdown-editor-message-secret" content="${this._messageSecret}" />
	<meta id="vscode-markdown-editor-initial-state" content="${initialState}" />
	<base href="${baseHref}" />
	<link rel="stylesheet" href="${styleUri}" />
	<style>
		html, body { height: 100%; margin: 0; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #cccccc); }
		#editor { min-height: 100%; font-size: ${editorFontSize}px; }
		#sidex-md-editor-empty {
			position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
			padding: 24px; box-sizing: border-box; text-align: center;
			font: ${Math.max(14, editorFontSize)}px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
			opacity: 0.9; pointer-events: none; z-index: 1;
		}
	</style>
	<title>Markdown Editor</title>
</head>
<body>
	<div id="sidex-md-editor-empty">预览加载中 / Loading Markdown Editor…<br/><span style="font-size:0.85em;opacity:0.8">若一直空白请升级 SideX，或改用「打开侧边预览」</span></div>
	<div id="editor"></div>
	<script nonce="${nonce}">
		(function () {
			var failText = 'Markdown Editor failed to load. Use Open Preview to the Side, or upgrade SideX.\\n编辑器未加载：请改用「打开侧边预览」或升级 SideX。';
			var scriptUri = ${JSON.stringify(scriptUri)};
			var reported = false;
			function reportBootstrapFail(detail) {
				var h = document.getElementById('sidex-md-editor-empty');
				if (h) {
					h.innerHTML = failText.replace(/\\n/g, '<br/>') + (detail ? '<br/><span style="font-size:0.8em;opacity:0.75">' + String(detail).slice(0, 180) + '</span>' : '');
				}
				if (reported) { return; }
				reported = true;
				console.warn('[Markdown Editor] bootstrap failed:', detail);
				try {
					var api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
					if (api) {
						api.postMessage({ type: 'bootstrapFailed', message: String(detail || 'unknown') });
					}
				} catch (e) { /* host may not be ready */ }
			}
			window.__sidexMdEditorMarkFailed = reportBootstrapFail;
			setTimeout(function () {
				var h = document.getElementById('sidex-md-editor-empty');
				var ed = document.getElementById('editor');
				if (!h) { return; }
				if (ed && ed.childElementCount > 0) { h.style.display = 'none'; return; }
				reportBootstrapFail('timeout — editor DOM stayed empty after 8s');
			}, 8000);
			var obs = new MutationObserver(function () {
				var ed = document.getElementById('editor');
				var h = document.getElementById('sidex-md-editor-empty');
				if (ed && h && ed.childElementCount > 0) { h.style.display = 'none'; obs.disconnect(); }
			});
			var ed = document.getElementById('editor');
			if (ed) { obs.observe(ed, { childList: true, subtree: true }); }
			// If the host's un-nonced _vscodeApiScript was blocked by our CSP
			// nonce, install the same bridge here (nonced script) before import.
			if (typeof acquireVsCodeApi !== 'function') {
				try {
					var parentPost = window.parent && window.parent['__vscode_post_message__'];
					if (typeof parentPost === 'function') {
						var originalPostMessage = parentPost.bind(window.parent);
						var acquired = false;
						globalThis.acquireVsCodeApi = function () {
							if (acquired) {
								throw new Error('An instance of the VS Code API has already been acquired');
							}
							acquired = true;
							return Object.freeze({
								postMessage: function (message, transfer) {
									originalPostMessage('onmessage', { message: message, transfer: transfer }, transfer);
								},
								setState: function (newState) {
									originalPostMessage('do-update-state', JSON.stringify(newState));
									return newState;
								},
								getState: function () { return undefined; }
							});
						};
						window.parent = window;
						window.top = window;
						window.frameElement = null;
						console.info('[Markdown Editor] installed acquireVsCodeApi fallback (host inject missing/blocked)');
					} else {
						reportBootstrapFail('acquireVsCodeApi missing and parent __vscode_post_message__ unavailable');
						return;
					}
				} catch (bridgeErr) {
					reportBootstrapFail('acquireVsCodeApi fallback failed: ' + (bridgeErr && (bridgeErr.message || bridgeErr)));
					return;
				}
			}
			// document.write + <script type="module" src> often never runs on
			// WKWebView. Classic script + dynamic import() does.
			import(scriptUri).catch(function (err) {
				var detail = 'import failed: ' + scriptUri + ' — ' + (err && (err.message || err));
				console.error('[Markdown Editor] module load failed', scriptUri, err);
				reportBootstrapFail(detail);
			});
		})();
	</script>
</body>
</html>`;
	}

	private _listenToContentChanges(): void {
		this._contentDisposables.clear();
		this._modelListen.clear();
		const resource = this._currentResource;
		if (!resource) {
			return;
		}
		const fileModel = this._textFileService.files.get(resource);
		if (!fileModel) {
			return;
		}
		if (!fileModel.isResolved()) {
			this._contentDisposables.add(
				this._textFileService.files.onDidResolve(e => {
					if (e.model.resource.toString() === resource.toString()) {
						this._listenToContentChanges();
						this._reloadHtml();
					}
				})
			);
			return;
		}
		const textModel = fileModel.textEditorModel;
		this._modelListen.value = textModel.onDidChangeContent(() => {
			if (this._applyingWebviewEdit || !this._ready) {
				return;
			}
			this._pushAuthoritativeUpdate();
		});
	}

	private _pushAuthoritativeUpdate(): void {
		const resource = this._currentResource;
		const fileModel = resource ? this._textFileService.files.get(resource) : undefined;
		if (!fileModel?.isResolved()) {
			return;
		}
		this._editEpoch += 1;
		const content = fileModel.textEditorModel.getValue(EndOfLinePreference.LF);
		this._postToWebview({ type: 'update', content, editEpoch: this._editEpoch });
	}

	private _postToWebview(message: Record<string, unknown>): void {
		this._webviewInput?.webview.postMessage({ ...message, messageSecret: this._messageSecret }).catch(() => {
			/* editor may be gone */
		});
	}

	private _onWebviewMessage(raw: unknown): void {
		const message = raw as MarkdownEditorHostMessage;
		if (!message || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'ready':
				this._ready = true;
				if (typeof message.editEpoch === 'number') {
					this._editEpoch = message.editEpoch;
				}
				this._logService.info('[Markdown Editor] webview ready', this._currentResource?.toString());
				break;
			case 'bootstrapFailed':
				this._logService.warn(
					'[Markdown Editor] bootstrap/import failed',
					this._currentResource?.toString(),
					message.message ?? 'unknown'
				);
				break;
			case 'edit':
				void this._applyEdit(message);
				break;
			case 'history':
				this._runHistory(message.command);
				break;
			case 'openLink':
				void this._openLink(String(message.href ?? ''));
				break;
			case 'setReadonly':
				if (typeof message.readonly === 'boolean') {
					this._readonly = message.readonly;
					this._storageService.store(READONLY_STATE_KEY, this._readonly, StorageScope.PROFILE, StorageTarget.USER);
					this._updateTitle();
				}
				break;
			case 'editorFocusChanged':
				break;
			case 'resolveCodeBlockEditor':
				// No contributed code-block editors yet — reply empty.
				if (typeof message.requestId === 'number') {
					this._postToWebview({
						type: 'resolvedCodeBlockEditor',
						requestId: message.requestId,
						descriptor: undefined
					});
				}
				break;
			case 'codeBlockEditorDiagnostic':
				if (message.message) {
					this._logService.warn('[Markdown Editor]', message.message);
				}
				break;
			case 'createCodeBlockEditorHostTransport':
			case 'disposeCodeBlockEditorHostTransport':
			case 'codeBlockEditorHostTransportMessage':
			case 'addComment':
			case 'deleteComment':
				// Intentionally no-op until extension host + comment providers land.
				break;
			default:
				break;
		}
	}

	private async _applyEdit(message: MarkdownEditorHostMessage): Promise<void> {
		const resource = this._currentResource;
		const fileModel = resource ? this._textFileService.files.get(resource) : undefined;
		if (!fileModel?.isResolved()) {
			return;
		}
		if (typeof message.editEpoch === 'number' && message.editEpoch !== this._editEpoch) {
			// Stale edit against an older baseline — push truth back.
			this._pushAuthoritativeUpdate();
			return;
		}
		const model = fileModel.textEditorModel;
		const text = model.getValue(EndOfLinePreference.LF);
		const start = typeof message.start === 'number' ? message.start : 0;
		const endExclusive = typeof message.endExclusive === 'number' ? message.endExclusive : start;
		const insert = typeof message.text === 'string' ? message.text : '';
		const startPos = offsetToPosition(text, start);
		const endPos = offsetToPosition(text, endExclusive);
		this._applyingWebviewEdit = true;
		try {
			model.pushEditOperations(
				null,
				[
					{
						range: new Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
						text: insert
					}
				],
				() => null
			);
		} finally {
			this._applyingWebviewEdit = false;
		}
	}

	private _runHistory(command: 'undo' | 'redo' | undefined): void {
		if (command !== 'undo' && command !== 'redo') {
			return;
		}
		const resource = this._currentResource;
		const editor = this._codeEditorService.getActiveCodeEditor();
		if (resource && editor && editor.getModel()?.uri.toString() === resource.toString()) {
			editor.trigger('markdownEditor', command, null);
			return;
		}
		// Edits applied via pushEditOperations live on the text model's undo stack.
		// Without a focused code editor, re-sync the webview from the model after
		// asking the workbench undo/redo command (no-op if nothing is stacked).
		const fileModel = resource ? this._textFileService.files.get(resource) : undefined;
		if (!fileModel?.isResolved()) {
			return;
		}
		this._logService.trace('[Markdown Editor] history', command);
		this._pushAuthoritativeUpdate();
	}

	private async _openLink(href: string): Promise<void> {
		const resource = this._currentResource;
		if (!resource || href.length === 0 || href.startsWith('#')) {
			return;
		}
		const uri = HAS_SCHEME.test(href) ? URI.parse(href) : URI.joinPath(URI.joinPath(resource, '..'), href);
		try {
			if (uri.scheme === 'file' || uri.scheme === 'vscode-file') {
				await this._editorService.openEditor({ resource: uri, options: { pinned: true } });
				return;
			}
			if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
				await this._openerService.open(uri, { openExternal: true, fromUserGesture: true });
				return;
			}
			this._logService.warn('[Markdown Editor] Refusing link scheme', uri.scheme);
		} catch (err) {
			this._logService.warn('[Markdown Editor] Could not open link', href, err);
		}
	}

	private _activeMarkdownResource(): URI | undefined {
		const editor = this._editorService.activeEditor;
		const resource = editor instanceof EditorInput ? editor.resource : undefined;
		if (!resource) {
			return undefined;
		}
		const lower = resource.path.toLowerCase();
		if (!(
			lower.endsWith('.md') ||
			lower.endsWith('.markdown') ||
			lower.endsWith('.mdx') ||
			lower.endsWith('.mdtxt') ||
			lower.endsWith('.mdtext')
		)) {
			return undefined;
		}
		return resource;
	}

	private _updateTitle(): void {
		const name = this._currentResource?.path.split('/').pop() ?? 'Markdown';
		this._webviewInput?.setWebviewTitle(
			this._readonly
				? localize('markdownEditorLockedTitle', 'Markdown Editor (locked): {0}', name)
				: localize('markdownEditorEditingTitle', 'Markdown Editor: {0}', name)
		);
	}
}
