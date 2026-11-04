import type { WorkspaceChangedEvent } from "@shared/workspace-events";
import type { WorkspacePanelInput } from "@shared/workspace-panels";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const WORKSPACE_QUERY_GC_TIME_MS = 60_000;

export const workspaceQueryKey = (id: string) => ["workspace", id] as const;

/**
 * One workspace, including its authoritative membership.
 *
 * Membership arrives with the workspace rather than from a second request so a caller
 * can never render the arrangement before knowing which panels exist — deriving the
 * panel set from the layout is exactly what let a narrator be listed in the sidebar
 * while nothing rendered.
 */
export function useWorkspace(id: string) {
	return useQuery({
		queryKey: workspaceQueryKey(id),
		queryFn: () => api.getWorkspace(id),
		enabled: !!id,
		gcTime: WORKSPACE_QUERY_GC_TIME_MS,
	});
}

/**
 * Keep a mounted workspace view in step with writes from OTHER devices.
 *
 * The server broadcasts `workspace_changed` after every layout save, membership
 * change and rename; without this listener the view only converged on a window
 * refocus. The event is an invalidation signal — the refetch itself decides how
 * to adopt the new state (see `decideSurfaceRefresh`), so bursts during a drag
 * cost at most one in-flight GET each.
 *
 * Frames missed while the socket was down are recovered by invalidating on
 * reconnect (the same reconciliation the recent-tabs subscription does).
 *
 * `deleted` is handled by the caller (it navigates away), not by an invalidate:
 * the re-fetch would 404 and strand the page on its loading state. The query is
 * still dropped here so a remount within `gcTime` cannot resurrect the deleted
 * workspace from cache; the active observer may fire one 404 refetch in the
 * meantime, which the navigation makes moot.
 */
export function useWorkspaceChangeSync(
	workspaceId: string,
	onDeleted?: (workspaceId: string) => void,
) {
	const qc = useQueryClient();
	useEffect(() => {
		const handle = narratorWSManager.addListener({ types: ["workspace_changed"] }, (frame) => {
			const event = frame as unknown as WorkspaceChangedEvent;
			if (event.workspaceId !== workspaceId) return;
			if (event.reason === "deleted") {
				qc.removeQueries({ queryKey: workspaceQueryKey(workspaceId) });
				onDeleted?.(workspaceId);
				return;
			}
			void qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
		});
		const offConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) {
				void qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
			}
		});
		return () => {
			narratorWSManager.removeListener(handle);
			offConnection();
		};
	}, [qc, workspaceId, onDeleted]);
}

export function useCreateWorkspace() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { title?: string; tree: string }) => api.createWorkspace(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["workspaces"] });
		},
	});
}

/**
 * Rename a workspace. Title only — the layout is written by `saveWorkspaceLayout`,
 * which guards it with `expectedRevision`; this route does not, so accepting a layout
 * here would silently bypass that lock.
 */
export function useUpdateWorkspace() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string; title: string }) => api.updateWorkspace(id, data),
		// The header switcher lists workspaces by title.
		onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
	});
}

export function useDeleteWorkspace() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteWorkspace(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["workspaces"] });
		},
	});
}

/**
 * Add a panel to a workspace.
 *
 * The membership write is what must succeed FIRST; the caller reflects it in the
 * dockview surface only afterwards. The reverse order is what produced the original
 * bug: a sidebar tab was persisted while the panel lived only in a client-side queue,
 * so any interruption left the two permanently out of step.
 */
export function useAddWorkspacePanel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ workspaceId, input }: { workspaceId: string; input: WorkspacePanelInput }) =>
			api.addWorkspacePanel(workspaceId, input),
		onSuccess: (_result, { workspaceId }) => {
			qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
		},
	});
}

export function useRemoveWorkspacePanel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ workspaceId, panelId }: { workspaceId: string; panelId: string }) =>
			api.removeWorkspacePanel(workspaceId, panelId),
		onSuccess: (_result, { workspaceId }) => {
			qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
		},
	});
}

export function useUpdateWorkspacePanelConfig() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			workspaceId,
			panelId,
			config,
		}: {
			workspaceId: string;
			panelId: string;
			config: unknown;
		}) => api.updateWorkspacePanelConfig(workspaceId, panelId, config),
		onSuccess: (_result, { workspaceId }) => {
			qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
		},
	});
}
