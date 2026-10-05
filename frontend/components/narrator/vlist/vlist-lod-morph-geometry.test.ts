import { describe, expect, it } from "bun:test";
import type { PretextLayoutItem } from "@shared/pretext-layout";
import { layoutItems } from "@shared/pretext-layout/vlist-virtualization";
import { foldRevisionOf } from "./vlist-exact-layout";
import { buildLodSnapshots } from "./vlist-lod-morph";
import { commitLodMorph } from "./vlist-lod-morph-commit";
import type { createLodMorphFrameBaseline } from "./vlist-lod-morph-frame";
import {
	buildLodMorphGeometry,
	createLodMorphGeometryCache,
	type LodMorphGeometryInput,
} from "./vlist-lod-morph-geometry";
import { admitElements } from "./vlist-morph-plan";
import type { VListItem } from "./vlist-pipeline";
import { createVisualStateStore } from "./vlist-visual-state";

type Row = { top: number; rowHeight: number; blockHeight?: number; unitId?: string };

function item(
	key: string,
	height: number,
	spec: Partial<VListItem["spec"]> = {},
	rows?: Row[],
): VListItem {
	return {
		spec: { key, kind: "tool-call", data: null, ...spec },
		measured: {
			height,
			blocks: [],
			frame: { blocks: [], contentHeight: height, usedWidth: 600 },
			contentWidth: 600,
			usedWidth: 600,
			...(rows ? { rows } : {}),
		},
	};
}

function binding(items: readonly VListItem[], positions?: ReadonlyMap<string, number>) {
	const byKey = positions ?? new Map(items.map((it, i) => [it.spec.key, i]));
	return {
		itemByKey(key: string) {
			const index = byKey.get(key);
			if (index == null) return undefined;
			const manifestItem: PretextLayoutItem = {
				itemKey: key,
				firstSeq: index,
				lastSeq: index,
				sourceMessageIds: [],
				kind: "activity-trace",
				height: 0,
			};
			return { item: manifestItem, index };
		},
	};
}

function input(items: readonly VListItem[], top = 0): LodMorphGeometryInput {
	return {
		narratorId: "narrator-a",
		items,
		layout: layoutItems(
			items.map((it) => it.measured.height),
			10,
			top,
		),
		index: binding(items),
	};
}

function expanded(top = 100): LodMorphGeometryInput {
	return input(
		[
			item("card-a", 400, { unitId: "tool-a", morphGroupId: "activity", unitStart: true }),
			item("card-b", 500, { unitId: "tool-b", morphGroupId: "activity", unitStart: true }),
			item("body", 60, { kind: "markdown" }),
		],
		top,
	);
}

function folded(top = 100, rowTop = 30): LodMorphGeometryInput {
	return input(
		[
			item("trace", 80, { kind: "activity-trace", morphGroupId: "activity" }, [
				{ top: 10, rowHeight: 19, blockHeight: 400, unitId: "tool-a" },
				{ top: rowTop, rowHeight: 21, blockHeight: 500, unitId: "tool-b" },
			]),
			item("body", 60, { kind: "markdown" }),
		],
		top,
	);
}

