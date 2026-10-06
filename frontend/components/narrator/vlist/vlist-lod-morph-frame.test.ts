import { describe, expect, it } from "bun:test";
import type { PretextLayoutItem } from "@shared/pretext-layout";
import { layoutItems } from "@shared/pretext-layout/vlist-virtualization";
import { DRILL_MORPH_X_OFFSET } from "./vlist-drill-morph";
import { foldRevisionOf } from "./vlist-exact-layout";
import {
	buildLodSnapshots,
	diffLodSnapshots,
	type LodElementSource,
	type LodMorphPlan,
} from "./vlist-lod-morph";
import { commitLodMorph, resetLodMorphPlayback } from "./vlist-lod-morph-commit";
import { createLodMorphFrameBaseline, type LodMorphFrame } from "./vlist-lod-morph-frame";
import {
	buildLodMorphGeometry,
	type createLodMorphGeometryCache,
	type LodMorphGeometry,
	type LodMorphGeometryInput,
} from "./vlist-lod-morph-geometry";
import { lodMorphKeyframesFrom } from "./vlist-lod-morph-motion";
import { admitPair, type MorphTargetPlan, planMorphTargets } from "./vlist-morph-plan";
import { LOD_MOTION_DURATION_MS, type MotionOp } from "./vlist-motion-scheduler";
import type { VListItem } from "./vlist-pipeline";
import type { VisualTarget } from "./vlist-visual-state";

function descriptor(overrides: Partial<LodMorphFrame> = {}): LodMorphFrame {
	return {
		narratorId: "owner-a",
		geometry: { elements: [], unifiedElements: [] },
		scrollTop: 0,
		viewportHeight: 800,
		documentRevision: 1,
		lod: 4,
		...overrides,
	};
}

describe("single latest committed LOD frame", () => {
	it("copies the descriptor, sharing only immutable geometry", () => {
		const baseline = createLodMorphFrameBaseline();
		const frame = { ...descriptor() };
		const geometry = frame.geometry;
		expect(baseline.commit(frame)).toBeNull();
		frame.scrollTop = 500;
		frame.viewportHeight = 300;
		frame.documentRevision = 2;
		frame.narratorId = "mutated-owner";
		frame.lod = 2;
		frame.geometry = { elements: [], unifiedElements: [] };
		const pair = baseline.commit(descriptor({ lod: 2 }));
		expect(pair?.before).toEqual(descriptor({ geometry }));
		expect(pair?.before).not.toBe(frame);
		expect(pair?.before.geometry).toBe(geometry);
		const after = { ...descriptor({ lod: 4 }) };
		const next = baseline.commit(after);
		expect(next?.after).not.toBe(after);
		expect(next?.after.geometry).toBe(after.geometry);
	});

	it("never resurrects an owner or revision older than the immediately preceding commit", () => {
		const baseline = createLodMorphFrameBaseline();
		baseline.commit(descriptor());
		expect(baseline.commit(descriptor({ narratorId: "owner-b", lod: 2 }))).toBeNull();
		expect(baseline.commit(descriptor({ lod: 2 }))).toBeNull();
		const pair = baseline.commit(descriptor({ lod: 4 }));
		expect(pair?.before.narratorId).toBe("owner-a");
		baseline.commit(descriptor({ documentRevision: 2 }));
		expect(baseline.commit(descriptor({ documentRevision: 1, lod: 2 }))).toBeNull();
		expect(baseline.commit(descriptor({ lod: 4 }))?.before.lod).toBe(2);
	});

	it("isolates independent list owners and refreshes geometry/scroll/height on every commit", () => {
		const left = createLodMorphFrameBaseline();
		const right = createLodMorphFrameBaseline();
		left.commit(descriptor());
		right.commit(descriptor({ scrollTop: 900 }));
		const latest = descriptor({ scrollTop: 300, viewportHeight: 450 });
		expect(left.commit(latest)).toBeNull();
		const pair = left.commit(descriptor({ lod: 2 }));
		expect(pair?.before).toEqual(latest);
		expect(pair?.before.geometry).toBe(latest.geometry);
		expect(right.commit(descriptor({ lod: 2 }))?.before.scrollTop).toBe(900);
	});

	for (const [name, change] of [
		["ordinary commit", {}],
		["non-LOD revision rebuild", { documentRevision: 2, lod: 2 }],
		["owner replacement", { narratorId: "owner-b", lod: 2 }],
	] as const) {
		it(`${name} returns null but still rolls forward`, () => {
			const baseline = createLodMorphFrameBaseline();
			baseline.commit(descriptor());
			const next = descriptor({ ...change, scrollTop: 88, viewportHeight: 360 });
			expect(baseline.commit(next)).toBeNull();
			const switched = baseline.commit({ ...next, lod: next.lod === 2 ? 4 : 2 });
			expect(switched?.before).toEqual(next);
		});
	}

	it("a previous -1 level is initialization, not a switch", () => {
		const baseline = createLodMorphFrameBaseline();
		baseline.commit(descriptor({ lod: -1 }));
		expect(baseline.commit(descriptor({ lod: 2, scrollTop: 90 }))).toBeNull();
		expect(baseline.commit(descriptor({ lod: 4 }))?.before.scrollTop).toBe(90);
	});
});

