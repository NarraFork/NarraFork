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
	  }
	| {
			kind: "bottom";
			distanceFromBottom: number;
	  };

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
		cursor = end + (index < items.length - 1 ? metrics.itemGap : 0);
	}
	const totalHeight = cursor + metrics.bottomPadding;
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
	const byKey = new Map(items.map((item, index) => [item.itemKey, { item, index }]));
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
	return {
		manifest: { ...manifest, metrics, items },
		itemStarts,
		itemEnds,
		totalHeight,
		itemIndexAtOffset,
		itemStart,
		itemEnd,
		itemByKey: (itemKey) => byKey.get(itemKey),
		itemIndicesForSourceSeq,
		itemIndicesForSourceMessageId: (messageId) => bySourceMessageId.get(messageId) ?? [],
	};
}

export function capturePretextLayoutAnchor(
	index: PretextLayoutIndex,
	scrollTop: number,
	viewportHeight: number,
	pinnedToBottom: boolean,
): PretextLayoutAnchor {
	if (pinnedToBottom) {
		return {
			kind: "bottom",
			distanceFromBottom: Math.max(0, index.totalHeight - scrollTop - Math.max(0, viewportHeight)),
		};
	}
	// A scroll position inside the leading canvas padding is not inside an item.
	// Keep the sentinel explicit so restoring an anchor does not jump down to the
	// first item when a rebuilt layout is otherwise unchanged.
	if (index.itemStarts.length > 0 && scrollTop < index.itemStart(0)) {
		return { kind: "item", itemKey: "", offsetWithinItem: 0, fallbackIndex: -1 };
	}
	const itemIndex = index.itemIndexAtOffset(scrollTop);
	if (itemIndex < 0) {
		return { kind: "item", itemKey: "", offsetWithinItem: 0, fallbackIndex: -1 };
	}
	const item = index.manifest.items[itemIndex];
	return {
		kind: "item",
		itemKey: item?.itemKey ?? "",
		offsetWithinItem: Math.max(0, scrollTop - index.itemStart(itemIndex)),
		fallbackIndex: itemIndex,
	};
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
	const located = anchor.itemKey ? next.itemByKey(anchor.itemKey) : undefined;
	const index =
		located?.index ?? Math.min(Math.max(anchor.fallbackIndex, 0), next.manifest.items.length - 1);
	if (index < 0 || next.manifest.items.length === 0) return 0;
	const maxOffset = Math.max(0, next.itemEnd(index) - next.itemStart(index));
	return Math.max(0, next.itemStart(index) + Math.min(anchor.offsetWithinItem, maxOffset));
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
