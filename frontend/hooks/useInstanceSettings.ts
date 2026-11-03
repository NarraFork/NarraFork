import { notifications } from "@mantine/notifications";
import { DEFAULT_BRAND_ICON_COLOR } from "@shared/branding";
import { cloneDefaultContextThresholds } from "@shared/context-thresholds";
import {
	DEFAULT_RECORDING_REQUEST_BYTES,
	DEFAULT_RECORDING_RESPONSE_BYTES,
	type RecordingSettings,
	type RequestEvidenceAutoPin,
} from "@shared/request-recording";
import type {
	SubagentAllowedModels,
	SubagentModelReasoningEfforts,
} from "@shared/subagent-model-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ensurePrefix } from "../components/providers/types";
import { api } from "../lib/api";
import type {
	CommandBlacklistRuleInput,
	CommandWhitelistRuleInput,
	DirectoryBlacklistRuleInput,
	DirectoryWhitelistRuleInput,
} from "../lib/api/types";
import { normalizeRuleTargetSelector } from "../lib/api/types";
import { FOLLOW_DEFAULT_MODEL, FOLLOW_SUMMARY_MODEL } from "../lib/constants";
import { DEFAULT_GITHUB_REPOSITORY, type UpdateSource } from "../lib/update-source";
import { normalizeUrlProtocol } from "../lib/url";
import { PROJECT_DIR_STATUS_QUERY_KEY } from "./useProjectDirStatus";

export type DefaultNarratorVisibility = "auto" | "private" | "public";
export type DefaultNarratorWriteAudience = "auto" | "owner" | "project" | "public";
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
	tlsAutoReissue: boolean;
	tlsCertFile: string;
	tlsKeyFile: string;
	tlsPassphrase: string;
	tlsCaFile: string;
	// Update
	updateSource: UpdateSource;
	updateGithubRepository: string;
	updateServerUrl: string;
	updateChannel: "stable" | "beta";
	updateAutoDownload: boolean;
	// Branding — empty name means "use the NarraFork default".
	brandName: string;
	brandIconColor: string;
	// Agent / Models
	defaultModel: string;
	permissionMode: string;
	summaryModel: string;
	translationModel: string;
	promptOptimizeModel: string;
	promptOptimizeContextMaxMessages: number;
	maxTurns: number;
	subagentExploreModel: string;
	subagentPlanModel: string;
	subagentSearchModel: string;
	subagentReviewModel: string;
	subagentAllowedModels: SubagentAllowedModels;
	subagentModelReasoningEfforts: SubagentModelReasoningEfforts;
	legacyEncoding: boolean;
	freshShellEnv: boolean;
	translateReasoning: boolean;
	ringEnabled: boolean;
	ringRequestBytes: number;
	ringResponseBytes: number;
	autoPin: RequestEvidenceAutoPin;
	defaultNarratorVisibility: DefaultNarratorVisibility;
	defaultNarratorWriteAudience: DefaultNarratorWriteAudience;
	defaultStartInPlanMode: boolean;
	defaultRelaxedPlan: boolean;
	planModeAllowInlinePlan: boolean;
	permissionRuleAutoApprove: boolean;
	planReflectionAutoApprove: boolean;
	planReflectionAllowAutoCompact: boolean;
	questionReflectionEnabled: boolean;
	questionReflectionTimeoutMs: number;
	dangerReflectionLevel: DangerReflectionLevel;
	dangerReflectionEnabled: boolean;
	dangerSkipReadOnlyConfirmations: boolean;
	autoContinuationMode: AutoContinuationMode;
	maxTransientRetries: number;
	maxToolCallsPerResponse: number;
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
		standard: { compactStart: number };
		large: { compactStart: number };
	};
	autoCompactKeepPairs: number;
	queueDuringCompaction: boolean;
	agentDefaultReasoningEffort: string;
	/** Models excluded from receiving a reasoning-effort hint. */
	reasoningEffortBlocklist: Array<{ pattern: string; enabled?: boolean }>;
	globalWhitelistDirs: DirectoryWhitelistRuleInput[];
	globalBlacklistDirs: DirectoryBlacklistRuleInput[];
	globalCommandWhitelist: CommandWhitelistRuleInput[];
	globalCommandBlacklist: CommandBlacklistRuleInput[];
	// Workspace
	treeSnapshots: boolean;
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