type Options = {
	lod?: number;
	docRev?: number;
	scrollTop?: number;
	viewportHeight?: number;
	reducedMotion?: boolean;
	unifiedMorph?: boolean;
};
const cardness = (kind: string) => (kind === "tool-call" || kind === "subagent-card" ? 1 : 0);
const xOffset = () => DRILL_MORPH_X_OFFSET;

function harness(geometryOverride?: LodMorphGeometry) {
	const cache = {
		current: geometryOverride
			? { get: () => geometryOverride }
			: (null as ReturnType<typeof createLodMorphGeometryCache> | null),
	};
	const baseline = { current: null as ReturnType<typeof createLodMorphFrameBaseline> | null };
	const calls = {
		build: [] as Parameters<typeof buildLodSnapshots>[],
		diff: [] as LodMorphPlan[][],
		admit: [] as Parameters<typeof admitPair>[],
		targets: [] as MorphTargetPlan[][],
		begin: 0,
		push: [] as { ops: MotionOp[]; duration: number | undefined }[],
		seed: [] as { id: string; initial: VisualTarget; target: VisualTarget }[],
		retarget: [] as { id: string; target: VisualTarget }[],
		retained: [] as ReadonlySet<string>[],
		kick: 0,
		stop: 0,
	};
	const moving = new Set<string>();
	const visual = new Map<string, VisualTarget>();
	const identities = { current: new Set<string>() };
	const driver = {
		kick: () => calls.kick++,
		stop: () => calls.stop++,
	};
	// Only selector resolution is part of this player boundary; geometry reads fail.
	const host = { querySelector: () => ({}) } as unknown as HTMLElement;
	const node = new Proxy(
		{ querySelector: () => host },
		{
			get(target, key, receiver) {
				if (key !== "querySelector") throw new Error(`Forbidden DOM access: ${String(key)}`);
				return Reflect.get(target, key, receiver);
			},
		},
	) as unknown as Pick<HTMLElement, "querySelector">;
	return {
		calls,
		moving,
		visual,
		identities,
		cache,
		commit(frame: LodMorphGeometryInput, options: Options = {}) {
			return commitLodMorph(
				{
					...frame,
					scrollTop: options.scrollTop ?? 0,
					viewportHeight: options.viewportHeight ?? 800,
					documentRevision: foldRevisionOf(options.docRev ?? 1),
					lod: options.lod ?? 4,
				},
				{ geometry: cache, frames: baseline },
				{
					viewport: node,
					unified: options.unifiedMorph ?? false,
					prefersReducedMotion: () => options.reducedMotion ?? false,
					visualState: {
						isMoving: (id) => moving.has(id),
						startFrom: (id, initial, target) => {
							calls.seed.push({ id, initial, target });
							visual.set(id, initial);
						},
						setTarget: (id, target) => calls.retarget.push({ id, target }),
						retain: (ids) => calls.retained.push(ids),
					},
					identities,
					driver,
					motion: {
						begin: () => calls.begin++,
						push: (ops, duration) => calls.push.push({ ops: [...ops], duration }),
					},
				},
				{
					admit: (...args) => {
						calls.admit.push(args);
						return admitPair(...args);
					},
					planTargets: (...args) => {
						const plans = planMorphTargets(...args);
						calls.targets.push(plans);
						return plans;
					},
					buildSnapshots: (...args) => {
						calls.build.push(args);
						return buildLodSnapshots(...args);
					},
					diffSnapshots: (...args) => {
						const plans = diffLodSnapshots(...args);
						calls.diff.push(plans);
						return plans;
					},
				},
			);
		},
		toggle(unifiedMorph: boolean) {
			void unifiedMorph;
			resetLodMorphPlayback(identities, driver);
		},
	};
}

