import type { ModelCatalogMutation, ModelCatalogSnapshot, ModelQuery } from "@shared/model-catalog";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modelCatalogApi } from "../lib/api/model-catalog";

export const modelCatalogKeys = {
	all: ["model-catalog"] as const,
	snapshot: ["model-catalog", "snapshot"] as const,
	resolved: (query?: ModelQuery) => ["model-catalog", "resolved", query] as const,
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
