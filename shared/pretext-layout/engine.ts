import {
	buildPretextLayoutIndex,
	type PretextLayoutIndex,
	type PretextLayoutItem,
	type PretextLayoutManifest,
	type PretextLayoutMetrics,
} from "./index";

/** The source metadata every visual item must carry across environments. */
export interface PretextEngineSource {
	itemKey: string;
	firstSeq: number;
	lastSeq: number;
	sourceMessageIds: readonly string[];
	kind: string;
}

export interface PretextEngineIdentity {
	layoutRevision: string;
	documentRevision: string | number;
	lod: number;
	widthBucket: string | number;
	layoutOptionsRevision?: string;
}

/** Width-independent context used by the prepare phase. */
export interface PretextEnginePrepareContext extends PretextEngineIdentity {}

/** Concrete width context used only by the measure phase. */
export interface PretextEngineMeasureContext extends PretextEngineIdentity {
	contentWidth: number;
	viewportHeight: number;
}

export interface PretextEngineProvider<TSource extends PretextEngineSource, TPrepared> {
	/** Prepare once per source/document/LOD identity; do not read DOM state here. */
	prepare: (source: TSource, context: PretextEnginePrepareContext) => TPrepared;
	/** Return the exact height for the current width/LOD context. */
	measure: (prepared: TPrepared, context: PretextEngineMeasureContext) => number;
}

export interface BuildPretextEngineOptions extends PretextEngineIdentity {
	contentWidth: number;
	viewportHeight?: number;
	metrics: PretextLayoutMetrics;
}

export interface PreparedPretextEngineItem<TSource extends PretextEngineSource, TPrepared> {
	source: TSource;
	prepared: TPrepared;
	height: number;
}

export interface BuiltPretextEngineLayout<TSource extends PretextEngineSource, TPrepared> {
	manifest: PretextLayoutManifest;
	index: PretextLayoutIndex;
	preparedItems: readonly PreparedPretextEngineItem<TSource, TPrepared>[];
}

/**
 * Build one exact manifest through an environment-provided preparation/measurement
 * provider. This is the shared seam between browser canvas measurement, a future
 * server layout worker, and deterministic test providers.
 */
export function buildPretextEngineLayout<TSource extends PretextEngineSource, TPrepared>(
	sources: readonly TSource[],
	provider: PretextEngineProvider<TSource, TPrepared>,
	options: BuildPretextEngineOptions,
): BuiltPretextEngineLayout<TSource, TPrepared> {
	if (!Number.isFinite(options.contentWidth) || options.contentWidth <= 0)
		throw new Error("pretext engine contentWidth must be finite and positive");
	if (!Number.isFinite(options.viewportHeight) || (options.viewportHeight ?? 0) < 0)
		throw new Error("pretext engine viewportHeight must be finite and non-negative");

	const prepareContext: PretextEnginePrepareContext = {
		layoutRevision: options.layoutRevision,
		documentRevision: options.documentRevision,
		lod: options.lod,
		widthBucket: options.widthBucket,
		layoutOptionsRevision: options.layoutOptionsRevision,
	};
	const measureContext: PretextEngineMeasureContext = {
		...prepareContext,
		contentWidth: options.contentWidth,
		viewportHeight: options.viewportHeight ?? 0,
	};
	const preparedItems: PreparedPretextEngineItem<TSource, TPrepared>[] = sources.map((source) => {
		const prepared = provider.prepare(source, prepareContext);
		const height = provider.measure(prepared, measureContext);
		if (!Number.isFinite(height) || height < 0)
			throw new Error(`pretext engine produced an invalid height for ${source.itemKey}`);
		return { source, prepared, height };
	});
	const items: PretextLayoutItem[] = preparedItems.map(({ source, height }) => ({
		itemKey: source.itemKey,
		firstSeq: source.firstSeq,
		lastSeq: source.lastSeq,
		sourceMessageIds: [...source.sourceMessageIds],
		kind: source.kind,
		height,
	}));
	const manifest: PretextLayoutManifest = {
		layoutRevision: options.layoutRevision,
		documentRevision: options.documentRevision,
		lod: options.lod,
		widthBucket: options.widthBucket,
		metrics: options.metrics,
		items,
	};
	return { manifest, index: buildPretextLayoutIndex(manifest), preparedItems };
}
