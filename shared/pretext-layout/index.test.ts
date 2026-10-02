import { describe, expect, it } from "bun:test";
import {
	buildPretextLayoutIndex,
	capturePretextLayoutAnchor,
	type PretextLayoutIndex,
	type PretextLayoutItem,
	type PretextLayoutManifest,
	patchPretextLayoutHeights,
	replacePretextLayout,
} from "./index";

function manifest(count: number, height = 48): PretextLayoutManifest {
	const items: PretextLayoutItem[] = Array.from({ length: count }, (_, index) => ({
		itemKey: `message-${index}`,
		firstSeq: index,
		lastSeq: index,
		sourceMessageIds: [`message-${index}`],
		kind: index % 3 === 0 ? "message-bubble" : "markdown",
		height: height + (index % 5) * 7,
	}));
	return {
		layoutRevision: `layout-${count}`,
		documentRevision: count,
		lod: 3,
		widthBucket: "860",
		metrics: { topPadding: 16, itemGap: 4, bottomPadding: 16 },
		items,
	};
}

function expectEquivalentLayout(actual: PretextLayoutIndex, expected: PretextLayoutIndex): void {
	expect(actual.manifest).toEqual(expected.manifest);
	expect(actual.itemStarts).toEqual(expected.itemStarts);
	expect(actual.itemEnds).toEqual(expected.itemEnds);
	expect(actual.totalHeight).toBe(expected.totalHeight);
	for (let itemIndex = -1; itemIndex <= expected.manifest.items.length; itemIndex++) {
		expect(actual.itemStart(itemIndex)).toBe(expected.itemStart(itemIndex));
		expect(actual.itemEnd(itemIndex)).toBe(expected.itemEnd(itemIndex));
	}
	const offsets = [-1, 0, actual.totalHeight, actual.totalHeight + 1, Infinity, -Infinity];
	for (let itemIndex = 0; itemIndex < actual.manifest.items.length; itemIndex++) {
		const item = expected.manifest.items[itemIndex];
		if (!item) continue;
		expect(actual.itemByKey(item.itemKey)).toEqual(expected.itemByKey(item.itemKey));
		expect(actual.itemByKey(item.itemKey)?.item).toBe(actual.manifest.items[itemIndex]);
		for (const seq of [item.firstSeq - 1, item.firstSeq, item.lastSeq, item.lastSeq + 1]) {
			expect(actual.itemIndicesForSourceSeq(seq)).toEqual(expected.itemIndicesForSourceSeq(seq));
		}
		for (const messageId of item.sourceMessageIds) {
			expect(actual.itemIndicesForSourceMessageId(messageId)).toEqual(
				expected.itemIndicesForSourceMessageId(messageId),
			);
		}
		const start = actual.itemStart(itemIndex);
		const end = actual.itemEnd(itemIndex);
		offsets.push(start - 0.01, start, start + 0.01, (start + end) / 2, end - 0.01, end, end + 0.01);
	}
	for (const offset of offsets) {
		expect(actual.itemIndexAtOffset(offset)).toBe(expected.itemIndexAtOffset(offset));
	}
	expect(actual.itemByKey("missing")).toBeUndefined();
	expect(actual.itemIndicesForSourceSeq(NaN)).toEqual([]);
	expect(actual.itemIndicesForSourceSeq(0.5)).toEqual([]);
	expect(actual.itemIndicesForSourceMessageId("missing")).toEqual([]);
}

function rebuildWithHeights(
	index: PretextLayoutIndex,
	heights: ReadonlyMap<number, number>,
	layoutRevision = index.manifest.layoutRevision,
): PretextLayoutIndex {
	return buildPretextLayoutIndex({
		...index.manifest,
		layoutRevision,
		items: index.manifest.items.map((item, itemIndex) => ({
			...item,
			height: heights.get(itemIndex) ?? item.height,
		})),
	});
}

