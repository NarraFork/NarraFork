import {
	capturePretextLayoutAnchor,
	type PretextLayoutIndex,
	patchPretextLayoutHeights,
	restorePretextLayoutAnchor,
} from "@shared/pretext-layout";
import type { MeasureElement, VListItem } from "@shared/pretext-layout/layout-pipeline";
import type { RenderLod } from "./prepared-block";
import { type ResizePermissionResolver, reflowPermissionForms } from "./vlist-resize-permission";

/** Keep both the work and the shrink-to-reveal loop bounded to one batch per frame. */
export const RESIZE_PREVIEW_MAX_ITEMS = 64;
export const RESIZE_PREVIEW_OVERSCAN = 160;

export interface ResizePreviewView {
	scrollTop: number;
	viewportHeight: number;
	pinnedToBottom: boolean;
}

export interface ResizePreviewInput {
	index: PretextLayoutIndex;
	items: readonly VListItem[];
	/** Fallback only for older/test items without their own outer column width. */
	committedWidth: number;
	width: number;
	lod: RenderLod;
	view: ResizePreviewView;
	measure: MeasureElement;
	/** Real heights of the controlled dynamic-row exceptions, at their CURRENT width. */
	heightOverrides?: ReadonlyMap<string, number>;
	/** A local form-height report invalidates just its row, even at the same width. */
	dirtyKeys?: ReadonlySet<string>;
	resolvePermissionForm?: ResizePermissionResolver;
	maxItems?: number;
	overscan?: number;
}

/** Apply real-height corrections without losing per-item gaps or changing the raw frame. */
export function indexWithHeightOverrides(
	index: PretextLayoutIndex,
	overrides: ReadonlyMap<string, number> | undefined,
	excluded?: ReadonlySet<string>,
): PretextLayoutIndex {
	if (!overrides?.size) return index;
	const heights = new Map<number, number>();
	for (const [key, height] of overrides) {
		if (excluded?.has(key) || !Number.isFinite(height) || height < 0) continue;
		const found = index.itemByKey(key);
		if (found && found.item.height !== height) heights.set(found.index, height);
	}
	return heights.size ? patchPretextLayoutHeights(index, heights) : index;
}

function windowRange(index: PretextLayoutIndex, top: number, height: number, overscan: number) {
	if (index.manifest.items.length === 0) return { start: 0, end: 0 };
	return {
		start: Math.max(0, index.itemIndexAtOffset(Math.max(0, top - overscan))),
		end: Math.min(
			index.manifest.items.length,
			index.itemIndexAtOffset(top + height + overscan) + 1,
		),
	};
}

/**
 * Reflow existing specs, never messages: no segmentation, adaptation or source indexing.
 * Outside the chosen batch both the prepared frame AND outer column width survive.
 * Numeric suffix geometry may move, but that is not an off-screen text reflow.
 */
export function previewResize(input: ResizePreviewInput) {
	const { index, items, view, measure } = input;
	const width = Math.max(1, Math.round(input.width));
	const overscan = input.overscan ?? RESIZE_PREVIEW_OVERSCAN;
	const maxItems = Math.max(1, Math.floor(input.maxItems ?? RESIZE_PREVIEW_MAX_ITEMS));
	const effective = indexWithHeightOverrides(index, input.heightOverrides);
	const anchor = capturePretextLayoutAnchor(
		effective,
		view.scrollTop,
		view.viewportHeight,
		view.pinnedToBottom,
	);
	const visible = windowRange(effective, view.scrollTop, view.viewportHeight, 0);
	const buffered = windowRange(effective, view.scrollTop, view.viewportHeight, overscan);
	// Visible first, then buffer. A dense buffer may be deferred to the next frame.
	const candidates: number[] = [];
	for (let i = visible.start; i < visible.end; i++) candidates.push(i);
	for (let i = buffered.start; i < visible.start; i++) candidates.push(i);
	for (let i = visible.end; i < buffered.end; i++) candidates.push(i);
	const changedKeys = new Set<string>();
	const changedWidths = new Set<string>();
	const heights = new Map<number, number>();
	let nextItems: VListItem[] | undefined;
	for (const itemIndex of candidates) {
		if (changedKeys.size >= maxItems) break;
		const item = items[itemIndex];
		if (!item) continue;
		if (
			Math.round(item.contentWidth ?? input.committedWidth) === width &&
			!input.dirtyKeys?.has(item.spec.key)
		)
			continue;
		if (Math.round(item.contentWidth ?? input.committedWidth) !== width)
			changedWidths.add(item.spec.key);
		const data = reflowPermissionForms(item.spec.data, width, input.resolvePermissionForm);
		const spec = data === item.spec.data ? item.spec : { ...item.spec, data };
		const measured = measure(
			spec.kind,
			spec.data,
			width,
			input.lod,
			spec.opts,
			spec.key,
			index.manifest.documentRevision,
		);
		nextItems ??= items.slice();
		nextItems[itemIndex] = { spec, measured, contentWidth: width };
		changedKeys.add(spec.key);
		heights.set(itemIndex, measured.height);
	}
	const nextIndex = heights.size ? patchPretextLayoutHeights(index, heights) : index;
	const effectiveNext = indexWithHeightOverrides(nextIndex, input.heightOverrides, changedWidths);
	const scrollTop = restorePretextLayoutAnchor(anchor, effectiveNext, view.viewportHeight);
	const nextRange = windowRange(effectiveNext, scrollTop, view.viewportHeight, overscan);
	const resultItems = nextItems ?? items;
	let needsMore = false;
	for (let i = nextRange.start; i < nextRange.end; i++) {
		const item = resultItems[i];
		if (
			item &&
			(Math.round(item.contentWidth ?? input.committedWidth) !== width ||
				(input.dirtyKeys?.has(item.spec.key) && !changedKeys.has(item.spec.key)))
		) {
			needsMore = true;
			break;
		}
	}
	return {
		index: nextIndex,
		items: resultItems,
		changedKeys,
		needsMore,
		scrollTop,
		anchorKind: anchor.kind,
	};
}