function input(elements: readonly VListItem[], top = 100): LodMorphGeometryInput {
	return {
		narratorId: "owner-a",
		items: elements,
		layout: layoutItems(
			elements.map((el) => el.measured.height),
			10,
			top,
		),
		index: {
			itemByKey(key) {
				const index = elements.findIndex((el) => el.spec.key === key);
				if (index < 0) return undefined;
				const item: PretextLayoutItem = {
					itemKey: key,
					firstSeq: index,
					lastSeq: index,
					sourceMessageIds: [],
					kind: "activity-trace",
					height: 0,
				};
				return { item, index };
			},
		},
	};
}

function item(key: string, height: number, spec: Partial<VListItem["spec"]> = {}): VListItem {
	return {
		spec: { key, kind: "tool-call", data: null, ...spec },
		measured: {
			height,
			blocks: [],
			frame: { blocks: [], contentHeight: height, usedWidth: 600 },
			contentWidth: 600,
			usedWidth: 600,
		},
	};
}
function cards(top = 100) {
	return input(
		[
			item("card-a", 400, { unitId: "tool-a", morphGroupId: "activity", unitStart: true }),
			item("card-b", 500, { unitId: "tool-b", morphGroupId: "activity", unitStart: true }),
			item("body", 60, { kind: "markdown" }),
		],
		top,
	);
}
function rows(top = 100, rowTop = 30) {
	const trace = item("trace", 80, { kind: "activity-trace", morphGroupId: "activity" });
	const measuredTrace = {
		...trace,
		measured: {
			...trace.measured,
			rows: [
				{ top: 10, rowHeight: 19, blockHeight: 400, unitId: "tool-a" },
				{ top: rowTop, rowHeight: 21, blockHeight: 500, unitId: "tool-b" },
			],
		},
	};
	return input([measuredTrace, item("body", 60, { kind: "markdown" })], top);
}

/** Frozen phase-one eager policy, NOT the new frame helper or its result.
 * Every commit eagerly publishes its snapshot and full unified sources before any
 * playback gate. Keyframes retain old height; unified re-admits with current height.
 */
