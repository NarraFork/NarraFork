import { Marked, type Tokens } from "marked";

/**
 * How a spec document is shown in the Spec panel.
 *
 * - `source`: the raw text in a code editor; a save writes exactly what was typed.
 * - `split`: the same source editor beside a read-only rendered preview.
 * - `rich`: the Tiptap WYSIWYG editor. It re-serializes the whole document on every change,
 *   so it is opt-in, and only offered for markdown files it can load without losing content.
 */
export type SpecEditorMode = "source" | "split" | "rich";

export const SPEC_EDITOR_MODES: readonly SpecEditorMode[] = ["source", "split", "rich"];

/** Injected verbatim into the model prompt (`server/services/spec-reminder.ts`): never markdown. */
const BEHAVIOR_FENCE_PATH = "behavior_fence";

export function isMarkdownSpecPath(path: string): boolean {
	return path !== BEHAVIOR_FENCE_PATH && /\.(?:md|markdown)$/i.test(path);
}

/** Non-markdown files (agent-written .json/.yaml, the behavior fence) are plain text only. */
export function availableSpecEditorModes(path: string): SpecEditorMode[] {
	return isMarkdownSpecPath(path) ? [...SPEC_EDITOR_MODES] : ["source"];
}

/** The mode a document opens in: the reader's last choice when this file offers it, else source. */
export function initialSpecEditorMode(preferred: SpecEditorMode, path: string): SpecEditorMode {
	return availableSpecEditorModes(path).includes(preferred) ? preferred : "source";
}

/**
 * Markdown the rich editor cannot keep. Each kind is dropped or rewritten when Tiptap loads the
 * document, so saving from the rich editor would silently change the file.
 */
export type SpecRichUnsupportedKind = "frontMatter" | "html" | "image" | "taskList" | "footnote";

const KIND_ORDER: readonly SpecRichUnsupportedKind[] = [
	"frontMatter",
	"html",
	"image",
	"taskList",
	"footnote",
];

/**
 * YAML front matter at the very start of the file. marked has no front-matter rule (it reads the
 * block as a thematic break plus a setext heading), so this one is matched on the source. The
 * opening fence must be followed directly by a non-blank line: a rich-editor save writes a leading
 * horizontal rule as `---` plus a blank line, and that must not read as front matter next time.
 */
const FRONT_MATTER = /^﻿?---[ \t]*\r?\n(?![ \t]*\r?\n)[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

// A private instance: options or extensions registered on the global `marked` elsewhere in the
// bundle must not change what counts as unsupported here.
const lexer = new Marked({ gfm: true });

/**
 * Detect content the rich editor would lose, using the marked lexer the frontend already bundles:
 * raw HTML (block or inline, including comments), images, task-list items, footnote definitions
 * (link definitions whose label starts with `^`) and leading front matter. Tables are not listed:
 * the editor loads them through TableKit and writes them back with escaped pipes.
 *
 * Cost grows with the document (hundreds of ms near the 200k-char spec limit), so callers run it
 * when the rich editor is about to load a document, not on every keystroke.
 */
export function detectRichUnsupported(markdown: string): SpecRichUnsupportedKind[] {
	const found = new Set<SpecRichUnsupportedKind>();
	if (FRONT_MATTER.test(markdown)) found.add("frontMatter");
	const tokens = lexer.lexer(markdown);
	for (const label of Object.keys(tokens.links)) {
		if (label.startsWith("^")) found.add("footnote");
	}
	lexer.walkTokens(tokens, (token) => {
		switch (token.type) {
			case "html":
				found.add("html");
				break;
			case "image":
				found.add("image");
				break;
			case "list_item":
				if ((token as Tokens.ListItem).task) found.add("taskList");
				break;
			case "def":
				if ((token as Tokens.Def).tag.startsWith("^")) found.add("footnote");
				break;
		}
	});
	return KIND_ORDER.filter((kind) => found.has(kind));
}

/**
 * Which mode one document is shown in, plus the snapshot the rich editor loads. Kept per
 * document so switching files re-applies the reader's preferred mode.
 */
export interface SpecEditorView {
	documentKey: string;
	mode: SpecEditorMode;
	/** The reader picked this mode for this document (as opposed to it being the default). */
	explicit: boolean;
	/**
	 * Rich mode only: the text the rich editor loads and what it cannot keep. Taken when rich
	 * mode is entered and again on every new server revision, never per keystroke: the rich
	 * editor's own output is not re-checked while the reader is typing in it.
	 */
	rich: { revisionKey: string; text: string; unsupported: SpecRichUnsupportedKind[] } | null;
}

export interface SpecEditorViewInput {
	documentKey: string;
	path: string;
	/** Changes whenever content is (re)loaded from the server; stable while the reader types. */
	revisionKey: string;
	value: string;
	preferredMode: SpecEditorMode;
}

type Detect = (markdown: string) => SpecRichUnsupportedKind[];

/**
 * Bring a view up to date with the current document. Returns `prev` itself when nothing changed,
 * so a component can call it on every render and only store the result when it differs.
 *
 * A document that opens in rich mode by default but holds unsupported content falls back to
 * source mode. When the reader picked rich mode, it stays, and the caller shows a read-only
 * rendering instead of the editor (`rich.unsupported` is non-empty).
 */
export function syncSpecEditorView(
	prev: SpecEditorView | null,
	input: SpecEditorViewInput,
	detect: Detect = detectRichUnsupported,
): SpecEditorView {
	let view: SpecEditorView =
		prev && prev.documentKey === input.documentKey
			? prev
			: {
					documentKey: input.documentKey,
					mode: initialSpecEditorMode(input.preferredMode, input.path),
					explicit: false,
					rich: null,
				};
	if (!availableSpecEditorModes(input.path).includes(view.mode)) {
		view = { ...view, mode: "source", rich: null };
	}
	if (view.mode !== "rich" || view.rich?.revisionKey === input.revisionKey) return view;
	const unsupported = detect(input.value);
	if (unsupported.length > 0 && !view.explicit) return { ...view, mode: "source", rich: null };
	return { ...view, rich: { revisionKey: input.revisionKey, text: input.value, unsupported } };
}

/** The reader picked `mode`. Entering rich mode checks the current text, including unsaved edits. */
export function selectSpecEditorMode(
	view: SpecEditorView,
	mode: SpecEditorMode,
	input: SpecEditorViewInput,
	detect: Detect = detectRichUnsupported,
): SpecEditorView {
	return syncSpecEditorView({ ...view, mode, explicit: true, rich: null }, input, detect);
}
