import type { AsyncQuestion, HumanAttentionDetail } from "@frontend/types/narrator";
import type { UsageHistoryStats } from "@frontend/types/usage-history";
import type { BackgroundTaskListPage } from "@shared/background-task-list";
import type { FileChangeEvidenceUncertaintyWarning } from "@shared/file-change-protocol";
import type { FileReference } from "@shared/file-reference";
import type { HumanAttentionPage } from "@shared/human-attention";
import type { SubagentModelPools, SubagentModelUse } from "@shared/subagent-model-policy";
import type { ToolEditPreview } from "@shared/tool-edit-preview";
import {
	ApiError,
	absorbRenewedToken,
	apiBase,
	authorizedFetch,
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
	CommandBlacklistRuleInput,
	CommandWhitelistRuleInput,
	CompactMessageDetail,
	DirectoryBlacklistRuleInput,
	DirectoryWhitelistRuleInput,
	MessageLocationResult,
	NarratorAccess,
	NarratorGrant,
	NarratorGrantAccess,
	NarratorGrantBatchResult,
	NarratorMessageSearchResponse,
	NarratorVisibility,
	NarratorWriteAudience,
	PaginatedNarrators,
	PretextDocumentPageResult,
	RuleTargetSelector,
	WhitelistCmd,
	WhitelistDir,
} from "./types";
import { normalizeRuleTargetSelector, selectorToLegacyDeviceScope } from "./types";

/** Persisted row identity; a provider's tool-use id alone need not be unique. */
export interface ToolCallDetailRef {
	toolCallId?: string;
	messageId?: string;
	/** Cache discriminator only; never a substitute for a row PK or message ref. */
	executionAttempt?: number;
}

export function toolCallDetailQueryKey(
	narratorId: string,
	toolUseId: string,
	ref?: ToolCallDetailRef,
) {
	return [
		"narrators",
		narratorId,
		"tool-calls",
		toolUseId,
		ref?.toolCallId ?? null,
		ref?.messageId ?? null,
		ref?.executionAttempt ?? null,
	] as const;
}

export function shouldClearEditDraft(result: unknown): result is true {
	return result === true;
}

/**
 * Read the download filename out of a `Content-Disposition` header.
 *
 * `filename*` (RFC 5987) wins when present because it carries the real, possibly
 * non-ASCII title; the quoted `filename` is the ASCII fallback. Returns null when
 * the header is absent or unparseable, leaving the caller to name the file.
 *
 * Any path separators in the result are dropped: the value comes from a server
 * response and is about to become a download name, so it must not be able to
 * express a path.
 */
export function parseContentDispositionFileName(header: string | null): string | null {
	if (!header) return null;

	const extended = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
	if (extended?.[1]) {
		try {
			const decoded = decodeURIComponent(extended[1].trim());
			const safe = sanitizeDownloadName(decoded);
			if (safe) return safe;
		} catch {
			// Malformed percent-encoding: fall through to the plain filename.
		}
	}

	const plain =
		header.match(/filename\s*=\s*"([^"]*)"/i) ?? header.match(/filename\s*=\s*([^;]+)/i);
	if (plain?.[1]) return sanitizeDownloadName(plain[1].trim());
	return null;
}

function sanitizeDownloadName(value: string): string | null {
	const base = value.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
	if (!base || base === "." || base === "..") return null;
	return base;
}

/**
 * How wide a file rollback reaches. `narrator` undoes only this narrator's own
 * changes; `workspace` restores every file in the window.
 */
export type RevertScope = "narrator" | "workspace";

/**
 * Why a rollback scope is unavailable for a window.
 *
 * `nothing_owned` is the only non-blocking reason: with `available: true`, it
 * proves this narrator changed nothing. Every other reason blocks file rollback,
 * without automatically selecting a wider scope or replaying legacy tool inputs.
 */
export type ScopedRevertUnavailableReason =
	| "no_boundaries"
	| "snapshot_missing"
	| "no_workspace"
	| "git_unsupported"
	| "window_too_large"
	| "legacy_unverified"
	| "execution_unavailable"
	| "runtime_reload_required"
	| "incomplete_coverage"
	| "unsupported_target"
	| "pending_operations"
	| "nothing_owned";

/**
 * Structured advisory about changes a rollback discarded beyond the intended scope.
 *
 * The server sends codes and counts rather than sentences so this bilingual UI can
 * translate them.
 */
