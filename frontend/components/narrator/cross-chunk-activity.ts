import type { ActivityInput } from "./ActivityTrace";
import { segmentMessages } from "./message-segments";
import type { NarratorMsg } from "./narrator-panel-types";
import { groupRenderUnits, type RenderUnit } from "./render-units";

export interface ActivityRenderOverride {
	hidden?: boolean;
	appendItems?: ActivityInput[];
}

export type ActivityRenderOverrides = ReadonlyMap<number, ActivityRenderOverride>;
export type CrossChunkActivityOverrides = ReadonlyMap<string, ActivityRenderOverrides>;

export interface ChunkActivityUnits {
	chunkId: string;
	/** Null means the chunk content is not loaded and must break continuity. */
	units: RenderUnit[] | null;
}

export interface ActivityRenderUnitOptions {
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	renderLod: number;
}

export interface TailActivityOverlay {
	chunkId: string;
	messages: NarratorMsg[];
	streamingMsg: NarratorMsg | null;
}

export interface CrossChunkActivityRenderPlan {
	chunkUnits: readonly ChunkActivityUnits[];
	overrides: CrossChunkActivityOverrides;
}

/**
 * Compute the exact units consumed by renderTreeMessages for one chunk. Keeping
 * this pure entry shared by the base memo, tail overlay, and tests prevents the
 * override ordinals from drifting from the renderer's streaming/prune/LOD input.
 */
export function computeChunkActivityUnits(
	chunkId: string,
	messages: NarratorMsg[] | null | undefined,
	options: ActivityRenderUnitOptions,
	streamingMsg: NarratorMsg | null = null,
): ChunkActivityUnits {
	if (!messages) return { chunkId, units: null };
	const segments = segmentMessages(messages, {
		pruneBoundaryMessageId: options.pruneBoundaryMessageId,
		pruneDividerLabel: options.pruneDividerLabel,
		streamingMsg,
	});
	return {
		chunkId,
		units: groupRenderUnits(segments, options.renderLod <= 2),
	};
}

interface ActivityRef {
	chunkId: string;
	chunkIndex: number;
	activityIndex: number;
	unit: Extract<RenderUnit, { kind: "activity" }>;
}

interface ChunkBoundaryActivityRefs {
	first?: ActivityRef;
	last?: ActivityRef;
}

function getChunkBoundaryActivityRefs(
	chunks: readonly ChunkActivityUnits[],
	chunkIndex: number,
): ChunkBoundaryActivityRefs {
	const chunk = chunks[chunkIndex];
	if (!chunk?.units || chunk.units.length === 0) return {};

	let activityIndex = 0;
	let first: ActivityRef | undefined;
	let last: ActivityRef | undefined;
	for (let unitIndex = 0; unitIndex < chunk.units.length; unitIndex++) {
		const unit = chunk.units[unitIndex];
		if (unit.kind !== "activity") continue;
		const ref = { chunkId: chunk.chunkId, chunkIndex, activityIndex, unit };
		if (unitIndex === 0) first = ref;
		if (unitIndex === chunk.units.length - 1) last = ref;
		activityIndex++;
	}
	return { first, last };
}

function activityRefKey(ref: ActivityRef): string {
	return `${ref.chunkIndex}:${ref.activityIndex}`;
}

function sameActivityRef(left: ActivityRef | undefined, right: ActivityRef): boolean {
	return left?.chunkIndex === right.chunkIndex && left.activityIndex === right.activityIndex;
}

interface ActivityRefSeed {
	chunkIndex: number;
	activityIndex: number;
}

/**
 * Collect only boundary components reachable from selected activity ordinals.
 * Cross-chunk components form linear chains: a chunk continues through both
 * sides only when its first and last boundary activity are the same ordinal.
 */
