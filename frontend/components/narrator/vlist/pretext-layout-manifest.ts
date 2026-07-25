import type {
	PretextLayoutIndex,
	PretextLayoutManifest,
	PretextLayoutMetrics,
} from "@shared/pretext-layout";
import { buildPretextEngineLayout, type PretextEngineSource } from "@shared/pretext-layout/engine";
import type { RenderLod } from "./prepared-block";
import type { AdapterRenderUnit, ElementSpec } from "./segment-adapter";
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
	 * items (content blocks, in-run tool cards) at the tight base `gap`. Omitted
	 * (or equal to `gap`) → every boundary uses the uniform base gap.
	 */
	segmentGap?: number;
}

export interface BuiltPretextLayoutManifest {
	manifest: PretextLayoutManifest;
	index: PretextLayoutIndex;
	/** Prepared render items paired with the exact heights in `index`. */
	items: readonly VListItem[];
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
	const keyCounts = new Map<string, number>();
	for (const item of computed.items) {
		const key = item.spec.key;
		const prev = keyCounts.get(key) ?? 0;
		if (prev > 0) {
			const deduped = `${key}#dup${prev}`;
			item.spec.key = deduped;
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
		const gapAfter = widenBoundaries && nextItem?.spec.unitStart === true ? segmentGap : undefined;
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