function eagerReference() {
	let previous:
		| {
				owner: string;
				revision: number;
				lod: number;
				scrollTop: number;
				viewportHeight: number;
				geometry: LodMorphGeometry;
				snapshots: ReturnType<typeof buildLodSnapshots>;
		  }
		| undefined;
	return (input: LodMorphGeometryInput, options: Options) => {
		const geometry = buildLodMorphGeometry(input);
		const scrollTop = options.scrollTop ?? 0;
		const vh = options.viewportHeight ?? 800;
		const next = buildLodSnapshots(geometry.elements, scrollTop, vh);
		const old = previous;
		previous = {
			owner: input.narratorId,
			revision: options.docRev ?? 1,
			lod: options.lod ?? 4,
			scrollTop,
			viewportHeight: vh,
			geometry,
			snapshots: next,
		};
		if (
			!old ||
			old.owner !== previous.owner ||
			old.revision !== previous.revision ||
			old.lod === -1 ||
			old.lod === previous.lod ||
			options.reducedMotion
		)
			return null;
		const admitted = admitPair(
			old.geometry.unifiedElements,
			geometry.unifiedElements,
			scrollTop,
			vh,
			old.scrollTop,
		);
		return {
			keyframe: diffLodSnapshots(old.snapshots, next),
			unified: planMorphTargets(admitted.before, admitted.after, cardness, xOffset),
			buildArgs: [
				[old.geometry.elements, old.scrollTop, old.viewportHeight],
				[geometry.elements, scrollTop, vh],
			] satisfies Parameters<typeof buildLodSnapshots>[],
			admitArgs: [
				old.geometry.unifiedElements,
				geometry.unifiedElements,
				scrollTop,
				vh,
				old.scrollTop,
			] satisfies Parameters<typeof admitPair>,
		};
	};
}

function counts(h: ReturnType<typeof harness>) {
	return [h.calls.build.length, h.calls.diff.length, h.calls.admit.length, h.calls.targets.length];
}