describe("patchPretextLayoutHeights", () => {
	it("replaces only height-different items and shares identity/source lookups", () => {
		const previous = buildPretextLayoutIndex(manifest(451));
		const heights = new Map([
			[219, 213],
			[0, previous.manifest.items[0]?.height ?? 0],
			[450, 0],
		]);
		const next = patchPretextLayoutHeights(previous, heights, "patched");
		expectEquivalentLayout(next, rebuildWithHeights(previous, heights, "patched"));
		expect(next.manifest.metrics).toBe(previous.manifest.metrics);
		expect(next.itemIndicesForSourceSeq).toBe(previous.itemIndicesForSourceSeq);
		expect(next.itemIndicesForSourceMessageId).toBe(previous.itemIndicesForSourceMessageId);
		expect(next.itemIndicesForSourceMessageId("message-219")).toBe(
			previous.itemIndicesForSourceMessageId("message-219"),
		);
		for (let itemIndex = 0; itemIndex < previous.manifest.items.length; itemIndex++) {
			const before = previous.manifest.items[itemIndex];
			const after = next.manifest.items[itemIndex];
			if (!before || !after) throw new Error("missing item");
			if (itemIndex === 219 || itemIndex === 450) {
				const height = heights.get(itemIndex);
				if (height === undefined) throw new Error("missing patched height");
				expect(after).not.toBe(before);
				expect(after).toEqual({ ...before, height });
			} else expect(after).toBe(before);
			expect(after.sourceMessageIds).toBe(before.sourceMessageIds);
		}
		expect(next.itemStarts.slice(0, 220)).toEqual(previous.itemStarts.slice(0, 220));
		expect(next.itemEnds.slice(0, 219)).toEqual(previous.itemEnds.slice(0, 219));
		const sourceIndex = next.itemIndicesForSourceSeq(219)[0];
		expect(sourceIndex).toBe(219);
		expect(next.manifest.items[sourceIndex ?? -1]?.height).toBe(213);
		expect(next.itemByKey("message-219")?.item.height).toBe(213);
	});

	it("returns the original snapshot for no-op patches, but honors revision-only updates", () => {
		const previous = buildPretextLayoutIndex(manifest(5));
		const unchanged = new Map(previous.manifest.items.map((item, index) => [index, item.height]));
		expect(patchPretextLayoutHeights(previous, new Map())).toBe(previous);
		expect(patchPretextLayoutHeights(previous, unchanged)).toBe(previous);
		expect(patchPretextLayoutHeights(previous, unchanged, previous.manifest.layoutRevision)).toBe(
			previous,
		);
		const next = patchPretextLayoutHeights(previous, unchanged, "");
		expect(next).not.toBe(previous);
		expect(next.manifest.layoutRevision).toBe("");
		expect(next.manifest.items).toBe(previous.manifest.items);
		expect(next.manifest.metrics).toBe(previous.manifest.metrics);
		expect(next.itemStarts).toBe(previous.itemStarts);
		expect(next.itemEnds).toBe(previous.itemEnds);
		expectEquivalentLayout(next, rebuildWithHeights(previous, unchanged, ""));
		expect(patchPretextLayoutHeights(next, unchanged, "")).toBe(next);
	});

	it("preserves zero/custom gaps, drops the final gap and resolves offset boundaries", () => {
		const fixture = manifest(5);
		fixture.metrics = { topPadding: 11, itemGap: 4, bottomPadding: 13 };
		fixture.items = fixture.items.map((item, index) => ({
			...item,
			height: [5, 7, 2, 6, 8][index] ?? 0,
			gapAfter: [0, 3, 0, undefined, 999][index],
		}));
		const previous = buildPretextLayoutIndex(fixture);
		const heights = new Map([
			[4, 2],
			[0, 10],
			[1, 4],
		]);
		const next = patchPretextLayoutHeights(previous, heights);
		expect(next.itemStarts).toEqual([11, 21, 28, 30, 40]);
		expect(next.itemEnds).toEqual([21, 25, 30, 36, 42]);
		expect(next.totalHeight).toBe(55);
		for (const [offset, itemIndex] of [
			[-1, 0],
			[0, 0],
			[10, 0],
			[11, 0],
			[20.99, 0],
			[21, 1],
			[25, 2],
			[27, 2],
			[28, 2],
			[30, 3],
			[36, 4],
			[40, 4],
			[42, 4],
			[55, 4],
			[999, 4],
		]) {
			expect(next.itemIndexAtOffset(offset ?? 0)).toBe(itemIndex);
		}
		expectEquivalentLayout(next, rebuildWithHeights(previous, heights));
		const lastOnly = patchPretextLayoutHeights(next, new Map([[4, 10]]));
		expect(lastOnly.itemStarts).toEqual(next.itemStarts);
		expect(lastOnly.totalHeight).toBe(63);
	});

	it("handles empty, single-item and all-zero layouts with top/bottom padding", () => {
		const empty = buildPretextLayoutIndex(manifest(0));
		expect(patchPretextLayoutHeights(empty, new Map())).toBe(empty);
		const revisedEmpty = patchPretextLayoutHeights(empty, new Map(), "empty");
		expect(revisedEmpty.totalHeight).toBe(32);
		expect(revisedEmpty.itemStart(0)).toBe(16);
		expect(revisedEmpty.itemEnd(0)).toBe(16);
		expect(revisedEmpty.itemIndexAtOffset(16)).toBe(-1);
		expectEquivalentLayout(revisedEmpty, rebuildWithHeights(empty, new Map(), "empty"));
		for (const count of [1, 4]) {
			for (const padding of [0, 0.25, 16]) {
				const fixture = manifest(count);
				fixture.metrics = { topPadding: padding, itemGap: 0, bottomPadding: padding };
				fixture.items = fixture.items.map((item) => ({ ...item, gapAfter: 0 }));
				const previous = buildPretextLayoutIndex(fixture);
				const heights = new Map(fixture.items.map((_, index) => [index, 0]));
				const next = patchPretextLayoutHeights(previous, heights);
				expect(next.totalHeight).toBe(padding * 2);
				expectEquivalentLayout(next, rebuildWithHeights(previous, heights));
			}
		}
	});

	it("leaves frozen previous snapshots and the input map unchanged", () => {
		const previous = buildPretextLayoutIndex(manifest(9));
		const snapshot = JSON.stringify(previous);
		for (const item of previous.manifest.items) {
			Object.freeze(item.sourceMessageIds);
			Object.freeze(item);
		}
		Object.freeze(previous.manifest.items);
		Object.freeze(previous.manifest.metrics);
		Object.freeze(previous.manifest);
		Object.freeze(previous.itemStarts);
		Object.freeze(previous.itemEnds);
		Object.freeze(previous);
		const heights = new Map([[4, 0.7]]);
		const first = patchPretextLayoutHeights(previous, heights);
		const firstSnapshot = JSON.stringify(first);
		const second = patchPretextLayoutHeights(first, new Map([[0, 100.1]]));
		expectEquivalentLayout(first, rebuildWithHeights(previous, heights));
		expectEquivalentLayout(second, rebuildWithHeights(first, new Map([[0, 100.1]])));
		expect(JSON.stringify(previous)).toBe(snapshot);
		expect(JSON.stringify(first)).toBe(firstSnapshot);
		expect(previous.itemByKey("message-4")?.item.height).toBe(76);
		expect(first.itemByKey("message-4")?.item.height).toBe(0.7);
		expect([...heights]).toEqual([[4, 0.7]]);
	});

	it("rejects invalid indices/heights even after valid or unchanged entries without mutation", () => {
		const previous = buildPretextLayoutIndex(manifest(3));
		const snapshot = JSON.stringify(previous);
		for (const itemIndex of [-1, 3, 0.5, NaN, Infinity, -Infinity]) {
			expect(() => patchPretextLayoutHeights(previous, new Map([[itemIndex, 10]]))).toThrow(
				"invalid layout item index",
			);
		}
		for (const height of [-1, NaN, Infinity, -Infinity]) {
			for (const firstHeight of [48, 0]) {
				expect(() =>
					patchPretextLayoutHeights(
						previous,
						new Map([
							[0, firstHeight],
							[1, height],
						]),
						"bad",
					),
				).toThrow("finite non-negative");
			}
		}
		expect(() =>
			patchPretextLayoutHeights(
				previous,
				new Map([
					[0, 0],
					[3, 0],
				]),
			),
		).toThrow();
		expect(() =>
			patchPretextLayoutHeights(buildPretextLayoutIndex(manifest(0)), new Map([[0, 0]])),
		).toThrow();
		expect(JSON.stringify(previous)).toBe(snapshot);
		expectEquivalentLayout(previous, buildPretextLayoutIndex(manifest(3)));
	});

	it("matches full builds over seeded random fractional/zero heights and repeated patches", () => {
		let seed = 0x725e17;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		const fixture = manifest(51);
		fixture.metrics = { topPadding: 1.3, itemGap: 0.7, bottomPadding: 2.9 };
		fixture.items = fixture.items.map((item, index) => {
			const firstSeq = Math.floor(random() * 30) - 5;
			return {
				...item,
				firstSeq,
				lastSeq: firstSeq + Math.floor(random() * 15),
				sourceMessageIds: ["shared", `source-${index % 5}`, `source-${index % 5}`],
				height: random() * 100,
				gapAfter: index % 3 === 0 ? 0 : index % 3 === 1 ? random() * 3 : undefined,
			};
		});
		let actual = buildPretextLayoutIndex(fixture);
		let expected = buildPretextLayoutIndex(fixture);
		const sourceLookup = actual.itemIndicesForSourceSeq;
		const messageLookup = actual.itemIndicesForSourceMessageId;
		for (let round = 0; round < 80; round++) {
			const heights = new Map<number, number>();
			for (let change = 0; change < 12; change++) {
				const itemIndex = Math.floor(random() * fixture.items.length);
				heights.set(itemIndex, change % 4 === 0 ? 0 : random() * 100);
			}
			const previous = actual;
			const snapshot = JSON.stringify(previous);
			actual = patchPretextLayoutHeights(actual, heights, `random-${round}`);
			expected = rebuildWithHeights(expected, heights, `random-${round}`);
			expectEquivalentLayout(actual, expected);
			expect(JSON.stringify(previous)).toBe(snapshot);
			expect(actual.itemIndicesForSourceSeq).toBe(sourceLookup);
			expect(actual.itemIndicesForSourceMessageId).toBe(messageLookup);
			for (let itemIndex = 0; itemIndex < fixture.items.length; itemIndex++) {
				const before = previous.manifest.items[itemIndex];
				const after = actual.manifest.items[itemIndex];
				if (!heights.has(itemIndex) || heights.get(itemIndex) === before?.height)
					expect(after).toBe(before);
			}
		}
	});

	it("does not accumulate lookup wrappers across thousands of patches", () => {
		let index = buildPretextLayoutIndex(manifest(1));
		const original = index;
		for (let round = 0; round < 12_000; round++) {
			index = patchPretextLayoutHeights(index, new Map([[0, round % 2]]));
		}
		expect(index.itemByKey("message-0")?.item.height).toBe(1);
		expect(index.itemIndicesForSourceSeq).toBe(original.itemIndicesForSourceSeq);
		expect(index.itemIndicesForSourceMessageId).toBe(original.itemIndicesForSourceMessageId);
		expect(index.itemIndicesForSourceSeq(0)).toEqual([0]);
		expect(index.itemIndicesForSourceMessageId("message-0")).toEqual([0]);
		expect(original.itemByKey("message-0")?.item.height).toBe(48);
	});

	it("supports structural indices without rebuilding source lookup state or chaining wrappers", () => {
		const base = buildPretextLayoutIndex(manifest(2));
		let keyCalls = 0;
		const structural: PretextLayoutIndex = {
			...base,
			itemByKey(key) {
				keyCalls++;
				return base.itemByKey(key);
			},
			itemIndicesForSourceSeq(seq) {
				expect(this).toBe(structural);
				return base.itemIndicesForSourceSeq(seq);
			},
			itemIndicesForSourceMessageId(messageId) {
				expect(this).toBe(structural);
				return base.itemIndicesForSourceMessageId(messageId);
			},
		};
		let next = patchPretextLayoutHeights(structural, new Map([[0, 1]]));
		const sourceLookup = next.itemIndicesForSourceSeq;
		for (let round = 0; round < 100; round++) {
			next = patchPretextLayoutHeights(next, new Map([[0, round]]));
		}
		expect(keyCalls).toBe(0);
		expect(next.itemByKey("message-0")?.item.height).toBe(99);
		expect(keyCalls).toBe(1);
		expect(next.itemIndicesForSourceSeq).toBe(sourceLookup);
		expect(next.itemIndicesForSourceSeq(0)).toEqual([0]);
		expect(next.itemIndicesForSourceMessageId("message-0")).toEqual([0]);
		expectEquivalentLayout(next, rebuildWithHeights(base, new Map([[0, 99]])));
	});
});

