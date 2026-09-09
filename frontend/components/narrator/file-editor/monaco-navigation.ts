import type { FileSelection } from "@shared/file-reference";
import type { editor, IPosition, IRange } from "monaco-editor/editor/editor.api";

export function monacoFileSelectionRange(
	model: Pick<editor.ITextModel, "getLineCount" | "getLineMaxColumn" | "getOffsetAt"> & {
		getPositionAt(offset: number): IPosition;
	},
	selection: FileSelection,
): IRange {
	const position = (line: number, column: number) => {
		if (line > model.getLineCount())
			return {
				lineNumber: model.getLineCount(),
				column: model.getLineMaxColumn(model.getLineCount()),
			};
		const lineNumber = Math.max(1, Math.trunc(line) || 1);
		return {
			lineNumber,
			column: Math.min(model.getLineMaxColumn(lineNumber), Math.max(1, Math.trunc(column) || 1)),
		};
	};
	const a = model.getOffsetAt(position(selection.startLineNumber, selection.startColumn));
	const b = model.getOffsetAt(position(selection.endLineNumber, selection.endColumn));
	const start = model.getPositionAt(Math.min(a, b));
	const end = model.getPositionAt(Math.max(a, b));
	return {
		startLineNumber: start.lineNumber,
		startColumn: start.column,
		endLineNumber: end.lineNumber,
		endColumn: end.column,
	};
}

export function monacoFileSelection(range: IRange | null): FileSelection | null {
	if (
		!range ||
		(range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn)
	)
		return null;
	return {
		startLineNumber: range.startLineNumber,
		startColumn: range.startColumn,
		endLineNumber: range.endLineNumber,
		endColumn: range.endColumn,
	};
}

/** Exclusive line-start ends must not tint the following line. */
export function monacoNavigationLines(range: IRange): { first: number; last: number } {
	return {
		first: range.startLineNumber,
		last: Math.max(range.startLineNumber, range.endLineNumber - (range.endColumn === 1 ? 1 : 0)),
	};
}

/** Constant decoration count even for a 300k-line reference. Tracked range follows edits. */
export class MonacoNavigationHighlight {
	private tracked: editor.IEditorDecorationsCollection;
	private paint: editor.IEditorDecorationsCollection;
	constructor(editor: editor.IStandaloneCodeEditor) {
		this.tracked = editor.createDecorationsCollection();
		this.paint = editor.createDecorationsCollection();
	}
	set(range: IRange | null): void {
		this.tracked.set(range ? [{ range, options: { stickiness: 1 } }] : []);
		this.refresh();
	}
	refresh(): void {
		const range = this.tracked.getRange(0);
		if (!range) {
			this.paint.clear();
			return;
		}
		const { first, last } = monacoNavigationLines(range);
		const line = (n: number): IRange => ({
			startLineNumber: n,
			startColumn: 1,
			endLineNumber: n,
			endColumn: 1,
		});
		const boundaries: editor.IModelDeltaDecoration[] =
			first === last
				? [
						{
							range: line(first),
							options: {
								isWholeLine: true,
								className: "nf-monaco-navigation-start nf-monaco-navigation-end",
							},
						},
					]
				: [
						{
							range: line(first),
							options: {
								isWholeLine: true,
								className: "nf-monaco-navigation-start",
							},
						},
						{
							range: line(last),
							options: {
								isWholeLine: true,
								className: "nf-monaco-navigation-end",
							},
						},
					];
		this.paint.set([
			{
				range: { ...line(first), endLineNumber: last },
				options: {
					isWholeLine: true,
					marginClassName: "nf-monaco-navigation-gutter",
				},
			},
			...boundaries,
		]);
	}
	dispose(): void {
		this.tracked.clear();
		this.paint.clear();
	}
}