describe("LOD geometry: document-space sources for both planners", () => {
	it("shares morphGroupId boxes despite every card having unitStart, retaining late cards", () => {
		const geometry = buildLodMorphGeometry(expanded());
		const [a, b, body] = geometry.elements;
		expect(a.groupBox).toEqual({ top: 100, height: 910 });
		expect(b.groupBox).toBe(a.groupBox);
		expect(body.groupBox).toEqual({ top: 1020, height: 60 });
		expect(body.groupBox).not.toBe(a.groupBox);
		expect(a.unitAnchored).toBe(true);
		// b's own top (510) is outside the window [−150, 300), but its group is not.
		expect([...buildLodSnapshots(geometry.elements, 0, 150).keys()]).toEqual(["tool-a", "tool-b"]);
		expect([...admitElements(geometry.unifiedElements, 0, 150).keys()]).toEqual([
			"tool-a",
			"tool-b",
		]);
		expect(geometry.unifiedElements[0].unitBox).toBe(a.groupBox);
	});

	it("does not merge different groups or ungrouped items merely sharing render-unit flags", () => {
		const frame = input([
			item("a", 40, { morphGroupId: "one", unitStart: true }),
			item("b", 60, { morphGroupId: "two", unitStart: false }),
			item("c", 80, { unitStart: false }),
			item("d", 100, { unitStart: false }),
		]);
		expect(buildLodMorphGeometry(frame).elements.map((el) => el.groupBox)).toEqual([
			{ top: 0, height: 40 },
			{ top: 50, height: 60 },
			{ top: 120, height: 80 },
			{ top: 210, height: 100 },
		]);
	});

	it("retains top-level key/kind fallback and unitId precedence in both planners", () => {
		const frame = input([
			item("body", 60, { kind: "markdown" }),
			item("card-key", 90, { unitId: "tool-id" }),
		]);
		const geometry = buildLodMorphGeometry(frame);
		expect(geometry.elements[0]).toMatchObject({
			key: "body",
			kind: "markdown",
			unitId: undefined,
		});
		const snapshots = buildLodSnapshots(geometry.elements, 20, 800);
		expect([...snapshots.keys()]).toEqual(["body", "tool-id"]);
		expect(snapshots.get("body")).toEqual({
			unitId: "body",
			kind: "markdown",
			viewportTop: -20,
			height: 60,
			clip: null,
		});
		expect(admitElements(geometry.unifiedElements, 20, 800)).toEqual(snapshots);
	});

	it("lifts nested title lines, keeps their own clip/groupBox, and skips rows without unitId", () => {
		const frame = folded(700);
		const geometry = buildLodMorphGeometry(frame);
		expect(geometry.elements[1]).toEqual({
			unitId: "tool-a",
			key: "tool-a",
			kind: "trace-row",
			top: 710,
			height: 19,
			clip: { top: 700, bottom: 780 },
			nested: true,
			groupBox: { top: 700, height: 80 },
		});
		expect(geometry.unifiedElements[1]).toEqual({
			unitId: "tool-a",
			key: "tool-a",
			kind: "trace-row",
			top: 710,
			height: 19,
			clip: { top: 700, bottom: 780 },
			nested: true,
			unitBox: { top: 700, height: 80 },
		});
		const noIdentity = input([
			item("trace", 300, { kind: "activity-trace" }, [
				{ top: 3, rowHeight: 19 },
				{ top: 30, rowHeight: 19, unitId: "" },
				{ top: 60, rowHeight: 19, unitId: "valid" },
			]),
		]);
		expect(buildLodMorphGeometry(noIdentity).elements.map((el) => el.key)).toEqual([
			"trace",
			"valid",
		]);
	});

	it("binds measurements through index.itemByKey rather than traversal position", () => {
		const frame = input([
			item("a", 100, { kind: "activity-trace" }, [{ top: 5, rowHeight: 17, unitId: "row-a" }]),
			item("b", 200, { kind: "activity-trace" }, [{ top: 25, rowHeight: 23, unitId: "row-b" }]),
		]);
		const reordered = buildLodMorphGeometry({
			...frame,
			index: binding(
				frame.items,
				new Map([
					["a", 1],
					["b", 0],
				]),
			),
		});
		expect(
			reordered.elements.filter((el) => el.nested).map((el) => [el.key, el.top, el.height]),
		).toEqual([
			["row-b", 25, 23],
			["row-a", 115, 17],
		]);
	});

	it("does not invent measured rows for missing, absent or out-of-range bindings", () => {
		const frame = folded();
		for (const index of [
			undefined,
			binding(frame.items, new Map()),
			binding(frame.items, new Map([["trace", 99]])),
		]) {
			const geometry = buildLodMorphGeometry({ ...frame, index });
			expect(geometry.elements.map((el) => el.key)).toEqual(["trace", "body"]);
			expect(geometry.unifiedElements.some((el) => el.nested)).toBe(false);
		}
	});

	it("skips items with no geometry, including their nested measurements", () => {
		const frame = folded();
		const geometry = buildLodMorphGeometry({ ...frame, layout: layoutItems([], 0) });
		expect(geometry).toEqual({ elements: [], unifiedElements: [] });
		const truncated = buildLodMorphGeometry({ ...frame, layout: layoutItems([80], 0, 100) });
		expect(truncated.elements.map((el) => el.key)).toEqual(["trace", "tool-a", "tool-b"]);
	});
});

