/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/markdownColors.js';
import './media/markdown.css';

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	IWorkbenchContribution,
	WorkbenchPhase,
	registerWorkbenchContribution2
} from '../../../common/contributions.js';
import { MARKDOWN_PREVIEW_VIEW_TYPE, MarkdownPreviewManager } from './markdownPreview.js';
import { MARKDOWN_EDITOR_VIEW_TYPE, MarkdownEditorManager } from './markdownEditor.js';
import { MarkdownDiffEditorManager } from './markdownDiffEditor.js';
import { SideBySideEditorInput } from '../../../common/editor/sideBySideEditorInput.js';
import { DEFAULT_EDITOR_ASSOCIATION } from '../../../common/editor.js';
import {
	IEditorResolverService,
	RegisteredEditorPriority
} from '../../../services/editor/common/editorResolverService.js';
import {
	Extensions as ConfigurationExtensions,
	IConfigurationRegistry,
	ConfigurationScope
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

let _previewManager: MarkdownPreviewManager | undefined;

function getOrCreateManager(accessor: ServicesAccessor): MarkdownPreviewManager {
	if (!_previewManager) {
		_previewManager = accessor.get(IInstantiationService).createInstance(MarkdownPreviewManager);
	}
	return _previewManager;
}

let _editorManager: MarkdownEditorManager | undefined;

function getOrCreateEditorManager(accessor: ServicesAccessor): MarkdownEditorManager {
	if (!_editorManager) {
		_editorManager = accessor.get(IInstantiationService).createInstance(MarkdownEditorManager);
	}
	return _editorManager;
}

let _diffEditorManager: MarkdownDiffEditorManager | undefined;

function getOrCreateDiffEditorManager(accessor: ServicesAccessor): MarkdownDiffEditorManager {
	const editorManager = getOrCreateEditorManager(accessor);
	if (!_diffEditorManager) {
		_diffEditorManager = accessor.get(IInstantiationService).createInstance(MarkdownDiffEditorManager, editorManager);
	}
	return _diffEditorManager;
}

class MarkdownPreviewAutoReopen extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.markdownPreviewAutoReopen';

	private _didAutoReopen = false;

	constructor(
		@IEditorService editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IStorageService private readonly _storageService: IStorageService
	) {
		super();

		const startupTimer = setTimeout(() => {
			this._didAutoReopen = true;
		}, 3000);
		this._register({ dispose: () => clearTimeout(startupTimer) });

		this._register(
			editorService.onDidVisibleEditorsChange(() => {
				if (this._didAutoReopen) {
					return;
				}
				this._onVisibleEditorsChanged(editorService);
			})
		);
	}

	private _onVisibleEditorsChanged(editorService: IEditorService): void {
		const activeEditor = editorService.activeEditor;
		if (!(activeEditor instanceof EditorInput)) {
			return;
		}

		const resource = activeEditor.resource;
		if (!resource || !resource.path.endsWith('.md')) {
			return;
		}

		if (_previewManager && _previewManager.hasActivePreview()) {
			return;
		}

		if (!MarkdownPreviewManager.wasPreviewOpen(this._storageService, resource)) {
			return;
		}

		this._didAutoReopen = true;
		const manager = this._instantiationService.createInstance(MarkdownPreviewManager);
		_previewManager = manager;
		manager.showPreview(true);
	}
}

registerWorkbenchContribution2(MarkdownPreviewAutoReopen.ID, MarkdownPreviewAutoReopen, WorkbenchPhase.BlockStartup);

/**
 * Register the preview as a first-class editor so Open With / Reopen With match
 * VS Code: Text Editor (default) + Markdown Preview + Markdown Editor, each
 * option opens the real host (viewType `vscode.markdown.preview.editor`).
 * `workbench.editorAssociations` can point `*.md` at any of them.
 *
 * `RegisteredEditorPriority.option` is deliberate: the resolver only picks a
 * registered editor when the user asked for one (association or picker), so
 * markdown keeps opening in the text editor until someone chooses otherwise.
 */
class MarkdownPreviewEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.markdownPreviewEditor';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();
		this._register(
			editorResolverService.registerEditor(
				'*.{md,markdown,mdx,mdtxt,mdtext}',
				{
					id: MARKDOWN_PREVIEW_VIEW_TYPE,
					label: localize('markdownPreviewEditor', 'Markdown Preview'),
					detail: localize('markdownPreviewEditorDetail', 'Built-in'),
					priority: RegisteredEditorPriority.option
				},
				{},
				{
					createEditorInput: async ({ resource }) => {
						if (!_previewManager) {
							_previewManager = this._instantiationService.createInstance(MarkdownPreviewManager);
						}
						const editor = await _previewManager.createPreviewInputWhenReady(resource);
						if (!editor) {
							throw new Error(`Markdown Preview could not open ${resource.toString()}`);
						}
						return { editor };
					}
				}
			)
		);
	}
}

registerWorkbenchContribution2(
	MarkdownPreviewEditorContribution.ID,
	MarkdownPreviewEditorContribution,
	WorkbenchPhase.BlockStartup
);

/**
 * VS Code "Markdown Editor" (WYSIWYG) — same viewType `vscode.markdown.editor`
 * as markdown-language-features. Hosted in-workbench because the SideX
 * extension host is still WIP; the webview bundle is the upstream
 * `markdown-editor-out` from VS Code 1.141.
 */
class MarkdownWysiwygEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.markdownWysiwygEditor';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();
		this._register(
			editorResolverService.registerEditor(
				'*.{md,markdown,mdx,mdtxt,mdtext}',
				{
					id: MARKDOWN_EDITOR_VIEW_TYPE,
					label: localize('markdownWysiwygEditor', 'Markdown Editor'),
					detail: localize('markdownWysiwygEditorDetail', 'Built-in'),
					priority: RegisteredEditorPriority.option
				},
				{},
				{
					createEditorInput: async ({ resource }) => {
						if (!_editorManager) {
							_editorManager = this._instantiationService.createInstance(MarkdownEditorManager);
						}
						const editor = await _editorManager.createEditorInputWhenReady(resource);
						if (!editor) {
							throw new Error(`Markdown Editor could not open ${resource.toString()}`);
						}
						return { editor };
					},
					createDiffEditorInput: async diff => {
						if (!_editorManager) {
							_editorManager = this._instantiationService.createInstance(MarkdownEditorManager);
						}
						if (!_diffEditorManager) {
							_diffEditorManager = this._instantiationService.createInstance(MarkdownDiffEditorManager, _editorManager);
						}
						const editor = await _diffEditorManager.createDiffEditorInput(diff);
						if (!editor) {
							throw new Error('Markdown Diff Editor could not open the requested diff');
						}
						return { editor };
					}
				}
			)
		);
	}
}

registerWorkbenchContribution2(
	MarkdownWysiwygEditorContribution.ID,
	MarkdownWysiwygEditorContribution,
	WorkbenchPhase.BlockStartup
);

CommandsRegistry.registerCommand('markdown.showPreview', accessor => {
	getOrCreateManager(accessor).showPreview();
});

CommandsRegistry.registerCommand('markdown.showPreviewToSide', accessor => {
	getOrCreateManager(accessor).showPreview(true);
});

CommandsRegistry.registerCommand('markdown.showSource', accessor => {
	getOrCreateManager(accessor).showSource();
});

CommandsRegistry.registerCommand('markdown.togglePreview', accessor => {
	getOrCreateManager(accessor).toggle();
});

CommandsRegistry.registerCommand('markdown.preview.refresh', accessor => {
	getOrCreateManager(accessor).refresh();
});