export type RevertWarning =
	| FileChangeEvidenceUncertaintyWarning
	| {
			code: "WORKSPACE_SCOPE_DISCARDED_OTHERS";
			otherActorCount: number;
			externalCount: number;
			unserializedCount: number;
			/**
			 * Human edits in the window. Optional for wire compatibility with a server
			 * that predates the field; absent is read as zero.
			 */
			humanCount?: number;
			sampleFilePaths: string[];
	  }
	| {
			code: "SUBAGENT_CHANGES_REVERTED";
			changeCount: number;
			sampleFilePaths: string[];
	  };

export type RevertAction = "rollback_to_block" | "delete_tool_block" | "revert_files";

export interface RevertActionTarget {
	messageId: string;
	blockIndex?: number;
}

/** The exact durable plan reviewed by the user, never a request to re-plan. */
export interface RevertPlanConfirmation {
	planId: string;
	planHash: string;
	action: RevertAction;
}

export interface RevertActionConfirmOptions {
	skipRevert: boolean;
	scope?: RevertScope;
	revertPlan?: RevertPlanConfirmation;
}

export interface RevertActionPlan {
	id: string;
	planHash: string | null;
	status: string;
	coverageComplete: boolean;
	expectedFileCount: number;
	expiresAt: string;
	expired: boolean;
	kind: "revert" | "history_delete" | "rollback_to_block";
	selectorKind: string;
}

export interface RevertHistorySummary {
	deletedMessageCount: number;
	deletedBlockCount: number;
}

export interface RevertActionPreview {
	action: RevertAction;
	plan: RevertActionPlan | null;
	executable: false;
	historySummary: RevertHistorySummary | null;
	unavailable?: ScopedRevertUnavailableReason;
}

/** Bounded metadata only; snapshots and file contents are not loaded by this UI. */
export interface RevertPlanFile {
	id: string;
	fileKey: string;
	sequence: number;
	identityJson: {
		deviceId: string;
		displayPath: string;
		lexicalPath: string;
		canonicalPath: string;
	};
	expectedStateJson: { kind: "absent" | "regular" | "symlink" | "unknown" };
	desiredStateJson: { kind: "absent" | "regular" | "symlink" };
}

export interface RevertPlanFilesPage {
	items: RevertPlanFile[];
	hasMore: boolean;
	nextCursor: { fileKey: string } | null;
	executable: false;
}

export interface RevertPlanApplyResult {
	planId: string;
	status: "committed" | "compensated" | "recovery_required";
	journalStatus: string;
	settling: boolean;
	reason: string | null;
}

export type RevertPlanPreviewIssue =
	| "expired"
	| "not_prepared"
	| "preview_failed"
	| "incomplete_files"
	| "window_too_large"
	| "reload_required";

/** UI-only review state, tied to one target and one opening/reload. */
export interface RevertPlanReview extends Omit<RevertActionPlan, "id"> {
	planId: string;
	action: RevertAction;
	previewKey: string;
	filesComplete: boolean;
}

export interface RevertPreviewFile {
	fileKey?: string;
	deviceId: string;
	filePath: string;
	willBeDeleted: boolean;
}

export interface RevertPreviewFileWithContent extends RevertPreviewFile {
	currentContent: string | null;
	revertedContent: string | null;
}

/**
 * What deleting a single tool_use block would roll back.
 *
 * Narrower than {@link RevertScopePreviews}: a block is one recorded call, so there
 * is no scope to choose between. `available: false` means the change cannot be
 * reversed safely. Only history-only deletion is permitted; legacy tool inputs
 * are not evidence that authorizes writing files.
 */
export interface BlockDeletePreview {
	available: boolean;
	reason?: ScopedRevertUnavailableReason | "not_a_tool_use";
	files: RevertPreviewFileWithContent[];
	/** Paths another actor changed in the same regions; deletion would be refused. */
	conflicts: string[];
	subagentWarning?: { changeCount: number; sampleFiles: string[] };
}

/**
 * Both rollback scopes for one window, so the dialog can compare them.
 *
 * Scope metadata remains optional for older preview responses. Missing metadata
 * is unverified, not permission to replay `affectedFiles` or proof of no changes.
 * `scope` is only a recommendation; workspace rollback always needs an explicit
 * user choice and an available, complete preview.
 */
