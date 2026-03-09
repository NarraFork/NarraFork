import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useMcpServers() {
	return useQuery({
		queryKey: ["mcp-servers"],
		queryFn: api.mcpListServers,
		select: (data) => data.servers,
	});
}

export function useCreateMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mcpCreateServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
	});
}

export function useUpdateMcpServer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
			api.mcpUpdateServer(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
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
