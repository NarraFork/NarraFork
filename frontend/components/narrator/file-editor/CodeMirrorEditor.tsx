/**
 * CodeMirror owns the document, cursor and undo history. Shiki only supplies
 * decorations, using the same lazy grammars and light/dark themes as file preview.
 * Reconfiguring language, theme or read-only mode must never rebuild the view.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
	Compartment,
	EditorSelection,
	EditorState,
	type Text,
	Transaction,
} from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { Box, useComputedColorScheme } from "@mantine/core";
import type { FileSelection } from "@shared/file-reference";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	createEditorSearchPanel,
	EditorSearchPanel,
	type EditorSearchPanelState,
} from "./EditorSearchPanel";
import {
	fileNavigationHighlightExtension,
	setFileNavigationHighlight,
} from "./file-navigation-highlight";
import { shikiEditorExtension } from "./shiki-editor";

export interface CodeMirrorEditorProps {
	/** The document content. Pushed into the editor only when it diverges externally. */
	value: string;
	/** Shiki language id, resolved from the file path by the caller. */
	language?: string;
	onChange: (value: string) => void;
	/** Cmd/Ctrl+S. Handled here so it works while the editor has focus. */
	onSave?: () => void;
	readOnly?: boolean;
	selection?: FileSelection;
	/** A fresh request re-scrolls even when the range is unchanged. */
	navigationRequestId?: string;
	onSelectionChange?: (selection: FileSelection | null, selectionSet: boolean) => void;
	lineWrapping?: boolean;
	searchRequestId?: number;
	/** Localized CodeMirror search / go-to-line UI. */
	phrases?: Record<string, string>;
	ariaLabel?: string;
}

/** Clamp stale line/column coordinates to the current buffer, never replace that buffer. */
export function fileSelectionRange(doc: Text, selection: FileSelection): EditorSelection {
	const offset = (lineNumber: number, column: number) => {
		if (lineNumber > doc.lines) return doc.length;
		const line = doc.line(Math.max(1, Math.trunc(lineNumber) || 1));
		return line.from + Math.min(line.length, Math.max(0, Math.trunc(column) - 1 || 0));
	};
	const from = offset(selection.startLineNumber, selection.startColumn);
	const to = offset(selection.endLineNumber, selection.endColumn);
	return EditorSelection.single(Math.min(from, to), Math.max(from, to));
}

export function editorFileSelection(state: EditorState): FileSelection | null {
	const { from, to, empty } = state.selection.main;
	if (empty) return null;
	const start = state.doc.lineAt(from);
	const end = state.doc.lineAt(to);
	return {
		startLineNumber: start.number,
		startColumn: from - start.from + 1,
		endLineNumber: end.number,
		endColumn: to - end.from + 1,
	};
}

export function navigateFileSelection(
	view: Pick<EditorView, "state" | "dispatch">,
	selection: FileSelection,
): void {
	const range = fileSelectionRange(view.state.doc, selection);
	view.dispatch({
		selection: EditorSelection.single(range.main.from),
		effects: [
			setFileNavigationHighlight.of({ from: range.main.from, to: range.main.to }),
			EditorView.scrollIntoView(range.main.from, { y: "center" }),
		],
		annotations: Transaction.addToHistory.of(false),
	});
}

function editorTheme(dark: boolean) {
	return EditorView.theme(
		{
			"&": {
				height: "100%",
				fontSize: "13px",
				color: "var(--mantine-color-text)",
				backgroundColor: "var(--mantine-color-body)",
			},
			".cm-scroller": { fontFamily: "var(--mantine-font-family-monospace)" },
			".cm-content": { caretColor: "var(--mantine-color-text)" },
			".cm-gutters": {
				color: "var(--mantine-color-dimmed)",
				backgroundColor: "var(--mantine-color-body)",
				borderColor: "var(--mantine-color-default-border)",
			},
		},
		{ dark },
	);
}

