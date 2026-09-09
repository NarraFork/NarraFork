/**
 * The frontend's canonical shape for one tool call record.
 *
 * Historically declared in ToolCallCard.tsx; extracted into this neutral,
 * dependency-light module so data-path consumers (message segments, helpers,
 * the vlist adapter) do not import the 6k-line card component just for a type.
 */

import type { ToolProgressPayload } from "@shared/tool-progress";
import type { SubagentActivitySummary } from "../../lib/api";
import type { ExecutionTargetIdentity } from "../../lib/api/types";

export interface ToolCallData {
	id?: string;
	toolName: string;
	toolUseId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	inputJson: any;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	outputJson?: any;
	status: string;
	durationMs?: number;
	streamStartedAt?: string | number | null;
	permissionStartedAt?: string | number | null;
	executionStartedAt?: string | number | null;
	completedAt?: string | number | null;
	createdAt?: string | number | null;
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	executionTarget?: ExecutionTargetIdentity | null;
	executionTargets?: ExecutionTargetIdentity[];
	deviceSelectionSource?: "explicit" | "session_default" | "local_default" | null;
	errorMessage?: string;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
	/** Who decided this permission. `narrator:<id>` marks a proxy approval by a controlling named narrator. */
	permissionDecidedBy?: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	permissionSuggestions?: any[] | null;
	/** Timestamp (Date.now()) when the tool started running — used for live elapsed timer */
	startedAt?: number;
	/** Optional metadata from the tool (e.g. line numbers for Edit) */
	_metadata?: Record<string, unknown>;
	/** Set by watchdog when process has been running ≥60s — shows terminate button */
	_longRunning?: boolean;
	/** Real-time streaming output from bash tool (updated via WS tool_output events) */
	_streamingOutput?: string;
	/**
	 * Latest determinate progress measurement (WS `tool_structured_progress`).
	 *
	 * Rendered as a real progress bar. Kept separate from `_streamingOutput`
	 * because the two are different kinds of thing: one is a text stream, this is
	 * a measurement — drawing a bar out of the text would mean re-parsing the
	 * tool's own formatting.
	 */
	_structuredProgress?: ToolProgressPayload;
	/** Frontend promoted a complete streaming output into outputJson on completion */
	_streamedFullOutput?: boolean;
	/** Current timeout in ms (set from inputJson.timeout or updated via WS timeout_updated) */
	_timeoutMs?: number;
	/** Subagent assistant message ID that produced the result (for scroll-to navigation) */
	resultMessageId?: string;
	/** Lightweight latest activity for Agent/Task/Send subagent cards. */
	_subagentActivity?: SubagentActivitySummary;
	/**
	 * Child narrator id of a RUNNING Await-agent or single-target Send, resolved
	 * by the server from the call's target selector (legacy transport field name).
	 *
	 * A wait in flight has no output, so `metadata.subagentId` and the
	 * `<subagent_id>` tag do not exist yet — this is the only source that lets the
	 * card open the child's session before the wait returns. Kept out of `_metadata`
	 * on purpose (it would render an extra `subagent:` row and change measured
	 * height); see `AWAIT_AGENT_RESOLVED_FIELD` on the server.
	 */
	_awaitAgentNarratorId?: string;
	/** Accepted/queued delivery receipts, independent of the eventual tool result. */
	_sendDeliveryTargets?: Array<{ id: string; deliveryMessageId: string }>;
	/**
	 * The subagent this call waits on is TAKEN OVER by the user, so the call is
	 * blocked until the takeover stops.
	 *
	 * Kept out of `_metadata` for the same two reasons as
	 * `_awaitAgentNarratorId`: it must not become an extra detail row (height), and
	 * it is server-derived rather than tool-reported (provenance).
	 */
	_takenOver?: boolean;
}
