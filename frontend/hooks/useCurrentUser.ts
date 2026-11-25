import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { type ApiError, getAuthSnapshot, subscribeAuth } from "../lib/api/client";
import { clearCurrentUserCache, readCurrentUserCache } from "../lib/current-user-cache";

const meFilter = { queryKey: ["auth", "me"], exact: true };
const clients = new WeakMap<
	QueryClient,
	{ generation: number; count: number; stop?: () => void }
>();

function getClientState(qc: QueryClient, generation: number) {
	let state = clients.get(qc);
	if (!state) {
		state = { generation, count: 0 };
		clients.set(qc, state);
	}
	return state;
}

function observeCurrentUser(qc: QueryClient) {
	const state = getClientState(qc, getAuthSnapshot().generation);
	if (state.count++ === 0) {
		const refresh = () => {
			const { generation, hasToken } = getAuthSnapshot();
			if (state.generation === generation) return;
			state.generation = generation;
			// Reset in place so mounted observers keep their query and cancel old work.
			qc.getQueryCache().find(meFilter)?.reset();
			if (hasToken) void qc.refetchQueries({ ...meFilter, type: "active" });
		};
		state.stop = subscribeAuth(refresh);
		refresh();
	}
	return () => {
		if (--state.count !== 0) return;
		state.stop?.();
		state.stop = undefined;
	};
}

/** Seed the public query with a profile returned as part of a successful login. */
export function seedCurrentUser(
	qc: QueryClient,
	generation: number,
	user: Awaited<ReturnType<typeof api.me>>,
): void {
	getClientState(qc, generation).generation = generation;
	void qc.cancelQueries(meFilter);
	qc.setQueryData(meFilter.queryKey, user);
}

/** Read-only identity query: no login flows or language initialization dependencies. */
export function useCurrentUser() {
	const qc = useQueryClient();
	const auth = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);
	const query = useQuery({
		queryKey: meFilter.queryKey,
		queryFn: async ({ signal }) => {
			const { generation } = getAuthSnapshot();
			try {
				const user = await api.me({ signal });
				signal.throwIfAborted();
				if (getAuthSnapshot().generation !== generation) {
					throw new DOMException("Session changed", "AbortError");
				}
				return user;
			} catch (error) {
				if ((error as ApiError)?.status === 401 && getAuthSnapshot().generation === generation) {
					clearCurrentUserCache();
				}
				throw error;
			}
		},
		enabled: auth.hasToken,
		// A persisted profile can paint the initial shell without becoming auth evidence
		// (or being restored as initial query data during a credential change).
		placeholderData: () => (auth.hasToken ? readCurrentUserCache() : undefined),
		refetchOnMount: auth.userId ? true : "always",
		retry: (failureCount, error) => {
			// 401 = token invalid/expired; 404 = user deleted while token still valid.
			const status = (error as ApiError)?.status;
			if (status === 401 || status === 404) return false;
			return failureCount < 3;
		},
		staleTime: 30_000,
	});
	useEffect(() => observeCurrentUser(qc), [qc]);
	return query;
}
