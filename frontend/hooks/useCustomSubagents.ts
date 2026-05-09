import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const CUSTOM_SUBAGENT_QUERY_GC_TIME_MS = 60_000;

export interface CustomSubagentDef {
	name: string;
	description: string;
	toolAccess: string;
	customTools: string[];
	defaultModel: string;
	prompt: string;
}

export function useCustomSubagents() {
	return useQuery({
		queryKey: ["custom-subagents"],
		queryFn: () => api.listCustomSubagents(),
		gcTime: CUSTOM_SUBAGENT_QUERY_GC_TIME_MS,
	});
}

export function useCustomSubagent(name: string, enabled = true) {
	return useQuery({
		queryKey: ["custom-subagent", name],
		queryFn: () => api.getCustomSubagent(name),
		enabled: !!name && enabled,
		gcTime: CUSTOM_SUBAGENT_QUERY_GC_TIME_MS,
	});
}

export function useCreateCustomSubagent() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: CustomSubagentDef) => api.createCustomSubagent(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["custom-subagents"] });
		},
	});
}

export function useUpdateCustomSubagent() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ currentName, ...data }: CustomSubagentDef & { currentName: string }) =>
			api.updateCustomSubagent(currentName, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["custom-subagents"] });
			qc.invalidateQueries({ queryKey: ["custom-subagent"] });
		},
	});
}

export function useDeleteCustomSubagent() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api.deleteCustomSubagent(name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["custom-subagents"] });
		},
	});
}
