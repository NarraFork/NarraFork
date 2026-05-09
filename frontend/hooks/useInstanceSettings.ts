import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ensurePrefix } from "../components/providers/types";
import type { SubagentAllowedModels } from "../components/settings/ModelsSection";
import { api } from "../lib/api";
import { normalizeProxyUrl } from "../lib/proxy";

export interface InstanceSettingsState {
	// Server
	port: number | undefined;
	host: string;
	openBrowser: string;
	projectDir: string;
	// TLS
	tlsEnabled: boolean;
	tlsCertFile: string;
	tlsKeyFile: string;
	tlsPassphrase: string;
	tlsCaFile: string;
	// Update
	updateServerUrl: string;
	updateChannel: "stable" | "beta";
	updateAutoDownload: boolean;
	// Agent / Models
	defaultModel: string;
	permissionMode: string;
	summaryModel: string;
	maxTurns: number;
	subagentExploreModel: string;
	subagentPlanModel: string;
	subagentAllowedModels: SubagentAllowedModels;
	legacyEncoding: boolean;
	freshShellEnv: boolean;
	translateReasoning: boolean;
	requestDumpEnabled: boolean;
	defaultStartInPlanMode: boolean;
	defaultRelaxedPlan: boolean;
	planReflectionAutoApprove: boolean;
	dangerReflectionEnabled: boolean;
	dangerSkipReadOnlyConfirmations: boolean;
	maxTransientRetries: number;
	silentToolCallThreshold: number;
	retryBackoffCeilMs: number;
	firstTokenTimeoutMs: number;
	customRetryRules: Array<{
		id: string;
		domain?: string;
		statusCode?: number;
		keyword?: string;
		enabled?: boolean;
		note?: string;
	}>;
	contextThresholds: {
		standard: { pruneStart: number; compactStart: number };
		large: { pruneStart: number; compactStart: number };
	};
	autoCompactKeepPairs: number;
	codexDefaultReasoningEffort: string;
	agentDefaultReasoningEffort: string;
	globalWhitelistDirs: Array<{ path: string; accessLevel: string; enabled?: boolean }>;
	globalBlacklistDirs: Array<{ path: string; denyLevel: string; enabled?: boolean }>;
	globalCommandWhitelist: Array<{ pattern: string; enabled?: boolean }>;
	globalCommandBlacklist: Array<{ pattern: string; denyPrompt?: string; enabled?: boolean }>;
	webFetchProxyMode: string;
	webFetchProxyUrl: string;
	// Chapters
	maxWorktrees: number;
	maxContainers: number;
	sizeWarning: number;
	autoSave: boolean;
	dormantMinutes: number;
	// Containers
	portStart: number;
	portEnd: number;
	proxyEnabled: boolean;
	proxyPort: number;
}

type Setters = {
	[K in keyof InstanceSettingsState as `set${Capitalize<K>}`]: (
		v: InstanceSettingsState[K],
	) => void;
};

export interface UseInstanceSettingsReturn extends InstanceSettingsState, Setters {
	isDirty: boolean;
	isLoading: boolean;
	isSaving: boolean;
	initialized: boolean;
	settings: ReturnType<typeof api.getSettings> extends Promise<infer T> ? T : unknown;
	save: () => void;
	highlight: boolean;
}

