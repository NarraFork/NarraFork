import { notifications } from "@mantine/notifications";
import { cloneDefaultContextThresholds } from "@shared/context-thresholds";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ensurePrefix } from "../components/providers/types";
import type { SubagentAllowedModels } from "../components/settings/ModelsSection";
import { api } from "../lib/api";
import { normalizeUrlProtocol } from "../lib/url";

export type DangerReflectionLevel = "off" | "light" | "standard" | "strict";
export type AutoContinuationMode = "always" | "blockStop" | "protectedOnly" | "off";

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
	translationModel: string;
	maxTurns: number;
	subagentExploreModel: string;
	subagentPlanModel: string;
	subagentSearchModel: string;
	subagentReviewModel: string;
	subagentAllowedModels: SubagentAllowedModels;
	legacyEncoding: boolean;
	freshShellEnv: boolean;
	translateReasoning: boolean;
	requestDumpEnabled: boolean;
	requestDumpErrorsOnly: boolean;
	defaultStartInPlanMode: boolean;
	defaultRelaxedPlan: boolean;
	defaultPruneEnabled: boolean;
	planModeAllowInlinePlan: boolean;
	planReflectionAutoApprove: boolean;
	planReflectionAllowAutoCompact: boolean;
	questionReflectionEnabled: boolean;
	questionReflectionTimeoutMs: number;
	dangerReflectionLevel: DangerReflectionLevel;
	dangerReflectionEnabled: boolean;
	dangerSkipReadOnlyConfirmations: boolean;
	autoContinuationMode: AutoContinuationMode;
	maxTransientRetries: number;
	silentToolCallThreshold: number;
	pipelineUnusedToolCallThreshold: number;
	behaviorFenceInterval: number;
	tasksReminderInterval: number;
	behaviorFenceAttachTasks: boolean;
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
	autoCompactPruneThreshold: number;
	minPruneRatio: number;
	queueDuringCompaction: boolean;
	agentDefaultReasoningEffort: string;
	globalWhitelistDirs: Array<{ path: string; accessLevel: string; enabled?: boolean }>;
	globalBlacklistDirs: Array<{ path: string; denyLevel: string; enabled?: boolean }>;
	globalCommandWhitelist: Array<{ pattern: string; enabled?: boolean }>;
	globalCommandBlacklist: Array<{ pattern: string; denyPrompt?: string; enabled?: boolean }>;
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
		translationModel: "__summary__",
		maxTurns: 1000,
		subagentExploreModel: "",
		subagentPlanModel: "",
		subagentSearchModel: "",
		subagentReviewModel: "",
		subagentAllowedModels: { explore: [], plan: [], general: [], search: [], review: [] },
		legacyEncoding: false,
		freshShellEnv: false,
		translateReasoning: false,
		requestDumpEnabled: false,
		requestDumpErrorsOnly: false,
		defaultStartInPlanMode: false,
		defaultRelaxedPlan: false,
		defaultPruneEnabled: false,
		planModeAllowInlinePlan: true,
		planReflectionAutoApprove: false,
		planReflectionAllowAutoCompact: false,
		questionReflectionEnabled: false,
		questionReflectionTimeoutMs: 300000,
		dangerReflectionLevel: "standard",
		dangerReflectionEnabled: true,
		dangerSkipReadOnlyConfirmations: false,
		autoContinuationMode: "protectedOnly",
		maxTransientRetries: 10,
		silentToolCallThreshold: 20,
		pipelineUnusedToolCallThreshold: 10,
		behaviorFenceInterval: -1,
		tasksReminderInterval: 15,
		behaviorFenceAttachTasks: true,
		retryBackoffCeilMs: 20000,
		firstTokenTimeoutMs: 300000,
		customRetryRules: [],
		contextThresholds: cloneDefaultContextThresholds(),
		autoCompactKeepPairs: 2,
		autoCompactPruneThreshold: 80,
		minPruneRatio: 30,
		queueDuringCompaction: false,
		agentDefaultReasoningEffort: "",
		globalWhitelistDirs: [],
		globalBlacklistDirs: [],
		globalCommandWhitelist: [],
		globalCommandBlacklist: [],
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
	const { t } = useTranslation("settings");
	const { data: settings, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const qc = useQueryClient();
	const updateSettings = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => {
			// Use setQueryData to synchronously update the cache instead of
			// invalidateQueries which triggers cascading refetches.
			qc.setQueryData(["settings"], data);
		},
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
				translationModel: settings.agent?.translationModel?.startsWith("__")
					? settings.agent.translationModel
					: ensurePrefix(settings.agent?.translationModel ?? "__summary__"),
				maxTurns: settings.agent?.maxTurns ?? 1000,
				subagentExploreModel: ensurePrefix(settings.agent?.subagentModels?.explore ?? ""),
				subagentPlanModel: ensurePrefix(settings.agent?.subagentModels?.plan ?? ""),
				subagentSearchModel: ensurePrefix(settings.agent?.subagentModels?.search ?? ""),
				subagentReviewModel: ensurePrefix(settings.agent?.subagentModels?.review ?? ""),
				subagentAllowedModels: {
					explore: settings.agent?.subagentAllowedModels?.explore ?? [],
					plan: settings.agent?.subagentAllowedModels?.plan ?? [],
					general: settings.agent?.subagentAllowedModels?.general ?? [],
					search: settings.agent?.subagentAllowedModels?.search ?? [],
					review: settings.agent?.subagentAllowedModels?.review ?? [],
				},
				legacyEncoding: settings.agent?.legacyEncoding ?? false,
				freshShellEnv: settings.agent?.freshShellEnv ?? false,
				translateReasoning: settings.agent?.translateReasoning ?? false,
				requestDumpEnabled: settings.agent?.requestDumpEnabled ?? false,
				requestDumpErrorsOnly: settings.agent?.requestDumpErrorsOnly ?? false,
				defaultRelaxedPlan: settings.agent?.defaultRelaxedPlan ?? false,
				defaultPruneEnabled: settings.agent?.defaultPruneEnabled ?? false,
				planModeAllowInlinePlan: settings.agent?.planModeAllowInlinePlan ?? true,
				planReflectionAutoApprove: settings.agent?.planReflectionAutoApprove ?? false,
				planReflectionAllowAutoCompact: settings.agent?.planReflectionAllowAutoCompact ?? false,
				questionReflectionEnabled: settings.agent?.questionReflectionEnabled ?? false,
				questionReflectionTimeoutMs: settings.agent?.questionReflectionTimeoutMs ?? 300000,
				dangerReflectionLevel:
					(settings.agent?.dangerReflectionLevel as DangerReflectionLevel | undefined) ??
					(settings.agent?.dangerReflectionEnabled === false ? "off" : "standard"),
				dangerReflectionEnabled: settings.agent?.dangerReflectionEnabled ?? true,
				dangerSkipReadOnlyConfirmations: settings.agent?.dangerSkipReadOnlyConfirmations ?? false,
				autoContinuationMode:
					(settings.agent?.autoContinuationMode as AutoContinuationMode | undefined) ??
					"protectedOnly",
				maxTransientRetries: settings.agent?.maxTransientRetries ?? 10,
				silentToolCallThreshold: settings.agent?.silentToolCallThreshold ?? 20,
				pipelineUnusedToolCallThreshold: settings.agent?.pipelineUnusedToolCallThreshold ?? 10,
				behaviorFenceInterval: settings.agent?.behaviorFenceInterval ?? -1,
				tasksReminderInterval: settings.agent?.tasksReminderInterval ?? 15,
				behaviorFenceAttachTasks: settings.agent?.behaviorFenceAttachTasks ?? true,
				retryBackoffCeilMs: settings.agent?.retryBackoffCeilMs ?? 20000,
				firstTokenTimeoutMs: settings.agent?.firstTokenTimeoutMs ?? 300000,
				customRetryRules: settings.agent?.customRetryRules ?? [],
				contextThresholds: settings.agent?.contextThresholds ?? cloneDefaultContextThresholds(),
				autoCompactKeepPairs: settings.agent?.autoCompactKeepPairs ?? 2,
				autoCompactPruneThreshold: settings.agent?.autoCompactPruneThreshold ?? 80,
				minPruneRatio: settings.agent?.minPruneRatio ?? 30,
				queueDuringCompaction: settings.agent?.queueDuringCompaction ?? false,
				agentDefaultReasoningEffort: settings.agent?.defaultReasoningEffort ?? "",
				globalWhitelistDirs: settings.agent?.whitelistDirs ?? [],
				globalBlacklistDirs: settings.agent?.blacklistDirs ?? [],
				globalCommandWhitelist: settings.agent?.commandWhitelist ?? [],
				globalCommandBlacklist: settings.agent?.commandBlacklist ?? [],
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
		const normalizedUpdateServerUrl = normalizeUrlProtocol(state.updateServerUrl) ?? "";
		const normalizedState = {
			...state,
			dangerReflectionEnabled: state.dangerReflectionLevel !== "off",
			updateServerUrl: normalizedUpdateServerUrl,
		};
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
					translationModel: state.translationModel,
					maxTurns: state.maxTurns,
					subagentModels: {
						explore: state.subagentExploreModel,
						plan: state.subagentPlanModel,
						search: state.subagentSearchModel,
						review: state.subagentReviewModel,
					},
					subagentAllowedModels: state.subagentAllowedModels,
					legacyEncoding: state.legacyEncoding,
					freshShellEnv: state.freshShellEnv,
					translateReasoning: state.translateReasoning,
					requestDumpEnabled: state.requestDumpEnabled,
					requestDumpErrorsOnly: state.requestDumpErrorsOnly,
					defaultStartInPlanMode: state.defaultStartInPlanMode,
					defaultRelaxedPlan: state.defaultRelaxedPlan,
					defaultPruneEnabled: state.defaultPruneEnabled,
					planModeAllowInlinePlan: state.planModeAllowInlinePlan,
					planReflectionAutoApprove: state.planReflectionAutoApprove,
					planReflectionAllowAutoCompact: state.planReflectionAllowAutoCompact,
					questionReflectionEnabled: state.questionReflectionEnabled,
					questionReflectionTimeoutMs: state.questionReflectionTimeoutMs,
					dangerReflectionLevel: state.dangerReflectionLevel,
					dangerReflectionEnabled: state.dangerReflectionLevel !== "off",
					dangerSkipReadOnlyConfirmations: state.dangerSkipReadOnlyConfirmations,
					autoContinuationMode: state.autoContinuationMode,
					behaviorFenceInterval: state.behaviorFenceInterval,
					tasksReminderInterval: state.tasksReminderInterval,
					behaviorFenceAttachTasks: state.behaviorFenceAttachTasks,
					defaultReasoningEffort:
						(state.agentDefaultReasoningEffort as
							| "none"
							| "low"
							| "medium"
							| "high"
							| "xhigh"
							| "max") || undefined,
					maxTransientRetries: state.maxTransientRetries,
					silentToolCallThreshold: state.silentToolCallThreshold,
					pipelineUnusedToolCallThreshold:
						state.pipelineUnusedToolCallThreshold === 0 ? 1 : state.pipelineUnusedToolCallThreshold,
					retryBackoffCeilMs: state.retryBackoffCeilMs,
					firstTokenTimeoutMs: state.firstTokenTimeoutMs,
					customRetryRules: state.customRetryRules,
					contextThresholds: state.contextThresholds,
					autoCompactKeepPairs: state.autoCompactKeepPairs,
					autoCompactPruneThreshold: state.autoCompactPruneThreshold,
					minPruneRatio: state.minPruneRatio,
					queueDuringCompaction: state.queueDuringCompaction,
					whitelistDirs: state.globalWhitelistDirs,
					blacklistDirs: state.globalBlacklistDirs,
					commandWhitelist: state.globalCommandWhitelist,
					commandBlacklist: state.globalCommandBlacklist,
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
				update: {
					serverUrl: normalizedUpdateServerUrl || undefined,
					channel: state.updateChannel,
					autoDownload: state.updateAutoDownload,
				},
			},
			{
				onSuccess: (data) => {
					serverSnapshot.current = normalizedState;
					setState(normalizedState);
					const resp = data as {
						serverRestarting?: boolean;
						manualRestartRequired?: boolean;
						newUrl?: string;
					};
					if (resp.serverRestarting && resp.newUrl) {
						setTimeout(() => {
							window.location.href = resp.newUrl as string;
						}, 1000);
					} else if (resp.manualRestartRequired) {
						notifications.show({
							message: t("serverRestartRequired"),
							color: "yellow",
						});
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
