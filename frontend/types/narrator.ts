import type { HumanAttentionItem } from "@shared/human-attention";
import type { ExecutionTargetIdentity } from "../lib/api/types";

/** Full decision input is fetched only after opening a summary row. */
export interface HumanAttentionDetail {
	item: HumanAttentionItem;
	question?: AsyncQuestion;
	permission?: PendingPermission;
	/** No safe approval is possible without reviewing the omitted input in its session. */
	tooLarge?: boolean;
}

export interface PendingPermission {
	id: string;
	toolName: string;
	toolUseId?: string;
	/** Parent Agent/Task/Send tool use that owns this subagent permission. */
	parentToolUseId?: string | null;
	/** Subagent session that emitted the permission. */
	subagentNarratorId?: string | null;
	/** Narrator whose permission endpoint owns this request. */
	ownerNarratorId?: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	inputJson: any;
	decisionReason?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	suggestions?: any[];
	/** Frozen execution target captured before permission handling. */
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	executionTarget?: ExecutionTargetIdentity | null;
	executionTargets?: ExecutionTargetIdentity[];
	deviceSelectionSource?: "explicit" | "session_default" | "local_default" | null;
	suppressNotifications?: boolean;
	/**
	 * Absolute epoch-ms deadline for automatic AskUserQuestion reflection, used to
	 * render a live countdown. Cleared once the timer is disarmed or fires.
	 */
	reflectionDeadline?: number;
}

/** One question definition inside an async question record. */
export interface AsyncQuestionDefinition {
	/** Internal draft key; not advertised to models. */
	id: string;
	/** SHORT title shown as the heading; also the model-facing answers key. */
	header: string;
	/** Optional FULL prompt / extra context under the header. */
	description?: string;
	multiSelect?: boolean;
	options?: { header: string; description?: string; preview?: string }[];
}

export type AsyncQuestionStatus = "open" | "answered" | "dismissed" | "withdrawn";

/**
 * An asynchronous AskUserQuestion (`narrator_questions`).
 *
 * Deliberately NOT a `PendingPermission`: nothing is suspended waiting for it, so it
 * must not reach the places that assume a blocked loop (the composer send gate, the
 * Enter-key binding, attention notifications). It is a durable record the user works
 * through when convenient.
 */
export interface AsyncQuestion {
	id: string;
	narratorId: string;
	toolCallId: string;
	toolUseId: string;
	questions: AsyncQuestionDefinition[];
	answers: Record<string, string> | null;
	annotations?: Record<string, { preview?: string; notes?: string }> | null;
	status: AsyncQuestionStatus;
	origin: "agent_async" | "user_deferred";
	answerMessageId: string | null;
	decidedBy: string | null;
	decidedAt: string | null;
	createdAt: string;
	/**
	 * True while the agent is BLOCKED on this question via `Await`.
	 *
	 * This is the one case where an async question is urgent: the session has stopped
	 * and is waiting for this specific answer. The inbox ranks these first and says so,
	 * and the server raises the same attention intent a permission prompt does.
	 */
	awaited?: boolean;
}
