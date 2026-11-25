import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { normalizeNamedSuggestionQuery } from "@shared/named-narrator-suggestions";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { getToken, onTokenChange } from "../lib/api/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";

export const namedSuggestionsQueryKey = ["named-narrator-suggestions"] as const;
export const NAMED_SUGGESTIONS_DEBOUNCE_MS = 175;
let sessionSnapshot = { token: null as string | null, generation: 0 };
function readSession() {
	const token = getToken();
	if (token !== sessionSnapshot.token)
		sessionSnapshot = { token, generation: sessionSnapshot.generation + 1 };
	return sessionSnapshot;
}

function subscribeSession(changed: () => void) {
	const offToken = onTokenChange(changed);
	const storageChanged = (event: StorageEvent) => {
		if (event.key === "narrafork_token" || event.key === null) changed();
	};
	if (typeof window !== "undefined") window.addEventListener("storage", storageChanged);
	return () => {
		offToken();
		if (typeof window !== "undefined") window.removeEventListener("storage", storageChanged);
	};
}

const listeners = new WeakMap<QueryClient, { users: number; dispose: () => void }>();
function retainListener(client: QueryClient) {
	let entry = listeners.get(client);
	if (!entry) {
		// Reset drops no-longer-authorized cached rows immediately and cancels old reads.
		const reset = () => void client.resetQueries({ queryKey: namedSuggestionsQueryKey });
		const handle = narratorWSManager.addListener(
			{
				types: [
					"narrator_access_changed",
					"project_access_changed",
					"project_deleted",
					"narrator_deleted",
					"narrators_deleted",
					"title_updated",
					"status_change",
				],
			},
			reset,
		);
		const off = narratorWSManager.onConnectionChange((connected) => {
			if (connected) reset();
		});
		const offRecovery = narratorWSManager.onControlPlaneRecovery(reset);
		entry = {
			users: 0,
			dispose: () => {
				narratorWSManager.removeListener(handle);
				off();
				offRecovery();
			},
		};
		listeners.set(client, entry);
	}
	entry.users++;
	return () => {
		if (--entry.users === 0) {
			entry.dispose();
			listeners.delete(client);
		}
	};
}

/** Caller must explicitly gate visibility, focus, mention mode and history/command mode. */
export function useNamedNarratorSuggestions(query: string | null, enabled: boolean) {
	const session = useSyncExternalStore(subscribeSession, readSession, readSession);
	const client = useQueryClient();
	const q = query === null ? null : normalizeNamedSuggestionQuery(query);
	const active = enabled && !REMOTE_BUILD && !!session.token && q !== null;
	const input = useMemo(
		() => ({ q, generation: session.generation, active }),
		[q, session.generation, active],
	);
	const [debounced, setDebounced] = useState<typeof input | null>(null);
	useEffect(() => {
		if (!input.active) {
			setDebounced(null);
			return;
		}
		const timer = setTimeout(() => setDebounced(input), NAMED_SUGGESTIONS_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [input]);
	// Keep cache invalidation while closed, without a room/narrator subscription or GET.
	const listen = !REMOTE_BUILD && !!session.token;
	useEffect(() => (listen ? retainListener(client) : undefined), [client, listen]);
	const ready = active && debounced === input;
	const result = useQuery({
		// Switch away immediately, not after debounce: the former observer detaches,
		// aborting its fetch. Closed consumers never keep a request alive.
		queryKey: [...namedSuggestionsQueryKey, session.generation, active ? q : null],
		queryFn: async ({ signal }) => {
			if (getToken() !== session.token) throw new DOMException("Session changed", "AbortError");
			const page = await api.listNamedNarratorSuggestions({ q: q ?? "" }, { signal });
			if (getToken() !== session.token || signal.aborted)
				throw new DOMException("Session changed", "AbortError");
			return page;
		},
		enabled: ready,
		staleTime: 30_000,
		gcTime: 60_000,
		retry: false,
		placeholderData: undefined,
	});
	return { ...result, data: ready && !result.isError ? result.data : undefined };
}
