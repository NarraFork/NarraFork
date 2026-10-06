import type {
	PretextLayoutIndex,
	PretextLayoutManifest,
	PretextLayoutMetrics,
} from "@shared/pretext-layout";
import { buildPretextEngineLayout, type PretextEngineSource } from "@shared/pretext-layout/engine";
import type { RenderLod } from "./prepared-block";
import type { AdapterRenderUnit, ElementSpec } from "./segment-adapter";
import { isConnectedCardBoundary } from "./vlist-exact-layout";
import { type ComputeLayoutOptions, computeVListLayout, type VListItem } from "./vlist-pipeline";

export interface PretextLayoutSource {
	firstSeq: number;
	lastSeq: number;
	sourceMessageIds: readonly string[];
}

type MeasuredPretextSource = PretextEngineSource & {
	measuredHeight: number;
};

export interface BuildPretextLayoutManifestOptions extends Omit<ComputeLayoutOptions, "lod"> {
	layoutRevision: string;
	documentRevision: string | number;
	lod: RenderLod;
	widthBucket: string | number;
	renderUnits: readonly AdapterRenderUnit[];
	resolveSource: (spec: ElementSpec, itemIndex: number, item: VListItem) => PretextLayoutSource;
	/**
	 * Gap (px) between top-level render units (messages / tool-runs / dividers).
	 * When set and larger than the base `gap`, the boundary AFTER a unit's last
	 * item is widened to this value via the item's `gapAfter`, keeping intra-unit
	 * content blocks at the tight base `gap`. Connected action cards always have
	 * zero gap, including across unit boundaries. Omitted (or equal to `gap`) →
	 * other boundaries use the uniform base gap.
	 */
	segmentGap?: number;
}

export interface BuiltPretextLayoutManifest {
	manifest: PretextLayoutManifest;
	index: PretextLayoutIndex;
	/** Prepared render items paired with the exact heights in `index`. */
	items: readonly VListItem[];
}

/** Same visual run boundary as the decorative frame, even across render units. */
function inRunGapAfter(items: readonly VListItem[], index: number): number | undefined {
	return isConnectedCardBoundary(items[index], items[index + 1]) ? 0 : undefined;
}

function metricsFrom(options: BuildPretextLayoutManifestOptions): PretextLayoutMetrics {
	return {
		topPadding: options.topPadding ?? 0,
		itemGap: options.gap ?? 4,
		bottomPadding: options.bottomPadding ?? 0,
	};
}

export function buildPretextLayoutManifest(
	options: BuildPretextLayoutManifestOptions,
): BuiltPretextLayoutManifest {
	const computed = computeVListLayout(options.renderUnits, options);

	// Deduplicate item keys: provider retries can produce identical tool_use IDs
	// across adjacent assistant messages, leading to duplicate spec.key values.
	// We disambiguate in-place so both sources[].itemKey and item.spec.key stay in sync.
	//
	// `unitId` is suffixed with the SAME index, because it is the cross-level morph
	// identity (`unitId ?? key`, see vlist-lod-morph.ts) and the low-LOD side already
	// disambiguates a retry on its own: the activity fold appends `#<n>` via
	// `dedupeSuffix` (segment-adapter), giving rows `tool-x` and `tool-x#1`. Leaving
	// the two cards here both claiming a bare `tool-x` made the retry's SECOND call
	// unpairable — the planner keys on a Map, so the duplicate collapsed and one card
	// silently lost its animation. Suffixing keeps the two sides symmetric.
	//
	// The suffix must match the fold's (`#1` for the second copy), not `#dup1`: these
	// are two renderings of one call and the strings have to be equal to pair.
	const keyCounts = new Map<string, number>();
	for (const item of computed.items) {
		const key = item.spec.key;
		const prev = keyCounts.get(key) ?? 0;
		if (prev > 0) {
			item.spec.key = `${key}#dup${prev}`;
			// Only a spec that HAS a unitId gets one back; absent stays absent so the
			// planner keeps falling back to `key` for bodies, bubbles and dividers.
			if (item.spec.unitId) item.spec.unitId = `${item.spec.unitId}#${prev}`;
		}
		keyCounts.set(key, prev + 1);
	}

	// A wider gap is applied only at top-level boundaries: the boundary AFTER an
	// item whose NEXT item begins a new render unit (spec.unitStart). Intra-unit
	// boundaries (content blocks within a message, cards within a tool-run) keep
	// the base itemGap. Skipped entirely when segmentGap is absent or equals gap.
	const baseGap = options.gap ?? 4;
	const segmentGap = options.segmentGap;
	const widenBoundaries = segmentGap !== undefined && segmentGap !== baseGap;
	const sources: MeasuredPretextSource[] = computed.items.map((item, index) => {
		if (!item) throw new Error(`pretext produced an empty layout item at index ${index}`);
		const source = options.resolveSource(item.spec, index, item);
		const nextItem = computed.items[index + 1];
		// A visual card run wins over a logical segment boundary: native search /
		// generation split tool segments, but their cards share the same surface.
		const gapAfter =
			inRunGapAfter(computed.items, index) ??
			(widenBoundaries && nextItem?.spec.unitStart === true ? segmentGap : undefined);
		return {
			...source,
			itemKey: item.spec.key,
			kind: item.spec.kind,
			measuredHeight: item.measured.height,
			...(gapAfter === undefined ? {} : { gapAfter }),
		};
	});
	const built = buildPretextEngineLayout(
		sources,
		{
			prepare: (source) => source,
			measure: (source) => source.measuredHeight,
		},
		{
			layoutRevision: options.layoutRevision,
			documentRevision: options.documentRevision,
			lod: options.lod,
			widthBucket: options.widthBucket,
			contentWidth: options.contentWidth,
			viewportHeight: options.viewportHeight ?? 0,
			metrics: metricsFrom(options),
		},
	);
	if (built.manifest.items.length !== computed.items.length)
		throw new Error("pretext manifest item count diverged from prepared render items");
	for (let index = 0; index < computed.items.length; index++) {
		const item = computed.items[index];
		const manifestItem = built.manifest.items[index];
		if (!item || !manifestItem) throw new Error(`pretext manifest item ${index} is missing`);
		if (
			item.spec.key !== manifestItem.itemKey ||
			item.spec.kind !== manifestItem.kind ||
			item.measured.height !== manifestItem.height
		)
			throw new Error(`pretext manifest item ${index} diverged from prepared render item`);
	}
	return { manifest: built.manifest, index: built.index, items: computed.items };
}
