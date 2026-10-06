import type { SwitchWorkingDirectoryRequest, WorkspaceContext } from "@shared/workspace-context";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { type ListenerHandle, narratorWSManager } from "../lib/narrator-ws-manager";

export const workspaceContextKey = (id: string) => ["workspaceContext", id] as const;
const transitionKey = (id: string) => ["workspaceContextTransition", id] as const;

export function workspaceFileTarget(context: WorkspaceContext | undefined) {
	return context?.deviceId && context.cwd ? { deviceId: context.deviceId, cwd: context.cwd } : null;
}

/** Do not let an old read or out-of-order WS notification undo a completed switch. */
export function latestWorkspaceContext(
	previous: WorkspaceContext | undefined,
	incoming: WorkspaceContext,
): WorkspaceContext {
	return previous && previous.revision > incoming.revision ? previous : incoming;
}

export function applyWorkspaceContext(qc: QueryClient, id: string, context: WorkspaceContext) {
	qc.setQueryData<WorkspaceContext>(workspaceContextKey(id), (old) =>
		latestWorkspaceContext(old, context),
	);
	void qc.invalidateQueries({ queryKey: ["narrators", id] });
	void qc.invalidateQueries({ queryKey: ["narratorExecutionDevices", id] });
	void qc.invalidateQueries({ queryKey: ["gitWorkspace", id] });
	if (context.git)
		void qc.invalidateQueries({
			predicate: (query) =>
				String(query.queryKey[0]).startsWith("git") &&
				query.queryKey[1] === context.git?.workspaceKey,
		});
	void qc.invalidateQueries({ queryKey: ["narratorWorktrees", id] });
	void qc.invalidateQueries({ queryKey: ["recentTabs"] });
}

const subscriptions = new WeakMap<
	QueryClient,
	Map<string, { count: number; handle: ListenerHandle }>
>();
function subscribeWorkspaceContext(qc: QueryClient, narratorId: string) {
	let clients = subscriptions.get(qc);
	if (!clients) {
		clients = new Map();
		subscriptions.set(qc, clients);
	}
	let entry = clients.get(narratorId);
	if (!entry) {
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["workspace_context_changed"] },
			(event) => {
				const context = event.current as WorkspaceContext | undefined;
				if (context?.contextKey && typeof context.revision === "number") {
					const previous = qc.getQueryData<WorkspaceContext>(workspaceContextKey(narratorId));
					if (previous && context.revision < previous.revision) return;
					applyWorkspaceContext(qc, narratorId, context);
					if (!previous || context.revision > previous.revision)
						qc.setQueryData(transitionKey(narratorId), false);
					void qc.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
				}
			},
		);
		entry = { count: 0, handle };
		clients.set(narratorId, entry);
	}
	entry.count++;
	return () => {
		if (--entry.count !== 0) return;
		narratorWSManager.removeListener(entry.handle);
		clients.delete(narratorId);
	};
}

export function useWorkspaceContext(narratorId: string) {
	const qc = useQueryClient();
	useEffect(
		() => (narratorId ? subscribeWorkspaceContext(qc, narratorId) : undefined),
		[qc, narratorId],
	);
	const transition = useQuery({
		queryKey: transitionKey(narratorId),
		queryFn: () => false,
		enabled: false,
	});
	const query = useQuery({
		queryKey: workspaceContextKey(narratorId),
		queryFn: async ({ signal }) => {
			const incoming = await api.getWorkspaceContext(narratorId, signal);
			return latestWorkspaceContext(qc.getQueryData(workspaceContextKey(narratorId)), incoming);
		},
		enabled: !!narratorId && !transition.data,
	});
	return {
		...query,
		data: transition.data ? undefined : query.data,
		transitioning: transition.data === true,
	};
}

/** HTTP device selection and model SwitchDevice share the server's revisioned context. */
export function useUpdateExecutionDevice(narratorId: string, onError?: (error: Error) => void) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (deviceId: string | null) => api.updateNarratorDefaultDevice(narratorId, deviceId),
		retry: false,
		onMutate: async () => {
			qc.setQueryData(transitionKey(narratorId), true);
			await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
		},
		onSuccess: async (result) => {
			await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
			const incoming = result.current ?? (await api.getWorkspaceContext(narratorId));
			applyWorkspaceContext(qc, narratorId, incoming);
			qc.setQueryData(transitionKey(narratorId), false);
		},
		onError: async (error) => {
			// A dropped HTTP response may still have switched. Re-enable only after
			// an authoritative read; never infer the device/cwd from the failed request.
			try {
				const incoming = await api.getWorkspaceContext(narratorId);
				applyWorkspaceContext(qc, narratorId, incoming);
				qc.setQueryData(transitionKey(narratorId), false);
			} catch {
				/* Fail closed until another successful selection/context event. */
			}
			onError?.(error);
		},
		onSettled: () => {
			void qc.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
			void qc.invalidateQueries({ queryKey: ["narratorExecutionDevices", narratorId] });
			void qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
		},
	});
}

export function useSwitchWorkspaceContext(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: SwitchWorkingDirectoryRequest) =>
			api.switchWorkspaceContext(narratorId, input),
		retry: false,
		onError: () => {
			void qc.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
		},
		onSuccess: async ({ current }) => {
			await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
			applyWorkspaceContext(qc, narratorId, current);
			void qc.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
		},
	});
}
