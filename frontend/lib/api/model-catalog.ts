import type {
	ModelCatalogMutation,
	ModelCatalogSnapshot,
	ModelQuery,
	ResolvedModelMetadata,
} from "@shared/model-catalog";
import type { ModelCard, RawCatalog } from "@shared/model-catalog/card";
import type { ModelCardMutation } from "@shared/model-catalog/card-local";
import type { RawLocalState } from "@shared/model-catalog/card-resolver";
import type { CatalogUpdateStatus } from "@shared/model-catalog/schema/api";
import { request } from "./client";

/** v2 snapshot: complete source metadata plus the local layer, no derived defaults. */
export interface ModelCardSnapshot {
	schemaVersion: 2;
	catalog: RawCatalog;
	local: RawLocalState;
	update: CatalogUpdateStatus;
}

const root = "/model-catalog";
export const modelCatalogApi = {
	snapshot: () => request<ModelCatalogSnapshot>(root),
	cardSnapshot: () => request<ModelCardSnapshot>(`${root}/v2`),
	resolveCard: (query: ModelQuery) =>
		request<ModelCard>(`${root}/v2/resolve`, {
			method: "POST",
			body: JSON.stringify({ query }),
		}),
	resolveCardModel: (model: string) =>
		request<ModelCard & { resolvedQuery: ModelQuery }>(`${root}/v2/resolve`, {
			method: "POST",
			body: JSON.stringify({ model }),
		}),
	mutateCard: (mutation: ModelCardMutation) =>
		request<ModelCardSnapshot>(`${root}/v2/mutate`, {
			method: "POST",
			body: JSON.stringify(mutation),
		}),
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
