import type { AutoModelInfo } from "@shared/auto-model";
import type { ModelCard } from "@shared/model-catalog/card";
import type { CatalogQuery } from "@shared/model-catalog/resolve";
import type {
	CatalogStatus,
	ModelDescription,
	ModelDescriptionsResponse,
	ModelOverrideRequest,
} from "@shared/model-catalog/schema/api";
import { MODEL_RUNTIME_MAX_BYTES, type RuntimeModelSummary } from "@shared/model-runtime";
import { type RequestOptions, request } from "./client";

export interface ModelCatalogOption {
	value: string;
	label: string;
	provider?: string;
	modelId?: string;
	sourceCount?: number;
	aggregationId?: string;
	memberCount?: number;
	available?: boolean;
}
export interface ModelCatalogOptionsPage {
	revision: string;
	items: ModelCatalogOption[];
	nextCursor: string | null;
	hasMore: boolean;
}
export interface ModelCatalogOptionsInput {
	q?: string;
	cursor?: string;
	limit?: number;
	scope?: "all" | "auto" | "concrete";
	sourceModelId?: string;
	aggregationId?: string;
}

function boundedOptions(options: RequestOptions | undefined, bytes: number): RequestOptions {
	return {
		...options,
		maxResponseBytes: bytes,
		signal: options?.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
			: AbortSignal.timeout(15_000),
	};
}

const root = "/model-catalog";
export const modelCatalogApi = {
	runtime: (input: { model: string; narratorId?: string }, options?: RequestOptions) => {
		const query = new URLSearchParams({ model: input.model });
		if (input.narratorId) query.set("narratorId", input.narratorId);
		return request<RuntimeModelSummary>(
			`${root}/runtime?${query}`,
			boundedOptions(options, MODEL_RUNTIME_MAX_BYTES),
		);
	},
	options: (input: ModelCatalogOptionsInput = {}, options?: RequestOptions) => {
		const query = new URLSearchParams();
		if (input.q) query.set("q", input.q);
		if (input.cursor) query.set("cursor", input.cursor);
		if (input.scope) query.set("scope", input.scope);
		if (input.limit != null) query.set("limit", String(input.limit));
		if (input.sourceModelId) query.set("sourceModelId", input.sourceModelId);
		if (input.aggregationId) query.set("aggregationId", input.aggregationId);
		return request<ModelCatalogOptionsPage>(
			`${root}/options?${query}`,
			boundedOptions(options, 64 * 1024),
		);
	},
	status: () => request<CatalogStatus>(`${root}/status`),
	/** Every `auto:<model>` some provider serves, sources in the order routing tries them. */
	autoModels: () => request<{ models: AutoModelInfo[] }>(`${root}/auto`),
	/** The card a request for this full model value (`provider:model`) resolves to. */
	card: (model: string) =>
		request<ModelCard & { resolvedQuery: CatalogQuery }>(
			`${root}/card?model=${encodeURIComponent(model)}`,
		),
	describe: (models: string[]) =>
		request<ModelDescriptionsResponse>(`${root}/models`, {
			method: "POST",
			body: JSON.stringify({ models }),
		}),
	/** Save (or clear with `fields: null`) one override; returns `model` re-described. */
	setOverride: (input: ModelOverrideRequest & { model: string }) =>
		request<ModelDescription>(`${root}/overrides`, {
			method: "PUT",
			body: JSON.stringify(input),
		}),
	update: (action: "check" | "apply" | "restore-builtin") =>
		request<CatalogStatus>(`${root}/updates/${action}`, { method: "POST", body: "{}" }),
	setAutoUpdate: (autoUpdate: boolean) =>
		request<CatalogStatus>(`${root}/updates/settings`, {
			method: "PATCH",
			body: JSON.stringify({ autoUpdate }),
		}),
};