function normalizeSharedRules<
	T extends { selector: ReturnType<typeof normalizeRuleTargetSelector> },
>(rules: Array<Record<string, unknown>> | undefined): T[] {
	return (rules ?? []).map((rule) => ({
		...rule,
		selector: normalizeRuleTargetSelector(rule),
	})) as T[];
}

/** Older servers/configurations omit these fields; zero and false are explicit settings. */
export function readRequestRecordingSettings(
	evidence?: Partial<RecordingSettings>,
): RecordingSettings {
	return {
		ringEnabled: evidence?.ringEnabled ?? true,
		ringRequestBytes: evidence?.ringRequestBytes ?? DEFAULT_RECORDING_REQUEST_BYTES,
		ringResponseBytes: evidence?.ringResponseBytes ?? DEFAULT_RECORDING_RESPONSE_BYTES,
		autoPin: evidence?.autoPin ?? "off",
	};
}

/** Meta references a model field may hold instead of a model ID. */
const META_MODEL_REFERENCES = new Set([FOLLOW_DEFAULT_MODEL, FOLLOW_SUMMARY_MODEL]);

/**
 * Normalize one stored model reference into settings-form state.
 *
 * `fallback` follows `??` semantics: only an absent value uses it, an explicit
 * empty string stays empty (the server reads both differently).
 *
 * The legacy prefix strip heals settings written by builds that pushed every
 * stored value through `ensurePrefix`, turning a `__default__` summary model
 * into `openai:__default__`. The Select only offers the bare sentinel, so a
 * prefixed one renders the role as empty — and the next save would persist the
 * broken value all over again.
 */
export function normalizeSettingsModelRef(value: string | null | undefined, fallback = ""): string {
	const stored = (value ?? fallback).trim();
	const separator = stored.indexOf(":");
	// "provider:__default__" is the same instruction as "__default__"; the model
	// list has no such entry, only the sentinel.
	const model = separator > 0 ? stored.slice(separator + 1) : "";
	if (META_MODEL_REFERENCES.has(model)) return model;
	return ensurePrefix(stored);
}

/** The subset of `agent` settings the form holds as model references. */
interface AgentModelRefSettings {
	defaultModel?: string;
	summaryModel?: string;
	translationModel?: string;
	promptOptimizeModel?: string;
	subagentModels?: Partial<Record<"explore" | "plan" | "search" | "review", string>>;
}

/**
 * Build every model-reference field of the settings form.
 *
 * Kept as one exported function so the mapping stays directly testable: a role
 * that silently loses its sentinel only shows up as an empty Select after a
 * reload, which is exactly the failure this mapping exists to prevent.
 */
export function readInstanceModelRefs(agent?: AgentModelRefSettings) {
	return {
		defaultModel: normalizeSettingsModelRef(agent?.defaultModel),
		summaryModel: normalizeSettingsModelRef(agent?.summaryModel),
		translationModel: normalizeSettingsModelRef(agent?.translationModel, FOLLOW_SUMMARY_MODEL),
		promptOptimizeModel: normalizeSettingsModelRef(
			agent?.promptOptimizeModel,
			FOLLOW_SUMMARY_MODEL,
		),
		subagentExploreModel: normalizeSettingsModelRef(agent?.subagentModels?.explore),
		subagentPlanModel: normalizeSettingsModelRef(agent?.subagentModels?.plan),
		subagentSearchModel: normalizeSettingsModelRef(agent?.subagentModels?.search),
		subagentReviewModel: normalizeSettingsModelRef(agent?.subagentModels?.review),
	};
}

