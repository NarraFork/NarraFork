import type { RuntimeSettings } from "@shared/settings-runtime";
import { type MutateOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getToken, onTokenChange } from "../lib/api/client";
import { RUNTIME_SETTINGS_QUERY_KEY } from "./useRuntimeSettings";

type Input = Record<string, unknown>;
type Scope = { input: Input; token: string | null };
type Options = MutateOptions<RuntimeSettings, Error, Input, void>;
function scopedOptions(
	options?: Options,
): MutateOptions<RuntimeSettings, Error, Scope, void> | undefined {
	return (
		options && {
			onSuccess: (data, scope, context, mutation) =>
				options.onSuccess?.(data, scope.input, context, mutation),
			onError: (error, scope, context, mutation) =>
				options.onError?.(error, scope.input, context, mutation),
			onSettled: (data, error, scope, context, mutation) =>
				options.onSettled?.(data, error, scope.input, context, mutation),
		}
	);
}

/** Capture identity at the gesture, abort on replacement, and never fill the full cache. */
export function useUpdateRuntimeSettings() {
	const qc = useQueryClient();
	const mutation = useMutation<RuntimeSettings, Error, Scope, void>({
		onMutate: async ({ token }) => {
			await qc.cancelQueries({ queryKey: [...RUNTIME_SETTINGS_QUERY_KEY, token] });
		},
		mutationFn: async ({ input, token }) => {
			if (!token || getToken() !== token) throw new DOMException("Session changed", "AbortError");
			const controller = new AbortController();
			const off = onTokenChange(() => controller.abort());
			try {
				const data = await api.updateRuntimeSettings(input, { signal: controller.signal });
				if (getToken() !== token || controller.signal.aborted)
					throw new DOMException("Session changed", "AbortError");
				return data;
			} finally {
				off();
			}
		},
		onSuccess: async (data, { token }) => {
			if (token !== getToken()) return;
			const queryKey = [...RUNTIME_SETTINGS_QUERY_KEY, token];
			await qc.cancelQueries({ queryKey });
			if (token !== getToken()) return;
			qc.setQueryData(queryKey, data);
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["settings"] }),
				qc.invalidateQueries({ queryKey: ["model-catalog", "runtime"] }),
				qc.invalidateQueries({ queryKey: ["model-catalog", "options"] }),
			]);
		},
	});
	return {
		...mutation,
		variables: mutation.variables?.input,
		mutate: (input: Input, options?: Options) =>
			mutation.mutate({ input, token: getToken() }, scopedOptions(options)),
		mutateAsync: (input: Input, options?: Options) =>
			mutation.mutateAsync({ input, token: getToken() }, scopedOptions(options)),
	};
}