CommandsRegistry.registerCommand('markdown.preview.toggleLock', accessor => {
	const locked = getOrCreateManager(accessor).toggleLock();
	accessor
		.get(INotificationService)
		.info(
			locked
				? localize('markdownPreviewLocked', 'Markdown preview locked — it no longer follows the document.')
				: localize('markdownPreviewUnlocked', 'Markdown preview unlocked — it follows the document again.')
		);
});

CommandsRegistry.registerCommand('markdown.showPreviewSecuritySelector', accessor => {
	const level = getOrCreateManager(accessor).cycleSecurityLevel();
	accessor
		.get(INotificationService)
		.info(
			localize(
				'markdownPreviewSecurity',
				'Markdown preview content security level: {0}. Run the command again to change it.',
				level
			)
		);
});

CommandsRegistry.registerCommand('markdown.findAllFileReferences', accessor => {
	getOrCreateManager(accessor).findAllFileReferences();
});

CommandsRegistry.registerCommand('markdown.reopenAsPreview', accessor => {
	getOrCreateManager(accessor).showPreview();
});

CommandsRegistry.registerCommand('markdown.reopenAsSource', accessor => {
	getOrCreateManager(accessor).showSource();
});

// The markdown preview commands normally come from the `markdown-language-features`
// built-in extension. Since that extension only registers them when its extension
// host runs, the standalone preview registers its own palette entries, editor
// title action and keybindings so the feature is reachable on its own.
//
// The `when` clause accepts the file extension as well as the language id: the
// `markdown` language itself is contributed by a built-in extension, so a plain
// `.md` file has no language id until the extension host is available.
const MARKDOWN_LANG_WHEN = ContextKeyExpr.or(
	ContextKeyExpr.equals('editorLangId', 'markdown'),
	ContextKeyExpr.equals('resourceExtname', '.md'),
	ContextKeyExpr.equals('resourceExtname', '.markdown')
);

const markdownPaletteCommands: { id: string; title: string }[] = [
	{ id: 'markdown.showPreview', title: localize2('mdShowPreview', 'Open Preview').value },
	{ id: 'markdown.showPreviewToSide', title: localize2('mdShowPreviewToSide', 'Open Preview to the Side').value },
	{ id: 'markdown.togglePreview', title: localize2('mdTogglePreview', 'Toggle Preview').value },
	{ id: 'markdown.showSource', title: localize2('mdShowSource', 'Show Source').value },
	{ id: 'markdown.preview.refresh', title: localize2('mdRefreshPreview', 'Refresh Preview').value },
	{ id: 'markdown.preview.toggleLock', title: localize2('mdToggleLock', 'Toggle Preview Lock').value },
	{
		id: 'markdown.showPreviewSecuritySelector',
		title: localize2('mdSecuritySelector', 'Change Preview Security Settings').value
	},
	{
		id: 'markdown.findAllFileReferences',
		title: localize2('mdFindFileReferences', 'Find All File References').value
	},
	{ id: 'markdown.reopenAsPreview', title: localize2('mdReopenAsPreview', 'Reopen Editor With Preview').value },
	{ id: 'markdown.reopenAsSource', title: localize2('mdReopenAsSource', 'Reopen Editor With Source').value }
];

for (const command of markdownPaletteCommands) {
	MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
		command: { id: command.id, title: command.title, category: 'Markdown' },
		when: MARKDOWN_LANG_WHEN
	});
}

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: 'markdown.showPreviewToSide',
		title: localize2('mdOpenPreviewToSide', 'Open Preview to the Side').value,
		icon: Codicon.openPreview
	},
	group: 'navigation',
	order: 10,
	when: MARKDOWN_LANG_WHEN
});

// No `when` on these chords: with folder-only / non-MD focus VS Code would
// otherwise report "The key combination … is not a command". Empty-state UX
// lives in MarkdownPreviewManager.showPreview (notify / reuse last MD).
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'markdown.showPreviewToSide',
	weight: KeybindingWeight.WorkbenchContrib,
	// Match VS Code markdown-language-features: chord Ctrl/Cmd+K then V.
	primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyV),
	mac: { primary: KeyChord(KeyMod.WinCtrl | KeyCode.KeyK, KeyCode.KeyV) },
	handler: accessor => {
		getOrCreateManager(accessor).showPreview(true);
	}
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'markdown.togglePreview',
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV,
	mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyV },
	handler: accessor => {
		getOrCreateManager(accessor).toggle();
	}
});