function makeDefaults(): InstanceSettingsState {
	return {
		port: 7778,
		host: "localhost",
		openBrowser: "app",
		projectDir: "",
		tlsEnabled: false,
		tlsAutoReissue: true,
		tlsCertFile: "",
		tlsKeyFile: "",
		tlsPassphrase: "",
		tlsCaFile: "",
		updateSource: "github",
		updateGithubRepository: DEFAULT_GITHUB_REPOSITORY,
		updateServerUrl: "",
		updateChannel: "stable",
		updateAutoDownload: false,
		brandName: "",
		brandIconColor: DEFAULT_BRAND_ICON_COLOR,
		// Empty until the user picks one (see server defaults): no hardcoded
		// fallback, so an unconfigured instance never displays a model the user
		// never selected as if it were active.
		defaultModel: "",
		permissionMode: "bypassPermissions",
		summaryModel: "",
		translationModel: "__summary__",
		promptOptimizeModel: "__summary__",
		promptOptimizeContextMaxMessages: 3,
		maxTurns: 1000,
		subagentExploreModel: "",
		subagentPlanModel: "",
		subagentSearchModel: "",
		subagentReviewModel: "",
		subagentAllowedModels: { explore: [], plan: [], general: [], search: [], review: [] },
		subagentModelReasoningEfforts: {},
		legacyEncoding: false,
		freshShellEnv: false,
		translateReasoning: false,
		...readRequestRecordingSettings(),
		defaultNarratorVisibility: "auto",
		defaultNarratorWriteAudience: "auto",
		defaultStartInPlanMode: false,
		defaultRelaxedPlan: false,
		planModeAllowInlinePlan: true,
		permissionRuleAutoApprove: false,
		planReflectionAutoApprove: false,
		planReflectionAllowAutoCompact: false,
		questionReflectionEnabled: false,
		questionReflectionTimeoutMs: 300000,
		dangerReflectionLevel: "standard",
		dangerReflectionEnabled: true,
		dangerSkipReadOnlyConfirmations: false,
		autoContinuationMode: "protectedOnly",
		maxTransientRetries: 10,
		maxToolCallsPerResponse: 32,
		silentToolCallThreshold: 50,
		pipelineUnusedToolCallThreshold: 10,
		behaviorFenceInterval: -1,
		tasksReminderInterval: 15,
		behaviorFenceAttachTasks: true,
		retryBackoffCeilMs: 20000,
		firstTokenTimeoutMs: 300000,
		customRetryRules: [],
		contextThresholds: cloneDefaultContextThresholds(),
		autoCompactKeepPairs: 2,
		queueDuringCompaction: true,
		agentDefaultReasoningEffort: "",
		reasoningEffortBlocklist: [],
		globalWhitelistDirs: [],
		globalBlacklistDirs: [],
		globalCommandWhitelist: [],
		globalCommandBlacklist: [],
		treeSnapshots: true,
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
			void qc.invalidateQueries({ queryKey: PROJECT_DIR_STATUS_QUERY_KEY });
			// Drop stale recommendations and cancel in-flight checks, not prepared binaries/status.
			void qc.resetQueries({ queryKey: ["update-check"] });
			void qc.invalidateQueries({ queryKey: ["update-check"], refetchType: "none" });
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
				tlsAutoReissue: settings.server?.tls?.autoReissue ?? true,
				tlsCertFile: settings.server?.tls?.certFile ?? "",
				tlsKeyFile: settings.server?.tls?.keyFile ?? "",
				tlsPassphrase: "",
				tlsCaFile: settings.server?.tls?.caFile ?? "",
				updateSource: settings.update?.source ?? "github",
				updateGithubRepository: settings.update?.githubRepository ?? DEFAULT_GITHUB_REPOSITORY,
				updateServerUrl: settings.update?.serverUrl ?? "",
				updateChannel: settings.update?.channel ?? "stable",
				updateAutoDownload: settings.update?.autoDownload ?? false,
				brandName: settings.branding?.name ?? "",
				brandIconColor: settings.branding?.iconColor ?? DEFAULT_BRAND_ICON_COLOR,
				...readInstanceModelRefs(settings.agent),
				permissionMode: settings.agent?.defaultPermissionMode ?? "default",
				defaultNarratorVisibility: settings.agent?.defaultNarratorVisibility ?? "auto",
				defaultNarratorWriteAudience: settings.agent?.defaultNarratorWriteAudience ?? "auto",
				defaultStartInPlanMode: settings.agent?.defaultStartInPlanMode ?? false,
				promptOptimizeContextMaxMessages: settings.agent?.promptOptimizeContextMaxMessages ?? 3,
				maxTurns: settings.agent?.maxTurns ?? 1000,
				subagentAllowedModels: {
					explore: settings.agent?.subagentAllowedModels?.explore ?? [],
					plan: settings.agent?.subagentAllowedModels?.plan ?? [],
					general: settings.agent?.subagentAllowedModels?.general ?? [],
					search: settings.agent?.subagentAllowedModels?.search ?? [],
					review: settings.agent?.subagentAllowedModels?.review ?? [],
				},
				subagentModelReasoningEfforts: settings.agent?.subagentModelReasoningEfforts ?? {},
				legacyEncoding: settings.agent?.legacyEncoding ?? false,
				freshShellEnv: settings.agent?.freshShellEnv ?? false,
				translateReasoning: settings.agent?.translateReasoning ?? false,
				...readRequestRecordingSettings(settings.requestEvidence),
				defaultRelaxedPlan: settings.agent?.defaultRelaxedPlan ?? false,
				planModeAllowInlinePlan: settings.agent?.planModeAllowInlinePlan ?? true,
				permissionRuleAutoApprove: settings.agent?.permissionRuleAutoApprove ?? false,
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
				maxToolCallsPerResponse: settings.agent?.maxToolCallsPerResponse ?? 32,
				silentToolCallThreshold: settings.agent?.silentToolCallThreshold ?? 50,
				pipelineUnusedToolCallThreshold: settings.agent?.pipelineUnusedToolCallThreshold ?? 10,
				behaviorFenceInterval: settings.agent?.behaviorFenceInterval ?? -1,
				tasksReminderInterval: settings.agent?.tasksReminderInterval ?? 15,
				behaviorFenceAttachTasks: settings.agent?.behaviorFenceAttachTasks ?? true,
				retryBackoffCeilMs: settings.agent?.retryBackoffCeilMs ?? 20000,
				firstTokenTimeoutMs: settings.agent?.firstTokenTimeoutMs ?? 300000,
				customRetryRules: settings.agent?.customRetryRules ?? [],
				contextThresholds: settings.agent?.contextThresholds ?? cloneDefaultContextThresholds(),
				autoCompactKeepPairs: settings.agent?.autoCompactKeepPairs ?? 2,
				queueDuringCompaction: settings.agent?.queueDuringCompaction ?? true,
				agentDefaultReasoningEffort: settings.agent?.defaultReasoningEffort ?? "",
				reasoningEffortBlocklist: settings.agent?.reasoningEffortBlocklist ?? [],
				globalWhitelistDirs: normalizeSharedRules<DirectoryWhitelistRuleInput>(
					settings.agent?.whitelistDirs,
				),
				globalBlacklistDirs: normalizeSharedRules<DirectoryBlacklistRuleInput>(
					settings.agent?.blacklistDirs,
				),
				globalCommandWhitelist: normalizeSharedRules<CommandWhitelistRuleInput>(
					settings.agent?.commandWhitelist,
				),
				globalCommandBlacklist: normalizeSharedRules<CommandBlacklistRuleInput>(
					settings.agent?.commandBlacklist,
				),
				treeSnapshots: settings.workspace?.treeSnapshotsEnabled ?? true,
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
		if (!initialized) return;
		const normalizedUpdateServerUrl = normalizeUrlProtocol(state.updateServerUrl) ?? "";
		const normalizedState = {
			...state,
			dangerReflectionEnabled: state.dangerReflectionLevel !== "off",
			updateServerUrl: normalizedUpdateServerUrl,
			updateGithubRepository: state.updateGithubRepository.trim(),
		};
		updateSettings.mutate(
			{
				server: {
					port: state.port,
					host: state.host,
					openBrowser: state.openBrowser,
					tls: {
						enabled: state.tlsEnabled,
						autoReissue: state.tlsAutoReissue,
						certFile: state.tlsCertFile,
						keyFile: state.tlsKeyFile,
						...(state.tlsPassphrase && { passphrase: state.tlsPassphrase }),
						...(state.tlsCaFile && { caFile: state.tlsCaFile }),
					},
				},
				paths: { defaultProjectDir: state.projectDir },
				branding: {
					// "" is meaningful for both fields ("clear it"), so they are always
					// sent. Omitting a key would be read as "leave unchanged" by the
					// server's `.partial()` schema, making a custom name unremovable.
					name: state.brandName.trim(),
					iconColor: state.brandIconColor === DEFAULT_BRAND_ICON_COLOR ? "" : state.brandIconColor,
				},
				agent: {
					defaultModel: state.defaultModel,
					defaultPermissionMode: state.permissionMode,
					summaryModel: state.summaryModel,
					translationModel: state.translationModel,
					promptOptimizeModel: state.promptOptimizeModel,
					promptOptimizeContextMaxMessages: state.promptOptimizeContextMaxMessages,
					maxTurns: state.maxTurns,
					subagentModels: {
						explore: state.subagentExploreModel,
						plan: state.subagentPlanModel,
						search: state.subagentSearchModel,
						review: state.subagentReviewModel,
					},
					subagentAllowedModels: state.subagentAllowedModels,
					...(JSON.stringify(state.subagentModelReasoningEfforts) !==
					JSON.stringify(serverSnapshot.current.subagentModelReasoningEfforts)
						? { subagentModelReasoningEfforts: state.subagentModelReasoningEfforts }
						: {}),
					legacyEncoding: state.legacyEncoding,
					freshShellEnv: state.freshShellEnv,
					translateReasoning: state.translateReasoning,
					defaultNarratorVisibility: state.defaultNarratorVisibility,
					defaultNarratorWriteAudience: state.defaultNarratorWriteAudience,
					defaultStartInPlanMode: state.defaultStartInPlanMode,
					defaultRelaxedPlan: state.defaultRelaxedPlan,
					planModeAllowInlinePlan: state.planModeAllowInlinePlan,
					permissionRuleAutoApprove: state.permissionRuleAutoApprove,
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
					// "" is meaningful here ("auto"): the server drops the stored tier.
					// Sending undefined instead would be omitted by JSON.stringify and
					// the previous value would survive the patch merge.
					defaultReasoningEffort: state.agentDefaultReasoningEffort as
						| "none"
						| "low"
						| "medium"
						| "high"
						| "xhigh"
						| "max"
						| "",
					// Blank patterns are dropped so an empty row left in the editor
					// cannot become a rule that matches every model.
					reasoningEffortBlocklist: state.reasoningEffortBlocklist.filter((r) => r.pattern.trim()),
					maxTransientRetries: state.maxTransientRetries,
					maxToolCallsPerResponse: state.maxToolCallsPerResponse,
					silentToolCallThreshold: state.silentToolCallThreshold,
					pipelineUnusedToolCallThreshold:
						state.pipelineUnusedToolCallThreshold === 0 ? 1 : state.pipelineUnusedToolCallThreshold,
					retryBackoffCeilMs: state.retryBackoffCeilMs,
					firstTokenTimeoutMs: state.firstTokenTimeoutMs,
					customRetryRules: state.customRetryRules,
					contextThresholds: state.contextThresholds,
					autoCompactKeepPairs: state.autoCompactKeepPairs,
					queueDuringCompaction: state.queueDuringCompaction,
					whitelistDirs: state.globalWhitelistDirs,
					blacklistDirs: state.globalBlacklistDirs,
					commandWhitelist: state.globalCommandWhitelist,
					commandBlacklist: state.globalCommandBlacklist,
				},
				requestEvidence: {
					ringEnabled: state.ringEnabled,
					ringRequestBytes: state.ringRequestBytes,
					ringResponseBytes: state.ringResponseBytes,
					autoPin: state.autoPin,
				},
				workspace: { treeSnapshotsEnabled: state.treeSnapshots },
				editor: { type: "vscode" },
				update: {
					source: state.updateSource,
					githubRepository: state.updateGithubRepository.trim(),
					// Send "" (not undefined) so clearing the field resets the server
					// back to the built-in default instead of keeping the old value.
					serverUrl: normalizedUpdateServerUrl,
					channel: state.updateChannel,
					autoDownload: state.updateAutoDownload,
				},
			},
			{
				onSuccess: (data) => {
					serverSnapshot.current = normalizedState;
					setState(normalizedState);
					// Branding is served by its own public endpoint with a long staleTime,
					// so the tab title / favicon / header would keep the previous values
					// until the next full page load without an explicit invalidation.
					void qc.invalidateQueries({ queryKey: ["branding"] });
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
