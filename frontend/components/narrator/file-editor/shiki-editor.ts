import { type Extension, type Range, StateEffect, StateField, type Text } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import type { BundledLanguage, ThemedToken } from "shiki";
import { loadShiki } from "../../../lib/shiki-loader";
import { FILE_HIGHLIGHT_OPTIONS, MAX_FILE_HIGHLIGHT_CODE_CHARS } from "../highlight-cache";

const HIGHLIGHT_DELAY_MS = 150;
const MAX_DECORATIONS = 50_000;

type Token = Pick<ThemedToken, "content" | "color" | "fontStyle">;
export type EditorTokenLoader = (
	code: string,
	language: string,
	theme: string,
	signal: AbortSignal,
) => Promise<Token[][] | null>;

const loadTokens: EditorTokenLoader = async (code, language, theme, signal) => {
	const shiki = await loadShiki();
	if (signal.aborted || !shiki || !(language in shiki.bundledLanguages)) return null;
	const result = await shiki.codeToTokens(code, {
		lang: language as BundledLanguage,
		theme,
		...FILE_HIGHLIGHT_OPTIONS,
	});
	return result.tokens;
};

/** Match against the exact document, not just its length: async results may arrive late. */
export const setShikiDecorations = StateEffect.define<{ doc: Text; decorations: DecorationSet }>();
export const shikiDecorations = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decorations, transaction) {
		decorations = decorations.map(transaction.changes);
		for (const effect of transaction.effects) {
			if (effect.is(setShikiDecorations) && effect.value.doc === transaction.state.doc) {
				decorations = effect.value.decorations;
			}
		}
		return decorations;
	},
	provide: (field) => EditorView.decorations.from(field),
});

/** Use CodeMirror line offsets (UTF-16, normalized line endings), never byte offsets. */
export function tokensToDecorations(doc: Text, lines: Token[][]): DecorationSet {
	if (lines.length !== doc.lines) return Decoration.none;
	const ranges: Range<Decoration>[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = doc.line(index + 1);
		let from = line.from;
		for (const token of lines[index]) {
			const to = from + token.content.length;
			if (to > line.to || doc.sliceString(from, to) !== token.content) return Decoration.none;
			const styles: string[] = [];
			if (token.color) styles.push(`color:${token.color}`);
			const fontStyle = Math.max(0, token.fontStyle ?? 0);
			if (fontStyle & 1) styles.push("font-style:italic");
			if (fontStyle & 2) styles.push("font-weight:bold");
			if (fontStyle & 4) styles.push("text-decoration:underline");
			if (to > from && styles.length) {
				if (ranges.length >= MAX_DECORATIONS) return Decoration.none;
				ranges.push(
					Decoration.mark({ class: "cm-shiki", attributes: { style: styles.join(";") } }).range(
						from,
						to,
					),
				);
			}
			from = to;
		}
		if (from !== line.to) return Decoration.none;
	}
	return Decoration.set(ranges);
}

interface HighlightOptions {
	language: string;
	theme: string;
	/** Injection seams keep lifecycle tests independent of a browser and network. */
	loadTokens?: EditorTokenLoader;
	delayMs?: number;
}

/** Decoration-only updates preserve selection, undo history, scroll and the saved buffer. */
export class ShikiEditorHighlighter {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private controller: AbortController | undefined;
	private destroyed = false;

	constructor(
		private view: Pick<EditorView, "state" | "dispatch">,
		private options: HighlightOptions,
	) {
		this.schedule();
	}

	update(update: Pick<ViewUpdate, "docChanged">) {
		if (update.docChanged) this.schedule();
	}

	private schedule() {
		clearTimeout(this.timer);
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		// A new document remains editable immediately, even if it is too large to
		// highlight. Clearing old marks must not clear or replace the document.
		this.timer = setTimeout(
			() => void this.highlight(controller, 1),
			this.options.delayMs ?? HIGHLIGHT_DELAY_MS,
		);
	}

	private async highlight(controller: AbortController, retries: number) {
		const doc = this.view.state.doc;
		const isCurrent = () =>
			!this.destroyed && !controller.signal.aborted && this.view.state.doc === doc;
		try {
			const { language, theme } = this.options;
			const tokens =
				doc.length && language && language !== "text" && doc.length <= MAX_FILE_HIGHLIGHT_CODE_CHARS
					? await (this.options.loadTokens ?? loadTokens)(
							doc.toString(),
							language,
							theme,
							controller.signal,
						)
					: [];
			if (!isCurrent()) return;
			this.view.dispatch({
				effects: setShikiDecorations.of({
					doc,
					decorations: tokens ? tokensToDecorations(doc, tokens) : Decoration.none,
				}),
			});
			// A cold grammar/core load may fail transiently. Retry once, never on a
			// permanent plaintext/size fallback, and never after editing or unmount.
			if (tokens === null && retries > 0) this.retry(controller, retries - 1);
		} catch {
			if (!isCurrent()) return;
			this.view.dispatch({
				effects: setShikiDecorations.of({ doc, decorations: Decoration.none }),
			});
			if (retries > 0) this.retry(controller, retries - 1);
		}
	}

	private retry(controller: AbortController, retries: number) {
		this.timer = setTimeout(() => void this.highlight(controller, retries), 1_000);
	}

	destroy() {
		this.destroyed = true;
		clearTimeout(this.timer);
		this.controller?.abort();
	}
}

export function shikiEditorExtension(options: HighlightOptions): Extension {
	return [shikiDecorations, ViewPlugin.define((view) => new ShikiEditorHighlighter(view, options))];
}
