/**
 * The import of a session's Dynamic Spec into the outline, for the Spec panel's banner (outline
 * P2 PR 12b): its state, and "Import now". Read only while the outline is switched on (its routes
 * answer 404 otherwise). While an import runs the state is read again every couple of seconds;
 * when the session was moved the server says so (`spec_changed`, source `import`) and the panel
 * becomes the task board through the task queries, which listen to the same event.
 */
import type { OutlineSpecImportStatus } from "@shared/outline-spec-import";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useOutlineEnabledInCache } from "./useOutlineEnabled";

export const specImportKey = (narratorId: string) => ["spec-import", narratorId] as const;

/** How often a running import's state is read again. */
const RUNNING_REFETCH_MS = 2000;

export function useSpecImportStatus(narratorId: string) {
	const enabled = useOutlineEnabledInCache();
	const queryClient = useQueryClient();
	useEffect(() => {
		if (!narratorId || !enabled) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["spec_changed"] },
			(data) => {
				// Moved by an import, or back by an administrator (12b2).
				if (data.source !== "import" && data.source !== "revert") return;
				void queryClient.invalidateQueries({ queryKey: specImportKey(narratorId) });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, enabled, queryClient]);
	return useQuery({
		queryKey: specImportKey(narratorId),
		queryFn: () => api.getSpecImportStatus(narratorId),
		enabled: !!narratorId && enabled,
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.state === "running" ? RUNNING_REFETCH_MS : false,
	});
}

export function useStartSpecImport(narratorId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.startSpecImport(narratorId),
		onSuccess: (status: OutlineSpecImportStatus) => {
			queryClient.setQueryData(specImportKey(narratorId), status);
		},
	});
}
