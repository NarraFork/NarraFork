import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";

const PROJECT_QUERY_GC_TIME_MS = 60_000;

export function useProjects(status?: string) {
	return useQuery({
		queryKey: ["projects", { status }],
		queryFn: () => api.listProjects(status),
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
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
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
					qc.invalidateQueries({ queryKey: ["projects"] });
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
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects"] });
			qc.invalidateQueries({ queryKey: ["user-preferences", "recent-tabs"] });
		},
	});
}
