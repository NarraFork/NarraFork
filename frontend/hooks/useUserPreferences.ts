import {
	APPEARANCE_KEYS,
	type AppearancePreferenceKey,
	appearanceDefinition,
} from "@shared/appearance-preferences";
import {
	type MutateOptions,
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import {
	type AuthSnapshot,
	getAuthSnapshot,
	onTokenChange,
	subscribeAuth,
} from "../lib/api/client";
import type { UIPreferencesPatch } from "../lib/api/settings";
import {
	appearanceStore,
	subscribeAppearancePreferences,
} from "../lib/appearance-preference-store";
import { useCurrentUser } from "./useCurrentUser";
import { invalidateFastModeDetails } from "./useFastModeUpdates";

export const userPreferencesQueryKey = (
	view: "ui" | "detail",
	{ userId, generation }: Pick<AuthSnapshot, "userId" | "generation"> = getAuthSnapshot(),
) => ["user-preferences", view, userId, generation] as const;

function matchesSession(userId: string | null, generation: number): boolean {
	const current = getAuthSnapshot();
	return (
		current.hasToken && !!userId && current.userId === userId && current.generation === generation
	);
}

export function isUserPreferencesScopeCurrent(
	key: ReturnType<typeof userPreferencesQueryKey>,
): boolean {
	return matchesSession(key[2], key[3]);
}

function requireSession(userId: string | null, generation: number): void {
	if (!matchesSession(userId, generation)) throw new DOMException("Session changed", "AbortError");
}

async function readPreferences<T>(
	userId: string | null,
	generation: number,
	signal: AbortSignal,
	read: (options: { signal: AbortSignal }) => Promise<T>,
): Promise<T> {
	requireSession(userId, generation);
	const result = await read({ signal });
	signal.throwIfAborted();
	requireSession(userId, generation);
	return result;
}

function preferenceProjections(auth: Pick<AuthSnapshot, "userId" | "generation">) {
	return (["ui", "detail"] as const).map((view) => ({
		queryKey: userPreferencesQueryKey(view, auth),
		exact: true,
	}));
}

const sessionObservers = new WeakMap<QueryClient, { count: number; stop: () => void }>();
function observeSession(qc: QueryClient) {
	let observer = sessionObservers.get(qc);
	if (!observer) {
		const stop = onTokenChange(() => {
			void qc.cancelQueries({ queryKey: ["user-preferences"] });
			qc.removeQueries({ queryKey: ["user-preferences"] });
			// useCurrentUser owns the active me observer and its generation reset.
			appearanceStore.activate(null, true);
		});
		observer = { count: 0, stop };
		sessionObservers.set(qc, observer);
	}
	observer.count++;
	return () => {
		if (!observer || --observer.count !== 0) return;
		observer.stop();
		sessionObservers.delete(qc);
	};
}

/** Shared by all lightweight observers, including plugin overlays. */
export function useUserPreferences(options: { enabled?: boolean } = {}) {
	const qc = useQueryClient();
	useCurrentUser();
	const auth = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);
	const { userId, generation } = auth;
	const queryKey = userPreferencesQueryKey("ui", auth);
	const revision = useSyncExternalStore(
		subscribeAppearancePreferences,
		appearanceStore.getSnapshot,
		() => 0,
	);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => readPreferences(userId, generation, signal, api.getUIPreferences),
		enabled: options.enabled !== false && auth.hasToken && !!userId,
		staleTime: 30_000,
		placeholderData: undefined,
	});
	useEffect(() => observeSession(qc), [qc]);
	useEffect(() => {
		if (!userId || !matchesSession(userId, generation)) return;
		appearanceStore.activate(userId);
		if (!query.data) return;
		const projections = preferenceProjections(auth);
		appearanceStore.hydrate(userId, { ...query.data }, async (patch, signal) => {
			requireSession(userId, generation);
			await Promise.all(projections.map((filter) => qc.cancelQueries(filter)));
			requireSession(userId, generation);
			const result = await api.updateUIPreferences(patch, {
				signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
			});
			if (matchesSession(userId, generation) && appearanceStore.getUserId() === userId) {
				for (const filter of projections) void qc.invalidateQueries(filter);
			}
			return result;
		});
	}, [qc, auth, userId, generation, query.data]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision tracks the external appearance values.
	const data = useMemo(() => {
		if (!matchesSession(userId, generation)) return undefined;
		if (!query.data || appearanceStore.getUserId() !== userId || !appearanceStore.ready)
			return query.data;
		const effective = { ...query.data };
		for (const key of APPEARANCE_KEYS) {
			const def = appearanceDefinition(key);
			if (def.field && def.customizable) {
				Object.assign(effective, { [def.field]: appearanceStore.get(key) });
			}
		}
		return effective;
	}, [query.data, userId, generation, revision]);
	return { ...query, data, queryKey };
}

