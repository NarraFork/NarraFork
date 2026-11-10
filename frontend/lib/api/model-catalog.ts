import type { AutoModelInfo } from "@shared/auto-model";
import type { ModelCard } from "@shared/model-catalog/card";
import type { CatalogQuery } from "@shared/model-catalog/resolve";
import type {
	CatalogStatus,
	ModelDescription,
	ModelDescriptionsResponse,
	ModelOverrideRequest,
} from "@shared/model-catalog/schema/api";
import { request } from "./client";

const root = "/model-catalog";
export const modelCatalogApi = {
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
