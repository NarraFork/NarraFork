import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { capturePretextLayoutAnchor, restorePretextLayoutAnchor } from "@shared/pretext-layout";
import { buildPretextEngineLayout } from "@shared/pretext-layout/engine";
import {
	computePretextVListLayout,
	type MeasureElement,
} from "@shared/pretext-layout/layout-pipeline";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { measureElementCached } from "./registry";
import type { AdapterSegment } from "./segment-adapter";
import {
	indexWithHeightOverrides,
	previewResize,
	RESIZE_PREVIEW_MAX_ITEMS,
	type ResizePreviewInput,
} from "./vlist-resize-preview";

let disposeCanvas: () => void;
let fixtureRevision = 0;
beforeAll(() => {
	disposeCanvas = installCanvasStub();
});
afterAll(() => disposeCanvas());

/** Adapt real messages and measure their real prepared blocks before building the shared index. */
function fixture({
	count = 100,
	width = 860,
	text = "A real paragraph whose words must wrap differently as the column changes. ".repeat(8),
	gapAfter,
}: {
	count?: number;
	width?: number;
	text?: string;
	gapAfter?: (index: number) => number | undefined;
} = {}) {
	const segments: AdapterSegment[] = Array.from({ length: count }, (_, seq) => ({
		kind: "message",
		msg: {
			id: `resize-${seq}`,
			role: "assistant",
			contentJson: [{ type: "text", text }],
		},
	}));
	const options = {
		contentWidth: width,
		lod: 5 as const,
		documentRevision: `resize-fixture-${++fixtureRevision}`,
		gap: 4,
		topPadding: 16,
		bottomPadding: 24,
	};
	const computed = computePretextVListLayout(segments, options, measureElementCached);
	const built = buildPretextEngineLayout(
		computed.items.map((item, seq) => ({
			itemKey: item.spec.key,
			firstSeq: seq,
			lastSeq: seq,
			sourceMessageIds: [`resize-${seq}`],
			kind: item.spec.kind,
			gapAfter: gapAfter?.(seq),
			measured: item.measured,
		})),
		{ prepare: (source) => source.measured, measure: (measured) => measured.height },
		{
			...options,
			layoutRevision: `resize-${width}`,
			widthBucket: String(width),
			viewportHeight: 400,
			metrics: { topPadding: 16, itemGap: 4, bottomPadding: 24 },
		},
	);
	expect(computed.items).toHaveLength(count);
	return { index: built.index, items: computed.items, committedWidth: width };
}

function measuredCalls() {
	const calls: { key: string | undefined; width: number }[] = [];
	const measure: MeasureElement = (...args) => {
		calls.push({ key: args[5], width: args[2] });
		return measureElementCached(...args);
	};
	return { calls, measure };
}

function preview(
	frame: Pick<ResizePreviewInput, "index" | "items" | "committedWidth">,
	options: Partial<Omit<ResizePreviewInput, "index" | "items" | "committedWidth">> = {},
) {
	return previewResize({
		...frame,
		width: 420,
		lod: 5,
		view: { scrollTop: 0, viewportHeight: 400, pinnedToBottom: false },
		measure: measureElementCached,
		...options,
	});
}

function geometry(index: ResizePreviewInput["index"]) {
	return {
		items: index.manifest.items.map((item) => ({ ...item })),
		starts: [...index.itemStarts],
		ends: [...index.itemEnds],
		totalHeight: index.totalHeight,
	};
}

function expectGapGeometry(index: ResizePreviewInput["index"]) {
	let cursor = index.manifest.metrics.topPadding;
	for (const [i, item] of index.manifest.items.entries()) {
		expect(index.itemStart(i)).toBe(cursor);
		cursor += item.height;
		expect(index.itemEnd(i)).toBe(cursor);
		if (i < index.manifest.items.length - 1)
			cursor += item.gapAfter ?? index.manifest.metrics.itemGap;
	}
	expect(index.totalHeight).toBe(cursor + index.manifest.metrics.bottomPadding);
}

