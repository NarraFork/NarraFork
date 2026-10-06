export interface PretextLayoutItem {
	/** Stable identity of the visual item, not a viewport or transport request id. */
	itemKey: string;
	/** Inclusive source sequence range represented by this visual item. */
	firstSeq: number;
	lastSeq: number;
	/** Source message ids used to build the item (tool/activity items may span messages). */
	sourceMessageIds: readonly string[];
	/** Registry/pretext element kind used by the renderer. */
	kind: string;
	/** Exact content height for the manifest's lod/width/document revision. */
	height: number;
	/**
	 * Optional per-item gap applied AFTER this item, overriding `metrics.itemGap`
	 * for this one boundary. Used to open larger spacing between top-level
	 * messages/segments while keeping intra-message / in-run items tight. The gap
	 * after the last item is always dropped regardless of this value.
	 */
	gapAfter?: number;
}

export interface PretextLayoutMetrics {
	topPadding: number;
	itemGap: number;
	bottomPadding: number;
}

export interface PretextLayoutManifest {
	layoutRevision: string;
	documentRevision: string | number;
	lod: number;
	widthBucket: string | number;
	metrics: PretextLayoutMetrics;
	items: readonly PretextLayoutItem[];
}

export function checksumPretextLayoutItems(items: readonly PretextLayoutItem[]): string {
	const payload = items.map((item) => [
		item.itemKey,
		item.firstSeq,
		item.lastSeq,
		item.sourceMessageIds,
		item.kind,
		item.height,
		item.gapAfter ?? null,
	]);
	const text = JSON.stringify(payload);
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export type PretextLayoutAnchor =
	| {
			kind: "item";
			itemKey: string;
			offsetWithinItem: number;
			fallbackIndex: number;
			/**
			 * Viewport-relative Y of the anchored point at capture time (0 = the
			 * viewport top, the implicit anchor when no focus point is given).
			 *
			 * Restoring subtracts it, so the anchored content returns to the SAME
			 * screen position instead of being pulled up to the viewport top. This is
			 * what keeps the content under the mouse / pinch center fixed while an LOD
			 * switch resizes everything around it.
			 */
			viewportOffset?: number;
			/**
			 * `offsetWithinItem` as a fraction of the anchored item's height at capture
			 * time. Only consulted when the item became SHORTER than the captured
			 * offset (an LOD fold), where the absolute offset would otherwise clamp to
			 * the item's bottom edge.
			 */
			offsetRatio?: number;
			/**
			 * Source message ids of the anchored item. An LOD switch replaces item keys
			 * (a tool card folds into a run-count line), so these are the key-independent
			 * way to find the same CONTENT in the rebuilt layout.
			 */
			sourceMessageIds?: readonly string[];
	  }
	| {
			kind: "bottom";
			distanceFromBottom: number;
	  };

export interface CapturePretextLayoutAnchorOptions {
	/**
	 * Document offset (px from the canvas top) of the point whose content must stay
	 * visually fixed — the mouse position for alt+wheel, the pinch center for a
	 * two-finger gesture. Defaults to `scrollTop`, i.e. the viewport top.
	 */
	focusOffset?: number;
}

export interface PretextLayoutIndex {
	readonly manifest: PretextLayoutManifest;
	readonly itemStarts: readonly number[];
	readonly itemEnds: readonly number[];
	readonly totalHeight: number;
	itemIndexAtOffset(offset: number): number;
	itemStart(itemIndex: number): number;
	itemEnd(itemIndex: number): number;
	itemByKey(itemKey: string): { item: PretextLayoutItem; index: number } | undefined;
	itemIndicesForSourceSeq(seq: number): readonly number[];
	itemIndicesForSourceMessageId(messageId: string): readonly number[];
}

function nonNegativeFinite(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0)
		throw new Error(`${label} must be a finite non-negative number`);
	return value;
}

