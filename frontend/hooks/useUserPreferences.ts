import {
	APPEARANCE_KEYS,
	type AppearancePreferenceKey,
	appearanceDefinition,
} from "@shared/appearance-preferences";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { getToken, onTokenChange } from "../lib/api/client";
import {
	appearanceStore,
	subscribeAppearancePreferences,
} from "../lib/appearance-preference-store";
import { useCurrentUser } from "./useCurrentUser";

const sessionObservers = new WeakMap<QueryClient, { count: number; stop: () => void }>();
function observeSession(qc: QueryClient) {
	let observer = sessionObservers.get(qc);
	if (!observer) {
		const reset = () => {
			qc.removeQueries({ queryKey: ["user-preferences"] });
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

export function useUserPreferences() {
	const qc = useQueryClient();
	const { data: user } = useCurrentUser();
	const token = getToken();
	const revision = useSyncExternalStore(
		subscribeAppearancePreferences,
		appearanceStore.getSnapshot,
		() => 0,
	);
	const query = useQuery({
		queryKey: ["user-preferences"],
		queryFn: api.getUserPreferences,
		enabled: !!token,
		staleTime: 60_000,
	});
	useEffect(() => observeSession(qc), [qc]);
	useEffect(() => {
		if (!user?.id || !token || getToken() !== token) return;
		// Load the identified user's local scopes immediately, even while GET is pending.
		appearanceStore.activate(user.id);
		if (!query.data) return;
		appearanceStore.hydrate(user.id, query.data, async (patch, signal) => {
			if (getToken() !== token || appearanceStore.getUserId() !== user.id)
				throw new Error("Session changed");
			// Do not let a GET begun before this edit restore an older account value.
			await qc.cancelQueries({ queryKey: ["user-preferences"], exact: true });
			if (getToken() !== token || appearanceStore.getUserId() !== user.id)
				throw new Error("Session changed");
			const result = await api.updateUserPreferences(patch, {
				signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
			});
			if (getToken() === token && appearanceStore.getUserId() === user.id) {
				void qc.invalidateQueries({ queryKey: ["user-preferences"], exact: true });
			}
			return result;
		});
	}, [qc, user?.id, query.data, token]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision is the subscription version of the external values projected here.
	const data = useMemo(() => {
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
		// The external store version invalidates the effective projection, not the raw query cache.
	}, [query.data, user?.id, revision]);
	return { ...query, data };
}

export function useUpdateUserPreferences() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (patch: Parameters<typeof api.updateUserPreferences>[0]) => {
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
			const remaining = appearanceStore.splitPatch(patch);
			const result = Object.keys(remaining).length
				? await api.updateUserPreferences(remaining)
				: undefined;
			if (writesSyncedAppearance) {
				await appearanceStore.flush();
				if (appearanceStore.error) throw appearanceStore.error;
			}
			return result;
		},
		onSuccess: (result) => {
			if (result !== undefined) qc.invalidateQueries({ queryKey: ["user-preferences"] });
		},
	});
}
