import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const MCP_SERVERS_QUERY_GC_TIME_MS = 60_000;

export function useMcpServers() {
	return useQuery({
		queryKey: ["mcp-servers"],
		queryFn: api.mcpListServers,
		select: (data) => data.servers,
		gcTime: MCP_SERVERS_QUERY_GC_TIME_MS,
	});
}

export function useCreateMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpCreateServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
	});
}

interface McpServersCache {
	servers: Array<Record<string, unknown> & { id: string }>;
}

type McpUpdateVariables = { id: string } & Record<string, unknown>;

type McpToolPermissionPatch = {
	toolName: string;
	behavior?: string | null;
	enabled?: boolean;
};

function isMcpToolPermissionPatch(value: unknown): value is McpToolPermissionPatch {
	return (
		typeof value === "object" &&
		value !== null &&
		"toolName" in value &&
		typeof value.toolName === "string"
	);
}

function applyToolPermissionPatch(
	current: unknown,
	patch: McpToolPermissionPatch,
): Array<Record<string, unknown> & { toolName: string }> {
	const next = Array.isArray(current)
		? current
				.filter(
					(rule): rule is Record<string, unknown> & { toolName: string } =>
						typeof rule === "object" && rule !== null && typeof rule.toolName === "string",
				)
				.map((rule) => ({ ...rule }))
		: [];
	const idx = next.findIndex((rule) => rule.toolName === patch.toolName);
	if (patch.behavior === null || patch.behavior === "") {
		if (idx >= 0) next.splice(idx, 1);
		return next;
	}
	if (patch.behavior === undefined) {
		if (idx >= 0 && patch.enabled !== undefined) {
			next[idx] = { ...next[idx], enabled: patch.enabled };
		}
		return next;
	}
	const nextRule = {
		...(idx >= 0 ? next[idx] : {}),
		toolName: patch.toolName,
		behavior: patch.behavior,
		...(patch.enabled !== undefined && { enabled: patch.enabled }),
	};
	if (idx >= 0) {
		next[idx] = nextRule;
	} else {
		next.push(nextRule);
	}
	return next;
}

function applyMcpServerPatch(
	server: Record<string, unknown> & { id: string },
	patch: Record<string, unknown>,
): Record<string, unknown> & { id: string } {
	const { toolPermissionPatch, ...rest } = patch;
	const next = { ...server, ...rest };
	if (Object.hasOwn(patch, "defaultBehavior") && patch.defaultBehavior == null) {
		delete next.defaultBehavior;
	}
	if (isMcpToolPermissionPatch(toolPermissionPatch)) {
		next.toolPermissions = applyToolPermissionPatch(next.toolPermissions, toolPermissionPatch);
	}
	return next;
}

export function useUpdateMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: McpUpdateVariables) => api.mcpUpdateServer(id, data),
		onMutate: async ({ id, ...data }) => {
			await qc.cancelQueries({ queryKey: ["mcp-servers"] });
			const previous = qc.getQueryData<McpServersCache>(["mcp-servers"]);
			qc.setQueryData<McpServersCache>(["mcp-servers"], (old) =>
				old
					? {
							...old,
							servers: old.servers.map((server) =>
								server.id === id ? applyMcpServerPatch(server, data) : server,
							),
						}
					: old,
			);
			return { previous };
		},
		onError: (_err, _variables, context) => {
			if (context?.previous) qc.setQueryData(["mcp-servers"], context.previous);
		},
		onSuccess: (updated, variables) => {
			qc.setQueryData<McpServersCache>(["mcp-servers"], (old) =>
				old
					? {
							...old,
							servers: old.servers.map((server) =>
								server.id === variables.id ? applyMcpServerPatch(server, updated) : server,
							),
						}
					: old,
			);
			qc.invalidateQueries({ queryKey: ["mcp-servers"] });
		},
	});
}

export function useDeleteMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpDeleteServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
	});
}

export function useConnectMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpConnectServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
	});
}

export function useDisconnectMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpDisconnectServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
	});
}

export function useTestMcpConnection() {
	return useMutation({
		mutationFn: api.mcpTestConnection,
	});
}

export function useImportMcpServers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpImportServers,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
	});
}