describe("committed LOD entry: lazy selected-path planning", () => {
	for (const unifiedMorph of [false, true]) {
		it(`${unifiedMorph ? "unified" : "keyframe"}: first/ordinary/nonLOD/reduced/unknown/owner commits plan nothing`, () => {
			const forbidden = new Proxy([], {
				get: (_, key) => {
					throw new Error(`Ordinary commit traversed geometry: ${String(key)}`);
				},
			});
			const h = harness({ elements: forbidden, unifiedElements: forbidden });
			const frame = cards();
			for (const options of [
				{ lod: -1 },
				{ lod: 4 },
				{ lod: 4, scrollTop: 200, viewportHeight: 400 },
				{ lod: 2, docRev: 2 },
				{ lod: 4, docRev: 2, reducedMotion: true },
			])
				h.commit(frame, { ...options, unifiedMorph });
			h.commit({ ...frame, narratorId: "owner-b" }, { lod: 2, docRev: 2, unifiedMorph });
			expect(counts(h)).toEqual([0, 0, 0, 0]);
			expect(h.calls.begin).toBe(0);
			expect(h.calls.push).toHaveLength(0);
			expect(h.calls.kick).toBe(0);
		});

		it(`${unifiedMorph ? "unified" : "keyframe"}: matches eager plans and arguments after scroll/width/override/fold/drill/live/reduced/flag changes`, () => {
			const h = harness();
			const reference = eagerReference();
			const initial = cards();
			const width = {
				...initial,
				items: initial.items.map((el) => ({
					...el,
					measured: { ...el.measured, contentWidth: 480 },
				})),
			};
			const override = { ...width, layout: layoutItems([450, 520, 60], 10, 100) };
			const folded = rows(300);
			const drill = { ...folded, items: rows(300, 57).items };
			const live = rows(350, 62);
			const sequence: Array<[LodMorphGeometryInput, Options]> = [
				[initial, { lod: 4 }],
				[initial, { lod: 4, scrollTop: 250, viewportHeight: 260 }],
				[width, { lod: 4, scrollTop: 250, viewportHeight: 300 }],
				[override, { lod: 4, scrollTop: 260, viewportHeight: 350 }],
				[folded, { lod: 2, scrollTop: 300, viewportHeight: 800 }],
				[drill, { lod: 2, scrollTop: 310 }],
				[live, { lod: 2, docRev: 2, scrollTop: 320 }],
				[cards(400), { lod: 4, docRev: 2, scrollTop: 350 }],
				[
					rows(500),
					{ lod: 2, docRev: 2, scrollTop: 400, viewportHeight: 280, reducedMotion: true },
				],
				[cards(600), { lod: 4, docRev: 2, scrollTop: 450, viewportHeight: 700 }],
				[cards(650), { lod: 2, docRev: 3, scrollTop: 470 }],
				[rows(700), { lod: 4, docRev: 3, scrollTop: 500 }],
			];
			let switches = 0;
			for (const [frame, options] of sequence) {
				h.identities.current.add("stale");
				h.toggle(!unifiedMorph);
				h.toggle(unifiedMorph);
				expect(h.identities.current.size).toBe(0);
				const before = counts(h);
				const expected = reference(frame, options);
				h.commit(frame, { ...options, unifiedMorph });
				if (!expected) {
					expect(counts(h)).toEqual(before);
					continue;
				}
				switches++;
				expect(counts(h).map((n, i) => n - before[i])).toEqual(
					unifiedMorph ? [0, 0, 1, 1] : [2, 1, 0, 0],
				);
				if (unifiedMorph) {
					expect(h.calls.targets.at(-1)).toEqual(expected.unified);
					expect(h.calls.admit.at(-1)).toEqual(expected.admitArgs);
				} else {
					expect(h.calls.diff.at(-1)).toEqual(expected.keyframe);
					expect(h.calls.build.slice(-2)).toEqual(expected.buildArgs);
				}
			}
			expect(switches).toBe(4);
			expect(h.calls.stop).toBe(sequence.length * 2);
		});
	}

	it("keyframes use each frame's own height; unified uses current height on both sides with independent origins", () => {
		const before = input([item("far", 30, { unitId: "far", kind: "markdown" })], 900);
		const after = input([item("far", 300, { unitId: "far" })], 920);
		const keyframe = harness();
		const unified = harness();
		for (const [h, unifiedMorph] of [
			[keyframe, false],
			[unified, true],
		] as const) {
			h.commit(before, { lod: 2, viewportHeight: 100, scrollTop: 0, unifiedMorph });
			h.commit(after, { lod: 4, viewportHeight: 800, scrollTop: 200, unifiedMorph });
		}
		expect(keyframe.calls.build.map((args) => args.slice(1))).toEqual([
			[0, 100],
			[200, 800],
		]);
		expect(keyframe.calls.diff[0]).toEqual([]); // eager old window did not admit "far"
		expect(unified.calls.build).toEqual([]);
		expect(unified.calls.admit[0].slice(2)).toEqual([200, 800, 0]);
		expect(unified.calls.targets[0][0]?.fromOffset.y).toBe(180);
	});

	it("preference flips hand over playback without destroying the latest shared descriptor", () => {
		const h = harness();
		const initial = rows(500);
		h.commit(initial, { lod: 2, scrollTop: 300, viewportHeight: 300, unifiedMorph: false });
		h.commit(initial, { lod: 2, scrollTop: 400, viewportHeight: 350, unifiedMorph: true });
		h.toggle(true);
		h.commit(cards(700), { lod: 4, scrollTop: 600, viewportHeight: 800, unifiedMorph: true });
		expect(h.calls.admit[0].slice(2)).toEqual([600, 800, 400]);
		h.toggle(false);
		h.commit(rows(800), { lod: 2, scrollTop: 650, viewportHeight: 500, unifiedMorph: false });
		expect(h.calls.build.map((args) => args.slice(1))).toEqual([
			[600, 800],
			[650, 500],
		]);
		expect(h.calls.kick).toBe(1);
		expect(h.calls.stop).toBe(2);
	});

	it("rapid unified switches seed settled elements, retarget moving ones and retain one identity owner", () => {
		const h = harness();
		h.commit(rows(), { lod: 2, unifiedMorph: true });
		h.commit(cards(), { lod: 4, unifiedMorph: true });
		expect(h.calls.seed.length).toBeGreaterThan(0);
		const seeded = h.calls.seed.length;
		for (const seed of h.calls.seed) h.moving.add(seed.id);
		const held = new Map(h.visual);
		h.commit(rows(), { lod: 2, unifiedMorph: true });
		expect(h.calls.seed).toHaveLength(seeded);
		expect(h.calls.retarget.length).toBeGreaterThan(0);
		expect(h.visual).toEqual(held);
		h.moving.clear();
		h.commit(cards(), { lod: 4, unifiedMorph: true });
		expect(h.calls.seed.length).toBeGreaterThan(seeded);
		expect(h.calls.kick).toBe(3);
		expect(h.calls.retained.at(-1)).toBe(h.identities.current);
		expect(h.calls.push).toHaveLength(0);
	});

	it("keyframe player receives real resumable builders and event-level duration, including chrome", () => {
		const h = harness();
		h.commit(rows(), { lod: 2 });
		h.commit(cards(), { lod: 4 });
		const first = h.calls.push[0];
		expect(first.duration).toBe(LOD_MOTION_DURATION_MS);
		expect(h.calls.begin).toBe(1);
		for (const [index, op] of first.ops.entries()) {
			const plan = h.calls.diff[0][index];
			if (typeof op.keyframes !== "function") throw new Error("Lost resume builder");
			expect(op.keyframes(null)).toEqual(lodMorphKeyframesFrom(plan, null));
			expect(op.keyframes({ progress: 0.4 })).toEqual(
				lodMorphKeyframesFrom(plan, { progress: 0.4 }),
			);
			expect(op.resolve()).not.toBeNull();
		}
		const chrome = h.calls.push[1];
		expect(chrome.duration).toBe(LOD_MOTION_DURATION_MS);
		expect(chrome.ops.map((op) => op.scope)).toContain("lod:tool-a:tail");
		expect(chrome.ops.map((op) => op.scope)).toContain("lod:tool-a:border");
		h.commit(rows(), { lod: 2 });
		expect(h.calls.begin).toBe(2);
		expect(h.calls.kick).toBe(0);
	});
});

