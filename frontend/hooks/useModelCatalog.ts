import type { ModelCatalogMutation, ModelCatalogSnapshot, ModelQuery } from "@shared/model-catalog";
import type { ModelCardMutation } from "@shared/model-catalog/card-local";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modelCatalogApi } from "../lib/api/model-catalog";

export const modelCatalogKeys = {
	all: ["model-catalog"] as const,
	snapshot: ["model-catalog", "snapshot"] as const,
	resolved: (query?: ModelQuery) => ["model-catalog", "resolved", query] as const,
	cardSnapshot: ["model-catalog", "card-snapshot"] as const,
	card: (query?: ModelQuery) => ["model-catalog", "card", query] as const,
	cardModel: (model?: string) => ["model-catalog", "card-actual", model] as const,
};

/** One invalidation path for editors, version updates and binding changes. */
export async function invalidateModelCatalog(qc: QueryClient, snapshot?: ModelCatalogSnapshot) {
	if (snapshot) qc.setQueryData(modelCatalogKeys.snapshot, snapshot);
	await Promise.all([
		qc.invalidateQueries({ queryKey: modelCatalogKeys.all }),
		qc.invalidateQueries({ queryKey: ["model-cards"] }),
		qc.invalidateQueries({ queryKey: ["settings"] }),
		qc.invalidateQueries({ queryKey: ["model-pricing"] }),
	]);
}
export function useModelCatalog(enabled = true) {
	return useQuery({
		queryKey: modelCatalogKeys.snapshot,
		queryFn: modelCatalogApi.snapshot,
		staleTime: 60_000,
		enabled,
	});
}
export function useResolvedModel(query?: ModelQuery) {
	return useQuery({
		queryKey: modelCatalogKeys.resolved(query),
		queryFn: () => modelCatalogApi.resolve(query as ModelQuery),
		enabled: !!query,
		staleTime: 60_000,
	});
}
export function useActualResolvedModel(model?: string) {
	return useQuery({
		queryKey: [...modelCatalogKeys.all, "actual", model],
		queryFn: () => modelCatalogApi.resolveModel(model as string),
		enabled: !!model,
		staleTime: 60_000,
	});
}
export function useCatalogMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mutation: ModelCatalogMutation) => modelCatalogApi.mutate(mutation),
		onSuccess: (data) => invalidateModelCatalog(qc, data),
	});
}

/** v2 reads. The v1 snapshot stays available so old views keep working unchanged. */
export function useModelCardSnapshot(enabled = true) {
	return useQuery({
		queryKey: modelCatalogKeys.cardSnapshot,
		queryFn: modelCatalogApi.cardSnapshot,
		staleTime: 60_000,
		enabled,
	});
}
export function useResolvedModelCard(query?: ModelQuery) {
	return useQuery({
		queryKey: modelCatalogKeys.card(query),
		queryFn: () => modelCatalogApi.resolveCard(query as ModelQuery),
		enabled: !!query,
		staleTime: 60_000,
	});
}
export function useActualResolvedModelCard(model?: string) {
	return useQuery({
		queryKey: modelCatalogKeys.cardModel(model),
		queryFn: () => modelCatalogApi.resolveCardModel(model as string),
		enabled: !!model,
		staleTime: 60_000,
	});
}
export function useModelCardMutation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mutation: ModelCardMutation) => modelCatalogApi.mutateCard(mutation),
		// The v2 write changes the same local layer the v1 views read, so both
		// caches must be dropped together rather than only the v2 snapshot.
		onSuccess: () => invalidateModelCatalog(qc),
	});
}
export function useCatalogUpdate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (
			input:
				| { action: "check" | "apply" | "rollback"; version?: string }
				| { settings: { autoApply?: boolean; pinnedVersion?: string | null } },
		) =>
			"settings" in input
				? modelCatalogApi.settings(input.settings)
				: modelCatalogApi.update(input.action, input.version),
		onSuccess: (data) => invalidateModelCatalog(qc, data),
	});
}
