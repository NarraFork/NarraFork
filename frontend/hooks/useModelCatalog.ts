import type { ModelDescription } from "@shared/model-catalog/schema/api";
import {
	type QueryClient,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { modelCatalogApi } from "../lib/api/model-catalog";

export const modelCatalogKeys = {
	all: ["model-catalog"] as const,
	status: ["model-catalog", "status"] as const,
	card: (model?: string) => ["model-catalog", "card", model] as const,
	model: (model: string) => ["model-catalog", "model", model] as const,
};

/** Everything derived from the catalog or the overrides is stale after any change. */
export async function invalidateModelCatalog(qc: QueryClient) {
	await Promise.all([
		qc.invalidateQueries({ queryKey: modelCatalogKeys.all }),
		// The settings payload and model lists carry catalog-derived values.
		qc.invalidateQueries({ queryKey: ["settings"] }),
		qc.invalidateQueries({ queryKey: ["model-pricing"] }),
	]);
}

export function useCatalogStatus(enabled = true) {
	return useQuery({
		queryKey: modelCatalogKeys.status,
		queryFn: modelCatalogApi.status,
		staleTime: 60_000,
		enabled,
	});
}

export function useCatalogUpdate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (
			input: { action: "check" | "apply" | "restore-builtin" } | { autoUpdate: boolean },
		) =>
			"autoUpdate" in input
				? modelCatalogApi.setAutoUpdate(input.autoUpdate)
				: modelCatalogApi.update(input.action),
		onSuccess: async (status) => {
			qc.setQueryData(modelCatalogKeys.status, status);
			await invalidateModelCatalog(qc);
		},
	});
}

/** The card a request for this full model value (`provider:model`) actually resolves to. */
export function useActualResolvedModelCard(model?: string) {
	return useQuery({
		queryKey: modelCatalogKeys.card(model),
		queryFn: () => modelCatalogApi.card(model as string),
		enabled: !!model,
		staleTime: 60_000,
	});
}

/**
 * Rows on a provider page or the models page each ask for one model; requests made in
 * the same tick go to the server as one batch.
 */
type Waiter = { resolve: (value: ModelDescription) => void; reject: (error: unknown) => void };
const waiters = new Map<string, Waiter[]>();
let flushScheduled = false;
const BATCH = 500;
function flush() {
	flushScheduled = false;
	const batch = [...waiters];
	waiters.clear();
	for (let i = 0; i < batch.length; i += BATCH) {
		const chunk = batch.slice(i, i + BATCH);
		modelCatalogApi.describe(chunk.map(([model]) => model)).then(
			({ models }) => {
				const byModel = new Map(models.map((info) => [info.model, info]));
				for (const [model, list] of chunk) {
					const info = byModel.get(model.trim());
					for (const waiter of list)
						if (info) waiter.resolve(info);
						else waiter.reject(new Error(`No metadata for ${model}`));
				}
			},
			(error) => {
				for (const [, list] of chunk) for (const waiter of list) waiter.reject(error);
			},
		);
	}
}
function describe(model: string) {
	return new Promise<ModelDescription>((resolve, reject) => {
		const list = waiters.get(model) ?? [];
		list.push({ resolve, reject });
		waiters.set(model, list);
		if (flushScheduled) return;
		flushScheduled = true;
		setTimeout(flush, 0);
	});
}

/** One provider entry's effective fields, their origins and its overrides. */
export function useModelDescription(model: string | undefined, enabled = true) {
	return useQuery({
		queryKey: modelCatalogKeys.model(model ?? ""),
		queryFn: () => describe(model as string),
		enabled: enabled && !!model,
		staleTime: 30_000,
	});
}

/** Several provider entries, fetched in one batch. */
export function useModelDescriptions(models: string[]) {
	return useQueries({
		queries: models.map((model) => ({
			queryKey: modelCatalogKeys.model(model),
			queryFn: () => describe(model),
			staleTime: 30_000,
		})),
	});
}

export function useSetModelOverride() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: modelCatalogApi.setOverride,
		onSuccess: async (description) => {
			qc.setQueryData(modelCatalogKeys.model(description.model), description);
			await invalidateModelCatalog(qc);
		},
	});
}