describe("LOD geometry: single-entry identity cache", () => {
	it("reuses both arrays for an identical quartet even with a new input wrapper", () => {
		const cache = createLodMorphGeometryCache();
		const frame = folded();
		const first = cache.get(frame);
		expect(cache.get({ ...frame })).toBe(first);
		expect(cache.get(frame).elements).toBe(first.elements);
		expect(cache.get(frame).unifiedElements).toBe(first.unifiedElements);
	});

	for (const field of ["items", "layout", "index", "narratorId"] as const) {
		it(`invalidates only when ${field} identity changes, even at equal geometry`, () => {
			const cache = createLodMorphGeometryCache();
			const frame = folded();
			const first = cache.get(frame);
			const next: LodMorphGeometryInput = {
				...frame,
				...(field === "items" ? { items: [...frame.items] } : {}),
				...(field === "layout" ? { layout: { ...frame.layout } } : {}),
				...(field === "index" ? { index: binding(frame.items) } : {}),
				...(field === "narratorId" ? { narratorId: "narrator-b" } : {}),
			};
			const changed = cache.get(next);
			expect(changed).not.toBe(first);
			expect(changed.elements).not.toBe(first.elements);
			expect(changed.unifiedElements).not.toBe(first.unifiedElements);
			expect(changed).toEqual(first);
			expect(cache.get(next)).toBe(changed);
		});
	}

	it("evicts the previous version rather than retaining an A/B multi-version map", () => {
		const cache = createLodMorphGeometryCache();
		const a = folded();
		const b = expanded();
		const firstA = cache.get(a);
		const firstB = cache.get(b);
		const secondA = cache.get(a);
		expect(secondA).not.toBe(firstA);
		expect(secondA).toEqual(firstA);
		expect(cache.get(b)).not.toBe(firstB);
	});

	it("invalidates same-height nested measurements and never mutates published boxes", () => {
		const cache = createLodMorphGeometryCache();
		const a = folded();
		const first = cache.get(a);
		const serialized = JSON.stringify(first);
		for (const el of first.elements) {
			if (el.groupBox) Object.freeze(el.groupBox);
			if (el.clip) Object.freeze(el.clip);
		}
		const changedRows = folded(100, 47);
		const second = cache.get({ ...a, items: changedRows.items });
		expect(second.elements[2].top).toBe(147);
		expect(second.elements[2].height).toBe(21);
		expect(second.elements[2].groupBox).toEqual(first.elements[2].groupBox);
		expect(second.elements[2].groupBox).not.toBe(first.elements[2].groupBox);
		expect(second.elements[2].clip).not.toBe(first.elements[2].clip);
		expect(JSON.stringify(first)).toBe(serialized);
		const groupA = cache.get(expanded());
		const savedGroup = JSON.stringify(groupA);
		Object.freeze(groupA.elements[0].groupBox);
		cache.get(expanded(300));
		expect(JSON.stringify(groupA)).toBe(savedGroup);
	});

	it("does no spec/measurement/index work across 200 scroll commits of a 10k-item history", () => {
		let specReads = 0;
		let measuredReads = 0;
		let indexReads = 0;
		const items = Array.from({ length: 10_000 }, (_, n) => {
			const value = item(`stable-${n}`, 40, { unitId: `tool-${n}` });
			return new Proxy(value, {
				get(target, key, receiver) {
					if (key === "spec") specReads++;
					if (key === "measured") measuredReads++;
					return Reflect.get(target, key, receiver);
				},
			});
		});
		const original = input(items);
		const frame: LodMorphGeometryInput = {
			...original,
			index: {
				itemByKey(key) {
					indexReads++;
					return original.index?.itemByKey(key);
				},
			},
		};
		const harness = baselineHarness();
		harness.commit(frame, { scrollTop: 0 });
		expect(specReads).toBeGreaterThan(10_000);
		expect(measuredReads).toBeGreaterThanOrEqual(10_000);
		expect(indexReads).toBe(10_000);
		const counts = [specReads, measuredReads, indexReads];
		const geometry = harness.cache.current?.get(frame);
		if (!geometry) throw new Error("First committed frame must populate the cache");
		for (let commit = 1; commit <= 200; commit++) {
			harness.commit({ ...frame }, { scrollTop: commit * 500, viewportHeight: 600 + commit });
		}
		expect([specReads, measuredReads, indexReads]).toEqual(counts);
		const switched = harness.commit(frame, { lod: 2 });
		expect(switched?.before.geometry).toBe(geometry);
		expect(switched?.before.scrollTop).toBe(100_000);
		expect(switched?.before.viewportHeight).toBe(800);
		expect([specReads, measuredReads, indexReads]).toEqual(counts);
	});
});

/** Drive the same committed production entry, not an extracted prefix of shell source. */
function baselineHarness() {
	const cache = { current: null as ReturnType<typeof createLodMorphGeometryCache> | null };
	const frames = { current: null as ReturnType<typeof createLodMorphFrameBaseline> | null };
	const identities = { current: new Set<string>() };
	const visualState = createVisualStateStore();
	const unexpectedPlayback = () => {
		throw new Error("Geometry-only commits must not dispatch playback");
	};
	return {
		cache,
		commit(
			frame: LodMorphGeometryInput,
			options: { scrollTop?: number; viewportHeight?: number; lod?: number } = {},
		) {
			return commitLodMorph(
				{
					...frame,
					scrollTop: options.scrollTop ?? 0,
					viewportHeight: options.viewportHeight ?? 800,
					documentRevision: foldRevisionOf(1),
					lod: options.lod ?? 4,
				},
				{ geometry: cache, frames },
				{
					viewport: { querySelector: unexpectedPlayback },
					unified: false,
					prefersReducedMotion: () => true,
					visualState,
					identities,
					driver: null,
					motion: { begin: unexpectedPlayback, push: unexpectedPlayback },
				},
			);
		},
	};
}