describe("pretext layout index", () => {
	it("builds an exact full-history prefix index without estimates", () => {
		const index = buildPretextLayoutIndex(manifest(451));
		const expected =
			16 +
			451 * 48 +
			[...Array(451)].reduce((sum, _, itemIndex) => sum + (itemIndex % 5) * 7, 0) +
			450 * 4 +
			16;
		expect(index.totalHeight).toBe(expected);
		expect(index.itemStart(0)).toBe(16);
		expect(index.itemByKey("message-450")?.index).toBe(450);
		expect(index.itemIndexAtOffset(index.itemStart(200) + 1)).toBe(200);
	});

	it("keeps the same total height and item coordinates for the same manifest", () => {
		const first = buildPretextLayoutIndex(manifest(95));
		const second = buildPretextLayoutIndex(manifest(95));
		expect(second.totalHeight).toBe(first.totalHeight);
		expect(second.itemStarts).toEqual(first.itemStarts);
		expect(second.itemEnds).toEqual(first.itemEnds);
	});

	it("maps ordered layout items back from source seqs and source message ids", () => {
		const fixture = manifest(95);
		fixture.items = fixture.items.map((item, index) => ({
			...item,
			firstSeq: index * 2,
			lastSeq: index * 2 + (index % 7 === 0 ? 1 : 0),
			sourceMessageIds:
				index % 11 === 0 ? [`message-${index}`, "shared-activity"] : [`message-${index}`],
		}));
		const index = buildPretextLayoutIndex(fixture);
		for (let itemIndex = 0; itemIndex < fixture.items.length; itemIndex++) {
			const item = fixture.items[itemIndex];
			if (!item) continue;
			expect(index.itemIndicesForSourceSeq(item.firstSeq)).toContain(itemIndex);
			expect(index.itemIndicesForSourceSeq(item.lastSeq)).toContain(itemIndex);
			expect(index.itemIndicesForSourceMessageId(`message-${itemIndex}`)).toContain(itemIndex);
		}
		expect(index.itemIndicesForSourceMessageId("shared-activity")).toEqual([
			0, 11, 22, 33, 44, 55, 66, 77, 88,
		]);
		expect(index.itemIndicesForSourceSeq(3)).toEqual([]);
	});

	it("changes only the changed item end and suffix coordinates", () => {
		const previous = buildPretextLayoutIndex(manifest(451));
		const changedManifest = manifest(451);
		const changedIndex = 219;
		const delta = 137;
		changedManifest.items = changedManifest.items.map((item, index) =>
			index === changedIndex ? { ...item, height: item.height + delta } : item,
		);
		const next = buildPretextLayoutIndex(changedManifest);
		expect(next.itemStarts.slice(0, changedIndex + 1)).toEqual(
			previous.itemStarts.slice(0, changedIndex + 1),
		);
		expect(next.itemEnds.slice(0, changedIndex)).toEqual(previous.itemEnds.slice(0, changedIndex));
		expect(next.itemEnd(changedIndex)).toBe(previous.itemEnd(changedIndex) + delta);
		for (let itemIndex = changedIndex + 1; itemIndex < 451; itemIndex++) {
			expect(next.itemStart(itemIndex)).toBe(previous.itemStart(itemIndex) + delta);
			expect(next.itemEnd(itemIndex)).toBe(previous.itemEnd(itemIndex) + delta);
		}
	});

	it("restores a non-bottom anchor by stable item key after suffix height changes", () => {
		const previous = buildPretextLayoutIndex(manifest(95));
		const anchor = capturePretextLayoutAnchor(previous, previous.itemStart(40) + 13, 720, false);
		const changed = manifest(95);
		changed.items = changed.items.map((item, index) =>
			index >= 40 ? { ...item, height: item.height + 20 } : item,
		);
		const replacement = replacePretextLayout(previous, changed, anchor, 720);
		expect(replacement.scrollTop).toBe(replacement.index.itemStart(40) + 13);
	});

	it("preserves a top-of-canvas scroll position before leading padding", () => {
		const previous = buildPretextLayoutIndex(manifest(3));
		const anchor = capturePretextLayoutAnchor(previous, 0, 720, false);
		expect(anchor).toEqual({
			kind: "item",
			itemKey: "",
			offsetWithinItem: 0,
			fallbackIndex: -1,
		});
		const replacement = replacePretextLayout(previous, manifest(3), anchor, 720);
		expect(replacement.scrollTop).toBe(0);
	});

	// The LOD-switch contract: the content under the mouse / pinch center must stay
	// at the SAME screen position, not be pulled up to the viewport top. Every case
	// below fixes a way the previous viewport-top-only anchor moved it.
	describe("focus-point anchoring across an LOD switch", () => {
		it("keeps the focused content at its own screen position, not the viewport top", () => {
			const previous = buildPretextLayoutIndex(manifest(95));
			// Reader is scrolled to item 40; the pointer is 300px further down the
			// viewport, over item 45.
			const scrollTop = previous.itemStart(40);
			const focusOffset = previous.itemStart(45) + 6;
			const viewportOffset = focusOffset - scrollTop;
			const anchor = capturePretextLayoutAnchor(previous, scrollTop, 720, false, { focusOffset });
			// Everything above the focus grows, so the focused item moves far down.
			const changed = manifest(95);
			changed.items = changed.items.map((item, index) =>
				index < 45 ? { ...item, height: item.height + 30 } : item,
			);
			const replacement = replacePretextLayout(previous, changed, anchor, 720);
			// The focused point sits at the same distance below the viewport top as
			// before, i.e. under the unmoved pointer.
			expect(replacement.scrollTop).toBe(replacement.index.itemStart(45) + 6 - viewportOffset);
		});

		it("still anchors the viewport top when no focus point is supplied", () => {
			const previous = buildPretextLayoutIndex(manifest(95));
			const anchor = capturePretextLayoutAnchor(previous, previous.itemStart(40) + 13, 720, false);
			// Unchanged shape: a non-gesture rebuild must behave exactly as before.
			expect(anchor).toEqual({
				kind: "item",
				itemKey: "message-40",
				offsetWithinItem: 13,
				fallbackIndex: 40,
				offsetRatio: 13 / (previous.itemEnd(40) - previous.itemStart(40)),
				sourceMessageIds: ["message-40"],
			});
			const changed = manifest(95);
			changed.items = changed.items.map((item, index) =>
				index >= 40 ? { ...item, height: item.height + 20 } : item,
			);
			const replacement = replacePretextLayout(previous, changed, anchor, 720);
			expect(replacement.scrollTop).toBe(replacement.index.itemStart(40) + 13);
		});

		it("follows the same CONTENT when the LOD switch replaces the item key", () => {
			// This is the decisive LOD case: at a lower level a tool card folds into a
			// run-count line, so the captured itemKey no longer exists. Keying only on
			// itemKey fell back to a positional guess and jumped elsewhere.
			const previous = buildPretextLayoutIndex(manifest(95));
			const scrollTop = previous.itemStart(30);
			const focusOffset = previous.itemStart(37) + 4;
			const viewportOffset = focusOffset - scrollTop;
			const anchor = capturePretextLayoutAnchor(previous, scrollTop, 720, false, { focusOffset });
			// Rebuild renames every key and drops half the items — only the source
			// message ids connect the old anchor to the new layout.
			const folded = manifest(95);
			folded.items = folded.items
				.filter((_, index) => index % 2 === 1)
				.map((item) => ({ ...item, itemKey: `folded-${item.itemKey}` }));
			const replacement = replacePretextLayout(previous, folded, anchor, 720);
			const located = replacement.index.itemByKey("folded-message-37");
			if (!located) throw new Error("expected the folded item to exist");
			expect(replacement.scrollTop).toBe(
				replacement.index.itemStart(located.index) + 4 - viewportOffset,
			);
		});

		it("scales the offset inside an item that the LOD switch made shorter", () => {
			// A folded item is a fraction of its former height, so the absolute offset
			// would clamp to its bottom edge and lose the position within the content.
			const previous = buildPretextLayoutIndex(manifest(20, 400));
			const scrollTop = previous.itemStart(10);
			// Pointer three quarters of the way down a tall item.
			const itemHeight = previous.itemEnd(10) - previous.itemStart(10);
			const focusOffset = previous.itemStart(10) + itemHeight * 0.75;
			const anchor = capturePretextLayoutAnchor(previous, scrollTop, 720, false, { focusOffset });
			const shrunk = manifest(20, 400);
			shrunk.items = shrunk.items.map((item) => ({ ...item, height: 20 }));
			const replacement = replacePretextLayout(previous, shrunk, anchor, 720);
			const newHeight = replacement.index.itemEnd(10) - replacement.index.itemStart(10);
			expect(replacement.scrollTop).toBeCloseTo(
				Math.max(0, replacement.index.itemStart(10) + newHeight * 0.75 - (focusOffset - scrollTop)),
				5,
			);
		});

		it("ignores a focus point outside the visible band", () => {
			const previous = buildPretextLayoutIndex(manifest(95));
			const scrollTop = previous.itemStart(40);
			// A stale pointer far above the current scroll position must not anchor
			// content that is not on screen.
			const anchor = capturePretextLayoutAnchor(previous, scrollTop, 720, false, {
				focusOffset: previous.itemStart(2),
			});
			expect(anchor).toEqual(capturePretextLayoutAnchor(previous, scrollTop, 720, false));
		});

		it("ignores a focus point past the last item (padding / streaming tail)", () => {
			const previous = buildPretextLayoutIndex(manifest(3));
			const scrollTop = 0;
			// Below the last item there is only trailing padding and the (separately
			// rendered) streaming tail — nothing to anchor on.
			const anchor = capturePretextLayoutAnchor(previous, scrollTop, 4_000, false, {
				focusOffset: previous.totalHeight + 200,
			});
			expect(anchor).toEqual(capturePretextLayoutAnchor(previous, scrollTop, 4_000, false));
		});

		it("keeps the bottom anchor when pinned, regardless of the focus point", () => {
			// Pinned-to-bottom wins: zooming while following the tail must keep
			// following it rather than freezing whatever the pointer happens to be on.
			const previous = buildPretextLayoutIndex(manifest(95));
			const scrollTop = previous.totalHeight - 720;
			const anchor = capturePretextLayoutAnchor(previous, scrollTop, 720, true, {
				focusOffset: scrollTop + 100,
			});
			expect(anchor).toEqual({ kind: "bottom", distanceFromBottom: 0 });
		});
	});

	it("preserves bottom distance while the tail grows", () => {
		const previous = buildPretextLayoutIndex(manifest(95));
		const scrollTop = previous.totalHeight - 720 - 3;
		const anchor = capturePretextLayoutAnchor(previous, scrollTop, 720, true);
		const changed = manifest(95);
		changed.items = changed.items.map((item, index) =>
			index >= 90 ? { ...item, height: item.height + 100 } : item,
		);
		const replacement = replacePretextLayout(previous, changed, anchor, 720);
		expect(replacement.scrollTop).toBe(replacement.index.totalHeight - 720 - 3);
	});

	it("rejects missing or estimated heights instead of silently entering the scrollbar", () => {
		const invalid = manifest(1);
		invalid.items = [{ ...invalid.items[0], height: Number.NaN }];
		expect(() => buildPretextLayoutIndex(invalid)).toThrow("height must be a finite");
	});

	it("rejects duplicate visual keys but allows overlapping source seq ranges", () => {
		const duplicate = manifest(2);
		duplicate.items = [
			duplicate.items[0],
			{ ...duplicate.items[1], itemKey: duplicate.items[0].itemKey },
		];
		expect(() => buildPretextLayoutIndex(duplicate)).toThrow("duplicate layout item key");
		const overlapping = manifest(2);
		overlapping.items = [
			{ ...overlapping.items[0], firstSeq: 10, lastSeq: 20 },
			{ ...overlapping.items[1], firstSeq: 10, lastSeq: 10 },
		];
		expect(buildPretextLayoutIndex(overlapping).manifest.items).toHaveLength(2);
	});

	it("applies a per-item gapAfter override to that one boundary only", () => {
		const fixture: PretextLayoutManifest = {
			layoutRevision: "gap-after",
			documentRevision: 1,
			lod: 3,
			widthBucket: "860",
			metrics: { topPadding: 16, itemGap: 4, bottomPadding: 16 },
			items: [
				{
					itemKey: "a",
					firstSeq: 0,
					lastSeq: 0,
					sourceMessageIds: ["a"],
					kind: "message-bubble",
					height: 40,
					gapAfter: 12,
				},
				{
					itemKey: "b",
					firstSeq: 1,
					lastSeq: 1,
					sourceMessageIds: ["b"],
					kind: "markdown",
					height: 30,
				},
				{
					itemKey: "c",
					firstSeq: 2,
					lastSeq: 2,
					sourceMessageIds: ["c"],
					kind: "markdown",
					height: 20,
				},
			],
		};
		const index = buildPretextLayoutIndex(fixture);
		// a: [16, 56); then gapAfter 12 → b: [68, 98); then itemGap 4 → c: [102, 122)
		expect(index.itemStarts).toEqual([16, 68, 102]);
		expect(index.itemEnds).toEqual([56, 98, 122]);
		// last item drops any trailing gap; totalHeight = 122 + bottomPadding 16.
		expect(index.totalHeight).toBe(138);
	});

	it("ignores gapAfter on the final item (trailing gap is always dropped)", () => {
		const fixture: PretextLayoutManifest = {
			layoutRevision: "gap-after-tail",
			documentRevision: 1,
			lod: 3,
			widthBucket: "860",
			metrics: { topPadding: 0, itemGap: 4, bottomPadding: 0 },
			items: [
				{
					itemKey: "a",
					firstSeq: 0,
					lastSeq: 0,
					sourceMessageIds: ["a"],
					kind: "markdown",
					height: 50,
				},
				{
					itemKey: "b",
					firstSeq: 1,
					lastSeq: 1,
					sourceMessageIds: ["b"],
					kind: "markdown",
					height: 50,
					gapAfter: 99,
				},
			],
		};
		const index = buildPretextLayoutIndex(fixture);
		// a(50) + itemGap(4) + b(50) = 104. b's gapAfter:99 is the trailing gap and
		// is dropped; if it were honored the total would balloon to 149.
		expect(index.totalHeight).toBe(104);
	});

	it("rejects a negative or non-finite gapAfter", () => {
		const bad = manifest(1);
		bad.items = [{ ...bad.items[0], gapAfter: -5 }];
		expect(() => buildPretextLayoutIndex(bad)).toThrow("gapAfter");
	});
});
