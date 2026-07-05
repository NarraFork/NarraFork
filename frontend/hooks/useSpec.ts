import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import type { SpecTasksResponse, SpecWriteResult } from "../lib/api/spec";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const SPEC_GC_TIME_MS = 60_000;

function specFilesKey(narratorId: string) {
	return ["narrators", narratorId, "spec", "files"] as const;
}

function specFileKey(narratorId: string, uri: string) {
	return ["narrators", narratorId, "spec", "file", uri] as const;
}

function specTasksKey(narratorId: string) {
	return ["narrators", narratorId, "spec", "tasks"] as const;
}

/** List all spec files (metadata only). */
export function useSpecFiles(narratorId: string) {
	const qc = useQueryClient();

	useEffect(() => {
		if (!narratorId) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["spec_changed"] },
			() => {
				qc.invalidateQueries({ queryKey: specFilesKey(narratorId) });
				qc.invalidateQueries({ queryKey: specTasksKey(narratorId) });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, qc]);

	return useQuery({
		queryKey: specFilesKey(narratorId),
		queryFn: () => api.listSpecFiles(narratorId),
		enabled: !!narratorId,
		gcTime: SPEC_GC_TIME_MS,
		select: (data) => data.files,
	});
}

/** Read a single spec file (with content). */
export function useSpecFile(narratorId: string, uri: string) {
	const qc = useQueryClient();

	useEffect(() => {
		if (!narratorId || !uri) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["spec_changed"] },
			(data) => {
				if (data.uri === uri || data.path === uri.replace("spec://", "")) {
					qc.invalidateQueries({ queryKey: specFileKey(narratorId, uri) });
				}
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, uri, qc]);

	return useQuery({
		queryKey: specFileKey(narratorId, uri),
		queryFn: () => api.readSpecFile(narratorId, uri),
		enabled: !!narratorId && !!uri,
		gcTime: SPEC_GC_TIME_MS,
	});
}

/** Read and compile tasks.json. */
export function useSpecTasks(narratorId: string) {
	const qc = useQueryClient();

	useEffect(() => {
		if (!narratorId) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["spec_changed"] },
			(data) => {
				if (data.path === "tasks.json") {
					qc.invalidateQueries({ queryKey: specTasksKey(narratorId) });
				}
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, qc]);

	return useQuery<SpecTasksResponse>({
		queryKey: specTasksKey(narratorId),
		queryFn: () => api.readSpecTasks(narratorId),
		enabled: !!narratorId,
		gcTime: SPEC_GC_TIME_MS,
	});
}

/** Write a spec file (returns mutation). */
export function useUpdateSpecFile(narratorId: string) {
	const qc = useQueryClient();
	return useMutation<
		SpecWriteResult,
		Error,
		{ uri: string; content: string; baseRevisionId?: string | null; notifyAgent?: boolean }
	>({
		mutationFn: (data) => api.writeSpecFile(narratorId, data),
		onSuccess: (_result, variables) => {
			qc.invalidateQueries({ queryKey: specFilesKey(narratorId) });
			qc.invalidateQueries({ queryKey: specFileKey(narratorId, variables.uri) });
			if (variables.uri.endsWith("tasks.json")) {
				qc.invalidateQueries({ queryKey: specTasksKey(narratorId) });
			}
		},
	});
}
