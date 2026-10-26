import type {
	AsyncQuestion,
	HumanAttentionDetail,
	PendingPermission,
} from "@frontend/types/narrator";
import type { UsageHistoryStats } from "@frontend/types/usage-history";
import type { PendingAgentMessagesPage } from "@shared/agent-inbox";
import type { BackgroundTaskListPage } from "@shared/background-task-list";
import type { ComposerDocument } from "@shared/composer-document";
import type {
	FileChangeEvidenceUncertaintyWarning,
	FileChangeRevertAction,
	FileChangeRevertApplyResponse,
} from "@shared/file-change-protocol";
import type { FileReference } from "@shared/file-reference";
import type { GitWorkspaceSummary } from "@shared/git-workspace";
import type { HumanAttentionPage } from "@shared/human-attention";
import type { NarratorNavigationSummary, NarratorPanelState } from "@shared/narrator-panel-state";
import {
	TEXT_DOCUMENT_PACKET_BYTES,
	TEXT_DOCUMENT_PAGE_CHARS,
	type TextDocumentRange,
	type TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import type { RequestRecordingDetail, SavedRecording } from "@shared/request-recording";
import type { SubagentModelPools, SubagentModelUse } from "@shared/subagent-model-policy";
import type { ToolEditPreview } from "@shared/tool-edit-preview";
import type { WorkspaceContext } from "@shared/workspace-context";
import { decodeBlockMessage, decodeBlockPage } from "../block-protocol";
import { narratorLoadingMetrics } from "../narrator-loading-metrics";
import { createSharedInflight, type SharedReadOptions } from "../shared-inflight";
import type { GitIdentity } from "./auth";
import {
	ApiError,
	apiBase,
	authorizedFetch,
	clearTokenOnSessionFailure,
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
	HistoryRecoveryResult,
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
	TreeMessage,
	WhitelistCmd,
	WhitelistDir,
} from "./types";
import { normalizeRuleTargetSelector, selectorToLegacyDeviceScope } from "./types";

export interface ComposerDocumentDetail {
	composerDocument?: ComposerDocument;
	/** These summaries are read together with the document, never from a stale list row. */
	images?: {
		id?: string;
		imageId: string;
		filename?: string;
		mediaType?: string;
		width?: number;
		height?: number;
		size?: number;
		sourceMimeType?: string;
		uploadNarratorId?: string;
	}[];
	textFiles?: { filename: string; size: number; filePath?: string; index?: number }[];
	text?: string;
	fileReferences?: FileReference[];
	bodyRevision?: number;
}

export interface NarratorPanelStateOptions extends SharedReadOptions {
	permissionsCursor?: string;
	bufferCursor?: string;
}

export type NarratorPanelStateResponse = NarratorPanelState<
	PendingPermission,
	BufferMessageSummary
>;

export type NarratorDetail = ApiEntity & {
	navigationSummary?: NarratorNavigationSummary;
};

const sharePanelStateRead = createSharedInflight<NarratorPanelStateResponse>();

/** Live-request deduplication only; safety reconciliation never adopts query-cache permissions. */
export function getNarratorPanelState(id: string, options: NarratorPanelStateOptions = {}) {
	const { permissionsCursor, bufferCursor } = options;
	const scope = getToken();
	const key = JSON.stringify([scope, id, permissionsCursor ?? null, bufferCursor ?? null]);
	return sharePanelStateRead(
		key,
		async (signal) => {
			const controller = new AbortController();
			const abort = () => controller.abort(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			const timer = setTimeout(
				() => controller.abort(new Error("Panel state read timed out")),
				10_000,
			);
			try {
				const params = new URLSearchParams();
				if (permissionsCursor) params.set("permissionsCursor", permissionsCursor);
				if (bufferCursor) params.set("bufferCursor", bufferCursor);
				const query = params.toString();
				return await request<NarratorPanelStateResponse>(
					`/narrators/${encodeURIComponent(id)}/panel-state${query ? `?${query}` : ""}`,
					{ signal: controller.signal },
				);
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
			}
		},
		options,
	);
}

/** Bounded source lane: timeout, packet bytes and caller cancellation are independent of document size. */
async function requestTextDocumentJson<T>(path: string, signal?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	const timer = setTimeout(
		() => controller.abort(new Error("Text document read timed out")),
		10_000,
	);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		const response = await authorizedFetch(`${apiBase()}${path}`, { signal: controller.signal });
		if (!response.ok) {
			const error = await readFetchError(response, "Text document read failed");
			throw new ApiError(error.message, response.status, error.data);
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Text document response has no body");
		const decoder = new TextDecoder();
		let bytes = 0;
		let text = "";
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > TEXT_DOCUMENT_PACKET_BYTES)
					throw new Error("Text document packet limit exceeded");
				text += decoder.decode(chunk.value, { stream: true });
			}
			return JSON.parse(text + decoder.decode()) as T;
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

export interface WriteDocumentSourceReference {
	toolCallId: string;
	messageId: string;
	executionAttempt: number;
}

export function getTextDocumentRange(
	narratorId: string,
	refId: string,
	offset = 0,
	limit = TEXT_DOCUMENT_PAGE_CHARS,
	signal?: AbortSignal,
): Promise<TextDocumentRange> {
	const query = new URLSearchParams({
		offset: String(offset),
		limit: String(Math.min(limit, TEXT_DOCUMENT_PAGE_CHARS)),
	});
	return requestTextDocumentJson(
		`/narrators/${encodeURIComponent(narratorId)}/text-documents/${encodeURIComponent(refId)}?${query}`,
		signal,
	);
}

export function ensureWriteDocumentSource(
	narratorId: string,
	toolUseId: string,
	reference: WriteDocumentSourceReference,
	signal?: AbortSignal,
): Promise<TextDocumentRef> {
	const query = new URLSearchParams({
		toolCallId: reference.toolCallId,
		messageId: reference.messageId,
		executionAttempt: String(reference.executionAttempt),
	});
	return requestTextDocumentJson(
		`/narrators/${encodeURIComponent(narratorId)}/tool-calls/${encodeURIComponent(toolUseId)}/input-document?${query}`,
		signal,
	);
}

export function readTextDocumentRange(
	ref: TextDocumentRef,
	offset: number,
	limit: number,
	signal?: AbortSignal,
) {
	if (!ref.source?.narratorId) return Promise.reject(new Error("Text document owner is missing"));
	return getTextDocumentRange(ref.source.narratorId, ref.id, offset, limit, signal);
}

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
	| "file_conflict"
	| "history_changed"
	| "unsupported_target"
	| "platform_unsupported"
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

export type RevertAction = FileChangeRevertAction;

export interface RevertActionTarget {
	messageId: string;
	blockIndex?: number;
	/**
	 * The server's id for the block holding `blockIndex`, read from the row the action
	 * was picked on (§5.5). A block action (rollback, tool block deletion) names it.
	 */
	blockId?: string;
}

/** A message element an action starts from, with the server's id for its block. */
export type BlockTarget = RevertActionTarget & { blockIndex: number; blockId: string };

/** The exact durable plan reviewed by the user, never a request to re-plan. */
export interface RevertPlanConfirmation {
	planId: string;
	planHash: string;
	action: RevertAction;
	acceptSnapshotRestore?: true;
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

/**
 * One concrete holder that is currently refusing a safe file rollback.
 * Advisory only: listing a blocker never authorizes a wider plan.
 */
export interface RevertBlocker {
	kind: "running_tool" | "narrator_busy" | "planner_busy";
	toolCallId?: string;
	toolName?: string;
	operationId?: string;
	messageId?: string;
	detail?: string;
}

export interface RevertDiagnostic {
	code: string;
	reason?: string;
	filePath?: string;
	effectId?: string;
	toolCallId?: string;
	operationId?: string;
}

export interface RevertActionPreview {
	action: RevertAction;
	plan: RevertActionPlan | null;
	executable: false;
	historySummary: RevertHistorySummary | null;
	unavailable?: ScopedRevertUnavailableReason;
	diagnostics?: RevertDiagnostic[];
	recoveryMode?: "snapshot";
	/** Present when the server could name the running/unfinished holders. */
	blockers?: RevertBlocker[];
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
	desiredStateJson: { kind: "absent" | "regular" | "symlink" | "unknown"; reason?: string };
}

export interface RevertPlanFilesPage {
	items: RevertPlanFile[];
	hasMore: boolean;
	nextCursor: { fileKey: string } | null;
	executable: false;
}

export type RevertPlanApplyResult = FileChangeRevertApplyResponse;

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
	recoveryMode?: "snapshot";
}

export interface RevertPreviewFile {
	fileKey?: string;
	deviceId: string;
	filePath: string;
	willBeDeleted: boolean;
	unavailable?: boolean;
}

/**
 * A fixed narrator plan, with optional metadata for read-only legacy previews.
 * Missing plan metadata never authorizes replay or implies no file changes.
 */
export interface RevertScopePreviews<F extends RevertPreviewFile = RevertPreviewFile> {
	/** Present only for the new action-preview + paged-files flow. */
	revertPlan?: RevertPlanReview;
	previewIssue?: RevertPlanPreviewIssue;
	previewError?: string;
	previewErrorKey?: "revertPlanPreviewTimeout";
	diagnostics?: RevertDiagnostic[];
	recoveryMode?: "snapshot";
	blockers?: RevertBlocker[];
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

export type NarratorSlashMenuResponse = {
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
};

/** Delete whole blocks by id, history only (§5.5). */
function deleteBlocksById(narratorId: string, blockIds: string[]) {
	return request<{
		ok: boolean;
		deleted: number;
		failed?: number;
		results: Array<{ blockId: string; messageId: string; messageDeleted: boolean }>;
		/** A deletion's file outcome when the server reports one. */
		revertResult?: FileChangeRevertApplyResponse;
	}>(`/narrators/${narratorId}/blocks`, {
		method: "DELETE",
		body: JSON.stringify({ blockIds, skipRevert: true }),
	});
}

export const narratorsApi = {
	getRequestRecordingDetail: (narratorId: string, requestId: string, signal?: AbortSignal) =>
		request<RequestRecordingDetail>(
			`/narrators/${encodeURIComponent(narratorId)}/request-recordings/requests/${encodeURIComponent(requestId)}`,
			{ signal },
		),
	saveSpecificRequestRecording: (narratorId: string, requestId: string, signal?: AbortSignal) =>
		request<SavedRecording>(
			`/narrators/${encodeURIComponent(narratorId)}/request-recordings/requests/${encodeURIComponent(requestId)}`,
			{ method: "POST", signal },
		),
	saveRequestRecording: (narratorId: string, signal?: AbortSignal) =>
		request<SavedRecording>(`/narrators/${encodeURIComponent(narratorId)}/request-recordings`, {
			method: "POST",
			signal,
		}),
	listRequestRecordings: (narratorId: string, cursor?: string, signal?: AbortSignal) => {
		const params = new URLSearchParams({ limit: "50" });
		if (cursor) params.set("cursor", cursor);
		return request<{ items: SavedRecording[]; nextCursor: string | null }>(
			`/narrators/${encodeURIComponent(narratorId)}/request-recordings?${params}`,
			{ signal },
		);
	},
	deleteRequestRecording: (narratorId: string, saveId: string) =>
		request<{ ok: true }>(
			`/narrators/${encodeURIComponent(narratorId)}/request-recordings/${encodeURIComponent(saveId)}`,
			{ method: "DELETE" },
		),
	async downloadRequestRecording(
		narratorId: string,
		saveId: string,
		signal?: AbortSignal,
	): Promise<{ blob: Blob; fileName: string | null }> {
		const res = await authorizedFetch(
			`${apiBase()}/narrators/${encodeURIComponent(narratorId)}/request-recordings/${encodeURIComponent(saveId)}/download`,
			{ signal },
		);
		if (!res.ok) {
			const error = await readFetchError(res, `HTTP ${res.status}`);
			throw new ApiError(error.message, res.status, error.data);
		}
		return {
			blob: await res.blob(),
			fileName: parseContentDispositionFileName(res.headers.get("content-disposition")),
		};
	},
	getTextDocumentRange,
	ensureWriteDocumentSource,
	readTextDocumentRange,
	listNarrators: (opts?: {
		standalone?: boolean;
		status?: string;
		sortBy?: string;
		sortOrder?: string;
	}) => {
		const params = new URLSearchParams();
		if (opts?.standalone) params.set("standalone", "true");
		if (opts?.status) params.set("status", opts.status);
		if (opts?.sortBy) params.set("sortBy", opts.sortBy);
		if (opts?.sortOrder) params.set("sortOrder", opts.sortOrder);
		const qs = params.toString();
		return request<ApiEntity[]>(`/narrators${qs ? `?${qs}` : ""}`);
	},
	listNarratorsPaginated: (opts?: {
		projectId?: string;
		status?: string;
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
		if (opts?.projectId) params.set("projectId", opts.projectId);
		if (opts?.status) params.set("status", opts.status);
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
	getNarrator: async (id: string, signal?: AbortSignal) => {
		const token = narratorLoadingMetrics.current(id);
		if (token) narratorLoadingMetrics.mark(token, "detail-start");
		const detail = await request<NarratorDetail>(`/narrators/${id}`, { signal });
		if (token) narratorLoadingMetrics.mark(token, "detail-ready");
		return detail;
	},
	getNarratorPanelState,
	getNarratorGitSummary: async (
		id: string,
		signal?: AbortSignal,
	): Promise<GitWorkspaceSummary | null> => {
		// Generic request() treats JSON null as malformed; null is an explicit valid summary here.
		const response = await authorizedFetch(
			`${apiBase()}/narrators/${encodeURIComponent(id)}/git/summary`,
			{ signal },
		);
		if (!response.ok) {
			await clearTokenOnSessionFailure(response.clone());
			const error = await readFetchError(response, "Git summary read failed");
			throw new ApiError(error.message, response.status, error.data);
		}
		return response.json() as Promise<GitWorkspaceSummary | null>;
	},

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
	getNarratorDraft: (id: string, signal?: AbortSignal) =>
		request<{
			hasDraft: boolean;
			text: string;
			fileReferences?: FileReference[];
			composerDocument?: ComposerDocument;
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
		}>(`/narrators/${id}/draft`, { signal }),
	updateNarratorDraft: (
		id: string,
		text: string,
		sourceId?: string,
		fileReferences?: FileReference[],
		composerDocument?: ComposerDocument,
	) =>
		request<{
			ok: boolean;
			traits: string[];
			hasDraft: boolean;
			text: string;
			fileReferences?: FileReference[];
			composerDocument?: ComposerDocument;
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
		}>(`/narrators/${id}/draft`, {
			method: "PUT",
			body: JSON.stringify({ text, sourceId, fileReferences, composerDocument }),
		}),
	/** Swap the draft with the server's undo slot (the version the last write replaced). */
	restoreNarratorDraftPrevious: (id: string, sourceId?: string) =>
		request<{
			ok: boolean;
			hasDraft: boolean;
			text: string;
			fileReferences?: FileReference[];
			composerDocument?: ComposerDocument;
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
		}>(`/narrators/${id}/draft/restore`, {
			method: "POST",
			body: JSON.stringify({ sourceId }),
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
		request<NarratorSlashMenuResponse>(`/narrators/${id}/commands`),
	/** Slash menu for the session-less dashboard composer, resolved from `cwd`. */
	getDraftComposerCommands: (cwd: string | null) =>
		request<NarratorSlashMenuResponse>(
			`/narrators/draft-composer/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`,
		),
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
		contextProjectId?: string;
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
		title?: string;
		makeNamed?: boolean;
		handle?: string;
		kind?: "knowledge" | "setup" | "bot";
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
		opts?: {
			afterSeq?: number;
			beforeSeq?: number;
			limit?: number;
			messageVersion?: number;
			signal?: AbortSignal;
			maxResponseBytes?: number;
			onResponseBytes?: (bytes: number) => void;
		},
	) => {
		const params = new URLSearchParams();
		if (opts?.afterSeq != null) params.set("afterSeq", String(opts.afterSeq));
		if (opts?.beforeSeq != null) params.set("beforeSeq", String(opts.beforeSeq));
		if (opts?.limit != null) params.set("limit", String(opts.limit));
		if (opts?.messageVersion != null) params.set("messageVersion", String(opts.messageVersion));
		// The page is envelopes + blocks (§8.1), decoded into rows.
		return request<PretextDocumentPageResult>(`/narrators/${id}/pretext-document?${params}`, {
			signal: opts?.signal,
			maxResponseBytes: opts?.maxResponseBytes,
			onResponseBytes: opts?.onResponseBytes,
		}).then(decodeBlockPage);
	},
	// Resolve a message id to its top-level seq coordinate (jump-to-message).
	getMessageLocation: (id: string, messageId: string, signal?: AbortSignal) =>
		request<MessageLocationResult>(
			`/narrators/${id}/message-location/${encodeURIComponent(messageId)}`,
			{ signal },
		),
	// Bounded oversized-message scan used when the timeline cannot paginate.
	getHistoryRecovery: (id: string, signal?: AbortSignal) =>
		request<HistoryRecoveryResult>(`/narrators/${id}/history-recovery`, { signal }),
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
	interruptNarrator: (id: string, waitForIdle = false) =>
		request<ApiEntity & { settled?: boolean }>(
			`/narrators/${id}/interrupt${waitForIdle ? "?waitForIdle=1" : ""}`,
			{ method: "POST" },
		),
	detachBash: (narratorId: string, toolUseId: string) =>
		request<{ detached: true; taskId: string; alias: string }>(
			`/narrators/${encodeURIComponent(narratorId)}/tools/${encodeURIComponent(toolUseId)}/detach`,
			{ method: "POST" },
		),
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
	getMessageComposerDocument: (narratorId: string, messageId: string, signal?: AbortSignal) =>
		request<ComposerDocumentDetail>(
			`/narrators/${encodeURIComponent(narratorId)}/messages/${encodeURIComponent(messageId)}/composer-document`,
			{ signal },
		),
	getBufferedMessageComposerDocument: (
		narratorId: string,
		messageId: string,
		signal?: AbortSignal,
	) =>
		request<ComposerDocumentDetail>(
			`/narrators/${encodeURIComponent(narratorId)}/buffer/${encodeURIComponent(messageId)}/composer-document`,
			{ signal },
		),
	getBufferedMessages: (id: string, signal?: AbortSignal) =>
		request<BufferMessageSummary[]>(`/narrators/${id}/buffer`, { signal }),
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
			composerDocument?: ComposerDocument;
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
					composerDocument: opts?.composerDocument,
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
		if (opts.composerDocument !== undefined) {
			formData.append("composerDocument", JSON.stringify(opts.composerDocument));
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
	setBufferedMessageMode: (
		narratorId: string,
		messageId: string,
		mode: "turn" | "tool" | "interrupt",
	) =>
		request<{ ok: true; delivered?: boolean; messageId?: string }>(
			`/narrators/${encodeURIComponent(narratorId)}/buffer/${encodeURIComponent(messageId)}/mode`,
			{ method: "PATCH", body: JSON.stringify({ mode }) },
		),
	retryBufferedMessage: (narratorId: string, messageId: string) =>
		request<{ ok: true; resumed: boolean }>(
			`/narrators/${encodeURIComponent(narratorId)}/buffer/${encodeURIComponent(messageId)}/retry`,
			{ method: "POST" },
		),
	removeBufferedMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer/${messageId}`, {
			method: "DELETE",
		}),
	clearBufferedMessages: (narratorId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer`, { method: "DELETE" }),
	getPendingAgentMessages: (narratorId: string, signal?: AbortSignal) =>
		request<PendingAgentMessagesPage>(
			`/narrators/${encodeURIComponent(narratorId)}/inbox/agent-messages`,
			{ signal },
		),
	resumeAgentInbox: (narratorId: string) =>
		request<{ ok: true; resumed: boolean }>(
			`/narrators/${encodeURIComponent(narratorId)}/inbox/resume`,
			{ method: "POST" },
		),
	discardPendingAgentMessage: (narratorId: string, messageId: string) =>
		request<{ ok: true }>(
			`/narrators/${encodeURIComponent(narratorId)}/inbox/agent-messages/${encodeURIComponent(messageId)}`,
			{ method: "DELETE" },
		),
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
	getPendingPermissions: (id: string, signal?: AbortSignal) =>
		request<PendingPermission[]>(`/narrators/${id}/permissions`, { signal }),
	// Async AskUserQuestion inbox — separate from permissions because nothing is
	// suspended waiting for these (see the AsyncQuestion type).
	//
	// The GLOBAL variant answers "is anything waiting on me anywhere", which the
	// per-narrator one structurally cannot.
	getAllAsyncQuestions: () =>
		request<{
			items: (AsyncQuestion & { narratorTitle: string | null })[];
			openCount: number;
			awaitedCount: number;
		}>("/narrators/questions/all"),
	getAsyncQuestions: (
		id: string,
		params?: {
			status?: string;
			filter?: "all" | "open" | "pending" | "history";
			cursor?: string;
			limit?: number;
		},
	) => {
		const query = new URLSearchParams();
		if (params?.status) query.set("status", params.status);
		if (params?.filter) query.set("filter", params.filter);
		if (params?.cursor) query.set("cursor", params.cursor);
		if (params?.limit !== undefined) query.set("limit", String(params.limit));
		const suffix = query.size > 0 ? `?${query.toString()}` : "";
		return request<{ items: AsyncQuestion[]; nextCursor: string | null; openCount: number }>(
			`/narrators/${id}/questions${suffix}`,
		);
	},
	getAsyncQuestionDetail: (narratorId: string, questionId: string, cursor?: string) =>
		request<{
			question: AsyncQuestion;
			supplements: {
				messageId: string;
				kind?: "answer" | "dismissal" | "supplement";
				text: string | null;
				createdAt: string;
				actor?: string | null;
			}[];
			nextCursor?: string | null;
			tooLarge?: boolean;
			canAct?: boolean;
		}>(
			`/narrators/${narratorId}/questions/${questionId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
		),
	getGlobalQuestionPage: (filter: "open" | "pending" | "history", cursor?: string) => {
		const query = new URLSearchParams({ filter, limit: "30" });
		if (cursor) query.set("cursor", cursor);
		return request<{
			items: (AsyncQuestion & {
				narratorTitle: string | null;
				canAct?: boolean;
			})[];
			nextCursor: string | null;
		}>(`/narrators/questions?${query}`);
	},
	supplementAsyncQuestion: (
		narratorId: string,
		questionId: string,
		payload: { text: string; answerMessageId?: string },
	) =>
		request<{ ok: boolean; question: AsyncQuestion }>(
			`/narrators/${narratorId}/questions/${questionId}/supplement`,
			{
				method: "POST",
				body: JSON.stringify(payload),
			},
		),
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
	ignoreAsyncQuestion: (narratorId: string, questionId: string) =>
		request<{ ok: boolean; question: AsyncQuestion }>(
			`/narrators/${narratorId}/questions/${questionId}/ignore`,
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
		request<{ defaultDeviceId: string | null; current?: WorkspaceContext }>(
			`/narrators/${id}/default-device`,
			{
				method: "PATCH",
				body: JSON.stringify({ deviceId }),
			},
		),

	// === Git commit identity pick ===
	// Which of MY identities this narrator commits under, plus my identities to
	// choose from. Keyed by (user × narrator), so another user's pick is never
	// returned here and cannot be changed through these calls.

	getNarratorGitIdentity: (id: string) =>
		request<{ identities: GitIdentity[]; selectedId: string | null }>(
			`/narrators/${id}/git-identity`,
		),
	setNarratorGitIdentity: (id: string, identityId: string | null) =>
		request<{ ok: boolean }>(`/narrators/${id}/git-identity`, {
			method: "PUT",
			body: JSON.stringify({ identityId }),
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
	getCompactSummary: (narratorId: string, messageId: string) =>
		request<CompactMessageDetail>(`/narrators/${narratorId}/compact/${messageId}`),
	streamCompactSummary: (
		narratorId: string,
		messageId: string,
		offsets: { output: number; thinking: number },
	) => {
		const params = new URLSearchParams({
			outputOffset: String(Math.max(0, offsets.output)),
			thinkingOffset: String(Math.max(0, offsets.thinking)),
		});
		return authorizedFetch(
			`${apiBase()}/narrators/${encodeURIComponent(narratorId)}/compact/${encodeURIComponent(messageId)}/live?${params}`,
			{ headers: { Accept: "text/event-stream" } },
		);
	},
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
		interrupt?: boolean,
		queueMode?: "turn" | "tool" | "interrupt",
		options?: { composerDocument?: ComposerDocument },
	) => {
		if (queueMode !== undefined) {
			priority = queueMode !== "turn";
			interrupt = queueMode === "interrupt";
		}
		// Interrupt-and-insert is one request; its replacement always has queue priority.
		if (interrupt) priority = true;
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
			if (interrupt) formData.append("interrupt", "true");
			if (queueMode !== undefined) formData.append("queueMode", queueMode);
			if (fileReferences !== undefined) {
				formData.append("fileReferences", JSON.stringify(fileReferences));
			}
			if (options?.composerDocument !== undefined) {
				formData.append("composerDocument", JSON.stringify(options.composerDocument));
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
				body: JSON.stringify({
					message,
					...(priority ? { priority: true } : {}),
					...(interrupt ? { interrupt: true } : {}),
					...(queueMode !== undefined ? { queueMode } : {}),
					fileReferences,
					composerDocument: options?.composerDocument,
				}),
				signal,
			});
		}
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
		body: RevertActionTarget & {
			action: RevertAction;
			idempotencyKey: string;
			recoveryMode?: "snapshot";
		},
		signal?: AbortSignal,
	) => {
		// A rollback or a tool block deletion is planned for the whole block (§5.5).
		const { blockId, ...indexBody } = body;
		if (body.action === "rollback_to_block" || body.action === "delete_tool_block") {
			if (!blockId) return Promise.reject(new Error(`${body.action} needs the block's id`));
			return request<RevertActionPreview>(`/narrators/${narratorId}/blocks/revert-action-preview`, {
				method: "POST",
				body: JSON.stringify({
					action: body.action,
					blockIds: [blockId],
					idempotencyKey: body.idempotencyKey,
					...(body.recoveryMode ? { recoveryMode: body.recoveryMode } : {}),
				}),
				signal,
			});
		}
		return request<RevertActionPreview>(`/narrators/${narratorId}/revert-action-preview`, {
			method: "POST",
			body: JSON.stringify(indexBody),
			signal,
		});
	},
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
				body: JSON.stringify({
					planHash: plan.planHash,
					action: plan.action,
					...(plan.acceptSnapshotRestore === true ? { acceptSnapshotRestore: true } : {}),
				}),
			},
		),
	/** Keep the whole block the element belongs to (§5.5) and delete what follows it. */
	rollbackToBlock: (
		narratorId: string,
		{ blockId }: BlockTarget,
		opts?: { skipRevert?: boolean; scope?: RevertScope },
	) =>
		request<{ ok: boolean; warnings?: RevertWarning[] }>(
			`/narrators/${narratorId}/blocks/rollback`,
			{
				method: "POST",
				body: JSON.stringify({
					blockIds: [blockId],
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
			revertPlan?: RevertPlanConfirmation;
			keepImageIds?: string[];
			newImages?: File[];
			keepTextFilePaths?: string[];
			newTextFiles?: File[];
			fileReferences?: FileReference[];
			composerDocument?: ComposerDocument;
			/** The message's input block when the server named it; the message route otherwise. */
			inputBlockId?: string;
		},
	) => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;
		const inputBlockId = opts?.inputBlockId;

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
			if (opts.revertPlan) formData.append("revertPlan", JSON.stringify(opts.revertPlan));
			if (opts.keepImageIds) {
				formData.append("keepImageIds", JSON.stringify(opts.keepImageIds));
			}
			if (opts.keepTextFilePaths) {
				formData.append("keepTextFilePaths", JSON.stringify(opts.keepTextFilePaths));
			}
			if (opts.fileReferences !== undefined) {
				formData.append("fileReferences", JSON.stringify(opts.fileReferences));
			}
			if (opts.composerDocument !== undefined) {
				formData.append("composerDocument", JSON.stringify(opts.composerDocument));
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
				...(opts?.revertPlan ? { revertPlan: opts.revertPlan } : {}),
				...(opts?.keepImageIds ? { keepImageIds: opts.keepImageIds } : {}),
				...(opts?.keepTextFilePaths ? { keepTextFilePaths: opts.keepTextFilePaths } : {}),
				fileReferences: opts?.fileReferences,
				composerDocument: opts?.composerDocument,
			});
		}

		const res = await fetch(
			inputBlockId
				? `${apiBase()}/narrators/${narratorId}/blocks/${encodeURIComponent(inputBlockId)}/edit-and-regenerate`
				: `${apiBase()}/narrators/${narratorId}/edit-and-regenerate/${messageId}`,
			{
				method: "POST",
				headers,
				body,
			},
		);
		if (res.status === 401) {
			const error = await readFetchError(res, "Unauthorized");
			throw new ApiError(error.message, 401, error.data);
		}
		if (!res.ok) {
			const error = await readFetchError(res, "Request failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		const result = (await res.json()) as {
			ok?: unknown;
			warnings?: RevertWarning[];
			revertResult?: FileChangeRevertApplyResponse;
		};
		return {
			ok: result.ok === true,
			...(result.warnings?.length ? { warnings: result.warnings } : {}),
			...(result.revertResult ? { revertResult: result.revertResult } : {}),
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
	/** History-only: file restores go through a reviewed revert plan instead. */
	deleteMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedCount: number }>(
			`/narrators/${narratorId}/messages/${messageId}?skipRevert=1`,
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
	dismissInterruptTaskGuardMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedMessageIds: string[] }>(
			`/narrators/${narratorId}/interrupt-task-guard-messages/${messageId}`,
			{
				method: "DELETE",
			},
		),
	/**
	 * Close the post-error subagent recovery card without restarting anything.
	 * Neither resumes nor records a selection: the offer is simply withdrawn, and
	 * the server's per-subagent watermark keeps it from being offered again.
	 */
	dismissSubagentRecoveryMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedMessageIds: string[] }>(
			`/narrators/${narratorId}/subagent-recovery-messages/${messageId}`,
			{
				method: "DELETE",
			},
		),
	/** History-only: deleting a tool block with its files uses `applyRevertPlan`. */
	deleteMessageBlock: async (narratorId: string, { blockId }: BlockTarget) => {
		// The whole block the element belongs to (§5.5).
		const result = await deleteBlocksById(narratorId, [blockId]);
		return {
			ok: result.ok,
			messageDeleted: result.results.some((item) => item.messageDeleted),
		};
	},
	/** History-only: a multi-block selection has no previewable file restore plan. */
	deleteMessageBlocks: async (
		narratorId: string,
		targets: readonly BlockTarget[],
	): Promise<{
		ok: boolean;
		deleted: number;
		failed: number;
		revertResult?: FileChangeRevertApplyResponse;
	}> => {
		const ids = [...new Set(targets.map((target) => target.blockId))];
		const { ok, deleted, failed, revertResult } = await deleteBlocksById(narratorId, ids);
		return { ok, deleted, failed: failed ?? 0, ...(revertResult ? { revertResult } : {}) };
	},
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
	deleteSegmentCompact: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/segment-compact/${messageId}`, {
			method: "DELETE",
		}),
	updateSegmentCompactSummary: (narratorId: string, messageId: string, summary: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/segment-compact/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ summary }),
		}),

	// File tree — current Git changes relative to this narrator's cwd; legacy line counts are optional.
	getFileTreeStatus: (narratorId: string) =>
		request<{
			isGitRepo: boolean;
			files: Array<{
				path: string;
				status?: string;
				oldPath?: string;
				linesAdded?: number;
				linesRemoved?: number;
			}>;
			totalFiles: number;
			totalFilesExact?: boolean;
			truncated: boolean;
		}>(`/narrators/${narratorId}/file-tree-status`),

	getPermissionFilePreview: (narratorId: string, toolUseId: string) =>
		request<{
			deviceId: string;
			filePath: string;
			currentContent: string | null;
			previewContent: string | null;
			/** StructSed only: every changed region with context, each with its own origins. */
			diffHunks?: Array<{
				oldText: string;
				newText: string;
				oldStart: number;
				newStart: number;
				truncated?: true;
			}>;
			/** StructSed only: changed regions left out past the server's hunk cap. */
			diffOmittedHunks?: number;
			toolName: string;
			inputJson: Record<string, unknown>;
		}>(
			`/narrators/${narratorId}/permission-file-preview?toolUseId=${encodeURIComponent(toolUseId)}`,
		),

	// Ordinary conversation fork (standalone output).
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
		request<{ messageId: string; message?: unknown }>(
			`/narrators/${narratorId}/ask-in-passing/start`,
			{
				method: "POST",
				body: JSON.stringify(opts),
			},
		).then(decodeBlockMessage),
	askInPassing: (
		narratorId: string,
		opts: {
			question: string;
			pendingMessageId: string;
			/** Selected excerpt; the fork receives it as a quote block ahead of the question. */
			quote?: { label: string; text: string; anchor?: string };
		},
	) =>
		request<ApiEntity & { message?: unknown }>(`/narrators/${narratorId}/ask-in-passing`, {
			method: "POST",
			body: JSON.stringify(opts),
		}).then((response) => decodeBlockMessage(response) as ApiEntity & { message?: TreeMessage }),
	cancelAskInPassing: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/ask-in-passing/${messageId}`, {
			method: "DELETE",
		}),
	promoteNarrator: (narratorId: string) =>
		request<{ type: "unlocked"; narratorId: string; narrator?: ApiEntity }>(
			`/narrators/${narratorId}/promote`,
			{ method: "POST" },
		),
	/** Extract a subagent into an independent primary narrator (control-plane promotion). */
	extractSubagentToPrimary: (
		narratorId: string,
		opts?: { title?: string; inheritMode?: "full" | "compressed"; locale?: "en" | "zh-CN" },
	) =>
		request<{ type: "extracted"; narrator: ApiEntity }>(
			`/narrators/${narratorId}/extract-primary`,
			{
				method: "POST",
				body: JSON.stringify(opts ?? {}),
			},
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

	// ── Prompt optimization ────────────────────────────────────────────────────

	optimizePrompt: (
		narratorId: string,
		text: string,
		style: "clarify" | "concise" | "structured" | "translate_en",
		options?: {
			withContext?: boolean;
			messageId?: string;
			signal?: AbortSignal;
		},
	) =>
		request<{ text: string; model: string }>(`/narrators/${narratorId}/optimize-prompt`, {
			method: "POST",
			body: JSON.stringify({
				text,
				style,
				withContext: options?.withContext,
				messageId: options?.messageId,
			}),
			signal: options?.signal,
		}),
};
