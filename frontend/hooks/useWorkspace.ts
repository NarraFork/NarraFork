import type { WorkspacePanelInput } from "@shared/workspace-panels";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

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
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string; title: string }) => api.updateWorkspace(id, data),
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
