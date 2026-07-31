import type { UsageHistoryStats } from "@frontend/types/usage-history";
import {
	ApiError,
	absorbRenewedToken,
	authorizedFetch,
	BASE,
	getToken,
	postFormDataWithProgress,
	readFetchError,
	request,
} from "./client";
import type {
	ApiEntity,
	BlacklistCmd,
	BlacklistDir,
	BufferMessageSummary,
	ChunkManifest,
	ChunkRangeResult,
	CommandBlacklistRuleInput,
	CommandWhitelistRuleInput,
	CompactMessageDetail,
	DirectoryBlacklistRuleInput,
	DirectoryWhitelistRuleInput,
	MessageLocationResult,
	NarratorMessageSearchResponse,
	PaginatedNarrators,
	PretextDocumentPageResult,
	RuleTargetSelector,
	WhitelistCmd,
	WhitelistDir,
} from "./types";
import { normalizeRuleTargetSelector, selectorToLegacyDeviceScope } from "./types";

export function shouldClearEditDraft(result: unknown): result is true {
	return result === true;
}

export interface NarratorExecutionDevice {
	id: string;
	name: string;
	slug: string;
	description?: string | null;
	online: boolean;
	platform?: { os: string; arch: string; shellPath?: string };
	defaultCwd?: string | null;
}

export interface PermissionDecisionPayload {
	message?: string;
	answers?: Record<string, string>;
	feedbackText?: string;
	compactAfter?: boolean;
	updatedPlan?: string;
}

export interface RetryFailedCompactResponse {
	ok: true;
	messageId: string;
	oldMessageId?: string;
	replacedMessageId?: string;
}

/**
 * Why a narrator's persisted model was flagged.
 *
 * `provider_missing` is definite breakage (the prefix no longer resolves).
 * `model_not_listed` is only a suspicion: gateways pass model ids through
 * verbatim, so a hand-typed id absent from the catalog may still work.
 */
export type BrokenModelReason = "provider_missing" | "model_not_listed";

export interface BrokenModelNarrator {
	id: string;
	title: string | null;
	model: string;
	status: string;
	chapterId: string | null;
	hasBrokenPendingRestore: boolean;
}

export interface BrokenModelGroup {
	providerPrefix: string | null;
	reason: BrokenModelReason;
	detail: string;
	narrators: BrokenModelNarrator[];
}

export interface BrokenModelScanResponse {
	groups: BrokenModelGroup[];
	totalBroken: number;
	totalSuspect: number;
	scanned: number;
	truncated: boolean;
	undoAvailable: boolean;
}

export interface BrokenModelMigrationResponse {
	migrated: number;
	skipped: number;
	targetModel: string;
	undoAvailable: boolean;
}

type ApiRuleTargetFields = {
	selector?: RuleTargetSelector;
	targetKind?: RuleTargetSelector["kind"] | null;
	targetValue?: string | null;
	deviceScope?: string | null;
};

function normalizeRule<T extends ApiRuleTargetFields>(
	rule: T,
): T & { selector: RuleTargetSelector } {
	return { ...rule, selector: normalizeRuleTargetSelector(rule) };
}

function withCompatibleTarget<T extends { selector: RuleTargetSelector }>(data: T) {
	return { ...data, deviceScope: selectorToLegacyDeviceScope(data.selector) };
}