export interface RevertScopePreviews<F extends RevertPreviewFile = RevertPreviewFile> {
	/** Present only for the new action-preview + paged-files flow. */
	revertPlan?: RevertPlanReview;
	previewIssue?: RevertPlanPreviewIssue;
	previewError?: string;
	scope?: RevertScope;
	affectedFiles: F[];
	narratorScope?: {
		available: boolean;
		reason?: ScopedRevertUnavailableReason;
		files: F[];
		/** A truncated preview cannot authorize a file rollback. */
		totalFileCount?: number;
		hasMore?: boolean;
		/** Paths another actor changed in the same regions; blocks a scoped rollback. */
		conflicts: string[];
		/** Subagent changes this rollback would also revert. */
		subagentWarning?: { changeCount: number; sampleFiles: string[] };
	};
	workspaceScope?: {
		available: boolean;
		reason?: ScopedRevertUnavailableReason;
		files: F[];
		warnings: RevertWarning[];
	};
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

/** One level of a remote device's directory tree, in that device's path syntax. */
export interface RemoteDirectoryListing {
	path: string;
	/** `isSymlink` is absent on executors predating symlink resolution. */
	entries: Array<{ name: string; path: string; isDirectory: boolean; isSymlink?: boolean }>;
	parent: string | null;
	sep: string;
	truncated: boolean;
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

export interface NarratorCustomTraits {
	subagentModelRestriction: { version: 1; pools: SubagentModelPools } | null;
	disabledTools: { version: 1; tools: string[] } | null;
	blockedSkills: { version: 1; all: boolean; names: string[] } | null;
	availableModels: SubagentModelUse[];
	availableTools: { name: string; description: string; category: string }[];
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

