/**
 * Narrator WebSocket message types — extracted to a standalone file so that
 * both event-bus.ts and narrator-ws.ts can reference NarratorServerMessage
 * without creating circular imports.
 */
import type { GitStatusSummary } from "../services/git-service";

// Server → Client messages
export type NarratorServerMessage =
	| { type: "message"; narratorId: string; message: unknown }
	| { type: "stream_event"; narratorId: string; event: unknown }
	| { type: "permission_request"; narratorId: string; request: unknown }
	| {
			type: "danger_reflection_started";
			narratorId: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			danger: unknown;
	  }
	| {
			type: "danger_reflection_resolved";
			narratorId: string;
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
	  }
	| {
			type: "danger_reflection_stopped";
			narratorId: string;
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
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson: unknown;
			reason?: string;
	  }
	| {
			type: "plan_reflection_resolved";
			narratorId: string;
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
	  }
	| {
			type: "plan_reflection_stopped";
			narratorId: string;
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson: unknown;
			reason?: string;
	  }
	| {
			type: "status_change";
			narratorId: string;
			status: string;
			substatus?: string[];
			turnStartedAt?: string;
	  }
	| { type: "substatus_change"; narratorId: string; substatus: string[] }
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
			toolUseId: string;
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
			requestId: string;
			toolUseId?: string;
			decision?: "allow" | "deny";
			updatedInput?: Record<string, unknown>;
			feedbackText?: string;
	  }
	| { type: "todos_updated"; narratorId: string; todos: unknown[]; toolUseId?: string }
	| { type: "goals_set"; narratorId: string; goals: unknown[] }
	| { type: "goal_continuation"; narratorId: string; goal: unknown }
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
	| { type: "relaxed_plan_changed"; narratorId: string; relaxedPlan: boolean }
	| { type: "user_message"; narratorId: string; message: unknown }
	| { type: "compacting"; narratorId: string }
	| {
			type: "compact_done";
			narratorId: string;
			contextPercentAfter?: number;
			isSegment?: boolean;
	  }
	| { type: "compact_failed"; narratorId: string; messageId: string }
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
	| { type: "messages_deleted"; narratorId: string; deletedMessageIds: string[] }
	| { type: "message_updated"; narratorId: string; message: unknown }
	| { type: "narrator_forked"; narratorId: string; parentNarratorId: string }
	| { type: "narrator_error"; narratorId: string; error: string; errorCode?: string }
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
			outputIndex?: number;
			parentToolUseId?: string;
	  }
	| {
			type: "tool_started";
			narratorId: string;
			toolUseId: string;
			toolName: string;
			input: unknown;
			streamStartedAt?: number;
			parentToolUseId?: string;
	  }
	| {
			type: "tool_use_chunk";
			narratorId: string;
			toolUseId: string;
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
	  }
	| { type: "error"; message: string }
	| {
			type: "warning";
			narratorId: string;
			message: string;
			retryCount?: number;
			maxRetries?: number;
			delayMs?: number;
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
			type: "container_status_changed";
			narratorId: string;
			chapterId: string;
			containerStatus: string | null;
	  }
	| {
			narratorId: string;
			quotaBalance: number | null;
	  }
	| {
			narratorId: string;
			position: number;
			queueDepth: number;
	  }
	| {
			type: "quota_balance";
			narratorId: string;
			quotaBalance: string | null;
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
						outputIndex?: number;
				  }
				| { type: "text"; text: string; outputIndex?: number }
			>;
			toolChunks: Array<{
				toolUseId: string;
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
			type: "subagent_todos_updated";
			narratorId: string;
			subagentNarratorId: string;
			todos: unknown[];
			toolUseId?: string;
	  }
	| {
			type: "subagent_warning";
			narratorId: string;
			subagentNarratorId: string;
			message: string;
			retryCount?: number;
			maxRetries?: number;
			delayMs?: number;
	  }
	| {
			type: "subagent_conclusion_updated";
			narratorId: string;
			subagentNarratorId: string;
			toolUseId: string;
			output: string;
			hasError: boolean;
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
	  };
