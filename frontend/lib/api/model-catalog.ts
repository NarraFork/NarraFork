import type {
	ModelCatalogMutation,
	ModelCatalogSnapshot,
	ModelQuery,
	ResolvedModelMetadata,
} from "@shared/model-catalog";
import { request } from "./client";

const root = "/model-catalog";
export const modelCatalogApi = {
	snapshot: () => request<ModelCatalogSnapshot>(root),
	mutate: (mutation: ModelCatalogMutation) =>
		request<ModelCatalogSnapshot>(`${root}/mutate`, {
			method: "POST",
			body: JSON.stringify(mutation),
		}),
	resolve: (query: ModelQuery) =>
		request<ResolvedModelMetadata>(`${root}/resolve`, {
			method: "POST",
			body: JSON.stringify({ query }),
		}),
	resolveModel: (model: string) =>
		request<ResolvedModelMetadata & { resolvedQuery: ModelQuery }>(`${root}/resolve`, {
			method: "POST",
			body: JSON.stringify({ model }),
		}),
	update: (action: "check" | "apply" | "rollback", version?: string) =>
		request<ModelCatalogSnapshot>(`${root}/updates/${action}`, {
			method: "POST",
			body: JSON.stringify(version ? { version } : {}),
		}),
	settings: (settings: { autoApply?: boolean; pinnedVersion?: string | null }) =>
		request<ModelCatalogSnapshot>(`${root}/updates/settings`, {
			method: "PATCH",
			body: JSON.stringify(settings),
		}),
};
