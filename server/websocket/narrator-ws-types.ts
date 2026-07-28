/**
 * Narrator WebSocket message types — extracted to a standalone file so that
 * both event-bus.ts and narrator-ws.ts can reference NarratorServerMessage
 * without creating circular imports.
 */

import type { CatchUpCursor } from "@shared/narrator-catch-up";
import type { ProgressPhase } from "@shared/progress-phase";
import type { NarratorWsSubscriptionLimitError, RecentTabsDelta } from "@shared/recent-tabs";
import type { ApiRequestDiagnostics } from "../lib/agent/types";
import type { PublicCodexQuotaOverview } from "../lib/codex-manager";
import type { GitStatusSummary } from "../services/git-service";

export interface CodexQuotaOverviewWsMessage extends Record<string, unknown> {
	type: "codex_quota_overview_updated";
	overview: PublicCodexQuotaOverview;
}

export function createCodexQuotaOverviewWsMessage(
	overview: PublicCodexQuotaOverview,
): CodexQuotaOverviewWsMessage {
	return { type: "codex_quota_overview_updated", overview };
}

export interface NarratorListStateSnapshotItem {
	narratorId: string;
	status: string;
	substatus?: string[];
	turnStartedAt?: string;
}

/** Reflection gate families that report live progress. */
export type ReflectionProgressKind =
	| "danger_reflection"
	| "plan_reflection"
	| "task_reflection"
	| "question_reflection";

export interface NarratorListStateSnapshotMessage {
	type: "list_state_snapshot";
	items: NarratorListStateSnapshotItem[];
}

export interface RecentTabsSnapshotMessage {
	type: "user:recent_tabs_snapshot";
	tabs: Record<string, unknown>[];
	revision: number;
}

