/**
 * CodeMirrorEditor.tsx — the plain-text editing surface.
 *
 * Deliberately minimal: history, search, and the standard keymaps, with no language
 * support. Syntax highlighting stays on the READ path (Shiki, via `ContentViewer` and
 * the message list), which is where this repository's grammar investment already lives.
 * Adding Lezer grammars here would introduce a second syntax system whose colours drift
 * from the first, so it is a separate decision from "can a person save a file".
 *
 * ## Why the buffer is not a plain controlled `value`
 *
 * A CodeMirror document is not a string with a cursor bolted on. Replacing the whole
 * document on every keystroke — the naive controlled pattern — destroys the selection,
 * the undo history, and the scroll position. So the editor owns its document and reports
 * changes upward; the parent's value is only pushed back IN when it diverges for a
 * reason other than the user typing (a reload, a conflict resolution).
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Box } from "@mantine/core";
import { useEffect, useRef } from "react";

export interface CodeMirrorEditorProps {
	/** The document content. Pushed into the editor only when it diverges externally. */
	value: string;
	onChange: (value: string) => void;
	/** Cmd/Ctrl+S. Handled here so it works while the editor has focus. */
	onSave?: () => void;
	readOnly?: boolean;
}

export function CodeMirrorEditor({ value, onChange, onSave, readOnly }: CodeMirrorEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	// Callbacks live in refs so the view is built ONCE. Rebuilding it on every render
	// would throw away the undo history and the cursor.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	// The initial document, in a ref for the same reason as the callbacks: the view is
	// built once, and depending on `value` would rebuild it on every keystroke — throwing
	// away the undo history and the cursor. Later changes arrive through the sync effect
	// below, which is the one place allowed to touch the document.
	const initialDocRef = useRef(value);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: initialDocRef.current,
				extensions: [
					lineNumbers(),
					history(),
					keymap.of([
						{
							key: "Mod-s",
							// `preventDefault` via returning true: otherwise the browser's own "save
							// page" dialog opens over the editor.
							run: () => {
								onSaveRef.current?.();
								return true;
							},
						},
						// `indentWithTab` is opt-in in CodeMirror because binding Tab traps keyboard
						// navigation. Accepted here: this is a code editor, where Tab indenting is
						// the expectation, and Escape-then-Tab still leaves the field.
						indentWithTab,
						...defaultKeymap,
						...historyKeymap,
					]),
					EditorView.updateListener.of((update) => {
						// `docChanged` only: selection and viewport updates fire constantly and
						// reporting them as edits would mark a file dirty from a mouse click.
						if (update.docChanged) {
							onChangeRef.current(update.state.doc.toString());
						}
					}),
					EditorView.editable.of(!readOnly),
					EditorView.theme({
						"&": { height: "100%", fontSize: "13px" },
						".cm-scroller": { fontFamily: "var(--mantine-font-family-monospace)" },
					}),
				],
			}),
		});
		viewRef.current = view;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [readOnly]);

	// Push an EXTERNAL value change into the document.
	//
	// The guard is what makes this safe: when `value` already equals the document, the
	// change came from the user's own typing (round-tripped through the parent) and
	// dispatching it would reset the selection on every keystroke.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === value) return;
		view.dispatch({
			changes: { from: 0, to: current.length, insert: value },
		});
	}, [value]);

	return <Box ref={hostRef} style={{ height: "100%", overflow: "hidden" }} />;
}
