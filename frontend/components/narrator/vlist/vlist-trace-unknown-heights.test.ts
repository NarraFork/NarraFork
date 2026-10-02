import { describe, expect, it } from "bun:test";
import type { MeasuredCollapsibleTrace, MeasuredTraceRow } from "./measure/measure-tool-run";
import type { MeasuredElement, PreparedUnknownBlock } from "./prepared-block";
import {
	applyTraceUnknownHeights,
	isExpandedUnknownTraceBody,
	retainTraceUnknownHeights,
} from "./vlist-trace-unknown-heights";

function body(height: number, expanded = true): MeasuredElement {
	const block: PreparedUnknownBlock = {
		kind: "unknown",
		tag: "mermaid",
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
		placeholderHeight: height,
		data: {},
	};
	return {
		height: height + 20,
		blocks: [block],
		contentWidth: 300,
		usedWidth: 300,
		frame: {
			blocks: [{ index: 0, top: 0, height, usedWidth: 300 }],
			contentHeight: height,
			usedWidth: 300,
		},
		textPreview: {
			sourceText: "diagram",
			previewText: "diagram",
			charCount: 7,
			expanded,
			clipped: true,
			direction: "head",
			plainText: false,
			bodyHeight: height,
			buttonHeight: 20,
			sourceStart: 0,
		},
	};
}

function trace(): MeasuredCollapsibleTrace {
	let top = 24;
	const rows = [body(100), null, body(60), null].map((body, index) => {
		const blockHeight = 20 + (body ? body.height + 4 : 0);
		const row = {
			key: String(index),
			itemIndex: index,
			top,
			bodyTop: top + 22,
			rowHeight: 20,
			blockHeight,
			body,
			expanded: !!body,
			expandable: !!body,
			title: `row ${index}`,
			hasIcon: false,
			status: null,
			timing: null,
			displayDurationMs: null,
			diffStats: null,
			shimmer: false,
			cardMeasured: null,
			cardKind: "tool-call",
			canDrillDown: false,
			bodyLeft: 22,
			drillHeader: null,
		} as MeasuredTraceRow;
		top += blockHeight;
		return row;
	});
	return {
		variant: "reasoning-steps",
		rows,
		height: top + 2,
		contentWidth: 300,
		usedWidth: 300,
		blocks: [],
		frame: {
			contentHeight: top + 2,
			usedWidth: 300,
			blocks: [
				{ index: 0, top: 0, height: 24, usedWidth: 300 },
				...rows.map((row, index) => ({
					index: index + 1,
					top: row.top,
					height: row.blockHeight,
					usedWidth: 300,
				})),
				{ index: 5, top, height: 2, usedWidth: 300 },
			],
		},
		itemCount: 4,
		maxVisible: 4,
		collapsedToHeader: false,
		headerBandHeight: 24,
		header: {
			top: 0,
			height: 24,
			visible: true,
			hasChevron: false,
			opened: true,
			label: "reasoning",
			count: "4",
			variant: "reasoning-steps",
		},
		toggle: null,
	};
}

describe("controlled trace unknown body reflow", () => {
	it("adds disclosure chrome, shifts every following row and updates frame/preview height without mutating source", () => {
		const measured = trace();
		const first = measured.rows[0];
		const third = measured.rows[2];
		if (!first?.body || !third?.body) throw new Error("Missing fixture body");
		const next = applyTraceUnknownHeights(
			measured,
			new Map([
				[first.key, { originalBodyRef: first.body, height: 200 }],
				[third.key, { originalBodyRef: third.body, height: 40 }],
			]),
		);
		expect(next.height).toBe(measured.height + 80);
		expect(next.frame.contentHeight).toBe(measured.frame.contentHeight + 80);
		expect(next.rows[0]?.body?.height).toBe(220);
		expect(next.rows[0]?.body?.frame).toBe(first.body.frame);
		expect(next.rows[0]?.body?.frame.contentHeight).toBe(100);
		expect(next.rows[0]?.body?.textPreview?.bodyHeight).toBe(200);
		expect(next.rows[0]?.body?.textPreview?.buttonHeight).toBe(20);
		for (const index of [1, 2]) {
			expect(next.rows[index]?.top).toBe((measured.rows[index]?.top ?? 0) + 100);
			expect(next.rows[index]?.bodyTop).toBe((measured.rows[index]?.bodyTop ?? 0) + 100);
		}
		expect(next.rows[3]?.top).toBe((measured.rows[3]?.top ?? 0) + 80);
		expect(next.rows[2]?.blockHeight).toBe(third.blockHeight - 20);
		expect(next.frame.blocks[5]?.top).toBe((measured.frame.blocks[5]?.top ?? 0) + 80);
		expect(first.body.height).toBe(120);
		expect(first.body.frame.contentHeight).toBe(100);
	});

	it("rejects old-source, invalid, collapsed-preview and known-body readings", () => {
		const measured = trace();
		const row = measured.rows[0];
		if (!row?.body) throw new Error("Missing fixture body");
		for (const entry of [
			{ originalBodyRef: body(100), height: 800 },
			{ originalBodyRef: row.body, height: NaN },
			{ originalBodyRef: row.body, height: -1 },
		])
			expect(applyTraceUnknownHeights(measured, new Map([[row.key, entry]]))).toBe(measured);
		const collapsed = { ...row, body: body(100, false) };
		expect(isExpandedUnknownTraceBody(collapsed)).toBe(false);
		const known = { ...row, body: { ...row.body, blocks: [] } };
		expect(isExpandedUnknownTraceBody(known)).toBe(false);
		expect(isExpandedUnknownTraceBody({ ...row, expanded: false })).toBe(false);
	});

	it("bounds retained state to current eligible row bodies across source/fold changes", () => {
		const measured = trace();
		const row = measured.rows[0];
		if (!row?.body) throw new Error("Missing fixture body");
		const heights = new Map([[row.key, { originalBodyRef: row.body, height: 400 }]]);
		expect(retainTraceUnknownHeights(measured, heights)).toBe(heights);
		const rewritten = { ...measured, rows: [{ ...row, body: body(100) }] };
		expect(retainTraceUnknownHeights(rewritten, heights).size).toBe(0);
		expect(retainTraceUnknownHeights({ ...measured, rows: [] }, heights).size).toBe(0);
		expect(
			retainTraceUnknownHeights({ ...measured, rows: [{ ...row, expanded: false }] }, heights).size,
		).toBe(0);
	});
});
