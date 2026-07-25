import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizePluginList, pluginsApi } from "../lib/api/plugins";

const PLUGINS_QUERY_GC_TIME_MS = 60_000;
const PLUGIN_DIAGNOSTICS_REFETCH_INTERVAL_MS = 5_000;

export const pluginKeys = {
	all: ["plugins"] as const,
	detail: (pluginId: string) => ["plugins", pluginId] as const,
	diagnostics: (pluginId: string) => ["plugins", pluginId, "diagnostics"] as const,
	uiContributions: ["plugins", "ui-contributions"] as const,
	uiHealth: ["plugins", "ui-health"] as const,
	themes: ["plugins", "themes"] as const,
	availableThemes: ["plugins", "available-themes"] as const,
};

/**
 * Invalidate every plugin-scoped query after a lifecycle mutation.
 * Also drops UI contribution/health snapshots so runtime surfaces resync.
 * Exported for mutation wiring tests.
 */
export function invalidatePluginQueries(qc: {
	invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
}): void {
	void qc.invalidateQueries({ queryKey: pluginKeys.all });
	void qc.invalidateQueries({ queryKey: pluginKeys.uiContributions });
	void qc.invalidateQueries({ queryKey: pluginKeys.uiHealth });
}

function useInvalidatePlugins() {
	const qc = useQueryClient();
	return () => invalidatePluginQueries(qc);
}

export function usePlugins(options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: pluginKeys.all,
		queryFn: pluginsApi.list,
		select: normalizePluginList,
		enabled: options?.enabled ?? true,
		gcTime: PLUGINS_QUERY_GC_TIME_MS,
		retry: (failureCount, error) => {
			// 503 PLUGINS_DISABLED is a steady state, not a transient failure.
			if ((error as { status?: number }).status === 503) return false;
			return failureCount < 2;
		},
	});
}

export function usePlugin(pluginId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: pluginKeys.detail(pluginId),
		queryFn: () => pluginsApi.get(pluginId),
		enabled: (options?.enabled ?? true) && pluginId.length > 0,
		gcTime: PLUGINS_QUERY_GC_TIME_MS,
	});
}

/**
 * Diagnostics are only fetched while the diagnostics tab is visible
 * (`enabled`), and only then poll at a bounded interval.
 */
export function usePluginDiagnostics(pluginId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: pluginKeys.diagnostics(pluginId),
		queryFn: () => pluginsApi.getDiagnostics(pluginId),
		enabled: (options?.enabled ?? true) && pluginId.length > 0,
		refetchInterval: PLUGIN_DIAGNOSTICS_REFETCH_INTERVAL_MS,
		gcTime: PLUGINS_QUERY_GC_TIME_MS,
	});
}

export function usePluginUiContributions(options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: pluginKeys.uiContributions,
		queryFn: pluginsApi.listUiContributions,
		enabled: options?.enabled ?? true,
		gcTime: PLUGINS_QUERY_GC_TIME_MS,
	});
}

export function usePluginUiHealth(options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: pluginKeys.uiHealth,
		queryFn: pluginsApi.getUiHealth,
		enabled: options?.enabled ?? true,
		gcTime: PLUGINS_QUERY_GC_TIME_MS,
	});
}

export function useInstallPlugin() {
	const invalidate = useInvalidatePlugins();
	return useMutation({
		mutationFn: (path: string) => pluginsApi.install(path),
		onSuccess: invalidate,
	});
}

export function useUploadPlugin() {
	const invalidate = useInvalidatePlugins();
	return useMutation({
		mutationFn: (input: { file: File; onProgress?: (fraction: number) => void }) =>
			pluginsApi.installUpload(input.file, { onProgress: input.onProgress }),
		onSuccess: invalidate,
	});
}

/** Installable package files already present under the server import roots. */
export function useInstallSources(enabled = true) {
	return useQuery({
		queryKey: ["plugins", "install-sources"] as const,
		queryFn: pluginsApi.listInstallSources,
		enabled,
		gcTime: 30_000,
		retry: (failureCount, error) => {
			if ((error as { status?: number }).status === 503) return false;
			return failureCount < 2;
		},
	});
}

export function useEnablePlugin() {
	const invalidate = useInvalidatePlugins();
	return useMutation({
		mutationFn: (pluginId: string) => pluginsApi.enable(pluginId),
		onSuccess: invalidate,
	});
}

export function useDisablePlugin() {
	const invalidate = useInvalidatePlugins();
	return useMutation({
		mutationFn: (pluginId: string) => pluginsApi.disable(pluginId),
		onSuccess: invalidate,
	});
}

export function useActivatePlugin() {
	const invalidate = useInvalidatePlugins();
	return useMutation({
		mutationFn: (pluginId: string) => pluginsApi.activate(pluginId),
		onSuccess: invalidate,
	});
}

export function useRetryPlugin() {
	const invalidate = useInvalidatePlugins();
	return useMutation({
		mutationFn: (pluginId: string) => pluginsApi.retry(pluginId),
		onSuccess: invalidate,
	});
}

export function useUninstallPlugin() {
	const invalidate = useInvalidatePlugins();
	return useMutation({
		mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
		onSuccess: invalidate,
	});
}
