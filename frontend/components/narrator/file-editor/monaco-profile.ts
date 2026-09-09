import type { editor } from "monaco-editor/editor/editor.api";

export const MONACO_LONG_LINE_LIMIT = 10_000;
export const MONACO_LARGE_DOCUMENT_LENGTH = 1024 * 1024;

/** Model construction reads these settings from the already-created standalone editor. */
export function monacoEditorOptions(
	readOnly: boolean,
	wrapping: boolean,
	longLine: boolean,
): editor.IStandaloneEditorConstructionOptions {
	return {
		model: null,
		largeFileOptimizations: false,
		readOnly,
		fontSize: 13,
		fontFamily: "var(--mantine-font-family-monospace)",
		lineHeight: 20,
		minimap: { enabled: false },
		wordWrap: wrapping && !longLine ? "on" : "off",
		wrappingStrategy: "simple",
		maxTokenizationLineLength: MONACO_LONG_LINE_LIMIT,
		// Bound rendering only. The model, worker searches and saved bytes remain complete.
		stopRenderingLineAfter: MONACO_LONG_LINE_LIMIT,
		wordBasedSuggestions: "off",
		quickSuggestions: false,
		suggestOnTriggerCharacters: false,
		parameterHints: { enabled: false },
		codeLens: false,
		folding: false,
		links: false,
		colorDecorators: false,
		selectionHighlight: false,
		occurrencesHighlight: "off",
		matchBrackets: "never",
		bracketPairColorization: { enabled: false },
		guides: { indentation: false, bracketPairs: false, highlightActiveIndentation: false },
		stickyScroll: { enabled: false },
		unicodeHighlight: {
			nonBasicASCII: false,
			ambiguousCharacters: false,
			invisibleCharacters: false,
		},
		inlayHints: { enabled: "off" },
		"semanticHighlighting.enabled": false,
		renderValidationDecorations: "off",
		renderWhitespace: "none",
		renderControlCharacters: false,
		renderLineHighlight: "line",
		scrollBeyondLastLine: false,
		smoothScrolling: false,
		cursorSmoothCaretAnimation: "off",
		mouseWheelZoom: false,
		scrollbar: { alwaysConsumeMouseWheel: true, useShadows: false },
		overviewRulerLanes: 0,
		overviewRulerBorder: false,
		contextmenu: false,
		automaticLayout: false,
		padding: { top: 8, bottom: 8 },
	};
}

/** O(lines) once at load, O(changed lines + existing long lines) on ordinary typing. */
export class MonacoLongLineTracker {
	private lines = new Set<number>();
	constructor(private model: Pick<editor.ITextModel, "getLineCount" | "getLineLength">) {
		this.reset();
	}
	get hasLongLine(): boolean {
		return this.lines.size > 0;
	}
	reset(): void {
		this.lines.clear();
		for (let line = 1; line <= this.model.getLineCount(); line++) {
			if (this.model.getLineLength(line) > MONACO_LONG_LINE_LIMIT) this.lines.add(line);
		}
	}
	update(event: editor.IModelContentChangedEvent): void {
		if (event.isFlush) {
			this.reset();
			return;
		}
		// Monaco's ranges refer to the pre-edit model. Transform ascending, carrying the delta.
		const changes = [...event.changes].sort(
			(a, b) =>
				a.range.startLineNumber - b.range.startLineNumber ||
				a.range.startColumn - b.range.startColumn,
		);
		let delta = 0;
		const inspect = new Set<number>();
		for (const change of changes) {
			let insertedLines = 0;
			for (let at = change.text.indexOf("\n"); at !== -1; at = change.text.indexOf("\n", at + 1))
				insertedLines++;
			const start = change.range.startLineNumber + delta;
			const end = change.range.endLineNumber + delta;
			const shift = insertedLines - (end - start);
			this.lines = new Set(
				[...this.lines].flatMap((line) =>
					line < start ? [line] : line > end ? [line + shift] : [],
				),
			);
			// A later edit on the same line has no line shift; all inspected positions remain final.
			for (let line = start; line <= start + insertedLines; line++) inspect.add(line);
			delta += shift;
		}
		for (const line of inspect) {
			if (
				line <= this.model.getLineCount() &&
				this.model.getLineLength(line) > MONACO_LONG_LINE_LIMIT
			)
				this.lines.add(line);
		}
	}
}
