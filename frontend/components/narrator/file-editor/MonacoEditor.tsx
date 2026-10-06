import { Box, Button, Group, Text, useComputedColorScheme } from "@mantine/core";
import type { FileSelection } from "@shared/file-reference";
import type { editor } from "monaco-editor/editor/editor.api";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createEditorLocalId } from "./editor-local-id";
import { MonacoSearchPanel } from "./MonacoSearchPanel";
import {
	loadMonacoLanguage,
	type MonacoLanguageStatus,
	resolveMonacoLanguage,
} from "./monaco-languages";
import { loadMonaco, type MonacoAPI } from "./monaco-loader";
import {
	MonacoNavigationHighlight,
	monacoFileSelection,
	monacoFileSelectionRange,
} from "./monaco-navigation";
import {
	MONACO_LONG_LINE_LIMIT,
	MonacoLongLineTracker,
	monacoEditorOptions,
} from "./monaco-profile";
import {
	installMonacoScrollBoundary,
	monacoHostVisible,
	revealMonacoPosition,
} from "./monaco-scroll";

export interface MonacoEditorHandle {
	getEditor(): editor.IStandaloneCodeEditor | null;
	getModel(): editor.ITextModel | null;
	undo(): void;
	redo(): void;
	focus(): void;
}
export interface MonacoDocumentStatus extends MonacoLanguageStatus {
	revision: number;
	alternativeVersionId: number;
	length: number;
	lines: number;
	canUndo: boolean;
	canRedo: boolean;
	/** At least one line exceeds the lexical budget; wrapping is disabled, text is not truncated. */
	longLine: boolean;
}
export interface MonacoEditorProps {
	ref?: Ref<MonacoEditorHandle>;
	initialValue: string;
	documentKey: string;
	filePath: string;
	onReady?: (handle: MonacoEditorHandle | null) => void;
	onDocumentChange?: (status: MonacoDocumentStatus) => void;
	onSelectionChange?: (selection: FileSelection | null, explicit: boolean) => void;
	onSearchRequested?: () => void;
	onSave?: () => void;
	onError?: (error: Error) => void;
	readOnly?: boolean;
	selection?: FileSelection;
	navigationRequestId?: string;
	lineWrapping?: boolean;
	visible?: boolean;
}

interface Runtime {
	api: MonacoAPI;
	view: editor.IStandaloneCodeEditor;
	model: editor.ITextModel;
	sync(): void;
}

/** Resolve Mantine variables to actual CSS colours, which Monaco's theme parser requires. */
function updateTheme(api: MonacoAPI, host: HTMLElement, dark: boolean): void {
	const style = host.ownerDocument.defaultView?.getComputedStyle(host);
	const color = (variable: string, fallback: string) => {
		const value = style?.getPropertyValue(variable).trim() || fallback;
		// Monaco also feeds editor foreground/background into its token colour map,
		// which accepts six/eight hex digits, but rejects valid CSS shorthand like #000.
		if (/^#[\da-f]{3,4}$/i.test(value))
			return `#${[...value.slice(1)].map((digit) => digit + digit).join("")}`;
		return /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value) ? value : fallback;
	};
	api.editor.defineTheme("narrafork", {
		base: dark ? "vs-dark" : "vs",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": color("--mantine-color-body", dark ? "#242424" : "#ffffff"),
			"editor.foreground": color("--mantine-color-text", dark ? "#c9c9c9" : "#000000"),
			"editorLineNumber.foreground": color("--mantine-color-dimmed", "#828282"),
			"editorGutter.background": color("--mantine-color-body", dark ? "#242424" : "#ffffff"),
			"editorCursor.foreground": color("--mantine-color-text", dark ? "#c9c9c9" : "#000000"),
		},
	});
	api.editor.setTheme("narrafork");
}

