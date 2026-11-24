import type { SwitchWorkingDirectoryRequest, WorkspaceContext } from "@shared/workspace-context";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { type ListenerHandle, narratorWSManager } from "../lib/narrator-ws-manager";

export const workspaceContextKey = (id: string) => ["workspaceContext", id] as const;
const transitionKey = (id: string) => ["workspaceContextTransition", id] as const;

/** Minimum authoritative identity required before choosing any device-specific path. */
export function isWorkspaceContextIdentity(value: unknown): value is WorkspaceContext {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const context = value as Partial<WorkspaceContext>;
	return (
		typeof context.deviceId === "string" &&
		context.deviceId.trim().length > 0 &&
		typeof context.contextKey === "string" &&
		context.contextKey.trim().length > 0 &&
		Number.isSafeInteger(context.revision) &&
		(context.revision as number) >= 0
	);
}

/** Read again at an action boundary; a callback may predate a switch's React render. */
export function currentWorkspaceContext(qc: QueryClient, narratorId: string) {
	if (qc.getQueryData(transitionKey(narratorId)) === true) return undefined;
	const context = qc.getQueryData<WorkspaceContext>(workspaceContextKey(narratorId));
	return isWorkspaceContextIdentity(context) ? context : undefined;
}

export function workspaceFileTarget(context: WorkspaceContext | undefined) {
	return isWorkspaceContextIdentity(context) && context.cwd
		? { deviceId: context.deviceId, cwd: context.cwd }
		: null;
}

/** Do not let an old read or out-of-order WS notification undo a completed switch. */
export function latestWorkspaceContext(
	previous: WorkspaceContext | undefined,
	incoming: WorkspaceContext,
): WorkspaceContext {
	if (!isWorkspaceContextIdentity(incoming)) throw new Error("Invalid workspace context identity");
	return isWorkspaceContextIdentity(previous) && previous.revision > incoming.revision
		? previous
		: incoming;
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
				if (isWorkspaceContextIdentity(context)) {
					const previous = qc.getQueryData<WorkspaceContext>(workspaceContextKey(narratorId));
					if (isWorkspaceContextIdentity(previous) && context.revision < previous.revision) return;
					applyWorkspaceContext(qc, narratorId, context);
					if (!isWorkspaceContextIdentity(previous) || context.revision > previous.revision)
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
		// Context switches still cancel reads and invalidate immediately; duplicate observers reuse a recent revision.
		staleTime: 5_000,
	});
	return {
		...query,
		data: transition.data || !isWorkspaceContextIdentity(query.data) ? undefined : query.data,
		transitioning: transition.data === true,
	};
}

async function beginWorkspaceTransition(qc: QueryClient, narratorId: string) {
	qc.setQueryData(transitionKey(narratorId), true);
	await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
}

async function finishWorkspaceTransition(
	qc: QueryClient,
	narratorId: string,
	context?: WorkspaceContext,
) {
	await qc.cancelQueries({ queryKey: workspaceContextKey(narratorId) });
	const incoming = context ?? (await api.getWorkspaceContext(narratorId));
	applyWorkspaceContext(qc, narratorId, incoming);
	qc.setQueryData(transitionKey(narratorId), false);
}

async function recoverWorkspaceTransition(qc: QueryClient, narratorId: string) {
	// An uncertain response may still have switched. Only an authoritative read
	// or a valid newer context event can release the transition.
	try {
		await finishWorkspaceTransition(qc, narratorId);
	} catch {
		/* Keep the old cached device unavailable. */
	}
}

/** HTTP device selection and model SwitchDevice share the server's revisioned context. */
export function useUpdateExecutionDevice(narratorId: string, onError?: (error: Error) => void) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (deviceId: string | null) => api.updateNarratorDefaultDevice(narratorId, deviceId),
		retry: false,
		onMutate: () => beginWorkspaceTransition(qc, narratorId),
		onSuccess: (result) => finishWorkspaceTransition(qc, narratorId, result.current),
		onError: async (error) => {
			await recoverWorkspaceTransition(qc, narratorId);
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
		onMutate: () => beginWorkspaceTransition(qc, narratorId),
		onSuccess: ({ current }) => finishWorkspaceTransition(qc, narratorId, current),
		onError: () => recoverWorkspaceTransition(qc, narratorId),
		onSettled: () => {
			void qc.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
		},
	});
}

export const workspaceDevicesKey = (projectId?: string | null) =>
	["workspaceDevices", projectId ?? null] as const;
/**
 * The device a switch refused for lack of a working directory, or null.
 *
 * The device picker already knows which devices are configured, so this is the
 * backstop for a stale client: instead of a red toast, the caller opens the same
 * "set this device's directory" dialog.
 */
export function workspaceDirectoryRequiredDeviceId(error: unknown): string | null {
	const body = (error as { data?: unknown } | null)?.data;
	if (!body || typeof body !== "object") return null;
	const payload = body as { code?: unknown; details?: unknown };
	if (payload.code !== "WORKSPACE_DIRECTORY_REQUIRED") return null;
	const details = payload.details;
	if (!details || typeof details !== "object") return null;
	const deviceId = (details as { deviceId?: unknown }).deviceId;
	return typeof deviceId === "string" && deviceId.trim() ? deviceId : null;
} /**
 * Devices a session can be created on.
 *
 * Separate from the per-narrator list because creation needs it before the narrator
 * exists; the server authorizes it against the caller's own device visibility.
 */
export function useWorkspaceDevices(projectId?: string | null, enabled = true) {
	return useQuery({
		queryKey: workspaceDevicesKey(projectId),
		queryFn: () => api.getWorkspaceDevices(projectId),
		enabled,
		// Device connectivity changes slowly; the picker is opened on demand.
		staleTime: 15_000,
	});
}
