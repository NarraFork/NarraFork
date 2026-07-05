import { RichTextEditor } from "@mantine/tiptap";
import { Markdown } from "@tiptap/markdown";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import classes from "./SpecMarkdownEditor.module.css";

interface SpecMarkdownEditorProps {
	/** Initial markdown content (loaded once per revision). */
	value: string;
	/** Distinguishes reloads: when this changes, editor content is reset. */
	revisionKey: string;
	onChange: (markdown: string) => void;
}

/**
 * WYSIWYG markdown editor built on Tiptap + Mantine RichTextEditor.
 * Content round-trips through the official @tiptap/markdown extension.
 */
export function SpecMarkdownEditor({ value, revisionKey, onChange }: SpecMarkdownEditorProps) {
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	// Track the revision we last synced so external reloads reset the doc, but
	// local keystrokes (which don't change revisionKey) never clobber the cursor.
	const syncedRevisionRef = useRef<string | null>(null);

	const editor = useEditor({
		// Client-only render — first paint happens after mount, so `editor` is
		// briefly null. Mantine controls and our effects guard against that.
		immediatelyRender: false,
		extensions: [
			// StarterKit already bundles the Link extension in Tiptap v3; adding a
			// separate Link caused a duplicate-extension conflict that broke the
			// command manager. Configure link options through StarterKit instead.
			StarterKit.configure({ link: { openOnClick: false } }),
			Markdown.configure({ indentation: { style: "space", size: 2 } }),
		],
		content: value,
		contentType: "markdown",
		onUpdate: ({ editor }) => {
			if (editor.isDestroyed) return;
			onChangeRef.current(editor.getMarkdown());
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