function collectBoundaryComponentsFromSeeds(
	chunks: readonly ChunkActivityUnits[],
	seeds: readonly ActivityRefSeed[],
): ActivityRef[][] {
	const boundaryCache = new Map<number, ChunkBoundaryActivityRefs>();
	const getBoundary = (chunkIndex: number) => {
		let boundary = boundaryCache.get(chunkIndex);
		if (!boundary) {
			boundary = getChunkBoundaryActivityRefs(chunks, chunkIndex);
			boundaryCache.set(chunkIndex, boundary);
		}
		return boundary;
	};
	const starts: ActivityRef[] = [];
	for (const seed of seeds) {
		const boundary = getBoundary(seed.chunkIndex);
		if (boundary.first?.activityIndex === seed.activityIndex) starts.push(boundary.first);
		if (
			boundary.last?.activityIndex === seed.activityIndex &&
			!sameActivityRef(boundary.first, boundary.last)
		) {
			starts.push(boundary.last);
		}
	}
	const visited = new Set<string>();
	const components: ActivityRef[][] = [];

	for (const start of starts) {
		if (visited.has(activityRefKey(start))) continue;
		const component: ActivityRef[] = [];
		const pending = [start];
		while (pending.length > 0) {
			const ref = pending.pop();
			if (!ref) continue;
			const key = activityRefKey(ref);
			if (visited.has(key)) continue;
			visited.add(key);
			component.push(ref);

			const boundary = getBoundary(ref.chunkIndex);
			if (sameActivityRef(boundary.first, ref) && ref.chunkIndex > 0) {
				const previous = getBoundary(ref.chunkIndex - 1).last;
				if (previous) pending.push(previous);
			}
			if (sameActivityRef(boundary.last, ref) && ref.chunkIndex + 1 < chunks.length) {
				const next = getBoundary(ref.chunkIndex + 1).first;
				if (next) pending.push(next);
			}
		}
		component.sort(
			(left, right) =>
				left.chunkIndex - right.chunkIndex || left.activityIndex - right.activityIndex,
		);
		components.push(component);
	}
	return components;
}

function collectTouchingBoundaryComponents(
	chunks: readonly ChunkActivityUnits[],
	targetIndex: number,
): ActivityRef[][] {
	const target = getChunkBoundaryActivityRefs(chunks, targetIndex);
	return collectBoundaryComponentsFromSeeds(
		chunks,
		[target.first, target.last]
			.filter((ref): ref is ActivityRef => ref != null)
			.map(({ chunkIndex, activityIndex }) => ({ chunkIndex, activityIndex })),
	);
}

function activityInputsEqual(
	left: ActivityInput[] | undefined,
	right: ActivityInput[] | undefined,
) {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((item, index) => {
		const other = right[index];
		if (!other || item.kind !== other.kind) return false;
		if (item.kind === "reasoning" && other.kind === "reasoning") {
			return (
				item.msg === other.msg && item.blockIndex === other.blockIndex && item.block === other.block
			);
		}
		return (
			item.kind === "tool" &&
			other.kind === "tool" &&
			item.msg === other.msg &&
			item.blockIndex === other.blockIndex &&
			item.tc === other.tc
		);
	});
}

function activityOverridesEqual(
	left: ActivityRenderOverride | undefined,
	right: ActivityRenderOverride | undefined,
): boolean {
	if (left === right) return true;
	if (!left || !right || left.hidden !== right.hidden) return false;
	return activityInputsEqual(left.appendItems, right.appendItems);
}

function buildComponentOverrides(components: readonly ActivityRef[][]) {
	const overrides = new Map<string, Map<number, ActivityRenderOverride>>();
	const setOverride = (ref: ActivityRef, override: ActivityRenderOverride) => {
		let chunkOverrides = overrides.get(ref.chunkId);
		if (!chunkOverrides) {
			chunkOverrides = new Map();
			overrides.set(ref.chunkId, chunkOverrides);
		}
		chunkOverrides.set(ref.activityIndex, override);
	};
	for (const component of components) {
		if (component.length < 2) continue;
		const [owner, ...continuations] = component;
		setOverride(owner, {
			appendItems: continuations.flatMap((ref) => ref.unit.items),
		});
		for (const continuation of continuations) setOverride(continuation, { hidden: true });
	}
	return overrides;
}