function validateItem(item: PretextLayoutItem, index: number): void {
	if (!item.itemKey) throw new Error(`layout item ${index} has no itemKey`);
	if (!Number.isInteger(item.firstSeq) || !Number.isInteger(item.lastSeq))
		throw new Error(`layout item ${item.itemKey} has a non-integer seq range`);
	if (item.lastSeq < item.firstSeq)
		throw new Error(`layout item ${item.itemKey} has an inverted seq range`);
	if (!item.kind) throw new Error(`layout item ${item.itemKey} has no kind`);
	nonNegativeFinite(item.height, `layout item ${item.itemKey} height`);
	if (item.gapAfter !== undefined)
		nonNegativeFinite(item.gapAfter, `layout item ${item.itemKey} gapAfter`);
	if (item.sourceMessageIds.length === 0)
		throw new Error(`layout item ${item.itemKey} has no source message ids`);
	if (item.sourceMessageIds.some((messageId) => !messageId))
		throw new Error(`layout item ${item.itemKey} has an empty source message id`);
}

function normalizeMetrics(metrics: PretextLayoutMetrics): PretextLayoutMetrics {
	return {
		topPadding: nonNegativeFinite(metrics.topPadding, "topPadding"),
		itemGap: nonNegativeFinite(metrics.itemGap, "itemGap"),
		bottomPadding: nonNegativeFinite(metrics.bottomPadding, "bottomPadding"),
	};
}

interface PretextLayoutIdentityLookup {
	itemIndexForKey(itemKey: string): number | undefined;
	itemIndicesForSourceSeq: PretextLayoutIndex["itemIndicesForSourceSeq"];
	itemIndicesForSourceMessageId: PretextLayoutIndex["itemIndicesForSourceMessageId"];
}

// Every snapshot shares identity/source lookup state, never a chain of previous snapshots.
const identityLookups = new WeakMap<PretextLayoutIndex, PretextLayoutIdentityLookup>();

function createPretextLayoutIndex(
	manifest: PretextLayoutManifest,
	itemStarts: readonly number[],
	itemEnds: readonly number[],
	totalHeight: number,
	identity: PretextLayoutIdentityLookup,
): PretextLayoutIndex {
	const { items, metrics } = manifest;
	const itemIndexAtOffset = (offset: number): number => {
		if (items.length === 0) return -1;
		const target = Math.min(Math.max(offset, 0), Math.max(0, totalHeight - 1));
		let low = 0;
		let high = itemStarts.length - 1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			const start = itemStarts[middle] ?? 0;
			const end = itemEnds[middle] ?? start;
			if (target < start) high = middle - 1;
			else if (target >= end && middle < itemStarts.length - 1) low = middle + 1;
			else return middle;
		}
		return Math.min(Math.max(low, 0), itemStarts.length - 1);
	};
	const itemStart = (itemIndex: number): number => {
		if (items.length === 0) return metrics.topPadding;
		return itemStarts[Math.min(Math.max(itemIndex, 0), items.length - 1)] ?? metrics.topPadding;
	};
	const itemEnd = (itemIndex: number): number => {
		if (items.length === 0) return metrics.topPadding;
		return itemEnds[Math.min(Math.max(itemIndex, 0), items.length - 1)] ?? metrics.topPadding;
	};
	const index: PretextLayoutIndex = {
		manifest,
		itemStarts,
		itemEnds,
		totalHeight,
		itemIndexAtOffset,
		itemStart,
		itemEnd,
		itemByKey: (itemKey) => {
			const itemIndex = identity.itemIndexForKey(itemKey);
			const item = itemIndex === undefined ? undefined : items[itemIndex];
			return item && itemIndex !== undefined ? { item, index: itemIndex } : undefined;
		},
		itemIndicesForSourceSeq: identity.itemIndicesForSourceSeq,
		itemIndicesForSourceMessageId: identity.itemIndicesForSourceMessageId,
	};
	identityLookups.set(index, identity);
	return index;
}