describe("previewResize on the real adaptation/measurement/index pipeline", () => {
	it("never measures outside the buffered window and retains spec, prepared frame and width refs", () => {
		const base = fixture();
		const saved = geometry(base.index);
		const { measure, calls } = measuredCalls();
		const view = {
			scrollTop: base.index.itemStart(40) + 10,
			viewportHeight: 240,
			pinnedToBottom: false,
		};
		const first = base.index.itemIndexAtOffset(view.scrollTop - 160);
		const last = base.index.itemIndexAtOffset(view.scrollTop + view.viewportHeight + 160);
		const result = preview(base, { view, measure });
		expect(calls.length).toBeGreaterThan(0);
		for (const [i, old] of base.items.entries()) {
			expect(result.items[i]?.spec).toBe(old.spec);
			if (i < first || i > last) {
				expect(calls.filter((call) => call.key === old.spec.key)).toHaveLength(0);
				expect(result.items[i]).toBe(old);
				expect(result.items[i]?.measured).toBe(old.measured);
				expect(result.items[i]?.contentWidth).toBe(860);
			} else {
				expect(calls.filter((call) => call.key === old.spec.key)).toHaveLength(1);
				expect(result.items[i]?.contentWidth).toBe(420);
				expect(result.items[i]?.measured).not.toBe(old.measured);
			}
		}
		expect(geometry(base.index)).toEqual(saved);
		expect(base.items.every((item) => item.contentWidth === 860)).toBe(true);
	});

	for (const budget of [undefined, 7]) {
		it(`bounds a dense viewport to ${budget ?? "the default 64"} real measurements`, () => {
			const base = fixture({ count: 160, text: "one line" });
			const { measure, calls } = measuredCalls();
			const result = preview(base, {
				maxItems: budget,
				measure,
				view: { scrollTop: 0, viewportHeight: base.index.totalHeight, pinnedToBottom: false },
			});
			expect(calls).toHaveLength(budget ?? RESIZE_PREVIEW_MAX_ITEMS);
			expect(result.changedKeys.size).toBe(budget ?? 64);
			expect(result.needsMore).toBe(true);
		});
	}

	it("spends a small budget on the viewport before either overscan side", () => {
		const base = fixture({ text: "one line" });
		const { measure, calls } = measuredCalls();
		const scrollTop = base.index.itemStart(40) + 2;
		const result = preview(base, {
			maxItems: 1,
			overscan: 1000,
			measure,
			view: { scrollTop, viewportHeight: 100, pinnedToBottom: false },
		});
		expect(calls).toEqual([{ key: base.items[40]?.spec.key, width: 420 }]);
		expect(result.items[39]).toBe(base.items[39]);
		expect(result.needsMore).toBe(true);
	});

	it("requests another bounded batch when shorter wrapping reveals rows below the old window", () => {
		const base = fixture({ width: 160, count: 60 });
		const { measure, calls } = measuredCalls();
		const first = preview(base, { width: 1200, overscan: 0, maxItems: 2, measure });
		expect(first.items[0]?.measured.height).toBeLessThan(base.items[0]?.measured.height ?? 0);
		expect(first.needsMore).toBe(true);
		expect(calls.length).toBeLessThanOrEqual(2);
		const firstSaved = geometry(first.index);
		const second = preview(
			{ ...base, ...first },
			{
				width: 1200,
				overscan: 0,
				maxItems: 2,
				measure,
				view: { scrollTop: first.scrollTop, viewportHeight: 400, pinnedToBottom: false },
			},
		);
		expect(second.changedKeys.size).toBeGreaterThan(0);
		expect(second.changedKeys.size).toBeLessThanOrEqual(2);
		expect(second.items[0]).toBe(first.items[0]);
		let result = second;
		for (let batch = 0; result.needsMore && batch < 30; batch++) {
			const before = calls.length;
			result = preview(
				{ ...base, ...result },
				{
					width: 1200,
					overscan: 0,
					maxItems: 2,
					measure,
					view: { scrollTop: result.scrollTop, viewportHeight: 400, pinnedToBottom: false },
				},
			);
			expect(calls.length - before).toBeLessThanOrEqual(2);
		}
		expect(result.needsMore).toBe(false);
		const end = result.index.itemIndexAtOffset(result.scrollTop + 400);
		for (let i = 0; i <= end; i++) expect(result.items[i]?.contentWidth).toBe(1200);
		expect(new Set(calls.map((call) => call.key)).size).toBe(calls.length);
		expect(geometry(first.index)).toEqual(firstSaved);
	});

	for (const pinnedToBottom of [false, true]) {
		it(`restores the ${pinnedToBottom ? "bottom distance" : "item and interior offset"} anchor`, () => {
			const base = fixture();
			const view = {
				scrollTop: pinnedToBottom
					? base.index.totalHeight - 260 - 12
					: base.index.itemStart(30) + 9,
				viewportHeight: 260,
				pinnedToBottom,
			};
			const anchor = capturePretextLayoutAnchor(base.index, view.scrollTop, 260, pinnedToBottom);
			const result = preview(base, { view, overscan: 300 });
			expect(result.anchorKind).toBe(pinnedToBottom ? "bottom" : "item");
			expect(result.scrollTop).toBe(restorePretextLayoutAnchor(anchor, result.index, 260));
			if (anchor.kind === "bottom") {
				expect(result.index.totalHeight - result.scrollTop - 260).toBe(12);
			} else {
				const found = result.index.itemByKey(anchor.itemKey);
				expect(found).toBeDefined();
				expect(result.scrollTop - result.index.itemStart(found?.index ?? -1)).toBe(9);
			}
		});
	}

	it("keeps multiple historical widths, measures newly scrolled windows and skips already-current rows", () => {
		const base = fixture();
		const first = preview(base, { width: 500, overscan: 0 });
		const second = preview(
			{ ...base, ...first },
			{
				width: 260,
				overscan: 0,
				view: { scrollTop: first.index.itemStart(60), viewportHeight: 240, pinnedToBottom: false },
			},
		);
		expect(new Set(second.items.map((item) => item.contentWidth))).toEqual(
			new Set([860, 500, 260]),
		);
		const { measure, calls } = measuredCalls();
		const third = preview(
			{ ...base, ...second },
			{
				width: 500,
				overscan: 0,
				measure,
				view: { scrollTop: second.index.itemStart(60), viewportHeight: 240, pinnedToBottom: false },
			},
		);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.some((call) => call.key === base.items[0]?.spec.key)).toBe(false);
		expect(third.items[0]).toBe(first.items[0]);
		expect(third.items[30]).toBe(base.items[30]);
		for (const key of third.changedKeys) {
			const i = third.index.itemByKey(key)?.index ?? -1;
			expect(second.items[i]?.contentWidth).toBe(260);
			expect(third.items[i]?.contentWidth).toBe(500);
		}
		calls.length = 0;
		const revisit = preview({ ...base, ...third }, { width: 500, overscan: 0, measure });
		expect(calls).toHaveLength(0);
		expect(revisit.items).toBe(third.items);
		expect(revisit.index).toBe(third.index);
	});

	it("publishes a new prepared width frame even when the measured height does not change", () => {
		const base = fixture({ count: 3, text: "short" });
		const result = preview(base, { width: 600 });
		expect(result.changedKeys.size).toBe(3);
		expect(result.index).toBe(base.index);
		expect(result.items).not.toBe(base.items);
		for (const [i, old] of base.items.entries()) {
			expect(result.items[i]?.measured.height).toBe(old.measured.height);
			expect(result.items[i]?.measured).not.toBe(old.measured);
			expect(result.items[i]?.spec).toBe(old.spec);
			expect(result.items[i]?.contentWidth).toBe(600);
		}
	});

	it("uses the committed width only for legacy items missing their own outer width", () => {
		const base = fixture({ count: 3, text: "short" });
		const legacy = base.items.map(({ spec, measured }) => ({ spec, measured }));
		const { measure, calls } = measuredCalls();
		const same = preview({ ...base, items: legacy }, { width: 860, measure });
		expect(same.items).toBe(legacy);
		expect(calls).toHaveLength(0);
		const changed = preview({ ...base, items: legacy }, { width: 600, measure });
		expect(calls).toHaveLength(3);
		expect(changed.items.every((item) => item.contentWidth === 600)).toBe(true);
	});

	it("preserves zero, wide and last-item gaps through both override and preview patches", () => {
		const base = fixture({ count: 4, gapAfter: (i) => [0, 96, undefined, 999][i] });
		const old = geometry(base.index);
		const overrides = new Map([[base.items[1]?.spec.key ?? "", 700]]);
		const effective = indexWithHeightOverrides(base.index, overrides);
		expect(effective.manifest.items[1]?.height).toBe(700);
		expectGapGeometry(effective);
		const result = preview(base, {
			heightOverrides: overrides,
			view: { scrollTop: 0, viewportHeight: effective.totalHeight, pinnedToBottom: false },
		});
		expect(result.changedKeys.has(base.items[1]?.spec.key ?? "")).toBe(true);
		// A real height reported at the old width must not survive this item's reflow.
		expect(result.index.manifest.items[1]?.height).toBe(result.items[1]?.measured.height);
		expect(result.index.manifest.items[1]?.height).not.toBe(700);
		expect(result.index.manifest.items.map((item) => item.gapAfter)).toEqual([
			0,
			96,
			undefined,
			999,
		]);
		expectGapGeometry(result.index);
		expect(result.index.totalHeight).toBe(result.index.itemEnd(3) + 24);
		expect(geometry(base.index)).toEqual(old);
		expect(effective.manifest.items[1]?.height).toBe(700);
	});

	it("keeps an off-screen override at its unchanged width but excludes the reflowed row's old height", () => {
		const base = fixture({ gapAfter: (i) => (i === 0 ? 0 : 96) });
		const firstKey = base.items[0]?.spec.key ?? "";
		const changedKey = base.items[1]?.spec.key ?? "";
		const overrides = new Map([
			[firstKey, 600],
			[changedKey, 340],
		]);
		const effective = indexWithHeightOverrides(base.index, overrides);
		const view = {
			scrollTop: effective.itemStart(1) + 9,
			viewportHeight: 100,
			pinnedToBottom: false,
		};
		const anchor = capturePretextLayoutAnchor(effective, view.scrollTop, 100, false);
		const { measure, calls } = measuredCalls();
		const result = preview(base, { view, heightOverrides: overrides, overscan: 0, measure });
		expect(calls).toEqual([{ key: changedKey, width: 420 }]);
		expect(result.items[0]).toBe(base.items[0]);
		expect(result.index.manifest.items[0]).toBe(base.index.manifest.items[0]);
		expect(result.index.manifest.items[1]?.height).toBe(result.items[1]?.measured.height);
		expect(result.index.manifest.items[1]?.height).not.toBe(340);
		const nextEffective = indexWithHeightOverrides(result.index, overrides, result.changedKeys);
		expect(nextEffective.manifest.items[0]?.height).toBe(600);
		expect(result.scrollTop).toBe(restorePretextLayoutAnchor(anchor, nextEffective, 100));
		expect(result.scrollTop - nextEffective.itemStart(1)).toBe(9);
		expectGapGeometry(nextEffective);
		expect(overrides.get(changedKey)).toBe(340);
	});

	it("ignores excluded, unknown and invalid overrides without dropping unrelated geometry", () => {
		const base = fixture({ count: 4, gapAfter: () => 32 });
		const key = (i: number) => base.items[i]?.spec.key ?? "";
		const overrides = new Map([
			[key(0), 0],
			[key(1), 900],
			[key(2), Number.NaN],
			[key(3), -1],
			["not-in-this-document", 800],
		]);
		const result = indexWithHeightOverrides(base.index, overrides, new Set([key(1)]));
		expect(result.manifest.items[0]?.height).toBe(0);
		for (let i = 1; i < 4; i++) expect(result.manifest.items[i]).toBe(base.index.manifest.items[i]);
		expectGapGeometry(result);
		expect(indexWithHeightOverrides(base.index, new Map())).toBe(base.index);
	});
});

it("a same-width dirty refresh retains valid dynamic overrides when restoring the anchor", () => {
	const base = fixture({ count: 3, text: "short" });
	const key = base.items[0]?.spec.key;
	if (!key) throw new Error("missing first item");
	const result = preview(base, {
		width: base.committedWidth,
		dirtyKeys: new Set([key]),
		heightOverrides: new Map([[key, 200]]),
		view: { scrollTop: 100, viewportHeight: 100, pinnedToBottom: false },
	});
	expect(result.changedKeys.has(key)).toBe(true);
	expect(result.scrollTop).toBe(100);
	expect(base.items[0]?.contentWidth).toBe(result.items[0]?.contentWidth);
});