// Server → Client messages
export type NarratorServerMessage =
	| RecentTabsDelta
	| NarratorWsSubscriptionLimitError
	| RecentTabsSnapshotMessage
	| NarratorListStateSnapshotMessage
	| { type: "message"; narratorId: string; message: unknown }
	| { type: "stream_event"; narratorId: string; event: unknown }
	| { type: "permission_request"; narratorId: string; request: unknown }
	| {
			type: "danger_reflection_started";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			danger: unknown;
	  }
	| {
			type: "danger_reflection_resolved";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
	  }
	| {
			type: "danger_reflection_stopped";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			danger: unknown;
			inputJson: unknown;
			reason?: string;
	  }
	| {
			type: "plan_reflection_started";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson: unknown;
			reason?: string;
	  }
	| {
			type: "plan_reflection_resolved";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
	  }
	| {
			type: "plan_reflection_stopped";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson: unknown;
			reason?: string;
	  }
	| {
			type: "task_reflection_started";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson: unknown;
			mutations: unknown;
			reason?: string;
	  }
	| {
			type: "task_reflection_resolved";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
			nextSteps?: string;
	  }
	| {
			type: "task_reflection_stopped";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson: unknown;
			mutations: unknown;
			reason?: string;
	  }
	| {
			type: "question_reflection_started";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson: unknown;
			reason?: string;
	  }
	| {
			type: "question_reflection_resolved";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
	  }
	| {
			/**
			 * Live two-phase progress for a RUNNING reflection gate (danger / plan /
			 * task / question). Purely transient — like `compact_progress` it is never
			 * persisted, because writing `narratorToolCalls` every throttle window
			 * would put repeated writes on the main-thread SQLite path.
			 *
			 * The routing identity fields mirror `*_reflection_started` exactly so a
			 * subagent's gate lands on the same card.
			 */
			type: "reflection_progress";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
			/** Gate family, matching the `permissionSuggestions` entry's `type`. */
			kind: ReflectionProgressKind;
			phase: ProgressPhase;
			thinkingChars: number;
			outputChars: number;
	  }
	| {
			/**
			 * The automatic AskUserQuestion reflection timer was cancelled without
			 * changing the permission state (e.g. the user started answering). The
			 * frontend hides its countdown for this request.
			 */
			type: "question_reflection_disarmed";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId: string;
	  }
	| {
			type: "status_change";
			narratorId: string;
			status: string;
			substatus?: string[];
			turnStartedAt?: string;
	  }
	| { type: "substatus_change"; narratorId: string; substatus: string[] }
	| {
			type: "payment_required";
			narratorId: string;
			providerId?: string;
			providerPrefix?: string;
			balance?: number;
			required?: number;
			resumeAction: "retry" | "continue";
	  }
	| {
			/** The narrator is suspended waiting for a NUG model to recover (credential pool exhausted). */
			type: "model_unavailable_waiting";
			narratorId: string;
			message: string;
			model: string;
			providerId?: string;
			providerPrefix?: string;
			nugModelId?: string;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			/** A previously-unavailable NUG model recovered; the suspended narrator is resuming. */
			type: "model_unavailable_recovered";
			narratorId: string;
			model: string;
			nugModelId?: string;
	  }
	| {
			type: "queued_new_narrator_created";
			narratorId: string;
			messageId: string;
			newNarratorId: string;
	  }
	| { type: "tool_progress"; narratorId: string; toolUseId: string; elapsed: number }
	| {
			type: "tool_output";
			narratorId: string;
			toolUseId: string;
			output: string;
			parentToolUseId?: string;
	  }
	// 看门狗检测到 bash/shell 进程运行 ≥60s 时推送，前端据此显示终止按钮
	| {
			type: "tool_long_running";
			narratorId: string;
			toolUseId: string;
			elapsed: number;
			parentToolUseId?: string;
	  }
	| {
			type: "tool_completed";
			narratorId: string;
			toolCallId: string | null;
			toolUseId: string;
			subagentNarratorId?: string;
			toolName?: string;
			status: string;
			output?: unknown;
			durationMs?: number;
			updatedInput?: Record<string, unknown>;
			metadata?: Record<string, unknown>;
			sideCars?: Array<{
				target: string;
				source: string;
				content: string;
				toolUseId?: string | null;
				orderIndex?: number;
			}>;
			parentToolUseId?: string;
	  }
	| {
			type: "sidecars";
			narratorId: string;
			sideCars: Array<{
				target: string;
				source: string;
				content: string;
				toolUseId?: string | null;
				orderIndex?: number;
			}>;
			parentToolUseId?: string;
	  }
	| { type: "title_updated"; narratorId: string; title: string }
	| {
			type: "permission_resolved";
			narratorId: string;
			ownerNarratorId?: string;
			subagentNarratorId?: string;
			parentToolUseId?: string;
			requestId: string;
			toolUseId?: string;
			decision?: "allow" | "deny";
			updatedInput?: Record<string, unknown>;
			feedbackText?: string;
			/** Set when a controlling named narrator proxy-decided this request. */
			decidedByNarrator?: { id: string; handle: string | null };
	  }
	| {
			type: "buffer_set";
			narratorId: string;
			messages: Array<{ id: string; text: string; bufferedAt: string; priority?: boolean }>;
	  }
	| {
			type: "buffer_consumed";
			narratorId: string;
			messageId: string;
			remaining: Array<{ id: string; text: string; bufferedAt: string; priority?: boolean }>;
	  }
	| { type: "buffer_cleared"; narratorId: string; reason: "cancelled" | "sent" | "narrator_error" }
	| {
			type: "buffer_preserved";
			narratorId: string;
			messages: Array<{ id: string; text: string; bufferedAt: string; priority?: boolean }>;
	  }
	| { type: "permission_mode_changed"; narratorId: string; permissionMode: string }
	| {
			type: "model_settings_changed";
			narratorId: string;
			model?: string;
			reasoningEffort?: string | null;
			status: "updated" | "pending";
			applyAt: "next_request" | "next_model_request";
	  }
	| {
			type: "model_settings_applied";
			narratorId: string;
			model: string;
			provider: string;
			reasoningEffort?: string | null;
	  }
	| { type: "plan_mode_changed"; narratorId: string; planMode: boolean; traits: string[] }
	| { type: "custom_traits_changed"; narratorId: string; traits: string[]; customTraits: unknown }
	| {
			type: "draft_changed";
			narratorId: string;
			hasDraft: boolean;
			text: string;
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
	  }
	| { type: "relaxed_plan_changed"; narratorId: string; relaxedPlan: boolean }
	| {
			type: "reflection_overrides_changed";
			narratorId: string;
			planReflectionAutoApproveOverride?: "inherit" | "on" | "off";
			dangerReflectionOverride?: "inherit" | "on" | "off" | "light" | "standard" | "strict";
	  }
	| {
			type: "behavior_fence_settings_changed";
			narratorId: string;
			behaviorFenceIntervalOverride?: number | null;
			behaviorFenceAttachOverride?: "inherit" | "on" | "off";
	  }
	| { type: "user_message"; narratorId: string; message: unknown }
	| { type: "compacting"; narratorId: string; mode?: "blocking" | "background" }
	| {
			type: "compact_progress";
			narratorId: string;
			messageId: string;
			/**
			 * Which count the label should feature. Absent on payloads from an older
			 * server, which normalizes to `output` (the previous single-phase
			 * behaviour). See `@shared/progress-phase`.
			 */
			phase?: ProgressPhase;
			/** Thinking-channel characters so far (0 when the model does not stream reasoning). */
			thinkingChars?: number;
			outputChars: number;
			isSegment?: boolean;
			mode?: "blocking" | "background";
	  }
	| {
			type: "compact_done";
			narratorId: string;
			/** Final server-authoritative version after all compact persistence steps. */
			messageVersion?: number;
			contextPercentAfter?: number;
			isSegment?: boolean;
			mode?: "blocking" | "background";
			/** COW compact retry replacement identity, when this is a retry. */
			oldMessageId?: string;
			replacedMessageId?: string;
			messageId?: string;
			newMessageId?: string;
			replacementMessageId?: string;
	  }
	| {
			type: "compact_failed";
			narratorId: string;
			messageId: string;
			mode?: "blocking" | "background";
			/** COW compact retry replacement identity, when this is a retry. */
			oldMessageId?: string;
			replacedMessageId?: string;
			newMessageId?: string;
			replacementMessageId?: string;
	  }
	| { type: "segment_compact_hide"; narratorId: string; hiddenMessageIds: string[] }
	| {
			type: "context_usage";
			narratorId: string;
			percentage: number;
			isSubagent?: boolean;
			promptTokens?: number;
			contextWindow?: number;
			isEstimated?: boolean;
			pruneStart?: number;
			compactStart?: number;
	  }
	| {
			type: "prune_boundary";
			narratorId: string;
			boundaryMessageId: string | null;
			prunedPercent: number | null;
	  }
	| {
			type: "metering";
			narratorId: string;
			unit: string;
			unitPlural: string;
			usage: number;
			isSubagent?: boolean;
	  }
	| {
			type: "messages_deleted";
			narratorId: string;
			deletedMessageIds: string[];
			/** COW compact retry aliases: the deleted ID is replaced by messageId/newMessageId. */
			oldMessageId?: string;
			replacedMessageId?: string;
			messageId?: string;
			newMessageId?: string;
			replacementMessageId?: string;
	  }
	| {
			type: "message_updated";
			narratorId: string;
			message: unknown;
			/** COW compact retry aliases, forwarded with the replacement marker update. */
			oldMessageId?: string;
			replacedMessageId?: string;
			messageId?: string;
			newMessageId?: string;
			replacementMessageId?: string;
	  }
	| { type: "narrator_forked"; narratorId: string; parentNarratorId: string }
	| {
			type: "narrator_error";
			narratorId: string;
			error: string;
			errorCode?: string;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			type: "web_search";
			narratorId: string;
			id: string;
			status: "in_progress" | "searching" | "completed";
			query?: string;
			queries?: string[];
			outputIndex?: number;
			parentToolUseId?: string;
	  }
	| {
			type: "image_generation";
			narratorId: string;
			id: string;
			status: "in_progress" | "generating" | "completed";
			revisedPrompt?: string;
			partialImageIndex?: number;
			partialSavedPath?: string;
			savedPath?: string;
			width?: number;
			height?: number;
			outputIndex?: number;
			parentToolUseId?: string;
	  }
	| {
			type: "tool_started";
			narratorId: string;
			toolCallId: string | null;
			toolUseId: string;
			subagentNarratorId?: string;
			toolName: string;
			input?: unknown;
			streamStartedAt?: number;
			parentToolUseId?: string;
	  }
	| {
			type: "tool_use_chunk";
			narratorId: string;
			toolCallId: string | null;
			toolUseId: string;
			subagentNarratorId?: string;
			toolName: string;
			inputCharsTotal: number;
			parentToolUseId?: string;
			extractedFilePath?: string;
			contentCharsReceived?: number;
			extractedFields?: Record<string, string>;
			metadata?: Record<string, unknown>;
			/** Incremental delta of the large streaming field */
			streamingField?: { name: string; delta: string };
	  }
	| {
			type: "subagent_started";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
			subagentType: string;
			model?: string;
			reasoningEffort?: string;
	  }
	| {
			type: "background_task_started";
			narratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			subagentType: string;
	  }
	| {
			type: "background_task_completed";
			narratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			resultPreview: string;
	  }
	| {
			type: "background_task_failed";
			narratorId: string;
			taskNarratorId: string;
			toolUseId: string;
			error: string;
	  }
	| {
			type: "background_task_cancelled";
			narratorId: string;
			taskNarratorId: string;
			toolUseId: string;
	  }
	| {
			type: "background_task_status_changed";
			narratorId: string;
			taskId: string;
			status: string;
			output: string | null;
	  }
	| {
			type: "background_task_output";
			narratorId: string;
			taskId: string;
			/** Byte length of the accumulated output so far */
			outputBytes: number;
	  }
	| {
			type: "git_status";
			narratorId: string;
			chapterId: string;
			toolUseId: string;
			status: GitStatusSummary;
			commitsAhead?: number;
			baseBranch?: string;
			linesAdded?: number;
			linesRemoved?: number;
	  }
	| {
			type: "catch_up";
			narratorId: string;
			orphanChildren: unknown[];
			topLevel: unknown[];
			subagentActivities: unknown[];
			cursor?: CatchUpCursor;
			messageVersion?: number;
	  }
	| { type: "error"; message: string }
	| {
			type: "warning";
			narratorId: string;
			message: string;
			retryCount?: number;
			maxRetries?: number;
			delayMs?: number;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			/**
			 * uses it to mark stream-captured tool calls and to prompt downloading the raw SSE
			 * dump when capture failed. `apiRequestId` points at the persisted api_requests row
			 * for the leaked-tool-dump download endpoint.
			 */
			type: "leaked_tool_call_notice";
			narratorId: string;
			phase: "stream_captured" | "recovered" | "unrecovered";
			apiRequestId: string;
			toolUseIds?: string[];
			toolNames?: string[];
			snippet?: string;
	  }
	| { type: "context_length_exceeded"; narratorId: string }
	| { type: "full_reload"; narratorId: string }
	| {
			type: "timeout_updated";
			narratorId: string;
			toolUseId: string;
			timeoutMs: number;
	  }
	| { type: "commits_updated"; narratorId: string; chapterId: string; newCount: number }
	| {
			type: "presence_update";
			narratorId: string;
			viewers: Array<{
				userId: string;
				username: string;
				avatarColor: string | null;
				avatarImageId: string | null;
			}>;
	  }
	| {
			type: "terminal_count_changed";
			narratorId: string;
			activeTerminalCount: number;
	  }
	| {
			type: "browser_session_count";
			narratorId: string;
			activeBrowserSessions: number;
	  }
	| {
			type: "browser_session_visual_change";
			narratorId: string;
			sessionId: string;
	  }
	| {
			type: "container_status_changed";
			narratorId: string;
			chapterId: string;
			containerStatus: string | null;
	  }
	| {
			type: "quota_balance";
			narratorId: string;
			quotaBalance: string | null;
			detailedQuotaBalance?: string | null;
	  }
	| {
			type: "queue_status";
			narratorId: string;
			position?: number;
			queueDepth?: number;
			queueMessage?: string;
	  }
	| {
			type: "streaming_snapshot";
			narratorId: string;
			streamingBlocks: Array<
				| { type: "reasoning"; id?: string; outputIndex?: number; text: string }
				| {
						type: "web_search";
						id: string;
						status: string;
						query?: string;
						queries?: string[];
						outputIndex?: number;
				  }
				| {
						type: "image_generation";
						id: string;
						status: string;
						revisedPrompt?: string;
						result?: string;
						partialImageIndex?: number;
						partialSavedPath?: string;
						savedPath?: string;
						width?: number;
						height?: number;
						outputIndex?: number;
				  }
				| { type: "text"; text: string; outputIndex?: number }
			>;
			toolChunks: Array<{
				toolCallId: string | null;
				toolUseId: string;
				subagentNarratorId?: string;
				toolName: string;
				inputCharsTotal: number;
				parentToolUseId?: string;
				extractedFilePath?: string;
				contentCharsReceived?: number;
				extractedFields?: Record<string, string>;
				metadata?: Record<string, unknown>;
				started?: boolean;
				input?: unknown;
				streamStartedAt?: number;
				streamingOutput?: string;
			}>;
	  }
	| { type: "model_changed"; narratorId: string; model: string }
	| { type: "streaming_reset"; narratorId: string; parentToolUseId?: string }
	| {
			type: "model_switched";
			narratorId: string;
			model: string;
			provider: string;
			reasoningEffort?: string | null;
	  }
	| {
			type: "subagent_suspended";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
	  }
	| {
			type: "subagent_status_changed";
			narratorId: string;
			subagentNarratorId: string;
			status: string;
			substatus?: string[];
	  }
	| {
			type: "subagent_warning";
			narratorId: string;
			subagentNarratorId: string;
			message: string;
			retryCount?: number;
			maxRetries?: number;
			delayMs?: number;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			/** A subagent is suspended waiting for a NUG model to recover. */
			type: "subagent_model_unavailable_waiting";
			narratorId: string;
			subagentNarratorId: string;
			message: string;
			model: string;
			nugModelId?: string;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			/** A suspended subagent's NUG model recovered; it is resuming. */
			type: "subagent_model_unavailable_recovered";
			narratorId: string;
			subagentNarratorId: string;
			model: string;
			nugModelId?: string;
	  }
	| {
			type: "subagent_conclusion_updated";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
			output: string;
			hasError: boolean;
			completedAt?: number;
			durationMs?: number;
	  }
	| { type: "sync_ok"; narratorId: string; version: number }
	| {
			type: "team_message";
			narratorId: string;
			fromId: string;
			fromTitle: string | null;
			fromType: string;
			text: string;
			isBroadcast: boolean;
	  }
	| {
			type: "subagent_detached";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
	  }
	| {
			type: "subagent_attached";
			narratorId: string;
			subagentNarratorId: string;
	  }
	| {
			/** A new message was posted in a chat group this narrator belongs to. */
			type: "group_message";
			/** The narrator member this broadcast is routed to (WS subscription key). */
			narratorId: string;
			groupId: string;
			message: {
				id: string;
				groupId: string;
				senderType: "user" | "narrator" | "system";
				senderNarratorId: string | null;
				senderUserId: string | null;
				senderLabel: string;
				content: string;
				urgent: boolean;
				createdAt: string;
			};
	  }
	| {
			/** A chat group was fully set up; sent only to the initiating user. */
			type: "group:ready";
			groupId: string;
			title: string;
	  }
	| {
			type: "spec_changed";
			narratorId: string;
			uri: string;
			path: string;
			revisionId: string | null;
			updatedBy: "user" | "assistant" | "system";
			source: "ui" | "tool" | "task_create" | "reset";
	  };
