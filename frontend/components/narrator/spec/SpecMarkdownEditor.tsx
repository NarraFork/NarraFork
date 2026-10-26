import { RichTextEditor } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef } from "react";
import classes from "./SpecMarkdownEditor.module.css";
import { createSpecMarkdownExtensions } from "./spec-markdown-extensions";

interface SpecMarkdownEditorProps {
	/** Initial markdown content (loaded once per revision). */
	value: string;
	/** Distinguishes reloads: when this changes, editor content is reset. */
	revisionKey: string;
	onChange: (markdown: string) => void;
	/**
	 * Ctrl/Cmd+S inside the editor. The panel-level hotkey ignores contenteditable targets, so
	 * without this the shortcut fell through to the browser's own "save page".
	 */
	onSave?: () => void;
}

/**
 * WYSIWYG markdown editor built on Tiptap + Mantine RichTextEditor.
 * Content round-trips through the official @tiptap/markdown extension.
 *
 * Only mount it for content that `detectRichUnsupported` accepts: Tiptap drops or rewrites the
 * rest on load, and every change here writes the whole re-serialized document back.
 */
export function SpecMarkdownEditor({
	value,
	revisionKey,
	onChange,
	onSave,
}: SpecMarkdownEditorProps) {
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	// Track the revision we last synced so external reloads reset the doc, but
	// local keystrokes (which don't change revisionKey) never clobber the cursor.
	const syncedRevisionRef = useRef<string | null>(null);
	const extensions = useMemo(() => createSpecMarkdownExtensions(), []);

	const editor = useEditor({
		// Client-only render — first paint happens after mount, so `editor` is
		// briefly null. Mantine controls and our effects guard against that.
		immediatelyRender: false,
		extensions,
		content: value,
		contentType: "markdown",
		onUpdate: ({ editor }) => {
			if (editor.isDestroyed) return;
			onChangeRef.current(editor.getMarkdown());
		},
		editorProps: {
			handleKeyDown: (_view, event) => {
				const save =
					(event.ctrlKey || event.metaKey) &&
					!event.altKey &&
					!event.shiftKey &&
					event.key.toLowerCase() === "s";
				if (!save) return false;
				event.preventDefault();
				onSaveRef.current?.();
				return true;
			},
		},
	});

	// Reset editor content when a new revision is loaded (e.g. agent edited the
	// file, or the user switched files). Keep local edits otherwise.
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		if (syncedRevisionRef.current === revisionKey) return;
		syncedRevisionRef.current = revisionKey;
		editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
	}, [editor, value, revisionKey]);

	return (
		<RichTextEditor editor={editor} className={classes.root}>
			<RichTextEditor.Toolbar sticky stickyOffset={0}>
				<RichTextEditor.ControlsGroup>
					<RichTextEditor.Bold />
					<RichTextEditor.Italic />
					<RichTextEditor.Strikethrough />
					<RichTextEditor.Code />
				</RichTextEditor.ControlsGroup>
				<RichTextEditor.ControlsGroup>
					<RichTextEditor.H1 />
					<RichTextEditor.H2 />
					<RichTextEditor.H3 />
				</RichTextEditor.ControlsGroup>
				<RichTextEditor.ControlsGroup>
					<RichTextEditor.BulletList />
					<RichTextEditor.OrderedList />
					<RichTextEditor.Blockquote />
					<RichTextEditor.CodeBlock />
				</RichTextEditor.ControlsGroup>
				<RichTextEditor.ControlsGroup>
					<RichTextEditor.Link />
					<RichTextEditor.Unlink />
				</RichTextEditor.ControlsGroup>
				<RichTextEditor.ControlsGroup>
					<RichTextEditor.Undo />
					<RichTextEditor.Redo />
				</RichTextEditor.ControlsGroup>
			</RichTextEditor.Toolbar>
			<RichTextEditor.Content className={classes.content} />
		</RichTextEditor>
	);
}
