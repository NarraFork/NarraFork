import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { accumulateFrame, type MeasuredElement, type PreparedFixedBlock } from "../prepared-block";

/** Explicit pixel lanes shared with render; every label is single-line ellipsis. */
export const MODELTRACE_LAYOUT = {
	padding: 12,
	gap: 10,
	name: 20,
	winnerName: 26,
	barGap: 4,
	bar: 6,
	winnerBar: 8,
	footnote: 16,
	maxResults: 5,
} as const;

export function modelTraceRowHeight(winner: boolean): number {
	const c = MODELTRACE_LAYOUT;
	return (winner ? c.winnerName : c.name) + c.barGap + (winner ? c.winnerBar : c.bar);
}

export function modelTraceResultHeight(rowCount: number): number {
	const c = MODELTRACE_LAYOUT;
	const chrome = 2 * c.padding;
	if (rowCount === 0) return chrome + c.name;
	return (
		chrome +
		modelTraceRowHeight(true) +
		(rowCount - 1) * (modelTraceRowHeight(false) + c.gap) +
		c.gap +
		c.footnote
	);
}

export function measureModelTraceResult(
	data: ModelTraceResultBlock,
	contentWidth: number,
): MeasuredElement {
	// Stored history may be malformed. Keep the card bounded and never paint NaN bars.
	const results = data.error
		? []
		: (Array.isArray(data.results) ? data.results : [])
				.filter(
					(row) =>
						row &&
						typeof row.model === "string" &&
						typeof row.displayName === "string" &&
						Number.isFinite(row.probability) &&
						row.probability >= 0 &&
						row.probability <= 1,
				)
				.slice(0, MODELTRACE_LAYOUT.maxResults);
	const block: PreparedFixedBlock = {
		kind: "fixed",
		tag: "modeltrace_result",
		height: modelTraceResultHeight(results.length),
		data: { type: "modeltrace_result", results, error: data.error },
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	const blocks = [block];
	const frame = accumulateFrame(blocks, contentWidth, () => ({ lineCount: 1, maxLineWidth: 0 }));
	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: contentWidth,
	};
}
