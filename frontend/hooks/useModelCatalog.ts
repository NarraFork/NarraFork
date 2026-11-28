import type { ModelDescription } from "@shared/model-catalog/schema/api";
import type { RuntimeModelSummary } from "@shared/model-runtime";
import {
	type QueryClient,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getAuthSnapshot, subscribeAuth } from "../lib/api/client";
import { type ModelCatalogOptionsInput, modelCatalogApi } from "../lib/api/model-catalog";
import { narratorWSManager } from "../lib/narrator-ws-manager";

export const modelCatalogKeys = {
	all: ["model-catalog"] as const,
	status: ["model-catalog", "status"] as const,
	options: (generation: number, input: ModelCatalogOptionsInput) =>
		[
			"model-catalog",
			"options",
			generation,
			input.scope ?? "all",
			input.q ?? "",
			input.sourceModelId ?? "",
			input.aggregationId ?? "",
			input.cursor ?? "",
			input.limit ?? 40,
		] as const,
	runtime: (
		generation: number,
		model: string | undefined,
		narratorId?: string,
		revision?: string,
	) =>
		[
			"model-catalog",
			"runtime",
			generation,
			narratorId ?? null,
			model ?? null,
			revision ?? null,
		] as const,
	card: (model?: string) => ["model-catalog", "card", model] as const,
	model: (model: string) => ["model-catalog", "model", model] as const,
};

type RuntimeRefresh = { started: boolean; dirty: boolean; promise: Promise<void> };
const runtimeRefreshes = new WeakMap<QueryClient, Map<string, RuntimeRefresh>>();
/** The three mounted current-model consumers share a single narrator-marker refresh. */
function refreshRuntimeSelection(
	qc: QueryClient,
	queryKey: ReturnType<typeof modelCatalogKeys.runtime>,
	generation: number,
): Promise<void> {
	const active = () =>
		getAuthSnapshot().generation === generation &&
		qc.getQueryCache().find({ queryKey, exact: true })?.isActive() === true;
	if (!active()) return Promise.resolve();
	let entries = runtimeRefreshes.get(qc);
	if (!entries) {
		entries = new Map();
		runtimeRefreshes.set(qc, entries);
	}
	const key = JSON.stringify(queryKey);
	const old = entries.get(key);
	if (old) {
		if (old.started) old.dirty = true;
		return old.promise;
	}
	let complete!: () => void;
	let fail!: (error: unknown) => void;
	const entry: RuntimeRefresh = {
		started: false,
		dirty: false,
		promise: new Promise<void>((resolve, reject) => {
			complete = resolve;
			fail = reject;
		}),
	};
	entries.set(key, entry);
	queueMicrotask(() => {
		void (async () => {
			if (!active()) return;
			entry.started = true;
			await qc.cancelQueries({ queryKey, exact: true });
			do {
				entry.dirty = false;
				if (!active()) return;
				await qc.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
			} while (entry.dirty && active());
		})().then(
			() => {
				entries.delete(key);
				complete();
			},
			(error) => {
				entries.delete(key);
				fail(error);
			},
		);
	});
	return entry.promise;
}

/** A single bounded page. The caller advances the cursor only on an explicit gesture. */
export function useModelOptions(input: ModelCatalogOptionsInput, opened: boolean) {
	const { generation, hasToken } = useSyncExternalStore(
		subscribeAuth,
		getAuthSnapshot,
		getAuthSnapshot,
	);
	return useQuery({
		queryKey: modelCatalogKeys.options(generation, input),
		queryFn: async ({ signal }) => {
			if (getAuthSnapshot().generation !== generation)
				throw new DOMException("Session changed", "AbortError");
			const page = await modelCatalogApi.options(input, { signal });
			if (getAuthSnapshot().generation !== generation)
				throw new DOMException("Session changed", "AbortError");
			return page;
		},
		enabled: opened && hasToken,
		staleTime: 30_000,
		gcTime: 60_000,
		retry: false,
	});
}

/** Prefer the already-authorized narrator DTO; never fetch its default placeholder. */
export function useRuntimeModel({
	model,
	narratorId,
	summary,
	enabled = true,
	revision,
}: {
	model: string | null | undefined;
	narratorId?: string;
	summary?: RuntimeModelSummary | null;
	enabled?: boolean;
	/** Small settings/runtime generation, not provider configuration JSON. */
	revision?: string;
}) {
	const { generation, hasToken } = useSyncExternalStore(
		subscribeAuth,
		getAuthSnapshot,
		getAuthSnapshot,
	);
	const qc = useQueryClient();
	const summaryOwner = useRef({ generation, summary });
	if (summaryOwner.current.summary !== summary) summaryOwner.current = { generation, summary };
	const matchingSummary =
		hasToken &&
		summaryOwner.current.generation === generation &&
		summary != null &&
		summary.selection.value === model &&
		(revision === undefined || String(summary.settingsRevision) === revision)
			? summary
			: undefined;
	const query = useQuery({
		initialData: matchingSummary,
		queryKey: modelCatalogKeys.runtime(generation, model ?? undefined, narratorId, revision),
		queryFn: async ({ signal }) => {
			if (getAuthSnapshot().generation !== generation)
				throw new DOMException("Session changed", "AbortError");
			const result = await modelCatalogApi.runtime(
				{ model: model as string, narratorId },
				{ signal },
			);
			if (
				getAuthSnapshot().generation !== generation ||
				result.selection.value !== model ||
				(revision !== undefined && String(result.settingsRevision) !== revision)
			)
				throw new DOMException("Model selection or configuration changed", "AbortError");
			return result;
		},
		enabled: enabled && !!model && hasToken,
		staleTime: 30_000,
		gcTime: 60_000,
		retry: false,
	});
	useEffect(() => {
		if (!enabled || !hasToken || !model || !narratorId) return;
		const queryKey = modelCatalogKeys.runtime(generation, model, narratorId, revision);
		const listener = narratorWSManager.addListener(
			{ types: ["runtime_model_changed"], narratorIds: [narratorId] },
			(message) => {
				if (getAuthSnapshot().generation !== generation || message.narratorId !== narratorId)
					return;
				void refreshRuntimeSelection(qc, queryKey, generation);
			},
		);
		return () => narratorWSManager.removeListener(listener);
	}, [enabled, generation, hasToken, model, narratorId, qc, revision]);
	useEffect(() => {
		if (!matchingSummary || !enabled || getAuthSnapshot().generation !== generation) return;
		const queryKey = modelCatalogKeys.runtime(generation, model ?? undefined, narratorId, revision);
		const current = qc.getQueryData<RuntimeModelSummary>(queryKey);
		if (current) {
			if (current.settingsRevision > matchingSummary.settingsRevision) return;
			if (
				current.settingsRevision === matchingSummary.settingsRevision &&
				(current.observedAt ?? 0) >= (matchingSummary.observedAt ?? 0)
			)
				return;
		}
		// Only a provably newer snapshot may supersede a completed or in-flight read.
		void qc.cancelQueries({ queryKey, exact: true });
		qc.setQueryData(queryKey, matchingSummary);
	}, [enabled, matchingSummary, model, narratorId, qc, revision, generation]);
	return { ...query, data: enabled ? query.data : undefined };
}

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
