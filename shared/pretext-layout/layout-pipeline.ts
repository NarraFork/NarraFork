/**
 * vlist-pipeline.ts — The deterministic compute core of PretextMessageList.
 *
 * Pure function pipeline (no React, no DOM):
 *   segments → adaptSegments → measureElement per spec → layoutItems
 *            → (on scroll) findVisibleRange
 *
 * PretextMessageList (the eventual component) wraps this with scroll state, a
 * scroll container, and the ChunkedMessageListHandle. Keeping the math here
 * makes the height/virtualization logic fully unit-testable with a canvas stub
 * and free of the component's stateful concerns.
 *
 * Zero DOM measurement: every height comes from measureElement (pretext pure
 * arithmetic). The only inputs are data + width + lod + scroll offsets.
 */

import type { VListElementKind } from "./element-kinds";
import type { MeasuredElement, RenderLod } from "./prepared-block";
import {
	type AdapterContext,
	type AdapterRenderUnit,
	type AdapterSegment,
	adaptRenderUnits,
	adaptSegments,
	type ElementSpec,
} from "./segment-adapter";
import {
	findVisibleRange,
	type LaidOutItem,
	type ListLayout,
	layoutItems,
	spacerHeights,
} from "./vlist-virtualization";

/** One fully-resolved list item: its spec + measured height + prepared blocks. */
export interface VListItem {
	spec: ElementSpec;
	measured: MeasuredElement;
}

export interface VListLayoutResult {
	/** Adapted + measured items, in order. */
	items: VListItem[];
	/** Per-item vertical geometry (top/height/bottom) + total canvas height. */
	layout: ListLayout;
}

export interface ComputeLayoutOptions {
	/** Available content width (px) for each element. */
	contentWidth: number;
	/** Render LOD (height master switch). */
	lod: RenderLod;
	/** Inter-item vertical gap (px). */
	gap?: number;
	/** Canvas top / bottom padding (px). */
	topPadding?: number;
	bottomPadding?: number;
	/** Resolve an element's expanded state (reasoning/tool/subagent/trace). */
	isExpanded?: (key: string) => boolean | undefined;
	isLodUserOverride?: (key: string) => boolean;
	showEarlier?: (key: string) => boolean;
	expandedRows?: (key: string) => readonly number[];
	/**
	 * Row-KEY addressed expansion, for the trace that folds a LIVE row list
	 * (`activity-trace`). See `AdapterContext.isRowExpanded` for why an index cannot
	 * survive a live run — and why the append-only traces stay on `expandedRows`.
	 */
	isRowExpanded?: (traceKey: string, rowKey: string) => boolean;
	/** Resolve whether a translated body shows its ORIGINAL text. */
	showOriginal?: (key: string) => boolean;
	/** Resolve whether a subagent card's prompt body is open. */
	isPromptOpen?: (key: string) => boolean;
	/** L5 recency window for tool/subagent cards. */
	recentMessageIds?: ReadonlySet<string>;
	/** Viewport height for isPlan tool-call cap (0.85×). */
	viewportHeight?: number;
	/** i18n labels passed through to measures. */
	labels?: Record<string, string>;
	/** Authoritative tool category resolver (tool-display.getCategory), injected
	 * by the shell so tool-call height (default-open) is correct. */
	resolveToolCategory?: (toolName: string, input?: unknown) => string;
	resolveToolColor?: (toolName: string, input?: unknown) => string;
	resolveToolTitle?: (tc: unknown) => string;
	/** Authoritative header summary (tool-display.getSummary), injected by the shell
	 * so the vlist header matches the chunked card even for truncated inputs. */
	resolveToolSummary?: (tc: unknown) => string;
	/**
	 * Label detail for ONE subagent recent-call row, from the tool name plus the
	 * whitelisted short input keys the server projected. Separate from
	 * `resolveToolSummary` because these rows carry no tool call at all — only that
	 * projection (the activity query never selects `input_json`).
	 */
	resolveSubagentRecentSummary?: (toolName: string, inputSummary: unknown) => string | null;
	/**
	 * Whether an error card may offer the "turn off image generation and retry"
	 * provider fix. Injected by the shell (eligibility depends on the user's role
	 * and the narrator's resolved provider). The fix is a LABELLED button on its own
	 * row, so this decision changes the card's measured height.
	 */
	canOfferProviderFix?: (errorText: string) => boolean;
	/** True when a tool/subagent item has a live pending permission request; forces
	 * its card expanded and folds into the measure cache key. */
	resolveHasPendingPermission?: (toolUseId: string | undefined) => boolean;
	/** Tool-use id of the latest spec://tasks.json call; that card never folds. */
	resolveLatestSpecTasksToolUseId?: () => string | null;
	/** Plan body from a pending permission when the tool call carries none yet. */
	resolvePendingPlan?: (toolUseId: string | undefined) => string | undefined;
	/**
	 * Full (un-truncated) tool payloads once the shell has fetched them.
	 *
	 * These MUST be forwarded into the adapter context: they are the only way a
	 * fetched payload replaces the server-side preview. Omitting them (as this
	 * pipeline did) leaves `truncatedLeafCount` permanently above zero, so the
	 * card keeps its notice, the shell keeps the row in its "in flight" set, and
	 * the notice reads "loading…" forever even though the fetch resolved.
	 */
	resolveFullToolInput?: (toolUseId: string | undefined) => unknown;
	resolveFullToolOutput?: (toolUseId: string | undefined) => unknown;
	/** A live pending permission's suggestions (reflection-gate precedence). */
	resolvePendingPermissionSuggestions?: (toolUseId: string | undefined) => unknown[] | undefined;
	/** Reader enabled per-turn token usage rows (absent → no usage specs at all). */
	showTokenUsage?: boolean;
	/** Phone-sized viewport → the trailing usage summary splits across two lines. */
	compactUsageLines?: boolean;
	/** Locale-aware number grouping for the usage rows. */
	formatUsageNumber?: (value: number) => string;
	/**
	 * Document version (narrator messageVersion) folded into the measurement
	 * cache key. Any in-place message edit bumps this, so a cached height/blocks
	 * entry for a stable spec.key is invalidated when the underlying content
	 * changes. Omitted (undefined) leaves the cache keyed by content-agnostic
	 * fields only — safe for pure/immutable specs but unsafe for editable text.
	 */
	documentRevision?: string | number;
}