function makeDefaults(): InstanceSettingsState {
	return {
		port: 7778,
		host: "localhost",
		openBrowser: "app",
		projectDir: "",
		tlsEnabled: false,
		tlsCertFile: "",
		tlsKeyFile: "",
		tlsPassphrase: "",
		tlsCaFile: "",
		updateServerUrl: "",
		updateChannel: "stable",
		updateAutoDownload: false,
		permissionMode: "acceptEdits",
		maxTurns: 200,
		subagentExploreModel: "",
		subagentPlanModel: "",
		subagentAllowedModels: { explore: [], plan: [], general: [] },
		legacyEncoding: false,
		freshShellEnv: false,
		translateReasoning: false,
		requestDumpEnabled: false,
		defaultStartInPlanMode: false,
		defaultRelaxedPlan: false,
		planReflectionAutoApprove: false,
		dangerReflectionEnabled: true,
		dangerSkipReadOnlyConfirmations: false,
		maxTransientRetries: 10,
		silentToolCallThreshold: 20,
		retryBackoffCeilMs: 20000,
		firstTokenTimeoutMs: 60000,
		customRetryRules: [],
		contextThresholds: {
			standard: { pruneStart: 95, compactStart: 99 },
			large: { pruneStart: 95, compactStart: 99 },
		},
		autoCompactKeepPairs: 2,
		codexDefaultReasoningEffort: "high",
		agentDefaultReasoningEffort: "",
		globalWhitelistDirs: [],
		globalBlacklistDirs: [],
		globalCommandWhitelist: [],
		globalCommandBlacklist: [],
		webFetchProxyMode: "system",
		webFetchProxyUrl: "",
		maxWorktrees: 10,
		maxContainers: 5,
		sizeWarning: 500,
		autoSave: true,
		dormantMinutes: 0,
		portStart: 10000,
		portEnd: 20000,
		proxyEnabled: false,
		proxyPort: 7780,
	};
}