CommandsRegistry.registerCommand('_markdown.openFrontMatterSettings', accessor => {
	// markdown-language-features declares this command for the frontmatter
	// webview context menu, but the SideX extension host does not activate
	// that handler — palette / menu invocations threw "command not found".
	void accessor.get(IPreferencesService).openSettings({ query: 'markdown.preview.frontMatter' });
});

CommandsRegistry.registerCommand('markdown.openMarkdownEditor', accessor => {
	getOrCreateEditorManager(accessor).showEditor();
});

CommandsRegistry.registerCommand('markdown.openMarkdownEditorToSide', accessor => {
	getOrCreateEditorManager(accessor).showEditor(true);
});

CommandsRegistry.registerCommand('markdown.editor.toggleReadonly', accessor => {
	getOrCreateEditorManager(accessor).toggleReadonly();
});

CommandsRegistry.registerCommand('markdown.editor.refresh', accessor => {
	getOrCreateEditorManager(accessor).refresh();
});

CommandsRegistry.registerCommand('markdown.editor.showSource', accessor => {
	getOrCreateEditorManager(accessor).showSource();
});

const markdownEditorPaletteCommands: { id: string; title: string }[] = [
	{ id: 'markdown.openMarkdownEditor', title: localize2('mdOpenEditor', 'Open Markdown Editor').value },
	{
		id: 'markdown.openMarkdownEditorToSide',
		title: localize2('mdOpenEditorToSide', 'Open Markdown Editor to the Side').value
	},
	{
		id: 'markdown.editor.toggleReadonly',
		title: localize2('mdEditorToggleLock', 'Markdown Editor: Toggle Lock').value
	},
	{ id: 'markdown.editor.refresh', title: localize2('mdEditorRefresh', 'Markdown Editor: Refresh').value },
	{ id: 'markdown.editor.showSource', title: localize2('mdEditorShowSource', 'Markdown Editor: Show Source').value }
];

for (const command of markdownEditorPaletteCommands) {
	MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
		command: { id: command.id, title: command.title, category: 'Markdown' },
		when: MARKDOWN_LANG_WHEN
	});
}

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: 'markdown.openMarkdownEditor',
		title: localize2('mdOpenEditorTitle', 'Open Markdown Editor').value,
		icon: Codicon.markdown
	},
	group: 'navigation',
	order: 9,
	when: MARKDOWN_LANG_WHEN
});

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: 'markdown.editor.toggleReadonly',
		title: localize2('mdEditorToggleLockTitle', 'Toggle Markdown Editor Lock').value,
		icon: Codicon.edit
	},
	group: 'navigation',
	order: 11,
	when: ContextKeyExpr.or(
		ContextKeyExpr.equals('activeEditor', MARKDOWN_EDITOR_VIEW_TYPE),
		ContextKeyExpr.equals('resourceExtname', '.md')
	)
});

CommandsRegistry.registerCommand('markdown.openMarkdownDiffEditor', accessor => {
	void getOrCreateDiffEditorManager(accessor).openFromActiveDiff();
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: {
		id: 'markdown.openMarkdownDiffEditor',
		title: localize2('mdOpenDiffEditor', 'Open Markdown Diff Editor').value,
		category: 'Markdown'
	},
	when: ContextKeyExpr.or(
		MARKDOWN_LANG_WHEN,
		ContextKeyExpr.equals('activeEditor', 'workbench.editors.textDiffEditor'),
		ContextKeyExpr.equals('activeEditor', SideBySideEditorInput.ID)
	)
});

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: 'markdown.openMarkdownDiffEditor',
		title: localize2('mdOpenDiffEditorTitle', 'Open Markdown Diff Editor').value,
		icon: Codicon.diff
	},
	group: 'navigation',
	order: 8,
	when: ContextKeyExpr.or(
		ContextKeyExpr.equals('activeEditor', 'workbench.editors.textDiffEditor'),
		ContextKeyExpr.and(MARKDOWN_LANG_WHEN, ContextKeyExpr.equals('resourceExtname', '.md'))
	)
});