export function buildPretextLayoutIndex(manifest: PretextLayoutManifest): PretextLayoutIndex {
	const metrics = normalizeMetrics(manifest.metrics);
	const seenKeys = new Set<string>();
	const items = manifest.items.map((item, index) => {
		validateItem(item, index);
		if (seenKeys.has(item.itemKey)) throw new Error(`duplicate layout item key ${item.itemKey}`);
		seenKeys.add(item.itemKey);
		return { ...item, sourceMessageIds: [...item.sourceMessageIds] };
	});
	const itemStarts: number[] = [];
	const itemEnds: number[] = [];
	let cursor = metrics.topPadding;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (!item) continue;
		itemStarts.push(cursor);
		const end = cursor + item.height;
		itemEnds.push(end);
		// A per-item gapAfter overrides the uniform itemGap for this one boundary
		// (larger spacing between top-level messages, tight within a message/run).
		// The trailing gap after the final item is always dropped.
		const gap = item.gapAfter ?? metrics.itemGap;
		cursor = end + (index < items.length - 1 ? gap : 0);
	}
	const totalHeight = cursor + metrics.bottomPadding;
	const byKey = new Map(items.map((item, index) => [item.itemKey, index]));
	const bySourceMessageId = new Map<string, number[]>();
	for (let index = 0; index < items.length; index++) {
		const uniqueMessageIds = new Set(items[index]?.sourceMessageIds ?? []);
		for (const messageId of uniqueMessageIds) {
			const mapped = bySourceMessageId.get(messageId);
			if (mapped) mapped.push(index);
			else bySourceMessageId.set(messageId, [index]);
		}
	}
	const sourceIntervals = items
		.map((item, index) => ({ firstSeq: item.firstSeq, lastSeq: item.lastSeq, itemIndex: index }))
		.sort((left, right) =>
			left.firstSeq !== right.firstSeq
				? left.firstSeq - right.firstSeq
				: left.itemIndex - right.itemIndex,
		);
	const maxLastSeqByInterval: number[] = [];
	for (let index = 0; index < sourceIntervals.length; index++) {
		maxLastSeqByInterval[index] = Math.max(
			maxLastSeqByInterval[index - 1] ?? Number.NEGATIVE_INFINITY,
			sourceIntervals[index]?.lastSeq ?? Number.NEGATIVE_INFINITY,
		);
	}
	const itemIndicesForSourceSeq = (seq: number): readonly number[] => {
		if (!Number.isInteger(seq) || sourceIntervals.length === 0) return [];
		let low = 0;
		let high = sourceIntervals.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((sourceIntervals[middle]?.firstSeq ?? Number.POSITIVE_INFINITY) <= seq) low = middle + 1;
			else high = middle;
		}
		const matched: number[] = [];
		for (let index = low - 1; index >= 0; index--) {
			if ((maxLastSeqByInterval[index] ?? Number.NEGATIVE_INFINITY) < seq) break;
			const interval = sourceIntervals[index];
			if (interval && interval.lastSeq >= seq) matched.push(interval.itemIndex);
		}
		return matched.sort((left, right) => left - right);
	};
	return createPretextLayoutIndex(
		{ ...manifest, metrics, items },
		itemStarts,
		itemEnds,
		totalHeight,
		{
			itemIndexForKey: (itemKey) => byKey.get(itemKey),
			itemIndicesForSourceSeq,
			itemIndicesForSourceMessageId: (messageId) => bySourceMessageId.get(messageId) ?? [],
		},
	);
}

/**
 * Replace only changed heights, preserving item identity/order and all source lookup state.
 * No height or revision change returns the original index. A revision-only change shares
 * the existing items and geometry. Neither path mutates the supplied snapshot.
 */
export function patchPretextLayoutHeights(
	index: PretextLayoutIndex,
	heights: ReadonlyMap<number, number>,
	layoutRevision?: string,
): PretextLayoutIndex {
	const { manifest } = index;
	let items: PretextLayoutItem[] | undefined;
	let firstChanged = manifest.items.length;
	for (const [itemIndex, height] of heights) {
		if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= manifest.items.length)
			throw new Error(`invalid layout item index ${itemIndex}`);
		nonNegativeFinite(height, `layout item ${itemIndex} height`);
		const item = manifest.items[itemIndex];
		if (!item || item.height === height) continue;
		items ??= manifest.items.slice();
		items[itemIndex] = { ...item, height };
		firstChanged = Math.min(firstChanged, itemIndex);
	}
	const nextRevision = layoutRevision ?? manifest.layoutRevision;
	if (!items && nextRevision === manifest.layoutRevision) return index;

	let itemStarts = index.itemStarts;
	let itemEnds = index.itemEnds;
	let totalHeight = index.totalHeight;
	if (items) {
		const starts = index.itemStarts.slice();
		const ends = index.itemEnds.slice();
		let cursor = starts[firstChanged] ?? manifest.metrics.topPadding;
		// Recompute from the unchanged prefix rather than adding deltas: the exact
		// arithmetic order matches a full build, even after many fractional patches.
		for (let itemIndex = firstChanged; itemIndex < items.length; itemIndex++) {
			const item = items[itemIndex];
			if (!item) continue;
			starts[itemIndex] = cursor;
			const end = cursor + item.height;
			ends[itemIndex] = end;
			cursor =
				end + (itemIndex < items.length - 1 ? (item.gapAfter ?? manifest.metrics.itemGap) : 0);
		}
		itemStarts = starts;
		itemEnds = ends;
		totalHeight = cursor + manifest.metrics.bottomPadding;
	}

	let identity = identityLookups.get(index);
	if (!identity) {
		// Structural implementations of the public interface can share their lookups
		// too. Register once, so later patches never wrap a preceding patch's methods.
		identity = {
			itemIndexForKey: (itemKey) => index.itemByKey(itemKey)?.index,
			itemIndicesForSourceSeq: index.itemIndicesForSourceSeq.bind(index),
			itemIndicesForSourceMessageId: index.itemIndicesForSourceMessageId.bind(index),
		};
		identityLookups.set(index, identity);
	}
	return createPretextLayoutIndex(
		{ ...manifest, layoutRevision: nextRevision, items: items ?? manifest.items },
		itemStarts,
		itemEnds,
		totalHeight,
		identity,
	);
}

