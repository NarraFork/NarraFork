import type { MeasuredCollapsibleTrace, MeasuredTraceRow } from "./measure/measure-tool-run";
import type { MeasuredElement } from "./prepared-block";
import { hasUnpredictableBlock } from "./vlist-unpredictable-blocks";

export interface TraceUnknownBodyHeight {
	/** A delayed observer may only correct the exact body it observed. */
	originalBodyRef: MeasuredElement;
	/** Natural markdown height, excluding the preview disclosure button. */
	height: number;
}

export type TraceUnknownBodyHeights = ReadonlyMap<string, TraceUnknownBodyHeight>;

/** Ordinary text, previews and nested tool cards never acquire DOM measurements. */
export function isExpandedUnknownTraceBody(row: MeasuredTraceRow): boolean {
	return (
		row.expanded &&
		row.body?.textPreview?.expanded === true &&
		hasUnpredictableBlock(row.body.blocks)
	);
}

/** Retain only currently mounted, expanded unknown bodies; source/LOD swaps expire readings. */
export function retainTraceUnknownHeights(
	measured: MeasuredCollapsibleTrace,
	heights: TraceUnknownBodyHeights,
): TraceUnknownBodyHeights {
	const current = new Map(
		measured.rows.filter(isExpandedUnknownTraceBody).map((row) => [row.key, row.body]),
	);
	let next: Map<string, TraceUnknownBodyHeight> | undefined;
	for (const [key, entry] of heights) {
		if (
			current.get(key) === entry.originalBodyRef &&
			Number.isFinite(entry.height) &&
			entry.height > 0
		)
			continue;
		next ??= new Map(heights);
		next.delete(key);
	}
	return next ?? heights;
}

/** Pure local reflow: grow/shrink the body, its row and every following visible row.
 * Cache-owned measurements remain immutable; unknown markdown keeps natural flow.
 */
export function applyTraceUnknownHeights(
	measured: MeasuredCollapsibleTrace,
	heights: TraceUnknownBodyHeights,
): MeasuredCollapsibleTrace {
	if (heights.size === 0) return measured;
	let shift = 0;
	let changed = false;
	const rowDeltas = new Map<number, { oldHeight: number; delta: number }>();
	const rows = measured.rows.map((row) => {
		const entry = heights.get(row.key);
		let body = row.body;
		let delta = 0;
		if (
			body &&
			entry?.originalBodyRef === body &&
			isExpandedUnknownTraceBody(row) &&
			Number.isFinite(entry.height) &&
			entry.height > 0
		) {
			const preview = body.textPreview;
			if (preview) {
				const height = entry.height + preview.buttonHeight;
				delta = height - body.height;
				if (delta !== 0 || preview.bodyHeight !== entry.height) {
					body = {
						...body,
						height,
						// RenderMarkdown's natural-flow minHeight must remain the original
						// prediction, never the last report (which would prevent shrinking).
						textPreview: { ...preview, bodyHeight: entry.height },
					};
					changed = true;
				}
			}
		}
		const corrected =
			body === row.body && shift === 0 && delta === 0
				? row
				: {
						...row,
						body,
						top: row.top + shift,
						bodyTop: row.bodyTop + shift,
						blockHeight: row.blockHeight + delta,
					};
		if (delta !== 0) rowDeltas.set(row.top, { oldHeight: row.blockHeight, delta });
		shift += delta;
		return corrected;
	});
	if (!changed) return measured;
	let frameShift = 0;
	const blocks = measured.frame.blocks.map((block) => {
		const candidate = rowDeltas.get(block.top);
		const delta = candidate?.oldHeight === block.height ? candidate.delta : 0;
		const corrected =
			frameShift === 0 && delta === 0
				? block
				: {
						...block,
						top: block.top + frameShift,
						height: block.height + delta,
					};
		frameShift += delta;
		return corrected;
	});
	return {
		...measured,
		rows,
		height: measured.height + shift,
		frame: { ...measured.frame, blocks, contentHeight: measured.frame.contentHeight + shift },
	};
}