export function CodeMirrorEditor({
	value,
	language = "text",
	onChange,
	onSave,
	readOnly = false,
	selection,
	navigationRequestId,
	onSelectionChange,
	lineWrapping = false,
	searchRequestId = 0,
	phrases,
	ariaLabel,
}: CodeMirrorEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const [searchPanel, setSearchPanel] = useState<EditorSearchPanelState | null>(null);
	const scheme = useComputedColorScheme("dark");
	const theme = scheme === "light" ? "github-light-default" : "github-dark-default";
	const compartments = useRef({
		highlight: new Compartment(),
		theme: new Compartment(),
		editable: new Compartment(),
		wrapping: new Compartment(),
		accessibility: new Compartment(),
	});

	// Ref-held callbacks and initial content let the view survive parent renders.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const initialDocRef = useRef(value);
	const onSelectionChangeRef = useRef(onSelectionChange);
	onSelectionChangeRef.current = onSelectionChange;
	const lastNavigationRef = useRef<string | null>(null);
	const externalDocumentRevisionRef = useRef(0);
	// Reuse the emitted string for controlled echoes instead of flattening the
	// persistent document a second time after every keystroke.
	const documentValueRef = useRef(value);
	const lastSearchRequestRef = useRef(0);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: initialDocRef.current,
				extensions: [
					lineNumbers(),
					fileNavigationHighlightExtension,
					drawSelection(),
					history(),
					search({
						top: true,
						createPanel: (view) => createEditorSearchPanel(view, setSearchPanel),
					}),
					bracketMatching(),
					indentOnInput(),
					highlightActiveLine(),
					keymap.of([
						{
							key: "Mod-s",
							scope: "editor search-panel",
							// Returning true prevents the browser's "save page" dialog.
							run: () => {
								onSaveRef.current?.();
								return true;
							},
						},
						// Escape-then-Tab still leaves the editor.
						indentWithTab,
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap,
					]),
					EditorView.updateListener.of((update) => {
						// Highlight/selection updates must never mark the buffer dirty.
						if (update.docChanged) {
							documentValueRef.current = update.state.doc.toString();
							onChangeRef.current(documentValueRef.current);
						}
						if (update.docChanged || update.selectionSet) {
							onSelectionChangeRef.current?.(
								editorFileSelection(update.state),
								update.selectionSet,
							);
						}
					}),
					compartments.current.highlight.of([]),
					compartments.current.theme.of([]),
					compartments.current.editable.of([]),
					compartments.current.wrapping.of([]),
					compartments.current.accessibility.of([]),
				],
			}),
		});
		viewRef.current = view;
		lastNavigationRef.current = null;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: [
				compartments.current.highlight.reconfigure(shikiEditorExtension({ language, theme })),
				compartments.current.theme.reconfigure(editorTheme(scheme === "dark")),
			],
		});
	}, [language, scheme, theme]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: compartments.current.editable.reconfigure([
				EditorView.editable.of(!readOnly),
				EditorState.readOnly.of(readOnly),
			]),
		});
	}, [readOnly]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: compartments.current.wrapping.reconfigure(
				lineWrapping ? EditorView.lineWrapping : [],
			),
		});
	}, [lineWrapping]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: compartments.current.accessibility.reconfigure([
				EditorState.phrases.of(phrases ?? {}),
				// Read-only content is not contenteditable, but still needs a keyboard
				// focus target when Escape closes the search form.
				EditorView.contentAttributes.of({ "aria-label": ariaLabel ?? "", tabindex: "0" }),
			]),
		});
	}, [phrases, ariaLabel]);

	useEffect(() => {
		if (searchRequestId === lastSearchRequestRef.current) return;
		lastSearchRequestRef.current = searchRequestId;
		if (viewRef.current) openSearchPanel(viewRef.current);
	}, [searchRequestId]);

	// Only external changes (reload/conflict resolution) replace the document.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (documentValueRef.current === value) return;
		externalDocumentRevisionRef.current += 1;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
	}, [value]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: value changes schedule late-load navigation; the revision latch ignores controlled edit echoes.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (!selection) {
			if (lastNavigationRef.current !== null) {
				lastNavigationRef.current = null;
				view.dispatch({ effects: setFileNavigationHighlight.of(null) });
			}
			return;
		}
		// A late load/reload may change the document after the request arrived. Typing
		// does not advance this revision, so controlled onChange echoes never re-jump.
		const request = JSON.stringify([
			navigationRequestId,
			selection,
			externalDocumentRevisionRef.current,
		]);
		if (lastNavigationRef.current === request) return;
		lastNavigationRef.current = request;
		navigateFileSelection(view, selection);
	}, [selection, navigationRequestId, value]);

	return (
		<>
			<Box ref={hostRef} style={{ height: "100%", overflow: "hidden" }} />
			{searchPanel && createPortal(<EditorSearchPanel {...searchPanel} />, searchPanel.dom)}
		</>
	);
}