const DEFAULT_GAP = 4;

export type MeasureElement = (
	kind: VListElementKind,
	data: unknown,
	contentWidth: number,
	lod: RenderLod,
	opts?: Record<string, unknown>,
	/** Stable spec key for measurement caching (optional; uncached when absent). */
	specKey?: string,
	/** Document version folded into the cache key so edits invalidate stale entries. */
	documentRevision?: string | number,
) => MeasuredElement;

/**
 * Compute the full list layout from segments using an injected measurement
 * provider. The shared pipeline owns adaptation and geometry; the runtime owns
 * the concrete text measurement registry.
 */
export function computePretextVListLayout(
	segmentsOrUnits: readonly AdapterSegment[] | readonly AdapterRenderUnit[],
	opts: ComputeLayoutOptions,
	measureElement: MeasureElement,
): VListLayoutResult {
	const ctx: AdapterContext = {
		lod: opts.lod,
		isExpanded: opts.isExpanded,
		isLodUserOverride: opts.isLodUserOverride,
		showEarlier: opts.showEarlier,
		expandedRows: opts.expandedRows,
		isRowExpanded: opts.isRowExpanded,
		showOriginal: opts.showOriginal,
		isPromptOpen: opts.isPromptOpen,
		recentMessageIds: opts.recentMessageIds,
		viewportHeight: opts.viewportHeight,
		labels: opts.labels,
		resolveToolCategory: opts.resolveToolCategory,
		resolveToolColor: opts.resolveToolColor,
		resolveToolTitle: opts.resolveToolTitle as AdapterContext["resolveToolTitle"],
		resolveToolSummary: opts.resolveToolSummary as AdapterContext["resolveToolSummary"],
		resolveSubagentRecentSummary: opts.resolveSubagentRecentSummary,
		canOfferProviderFix: opts.canOfferProviderFix,
		resolveHasPendingPermission: opts.resolveHasPendingPermission,
		resolveLatestSpecTasksToolUseId: opts.resolveLatestSpecTasksToolUseId,
		resolvePendingPlan: opts.resolvePendingPlan,
		resolveFullToolInput: opts.resolveFullToolInput,
		resolveFullToolOutput: opts.resolveFullToolOutput,
		resolvePendingPermissionSuggestions: opts.resolvePendingPermissionSuggestions,
		showTokenUsage: opts.showTokenUsage,
		compactUsageLines: opts.compactUsageLines,
		formatUsageNumber: opts.formatUsageNumber,
	};
	const first = segmentsOrUnits[0];
	const specs =
		first && (first.kind === "segment" || first.kind === "activity")
			? adaptRenderUnits(segmentsOrUnits as readonly AdapterRenderUnit[], ctx)
			: adaptSegments(segmentsOrUnits as readonly AdapterSegment[], ctx);

	const items: VListItem[] = new Array(specs.length);
	const heights: number[] = new Array(specs.length);
	for (let i = 0; i < specs.length; i++) {
		const spec = specs[i];
		if (!spec) continue;
		const measured = measureElement(
			spec.kind,
			spec.data,
			opts.contentWidth,
			opts.lod,
			spec.opts,
			spec.key,
			opts.documentRevision,
		);
		items[i] = { spec, measured };
		heights[i] = measured.height;
	}

	const layout = layoutItems(
		heights,
		opts.gap ?? DEFAULT_GAP,
		opts.topPadding ?? 0,
		opts.bottomPadding ?? 0,
	);
	return { items, layout };
}

export interface VisibleWindow {
	start: number;
	end: number;
	topSpacer: number;
	bottomSpacer: number;
}

/**
 * Resolve the mounted window for a scroll position. Pure; call on every scroll
 * frame (cheap binary search over the prefix layout).
 */
export function resolveVisibleWindow(
	layout: ListLayout,
	scrollTop: number,
	viewportHeight: number,
	overscan = 0,
): VisibleWindow {
	const { start, end } = findVisibleRange(layout.items, scrollTop, viewportHeight, overscan);
	const { top, bottom } = spacerHeights(layout.items, start, end, layout.totalHeight);
	return { start, end, topSpacer: top, bottomSpacer: bottom };
}

/** Convenience: the laid-out item geometry array. */
export function itemGeometry(layout: ListLayout): readonly LaidOutItem[] {
	return layout.items;
}