function patchTailBoundaryOverrides(
	baseChunks: readonly ChunkActivityUnits[],
	overlaidChunks: readonly ChunkActivityUnits[],
	tailIndex: number,
	baseOverrides: CrossChunkActivityOverrides,
): CrossChunkActivityOverrides {
	const oldComponents = collectTouchingBoundaryComponents(baseChunks, tailIndex);
	const overlaidTail = getChunkBoundaryActivityRefs(overlaidChunks, tailIndex);
	const newComponents = collectBoundaryComponentsFromSeeds(overlaidChunks, [
		...oldComponents.flatMap((component) =>
			component.map(({ chunkIndex, activityIndex }) => ({ chunkIndex, activityIndex })),
		),
		...[overlaidTail.first, overlaidTail.last]
			.filter((ref): ref is ActivityRef => ref != null)
			.map(({ chunkIndex, activityIndex }) => ({ chunkIndex, activityIndex })),
	]);
	const desired = buildComponentOverrides(newComponents);
	const oldKeys = new Map<string, Set<number>>();
	for (const component of oldComponents) {
		if (component.length < 2) continue;
		for (const ref of component) {
			let keys = oldKeys.get(ref.chunkId);
			if (!keys) {
				keys = new Set();
				oldKeys.set(ref.chunkId, keys);
			}
			keys.add(ref.activityIndex);
		}
	}

	const affectedChunkIds = new Set([...oldKeys.keys(), ...desired.keys()]);
	let patched: Map<string, ActivityRenderOverrides> | null = null;
	for (const chunkId of affectedChunkIds) {
		const baseChunkOverrides = baseOverrides.get(chunkId);
		const desiredChunkOverrides = desired.get(chunkId);
		const affectedOrdinals = new Set([
			...(oldKeys.get(chunkId) ?? []),
			...(desiredChunkOverrides?.keys() ?? []),
		]);
		let nextChunkOverrides: Map<number, ActivityRenderOverride> | null = null;
		for (const activityIndex of affectedOrdinals) {
			const baseOverride = baseChunkOverrides?.get(activityIndex);
			const desiredOverride = desiredChunkOverrides?.get(activityIndex);
			if (activityOverridesEqual(baseOverride, desiredOverride)) continue;
			nextChunkOverrides ??= new Map(baseChunkOverrides);
			if (desiredOverride) nextChunkOverrides.set(activityIndex, desiredOverride);
			else nextChunkOverrides.delete(activityIndex);
		}
		if (!nextChunkOverrides) continue;
		patched ??= new Map(baseOverrides);
		if (nextChunkOverrides.size > 0) patched.set(chunkId, nextChunkOverrides);
		else patched.delete(chunkId);
	}
	return patched ?? baseOverrides;
}

/**
 * Overlay only the live tail units on top of memoized persistent chunk units.
 * With no mounted streaming overlay, both base references are returned directly.
 * Otherwise only boundary components touching the tail are patched, preserving
 * every unaffected chunk's inner override map and override object references.
 */
export function buildCrossChunkActivityRenderPlan(
	baseChunks: readonly ChunkActivityUnits[],
	baseOverrides: CrossChunkActivityOverrides,
	tailOverlay: TailActivityOverlay | null,
	options: ActivityRenderUnitOptions,
): CrossChunkActivityRenderPlan {
	if (options.renderLod > 2 || !tailOverlay?.streamingMsg) {
		return { chunkUnits: baseChunks, overrides: baseOverrides };
	}

	const tailIndex = baseChunks.findIndex((chunk) => chunk.chunkId === tailOverlay.chunkId);
	if (tailIndex < 0 || !baseChunks[tailIndex]?.units) {
		return { chunkUnits: baseChunks, overrides: baseOverrides };
	}

	const overlaidChunks = [...baseChunks];
	overlaidChunks[tailIndex] = computeChunkActivityUnits(
		tailOverlay.chunkId,
		tailOverlay.messages,
		options,
		tailOverlay.streamingMsg,
	);
	return {
		chunkUnits: overlaidChunks,
		overrides: patchTailBoundaryOverrides(baseChunks, overlaidChunks, tailIndex, baseOverrides),
	};
}