// Product defaults: .md opens the text editor (not the still-fragile WYSIWYG
// webview). PDF opens the built-in EmbedPDF preview. Users can still pick
// Markdown Preview / Markdown Editor via Open With or workbench.editorAssociations.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([
	{
		overrides: {
			'workbench.editorAssociations': {
				'*.md': DEFAULT_EDITOR_ASSOCIATION.id,
				'*.markdown': DEFAULT_EDITOR_ASSOCIATION.id,
				'*.mdx': DEFAULT_EDITOR_ASSOCIATION.id,
				'*.mdtxt': DEFAULT_EDITOR_ASSOCIATION.id,
				'*.mdtext': DEFAULT_EDITOR_ASSOCIATION.id,
				'*.pdf': 'sidex.pdf.preview'
			}
		}
	}
]);

/**
 * UX-08: one-shot clear of stale `*.md` → Markdown Editor associations from earlier
 * experiments. Product default stays text editor; users may re-associate later
 * without this fighting them on every startup.
 */
class MarkdownStaleAssociationMigration extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.markdownStaleAssociationMigration';
	private static readonly DONE_KEY = 'sidex.markdown.clearedWysiwygAssociation.v1';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@INotificationService notificationService: INotificationService
	) {
		super();
		if (storageService.getBoolean(MarkdownStaleAssociationMigration.DONE_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		const raw = configurationService.getValue<Record<string, string>>('workbench.editorAssociations') ?? {};
		const assoc = { ...raw };
		let changed = false;
		const stale = new Set([MARKDOWN_EDITOR_VIEW_TYPE, 'vscode.markdown.editor']);
		for (const [pattern, viewType] of Object.entries(assoc)) {
			if (typeof viewType === 'string' && stale.has(viewType)) {
				assoc[pattern] = DEFAULT_EDITOR_ASSOCIATION.id;
				changed = true;
			}
		}
		storageService.store(
			MarkdownStaleAssociationMigration.DONE_KEY,
			true,
			StorageScope.PROFILE,
			StorageTarget.MACHINE
		);
		if (!changed) {
			return;
		}
		void configurationService.updateValue('workbench.editorAssociations', assoc).then(() => {
			notificationService.info(
				localize(
					'markdownAssociationReset',
					'Markdown files now open in the text editor by default. Use Reopen With → Markdown Editor for WYSIWYG.'
				)
			);
		});
	}
}

registerWorkbenchContribution2(
	MarkdownStaleAssociationMigration.ID,
	MarkdownStaleAssociationMigration,
	WorkbenchPhase.AfterRestored
);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'markdown',
	order: 35,
	title: localize('markdownConfigurationTitle', 'Markdown'),
	type: 'object',
	properties: {
		'markdown.editor.highlightActiveBlock': {
			type: 'boolean',
			default: true,
			description: localize(
				'markdown.editor.highlightActiveBlock',
				'Highlight the active block in the Markdown Editor (WYSIWYG).'
			),
			scope: ConfigurationScope.RESOURCE
		},
		'markdown.preview.fontSize': {
			type: 'number',
			default: 16,
			description: localize('markdown.preview.fontSize', 'Font size in pixels for the Markdown preview.'),
			scope: ConfigurationScope.RESOURCE
		},
		'markdown.preview.lineHeight': {
			type: 'number',
			default: 1.6,
			description: localize('markdown.preview.lineHeight', 'Line height for the Markdown preview.'),
			scope: ConfigurationScope.RESOURCE
		}
	}
});