export function useInstanceSettings(): UseInstanceSettingsReturn {
	const { data: settings, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const qc = useQueryClient();
	const updateSettings = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
	});

	const [state, setState] = useState<InstanceSettingsState>(makeDefaults);
	const [initialized, setInitialized] = useState(false);
	const [highlight, setHighlight] = useState(false);
	const prevDirty = useRef(false);
	const serverSnapshot = useRef<InstanceSettingsState>(makeDefaults());

	useEffect(() => {
		if (settings && !initialized) {
			const snap: InstanceSettingsState = {
				port: settings.server?.port ?? 7778,
				host: settings.server?.host ?? "localhost",
				openBrowser: settings.server?.openBrowser ?? "app",
				projectDir: settings.paths?.defaultProjectDir ?? "",
				tlsEnabled: settings.server?.tls?.enabled ?? false,
				tlsCertFile: settings.server?.tls?.certFile ?? "",
				tlsKeyFile: settings.server?.tls?.keyFile ?? "",
				tlsPassphrase: "",
				tlsCaFile: settings.server?.tls?.caFile ?? "",
				updateServerUrl: settings.update?.serverUrl ?? "",
				updateChannel: settings.update?.channel ?? "stable",
				updateAutoDownload: settings.update?.autoDownload ?? false,
				permissionMode: settings.agent?.defaultPermissionMode ?? "default",
				defaultStartInPlanMode: settings.agent?.defaultStartInPlanMode ?? false,
				maxTurns: settings.agent?.maxTurns ?? 200,
				subagentExploreModel: ensurePrefix(settings.agent?.subagentModels?.explore ?? ""),
				subagentPlanModel: ensurePrefix(settings.agent?.subagentModels?.plan ?? ""),
				subagentAllowedModels: {
					explore: settings.agent?.subagentAllowedModels?.explore ?? [],
					plan: settings.agent?.subagentAllowedModels?.plan ?? [],
					general: settings.agent?.subagentAllowedModels?.general ?? [],
				},
				legacyEncoding: settings.agent?.legacyEncoding ?? false,
				freshShellEnv: settings.agent?.freshShellEnv ?? false,
				translateReasoning: settings.agent?.translateReasoning ?? false,
				requestDumpEnabled: settings.agent?.requestDumpEnabled ?? false,
				defaultRelaxedPlan: settings.agent?.defaultRelaxedPlan ?? false,
				planReflectionAutoApprove: settings.agent?.planReflectionAutoApprove ?? false,
				dangerReflectionEnabled: settings.agent?.dangerReflectionEnabled ?? true,
				dangerSkipReadOnlyConfirmations: settings.agent?.dangerSkipReadOnlyConfirmations ?? false,
				maxTransientRetries: settings.agent?.maxTransientRetries ?? 10,
				silentToolCallThreshold: settings.agent?.silentToolCallThreshold ?? 20,
				retryBackoffCeilMs: settings.agent?.retryBackoffCeilMs ?? 20000,
				firstTokenTimeoutMs: settings.agent?.firstTokenTimeoutMs ?? 60000,
				customRetryRules: settings.agent?.customRetryRules ?? [],
				contextThresholds: settings.agent?.contextThresholds ?? {
					standard: { pruneStart: 95, compactStart: 99 },
					large: { pruneStart: 95, compactStart: 99 },
				},
				autoCompactKeepPairs: settings.agent?.autoCompactKeepPairs ?? 2,
				codexDefaultReasoningEffort: settings.codex?.defaultReasoningEffort ?? "",
				agentDefaultReasoningEffort: settings.agent?.defaultReasoningEffort ?? "",
				globalWhitelistDirs: settings.agent?.whitelistDirs ?? [],
				globalBlacklistDirs: settings.agent?.blacklistDirs ?? [],
				globalCommandWhitelist: settings.agent?.commandWhitelist ?? [],
				globalCommandBlacklist: settings.agent?.commandBlacklist ?? [],
				webFetchProxyMode: settings.agent?.webFetchPolicy?.proxy?.mode ?? "system",
				webFetchProxyUrl: settings.agent?.webFetchPolicy?.proxy?.url ?? "",
				maxWorktrees: settings.chapters?.maxActiveWorktrees ?? 10,
				maxContainers: settings.chapters?.maxActiveContainers ?? 5,
				sizeWarning: settings.chapters?.worktreeSizeWarningMb ?? 500,
				autoSave: settings.chapters?.autoSaveOnDormant ?? true,
				dormantMinutes: settings.chapters?.dormantAfterMinutes ?? 0,
				portStart: settings.containers?.portRangeStart ?? 10000,
				portEnd: settings.containers?.portRangeEnd ?? 20000,
				proxyEnabled: settings.containers?.proxy?.enabled ?? false,
				proxyPort: settings.containers?.proxy?.port ?? 7780,
			};
			serverSnapshot.current = snap;
			setState(snap);
			setInitialized(true);
		}
	}, [settings, initialized]);

	const isDirty = useMemo(() => {
		if (!initialized) return false;
		const s = serverSnapshot.current;
		return JSON.stringify(state) !== JSON.stringify(s);
	}, [initialized, state]);

	// Trigger highlight animation when transitioning from clean to dirty
	useEffect(() => {
		if (isDirty && !prevDirty.current) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
		prevDirty.current = isDirty;
	}, [isDirty]);

	const save = () => {
		const normalizedWebFetchProxyUrl = normalizeProxyUrl(state.webFetchProxyUrl) ?? "";
		const normalizedState = { ...state, webFetchProxyUrl: normalizedWebFetchProxyUrl };
		updateSettings.mutate(
			{
				server: {
					port: state.port,
					host: state.host,
					openBrowser: state.openBrowser,
					tls: {
						enabled: state.tlsEnabled,
						certFile: state.tlsCertFile,
						keyFile: state.tlsKeyFile,
						...(state.tlsPassphrase && { passphrase: state.tlsPassphrase }),
						...(state.tlsCaFile && { caFile: state.tlsCaFile }),
					},
				},
				paths: { defaultProjectDir: state.projectDir },
				agent: {
					defaultModel: state.defaultModel,
					defaultPermissionMode: state.permissionMode,
					summaryModel: state.summaryModel,
					maxTurns: state.maxTurns,
					subagentModels: {
						explore: state.subagentExploreModel,
						plan: state.subagentPlanModel,
					},
					subagentAllowedModels: state.subagentAllowedModels,
					legacyEncoding: state.legacyEncoding,
					freshShellEnv: state.freshShellEnv,
					translateReasoning: state.translateReasoning,
					requestDumpEnabled: state.requestDumpEnabled,
					defaultStartInPlanMode: state.defaultStartInPlanMode,
					defaultRelaxedPlan: state.defaultRelaxedPlan,
					planReflectionAutoApprove: state.planReflectionAutoApprove,
					dangerReflectionEnabled: state.dangerReflectionEnabled,
					dangerSkipReadOnlyConfirmations: state.dangerSkipReadOnlyConfirmations,
					defaultReasoningEffort:
						(state.agentDefaultReasoningEffort as "none" | "low" | "medium" | "high" | "xhigh") ||
						undefined,
					maxTransientRetries: state.maxTransientRetries,
					silentToolCallThreshold: state.silentToolCallThreshold,
					retryBackoffCeilMs: state.retryBackoffCeilMs,
					firstTokenTimeoutMs: state.firstTokenTimeoutMs,
					customRetryRules: state.customRetryRules,
					contextThresholds: state.contextThresholds,
					autoCompactKeepPairs: state.autoCompactKeepPairs,
					whitelistDirs: state.globalWhitelistDirs,
					blacklistDirs: state.globalBlacklistDirs,
					commandWhitelist: state.globalCommandWhitelist,
					commandBlacklist: state.globalCommandBlacklist,
					webFetchPolicy: {
						proxy: {
							mode: state.webFetchProxyMode as "direct" | "system" | "custom",
							...(state.webFetchProxyMode === "custom" && normalizedWebFetchProxyUrl
								? { url: normalizedWebFetchProxyUrl }
								: {}),
						},
					},
				},
				chapters: {
					maxActiveWorktrees: state.maxWorktrees,
					maxActiveContainers: state.maxContainers,
					worktreeSizeWarningMb: state.sizeWarning,
					autoSaveOnDormant: state.autoSave,
					dormantAfterMinutes: state.dormantMinutes,
				},
				containers: {
					portRangeStart: state.portStart,
					portRangeEnd: state.portEnd,
					proxy: {
						enabled: state.proxyEnabled,
						port: state.proxyPort,
					},
				},
				editor: { type: "vscode" },
				codex: {
					defaultReasoningEffort:
						(state.codexDefaultReasoningEffort as "none" | "low" | "medium" | "high" | "xhigh") ||
						null,
				},
				update: {
					serverUrl: state.updateServerUrl || undefined,
					channel: state.updateChannel,
					autoDownload: state.updateAutoDownload,
				},
			},
			{
				onSuccess: (data) => {
					serverSnapshot.current = normalizedState;
					setState(normalizedState);
					const resp = data as { serverRestarting?: boolean; newUrl?: string };
					if (resp.serverRestarting && resp.newUrl) {
						setTimeout(() => {
							window.location.href = resp.newUrl as string;
						}, 1000);
					}
				},
			},
		);
	};

	// Build setters dynamically
	const setters = useMemo(() => {
		const result: Record<string, (v: unknown) => void> = {};
		for (const key of Object.keys(makeDefaults())) {
			const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
			result[setterName] = (v: unknown) => setState((prev) => ({ ...prev, [key]: v }));
		}
		return result;
	}, []);

	return {
		...state,
		...setters,
		isDirty,
		isLoading,
		isSaving: updateSettings.isPending,
		initialized,
		settings,
		save,
		highlight,
	} as unknown as UseInstanceSettingsReturn;
}

// --- Context-based singleton for settings layout ---

const InstanceSettingsContext = createContext<UseInstanceSettingsReturn | null>(null);

export const InstanceSettingsProvider = InstanceSettingsContext.Provider;

/**
 * Consume the shared instance settings from the nearest Provider.
 * Must be called inside `<InstanceSettingsProvider>` (i.e. under the settings layout).
 */
export function useInstanceSettingsContext(): UseInstanceSettingsReturn {
	const ctx = useContext(InstanceSettingsContext);
	if (!ctx) {
		throw new Error("useInstanceSettingsContext must be used within InstanceSettingsProvider");
	}
	return ctx;
}