function geometryFrom(elements: readonly LodElementSource[]): LodMorphGeometry {
	return {
		elements: [...elements],
		unifiedElements: elements.map(({ groupBox, unitAnchored: _anchored, ...el }) => ({
			...el,
			unitBox: groupBox,
		})),
	};
}

describe("actual selected planners preserve full-source correctness", () => {
	for (const unifiedMorph of [false, true]) {
		it(`${unifiedMorph ? "unified" : "keyframe"}: true switches never read the unselected geometry array`, () => {
			const forbidden = new Proxy([], {
				get: (_, key) => {
					throw new Error(`Unselected planner read geometry: ${String(key)}`);
				},
			});
			let current = buildLodMorphGeometry(rows());
			const h = harness();
			h.cache.current = {
				get: () =>
					unifiedMorph
						? { ...current, elements: forbidden }
						: { ...current, unifiedElements: forbidden },
			};
			const frame = cards();
			h.commit(frame, { lod: 2, unifiedMorph });
			current = buildLodMorphGeometry(cards());
			h.commit(frame, { lod: 4, unifiedMorph });
			expect(counts(h)).toEqual(unifiedMorph ? [0, 0, 1, 1] : [2, 1, 0, 0]);
		});

		it(`${unifiedMorph ? "unified" : "keyframe"}: clipped re-themes fade without travel, partial overlap still travels`, () => {
			const elements = [
				{ unitId: "hidden", key: "hidden", kind: "tool-call", top: 500, height: 30 },
				{ unitId: "partial", key: "partial", kind: "tool-call", top: 90, height: 30 },
				{ unitId: "unchanged", key: "unchanged", kind: "trace-row", top: 500, height: 30 },
			];
			let current = geometryFrom(elements);
			const h = harness();
			h.cache.current = { get: () => current };
			const frame = cards();
			h.commit(frame, { lod: 4, unifiedMorph });
			current = geometryFrom(
				elements.map((el) => ({
					...el,
					kind: "trace-row",
					top: 100,
					nested: true,
					clip: { top: 100, bottom: 200 },
				})),
			);
			h.commit(frame, { lod: 2, unifiedMorph });
			if (unifiedMorph) {
				expect(h.calls.targets[0].map((p) => [p.unitId, p.fromOffset.y, p.reTheme])).toEqual([
					["hidden", 0, true],
					["partial", -10, true],
				]);
			} else {
				expect(h.calls.diff[0].map((p) => [p.unitId, p.deltaY, p.fade])).toEqual([
					["hidden", 0, true],
					["partial", -10, true],
				]);
			}
		});
	}

	it("unified rescues counterparts outside the old window with their own origins and clips", () => {
		const h = harness();
		const expanded = cards(1000);
		const folded = rows(1000);
		h.commit(expanded, { lod: 4, scrollTop: 1400, viewportHeight: 150, unifiedMorph: true });
		h.commit(folded, { lod: 2, scrollTop: 1450, viewportHeight: 150, unifiedMorph: true });
		expect(h.calls.targets[0].map((p) => p.unitId)).toEqual(["tool-a", "tool-b"]);
		expect(h.calls.targets[0].every((p) => p.reTheme)).toBe(true);
		// First card still overlaps the rescued clip; the later card cannot slide visibly.
		expect(h.calls.targets[0].map((p) => p.fromOffset.y)).toEqual([40, 0]);
		const pair = admitPair(...h.calls.admit[0]);
		expect(pair.before.get("tool-a")?.viewportTop).toBe(-400);
		expect(pair.after.get("tool-a")).toMatchObject({
			viewportTop: -440,
			clip: { top: -450, bottom: -370 },
		});
	});

	for (const unifiedMorph of [false, true]) {
		it(`${unifiedMorph ? "unified" : "keyframe"}: group cap and duplicate unitIds survive lazy full-source derivation`, () => {
			const box = { top: 100, height: 30_000 };
			const sources = Array.from(
				{ length: 40 },
				(_, i): LodElementSource => ({
					unitId: `unit-${i}`,
					key: `card-${i}`,
					kind: "trace-row",
					top: 100 + i * 500,
					height: 20,
					groupBox: box,
					unitAnchored: true,
				}),
			);
			sources.splice(1, 0, { ...sources[0], key: "duplicate", top: 20_000 });
			const before = geometryFrom(sources);
			const after = geometryFrom(
				sources.map((el) => ({ ...el, kind: "tool-call", top: el.top + 10 })),
			);
			// Replace the cache's published version per commit; the sources stay complete.
			let current = before;
			const h = harness();
			h.cache.current = { get: () => current };
			const frame = cards();
			h.commit(frame, { lod: 2, viewportHeight: 150, unifiedMorph });
			current = after;
			h.commit(frame, { lod: 4, viewportHeight: 150, unifiedMorph });
			const actual = unifiedMorph ? h.calls.targets[0] : h.calls.diff[0];
			// Frozen planner difference: keyframes spend a group slot BEFORE identity
			// de-duplication; unified de-duplicates first. Do not silently equalize them.
			const admitted = unifiedMorph ? 30 : 29;
			expect(actual).toHaveLength(admitted);
			expect(new Set(actual.map((p) => p.unitId)).size).toBe(admitted);
			expect(actual.map((p) => p.unitId)).toContain(`unit-${admitted - 1}`);
			expect(actual.map((p) => p.unitId)).not.toContain(`unit-${admitted}`);
			const pair = admitPair(before.unifiedElements, after.unifiedElements, 0, 150, 0);
			expect(actual).toEqual(
				unifiedMorph
					? planMorphTargets(pair.before, pair.after, cardness, xOffset)
					: diffLodSnapshots(
							buildLodSnapshots(before.elements, 0, 150),
							buildLodSnapshots(after.elements, 0, 150),
						),
			);
			if (unifiedMorph) {
				expect(h.calls.targets[0][0].fromOffset.y).toBe(-10);
			} else {
				expect(h.calls.diff[0][0].deltaY).toBe(-10);
			}
		});
	}
});