/** Monaco owns the only mutable document. Props are explicit loads, never controlled input echoes. */
export function MonacoEditor(props: MonacoEditorProps) {
	const { ref, documentKey } = props;
	const { t } = useTranslation("narrator");
	const [longLineDocumentKey, setLongLineDocumentKey] = useState<string | null>(null);
	const [fullLongLineDocumentKey, setFullLongLineDocumentKey] = useState<string | null>(null);
	const fullLongLines = fullLongLineDocumentKey === documentKey;
	const fullLongLinesRef = useRef(fullLongLines);
	fullLongLinesRef.current = fullLongLines;
	const hostRef = useRef<HTMLDivElement | null>(null);
	const runtime = useRef<Runtime | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const scheme = useComputedColorScheme("dark");
	const darkRef = useRef(scheme === "dark");
	darkRef.current = scheme === "dark";
	const [error, setError] = useState<string | null>(null);
	const [internalSearch, setInternalSearch] = useState<{
		documentKey: string;
		view: editor.IStandaloneCodeEditor;
	} | null>(null);
	const handle = useRef<MonacoEditorHandle>({
		getEditor: () => runtime.current?.view ?? null,
		getModel: () => runtime.current?.model ?? null,
		undo: () => {
			if (!latest.current.readOnly) {
				runtime.current?.view.trigger("toolbar", "undo", null);
				runtime.current?.view.focus();
			}
		},
		redo: () => {
			if (!latest.current.readOnly) {
				runtime.current?.view.trigger("toolbar", "redo", null);
				runtime.current?.view.focus();
			}
		},
		focus: () => runtime.current?.view.focus(),
	}).current;
	useImperativeHandle(ref, () => handle, [handle]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let cancelled = false;
		let dispose: (() => void) | undefined;
		// Full rendering is an opt-in for this model lifetime, not a preference for another file.
		fullLongLinesRef.current = false;
		setFullLongLineDocumentKey(null);
		setError(null);
		void (async () => {
			const api = await loadMonaco();
			const initialLanguagePath = latest.current.filePath;
			let languageStatus = await loadMonacoLanguage(api, initialLanguagePath);
			if (cancelled) return;
			const initial = latest.current;
			// This order is critical. createModel consults the standalone configuration service.
			// Updating options AFTER model creation cannot re-enable large-file tokenization.
			updateTheme(api, host, darkRef.current);
			let renderingFull = fullLongLinesRef.current;
			const view = api.editor.create(host, {
				...monacoEditorOptions(!!initial.readOnly, !!initial.lineWrapping, false),
				stopRenderingLineAfter: renderingFull ? -1 : MONACO_LONG_LINE_LIMIT,
				theme: "narrafork",
				ariaLabel: initial.filePath,
			});
			dispose = () => view.dispose();
			const uri = api.Uri.from({
				scheme: "narrafork-editor",
				authority: "document",
				path: `/${encodeURIComponent(documentKey)}/${encodeURIComponent(initial.filePath)}`,
				query: createEditorLocalId(),
			});
			const model = api.editor.createModel(initial.initialValue, languageStatus.language, uri);
			dispose = () => {
				view.dispose();
				model.dispose();
			};
			const longLines = new MonacoLongLineTracker(model);
			if (longLines.hasLongLine) view.updateOptions({ wordWrap: "off" });
			view.setModel(model);
			const navigation = new MonacoNavigationHighlight(view);
			let loadedValue = initial.initialValue;
			let loadedPath = initialLanguagePath;
			let lastNavigation = "";
			let loadRevision = 0;
			let languageRequest = 0;
			let readyCallback = initial.onReady;
			let lastTheme = darkRef.current;
			let readOnly = !!initial.readOnly;
			let wrapping = !!initial.lineWrapping && !longLines.hasLongLine;
			let frame = 0;
			let metadataQueued = false;
			const emit = () => {
				if (cancelled) return;
				setLongLineDocumentKey(longLines.hasLongLine ? documentKey : null);
				latest.current.onDocumentChange?.({
					revision: model.getVersionId(),
					alternativeVersionId: model.getAlternativeVersionId(),
					length: model.getValueLength(),
					lines: model.getLineCount(),
					canUndo: !latest.current.readOnly && model.canUndo(),
					canRedo: !latest.current.readOnly && model.canRedo(),
					...languageStatus,
					longLine: longLines.hasLongLine,
				});
			};
			let width = -1;
			let height = -1;
			const layout = () => {
				if (frame) return;
				frame = requestAnimationFrame(() => {
					frame = 0;
					if (cancelled || latest.current.visible === false || !monacoHostVisible(host)) return;
					if (width !== host.clientWidth || height !== host.clientHeight) {
						width = host.clientWidth;
						height = host.clientHeight;
						view.layout({ width, height });
					}
					if (pendingReveal) {
						if (pendingReveal.revision !== model.getVersionId()) {
							pendingReveal = null;
						} else if (
							!revealMonacoPosition(view, host, pendingReveal.position) &&
							pendingReveal.attempts++ < 2
						) {
							// A newly revealed wrapped line may not yet have measurable horizontal geometry.
							layout();
						} else pendingReveal = null;
					}
				});
			};
			let pendingReveal: {
				position: { lineNumber: number; column: number };
				revision: number;
				attempts: number;
			} | null = null;
			const sync = () => {
				const next = latest.current;
				if (readyCallback !== next.onReady) {
					readyCallback?.(null);
					readyCallback = next.onReady;
					readyCallback?.(handle);
				}
				if (loadedValue !== next.initialValue) {
					loadedValue = next.initialValue;
					model.setValue(next.initialValue);
				}
				if (loadedPath !== next.filePath) {
					loadedPath = next.filePath;
					const request = ++languageRequest;
					languageStatus = resolveMonacoLanguage(loadedPath);
					void loadMonacoLanguage(api, loadedPath)
						.then((status) => {
							if (cancelled || request !== languageRequest) return;
							languageStatus = status;
							api.editor.setModelLanguage(model, status.language);
							emit();
						})
						.catch((cause: unknown) =>
							latest.current.onError?.(cause instanceof Error ? cause : new Error(String(cause))),
						);
					view.updateOptions({ ariaLabel: loadedPath });
				}
				if (lastTheme !== darkRef.current) {
					lastTheme = darkRef.current;
					updateTheme(api, host, lastTheme);
				}
				if (readOnly !== !!next.readOnly) {
					readOnly = !!next.readOnly;
					view.updateOptions({ readOnly });
					emit();
				}
				if (renderingFull !== fullLongLinesRef.current) {
					renderingFull = fullLongLinesRef.current;
					view.updateOptions({
						stopRenderingLineAfter: renderingFull ? -1 : MONACO_LONG_LINE_LIMIT,
					});
				}
				const nextWrapping = !!next.lineWrapping && !longLines.hasLongLine;
				if (wrapping !== nextWrapping) {
					wrapping = nextWrapping;
					view.updateOptions({ wordWrap: wrapping ? "on" : "off" });
				}
				const request = next.selection
					? JSON.stringify([next.navigationRequestId, next.selection, loadRevision])
					: "";
				if (lastNavigation !== request) {
					lastNavigation = request;
					if (next.selection) {
						const range = monacoFileSelectionRange(model, next.selection);
						navigation.set(range);
						pendingReveal = {
							position: { lineNumber: range.startLineNumber, column: range.startColumn },
							revision: model.getVersionId(),
							attempts: 0,
						};
						view.setPosition(pendingReveal.position, "file-navigation");
						// Repeated navigation still explicitly takes ownership even at the same cursor.
						latest.current.onSelectionChange?.(null, true);
					} else {
						navigation.set(null);
						pendingReveal = null;
					}
				}
				layout();
			};
			// Drag-select fires onDidChangeCursorSelection on every pointer move. Publishing
			// each frame into React re-renders the dock/NarratorPanel tree and blocks the
			// main thread, so Monaco's own hit-testing starves — that is the production
			// jank. Coalesce to one publication per mouse gesture (mouseup / blur).
			let mouseSelecting = false;
			let dragPending: { selection: FileSelection | null; explicit: boolean } | null = null;
			const emitSelection = (selection: FileSelection | null, explicit: boolean) => {
				if (mouseSelecting) {
					dragPending = {
						selection,
						explicit: explicit || !!dragPending?.explicit,
					};
					return;
				}
				latest.current.onSelectionChange?.(selection, explicit);
			};
			const flushDragSelection = () => {
				if (!mouseSelecting) return;
				mouseSelecting = false;
				const pending = dragPending ?? {
					selection: monacoFileSelection(view.getSelection()),
					explicit: true,
				};
				dragPending = null;
				if (!cancelled) latest.current.onSelectionChange?.(pending.selection, pending.explicit);
			};
			const endPointerSelection = () => flushDragSelection();
			const win = host.ownerDocument.defaultView;
			win?.addEventListener("mouseup", endPointerSelection, true);
			win?.addEventListener("pointercancel", endPointerSelection, true);
			const blurSubscription =
				typeof view.onDidBlurEditorText === "function"
					? view.onDidBlurEditorText(() => flushDragSelection())
					: null;
			const subscriptions = [
				view.onDidFocusEditorText(() => {
					// A focus steal mid-drag must still settle the gesture once.
					flushDragSelection();
					latest.current.onSelectionChange?.(monacoFileSelection(view.getSelection()), true);
				}),
				view.onMouseDown((event) => {
					if (
						event.target.type !== api.editor.MouseTargetType.CONTENT_TEXT &&
						event.target.type !== api.editor.MouseTargetType.CONTENT_EMPTY &&
						event.target.type !== api.editor.MouseTargetType.GUTTER_LINE_NUMBERS
					)
						return;
					// Ownership for this gesture is decided on pointer end, not every move.
					mouseSelecting = true;
					dragPending = null;
					queueMicrotask(() => {
						if (cancelled) return;
						if (mouseSelecting) {
							dragPending ??= {
								selection: monacoFileSelection(view.getSelection()),
								explicit: true,
							};
							return;
						}
						latest.current.onSelectionChange?.(monacoFileSelection(view.getSelection()), true);
					});
				}),
				model.onDidChangeContent((event) => {
					if (event.isFlush) {
						loadRevision++;
						// Also support explicit reloads performed through the public model handle.
						queueMicrotask(() => {
							if (!cancelled) sync();
						});
					}
					longLines.update(event);
					navigation.refresh();
					const nextWrapping = !!latest.current.lineWrapping && !longLines.hasLongLine;
					if (wrapping !== nextWrapping) {
						wrapping = nextWrapping;
						view.updateOptions({ wordWrap: wrapping ? "on" : "off" });
					}
					// Undo/redo bookkeeping and cursor mapping settle after the content event.
					if (!metadataQueued) {
						metadataQueued = true;
						queueMicrotask(() => {
							metadataQueued = false;
							emit();
							if (!cancelled) emitSelection(monacoFileSelection(view.getSelection()), false);
						});
					}
				}),
				view.onDidChangeCursorSelection((event) => {
					// Flush/recover are document-only changes and cannot steal another panel's ownership.
					const explicit =
						event.reason !== api.editor.CursorChangeReason.ContentFlush &&
						event.reason !== api.editor.CursorChangeReason.RecoverFromMarkers;
					// During a pointer gesture the live selection stays in Monaco; React is
					// notified once on pointer end so drag-select does not re-render the panel tree.
					emitSelection(monacoFileSelection(event.selection), explicit);
				}),
			];
			view.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyF, () => {
				if (latest.current.onSearchRequested) latest.current.onSearchRequested();
				else setInternalSearch({ documentKey, view });
			});
			view.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => latest.current.onSave?.());
			const removeBoundary = installMonacoScrollBoundary(host);
			const observer = new ResizeObserver(layout);
			observer.observe(host);
			// Visibility can change without a size change (docked tabs). Observe only ancestor attrs.
			const visibilityObserver = new MutationObserver(layout);
			let parent: HTMLElement | null = host;
			for (let depth = 0; parent && depth < 64; depth++, parent = parent.parentElement)
				visibilityObserver.observe(parent, {
					attributes: true,
					attributeFilter: ["style", "class", "hidden"],
				});
			dispose = () => {
				if (frame) cancelAnimationFrame(frame);
				win?.removeEventListener("mouseup", endPointerSelection, true);
				win?.removeEventListener("pointercancel", endPointerSelection, true);
				observer.disconnect();
				visibilityObserver.disconnect();
				removeBoundary();
				for (const subscription of subscriptions) subscription.dispose();
				blurSubscription?.dispose();
				navigation.dispose();
				runtime.current = null;
				view.dispose();
				model.dispose();
				readyCallback?.(null);
			};
			runtime.current = { api, view, model, sync };
			readyCallback?.(handle);
			emit();
			sync();
		})().catch((cause: unknown) => {
			if (cancelled) return;
			dispose?.();
			dispose = undefined;
			const failure = cause instanceof Error ? cause : new Error(String(cause));
			setError(failure.message);
			latest.current.onError?.(failure);
		});
		return () => {
			cancelled = true;
			dispose?.();
		};
	}, [documentKey, handle]);

	// No props are lifecycle dependencies: theme, preview and callback changes retain the model.
	useEffect(() => {
		runtime.current?.sync();
	});
	useEffect(() => {
		if (internalSearch && (internalSearch.documentKey !== documentKey || props.onSearchRequested))
			setInternalSearch(null);
	}, [internalSearch, documentKey, props.onSearchRequested]);
	return (
		<Box
			style={{
				height: "100%",
				minWidth: 0,
				minHeight: 0,
				display: props.visible === false ? "none" : "flex",
				flexDirection: "column",
				visibility: "inherit",
			}}
		>
			{error && <Box role="alert">{error}</Box>}
			{longLineDocumentKey === documentKey && (
				<Group gap="xs" px="xs" py={4} wrap="nowrap" data-monaco-long-line-protection>
					<Text size="xs" c="dimmed" style={{ flex: 1 }} role="status">
						{t(fullLongLines ? "fileEditor.longLineFullDisplay" : "fileEditor.longLineProtected", {
							limit: MONACO_LONG_LINE_LIMIT,
						})}
					</Text>
					<Button
						size="compact-xs"
						variant="subtle"
						data-monaco-long-line-toggle
						aria-pressed={fullLongLines}
						onClick={() => setFullLongLineDocumentKey(fullLongLines ? null : documentKey)}
					>
						{t(fullLongLines ? "fileEditor.protectLongLines" : "fileEditor.showFullLongLines")}
					</Button>
				</Group>
			)}
			{internalSearch?.documentKey === documentKey && !props.onSearchRequested && (
				<MonacoSearchPanel
					editor={internalSearch.view}
					readOnly={!!props.readOnly}
					onSave={props.onSave}
					onClose={() => setInternalSearch(null)}
				/>
			)}
			<Box
				ref={hostRef}
				className="nf-monaco-host"
				data-monaco-document-key={documentKey}
				style={{ flex: 1, minHeight: 0, overflow: "hidden", visibility: "inherit" }}
			/>
		</Box>
	);
}
