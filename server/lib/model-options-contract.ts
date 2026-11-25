import type { ModelListSource } from "./sourcing/model-list-readers";
import type { SourceGroupView } from "./sourcing/source-groups";

export const OPTIONS_BUDGET = {
	batchRows: 128,
	batchBytes: 64 * 1024,
	rows: 20_000,
	bytes: 8 * 1024 * 1024,
	queue: 8,
	buildMs: 10_000,
	queryMs: 2_000,
	coldMs: 12_000,
	pageBytes: 64 * 1024,
} as const;
export interface ModelOptionInput {
	value: string;
	label: string;
	provider: string;
	upstreamModelId: string;
	providerKey?: string;
	auto?: boolean;
	/** Only aggregation rows carry their configured, bounded member references. */
	aggregationMembers?: string[];
	inputPrice?: number | null;
	outputPrice?: number | null;
}
export interface ModelOptionSourceCandidate {
	value: string;
	provider: string;
	modelId?: string;
	inputPrice?: number | null;
	outputPrice?: number | null;
}
/** Selected scalar prices only; never materialize a card to order a bounded source set. */
export function modelOptionPrice(value: unknown, perToken = false): number | null | undefined {
	if (value === null) return null;
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	const price = Number(value) * (perToken ? 1_000_000 : 1);
	return Number.isFinite(price) && price >= 0 ? price : undefined;
}
export interface ModelOptionRow {
	value: string;
	label: string;
	provider?: string;
	modelId?: string;
	sourceCount?: number;
	aggregationId?: string;
	memberCount?: number;
	/** Unwrapped member reference for catalog/protocol details, never the selection pin. */
	concreteValue?: string;
	available?: boolean;
	subscription?: boolean;
	referencePrice?: number;
}
export interface ModelOptionsQuery {
	q: string;
	scope: "all" | "auto" | "concrete";
	limit: number;
	cursor?: string;
	sourceModelId?: string;
	aggregationId?: string;
}
export interface ModelOptionsPage {
	revision: string;
	items: ModelOptionRow[];
	nextCursor: string | null;
	hasMore: boolean;
}
export class ModelOptionsError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: 400 | 409 | 503 = 503,
	) {
		super(message);
	}
}
export function parseModelOptionsQuery(raw: Record<string, string | undefined>): ModelOptionsQuery {
	const q = raw.q ?? "";
	const scope = raw.scope ?? "all";
	const limit = raw.limit === undefined ? 40 : Number(raw.limit);
	if (
		q.length > 100 ||
		(raw.cursor?.length ?? 0) > 2048 ||
		(raw.sourceModelId?.length ?? 0) > 256 ||
		(raw.aggregationId?.length ?? 0) > 20 ||
		(raw.aggregationId !== undefined && !raw.aggregationId.trim()) ||
		(raw.aggregationId !== undefined && raw.sourceModelId !== undefined) ||
		!["all", "auto", "concrete"].includes(scope) ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		(raw.sourceModelId !== undefined && !raw.sourceModelId.trim())
	) {
		throw new ModelOptionsError("MODEL_OPTIONS_INVALID_QUERY", "Invalid model options query", 400);
	}
	return {
		q,
		scope: scope as ModelOptionsQuery["scope"],
		limit,
		...(raw.cursor !== undefined && { cursor: raw.cursor }),
		...(raw.sourceModelId !== undefined && { sourceModelId: raw.sourceModelId }),
		...(raw.aggregationId !== undefined && { aggregationId: raw.aggregationId }),
	};
}

/** Cache owners publish immutable arrays; capture pins that array and slices BEFORE projection. */
export interface ModelOptionsCapture {
	generation: number;
	count: number;
	readSlice(offset: number, limit: number): ModelOptionInput[];
}
const empty: readonly never[] = Object.freeze([]);
const arrayGenerations = new WeakMap<object, number>();
let nextGeneration = 0;
export function captureModelOptionsArray<T>(
	array: readonly T[] | undefined,
	project: (row: T) => ModelOptionInput,
	generation?: number,
): ModelOptionsCapture {
	const pinned = array?.length ? array : empty;
	let observed = arrayGenerations.get(pinned);
	if (observed === undefined) {
		observed = ++nextGeneration;
		arrayGenerations.set(pinned, observed);
	}
	return {
		generation: generation ?? observed,
		count: pinned.length,
		readSlice(offset, limit) {
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > OPTIONS_BUDGET.batchRows
			)
				throw new Error("Invalid capture slice");
			return pinned.slice(offset, offset + limit).map(project);
		},
	};
}
/** Each publication, including a same-reference publication, advances the cache generation. */
export class ModelOptionsCacheMap<K, V> extends Map<K, V> {
	generation = 0;
	override set(key: K, value: V): this {
		this.generation++;
		return super.set(key, value);
	}
	override delete(key: K): boolean {
		this.generation++;
		return super.delete(key);
	}
	override clear(): void {
		this.generation++;
		super.clear();
	}
}
type CaptureReader = (group: SourceGroupView) => ModelOptionsCapture;
const captures = new Map<ModelListSource, CaptureReader>();
export function registerModelOptionsCapture(
	source: ModelListSource,
	capture: CaptureReader,
): () => void {
	captures.set(source, capture);
	return () => {
		if (captures.get(source) === capture) captures.delete(source);
	};
}
export function captureTemplateModelOptions(group: SourceGroupView): ModelOptionsCapture {
	const singleton = ["codex", "tokendance", "command-code", "nug", "plugin"].includes(
		group.templateId,
	);
	const source = singleton
		? (group.templateId as ModelListSource)
		: (group.endpoint.protocol ?? "completions-compatible");
	const capture = captures.get(source);
	if (!capture)
		throw new ModelOptionsError(
			"MODEL_OPTIONS_OWNER_UNAVAILABLE",
			"Model cache owner is not ready",
		);
	return capture(group);
}
export function optionInput(group: SourceGroupView, id: string, label = id): ModelOptionInput {
	return {
		value: `${group.prefix}:${id}`,
		label,
		provider: group.prefix,
		upstreamModelId: id,
		...(["codex", "anthropic", "openai", "gemini"].includes(group.prefix) && {
			providerKey: group.prefix,
		}),
	};
}
