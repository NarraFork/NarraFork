import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";

const PROJECT_QUERY_GC_TIME_MS = 60_000;

export const PROJECT_CREATE_REFRESH_QUERY_KEYS = [["projects"]] as const;

export const PROJECT_DELETE_REFRESH_QUERY_KEYS = [
	["projects"],
	["user-preferences", "recent-tabs"],
] as const;

type ProjectRefreshInvalidator = {
	invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

type RecentTabLike = {
	type?: unknown;
	id?: unknown;
};

export function invalidateProjectCreateQueries(queryClient: ProjectRefreshInvalidator) {
	for (const queryKey of PROJECT_CREATE_REFRESH_QUERY_KEYS) {
		queryClient.invalidateQueries({ queryKey });
	}
}

export function invalidateProjectDeleteQueries(queryClient: ProjectRefreshInvalidator) {
	for (const queryKey of PROJECT_DELETE_REFRESH_QUERY_KEYS) {
		queryClient.invalidateQueries({ queryKey });
	}
}

export function recentTabsSnapshotRemovedProject(
	previousTabs: readonly RecentTabLike[],
	nextTabs: readonly RecentTabLike[],
): boolean {
	const nextProjectIds = new Set(
		nextTabs
			.filter((tab) => tab.type === "project" && typeof tab.id === "string")
			.map((tab) => tab.id),
	);
	return previousTabs.some(
		(tab) => tab.type === "project" && typeof tab.id === "string" && !nextProjectIds.has(tab.id),
	);
}

export function useProjects(status?: string) {
	return useQuery({
		queryKey: ["projects", { status }],
		queryFn: () => api.listProjects(status),
		gcTime: PROJECT_QUERY_GC_TIME_MS,
	});
}

/**
 * Whether projects exist that this user cannot see — used to pick the right empty state.
 *
 * Gated on `enabled` so it only runs when the visible list is actually empty: on a
 * populated dashboard the answer is irrelevant, and the probe should not be paid for.
 */
export function useHiddenProjectExistence(enabled: boolean) {
	return useQuery({
		queryKey: ["projects", "hidden-existence"],
		queryFn: () => api.getHiddenProjectExistence(),
		enabled,
		gcTime: PROJECT_QUERY_GC_TIME_MS,
	});
}

export function useProject(id: string) {
	return useQuery({
		queryKey: ["projects", id],
		queryFn: () => api.getProject(id),
		enabled: !!id,
		gcTime: PROJECT_QUERY_GC_TIME_MS,
	});
}

export function useCreateProject() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.createProject,
		onSuccess: () => invalidateProjectCreateQueries(qc),
	});
}

/**
 * Create a project with clone mode — streams git clone progress.
 * Returns mutation-like state plus `cloneProgress` string.
 */
export function useCreateProjectStream() {
	const qc = useQueryClient();
	const [isPending, setIsPending] = useState(false);
	const [cloneProgress, setCloneProgress] = useState("");
	const [error, setError] = useState<Error | null>(null);
	const [needsAuth, setNeedsAuth] = useState(false);
	const lastDataRef = useRef<Record<string, unknown> | null>(null);
	const callbackRef = useRef<{
		onSuccess?: () => void;
		onError?: (err: Error) => void;
	}>({});

	const mutate = useCallback(
		(
			data: Record<string, unknown>,
			opts?: { onSuccess?: () => void; onError?: (err: Error) => void },
		) => {
			callbackRef.current = opts ?? {};
			lastDataRef.current = data;
			setIsPending(true);
			setCloneProgress("");
			setError(null);
			setNeedsAuth(false);

			api
				.createProjectStream(
					data,
					(message) => {
						setCloneProgress(message);
					},
					() => {
						setNeedsAuth(true);
					},
				)
				.then(() => {
					setIsPending(false);
					invalidateProjectCreateQueries(qc);
					callbackRef.current.onSuccess?.();
				})
				.catch((err) => {
					setIsPending(false);
					setError(err);
					callbackRef.current.onError?.(err);
				});
		},
		[qc],
	);

	const retryWithCredentials = useCallback(
		(username: string, password: string) => {
			if (!lastDataRef.current) return;
			const data = {
				...lastDataRef.current,
				cloneUsername: username,
				clonePassword: password,
			};
			mutate(data, callbackRef.current);
		},
		[mutate],
	);

	const reset = useCallback(() => {
		setCloneProgress("");
		setError(null);
		setNeedsAuth(false);
		lastDataRef.current = null;
	}, []);

	return { mutate, isPending, cloneProgress, error, needsAuth, retryWithCredentials, reset };
}

export function useUpdateProject() {
	const qc = useQueryClient();
	return useMutation({
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		mutationFn: ({ id, data }: { id: string; data: any }) => api.updateProject(id, data),
		onSuccess: (_, { id }) => {
			qc.invalidateQueries({ queryKey: ["projects"] });
			qc.invalidateQueries({ queryKey: ["projects", id] });
		},
	});
}

export function useDeleteProject() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteProject,
		onSuccess: () => invalidateProjectDeleteQueries(qc),
	});
}