	/**
	 * Upload a custom bitmap avatar for a narrator, replacing any previous one.
	 * Without one the UI shows the identicon derived from the narrator id.
	 */
	uploadNarratorAvatar: async (id: string, file: File) => {
		const formData = new FormData();
		formData.append("file", file);
		const res = await authorizedFetch(`${apiBase()}/narrators/${id}/avatar`, {
			method: "PATCH",
			body: formData,
		});
		if (!res.ok) {
			const error = await readFetchError(res, "Upload failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return res.json() as Promise<{ ok: boolean; avatarImageId: string }>;
	},
	/** Drop the custom avatar, falling back to the procedural identicon. */
	deleteNarratorAvatar: (id: string) =>
		request<{ ok: boolean }>(`/narrators/${id}/avatar`, { method: "DELETE" }),
	getNarratorDraft: (id: string) =>
		request<{
			hasDraft: boolean;
			text: string;
			fileReferences?: FileReference[];
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
		}>(`/narrators/${id}/draft`),
	updateNarratorDraft: (
		id: string,
		text: string,
		baseRevision: number,
		sourceId?: string,
		fileReferences?: FileReference[],
	) =>
		request<{
			ok: boolean;
			traits: string[];
			hasDraft: boolean;
			text: string;
			fileReferences?: FileReference[];
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
		}>(`/narrators/${id}/draft`, {
			method: "PUT",
			body: JSON.stringify({ text, baseRevision, sourceId, fileReferences }),
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
		fastModeOverride?: "inherit" | "on" | "off";
		relaxedPlan?: boolean;
		planReflectionAutoApproveOverride?: "inherit" | "on" | "off";
		dangerReflectionOverride?: "inherit" | "on" | "off" | "light" | "standard" | "strict";
		autoContinuationOverride?: "inherit" | "always" | "blockStop" | "protectedOnly" | "off";
		behaviorFenceIntervalOverride?: number | null;
		behaviorFenceAttachOverride?: "inherit" | "on" | "off";
		cwd?: string;
		makeNamed?: boolean;
		handle?: string;
		kind?: "knowledge" | "setup";
	}) => request<ApiEntity>("/narrators", { method: "POST", body: JSON.stringify(data) }),
	/**
	 * Spawn a Setup Assistant narrator that installs the missing system
	 * dependencies on this machine. Returns `created: false` when nothing
	 * installable is missing, so callers can report "already good" instead of
	 * opening an empty session. Admin-only on the server.
	 *
	 * `authorization` must reflect an explicit user choice: "full" grants
	 * bypassPermissions (with strict danger reflection, i.e. a same-model review
	 * turn for classifier-flagged calls), "default" keeps per-command approval
	 * cards. Omitting it means "default" — never silently grant more.
	 */
	createSetupAssistantNarrator: (data?: { authorization?: "full" | "default" }) =>
		request<{
			created: boolean;
			authorization?: "full" | "default";
			narrator?: ApiEntity;
			dependencies: {
				platform: "windows" | "macos" | "linux";
				packageManager?: string;
				dependencies: Array<{
					name: string;
					required: boolean;
					installed: boolean;
					platformSupported: boolean;
				}>;
				allRequiredMet: boolean;
			};
		}>("/narrators/setup-assistant", {
			method: "POST",
			body: JSON.stringify({ authorization: data?.authorization ?? "default" }),
		}),
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
	// Resolve a message id to its top-level seq coordinate (jump-to-message).
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
	/**
	 * Download the transcript as Markdown or JSON.
	 *
	 * Returns a Blob plus the server-proposed filename rather than going through
	 * `request`, which assumes a JSON body. The response is streamed by the server,
	 * so the browser can start writing to disk before the export finishes.
	 */
	exportNarratorMessages: async (
		id: string,
		opts: {
			format: "markdown" | "json";
			scope: "full" | "visible";
			includeToolIO: boolean;
			lang: string;
		},
	) => {
		const params = new URLSearchParams({
			format: opts.format,
			scope: opts.scope,
			includeToolIO: String(opts.includeToolIO),
			// The server only localizes Markdown labels for the languages it knows.
			lang: opts.lang === "zh-CN" ? "zh-CN" : "en",
		});
		const res = await authorizedFetch(`${apiBase()}/narrators/${id}/export?${params.toString()}`);
		if (!res.ok) {
			const error = await readFetchError(res, "Export failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return {
			blob: await res.blob(),
			fileName: parseContentDispositionFileName(res.headers.get("content-disposition")),
		};
	},
	getToolCallDetail: (
		narratorId: string,
		toolUseId: string,
		ref?: ToolCallDetailRef,
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams();
		if (ref?.toolCallId !== undefined) params.set("toolCallId", ref.toolCallId);
		if (ref?.messageId !== undefined) params.set("messageId", ref.messageId);
		const query = params.size ? `?${params}` : "";
		return request<ApiEntity>(
			`/narrators/${encodeURIComponent(narratorId)}/tool-calls/${encodeURIComponent(toolUseId)}${query}`,
			{ signal },
		);
	},
	getToolEditPreview: (
		narratorId: string,
		toolUseId: string,
		ref?: ToolCallDetailRef,
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams();
		if (ref?.toolCallId !== undefined) params.set("toolCallId", ref.toolCallId);
		if (ref?.messageId !== undefined) params.set("messageId", ref.messageId);
		return request<ToolEditPreview>(
			`/narrators/${encodeURIComponent(narratorId)}/tool-calls/${encodeURIComponent(toolUseId)}/file-edit-preview${params.size ? `?${params}` : ""}`,
			{ signal },
		);
	},
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
	/**
	 * One cursor page of a narrator's background tasks, newest first.
	 *
	 * Paged because a long-lived narrator accumulates hundreds of long-finished
	 * tasks; the previous unpaged version re-sent all of them every few seconds.
	 * Steady-state updates arrive as `background_task_list_delta` WS frames — do
	 * NOT add a `refetchInterval` to callers of this.
	 */
	listBackgroundTasks: (narratorId: string, opts?: { limit?: number; cursor?: string | null }) => {
		const params = new URLSearchParams();
		if (opts?.limit != null) params.set("limit", String(opts.limit));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		const query = params.size > 0 ? `?${params.toString()}` : "";
		return request<BackgroundTaskListPage>(`/narrators/${narratorId}/background-tasks${query}`);
	},
	/** Resolve an Await/Send target to its subagent narrator id (one-shot; never polled). */
	resolveBackgroundTaskTarget: (narratorId: string, target: string) =>
		request<{ subagentNarratorId: string | null }>(
			`/narrators/${narratorId}/background-tasks/resolve?target=${encodeURIComponent(target)}`,
		),
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
	/**
	 * Edit a queued message's text and/or its attachments.
	 *
	 * Omitting both keep lists means "keep every attachment", which is what a
	 * text-only edit wants. Passing them replaces the set; new uploads switch the
	 * request to multipart.
	 */
	updateBufferedMessage: async (
		narratorId: string,
		messageId: string,
		text: string,
		opts?: {
			keepImageIds?: string[];
			keepTextFiles?: { index: number; filename: string }[];
			newImages?: File[];
			newTextFiles?: File[];
			fileReferences?: FileReference[];
		},
	) => {
		const path = `/narrators/${narratorId}/buffer/${messageId}`;
		if (!opts?.newImages?.length && !opts?.newTextFiles?.length) {
			return request<{ ok: boolean }>(path, {
				method: "PATCH",
				body: JSON.stringify({
					text,
					...(opts?.keepImageIds ? { keepImageIds: opts.keepImageIds } : {}),
					...(opts?.keepTextFiles ? { keepTextFiles: opts.keepTextFiles } : {}),
					fileReferences: opts?.fileReferences,
				}),
			});
		}
		const formData = new FormData();
		formData.append("text", text);
		if (opts.keepImageIds) formData.append("keepImageIds", JSON.stringify(opts.keepImageIds));
		if (opts.keepTextFiles) formData.append("keepTextFiles", JSON.stringify(opts.keepTextFiles));
		if (opts.fileReferences !== undefined) {
			formData.append("fileReferences", JSON.stringify(opts.fileReferences));
		}
		for (const img of opts.newImages ?? []) formData.append("images", img);
		for (const tf of opts.newTextFiles ?? []) formData.append("textFiles", tf);
		// Content-Type is left unset so the browser adds the multipart boundary.
		const res = await authorizedFetch(`${apiBase()}${path}`, { method: "PATCH", body: formData });
		if (!res.ok) {
			const error = await readFetchError(res, "Request failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return (await res.json()) as { ok: boolean };
	},
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
	getHumanAttention: (params?: { cursor?: string; limit?: number }, signal?: AbortSignal) => {
		const query = new URLSearchParams();
		if (params?.cursor) query.set("cursor", params.cursor);
		if (params?.limit !== undefined) query.set("limit", String(params.limit));
		const suffix = query.size > 0 ? `?${query.toString()}` : "";
		return request<HumanAttentionPage>(`/narrators/human-attention${suffix}`, { signal });
	},
	getHumanAttentionDetail: (id: string, signal?: AbortSignal) =>
		request<HumanAttentionDetail>(`/narrators/human-attention/${encodeURIComponent(id)}`, {
			signal,
		}),
	getPendingPermissions: (id: string) => request<ApiEntity[]>(`/narrators/${id}/permissions`),
	// Async AskUserQuestion inbox — separate from permissions because nothing is
	// suspended waiting for these (see the AsyncQuestion type).
	//
	// The GLOBAL variant answers "is anything waiting on me anywhere", which the
	// per-narrator one structurally cannot.
	getAllAsyncQuestions: () =>
		request<{
			items: (AsyncQuestion & { narratorTitle: string | null; chapterId: string | null })[];
			openCount: number;
			awaitedCount: number;
		}>("/narrators/questions/all"),
	getAsyncQuestions: (
		id: string,
		params?: { status?: string; cursor?: string; limit?: number },
	) => {
		const query = new URLSearchParams();
		if (params?.status) query.set("status", params.status);
		if (params?.cursor) query.set("cursor", params.cursor);
		if (params?.limit !== undefined) query.set("limit", String(params.limit));
		const suffix = query.size > 0 ? `?${query.toString()}` : "";
		return request<{ items: AsyncQuestion[]; nextCursor: string | null; openCount: number }>(
			`/narrators/${id}/questions${suffix}`,
		);
	},
	answerAsyncQuestion: (
		narratorId: string,
		questionId: string,
		payload: {
			answers: Record<string, string>;
			annotations?: Record<string, { preview?: string; notes?: string }>;
		},
	) =>
		request<{ ok: boolean; question: AsyncQuestion }>(
			`/narrators/${narratorId}/questions/${questionId}/answer`,
			{ method: "POST", body: JSON.stringify(payload) },
		),
	dismissAsyncQuestion: (narratorId: string, questionId: string) =>
		request<{ ok: boolean; question: AsyncQuestion }>(
			`/narrators/${narratorId}/questions/${questionId}/dismiss`,
			{ method: "POST" },
		),
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
	// "Answer later": release the loop without deciding, moving the question to the
	// async inbox. Not a deny — the question is accepted, just postponed.
	deferPermissionQuestion: (requestId: string) =>
		request<{ ok: boolean }>(`/narrators/permissions/${requestId}/defer`, { method: "POST" }),
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
	getCustomTraits: (id: string) => request<NarratorCustomTraits>(`/narrators/${id}/custom-traits`),
	updateSubagentModelRestriction: (id: string, pools: SubagentModelPools) =>
		request<{ ok: boolean; traits: string[]; customTraits: NarratorCustomTraits }>(
			`/narrators/${id}/custom-traits/subagent-model-restriction`,
			{ method: "PUT", body: JSON.stringify({ pools }) },
		),
	clearSubagentModelRestriction: (id: string) =>
		request<{ ok: boolean; traits: string[]; customTraits: NarratorCustomTraits }>(
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
	/**
	 * Browse one level of a device's filesystem through a narrator's device
	 * authorization, so non-admin users can use the remote path picker.
	 */
	browseNarratorDevice: (
		id: string,
		deviceId: string,
		path?: string,
		opts?: { showHidden?: boolean },
	) => {
		const params = new URLSearchParams({ deviceId });
		if (path) params.set("path", path);
		if (opts?.showHidden) params.set("showHidden", "1");
		return request<RemoteDirectoryListing>(`/narrators/${id}/device-browse?${params}`);
	},
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
	updateNarratorFastMode: (id: string, fastModeOverride: "inherit" | "on" | "off") =>
		request<{ ok: boolean; fastModeOverride: "inherit" | "on" | "off"; fastMode: boolean }>(
			`/narrators/${id}/fast-mode`,
			{
				method: "PATCH",
				body: JSON.stringify({ fastModeOverride }),
			},
		),
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
		fileReferences?: FileReference[],
	) => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;

		const url = `${apiBase()}/narrators/${narratorId}/messages`;
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
			if (fileReferences !== undefined) {
				formData.append("fileReferences", JSON.stringify(fileReferences));
			}
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
				body: JSON.stringify({ message, ...(priority ? { priority: true } : {}), fileReferences }),
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
	previewRevertAction: (
		narratorId: string,
		body: RevertActionTarget & { action: RevertAction; idempotencyKey: string },
		signal?: AbortSignal,
	) =>
		request<RevertActionPreview>(`/narrators/${narratorId}/revert-action-preview`, {
			method: "POST",
			body: JSON.stringify(body),
			signal,
		}),
	getRevertPlanFiles: (
		narratorId: string,
		planId: string,
		params: { limit: number; cursor?: string },
		signal?: AbortSignal,
	) => {
		const query = new URLSearchParams({ limit: String(params.limit) });
		if (params.cursor !== undefined) query.set("cursor", params.cursor);
		return request<RevertPlanFilesPage>(
			`/narrators/${narratorId}/revert-plans/${encodeURIComponent(planId)}/files?${query}`,
			{ signal },
		);
	},
	applyRevertPlan: (narratorId: string, plan: RevertPlanConfirmation) =>
		request<RevertPlanApplyResult>(
			`/narrators/${narratorId}/revert-plans/${encodeURIComponent(plan.planId)}/apply`,
			{
				method: "POST",
				body: JSON.stringify({ planHash: plan.planHash, action: plan.action }),
			},
		),
	rollbackToBlock: (
		narratorId: string,
		messageId: string,
		blockIndex: number,
		opts?: { skipRevert?: boolean; scope?: RevertScope },
	) =>
		request<{ ok: boolean; warnings?: RevertWarning[] }>(
			`/narrators/${narratorId}/rollback/${messageId}`,
			{
				method: "POST",
				body: JSON.stringify({
					blockIndex,
					skipRevert: opts?.skipRevert === true,
					...(opts?.scope ? { scope: opts.scope } : {}),
				}),
			},
		),
	/**
	 * Edit a user message and regenerate from it.
	 *
	 * `skipRevert` / `scope` are the same two choices rollback-to-block offers, and
	 * they are sent explicitly: the superseded `rollback` flag was accepted by the
	 * server and then ignored, so every edit reverted files regardless of it.
	 */
	editAndRegenerate: async (
		narratorId: string,
		messageId: string,
		content: string,
		opts?: {
			skipRevert?: boolean;
			scope?: RevertScope;
			keepImageIds?: string[];
			newImages?: File[];
			keepTextFilePaths?: string[];
			newTextFiles?: File[];
			fileReferences?: FileReference[];
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
			if (opts.skipRevert !== undefined) {
				formData.append("skipRevert", opts.skipRevert ? "true" : "false");
			}
			if (opts.scope) formData.append("scope", opts.scope);
			if (opts.keepImageIds) {
				formData.append("keepImageIds", JSON.stringify(opts.keepImageIds));
			}
			if (opts.keepTextFilePaths) {
				formData.append("keepTextFilePaths", JSON.stringify(opts.keepTextFilePaths));
			}
			if (opts.fileReferences !== undefined) {
				formData.append("fileReferences", JSON.stringify(opts.fileReferences));
			}
			for (const img of opts.newImages ?? []) formData.append("images", img);
			for (const tf of opts.newTextFiles ?? []) formData.append("textFiles", tf);
			body = formData;
		} else {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify({
				content,
				...(opts?.skipRevert !== undefined ? { skipRevert: opts.skipRevert } : {}),
				...(opts?.scope ? { scope: opts.scope } : {}),
				...(opts?.keepImageIds ? { keepImageIds: opts.keepImageIds } : {}),
				...(opts?.keepTextFilePaths ? { keepTextFilePaths: opts.keepTextFilePaths } : {}),
				fileReferences: opts?.fileReferences,
			});
		}

		const res = await fetch(
			`${apiBase()}/narrators/${narratorId}/edit-and-regenerate/${messageId}`,
			{
				method: "POST",
				headers,
				body,
			},
		);
		absorbRenewedToken(res, token);
		if (res.status === 401) {
			const error = await readFetchError(res, "Unauthorized");
			throw new ApiError(error.message, 401, error.data);
		}
		if (!res.ok) {
			const error = await readFetchError(res, "Request failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		const result = (await res.json()) as { ok?: unknown; warnings?: RevertWarning[] };
		return {
			ok: result.ok === true,
			...(result.warnings?.length ? { warnings: result.warnings } : {}),
		};
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
	deleteMessage: (
		narratorId: string,
		messageId: string,
		opts?: { skipRevert?: boolean; scope?: RevertScope },
	) => {
		const query = new URLSearchParams();
		if (opts?.skipRevert) query.set("skipRevert", "1");
		// A narrator-scoped revert can refuse on conflict; widening the scope is the
		// remedy the error suggests, so it has to be reachable from the client.
		if (opts?.scope) query.set("scope", opts.scope);
		const suffix = query.size > 0 ? `?${query}` : "";
		return request<{ ok: boolean; deletedCount: number }>(
			`/narrators/${narratorId}/messages/${messageId}${suffix}`,
			{
				method: "DELETE",
			},
		);
	},
	dismissSpecCarryoverMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedMessageIds: string[] }>(
			`/narrators/${narratorId}/spec-carryover-messages/${messageId}`,
			{
				method: "DELETE",
			},
		),
	/**
	 * Start a turn for a review conclusion the narrator already holds.
	 *
	 * Writes no message: the conclusion row IS the user message and has been in the
	 * history since the review concluded. `started: false` is a normal outcome (the
	 * narrator is busy, or the row was already handled), not an error — either way the
	 * findings are in the history the next request rebuilds.
	 */
	applyReviewFeedback: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; started: boolean; reason: string }>(
			`/narrators/${narratorId}/review-feedback/${messageId}/apply`,
			{
				method: "POST",
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
	dismissInterruptTaskGuardMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedMessageIds: string[] }>(
			`/narrators/${narratorId}/interrupt-task-guard-messages/${messageId}`,
			{
				method: "DELETE",
			},
		),
	/** What deleting one tool_use block would roll back, for the confirm dialog. */
	blockDeletePreview: (narratorId: string, messageId: string, blockIndex: number) =>
		request<BlockDeletePreview>(
			`/narrators/${narratorId}/block-delete-preview?messageId=${encodeURIComponent(
				messageId,
			)}&blockIndex=${blockIndex}`,
		),
	deleteMessageBlock: (
		narratorId: string,
		messageId: string,
		blockIndex: number,
		opts?: { skipRevert?: boolean; scope?: RevertScope },
	) => {
		const params = new URLSearchParams();
		if (opts?.skipRevert) params.set("skipRevert", "1");
		if (opts?.scope) params.set("scope", opts.scope);
		const query = params.toString();
		return request<{ ok: boolean; messageDeleted: boolean }>(
			`/narrators/${narratorId}/messages/${messageId}/blocks/${blockIndex}${
				query ? `?${query}` : ""
			}`,
			{ method: "DELETE" },
		);
	},
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

	// File tree — current uncommitted Git line counts, relative to this narrator's cwd.
	getFileTreeStatus: (narratorId: string) =>
		request<{
			isGitRepo: boolean;
			files: Array<{ path: string; linesAdded: number; linesRemoved: number }>;
			totalFiles: number;
			truncated: boolean;
		}>(`/narrators/${narratorId}/file-tree-status`),

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
			/** Newest window only; see `timelineTruncated`. */
			timeline: Array<{
				messageId: string;
				createdAt: string;
				seq: number;
				role: string;
				hasEdits: boolean;
			}>;
			/** True when older messages exist outside the returned timeline window. */
			timelineTruncated?: boolean;
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
	revertAllFiles: (narratorId: string, opts?: { scope?: RevertScope }) =>
		request<{ fileCount: number; files: string[]; warnings?: RevertWarning[] }>(
			`/narrators/${narratorId}/revert`,
			{
				method: "POST",
				body: JSON.stringify({
					messageId: "__all__",
					...(opts?.scope ? { scope: opts.scope } : {}),
				}),
			},
		),
	unrevertAll: (narratorId: string) =>
		request<{ success: boolean }>(`/narrators/${narratorId}/unrevert`, { method: "POST" }),
	getDeletePreview: (narratorId: string, messageId: string) =>
		request<
			RevertScopePreviews<RevertPreviewFileWithContent> & {
				toolCallCount: number;
			}
		>(`/narrators/${narratorId}/delete-preview?messageId=${encodeURIComponent(messageId)}`),
	getRollbackPreview: (narratorId: string, messageId: string, blockIndex: number) =>
		request<
			RevertScopePreviews<RevertPreviewFile> & {
				toolCallCount: number;
				deletedBlockCount: number;
				deletedMessageCount: number;
			}
		>(
			`/narrators/${narratorId}/rollback-preview?messageId=${encodeURIComponent(messageId)}&blockIndex=${blockIndex}`,
		),
	/**
	 * What editing this user message and regenerating would roll back.
	 *
	 * Same endpoint as the rollback preview, with no `blockIndex`: editing keeps the
	 * whole user turn and truncates what follows, which is exactly the window the
	 * server computes when no index is given. Sharing it is what keeps the dialog's
	 * promise identical to the rollback that runs.
	 */
	getEditRegeneratePreview: (narratorId: string, messageId: string) =>
		request<
			RevertScopePreviews<RevertPreviewFile> & {
				toolCallCount: number;
				deletedBlockCount: number;
				deletedMessageCount: number;
			}
		>(`/narrators/${narratorId}/rollback-preview?messageId=${encodeURIComponent(messageId)}`),
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

	// ── Access control (sharing) ───────────────────────────────────────────────

	getNarratorAccess: (narratorId: string) =>
		request<NarratorAccess>(`/narrators/${narratorId}/access`),

	setNarratorVisibility: (narratorId: string, visibility: NarratorVisibility) =>
		request<NarratorAccess>(`/narrators/${narratorId}/visibility`, {
			method: "PATCH",
			body: JSON.stringify({ visibility }),
		}),

	setNarratorWriteAudience: (narratorId: string, writeAudience: NarratorWriteAudience) =>
		request<NarratorAccess>(`/narrators/${narratorId}/write-audience`, {
			method: "PATCH",
			body: JSON.stringify({ writeAudience }),
		}),

	/** Share with several users at once; the response reports each user's outcome. */
	grantNarratorAccess: (narratorId: string, userIds: string[], access: NarratorGrantAccess) =>
		request<NarratorGrantBatchResult>(`/narrators/${narratorId}/grants`, {
			method: "POST",
			body: JSON.stringify({ userIds, access }),
		}),

	updateNarratorGrant: (narratorId: string, grantId: string, access: NarratorGrantAccess) =>
		request<{ grants: NarratorGrant[] }>(`/narrators/${narratorId}/grants/${grantId}`, {
			method: "PATCH",
			body: JSON.stringify({ access }),
		}),

	revokeNarratorGrant: (narratorId: string, grantId: string) =>
		request<{ ok: true }>(`/narrators/${narratorId}/grants/${grantId}`, { method: "DELETE" }),

	transferNarratorOwner: (narratorId: string, userId: string | null) =>
		request<NarratorAccess>(`/narrators/${narratorId}/transfer-owner`, {
			method: "POST",
			body: JSON.stringify({ userId }),
		}),
};
