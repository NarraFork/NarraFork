import {
	APPEARANCE_KEYS,
	type AppearancePreferenceKey,
	appearanceDefinition,
} from "@shared/appearance-preferences";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { getToken, onTokenChange } from "../lib/api/client";
import type { UIPreferencesPatch } from "../lib/api/settings";
import {
	appearanceStore,
	subscribeAppearancePreferences,
} from "../lib/appearance-preference-store";
import { useCurrentUser } from "./useCurrentUser";
import { invalidateFastModeDetails } from "./useFastModeUpdates";

const sessionObservers = new WeakMap<QueryClient, { count: number; stop: () => void }>();
function observeSession(qc: QueryClient) {
	let observer = sessionObservers.get(qc);
	if (!observer) {
		const reset = () => {
			void qc.cancelQueries({ queryKey: ["user-preferences"] });
			qc.removeQueries({ queryKey: ["user-preferences"] });
			void qc.cancelQueries({ queryKey: ["auth", "me"], exact: true });
			qc.removeQueries({ queryKey: ["auth", "me"], exact: true });
			appearanceStore.activate(null, true);
		};
		const offToken = onTokenChange(reset);
		const onStorage = (event: StorageEvent) => {
			if (event.key === "narrafork_token" || event.key === null) reset();
		};
		if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
		observer = {
			count: 0,
			stop: () => {
				offToken();
				if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
			},
		};
		sessionObservers.set(qc, observer);
	}
	observer.count++;
	return () => {
		if (!observer || --observer.count !== 0) return;
		observer.stop();
		sessionObservers.delete(qc);
	};
}

function subscribeSession(listener: () => void) {
	const off = onTokenChange(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key === "narrafork_token" || event.key === null) listener();
	};
	if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
	return () => {
		off();
		if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
	};
}

/** Shared by all lightweight observers, including plugin overlays. */
export function useUserPreferences(options: { enabled?: boolean } = {}) {
	const qc = useQueryClient();
	const token = useSyncExternalStore(subscribeSession, getToken, () => null);
	const { data: user } = useCurrentUser();
	const queryKey = ["user-preferences", "ui", user?.id ?? null, token] as const;
	const revision = useSyncExternalStore(
		subscribeAppearancePreferences,
		appearanceStore.getSnapshot,
		() => 0,
	);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => api.getUIPreferences({ signal }),
		enabled: options.enabled !== false && !!token && !!user?.id,
		staleTime: 30_000,
		placeholderData: undefined,
	});
	useEffect(() => observeSession(qc), [qc]);
	useEffect(() => {
		if (!user?.id || !token || getToken() !== token) return;
		appearanceStore.activate(user.id);
		if (!query.data) return;
		appearanceStore.hydrate(user.id, { ...query.data }, async (patch, signal) => {
			if (getToken() !== token || appearanceStore.getUserId() !== user.id)
				throw new Error("Session changed");
			await qc.cancelQueries({ queryKey: ["user-preferences"] });
			if (getToken() !== token || appearanceStore.getUserId() !== user.id)
				throw new Error("Session changed");
			const result = await api.updateUIPreferences(patch, { signal });
			if (getToken() === token && appearanceStore.getUserId() === user.id) {
				void qc.invalidateQueries({ queryKey: ["user-preferences"] });
			}
			return result;
		});
	}, [qc, user?.id, query.data, token]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision tracks the external appearance values.
	const data = useMemo(() => {
		if (!token || getToken() !== token) return undefined;
		if (
			!query.data ||
			!user?.id ||
			appearanceStore.getUserId() !== user.id ||
			!appearanceStore.ready
		)
			return query.data;
		const effective = { ...query.data };
		for (const key of APPEARANCE_KEYS) {
			const def = appearanceDefinition(key);
			if (def.field && def.customizable) {
				Object.assign(effective, { [def.field]: appearanceStore.get(key) });
			}
		}
		return effective;
	}, [query.data, user?.id, revision, token]);
	return { ...query, data, queryKey };
}

/** Settings editors must load the complete DTO before saving fields absent from the UI view. */
export function useUserPreferencesDetail() {
	const ui = useUserPreferences();
	const [, , principal, token] = ui.queryKey;
	const query = useQuery({
		queryKey: ["user-preferences", "detail", principal, token],
		queryFn: ({ signal }) => api.getUserPreferences({ signal }),
		enabled: !!principal && !!token,
		staleTime: 30_000,
		placeholderData: undefined,
	});
	// UI hydration is authoritative for account/local appearance scopes. Never merge
	// lightweight responses into the complete query cache.
	const data = useMemo(() => {
		if (!token || getToken() !== token || !query.data) return undefined;
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
	}, [query.data, ui.data, token]);
	return { ...query, data };
}

function useUpdatePreferences<Patch extends Parameters<typeof api.updateUserPreferences>[0]>(
	write: (patch: Patch, options: { signal: AbortSignal }) => Promise<unknown>,
) {
	const qc = useQueryClient();
	useEffect(() => observeSession(qc), [qc]);
	return useMutation({
		onMutate: () => ({ token: getToken() }),
		mutationFn: async (patch: Patch) => {
			const token = getToken();
			const controller = new AbortController();
			const off = subscribeSession(() => {
				if (getToken() !== token) controller.abort(new Error("Session changed"));
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
				if (getToken() !== token) throw new Error("Session changed");
				if (writesSyncedAppearance) {
					await appearanceStore.flush();
					if (appearanceStore.error) throw appearanceStore.error;
				}
				return result;
			} finally {
				off();
			}
		},
		onSuccess: (result, variables, context) => {
			if (getToken() !== context?.token) return;
			if (result !== undefined) void qc.invalidateQueries({ queryKey: ["user-preferences"] });
			if (typeof variables.fastModeDefault === "boolean") {
				void invalidateFastModeDetails(qc);
			}
		},
	});
}

export function useUpdateUserPreferences() {
	return useUpdatePreferences<UIPreferencesPatch>(api.updateUIPreferences);
}

export function useUpdateUserPreferencesDetail() {
	return useUpdatePreferences(api.updateUserPreferences);
}