export function capturePretextLayoutAnchor(
	index: PretextLayoutIndex,
	scrollTop: number,
	viewportHeight: number,
	pinnedToBottom: boolean,
	options: CapturePretextLayoutAnchorOptions = {},
): PretextLayoutAnchor {
	if (pinnedToBottom) {
		return {
			kind: "bottom",
			distanceFromBottom: Math.max(0, index.totalHeight - scrollTop - Math.max(0, viewportHeight)),
		};
	}
	// The point to keep fixed. Clamped into the visible band so a stale pointer
	// position (or one captured over the chrome outside the list) cannot anchor on
	// content that is not on screen, and only honored while it lands inside the
	// item band — a point over the trailing padding / streaming tail keeps the
	// previous viewport-top behavior.
	const focusOffset = resolveFocusOffset(index, options.focusOffset, scrollTop, viewportHeight);
	// A scroll position inside the leading canvas padding is not inside an item.
	// Keep the sentinel explicit so restoring an anchor does not jump down to the
	// first item when a rebuilt layout is otherwise unchanged.
	if (index.itemStarts.length > 0 && focusOffset < index.itemStart(0)) {
		return { kind: "item", itemKey: "", offsetWithinItem: 0, fallbackIndex: -1 };
	}
	const itemIndex = index.itemIndexAtOffset(focusOffset);
	if (itemIndex < 0) {
		return { kind: "item", itemKey: "", offsetWithinItem: 0, fallbackIndex: -1 };
	}
	const item = index.manifest.items[itemIndex];
	const itemHeight = Math.max(0, index.itemEnd(itemIndex) - index.itemStart(itemIndex));
	const offsetWithinItem = Math.max(0, focusOffset - index.itemStart(itemIndex));
	// Screen offset of the ANCHORED POINT, which is not always the focus point: a
	// focus offset landing in the GAP between two items resolves to the following
	// item with `offsetWithinItem` clamped to 0. Measuring from the resolved point
	// (rather than from `focusOffset`) lets restore put that point back exactly where
	// it was, instead of pulling the item's top up to the focus position — a jump of
	// up to one inter-item gap on every anchored rebuild, which streaming made
	// frequent. For a focus point INSIDE an item this is algebraically identical to
	// the previous `focusOffset - scrollTop` (itemStart + offsetWithinItem ===
	// focusOffset there), so nothing else changes.
	const anchoredViewportOffset = index.itemStart(itemIndex) + offsetWithinItem - scrollTop;
	return {
		kind: "item",
		itemKey: item?.itemKey ?? "",
		offsetWithinItem,
		fallbackIndex: itemIndex,
		// Omitted when the anchored point IS the viewport top, so anchors captured
		// without a focus point stay byte-identical to the previous shape.
		...(anchoredViewportOffset > 0 ? { viewportOffset: anchoredViewportOffset } : {}),
		...(itemHeight > 0 ? { offsetRatio: Math.min(1, offsetWithinItem / itemHeight) } : {}),
		...(item && item.sourceMessageIds.length > 0
			? { sourceMessageIds: [...item.sourceMessageIds] }
			: {}),
	};
}