/** Settings editors must load the complete DTO before saving fields absent from the UI view. */
export function useUserPreferencesDetail() {
	const ui = useUserPreferences();
	const [, , userId, generation] = ui.queryKey;
	const query = useQuery({
		queryKey: userPreferencesQueryKey("detail", { userId, generation }),
		queryFn: ({ signal }) => readPreferences(userId, generation, signal, api.getUserPreferences),
		enabled: !!userId,
		staleTime: 30_000,
		placeholderData: undefined,
	});
	const data = useMemo(() => {
		if (!matchesSession(userId, generation) || !query.data) return undefined;
		const effective = { ...query.data };
		if (ui.data) {
			for (const key of APPEARANCE_KEYS) {
				const def = appearanceDefinition(key);
				if (def.field && def.customizable) {
					Object.assign(effective, { [def.field]: ui.data[def.field as keyof typeof ui.data] });
				}
			}
		}
		return effective;
	}, [query.data, ui.data, userId, generation]);
	return { ...query, data };
}

function useUpdatePreferences<Patch extends Parameters<typeof api.updateUserPreferences>[0]>(
	write: (patch: Patch, options: { signal: AbortSignal }) => Promise<unknown>,
) {
	const qc = useQueryClient();
	useEffect(() => observeSession(qc), [qc]);
	const mutation = useMutation({
		mutationFn: async ({ patch, auth }: { patch: Patch; auth: AuthSnapshot }) => {
			const { userId, generation } = auth;
			requireSession(userId, generation);
			const controller = new AbortController();
			const off = subscribeAuth(() => {
				if (!matchesSession(userId, generation)) {
					controller.abort(new DOMException("Session changed", "AbortError"));
				}
			});
			try {
				let writesSyncedAppearance = false;
				for (const key of Object.keys(patch)) {
					const def = appearanceDefinition(key);
					if (!def?.field || !def.customizable) continue;
					const synced = appearanceStore.isSynced(key as AppearancePreferenceKey);
					if (!appearanceStore.ready && (!appearanceStore.getUserId() || synced)) {
						throw new Error("Appearance preferences are not ready");
					}
					writesSyncedAppearance ||= synced;
				}
				const remaining = appearanceStore.splitPatch(patch) as Patch;
				const result = Object.keys(remaining).length
					? await write(remaining, { signal: controller.signal })
					: undefined;
				controller.signal.throwIfAborted();
				requireSession(userId, generation);
				if (writesSyncedAppearance) {
					await appearanceStore.flush();
					requireSession(userId, generation);
					if (appearanceStore.error) throw appearanceStore.error;
				}
				return result;
			} finally {
				off();
			}
		},
		onSuccess: (result, { patch, auth }) => {
			if (!matchesSession(auth.userId, auth.generation)) return;
			if (result !== undefined) {
				for (const filter of preferenceProjections(auth)) void qc.invalidateQueries(filter);
			}
			if (typeof patch.fastModeDefault === "boolean") void invalidateFastModeDetails(qc);
		},
	});
	const { mutate, mutateAsync } = mutation;
	const withScope = useCallback(
		(patch: Patch, options?: MutateOptions<unknown, Error, Patch>) =>
			mutate({ patch, auth: getAuthSnapshot() }, scopedMutationCallbacks(options)),
		[mutate],
	);
	const withScopeAsync = useCallback(
		(patch: Patch, options?: MutateOptions<unknown, Error, Patch>) =>
			mutateAsync({ patch, auth: getAuthSnapshot() }, scopedMutationCallbacks(options)),
		[mutateAsync],
	);
	const callbacks = { mutate: withScope, mutateAsync: withScopeAsync };
	return mutation.status === "idle"
		? { ...mutation, ...callbacks, variables: undefined }
		: { ...mutation, ...callbacks, variables: mutation.variables.patch };
}

function scopedMutationCallbacks<Patch>(options?: MutateOptions<unknown, Error, Patch>) {
	if (!options) return undefined;
	const scoped: MutateOptions<unknown, Error, { patch: Patch; auth: AuthSnapshot }> = {
		onSuccess: (data, { patch, auth }, value, context) => {
			if (matchesSession(auth.userId, auth.generation))
				options.onSuccess?.(data, patch, value, context);
		},
		onError: (error, { patch, auth }, value, context) => {
			if (matchesSession(auth.userId, auth.generation))
				options.onError?.(error, patch, value, context);
		},
		onSettled: (data, error, { patch, auth }, value, context) => {
			if (matchesSession(auth.userId, auth.generation))
				options.onSettled?.(data, error, patch, value, context);
		},
	};
	return scoped;
}

export function useUpdateUserPreferences() {
	return useUpdatePreferences<UIPreferencesPatch>(api.updateUIPreferences);
}

export function useUpdateUserPreferencesDetail() {
	return useUpdatePreferences(api.updateUserPreferences);
}
