/**
 * Narrator WebSocket message types — extracted to a standalone file so that
 * both event-bus.ts and narrator-ws.ts can reference NarratorServerMessage
 * without creating circular imports.
 */

import type {
	BackgroundTaskListDelta,
	BackgroundTaskProgressFrame,
} from "@shared/background-task-list";
import type { SubagentModelInheritance } from "@shared/model-inheritance";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import type { NOTIFICATION_CENTER_CHANGED_WS_TYPE } from "@shared/notification-center";
import type { TextDocumentStreamUpdate } from "@shared/pretext-layout/text-document";
import type { ProgressPhase } from "@shared/progress-phase";
import type { NarratorWsSubscriptionLimitError, RecentTabsDelta } from "@shared/recent-tabs";
import type { StreamingEditOrigin } from "@shared/streaming-edit-origin";
import type { SubagentToolInputSummary } from "@shared/subagent-tool-summary";
import type { ToolProgressPayload } from "@shared/tool-progress";
import type { ApiRequestDiagnostics } from "../lib/agent/types";
import type { PublicCodexQuotaOverview } from "../lib/codex-manager";
import type { ModelContextWindowSource } from "../lib/settings";
import type { GitStatusSummary } from "../services/git-service";
import type { BufferMessageSummary } from "../services/narrator-buffer";

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
	activeBackgroundTaskCount?: number;
	activeBackgroundWorkCount?: number;
	activeBackgroundServiceCount?: number;
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
	| import("@shared/workspace-context").WorkspaceContextChangedEvent
	| import("@shared/permission-policy-events").PermissionPolicyChangedEvent
	| import("@shared/git-workspace-events").GitWorkspaceServerMessage
	/** No narrator identifiers or payloads; clients re-fetch their ACL-filtered inbox. */
	| { type: "human_attention_changed" }
	/** Per-user activity invalidation; no titles, previews or source identifiers. */
	| {
			type: typeof NOTIFICATION_CENTER_CHANGED_WS_TYPE;
			kinds?: Array<"chat_message" | "permission_request">;
	  }
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
			decision: "allow" | "deny" | "aborted" | "failed";
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
			decision: "allow" | "deny" | "aborted" | "failed";
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
			 * An asynchronous AskUserQuestion changed state (`narrator_questions`).
			 *
			 * One event for every transition rather than one per verb: the client keeps a
			 * `Map<id, question>` and every change is either an upsert (`opened`) or a
			 * removal from the open set, so a single carrier with the full row is all the
			 * client needs to stay consistent — including after a missed event, because
			 * the row is complete rather than a delta.
			 *
			 * Deliberately NOT a `permission_request`: an async question does not suspend
			 * the loop, does not set the narrator to `waiting`, and must therefore not
			 * reach the code paths that assume both (attention notifications, the composer
			 * send gate, the Enter-key binding).
			 */
			type: "async_question_changed";
			narratorId: string;
			/**
			 * `awaited` / `await_ended` are WAIT transitions, not status changes: the
			 * question stays `open` while an agent blocks on it via `Await`, but it stops
			 * being the "answer whenever convenient" kind — see `awaitAsyncQuestion`.
			 */
			change: "opened" | "answered" | "dismissed" | "withdrawn" | "awaited" | "await_ended";
			question: unknown;
			/** True while at least one `Await` call is blocked on this question. */
			awaited?: boolean;
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
			/**
			 * The narrator is suspended on a self-recovering block: a NUG model to
			 * recover (credential pool exhausted), or a Kimi quota window to reset.
			 */
			type: "model_unavailable_waiting";
			narratorId: string;
			message: string;
			model: string;
			providerId?: string;
			providerPrefix?: string;
			nugModelId?: string;
			/** `credentials` when omitted. `quota` waits carry `resumeAt`. */
			waitKind?: "credentials" | "quota";
			/** Epoch ms the blocked window resets at. `quota` waits only. */
			resumeAt?: number;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			/**
			 * The suspended narrator's block cleared; it is resuming. `waitKind`
			 * distinguishes a recovered model from a reset quota window, so the
			 * client can word the recovery notice to match the wait it showed.
			 */
			type: "model_unavailable_recovered";
			narratorId: string;
			model: string;
			nugModelId?: string;
			waitKind?: "credentials" | "quota";
	  }
	| {
			type: "queued_new_narrator_created";
			narratorId: string;
			messageId: string;
			newNarratorId: string;
	  }
	/**
	 * The tool passed its permission gate and began executing.
	 *
	 * Separate from `tool_started` (which means the INPUT finished parsing) because the
	 * approval prompt and any reflection gate sit between the two — a client that reads
	 * `tool_started` as "executing" claims work has begun while the narrator may be
	 * waiting on a person.
	 */
	| {
			type: "tool_executing";
			narratorId: string;
			toolUseId: string;
			executionStartedAt: number;
			parentToolUseId?: string;
	  }
	| { type: "tool_progress"; narratorId: string; toolUseId: string; elapsed: number }
	/**
	 * A DETERMINATE progress measurement ("N of M done") from a tool that can
	 * measure its remaining work — currently TransferFile.
	 *
	 * Separate from `tool_progress`, which carries elapsed seconds only and means
	 * "still alive". Keeping them apart lets the client decide between a real bar
	 * and a spinner by WHICH frame arrived, rather than by probing fields.
	 */
	| {
			type: "tool_structured_progress";
			narratorId: string;
			toolUseId: string;
			progress: ToolProgressPayload;
			parentToolUseId?: string;
	  }
	/**
	 * A running Await-agent or single-target Send has resolved its child narrator,
	 * so its card can offer "open session" DURING the wait. The legacy event name
	 * is shared by both navigation-only updates; neither is a tool result.
	 *
	 * Needed as its own frame because the id is otherwise unknowable until the tool
	 * returns: an in-flight call has no `outputJson`, hence no `metadata.subagentId`
	 * and no `<subagent_id>` tag. Reloads get the same fact from the message loader
	 * (`AWAIT_AGENT_RESOLVED_FIELD`); this frame is what spares an already-open page
	 * from needing one.
	 */
	| {
			type: "await_agent_resolved";
			narratorId: string;
			toolUseId: string;
			subagentNarratorId: string;
			parentToolUseId?: string;
	  }
	/** Navigation receipts only: queued deliveryMessageIds may not yet exist in the DB. */
	| {
			type: "send_delivery_resolved";
			narratorId: string;
			toolUseId: string;
			targets: import("@shared/communication-tool").SendDeliveryReceipt[];
			targetCount?: number;
			toolCallBinding?: { toolCallId: string; attempt: number };
			parentToolUseId?: string;
	  }
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
			parentToolUseId?: string;
			/**
			 * Child-row label for the parent card's "recent calls" list. Only sent on the
			 * parent copy of a subagent event, where the raw `input` is deliberately
			 * withheld. See {@link SubagentToolInputSummary}.
			 */
			inputSummary?: SubagentToolInputSummary;
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
	// The three buffer snapshots all carry `toBufferSummary`'s output. They used to
	// inline a narrower shape that had already drifted (missing imageCount/creator),
	// so clients could not see attachments the server was in fact sending.
	| { type: "buffer_set"; narratorId: string; messages: BufferMessageSummary[] }
	| {
			type: "buffer_consumed";
			narratorId: string;
			messageId: string;
			remaining: BufferMessageSummary[];
	  }
	| { type: "buffer_cleared"; narratorId: string; reason: "cancelled" | "sent" | "narrator_error" }
	| { type: "buffer_preserved"; narratorId: string; messages: BufferMessageSummary[] }
	| { type: "permission_mode_changed"; narratorId: string; permissionMode: string }
	| {
			type: "model_settings_changed";
			narratorId: string;
			model?: string;
			reasoningEffort?: string | null;
			/** Present for `__parent__` children: followed parent, or pool fallback. */
			modelInheritance?: SubagentModelInheritance;
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
			fileReferences?: import("@shared/file-reference").FileReference[];
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
			model?: string;
			reasoningEffort?: string;
			startedAt?: string;
			/**
			 * 1-based ordinal of the retry now in flight, present only on the
			 * immediate broadcast emitted when a failed summary attempt is
			 * scheduled for retry. Absent (or 0 on the client) means "not
			 * retrying" — regular throttled ticks never carry it.
			 */
			retryCount?: number;
			/** Message of the error that triggered the retry (paired with retryCount). */
			retryError?: string;
			/**
			 * Where the summary model's context window came from. `fallback` means
			 * nothing user/catalog/provider configured a window, so packing used the
			 * tier default — worth telling the user when compact fails or stalls.
			 */
			contextWindowSource?: ModelContextWindowSource;
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
			/** Why the compact failed (also persisted on the failed marker message). */
			error?: string;
			/** Provenance of the summary model's context window (see compact_progress). */
			contextWindowSource?: ModelContextWindowSource;
			/** COW compact retry replacement identity, when this is a retry. */
			oldMessageId?: string;
			replacedMessageId?: string;
			newMessageId?: string;
			replacementMessageId?: string;
	  }
	| { type: "segment_compact_hide"; narratorId: string; hiddenMessageIds: string[] }
	| {
			type: "context_usage";
			source?: import("@shared/context-usage").ContextUsageSource;
			snapshot?: import("@shared/context-usage").ContextUsageSnapshot;
			narratorId: string;
			percentage: number;
			isSubagent?: boolean;
			promptTokens?: number;
			contextWindow?: number;
			isEstimated?: boolean;
			compactStart?: number;
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
	| {
			type: "narrator_forked";
			narratorId: string;
			parentNarratorId: string;
			/** Extract-to-primary: parentNarratorId is the source, not the DB parent. */
			extracted?: boolean;
	  }
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
			streamingEditOrigin?: StreamingEditOrigin;
			narratorId: string;
			toolCallId: string | null;
			toolUseId: string;
			subagentNarratorId?: string;
			toolName: string;
			input?: unknown;
			inputDocument?: TextDocumentStreamUpdate;
			streamStartedAt?: number;
			streamCompletedAt?: number;
			parentToolUseId?: string;
			/**
			 * Child-row label for the parent card's "recent calls" list. Only sent on the
			 * parent copy of a subagent event, where the raw `input` is deliberately
			 * withheld. See {@link SubagentToolInputSummary}.
			 */
			inputSummary?: SubagentToolInputSummary;
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
			streamingField?: {
				name: string;
				delta: string;
				startsField?: boolean;
				offset?: number;
				complete?: boolean;
			};
			inputDocument?: TextDocumentStreamUpdate;
			/**
			 * Child-row label for the parent card's "recent calls" list. Built from the
			 * fields the streaming JSON parser has already extracted, so the row can be
			 * labelled BEFORE the input finishes arriving.
			 */
			inputSummary?: SubagentToolInputSummary;
	  }
	| {
			type: "subagent_started";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
			subagentType: string;
			model?: string;
			reasoningEffort?: string;
			/** Present for `__parent__` children: followed parent, or pool fallback. */
			modelInheritance?: SubagentModelInheritance;
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
	/**
	 * Incremental background-task list update.
	 *
	 * Replaces the list's polling: the client applies `upsert`/`removeIds` in place
	 * as long as `version` advances by exactly one within the same `listEpoch`, and
	 * refetches its first page otherwise. Carrying the whole row (rather than a
	 * status patch) means a task the client has never seen and one it has both take
	 * the same path.
	 */
	| ({
			type: "background_task_list_delta";
			/** The PARENT narrator whose list changed. */
			narratorId: string;
	  } & BackgroundTaskListDelta)
	/**
	 * Live byte progress for one background transfer row.
	 *
	 * A separate frame from `background_task_list_delta` on purpose: that channel is
	 * version-ordered and a skipped version costs a full page refetch, while this
	 * one fires ~2×/s per active transfer. Each payload is a complete snapshot, so a
	 * dropped frame is self-correcting and no sequencing is required.
	 */
	| ({
			type: "background_task_progress";
			/** The PARENT narrator whose list holds the row. */
			narratorId: string;
	  } & BackgroundTaskProgressFrame)
	| {
			type: "git_status";
			narratorId: string;
			/** Null for chapter-less narrators, whose tools still touch a local Git repo. */
			chapterId: string | null;
			toolUseId: string;
			status: GitStatusSummary;
			commitsAhead?: number;
			baseBranch?: string;
			linesAdded?: number;
			linesRemoved?: number;
	  }
	| {
			/**
			 * Individual paths that changed under this narrator's worktree, so a file tree
			 * can patch the affected directories rather than refetching.
			 *
			 * Paths are worktree-RELATIVE: the client knows its own root, and absolute
			 * paths would disclose the host's directory layout to every subscriber.
			 *
			 * Only emitted while the native watcher is running
			 * (`NARRAFORK_ENABLE_NATIVE_WATCHER=1`); the default polling fallback observes
			 * no paths. A receiver must therefore treat this as an accelerator over its own
			 * on-demand fetching, never as its only route to a fresh view.
			 *
			 * `truncated` says more changed than `changes` lists — the batch hit the
			 * watcher's per-window cap. The list is then a sample, not the set, and the
			 * receiver must invalidate broadly instead of applying it literally.
			 */
			type: "workspace_paths_changed";
			narratorId: string;
			chapterId: string;
			toolUseId: string;
			changes: readonly { path: string; kind: "added" | "updated" | "deleted" }[];
			truncated: boolean;
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
			 * Non-persisted diagnostic for leaked XML tool calls. The frontend
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
	/**
	 * Background commit sync failed, so the commit list and Git panel are serving
	 * cached rows. The client already had the handler for this (a warning toast plus
	 * a refetch of the chapter's git state); nothing on the server ever sent it, so
	 * a failed sync silently kept showing stale data.
	 */
	| {
			type: "commit_sync_error";
			narratorId: string;
			chapterId: string;
			code: string;
			error: string;
			/** Cached rows are still being served, so this is a degradation, not a stop. */
			fallback: boolean;
			/** Raised by a watcher tick rather than by something the user just asked for. */
			backgroundSync: boolean;
	  }
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
			/**
			 * Lightweight counterpart to `background_task_list_delta` for list-level
			 * consumers (RecentTabs sidebar, narrator list) that only need the active
			 * count and must not parse full delta payloads. Emitted alongside every
			 * list delta, so it changes exactly when the delta's `activeCount` does.
			 */
			type: "background_task_count_changed";
			narratorId: string;
			activeBackgroundTaskCount: number;
			activeBackgroundWorkCount?: number;
			activeBackgroundServiceCount?: number;
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
			type: "streaming_identity";
			narratorId: string;
			model: string;
			provider: string;
			parentToolUseId?: string;
	  }
	| {
			type: "streaming_snapshot";
			narratorId: string;
			model?: string;
			provider?: string;
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
				/** The tool's INPUT finished parsing (NOT "it is executing" — see `executing`). */
				started?: boolean;
				/**
				 * Execution actually began (permission granted). A client reconnecting mid-tool
				 * needs this to tell "waiting on a human" apart from "running"; without it the
				 * only available signal was `started`, which is true in both cases.
				 */
				executing?: boolean;
				input?: unknown;
				streamStartedAt?: number;
				streamCompletedAt?: number;
				streamingOutput?: string;
				/**
				 * Latest determinate progress measurement, so a client that connects
				 * mid-transfer paints the bar from its catch-up instead of waiting for
				 * the next frame.
				 */
				structuredProgress?: ToolProgressPayload;
				/**
				 * Child-row label for a subagent chunk (`parentToolUseId` set), where
				 * `input` is deliberately absent. Lets a reconnecting client relabel the
				 * parent card's rows without waiting for the next REST fetch.
				 */
				inputSummary?: SubagentToolInputSummary;
			}>;
	  }
	| { type: "model_changed"; narratorId: string; model: string }
	/**
	 * 切模型后按新模型重估的历史占用逼近/超过了新模型的窗口。
	 *
	 * 这是**告知**，不是失败：切换本身已经照常完成，服务端既不自动压缩也不回退。
	 * 之所以要单独发一帧：占用率是按旧模型的窗口算的百分比，换掉分母后旧百分比失
	 * 真，界面上的进度条会显示一个安全的数字，而实际下一轮请求可能直接被拒。
	 * 带上数字而不是一句话，客户端才能把它排成"估算 52.5 万 / 窗口 27.2 万"。
	 */
	| {
			type: "context_window_warning";
			narratorId: string;
			model: string;
			provider: string;
			/** 按新模型重建历史后的估算占用。 */
			promptTokens: number;
			contextWindow: number;
			/** 估算占用率（百分比，可能大于 100）。 */
			percent: number;
			/**
			 * 非本地化回退文案（英文）。界面按自己的语言用上面的数字重排，
			 * 这个字段是给日志、IM 转发和没有本地化实现的客户端兜底的。
			 */
			message: string;
	  }
	| { type: "streaming_reset"; narratorId: string; parentToolUseId?: string }
	/**
	 * Live tool cards that will never complete, because the attempt that streamed
	 * their arguments was abandoned and replayed. They were never persisted, so no
	 * `tool_completed` or message will retire them — the client must drop them or
	 * they stay "running" forever.
	 */
	| {
			type: "tool_use_discarded";
			narratorId: string;
			toolUseIds: string[];
			parentToolUseId?: string;
	  }
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
	/**
	 * The user took over (or released) a subagent — the PARENT's waiting card must
	 * say so.
	 *
	 * Distinct from `subagent_status_changed` (which carries the same fact in its
	 * substatus) because that frame is consumed by the PANEL subscription, whose job
	 * is the narrator row's status chip. This one belongs to the MESSAGE layer: it
	 * patches the blocked Agent/Task or in-flight Await card, which is the only place
	 * a reader can see WHY the session stopped moving.
	 *
	 * `toolUseId` is best-effort: when the spawning tool_use cannot be resolved the
	 * frame still ships, and the client falls back to matching the card by
	 * `subagentNarratorId`. Dropping the frame instead would silently lose the
	 * indicator in exactly the edge cases that are hardest to debug.
	 */
	| {
			type: "subagent_takeover_changed";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId?: string;
			takenOver: boolean;
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
			/** A subagent is suspended on a self-recovering block (credential pool or quota). */
			type: "subagent_model_unavailable_waiting";
			narratorId: string;
			subagentNarratorId: string;
			message: string;
			model: string;
			nugModelId?: string;
			waitKind?: "credentials" | "quota";
			resumeAt?: number;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			/** A suspended subagent's block cleared; it is resuming. */
			type: "subagent_model_unavailable_recovered";
			narratorId: string;
			subagentNarratorId: string;
			model: string;
			nugModelId?: string;
			waitKind?: "credentials" | "quota";
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
	/**
	 * A subscribe request was refused because the connection's user may not read
	 * that narrator (or it does not exist — deliberately indistinguishable, matching
	 * the 404-on-denial rule of the HTTP surface).
	 *
	 * Sent so the client stops waiting: without it a denied subscription looks
	 * exactly like a narrator that has simply produced no events yet, and the UI
	 * would sit on a loading spinner forever.
	 */
	| { type: "subscribe_denied"; narratorId: string; requestId?: string }
	/**
	 * Project membership or visibility changed; the client should re-read its own
	 * access. Carries no membership detail, so a recipient cannot learn who else is in
	 * the project from the notification alone.
	 */
	| {
			type: "project_access_changed";
			projectId: string;
			reason: "visibility_changed" | "members_changed" | "owner_changed";
	  }
	/**
	 * Sharing settings for a narrator changed and the client should re-read its own
	 * access. Deliberately carries no grant detail: a recipient must not learn who
	 * else a narrator is shared with, only that their own answer may have moved.
	 */
	| {
			type: "narrator_access_changed";
			narratorId: string;
			reason:
				| "visibility_changed"
				| "write_audience_changed"
				| "shared"
				| "unshared"
				| "grant_changed"
				| "owner_changed";
	  }
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
			type: "spec_changed";
			narratorId: string;
			uri: string;
			path: string;
			revisionId: string | null;
			updatedBy: "user" | "assistant" | "system";
			source: "ui" | "tool" | "task_create" | "reset";
	  }
	| {
			/**
			 * A knowledge-base publish request needs this user's review, or one of their
			 * own publish requests changed state. Delivered per-user via `broadcastToUser`
			 * (no narratorId — it is not narrator-scoped).
			 *
			 * Deliberately id-only: the client refetches through the ACL-checked HTTP
			 * endpoints, so no entry title/content ever crosses this channel.
			 */
			type: "knowledge:review_inbox_changed";
			/** Why the inbox/badge should refresh, for client-side toast wording. */
			reason:
				| "submission_created"
				| "submission_reviewed"
				| "submission_invalidated"
				| "entry_published";
			submissionId: string;
			/** Set when the recipient is the submitter rather than a candidate reviewer. */
			role: "reviewer" | "submitter";
			/** Submission status after the change (absent for `submission_created`). */
			status?: string;
			entryId?: string | null;
	  }
	| {
			/**
			 * Something outside the review queue changed for this user's knowledge view:
			 *  - `entry_drifted`     — a global entry they hold a personal version of moved on,
			 *                          so their copy needs a rebase.
			 *  - `acl_changed`       — their knowledge authorization changed; the readable set,
			 *                          review scope and badges may all differ now.
			 *  - `owner_transferred` — they gained or lost ownership of an entry/collection.
			 *
			 * Same id-only discipline as `review_inbox_changed`: no titles or bodies cross this
			 * channel, the client refetches through the ACL-checked HTTP endpoints.
			 */
			type: "knowledge:library_changed";
			reason: "entry_drifted" | "acl_changed" | "owner_transferred";
			/** Set for entry-scoped reasons (`entry_drifted`, entry owner transfer). */
			entryId?: string | null;
			/** Set for collection-scoped reasons (collection owner transfer). */
			collectionId?: string | null;
	  }
	/**
	 * A person posted in a chat room this connection subscribed to.
	 *
	 * Unlike the knowledge signals this DOES carry the body: chat is what the
	 * reader is looking at, and a refetch-per-message round trip would make a live
	 * conversation feel like polling. It is safe to carry because the room was
	 * authorized once at subscribe time (`assertCanRead`) and the body is bounded
	 * by `CHAT_MESSAGE_MAX_CHARS`.
	 */
	| {
			type: "chat:message";
			roomId: string;
			message: {
				id: string;
				roomId: string;
				seq: number;
				kind: "text" | "system";
				contentText: string;
				replyToMessageId: string | null;
				/**
				 * The reply snapshot and attachment metadata travel WITH the frame.
				 *
				 * Omitting them would make a live-arriving reply render an empty quote
				 * strip (and an attachment-only message render as blank) until something
				 * else triggered a refetch — a defect visible only on the live path,
				 * which is the path most messages take.
				 */
				replyToSeq: number | null;
				replyToSender: {
					id: string;
					username: string;
					avatarColor: string | null;
					avatarImageId: string | null;
				} | null;
				replyToPreview: string | null;
				attachments: Array<{
					id: string;
					kind: "image" | "file";
					filename: string;
					mediaType: string;
					sizeBytes: number;
					width: number | null;
					height: number | null;
				}>;
				editedAt: string | null;
				deletedAt: string | null;
				createdAt: string;
				sender: {
					id: string;
					username: string;
					avatarColor: string | null;
					avatarImageId: string | null;
				} | null;
			};
	  }
	| { type: "chat:message_deleted"; roomId: string; messageId: string }
	/** Another member advanced their read watermark (read receipt). */
	| { type: "chat:read"; roomId: string; userId: string; lastReadSeq: number }
	/**
	 * Per-user badge refresh for a room this user is NOT currently viewing.
	 * Id + count only; the client refetches the summary if it needs more.
	 */
	| { type: "chat:unread_changed"; roomId: string; unread: number };