/**
 * Resolve the document offset whose content must stay fixed.
 *
 * Falls back to `scrollTop` (the viewport top, the historical behavior) when no
 * focus point was supplied, when it is outside the visible band, or when it lands
 * past the last item — a point over the trailing padding, the streaming tail or
 * the footer has no item to anchor on, and anchoring the last item there would
 * make the rebuild pull the document up.
 */
function resolveFocusOffset(
	index: PretextLayoutIndex,
	focusOffset: number | undefined,
	scrollTop: number,
	viewportHeight: number,
): number {
	if (focusOffset == null || !Number.isFinite(focusOffset)) return scrollTop;
	const bottom = scrollTop + Math.max(0, viewportHeight);
	if (focusOffset < scrollTop || focusOffset > bottom) return scrollTop;
	const lastEnd = index.itemEnds[index.itemEnds.length - 1];
	if (lastEnd != null && focusOffset > lastEnd) return scrollTop;
	return focusOffset;
}

/**
 * Locate the anchored item in the rebuilt layout.
 *
 * The item KEY is the precise handle, but an LOD switch is exactly the case where
 * it disappears: a tool card at L5 becomes part of a `toolrun-count-…` line at
 * L2, so the key it was captured under no longer exists. The captured source
 * message ids identify the same CONTENT regardless of how it is now rendered, so
 * they are the next-best handle; `fallbackIndex` (a positional guess) is only used
 * when neither resolves.
 */
function locateAnchoredItem(anchor: PretextLayoutAnchor, next: PretextLayoutIndex): number {
	if (anchor.kind !== "item") return -1;
	const byKey = anchor.itemKey ? next.itemByKey(anchor.itemKey) : undefined;
	if (byKey) return byKey.index;
	for (const messageId of anchor.sourceMessageIds ?? []) {
		const candidates = next.itemIndicesForSourceMessageId(messageId);
		const first = candidates[0];
		if (first != null) return first;
	}
	if (next.manifest.items.length === 0) return -1;
	return Math.min(Math.max(anchor.fallbackIndex, 0), next.manifest.items.length - 1);
}

export function restorePretextLayoutAnchor(
	anchor: PretextLayoutAnchor,
	next: PretextLayoutIndex,
	viewportHeight: number,
): number {
	if (anchor.kind === "bottom") {
		return Math.max(0, next.totalHeight - Math.max(0, viewportHeight) - anchor.distanceFromBottom);
	}
	if (!anchor.itemKey && anchor.fallbackIndex < 0) return 0;
	const index = locateAnchoredItem(anchor, next);
	if (index < 0 || next.manifest.items.length === 0) return 0;
	const itemHeight = Math.max(0, next.itemEnd(index) - next.itemStart(index));
	// The item usually keeps its absolute offset (only the content BELOW the point
	// moved). When an LOD fold made it shorter than the captured offset, the
	// absolute value would pin to its bottom edge and lose the position inside the
	// content — scale by the captured ratio instead.
	const offsetWithinItem =
		anchor.offsetRatio != null && anchor.offsetWithinItem > itemHeight
			? anchor.offsetRatio * itemHeight
			: Math.min(anchor.offsetWithinItem, itemHeight);
	// Put the anchored point back at the SAME screen position it was captured at,
	// rather than at the viewport top. No upper clamp: the scroll container clamps
	// the write itself, and clamping here would report a corrected scrollTop that
	// silently differs from the one a short canvas can actually take.
	return Math.max(0, next.itemStart(index) + offsetWithinItem - (anchor.viewportOffset ?? 0));
}

export function replacePretextLayout(
	previous: PretextLayoutIndex | undefined,
	nextManifest: PretextLayoutManifest,
	anchor: PretextLayoutAnchor | undefined,
	viewportHeight: number,
): { index: PretextLayoutIndex; scrollTop?: number } {
	const next = buildPretextLayoutIndex(nextManifest);
	if (!previous || !anchor) return { index: next };
	return {
		index: next,
		scrollTop: restorePretextLayoutAnchor(anchor, next, viewportHeight),
	};
}

export {
	type ComputeLayoutOptions,
	computePretextVListLayout,
	type MeasureElement,
	resolveVisibleWindow,
	type VisibleWindow,
	type VListItem,
	type VListLayoutResult,
} from "./layout-pipeline";