export const narratorsApi = {
	listNarrators: (opts?: {
		chapterId?: string;
		standalone?: boolean;
		status?: string;
		sortBy?: string;
		sortOrder?: string;
	}) => {
		const params = new URLSearchParams();
		if (opts?.chapterId) params.set("chapterId", opts.chapterId);
		if (opts?.standalone) params.set("standalone", "true");
		if (opts?.status) params.set("status", opts.status);
		if (opts?.sortBy) params.set("sortBy", opts.sortBy);
		if (opts?.sortOrder) params.set("sortOrder", opts.sortOrder);
		const qs = params.toString();
		return request<ApiEntity[]>(`/narrators${qs ? `?${qs}` : ""}`);
	},
	listNarratorsPaginated: (opts?: {
		standalone?: boolean | "all";
		status?: string;
		filter?: string;
		sortBy?: string;
		sortOrder?: string;
		limit?: number;
		cursor?: string;
		hasTerminals?: boolean;
		hasContainers?: boolean;
		hasRunningContainers?: boolean;
		hasViewers?: boolean;
	}) => {
		const params = new URLSearchParams();
		if (opts?.standalone === "all") params.set("standalone", "all");
		else if (opts?.standalone) params.set("standalone", "true");
		if (opts?.status) params.set("status", opts.status);
		if (opts?.filter) params.set("filter", opts.filter);
		if (opts?.sortBy) params.set("sortBy", opts.sortBy);
		if (opts?.sortOrder) params.set("sortOrder", opts.sortOrder);
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		if (opts?.hasTerminals) params.set("hasTerminals", "true");
		if (opts?.hasContainers) params.set("hasContainers", "true");
		if (opts?.hasRunningContainers) params.set("hasRunningContainers", "true");
		if (opts?.hasViewers) params.set("hasViewers", "true");
		const qs = params.toString();
		return request<PaginatedNarrators>(`/narrators${qs ? `?${qs}` : ""}`);
	},
	getNarrator: (id: string) => request<ApiEntity>(`/narrators/${id}`),
	getNarratorDraft: (id: string) =>
		request<{
			hasDraft: boolean;
			text: string;
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
		}>(`/narrators/${id}/draft`),
	updateNarratorDraft: (id: string, text: string, baseRevision: number, sourceId?: string) =>
		request<{
			ok: boolean;
			traits: string[];
			hasDraft: boolean;
			text: string;
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
		}>(`/narrators/${id}/draft`, {
			method: "PUT",
			body: JSON.stringify({ text, baseRevision, sourceId }),
		}),
	getNarratorUsageStats: (id: string, opts?: { includeSubagents?: boolean }) => {
		const params = new URLSearchParams();
		if (opts?.includeSubagents !== undefined) {
			params.set("includeSubagents", String(opts.includeSubagents));
		}
		const qs = params.toString();
		return request<UsageHistoryStats>(`/narrators/${id}/usage-stats${qs ? `?${qs}` : ""}`);
	},
	getNarratorCommands: (id: string) =>
		request<{
			commands: Array<{
				name: string;
				prompt: string;
				description?: string;
				source: string;
				runBashFirst?: boolean;
				bashCommand?: string;
				params?: Array<{
					name: string;
					description?: string;
					required?: boolean;
					defaultValue?: string;
				}>;
			}>;
			skills: Array<{
				name: string;
				description: string;
				source: string;
				blocked?: boolean;
			}>;
			tools: Array<{
				id: string;
				toolName: string;
				descriptionEn: string;
				descriptionZh: string;
			}>;
			allSkillsBlocked?: boolean;
		}>(`/narrators/${id}/commands`),
	getNarratorSkills: (id: string, opts?: { refresh?: boolean }) => {
		const params = new URLSearchParams();
		if (opts?.refresh) params.set("refresh", "true");
		const qs = params.toString();
		return request<{
			skills: Array<{
				name: string;
				description: string;
				location: string;
				files: string[];
				disabled?: boolean;
				source: "global" | "project" | "workspace";
				rootKind: "global" | "project" | "workspace";
				normalizedRootPath: string;
			}>;
			roots: Array<{
				rootKind: "global" | "project" | "workspace";
				rootPath: string;
				normalizedRootPath: string;
				scannedAt?: string | null;
				lastAccessedAt?: string | null;
				expiresAt?: string | null;
				cacheHit: boolean;
				refreshed: boolean;
				cacheable: boolean;
				skillCount: number;
			}>;
			scopeKey: string;
		}>(`/narrators/${id}/skills${qs ? `?${qs}` : ""}`);
	},
	createNarrator: (data: {
		chapterId?: string | null;
		type?: string;
		model?: string;
		systemPrompt?: string;
		permissionMode?: string;
		startInPlanMode?: boolean;
		reasoningEffort?: string | null;
		fastMode?: boolean;
		relaxedPlan?: boolean;
		planReflectionAutoApproveOverride?: "inherit" | "on" | "off";
		dangerReflectionOverride?: "inherit" | "on" | "off" | "light" | "standard" | "strict";
		autoContinuationOverride?: "inherit" | "always" | "blockStop" | "protectedOnly" | "off";
		behaviorFenceIntervalOverride?: number | null;
		behaviorFenceAttachOverride?: "inherit" | "on" | "off";
		cwd?: string;
		makeNamed?: boolean;
		handle?: string;
		kind?: "knowledge";
	}) => request<ApiEntity>("/narrators", { method: "POST", body: JSON.stringify(data) }),
	// Named narrators (@handle mention targets)
	listNamedNarrators: () => request<ApiEntity[]>("/narrators/named"),
	getNarratorByHandle: (handle: string) =>
		request<ApiEntity>(`/narrators/by-handle/${encodeURIComponent(handle)}`),
	updateNarratorHandle: (id: string, handle: string | null) =>
		request<ApiEntity>(`/narrators/${id}/handle`, {
			method: "PATCH",
			body: JSON.stringify({ handle }),
		}),
	archiveNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/archive`, { method: "PATCH" }),
	unarchiveNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/unarchive`, { method: "PATCH" }),
	deleteNarrator: (id: string) => request<ApiEntity>(`/narrators/${id}`, { method: "DELETE" }),
	markNarratorRead: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/mark-read`, { method: "PATCH" }),
	// Chunk virtualization: lightweight manifest of structural fingerprints.
	// `window` walks older bands: `limitChunks` caps the returned chunk count and
	// `beforeSeq` requests the band of chunks immediately older than that seq.
	getChunkManifest: (
		id: string,
		since?: number,
		window?: { limitChunks?: number; beforeSeq?: number },
	) => {
		const params = new URLSearchParams();
		if (since != null) params.set("since", String(since));
		if (window?.limitChunks != null) params.set("limitChunks", String(window.limitChunks));
		if (window?.beforeSeq != null) params.set("beforeSeq", String(window.beforeSeq));
		const qs = params.toString();
		return request<ChunkManifest>(`/narrators/${id}/chunk-manifest${qs ? `?${qs}` : ""}`);
	},
	// Exact-layout input page: transport batches are ordered by seq and carry no
	// scrollbar geometry or band semantics.
	getPretextDocumentPage: (
		id: string,
		opts?: { afterSeq?: number; beforeSeq?: number; limit?: number; messageVersion?: number },
	) => {
		const params = new URLSearchParams();
		if (opts?.afterSeq != null) params.set("afterSeq", String(opts.afterSeq));
		if (opts?.beforeSeq != null) params.set("beforeSeq", String(opts.beforeSeq));
		if (opts?.limit != null) params.set("limit", String(opts.limit));
		if (opts?.messageVersion != null) params.set("messageVersion", String(opts.messageVersion));
		const qs = params.toString();
		return request<PretextDocumentPageResult>(
			`/narrators/${id}/pretext-document${qs ? `?${qs}` : ""}`,
		);
	},
	// Chunk virtualization: fetch a contiguous range of chunks (full trees).
	getNarratorChunks: (
		id: string,
		opts?: { fromSeq?: number; direction?: "older" | "newer"; count?: number },
	) => {
		const params = new URLSearchParams();
		if (opts?.fromSeq != null) params.set("fromSeq", String(opts.fromSeq));
		if (opts?.direction) params.set("direction", opts.direction);
		if (opts?.count != null) params.set("count", String(opts.count));
		const qs = params.toString();
		return request<ChunkRangeResult>(`/narrators/${id}/chunks${qs ? `?${qs}` : ""}`);
	},
	// Chunk virtualization: resolve a message to its top-level seq coordinate.
	getMessageLocation: (id: string, messageId: string) =>
		request<MessageLocationResult>(
			`/narrators/${id}/message-location/${encodeURIComponent(messageId)}`,
		),
	// Full-text search within a single narrator's own conversation history.
	searchNarratorMessages: (id: string, q: string, limit?: number) => {
		const params = new URLSearchParams({ q });
		if (limit != null) params.set("limit", String(limit));
		return request<NarratorMessageSearchResponse>(`/narrators/${id}/search?${params.toString()}`);
	},
	getToolCallDetail: (narratorId: string, toolUseId: string) =>
		request<ApiEntity>(`/narrators/${narratorId}/tool-calls/${toolUseId}`),
	interruptNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/interrupt`, { method: "POST" }),
	detachSubagent: (id: string) =>
		request<{ detached: boolean }>(`/narrators/${id}/detach`, { method: "POST" }),
	takeoverSubagent: (id: string) =>
		request<{ takenOver: boolean }>(`/narrators/${id}/takeover`, { method: "POST" }),
	stopTakeoverSubagent: (id: string) =>
		request<{ stopped: boolean; deferred?: boolean }>(`/narrators/${id}/stop-takeover`, {
			method: "POST",
		}),
	cancelBackgroundTask: (narratorId: string, taskId: string) =>
		request<{
			success: boolean;
			cancelledTask?: boolean;
			interruptedContinuation?: boolean;
			cancelledChildren?: number;
		}>(`/narrators/${narratorId}/background-tasks/${taskId}/cancel`, {
			method: "POST",
		}),
	listBackgroundTasks: (narratorId: string) =>
		request<{
			tasks: {
				id: string;
				type: "bash" | "agent";
				status: string;
				effectiveStatus: string;
				currentNarratorStatus: string | null;
				activeChildTaskCount: number;
				canCancelActiveWork: boolean;
				command: string | null;
				exitCode: number | null;
				toolUseId: string | null;
				subagentNarratorId: string | null;
				subagentType: string | null;
				alias: string | null;
				title: string | null;
				/** Preview only (truncated server-side). Use getBackgroundTaskOutput for the full text. */
				output: string | null;
				outputBytes: number;
				outputTruncated: boolean;
				startedAt: string;
				completedAt: string | null;
			}[];
			legacySubagentTasks: {
				id: string;
				subagentType: string | null;
				backgroundStatus: string | null;
				backgroundResult: string | null;
				backgroundCompletedAt: string | null;
				status: string;
				createdAt: string;
				title: string | null;
			}[];
		}>(`/narrators/${narratorId}/background-tasks`),
	getBackgroundTaskOutput: (narratorId: string, taskId: string) =>
		request<{ output: string | null; status: string }>(
			`/narrators/${narratorId}/background-tasks/${taskId}/output`,
		),
	/**
	 * Bounded tail of a task's output. While the task is running this returns the
	 * live in-memory buffer, so it is safe to poll for a real-time view.
	 */
	getBackgroundTaskOutputTail: (narratorId: string, taskId: string, chars?: number) => {
		const query = chars != null ? `?chars=${chars}` : "";
		return request<{
			status: string;
			type: "bash" | "agent";
			command: string | null;
			exitCode: number | null;
			tail: string;
			totalChars: number;
			truncated: boolean;
			/** True when the tail came from the live in-memory buffer. */
			live: boolean;
			startedAt: string;
			completedAt: string | null;
		}>(`/narrators/${narratorId}/background-tasks/${taskId}/output/tail${query}`);
	},
	updateSubagentConclusion: (id: string) =>
		request<{ ok: boolean; toolUseId: string }>(`/narrators/${id}/update-conclusion`, {
			method: "POST",
		}),
	leaveNarrator: (id: string) =>
		request<{ ok: boolean }>(`/narrators/${id}/leave`, { method: "POST" }),
	getBufferedMessages: (id: string) => request<BufferMessageSummary[]>(`/narrators/${id}/buffer`),
	updateBufferedMessage: (narratorId: string, messageId: string, text: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ text }),
		}),
	removeBufferedMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer/${messageId}`, {
			method: "DELETE",
		}),
	clearBufferedMessages: (narratorId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer`, { method: "DELETE" }),
	reorderBufferedMessages: (narratorId: string, orderedIds: string[]) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer/reorder`, {
			method: "PUT",
			body: JSON.stringify({ orderedIds }),
		}),
	getPendingPermissions: (id: string) => request<ApiEntity[]>(`/narrators/${id}/permissions`),
	approvePermission: (requestId: string, payload?: PermissionDecisionPayload) =>
		request<ApiEntity>(`/narrators/permissions/${requestId}/approve`, {
			method: "POST",
			...(payload ? { body: JSON.stringify(payload) } : {}),
		}),
	denyPermission: (requestId: string, messageOrPayload?: string | PermissionDecisionPayload) =>
		request<ApiEntity>(`/narrators/permissions/${requestId}/deny`, {
			method: "POST",
			body: JSON.stringify(
				typeof messageOrPayload === "string"
					? { message: messageOrPayload }
					: (messageOrPayload ?? {}),
			),
		}),
	reflectQuestion: (requestId: string) =>
		request<{ ok: boolean; answers: Record<string, string> }>(
			`/narrators/permissions/${requestId}/reflect-question`,
			{
				method: "POST",
			},
		),
	disarmQuestionReflection: (requestId: string) =>
		request<{ ok: boolean; disarmed: boolean }>(
			`/narrators/permissions/${requestId}/disarm-question-reflection`,
			{
				method: "POST",
			},
		),
	stopQuestionReflection: (requestId: string) =>
		request<{ ok: boolean }>(`/narrators/permissions/${requestId}/stop-question-reflection`, {
			method: "POST",
		}),
	stopDangerReflection: (requestId: string) =>
		request<{ ok: boolean }>(`/narrators/permissions/${requestId}/stop-reflection`, {
			method: "POST",
		}),
	stopPlanReflection: (requestId: string) =>
		request<{ ok: boolean }>(`/narrators/permissions/${requestId}/stop-plan-reflection`, {
			method: "POST",
		}),
	stopTaskReflection: (requestId: string) =>
		request<{ ok: boolean }>(`/narrators/permissions/${requestId}/stop-task-reflection`, {
			method: "POST",
		}),
	updateNarratorTitle: (id: string, title: string) =>
		request<{ ok: boolean; title: string }>(`/narrators/${id}/title`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		}),
	updateNarratorCwd: (id: string, cwd: string) =>
		request<{ ok: boolean; cwd: string; changed: boolean }>(`/narrators/${id}/cwd`, {
			method: "PATCH",
			body: JSON.stringify({ cwd }),
		}),
	generateNarratorTitle: (id: string) =>
		request<{ title: string }>(`/narrators/${id}/generate-title`, { method: "POST" }),
	suggestAnswers: (
		narratorId: string,
		questions: {
			question: string;
			header: string;
			options: { label: string; description: string }[];
			multiSelect?: boolean;
		}[],
	) =>
		request<{ answers: Record<string, string> }>(`/narrators/${narratorId}/suggest-answers`, {
			method: "POST",
			body: JSON.stringify({ questions }),
		}),
	updateNarratorModel: (id: string, model: string) =>
		request<{ ok: boolean }>(`/narrators/${id}/model`, {
			method: "PATCH",
			body: JSON.stringify({ model }),
		}),
	// --- Broken model migration (admin only) ---
	scanBrokenModelNarrators: (opts?: { includeArchived?: boolean }) =>
		request<BrokenModelScanResponse>(
			`/narrators/broken-models${opts?.includeArchived ? "?includeArchived=true" : ""}`,
		),
	migrateBrokenModelNarrators: (payload: {
		targetModel: string;
		narratorIds: string[];
		includeArchived?: boolean;
	}) =>
		request<BrokenModelMigrationResponse>("/narrators/broken-models/migrate", {
			method: "POST",
			body: JSON.stringify(payload),
		}),
	undoBrokenModelMigration: () =>
		request<{ restored: number; skipped: number }>("/narrators/broken-models/undo", {
			method: "POST",
		}),
	getCustomTraits: (id: string) =>
		request<{
			subagentModelRestriction: {
				version: 1;
				pools: Record<string, { model: string; purpose?: string }[]>;
			} | null;
			disabledTools: { version: 1; tools: string[] } | null;
			blockedSkills: { version: 1; all: boolean; names: string[] } | null;
			availableModels: { model: string; purpose?: string }[];
			availableTools: { name: string; description: string; category: string }[];
		}>(`/narrators/${id}/custom-traits`),
	updateSubagentModelRestriction: (
		id: string,
		pools: Record<string, { model: string; purpose?: string }[]>,
	) =>
		request<{ ok: boolean; traits: string[]; customTraits: unknown }>(
			`/narrators/${id}/custom-traits/subagent-model-restriction`,
			{ method: "PUT", body: JSON.stringify({ pools }) },
		),
	clearSubagentModelRestriction: (id: string) =>
		request<{ ok: boolean; traits: string[]; customTraits: unknown }>(
			`/narrators/${id}/custom-traits/subagent-model-restriction`,
			{ method: "DELETE" },
		),
	updateDisabledTools: (id: string, tools: string[]) =>
		request<{ ok: boolean; traits: string[]; customTraits: unknown }>(
			`/narrators/${id}/custom-traits/disabled-tools`,
			{ method: "PUT", body: JSON.stringify({ tools }) },
		),
	clearDisabledTools: (id: string) =>
		request<{ ok: boolean; traits: string[]; customTraits: unknown }>(
			`/narrators/${id}/custom-traits/disabled-tools`,
			{ method: "DELETE" },
		),
	updateBlockedSkills: (id: string, blocked: { all: boolean; names: string[] }) =>
		request<{ ok: boolean; traits: string[]; customTraits: unknown }>(
			`/narrators/${id}/custom-traits/blocked-skills`,
			{ method: "PUT", body: JSON.stringify(blocked) },
		),
	clearBlockedSkills: (id: string) =>
		request<{ ok: boolean; traits: string[]; customTraits: unknown }>(
			`/narrators/${id}/custom-traits/blocked-skills`,
			{ method: "DELETE" },
		),
	getNarratorExecutionDevices: (id: string) =>
		request<{ defaultDeviceId: string | null; devices: NarratorExecutionDevice[] }>(
			`/narrators/${id}/execution-devices`,
		),
	updateNarratorDefaultDevice: (id: string, deviceId: string | null) =>
		request<{ defaultDeviceId: string | null }>(`/narrators/${id}/default-device`, {
			method: "PATCH",
			body: JSON.stringify({ deviceId }),
		}),
	updateNarratorPermissionMode: (id: string, permissionMode: string) =>
		request<{ ok: boolean }>(`/narrators/${id}/permission-mode`, {
			method: "PATCH",
			body: JSON.stringify({ permissionMode }),
		}),
	enterPlanMode: (id: string) =>
		request<{ ok: boolean; planMode: boolean; traits: string[] }>(
			`/narrators/${id}/plan-mode/enter`,
			{ method: "POST" },
		),
	exitPlanMode: (id: string) =>
		request<{ ok: boolean; planMode: boolean; traits: string[] }>(
			`/narrators/${id}/plan-mode/exit`,
			{ method: "POST" },
		),
	// Whitelist directories
	getWhitelistDirs: (id: string) =>
		request<WhitelistDir[]>(`/narrators/${id}/whitelist-dirs`).then((rules) =>
			rules.map(normalizeRule),
		),
	createWhitelistDir: (id: string, data: DirectoryWhitelistRuleInput) =>
		request<WhitelistDir>(`/narrators/${id}/whitelist-dirs`, {
			method: "POST",
			body: JSON.stringify(withCompatibleTarget(data)),
		}).then(normalizeRule),
	updateWhitelistDir: (
		dirId: string,
		data: Partial<DirectoryWhitelistRuleInput> & { selector?: RuleTargetSelector },
	) =>
		request<{ ok: boolean }>(`/narrators/whitelist-dirs/${dirId}`, {
			method: "PATCH",
			body: JSON.stringify(
				data.selector ? withCompatibleTarget(data as { selector: RuleTargetSelector }) : data,
			),
		}),
	deleteWhitelistDir: (dirId: string) =>
		request<{ ok: boolean }>(`/narrators/whitelist-dirs/${dirId}`, { method: "DELETE" }),
	// Blacklist directories
	getBlacklistDirs: (id: string) =>
		request<BlacklistDir[]>(`/narrators/${id}/blacklist-dirs`).then((rules) =>
			rules.map(normalizeRule),
		),
	createBlacklistDir: (id: string, data: DirectoryBlacklistRuleInput) =>
		request<BlacklistDir>(`/narrators/${id}/blacklist-dirs`, {
			method: "POST",
			body: JSON.stringify(withCompatibleTarget(data)),
		}).then(normalizeRule),
	updateBlacklistDir: (
		dirId: string,
		data: Partial<DirectoryBlacklistRuleInput> & { selector?: RuleTargetSelector },
	) =>
		request<{ ok: boolean }>(`/narrators/blacklist-dirs/${dirId}`, {
			method: "PATCH",
			body: JSON.stringify(
				data.selector ? withCompatibleTarget(data as { selector: RuleTargetSelector }) : data,
			),
		}),
	deleteBlacklistDir: (dirId: string) =>
		request<{ ok: boolean }>(`/narrators/blacklist-dirs/${dirId}`, { method: "DELETE" }),
	// Command whitelist
	getCmdWhitelist: (id: string) =>
		request<WhitelistCmd[]>(`/narrators/${id}/cmd-whitelist`).then((rules) =>
			rules.map(normalizeRule),
		),
	createCmdWhitelist: (id: string, data: CommandWhitelistRuleInput) =>
		request<WhitelistCmd>(`/narrators/${id}/cmd-whitelist`, {
			method: "POST",
			body: JSON.stringify(withCompatibleTarget(data)),
		}).then(normalizeRule),
	updateCmdWhitelist: (
		entryId: string,
		data: Partial<CommandWhitelistRuleInput> & { selector?: RuleTargetSelector },
	) =>
		request<{ ok: boolean }>(`/narrators/cmd-whitelist/${entryId}`, {
			method: "PATCH",
			body: JSON.stringify(
				data.selector ? withCompatibleTarget(data as { selector: RuleTargetSelector }) : data,
			),
		}),
	deleteCmdWhitelist: (entryId: string) =>
		request<{ ok: boolean }>(`/narrators/cmd-whitelist/${entryId}`, { method: "DELETE" }),
	// Command blacklist
	getCmdBlacklist: (id: string) =>
		request<BlacklistCmd[]>(`/narrators/${id}/cmd-blacklist`).then((rules) =>
			rules.map(normalizeRule),
		),
	createCmdBlacklist: (id: string, data: CommandBlacklistRuleInput) =>
		request<BlacklistCmd>(`/narrators/${id}/cmd-blacklist`, {
			method: "POST",
			body: JSON.stringify(withCompatibleTarget(data)),
		}).then(normalizeRule),
	updateCmdBlacklist: (
		entryId: string,
		data: Partial<CommandBlacklistRuleInput> & { selector?: RuleTargetSelector },
	) =>
		request<{ ok: boolean }>(`/narrators/cmd-blacklist/${entryId}`, {
			method: "PATCH",
			body: JSON.stringify(
				data.selector ? withCompatibleTarget(data as { selector: RuleTargetSelector }) : data,
			),
		}),
	deleteCmdBlacklist: (entryId: string) =>
		request<{ ok: boolean }>(`/narrators/cmd-blacklist/${entryId}`, { method: "DELETE" }),
	updateNarratorReasoningEffort: (id: string, reasoningEffort: string | null) =>
		request<{ ok: boolean }>(`/narrators/${id}/reasoning-effort`, {
			method: "PATCH",
			body: JSON.stringify({ reasoningEffort }),
		}),
	updateNarratorFastMode: (id: string, fastMode: boolean) =>
		request<{ ok: boolean }>(`/narrators/${id}/fast-mode`, {
			method: "PATCH",
			body: JSON.stringify({ fastMode }),
		}),
	updateNarratorRelaxedPlan: (id: string, relaxedPlan: boolean) =>
		request<{ ok: boolean; relaxedPlan: boolean }>(`/narrators/${id}/relaxed-plan`, {
			method: "PATCH",
			body: JSON.stringify({ relaxedPlan }),
		}),
	updateNarratorReflectionOverrides: (
		id: string,
		data: {
			planReflectionAutoApproveOverride?: "inherit" | "on" | "off";
			dangerReflectionOverride?: "inherit" | "on" | "off" | "light" | "standard" | "strict";
			autoContinuationOverride?: "inherit" | "always" | "blockStop" | "protectedOnly" | "off";
			tasksReminderIntervalOverride?: number | null;
		},
	) =>
		request<{ ok: boolean }>(`/narrators/${id}/reflection-overrides`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	updateNarratorBehaviorFence: (
		id: string,
		data: {
			behaviorFenceIntervalOverride?: number | null;
			behaviorFenceAttachOverride?: "inherit" | "on" | "off";
		},
	) =>
		request<{ ok: boolean }>(`/narrators/${id}/behavior-fence`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	updateNarratorPruneEnabled: (id: string, pruneEnabled: boolean) =>
		request<{ ok: boolean }>(`/narrators/${id}/prune-enabled`, {
			method: "PATCH",
			body: JSON.stringify({ pruneEnabled }),
		}),
	getCompactSummary: (narratorId: string, messageId: string) =>
		request<CompactMessageDetail>(`/narrators/${narratorId}/compact/${messageId}`),
	retryFailedCompact: (narratorId: string, messageId: string, model?: string) =>
		request<RetryFailedCompactResponse>(`/narrators/${narratorId}/compact/${messageId}/retry`, {
			method: "POST",
			body: JSON.stringify(model ? { model } : {}),
		}),
	sendNarratorMessage: async (
		narratorId: string,
		message: string,
		images?: File[],
		textFiles?: File[],
		priority?: boolean,
		onUploadProgress?: (fraction: number) => void,
		signal?: AbortSignal,
	) => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;

		const url = `${BASE}/narrators/${narratorId}/messages`;
		let res: Response;
		if (images?.length || textFiles?.length) {
			const formData = new FormData();
			formData.append("message", message);
			if (images) {
				for (const img of images) formData.append("images", img);
			}
			if (textFiles) {
				for (const tf of textFiles) formData.append("textFiles", tf);
			}
			if (priority) formData.append("priority", "true");
			// Use XHR-backed upload so we can surface real upload progress to the UI.
			res = await postFormDataWithProgress(url, formData, {
				headers,
				onProgress: onUploadProgress,
				signal,
			});
		} else {
			headers["Content-Type"] = "application/json";
			res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(priority ? { message, priority: true } : { message }),
				signal,
			});
		}
		// The XHR upload branch cannot go through authorizedFetch, so absorption
		// stays explicit here — with the token this request used, for the CAS.
		absorbRenewedToken(res, token);
		if (res.status === 401) {
			const error = await readFetchError(res, "Unauthorized");
			throw new ApiError(error.message, 401, error.data);
		}
		if (!res.ok) {
			const error = await readFetchError(res, "Request failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return res.json();
	},
	retryLastMessage: (narratorId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/retry`, { method: "POST" }),
	continueNarrator: (narratorId: string, recoveryMessageId?: string) =>
		request<{ ok: boolean; recovering?: number; deletedMessageIds?: string[] }>(
			`/narrators/${narratorId}/continue${
				recoveryMessageId ? `?recoveryMessageId=${encodeURIComponent(recoveryMessageId)}` : ""
			}`,
			{ method: "POST" },
		),
	resumeRecoverySubagents: (
		narratorId: string,
		body: { messageId: string; subagentIds: string[]; mode: "notify" | "await" },
	) =>
		request<{
			ok: boolean;
			mode: "notify" | "await";
			resumed: number;
			skipped: Array<{ id: string; reason: string }>;
		}>(`/narrators/${narratorId}/subagent-recovery`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	allowRetryToolCall: (narratorId: string, toolUseId: string) =>
		request<{ ok: boolean }>(
			`/narrators/${narratorId}/tool-calls/${encodeURIComponent(toolUseId)}/allow-retry`,
			{ method: "POST" },
		),
	rollbackToBlock: (
		narratorId: string,
		messageId: string,
		blockIndex: number,
		opts?: { skipRevert?: boolean },
	) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/rollback/${messageId}`, {
			method: "POST",
			body: JSON.stringify({ blockIndex, skipRevert: opts?.skipRevert === true }),
		}),
	editAndRegenerate: async (
		narratorId: string,
		messageId: string,
		content: string,
		rollback: boolean,
		opts?: {
			keepImageIds?: string[];
			newImages?: File[];
			keepTextFilePaths?: string[];
			newTextFiles?: File[];
		},
	) => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;

		let body: BodyInit;
		// Use multipart whenever new files (images or text files) are uploaded;
		// kept-subset ids/paths ride along so the server drops removed attachments.
		if (opts?.newImages?.length || opts?.newTextFiles?.length) {
			const formData = new FormData();
			formData.append("content", content);
			formData.append("rollback", rollback ? "true" : "false");
			if (opts.keepImageIds) {
				formData.append("keepImageIds", JSON.stringify(opts.keepImageIds));
			}
			if (opts.keepTextFilePaths) {
				formData.append("keepTextFilePaths", JSON.stringify(opts.keepTextFilePaths));
			}
			for (const img of opts.newImages ?? []) formData.append("images", img);
			for (const tf of opts.newTextFiles ?? []) formData.append("textFiles", tf);
			body = formData;
		} else {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify({
				content,
				rollback,
				...(opts?.keepImageIds ? { keepImageIds: opts.keepImageIds } : {}),
				...(opts?.keepTextFilePaths ? { keepTextFilePaths: opts.keepTextFilePaths } : {}),
			});
		}

		const res = await fetch(`${BASE}/narrators/${narratorId}/edit-and-regenerate/${messageId}`, {
			method: "POST",
			headers,
			body,
		});
		absorbRenewedToken(res, token);
		if (res.status === 401) {
			const error = await readFetchError(res, "Unauthorized");
			throw new ApiError(error.message, 401, error.data);
		}
		if (!res.ok) {
			const error = await readFetchError(res, "Request failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		const result = (await res.json()) as { ok?: unknown };
		return result.ok === true;
	},
	editAssistantMessage: (narratorId: string, messageId: string, content: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/edit-message/${messageId}`, {
			method: "POST",
			body: JSON.stringify({ content }),
		}),
	restoreAssistantMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/restore-message/${messageId}`, {
			method: "POST",
		}),
	triggerCompact: (narratorId: string, beforeMessageId?: string) =>
		request<{ ok: boolean; fallbackSummary?: boolean; fallbackReason?: string; summary?: string }>(
			`/narrators/${narratorId}/compact`,
			{
				method: "POST",
				body: JSON.stringify(beforeMessageId ? { beforeMessageId } : {}),
			},
		),
	cancelCompact: (narratorId: string) =>
		request<{ ok: boolean; reason?: string }>(`/narrators/${narratorId}/compact/cancel`, {
			method: "POST",
		}),
	clearContext: (narratorId: string, beforeMessageId?: string) =>
		request<{ ok: boolean; messageId?: string }>(`/narrators/${narratorId}/clear-context`, {
			method: "POST",
			body: JSON.stringify(beforeMessageId ? { beforeMessageId } : {}),
		}),
	createPlan: (narratorId: string, content: string) =>
		request<ApiEntity>(`/narrators/${narratorId}/plan`, {
			method: "POST",
			body: JSON.stringify({ content }),
		}),
	deleteCompactMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/compact/${messageId}`, {
			method: "DELETE",
		}),
	deleteMessage: (narratorId: string, messageId: string, opts?: { skipRevert?: boolean }) =>
		request<{ ok: boolean; deletedCount: number }>(
			`/narrators/${narratorId}/messages/${messageId}${opts?.skipRevert ? "?skipRevert=1" : ""}`,
			{
				method: "DELETE",
			},
		),
	dismissSpecCarryoverMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedMessageIds: string[] }>(
			`/narrators/${narratorId}/spec-carryover-messages/${messageId}`,
			{
				method: "DELETE",
			},
		),
	dismissCwdRecoveryMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedMessageIds: string[] }>(
			`/narrators/${narratorId}/cwd-recovery-messages/${messageId}`,
			{
				method: "DELETE",
			},
		),
	dismissErrorMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedMessageIds: string[] }>(
			`/narrators/${narratorId}/error-messages/${messageId}`,
			{
				method: "DELETE",
			},
		),
	deleteMessageBlock: (
		narratorId: string,
		messageId: string,
		blockIndex: number,
		opts?: { skipRevert?: boolean },
	) =>
		request<{ ok: boolean; messageDeleted: boolean }>(
			`/narrators/${narratorId}/messages/${messageId}/blocks/${blockIndex}${
				opts?.skipRevert ? "?skipRevert=1" : ""
			}`,
			{ method: "DELETE" },
		),
	deleteMessageBlocks: (
		narratorId: string,
		blocks: Array<{ messageId: string; blockIndex: number }>,
		opts?: { skipRevert?: boolean },
	) =>
		request<{ ok: boolean; deleted: number; failed: number }>(
			`/narrators/${narratorId}/messages/batch-blocks`,
			{
				method: "DELETE",
				body: JSON.stringify({ blocks, skipRevert: opts?.skipRevert === true }),
			},
		),
	updateCompactSummary: (narratorId: string, messageId: string, summary: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/compact/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ summary }),
		}),

	// Segment compact
	triggerSegmentCompact: (narratorId: string, messageIds: string[]) =>
		request<{
			ok: boolean;
			fallbackSummary?: boolean;
			fallbackReason?: string;
			summary?: string;
			messageCount?: number;
		}>(`/narrators/${narratorId}/segment-compact`, {
			method: "POST",
			body: JSON.stringify({ messageIds }),
		}),
	getSegmentCompactSummary: (narratorId: string, messageId: string) =>
		request<{ summary: string }>(`/narrators/${narratorId}/segment-compact/${messageId}`),
	getSegmentCompactMessages: (narratorId: string, messageId: string) =>
		request<{ messages: unknown[] }>(
			`/narrators/${narratorId}/segment-compact/${messageId}/messages`,
		),
	deleteSegmentCompact: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/segment-compact/${messageId}`, {
			method: "DELETE",
		}),
	updateSegmentCompactSummary: (narratorId: string, messageId: string, summary: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/segment-compact/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ summary }),
		}),

	// File modifications
	getFileModifications: (narratorId: string, upToMessageId?: string, fromMessageId?: string) => {
		const params = new URLSearchParams();
		if (upToMessageId) params.set("upToMessageId", upToMessageId);
		if (fromMessageId) params.set("fromMessageId", fromMessageId);
		const qs = params.toString();
		return request<{
			files: Array<{
				deviceId: string;
				filePath: string;
				snapshotId: string;
				originalExists: boolean;
				editCount: number;
				lastModifiedAt: string;
				operations: Array<{
					toolUseId: string;
					toolName: string;
					messageId: string;
					createdAt: string;
				}>;
			}>;
			timeline: Array<{
				messageId: string;
				createdAt: string;
				seq: number;
				role: string;
				hasEdits: boolean;
			}>;
		}>(`/narrators/${narratorId}/file-modifications${qs ? `?${qs}` : ""}`);
	},
	getFileDiff: (
		narratorId: string,
		snapshotId: string,
		upToMessageId?: string,
		fromMessageId?: string,
	) => {
		const params = new URLSearchParams();
		if (upToMessageId) params.set("upToMessageId", upToMessageId);
		if (fromMessageId) params.set("fromMessageId", fromMessageId);
		const qs = params.toString();
		return request<{
			deviceId: string;
			filePath: string;
			original: string | null;
			current: string | null;
		}>(`/narrators/${narratorId}/patches/${snapshotId}/diff${qs ? `?${qs}` : ""}`);
	},
	revertFile: (narratorId: string, target: { deviceId: string; filePath: string }) =>
		request<{ success: boolean; originalExists: boolean }>(`/narrators/${narratorId}/revert-file`, {
			method: "POST",
			body: JSON.stringify(target),
		}),
	revertAllFiles: (narratorId: string) =>
		request<{ fileCount: number; files: string[] }>(`/narrators/${narratorId}/revert`, {
			method: "POST",
			body: JSON.stringify({ messageId: "__all__" }),
		}),
	unrevertAll: (narratorId: string) =>
		request<{ success: boolean }>(`/narrators/${narratorId}/unrevert`, { method: "POST" }),
	getDeletePreview: (narratorId: string, messageId: string) =>
		request<{
			affectedFiles: Array<{
				deviceId: string;
				filePath: string;
				currentContent: string | null;
				revertedContent: string | null;
				willBeDeleted: boolean;
			}>;
			toolCallCount: number;
		}>(`/narrators/${narratorId}/delete-preview?messageId=${encodeURIComponent(messageId)}`),
	getRollbackPreview: (narratorId: string, messageId: string, blockIndex: number) =>
		request<{
			affectedFiles: Array<{
				deviceId: string;
				filePath: string;
				willBeDeleted: boolean;
			}>;
			toolCallCount: number;
			deletedBlockCount: number;
			deletedMessageCount: number;
		}>(
			`/narrators/${narratorId}/rollback-preview?messageId=${encodeURIComponent(messageId)}&blockIndex=${blockIndex}`,
		),
	getPermissionFilePreview: (narratorId: string, toolUseId: string) =>
		request<{
			deviceId: string;
			filePath: string;
			currentContent: string | null;
			previewContent: string | null;
			toolName: string;
			inputJson: Record<string, unknown>;
		}>(
			`/narrators/${narratorId}/permission-file-preview?toolUseId=${encodeURIComponent(toolUseId)}`,
		),

	// Narrator Fork (standalone sessions only).
	// The fork point is identified by the local narrator message id: only
	// assistant messages carry an SDK uuid, so a uuid-only contract cannot fork
	// from a user message.
	forkNarrator: (
		narratorId: string,
		forkMessageId: string,
		title?: string,
		inheritMode?: "full" | "compressed" | "fresh",
	) =>
		request<ApiEntity>(`/narrators/${narratorId}/fork`, {
			method: "POST",
			body: JSON.stringify({ forkMessageId, title, inheritMode }),
		}),
	startAskInPassing: (
		narratorId: string,
		opts: { sourceMessageId: string; sourceMessageUuid?: string },
	) =>
		request<{ messageId: string }>(`/narrators/${narratorId}/ask-in-passing/start`, {
			method: "POST",
			body: JSON.stringify(opts),
		}),
	askInPassing: (
		narratorId: string,
		opts: {
			question: string;
			pendingMessageId: string;
		},
	) =>
		request<ApiEntity>(`/narrators/${narratorId}/ask-in-passing`, {
			method: "POST",
			body: JSON.stringify(opts),
		}),
	cancelAskInPassing: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/ask-in-passing/${messageId}`, {
			method: "DELETE",
		}),
	promoteNarrator: (narratorId: string) =>
		request<{ type: "unlocked" | "forked"; narrator?: ApiEntity; chapter?: ApiEntity }>(
			`/narrators/${narratorId}/promote`,
			{ method: "POST" },
		),
	forkFromMessages: (narratorId: string, messageIds: string[], title?: string) =>
		request<ApiEntity>(`/narrators/${narratorId}/fork-messages`, {
			method: "POST",
			body: JSON.stringify({ messageIds, title }),
		}),

	// Optional tools (Browser, Terminal, ...) — `toolId` is the routine id, e.g. "browser"
	getOptionalToolState: (narratorId: string, toolId: string) =>
		request<{
			toolId: string;
			toolNames: string[];
			loaded: boolean;
			disabledByTrait: boolean;
			globallyEnabled: boolean;
		}>(`/narrators/${narratorId}/optional-tools/${toolId}`),
	loadOptionalTool: (narratorId: string, toolId: string) =>
		request<{ toolName: string; loaded: boolean; alreadyLoaded: boolean }>(
			`/narrators/${narratorId}/optional-tools/${toolId}/load`,
			{ method: "POST" },
		),

	// Browser sessions
	listBrowserSessions: (narratorId: string) =>
		request<
			{
				id: string;
				url: string;
				lastActivity: number;
				ttlMs: number;
				expiresAt: number;
				headless: boolean;
				tracing: { active: boolean; startedAt: number } | null;
				networkRequestCount: number;
				networkCaptureEnabled: boolean;
				viewport: { width: number; height: number };
			}[]
		>(`/narrators/${narratorId}/browser-sessions`),
	closeBrowserSession: (narratorId: string, sessionId: string) =>
		request(`/narrators/${narratorId}/browser-sessions/${sessionId}`, { method: "DELETE" }),
	setBrowserSessionTtl: (narratorId: string, sessionId: string, ttlMs: number) =>
		request(`/narrators/${narratorId}/browser-sessions/${sessionId}/ttl`, {
			method: "PATCH",
			body: JSON.stringify({ ttlMs }),
		}),
	stopBrowserTracing: (narratorId: string, sessionId: string) =>
		request(`/narrators/${narratorId}/browser-sessions/${sessionId}/stop-tracing`, {
			method: "POST",
		}),
	interactBrowserSession: (
		narratorId: string,
		sessionId: string,
		params: {
			action: "click" | "scroll" | "drag" | "type";
			coordinate?: { x: number; y: number };
			endCoordinate?: { x: number; y: number };
			direction?: "up" | "down";
			amount?: number;
			text?: string;
			key?: string;
			keys?: Array<{ text?: string; key?: string }>;
		},
	) =>
		authorizedFetch(`/api/narrators/${narratorId}/browser-sessions/${sessionId}/interact`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		}).then(async (res) => {
			if (!res.ok) throw new Error(`interact failed: ${res.status}`);
			return res.blob();
		}),
	/**
	 * Fetch the raw SSE request/response dump for a leaked-tool-call diagnostic.
	 * Narrator-scoped so non-admin users can download the data while debugging.
	 */
	getLeakedToolDump: (narratorId: string, apiRequestId: string) =>
		request<{
			id: string;
			narratorId: string;
			provider: string;
			model: string;
			createdAt: string;
			errorMessage: string | null;
			rawDump: unknown;
		}>(`/narrators/${narratorId}/leaked-tool-dump/${apiRequestId}`),
};
