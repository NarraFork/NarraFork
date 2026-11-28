import type { RuntimeSettings } from "@shared/settings-runtime";
import { type MutateOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getAuthSnapshot, subscribeAuth } from "../lib/api/client";
import { runtimeSettingsQueryKey } from "./useRuntimeSettings";

type Input = Record<string, unknown>;
type Scope = { input: Input; generation: number };
type Options = MutateOptions<RuntimeSettings, Error, Input, void>;
const isCurrentGeneration = (generation: number) => getAuthSnapshot().generation === generation;

function scopedOptions(
	options?: Options,
): MutateOptions<RuntimeSettings, Error, Scope, void> | undefined {
	return (
		options && {
			onSuccess: (data, scope, context, mutation) => {
				if (isCurrentGeneration(scope.generation))
					options.onSuccess?.(data, scope.input, context, mutation);
			},
			onError: (error, scope, context, mutation) => {
				if (isCurrentGeneration(scope.generation))
					options.onError?.(error, scope.input, context, mutation);
			},
			onSettled: (data, error, scope, context, mutation) => {
				if (isCurrentGeneration(scope.generation))
					options.onSettled?.(data, error, scope.input, context, mutation);
			},
		}
	);
}

/** Capture identity at the gesture, abort on replacement, and never fill the full cache. */
export function useUpdateRuntimeSettings() {
	const qc = useQueryClient();
	const mutation = useMutation<RuntimeSettings, Error, Scope, void>({
		onMutate: async ({ generation }) => {
			await qc.cancelQueries({ queryKey: runtimeSettingsQueryKey(generation), exact: true });
		},
		mutationFn: async ({ input, generation }) => {
			const auth = getAuthSnapshot();
			if (!auth.hasToken || auth.generation !== generation)
				throw new DOMException("Session changed", "AbortError");
			const controller = new AbortController();
			const off = subscribeAuth(() => {
				if (!isCurrentGeneration(generation)) controller.abort();
			});
			try {
				const data = await api.updateRuntimeSettings(input, { signal: controller.signal });
				if (!isCurrentGeneration(generation) || controller.signal.aborted)
					throw new DOMException("Session changed", "AbortError");
				return data;
			} finally {
				off();
			}
		},
		onSuccess: async (data, { generation }) => {
			if (!isCurrentGeneration(generation)) return;
			const queryKey = runtimeSettingsQueryKey(generation);
			await qc.cancelQueries({ queryKey, exact: true });
			if (!isCurrentGeneration(generation)) return;
			qc.setQueryData(queryKey, data);
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["settings"] }),
				qc.invalidateQueries({ queryKey: ["model-catalog", "runtime", generation] }),
				qc.invalidateQueries({ queryKey: ["model-catalog", "options", generation] }),
			]);
		},
	});
	return {
		...mutation,
		variables: mutation.variables?.input,
		mutate: (input: Input, options?: Options) =>
			mutation.mutate({ input, generation: getAuthSnapshot().generation }, scopedOptions(options)),
		mutateAsync: (input: Input, options?: Options) =>
			mutation.mutateAsync(
				{ input, generation: getAuthSnapshot().generation },
				scopedOptions(options),
			),
	};
}
