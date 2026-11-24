import { applyMcpLoadingPatch } from "@shared/mcp-loading-mode";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../lib/api";
import i18n from "../lib/i18n";
import { reportMutationError } from "../lib/query-client";

const MCP_SERVERS_QUERY_GC_TIME_MS = 60_000;

export function useMcpServers(options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: ["mcp-servers"],
		queryFn: api.mcpListServers,
		select: (data) => data.servers,
		enabled: options?.enabled ?? true,
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
	if (patch.mode !== undefined || patch.enabled !== undefined) {
		Object.assign(
			next,
			applyMcpLoadingPatch(
				{ mode: server.mode, enabled: server.enabled },
				{ mode: patch.mode, enabled: patch.enabled },
			),
		);
	}
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
		onError: (err, _variables, context) => {
			if (context?.previous) qc.setQueryData(["mcp-servers"], context.previous);
			// See useFavoriteDirectories: the rollback alone left the switch flipping
			// back on its own with nothing said.
			reportMutationError(err);
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

/**
 * Authorize a remote MCP server via OAuth. The window is opened synchronously in
 * the click so popup blockers allow it, then pointed at the authorization URL;
 * the server list refreshes once the window closes.
 */
export function useAuthorizeMcpServer() {
	const qc = useQueryClient();
	const mutation = useMutation({
		mutationFn: api.mcpStartOAuth,
		onError: (err) => reportMutationError(err),
	});
	const { mutate } = mutation;
	const authorize = useCallback(
		(id: string) => {
			const popup = window.open("about:blank", "_blank");
			if (popup) popup.opener = null;
			const refresh = () => qc.invalidateQueries({ queryKey: ["mcp-servers"] });
			mutate(id, {
				onSuccess: (result) => {
					if (!("authorizationUrl" in result)) {
						popup?.close();
						void refresh();
						return;
					}
					if (!popup) {
						window.location.assign(result.authorizationUrl);
						return;
					}
					popup.location.href = result.authorizationUrl;
					const timer = window.setInterval(() => {
						if (!popup.closed) return;
						window.clearInterval(timer);
						void refresh();
					}, 1000);
				},
				onError: () => popup?.close(),
			});
		},
		[mutate, qc],
	);
	return { authorize, isPending: mutation.isPending, pendingId: mutation.variables };
}

export function useSignOutMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpSignOutOAuth,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
		onError: (err) => reportMutationError(err),
	});
}

export function useRefreshMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpRefreshServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
		// Refresh failure has to surface: the button would otherwise look like a
		// no-op while the tool list stayed stale (the whole point of the action).
		onError: (err) => reportMutationError(err),
	});
}

export function useRefreshAllMcpServers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpRefreshAllServers,
		onSuccess: (data) => {
			const failures = data.results.filter((result) => !result.ok);
			if (failures.length)
				reportMutationError(
					new Error(
						i18n.t("routines:mcpRefreshPartialFailure", {
							count: failures.length,
							names: failures.map((result) => result.name).join(", "),
						}),
					),
				);
			return qc.invalidateQueries({ queryKey: ["mcp-servers"] });
		},
		onError: (err) => reportMutationError(err),
	});
}

export function useTestMcpConnection() {
	return useMutation({
		mutationFn: ({ id, data }: { id?: string; data: Record<string, unknown> }) =>
			id ? api.mcpTestExistingServer(id, data) : api.mcpTestConnection(data),
	});
}

export function useImportMcpServers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpImportServers,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
	});
}
