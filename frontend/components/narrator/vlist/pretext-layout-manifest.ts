import type {
	PretextLayoutIndex,
	PretextLayoutManifest,
	PretextLayoutMetrics,
} from "@shared/pretext-layout";
import { buildPretextEngineLayout, type PretextEngineSource } from "@shared/pretext-layout/engine";
import type { RenderLod } from "./prepared-block";
import { type ComposeRoundGroupsOptions, composeRoundGroups } from "./round-group-compose";
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
	/**
	 * 整轮折叠配置。缺省 = 不折叠（不传就完全不进入合成路径）。
	 *
	 * 由 `buildPretextDocumentLayout` 从「LOD / 设置开关 / 已展开的轮」拼出来后传入。
	 */
	roundFold?: ComposeRoundGroupsOptions;
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

	// Deduplicate item keys BEFORE round folding: provider retries can produce
	// identical tool_use IDs across adjacent assistant messages, leading to duplicate
	// spec.key values. Doing this before `composeRoundGroups` ensures folded children
	// inside a `round-group` preview also have unique React keys and distinct toggle
	// identities, while keeping top-level items symmetric with the activity fold's `#n`.
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

	// Resolve source metadata (sourceMessageIds, firstSeq, lastSeq) BEFORE round
	// folding, in original item order. Otherwise a synthesized `round-group` key
	// (`roundgroup-*`) misses `resolveSource` and falls back to an unrelated message
	// by folded array index, corrupting `firstSeq` and losing search targets inside
	// the folded range.
	const resolvedSourceByItem = new Map<VListItem, PretextLayoutSource>();
	for (let index = 0; index < computed.items.length; index++) {
		const item = computed.items[index];
		if (!item) throw new Error(`pretext produced an empty layout item at index ${index}`);
		resolvedSourceByItem.set(item, options.resolveSource(item.spec, index, item));
	}

	// 整轮折叠（运行期合成）：把已完成的轮里「轮首之后 → 最终回复之前」的元素序列
	// 换成一个 `round-group` 元素。
	//
	// 关闭时（设置关掉 / 没有任何可折的轮）`composeRoundGroups` 返回原数组引用，零成本。
	let foldedItems: typeof computed.items = computed.items;
	if (options.roundFold) {
		foldedItems = composeRoundGroups(
			computed.items,
			options.roundFold,
		) as unknown as typeof computed.items;
	}
	const computedWithFolds = { ...computed, items: foldedItems };

	const resolveFoldedSource = (item: VListItem, index: number): PretextLayoutSource => {
		const preResolved = resolvedSourceByItem.get(item);
		if (preResolved) return preResolved;
		if (item.spec.kind === "round-group") {
			const folded = (item.spec.data as { folded?: readonly VListItem[] } | undefined)?.folded;
			if (Array.isArray(folded) && folded.length > 0) {
				const seenIds = new Set<string>();
				const sourceMessageIds: string[] = [];
				let firstSeq = Number.POSITIVE_INFINITY;
				let lastSeq = Number.NEGATIVE_INFINITY;
				for (const child of folded) {
					const childSource = resolvedSourceByItem.get(child);
					if (!childSource) continue;
					if (Number.isFinite(childSource.firstSeq) && childSource.firstSeq < firstSeq) {
						firstSeq = childSource.firstSeq;
					}
					if (Number.isFinite(childSource.lastSeq) && childSource.lastSeq > lastSeq) {
						lastSeq = childSource.lastSeq;
					}
					for (const id of childSource.sourceMessageIds) {
						if (!seenIds.has(id)) {
							seenIds.add(id);
							sourceMessageIds.push(id);
						}
					}
				}
				if (sourceMessageIds.length > 0 && Number.isFinite(firstSeq) && Number.isFinite(lastSeq)) {
					return { firstSeq, lastSeq, sourceMessageIds };
				}
			}
		}
		return options.resolveSource(item.spec, index, item);
	};

	// A wider gap is applied only at top-level boundaries: the boundary AFTER an
	// item whose NEXT item begins a new render unit (spec.unitStart). Intra-unit
	// boundaries (content blocks within a message, cards within a tool-run) keep
	// the base itemGap. Skipped entirely when segmentGap is absent or equals gap.
	const baseGap = options.gap ?? 4;
	const segmentGap = options.segmentGap;
	const widenBoundaries = segmentGap !== undefined && segmentGap !== baseGap;
	const sources: MeasuredPretextSource[] = computedWithFolds.items.map((item, index) => {
		if (!item) throw new Error(`pretext produced an empty layout item at index ${index}`);
		const source = resolveFoldedSource(item, index);
		const nextItem = computedWithFolds.items[index + 1];
		// A visual card run wins over a logical segment boundary: native search /
		// generation split tool segments, but their cards share the same surface.
		const gapAfter =
			inRunGapAfter(computedWithFolds.items, index) ??
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
	if (built.manifest.items.length !== computedWithFolds.items.length)
		throw new Error("pretext manifest item count diverged from prepared render items");
	for (let index = 0; index < computedWithFolds.items.length; index++) {
		const item = computedWithFolds.items[index];
		const manifestItem = built.manifest.items[index];
		if (!item || !manifestItem) throw new Error(`pretext manifest item ${index} is missing`);
		if (
			item.spec.key !== manifestItem.itemKey ||
			item.spec.kind !== manifestItem.kind ||
			item.measured.height !== manifestItem.height
		)
			throw new Error(`pretext manifest item ${index} diverged from prepared render item`);
	}
	return { manifest: built.manifest, index: built.index, items: computedWithFolds.items };
}