/**
 * Build render overrides that merge activity units touching across loaded chunk
 * boundaries. The earliest unit owns the combined rows; continuation units are
 * hidden so chunk virtualization can retain independent containers and heights.
 */
export function buildCrossChunkActivityOverrides(
	chunks: readonly ChunkActivityUnits[],
): CrossChunkActivityOverrides {
	const refs: ActivityRef[] = [];
	const firstByChunk = new Map<number, ActivityRef>();
	const lastByChunk = new Map<number, ActivityRef>();

	for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
		const chunk = chunks[chunkIndex];
		if (!chunk.units) continue;
		let activityIndex = 0;
		let first: ActivityRef | undefined;
		let last: ActivityRef | undefined;
		for (const unit of chunk.units) {
			if (unit.kind !== "activity") continue;
			const ref: ActivityRef = {
				chunkId: chunk.chunkId,
				chunkIndex,
				activityIndex,
				unit,
			};
			refs.push(ref);
			first ??= ref;
			last = ref;
			activityIndex++;
		}
		if (first && chunk.units[0] === first.unit) firstByChunk.set(chunkIndex, first);
		if (last && chunk.units[chunk.units.length - 1] === last.unit)
			lastByChunk.set(chunkIndex, last);
	}

	if (refs.length < 2) return new Map();

	const refIndex = new Map<ActivityRef, number>();
	refs.forEach((ref, index) => {
		refIndex.set(ref, index);
	});
	const parent = refs.map((_, index) => index);

	const findRoot = (index: number): number => {
		let root = index;
		while (parent[root] !== root) root = parent[root];
		while (parent[index] !== index) {
			const next = parent[index];
			parent[index] = root;
			index = next;
		}
		return root;
	};
	const union = (left: ActivityRef, right: ActivityRef) => {
		const leftIndex = refIndex.get(left);
		const rightIndex = refIndex.get(right);
		if (leftIndex == null || rightIndex == null) return;
		const leftRoot = findRoot(leftIndex);
		const rightRoot = findRoot(rightIndex);
		if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
	};

	for (let chunkIndex = 1; chunkIndex < chunks.length; chunkIndex++) {
		// Direct adjacency is required. A null/unloaded chunk has no boundary refs,
		// so continuity cannot jump across its placeholder.
		const previousTail = lastByChunk.get(chunkIndex - 1);
		const currentHead = firstByChunk.get(chunkIndex);
		if (previousTail && currentHead) union(previousTail, currentHead);
	}

	const components = new Map<number, ActivityRef[]>();
	for (let index = 0; index < refs.length; index++) {
		const root = findRoot(index);
		const component = components.get(root);
		if (component) component.push(refs[index]);
		else components.set(root, [refs[index]]);
	}

	const mutableOverrides = new Map<string, Map<number, ActivityRenderOverride>>();
	const setOverride = (ref: ActivityRef, override: ActivityRenderOverride) => {
		let chunkOverrides = mutableOverrides.get(ref.chunkId);
		if (!chunkOverrides) {
			chunkOverrides = new Map();
			mutableOverrides.set(ref.chunkId, chunkOverrides);
		}
		chunkOverrides.set(ref.activityIndex, override);
	};

	for (const component of components.values()) {
		if (component.length < 2) continue;
		component.sort(
			(left, right) =>
				left.chunkIndex - right.chunkIndex || left.activityIndex - right.activityIndex,
		);
		const [owner, ...continuations] = component;
		setOverride(owner, {
			appendItems: continuations.flatMap((ref) => ref.unit.items),
		});
		for (const continuation of continuations) setOverride(continuation, { hidden: true });
	}

	return mutableOverrides;
}
