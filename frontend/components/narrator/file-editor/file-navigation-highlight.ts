import {
	type ChangeDesc,
	type Extension,
	StateEffect,
	StateField,
	type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from "@codemirror/view";

interface TargetRange {
	from: number;
	to: number;
}

interface NavigationHighlight {
	range: TargetRange;
	firstLine: number;
	lastLine: number;
	boundaries: DecorationSet;
}

function mapRange(range: TargetRange, changes: ChangeDesc): TargetRange {
	const from = changes.mapPos(range.from, 1);
	return { from, to: Math.max(from, changes.mapPos(range.to, -1)) };
}

export const setFileNavigationHighlight = StateEffect.define<TargetRange | null>({
	map: (range, changes) => (range ? mapRange(range, changes) : null),
});

const startBoundary = Decoration.line({ class: "cm-file-navigation-start" });
const endBoundary = Decoration.line({ class: "cm-file-navigation-end" });
const singleBoundary = Decoration.line({
	class: "cm-file-navigation-start cm-file-navigation-end",
});

function highlightRange(doc: Text, range: TargetRange): NavigationHighlight {
	const firstLine = doc.lineAt(range.from).from;
	// The end is exclusive: an end at the next line's start must not mark that line.
	const lastLine = doc.lineAt(Math.max(range.from, range.to - 1)).from;
	return {
		range,
		firstLine,
		lastLine,
		boundaries: Decoration.set(
			firstLine === lastLine
				? [singleBoundary.range(firstLine)]
				: [startBoundary.range(firstLine), endBoundary.range(lastLine)],
		),
	};
}

/** Navigation survives cursor/selection changes and follows edits without entering undo history. */
export const fileNavigationHighlight = StateField.define<NavigationHighlight | null>({
	create: () => null,
	update(highlight, transaction) {
		let range = highlight?.range ?? null;
		if (range && transaction.docChanged) range = mapRange(range, transaction.changes);
		for (const effect of transaction.effects) {
			if (effect.is(setFileNavigationHighlight)) range = effect.value;
		}
		if (!range) return null;
		if (range === highlight?.range && !transaction.docChanged) return highlight;
		return highlightRange(transaction.state.doc, range);
	},
	provide: (field) =>
		EditorView.decorations.from(field, (value) => value?.boundaries ?? Decoration.none),
});

class NavigationMarker extends GutterMarker {
	constructor(readonly elementClass: string) {
		super();
	}
}

const middleMarker = new NavigationMarker("");
const startMarker = new NavigationMarker("cm-file-navigation-start");
const endMarker = new NavigationMarker("cm-file-navigation-end");
const singleMarker = new NavigationMarker("cm-file-navigation-start cm-file-navigation-end");

export function fileNavigationGutterMarker(
	highlight: NavigationHighlight | null,
	lineFrom: number,
): GutterMarker | null {
	if (!highlight || lineFrom < highlight.firstLine || lineFrom > highlight.lastLine) return null;
	if (lineFrom === highlight.firstLine) {
		return lineFrom === highlight.lastLine ? singleMarker : startMarker;
	}
	return lineFrom === highlight.lastLine ? endMarker : middleMarker;
}

const topBoundary = "inset 0 1px 0 var(--mantine-color-indigo-light-hover)";
const bottomBoundary = "inset 0 -1px 0 var(--mantine-color-indigo-light-hover)";

export const fileNavigationHighlightExtension: Extension = [
	fileNavigationHighlight,
	// A non-interactive overlay tints the line-number background, without replacing numbers or
	// allocating a marker for every line of a potentially enormous target range.
	// CodeMirror calls lineMarker only for rendered lines, including wrapped lines.
	gutter({
		class: "cm-file-navigation-gutter",
		lineMarker: (view, line) =>
			fileNavigationGutterMarker(view.state.field(fileNavigationHighlight), line.from),
		lineMarkerChange: (update) =>
			update.startState.field(fileNavigationHighlight) !==
			update.state.field(fileNavigationHighlight),
	}),
	EditorView.baseTheme({
		".cm-gutters": { position: "relative" },
		".cm-lineNumbers": { position: "relative", zIndex: "1" },
		".cm-file-navigation-gutter": {
			position: "absolute",
			top: "0",
			insetInlineStart: "0",
			width: "100%",
			pointerEvents: "none",
			zIndex: "0",
		},
		".cm-file-navigation-gutter .cm-gutterElement": {
			width: "100%",
			backgroundColor: "var(--mantine-color-indigo-light)",
		},
		// Inset shadows do not change line height or disturb wrapped-line geometry.
		".cm-file-navigation-start": { boxShadow: topBoundary },
		".cm-file-navigation-end": { boxShadow: bottomBoundary },
		".cm-file-navigation-start.cm-file-navigation-end": {
			boxShadow: `${topBoundary}, ${bottomBoundary}`,
		},
	}),
];
