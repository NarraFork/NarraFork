import { describe, expect, it } from "bun:test";
import {
	buildPretextLayoutIndex,
	capturePretextLayoutAnchor,
	type PretextLayoutItem,
	type PretextLayoutManifest,
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
});
