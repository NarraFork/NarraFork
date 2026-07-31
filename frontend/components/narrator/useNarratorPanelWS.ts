import { notifications } from "@mantine/notifications";
import type { ProgressSnapshot } from "@shared/progress-phase";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { useNarratorPermissionsCapability } from "../../hooks/usePlatform";
import { api, type BufferMessageSummary } from "../../lib/api";
import { localizeNarratorError } from "./error-localization";
import {
	isActiveReflectionPermissionLike,
	isReflectionPermissionLike,
} from "./narrator-message-helpers";
import type {
	ContentBlock,
	NarratorMsg,
	PendingPermission,
	PermissionCallbacks,
} from "./narrator-panel-types";
import {
	clearAllReflectionProgress,
	clearReflectionProgress,
	setReflectionProgress,
} from "./reflection-progress-store";

/**
 * Message-layer events exclusively owned by the chunks hook (useNarratorChunksWS).
 * Panel never receives these — they are unconditionally excluded from the
 * panel's `kind: "panel"` subscription.
 */
const PANEL_EXCLUDED_EVENT_TYPES = [
	"user_message",
	"message_updated",
	"tool_use_chunk",
	"tool_completed",
	"sidecars",
	"tool_long_running",
	"timeout_updated",
	"tool_output",
	"subagent_started",
	"segment_compact_hide",
	"web_search",
	"image_generation",
	"streaming_reset",
	"background_task_completed",
	"background_task_failed",
	"background_task_cancelled",
] as const;

export interface ViewerInfo {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
}

export interface RetryInfo {
	message: string;
	retryCount: number;
	maxRetries: number;
	/** Timestamp (ms) when the retry delay expires */
	retryAt: number;
}

export interface PaymentRequiredInfo {
	providerId?: string;
	providerPrefix?: string;
	balance?: number;
	required?: number;
	resumeAction: "retry" | "continue";
}

/** Leaked XML tool-call diagnostic surfaced for the recovered/unrecovered dialog. */
export interface LeakedToolEvent {
	phase: "recovered" | "unrecovered";
	apiRequestId: string;
	toolNames?: string[];
	snippet?: string;
}

function isPageVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

function usePageVisibility(): boolean {
	const [visible, setVisible] = useState(isPageVisible);

	useEffect(() => {
		if (typeof document === "undefined") return;
		const handleVisibilityChange = () => setVisible(isPageVisible());
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, []);

	return visible;
}

function numericUsageField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function promptTokensFromTurnUsage(turnUsage: Record<string, unknown>): number | undefined {
	const promptTokens = numericUsageField(turnUsage.prompt_tokens);
	if (promptTokens != null) return promptTokens;
	const inputTokens = numericUsageField(turnUsage.input_tokens);
	if (inputTokens == null) return undefined;
	return (
		inputTokens +
		(numericUsageField(turnUsage.cached_input_tokens) ?? 0) +
		(numericUsageField(turnUsage.cache_creation_input_tokens) ?? 0)
	);
}

interface InitialMessageStatus {
	statusReady?: boolean;
	contextPercent?: number | null;
	turnUsageJson?: NarratorMsg["turnUsageJson"] | null;
	pruneBoundaryMessageId?: string | null;
	prunedPercent?: number | null;
}

export interface UseNarratorPanelWSOptions {
	narratorId: string;
	narratorStatus?: string;
	narratorErrorMessage?: string | null;
	initialMessageStatus?: InitialMessageStatus;
	/** Ref to isAtBottom state for unread tracking */
	isAtBottomRef: React.RefObject<boolean>;
	/** Whether this narrator is a subagent — skip mark-read to preserve done/error status for follow-up Send */
	isSubagent?: boolean;
	/** Initial generic gateway/API quota balance from settings cache. */
	initialQuotaBalance?: string | null;
	/** Initial generic gateway/API quota details from settings cache. */
	initialDetailedQuotaBalance?: string | null;
	/** Custom API provider ID for the current narrator model (used to sync quota back to settings cache). */
	customApiProviderId?: string | null;
	/** NUG provider ID for the current narrator model (used to sync quota back to NUG cache). */
	nugProviderId?: string | null;
	/** Generic provider key for resetting runtime quota/payment state when provider changes. */
	quotaProviderKey?: string | null;
	/** Persisted substatus from narrator data — used to seed the reducer on mount so that
	 *  substatus survives page navigation (the WS-only path starts from []). */
	narratorSubstatus?: string[];
	onDraftChanged?: (draft: {
		hasDraft: boolean;
		text: string;
		revision: number;
		updatedAt: string | null;
		updatedBy: string | null;
		sourceId: string | null;
	}) => void;
	onQueuedNewNarratorCreated?: (newNarratorId: string) => void;
}

export interface UseNarratorPanelWSReturn {
	// WS connection
	connected: boolean;
	disconnected: boolean;
	reconnect: () => void;
	sendBufferMessage: (narratorId: string, text: string) => boolean;
	cancelBuffer: (narratorId: string) => boolean;
	sendPermissionDecision: (
		requestId: string,
		decision: "allow" | "deny",
		message?: string,
		answers?: Record<string, string>,
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	// Permissions
	pendingPermission: PendingPermission | null;
	pendingPermissions: PendingPermission[];
	renderPermCb: PermissionCallbacks;
	// State
	queuedMessages: BufferMessageSummary[];
	setQueuedMessages: React.Dispatch<React.SetStateAction<BufferMessageSummary[]>>;
	/**
	 * Epoch-guarded reconcile of the buffered-message queue from REST. Discards
	 * its snapshot if any authoritative WS buffer event landed while the request
	 * was in flight, so a slow GET cannot resurrect an already-consumed message.
	 */
	reconcileBufferedMessages: () => void;
	substatus: string[];
	contextPercent: number | null;
	setContextPercent: React.Dispatch<React.SetStateAction<number | null>>;
	/**
	 * True when the displayed context usage may be inaccurate because the
	 * conversation history changed locally (compact / clear / delete) without a
	 * fresh server-reported `context_usage`. Cleared on the next real
	 * `context_usage` event.
	 */
	contextStale: boolean;
	promptTokens: number | null;
	contextWindow: number | null;
	isEstimated: boolean;
	activePruneStart: number | null;
	activeCompactStart: number | null;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
	compactProgress: ProgressSnapshot | null;
	quotaBalance: string | null;
	detailedQuotaBalance: string | null;
	// Browser sessions
	browserSessionCount: number;
	browserVisualChange: { sessionId: string; seq: number } | null;
	// Retry
	retryInfo: RetryInfo | null;
	paymentRequired: PaymentRequiredInfo | null;
	setPaymentRequired: React.Dispatch<React.SetStateAction<PaymentRequiredInfo | null>>;
	leakedToolEvent: LeakedToolEvent | null;
	setLeakedToolEvent: React.Dispatch<React.SetStateAction<LeakedToolEvent | null>>;
	// Tool expand
	expandedToolUseId: string | null;
	setExpandedToolUseId: React.Dispatch<React.SetStateAction<string | null>>;
	// Unread
	unreadCount: number;
	setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
	// Viewers
	viewers: ViewerInfo[];
}

// --- Reducer for co-updated state ---
// These fields are frequently set together in the same WS callback
// (onStatusChange, onContextUsage, onPruneBoundary, onCompactDone, etc.).
// Merging them into a single useReducer avoids multiple independent re-renders
// per callback since React batches reducer dispatches into one update.

interface StatusState {
	substatus: string[];
	contextPercent: number | null;
	contextStale: boolean;
	promptTokens: number | null;
	contextWindow: number | null;
	isEstimated: boolean;
	activePruneStart: number | null;
	activeCompactStart: number | null;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
	compactProgress: ProgressSnapshot | null;
}

type StatusAction = { type: "patch"; payload: Partial<StatusState> };

function arraysEqual(a: unknown, b: unknown): boolean {
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function statusReducer(state: StatusState, action: StatusAction): StatusState {
	if (action.type === "patch") {
		// Bail out early if nothing actually changed — avoids a re-render.
		const keys = Object.keys(action.payload) as (keyof StatusState)[];
		if (
			keys.every((k) => {
				const sv = state[k];
				const pv = action.payload[k];
				if (Array.isArray(sv) || Array.isArray(pv)) return arraysEqual(sv, pv);
				return sv === pv;
			})
		)
			return state;
		return { ...state, ...action.payload };
	}
	return state;
}

function withoutQueueMessageSubstatus(substatus: string[]): string[] {
	return substatus.filter((s) => !s.startsWith("queue_message:"));
}

function hasActiveCompactSubstatus(substatus: string[]): boolean {
	return substatus.includes("compacting") || substatus.includes("background_compacting");
}

function withoutCompactingSubstatus(substatus: unknown): string[] {
	return Array.isArray(substatus)
		? substatus.filter((s) => s !== "compacting" && s !== "background_compacting")
		: [];
}

function withoutSubstatusTag(substatus: unknown, tag: string): string[] {
	return Array.isArray(substatus) ? substatus.filter((s) => s !== tag) : [];
}

function withQueueSubstatus(
	substatus: string[],
	position?: number,
	queueDepth?: number,
	queueMessage?: string,
): string[] {
	const withoutQueue = substatus.filter(
		(s) =>
			!s.startsWith("queue_position:") &&
			!s.startsWith("queue_depth:") &&
			!s.startsWith("queue_message:"),
	);
	const nextSubstatus = [...withoutQueue];
	const safePosition = typeof position === "number" && Number.isFinite(position) ? position : null;
	if (safePosition != null && safePosition > 0) {
		const safeDepth =
			typeof queueDepth === "number" && Number.isFinite(queueDepth) ? Math.max(0, queueDepth) : 0;
		nextSubstatus.push(`queue_position:${safePosition}`, `queue_depth:${safeDepth}`);
	}
	if (queueMessage) {
		nextSubstatus.push(`queue_message:${encodeURIComponent(queueMessage)}`);
	}
	return nextSubstatus;
}

export function useNarratorPanelWS(opts: UseNarratorPanelWSOptions): UseNarratorPanelWSReturn {
	const {
		narratorId,
		narratorStatus,
		narratorErrorMessage,
		initialMessageStatus,
		isSubagent,
		initialQuotaBalance,
		initialDetailedQuotaBalance,
		customApiProviderId,
		nugProviderId,
		quotaProviderKey,
		narratorSubstatus,
		onDraftChanged,
		onQueuedNewNarratorCreated,
	} = opts;
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const narratorPermissionsCapability = useNarratorPermissionsCapability();
	const permissionDecisionsSupported =
		narratorPermissionsCapability.supported && narratorPermissionsCapability.approveDeny;
	const updatedPermissionInputSupported =
		narratorPermissionsCapability.supported && narratorPermissionsCapability.updatedInput;
	const pageVisible = usePageVisibility();

	// --- Permission state ---
	// requestId is the canonical identity — only Map<requestId, PendingPermission> is mutable.
	const [pendingPermsByRequestId, setPendingPermsByRequestId] = useState<
		Map<string, PendingPermission>
	>(() => new Map());
	const pendingPermissions = useMemo(
		() => [...pendingPermsByRequestId.values()],
		[pendingPermsByRequestId],
	);
	const pendingPermission = pendingPermissions[0] ?? null;
	const permissionGenerationRef = useRef(0);
	const permissionLifecycleRef = useRef(0);
	const resolvedPermissionIdsRef = useRef(new Set<string>());

	const bumpPermissionGeneration = useCallback(() => {
		permissionGenerationRef.current += 1;
	}, []);

	const upsertPendingPermission = useCallback(
		(permission: PendingPermission) => {
			if (resolvedPermissionIdsRef.current.has(permission.id)) return;
			bumpPermissionGeneration();
			setPendingPermsByRequestId((prev) => {
				const next = new Map(prev);
				next.set(permission.id, permission);
				return next;
			});
		},
		[bumpPermissionGeneration],
	);

	const removePendingPermission = useCallback(
		(requestId: string) => {
			resolvedPermissionIdsRef.current.add(requestId);
			bumpPermissionGeneration();
			setPendingPermsByRequestId((prev) => {
				if (!prev.has(requestId)) return prev;
				const next = new Map(prev);
				next.delete(requestId);
				return next;
			});
		},
		[bumpPermissionGeneration],
	);

	const replacePendingPermissions = useCallback(
		(perms: PendingPermission[], generation: number, lifecycle: number) => {
			if (
				permissionGenerationRef.current !== generation ||
				permissionLifecycleRef.current !== lifecycle
			) {
				return false;
			}
			const next = new Map<string, PendingPermission>();
			for (const permission of perms) {
				if (resolvedPermissionIdsRef.current.has(permission.id)) continue;
				if (
					isReflectionPermissionLike(permission) &&
					!isActiveReflectionPermissionLike(permission)
				) {
					continue;
				}
				next.set(permission.id, permission);
			}
			setPendingPermsByRequestId(next);
			return true;
		},
		[],
	);

	// Reset the permission lifecycle when a Dockview panel is reused for another narrator.
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId defines the lifecycle boundary.
	useEffect(() => {
		permissionLifecycleRef.current += 1;
		permissionGenerationRef.current += 1;
		resolvedPermissionIdsRef.current = new Set();
		setPendingPermsByRequestId(new Map());
	}, [narratorId]);

	// --- Misc state (co-updated fields merged into reducer) ---
	const [queuedMessages, setQueuedMessages] = useState<BufferMessageSummary[]>([]);
	// Monotonic version of the buffer queue. Every authoritative buffer event
	// (buffer_set / buffer_consumed / buffer_cleared / buffer_preserved) bumps it.
	// REST reconciles (page load, reconnect, post-send sync) capture the epoch
	// before their request and discard their (possibly stale) snapshot if any
	// authoritative event landed while the request was in flight. This prevents a
	// slow GET that observed the pre-consume queue from resurrecting a priority
	// message that the server already consumed and broadcast as removed.
	const bufferEpochRef = useRef(0);
	const bumpBufferEpoch = useCallback(() => {
		bufferEpochRef.current += 1;
	}, []);
	// Fetch the authoritative queue but only apply it when no WS buffer event
	// superseded this request in the meantime.
	const reconcileBufferedMessages = useCallback(() => {
		const epochAtRequest = bufferEpochRef.current;
		api
			.getBufferedMessages(narratorId)
			.then((msgs) => {
				if (bufferEpochRef.current !== epochAtRequest) return;
				setQueuedMessages(msgs ?? []);
			})
			.catch(() => {});
	}, [narratorId]);
	const [statusState, dispatchStatus] = useReducer(statusReducer, {
		substatus: [],
		contextPercent: null,
		contextStale: false,
		promptTokens: null,
		contextWindow: null,
		isEstimated: false,
		activePruneStart: null,
		activeCompactStart: null,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
		compactProgress: null,
	});
	const {
		substatus,
		contextPercent,
		contextStale,
		promptTokens,
		contextWindow,
		isEstimated,
		activePruneStart,
		activeCompactStart,
		pruneBoundaryMessageId,
		prunedPercent,
		compactProgress,
	} = statusState;
	const suppressMessageDerivedCompactingRef = useRef(false);

	// --- Seed substatus from persisted narrator data ---
	// The reducer starts with substatus=[] and is normally updated via WS events.
	// When the user navigates away and back, the WS may not re-emit a status_change
	// for an idle narrator, so the substatus stays []. Seed it from the server data
	// once on mount so that "Update Conclusion" and other substatus-dependent UI
	// survives page navigation.
	const substatusSeededRef = useRef(false);
	// Reset seed flag/state when narrator changes so a reused Dockview panel cannot
	// carry the previous narrator's transient tags (e.g. interrupted) into the next one.
	// This effect intentionally runs before the seeding effect below.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on narratorId change
	useEffect(() => {
		substatusSeededRef.current = false;
		suppressMessageDerivedCompactingRef.current = false;
		dispatchStatus({
			type: "patch",
			payload: { substatus: [], compactProgress: null },
		});
		// Reflection progress lives in a module store keyed by gate requestId, so it
		// is outside this hook's state and outside the document's narrator scoping. A
		// provider request id can legitimately recur across narrators, so drop
		// everything rather than risk showing one narrator's progress on another's card.
		clearAllReflectionProgress();
	}, [narratorId]);
	useEffect(() => {
		if (substatusSeededRef.current) return;
		if (!narratorSubstatus?.length) return;
		// Only seed for non-active states — active states get real-time WS updates
		if (narratorStatus === "working" || narratorStatus === "waiting") return;
		dispatchStatus({ type: "patch", payload: { substatus: narratorSubstatus } });
		substatusSeededRef.current = true;
	}, [narratorSubstatus, narratorStatus]);

	const setContextPercent = useCallback(
		(v: React.SetStateAction<number | null>) => {
			dispatchStatus({
				type: "patch",
				payload: {
					contextPercent: typeof v === "function" ? v(statusState.contextPercent) : v,
				},
			});
		},
		[statusState.contextPercent],
	);
	const [browserSessionCount, setBrowserSessionCount] = useState(0);
	// Carries a monotonic seq alongside the sessionId so consecutive visual
	// changes to the SAME session still produce a new object reference and
	// trigger the screenshot auto-refresh (a bare string would bail out of
	// React state updates when unchanged).
	const [browserVisualChange, setBrowserVisualChange] = useState<{
		sessionId: string;
		seq: number;
	} | null>(null);
	const [quotaBalance, setQuotaBalance] = useState<string | null>(initialQuotaBalance ?? null);
	const [detailedQuotaBalance, setDetailedQuotaBalance] = useState<string | null>(
		initialDetailedQuotaBalance ?? null,
	);
	// Sync initial generic quota when switching narrators or custom API providers.
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId/providerId must reset same-balance stale runtime state.
	useEffect(() => {
		setQuotaBalance(initialQuotaBalance ?? null);
		setDetailedQuotaBalance(initialDetailedQuotaBalance ?? null);
		setPaymentRequired(null);
	}, [narratorId, quotaProviderKey, initialQuotaBalance, initialDetailedQuotaBalance]);
	const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
	const [paymentRequired, setPaymentRequired] = useState<PaymentRequiredInfo | null>(null);
	const [leakedToolEvent, setLeakedToolEvent] = useState<LeakedToolEvent | null>(null);
	const retryInfoRef = useRef<RetryInfo | null>(null);
	const clearRetryIfActive = useCallback(() => {
		if (retryInfoRef.current) {
			retryInfoRef.current = null;
			setRetryInfo(null);
		}
	}, []);
	const [unreadCount, setUnreadCount] = useState(0);

	// --- Viewers ---
	const [viewers, setViewers] = useState<ViewerInfo[]>([]);

	// --- Tool expand ---
	const [expandedToolUseId, setExpandedToolUseId] = useState<string | null>(null);

	useEffect(() => {
		if (!expandedToolUseId) return;
		const timer = setTimeout(() => setExpandedToolUseId(null), 500);
		return () => clearTimeout(timer);
	}, [expandedToolUseId]);

	// --- Initialize context/prune state from initial message data ---
	// (handled below after WS section)

	// --- Permission decision refs ---
	const sendPermissionDecisionRef = useRef<
		| ((
				requestId: string,
				decision: "allow" | "deny",
				message?: string,
				answers?: Record<string, string>,
				feedbackText?: string,
				compactAfter?: boolean,
				updatedPlan?: string,
		  ) => boolean)
		| null
	>(null);
	const pendingPermsByRequestIdRef = useRef(pendingPermsByRequestId);
	pendingPermsByRequestIdRef.current = pendingPermsByRequestId;

	/** Resolve exactly one requestId without disturbing concurrent sibling permissions. */
	const resolveAndRemovePerm = useCallback(
		(requestId: string): { toolUseId: string | undefined; perm: PendingPermission | undefined } => {
			const perm = pendingPermsByRequestIdRef.current.get(requestId);
			resolvedPermissionIdsRef.current.add(requestId);
			bumpPermissionGeneration();
			setPendingPermsByRequestId((prev) => {
				if (!prev.has(requestId)) return prev;
				const next = new Map(prev);
				next.delete(requestId);
				return next;
			});
			return { toolUseId: perm?.toolUseId, perm };
		},
		[bumpPermissionGeneration],
	);

	// --- Permission decision handlers ---
	const handlePermissionDecision = useCallback(
		(
			requestId: string,
			decision: "allow" | "deny",
			feedbackText?: string,
			compactAfter?: boolean,
			updatedPlan?: string,
		) => {
			if (!permissionDecisionsSupported) return;
			const nextUpdatedPlan = updatedPermissionInputSupported ? updatedPlan : undefined;
			const wsSent = sendPermissionDecisionRef.current?.(
				requestId,
				decision,
				undefined,
				undefined,
				feedbackText,
				compactAfter,
				nextUpdatedPlan,
			);
			// Fallback to HTTP API when WS send fails (e.g. reconnecting)
			if (!wsSent) {
				const payload = {
					feedbackText,
					compactAfter,
					updatedPlan: nextUpdatedPlan,
				};
				if (decision === "allow") {
					api.approvePermission(requestId, payload).catch(() => {});
				} else {
					api.denyPermission(requestId, payload).catch(() => {});
				}
			}
			resolveAndRemovePerm(requestId);
		},
		[permissionDecisionsSupported, resolveAndRemovePerm, updatedPermissionInputSupported],
	);

	const handleQuestionSubmit = useCallback(
		(requestId: string, answers: Record<string, string>) => {
			if (!permissionDecisionsSupported || !updatedPermissionInputSupported) return;
			const wsSent = sendPermissionDecisionRef.current?.(requestId, "allow", undefined, answers);
			if (!wsSent) {
				api.approvePermission(requestId, { answers }).catch(() => {});
			}
			resolveAndRemovePerm(requestId);
		},
		[permissionDecisionsSupported, resolveAndRemovePerm, updatedPermissionInputSupported],
	);

	const handleQuestionReflect = useCallback(
		async (requestId: string) => {
			if (!permissionDecisionsSupported || !updatedPermissionInputSupported) return;
			try {
				await api.reflectQuestion(requestId);
				resolveAndRemovePerm(requestId);
			} catch {
				notifications.show({
					message: t("questionReflectionFailed"),
					color: "red",
					autoClose: 3000,
				});
			}
		},
		[permissionDecisionsSupported, resolveAndRemovePerm, t, updatedPermissionInputSupported],
	);

	const handleQuestionDeny = useCallback(
		(requestId: string) => {
			if (!permissionDecisionsSupported) return;
			const message = "User skipped the question";
			const wsSent = sendPermissionDecisionRef.current?.(requestId, "deny", message);
			if (!wsSent) {
				api.denyPermission(requestId, { message }).catch(() => {});
			}
			resolveAndRemovePerm(requestId);
		},
		[permissionDecisionsSupported, resolveAndRemovePerm],
	);

	// --- Stable permission callbacks ---
	const permCbRef = useRef<PermissionCallbacks | null>(null);
	permCbRef.current = {
		pendingPermission,
		pendingPermissions,
		onPermissionDecision: handlePermissionDecision,
		onQuestionSubmit: handleQuestionSubmit,
		onQuestionReflect: handleQuestionReflect,
		onQuestionDeny: handleQuestionDeny,
	};
	const stablePermCb = useMemo<PermissionCallbacks>(
		() => ({
			pendingPermission: null,
			pendingPermissions: [],
			onPermissionDecision: (...args) => permCbRef.current?.onPermissionDecision(...args),
			onQuestionSubmit: (...args) => permCbRef.current?.onQuestionSubmit(...args),
			onQuestionReflect: (...args) => permCbRef.current?.onQuestionReflect(...args),
			onQuestionDeny: (...args) => permCbRef.current?.onQuestionDeny(...args),
		}),
		[],
	);
	const renderPermCb = useMemo(
		() => ({
			...stablePermCb,
			pendingPermission,
			pendingPermissions,
		}),
		[stablePermCb, pendingPermission, pendingPermissions],
	);

	const applyQueueStatus = useCallback(
		(position?: number, queueDepth?: number, queueMessage?: string) => {
			const substatusWithQueue = withQueueSubstatus(
				statusState.substatus,
				position,
				queueDepth,
				queueMessage,
			);
			dispatchStatus({ type: "patch", payload: { substatus: substatusWithQueue } });
			qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
				old ? { ...old, substatus: substatusWithQueue } : old,
			);
		},
		[narratorId, qc, statusState.substatus],
	);

	const clearQueueMessage = useCallback(() => {
		if (!statusState.substatus.some((s) => s.startsWith("queue_message:"))) return;
		const substatusWithoutQueueMessage = withoutQueueMessageSubstatus(statusState.substatus);
		dispatchStatus({ type: "patch", payload: { substatus: substatusWithoutQueueMessage } });
		qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
			old ? { ...old, substatus: substatusWithoutQueueMessage } : old,
		);
	}, [narratorId, qc, statusState.substatus]);

	// --- WebSocket (pure control-plane: permissions, status, queue, quota, presence, notifications) ---
	const {
		connected,
		disconnected,
		sendPermissionDecision,
		sendBufferMessage,
		cancelBuffer,
		reconnect,
	} = useNarratorWS(
		narratorId,
		{
			onStreamEvent: () => {
				// Only control-plane side effects — clear queue message & retry on any delta.
				clearQueueMessage();
				clearRetryIfActive();
			},
			onMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				const blocks = Array.isArray(wsData.message?.contentJson) ? wsData.message.contentJson : [];
				const compactBlock = blocks.find(
					(b: ContentBlock) =>
						(b.type === "compact" && b.subtype !== "plan") || b.type === "segment_compact",
				);
				if (compactBlock) {
					const patch: Partial<StatusState> = {};
					if (compactBlock.status === "compacted" && wsData.message?.contextPercent != null) {
						patch.contextPercent = wsData.message.contextPercent as number;
					}
					const tu = wsData.message?.turnUsageJson as Record<string, unknown> | null | undefined;
					if (compactBlock.status === "compacted" && tu) {
						const restoredPromptTokens = promptTokensFromTurnUsage(tu);
						if (restoredPromptTokens != null) patch.promptTokens = restoredPromptTokens;
						if (tu.context_window != null) patch.contextWindow = tu.context_window as number;
						patch.isEstimated = !!tu.is_estimated;
					}
					if (Object.keys(patch).length > 0) {
						dispatchStatus({ type: "patch", payload: patch });
					}
				}
				if (wsData.message?.role === "assistant") {
					clearQueueMessage();
					clearRetryIfActive();
				}
			},
			onToolStarted: () => {
				clearRetryIfActive();
			},
			onMessagesDeleted: () => {
				dispatchStatus({ type: "patch", payload: { contextStale: true } });
			},
			onPermissionRequest: (request) => {
				upsertPendingPermission(request);
			},
			onPermissionResolved: (
				requestId,
				_toolUseId,
				_updatedInput,
				_decision,
				_feedbackText,
				subagentNarratorId,
			) => {
				removePendingPermission(requestId);
				if (subagentNarratorId) {
					qc.invalidateQueries({ queryKey: ["narrators", subagentNarratorId] });
				}
			},
			// Live gate progress feeds the render-only store both renderers read from.
			// It deliberately does NOT enter React state or either message tree: it
			// ticks several times a second and changes no layout.
			// See reflection-progress-store.ts.
			onReflectionProgress: ({ requestId, phase, thinkingChars, outputChars }) => {
				setReflectionProgress(requestId, { phase, thinkingChars, outputChars });
			},
			onDangerReflectionStarted: () => {},
			onDangerReflectionStopped: ({
				requestId,
				toolUseId,
				toolName,
				danger,
				inputJson,
				reason,
				parentToolUseId,
				subagentNarratorId,
				ownerNarratorId,
			}) => {
				const existing = pendingPermsByRequestIdRef.current.get(requestId);
				upsertPendingPermission({
					...(existing ?? {}),
					id: requestId,
					toolName,
					toolUseId,
					parentToolUseId: parentToolUseId ?? existing?.parentToolUseId,
					subagentNarratorId: subagentNarratorId ?? existing?.subagentNarratorId,
					ownerNarratorId: ownerNarratorId ?? existing?.ownerNarratorId,
					inputJson: existing?.inputJson ?? inputJson ?? {},
					decisionReason: reason ?? existing?.decisionReason,
					suggestions: [
						{ type: "danger_reflection", status: "awaiting_user", danger, requestId, reason },
					],
				});
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onDangerReflectionResolved: ({ requestId }) => {
				clearReflectionProgress(requestId);
				removePendingPermission(requestId);
			},
			onPlanReflectionStarted: () => {},
			onPlanReflectionStopped: ({
				requestId,
				toolUseId,
				toolName,
				inputJson,
				reason,
				parentToolUseId,
				subagentNarratorId,
				ownerNarratorId,
			}) => {
				const existing = pendingPermsByRequestIdRef.current.get(requestId);
				upsertPendingPermission({
					...(existing ?? {}),
					id: requestId,
					toolName,
					toolUseId,
					parentToolUseId: parentToolUseId ?? existing?.parentToolUseId,
					subagentNarratorId: subagentNarratorId ?? existing?.subagentNarratorId,
					ownerNarratorId: ownerNarratorId ?? existing?.ownerNarratorId,
					inputJson: existing?.inputJson ?? inputJson ?? {},
					decisionReason: reason ?? existing?.decisionReason,
					suggestions: [{ type: "plan_reflection", status: "awaiting_user", requestId, reason }],
				});
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onPlanReflectionResolved: ({ requestId }) => {
				clearReflectionProgress(requestId);
				removePendingPermission(requestId);
			},
			onTaskReflectionStarted: () => {},
			onTaskReflectionResolved: ({ requestId }) => {
				clearReflectionProgress(requestId);
				removePendingPermission(requestId);
			},
			onTaskReflectionStopped: ({
				requestId,
				toolUseId,
				toolName,
				inputJson,
				mutations,
				reason,
				parentToolUseId,
				subagentNarratorId,
				ownerNarratorId,
			}) => {
				const existing = pendingPermsByRequestIdRef.current.get(requestId);
				upsertPendingPermission({
					...(existing ?? {}),
					id: requestId,
					toolName,
					toolUseId,
					parentToolUseId: parentToolUseId ?? existing?.parentToolUseId,
					subagentNarratorId: subagentNarratorId ?? existing?.subagentNarratorId,
					ownerNarratorId: ownerNarratorId ?? existing?.ownerNarratorId,
					inputJson: existing?.inputJson ?? inputJson ?? {},
					decisionReason: reason ?? existing?.decisionReason,
					suggestions: [
						{ type: "task_reflection", status: "awaiting_user", requestId, reason, mutations },
					],
				});
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onQuestionReflectionStarted: ({
				requestId,
				toolUseId,
				toolName,
				inputJson,
				reason,
				parentToolUseId,
				subagentNarratorId,
				ownerNarratorId,
			}) => {
				const existing = pendingPermsByRequestIdRef.current.get(requestId);
				upsertPendingPermission({
					...(existing ?? {}),
					id: requestId,
					toolName,
					toolUseId,
					parentToolUseId: parentToolUseId ?? existing?.parentToolUseId,
					subagentNarratorId: subagentNarratorId ?? existing?.subagentNarratorId,
					ownerNarratorId: ownerNarratorId ?? existing?.ownerNarratorId,
					inputJson: existing?.inputJson ?? inputJson ?? {},
					decisionReason: reason ?? existing?.decisionReason,
					suggestions: [{ type: "question_reflection", status: "running", requestId, reason }],
				});
			},
			onQuestionReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				clearReflectionProgress(requestId);
				const existing = pendingPermsByRequestIdRef.current.get(requestId);
				if (decision === "allow") {
					removePendingPermission(requestId);
				} else if (existing) {
					upsertPendingPermission({
						...existing,
						toolUseId,
						decisionReason: reason ?? existing.decisionReason,
						suggestions: [
							{ type: "question_reflection", status: "awaiting_user", requestId, reason },
						],
					});
				}
			},
			onQuestionReflectionDisarmed: ({ requestId }) => {
				clearReflectionProgress(requestId);
				const existing = pendingPermsByRequestIdRef.current.get(requestId);
				if (existing?.reflectionDeadline !== undefined) {
					upsertPendingPermission({ ...existing, reflectionDeadline: undefined });
				}
			},
			onStatusChange: (status, turnStartedAt, eventSubstatus) => {
				clearRetryIfActive();
				const isNotWorking = status !== "working" && status !== "waiting";
				const patch: Partial<StatusState> = {};
				if (eventSubstatus !== undefined) {
					patch.substatus = eventSubstatus;
				} else if (isNotWorking) {
					patch.substatus = [];
				}
				if (patch.substatus !== undefined) {
					const hasCompact = hasActiveCompactSubstatus(patch.substatus);
					suppressMessageDerivedCompactingRef.current = !hasCompact;
					if (!hasCompact) patch.compactProgress = null;
				}
				dispatchStatus({ type: "patch", payload: patch });
				const narratorPatch: Record<string, unknown> = {
					status,
					...(turnStartedAt !== undefined && { turnStartedAt }),
				};
				if (eventSubstatus !== undefined) {
					narratorPatch.substatus = eventSubstatus;
				}
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) => {
					if (!old) return old;
					if (typeof old.id === "string" && old.id !== narratorId) return old;
					return { ...old, ...narratorPatch };
				});
				qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			},
			onSubstatusChange: (newSubstatus) => {
				const hasCompact = hasActiveCompactSubstatus(newSubstatus);
				suppressMessageDerivedCompactingRef.current = !hasCompact;
				dispatchStatus({
					type: "patch",
					payload: {
						substatus: newSubstatus,
						...(!hasCompact ? { compactProgress: null } : {}),
					},
				});
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) => {
					if (!old) return old;
					if (typeof old.id === "string" && old.id !== narratorId) return old;
					return { ...old, substatus: newSubstatus };
				});
			},
			onTitleUpdated: () => {
				qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			},
			onBufferSet: (messages) => {
				bumpBufferEpoch();
				setQueuedMessages(messages);
			},
			onBufferConsumed: (_messageId, remaining) => {
				bumpBufferEpoch();
				setQueuedMessages(remaining);
			},
			onQueuedNewNarratorCreated: (_messageId, newNarratorId) => {
				qc.invalidateQueries({ queryKey: ["narrators"] });
				qc.invalidateQueries({ queryKey: ["narrators", newNarratorId], exact: true });
				onQueuedNewNarratorCreated?.(newNarratorId);
			},
			onBufferCleared: () => {
				bumpBufferEpoch();
				setQueuedMessages([]);
			},
			onBufferPreserved: (messages) => {
				bumpBufferEpoch();
				setQueuedMessages(messages);
				notifications.show({
					title: t("narratorError"),
					message: t("bufferPreservedNotice"),
					color: "yellow",
					autoClose: 6000,
				});
			},
			onPermissionModeChanged: (permissionMode) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, permissionMode } : old,
				);
			},
			onPlanModeChanged: (planMode, traits) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, planMode, ...(traits ? { traits } : {}) } : old,
				);
			},
			onCustomTraitsChanged: (traits) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, ...(traits ? { traits } : {}) } : old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId, "custom-traits"] });
			},
			onDraftChanged: (draft) => {
				onDraftChanged?.(draft);
			},
			onRelaxedPlanChanged: (relaxedPlan) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, relaxedPlan } : old,
				);
			},
			onReflectionOverridesChanged: (overrides) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, ...overrides } : old,
				);
			},
			onContextUsage: (percentage, pTokens, ctxWindow, isEst, pruneStart, compactStart) => {
				dispatchStatus({
					type: "patch",
					payload: {
						contextPercent: percentage,
						contextStale: false,
						promptTokens: pTokens ?? null,
						contextWindow: ctxWindow ?? null,
						isEstimated: !!isEst,
						activePruneStart: pruneStart ?? null,
						activeCompactStart: compactStart ?? null,
					},
				});
			},
			onPruneBoundary: (boundaryMessageId, prunedPct) => {
				dispatchStatus({
					type: "patch",
					payload: { pruneBoundaryMessageId: boundaryMessageId, prunedPercent: prunedPct },
				});
			},
			onQuotaBalance: (balance, detailedBalance) => {
				setQuotaBalance(balance);
				setDetailedQuotaBalance(detailedBalance ?? null);
				if (customApiProviderId) {
					const updateSettingsQuota = (old: unknown) => {
						if (!old || typeof old !== "object") return old;
						const settings = old as Record<string, unknown>;
						const customApiQuotas =
							settings.customApiQuotas && typeof settings.customApiQuotas === "object"
								? (settings.customApiQuotas as Record<string, unknown>)
								: {};
						const existing =
							customApiQuotas[customApiProviderId] &&
							typeof customApiQuotas[customApiProviderId] === "object"
								? (customApiQuotas[customApiProviderId] as Record<string, unknown>)
								: {};
						return {
							...settings,
							customApiQuotas: {
								...customApiQuotas,
								[customApiProviderId]: {
									...existing,
									quotaBalance: balance,
									detailedQuotaBalance: detailedBalance ?? null,
								},
							},
						};
					};
					qc.setQueryData(["settings"], updateSettingsQuota);
					qc.setQueryData(["admin", "settings"], updateSettingsQuota);
				}
				if (nugProviderId && balance != null) {
					const numericBalance = Number(balance);
					if (Number.isFinite(numericBalance)) {
						qc.setQueryData(["nug", "quotas"], (old: unknown) => {
							const quotas = old && typeof old === "object" ? (old as Record<string, unknown>) : {};
							const existing =
								quotas[nugProviderId] && typeof quotas[nugProviderId] === "object"
									? (quotas[nugProviderId] as Record<string, unknown>)
									: {};
							return {
								...quotas,
								[nugProviderId]: {
									...existing,
									balance: numericBalance,
									totalGranted: existing.totalGranted ?? null,
									detailedQuotaBalance: detailedBalance ?? existing.detailedQuotaBalance ?? null,
								},
							};
						});
					}
				}
			},
			onPaymentRequired: (info) => {
				setPaymentRequired(info);
			},
			onModelUnavailableWaiting: (info) => {
				// The narrator is suspended waiting for a NUG model to recover. Reflect
				// the waiting status locally and surface a dismissible notice.
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, status: "waiting", substatus: ["model_unavailable"] } : old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				notifications.show({
					id: `model-unavailable-${narratorId}`,
					title: t("modelUnavailableWaitingTitle"),
					message: t("modelUnavailableWaitingDesc", { model: info.model }),
					color: "yellow",
					autoClose: false,
				});
			},
			onModelUnavailableRecovered: (info) => {
				notifications.hide(`model-unavailable-${narratorId}`);
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, status: "working", substatus: [] } : old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				notifications.show({
					title: t("modelUnavailableRecoveredTitle"),
					message: t("modelUnavailableRecoveredDesc", { model: info.model }),
					color: "green",
					autoClose: 4000,
				});
			},
			onQueueStatus: (position, queueDepth, queueMessage) => {
				applyQueueStatus(position, queueDepth, queueMessage);
			},
			onBrowserSessionCount: (count) => {
				setBrowserSessionCount(count);
				qc.invalidateQueries({ queryKey: ["browser-sessions", narratorId] });
			},
			onBrowserSessionVisualChange: (sessionId) => {
				setBrowserVisualChange((prev) => ({ sessionId, seq: (prev?.seq ?? 0) + 1 }));
			},
			onGitStatus: (data) => {
				qc.setQueryData(["chapterGitStatus", data.chapterId], {
					commitsAhead: data.commitsAhead,
					baseBranch: data.baseBranch,
					linesAdded: data.linesAdded,
					linesRemoved: data.linesRemoved,
				});
				qc.invalidateQueries({ queryKey: ["gitStatus", data.chapterId] });
			},
			onCommitSyncError: (event) => {
				qc.invalidateQueries({ queryKey: ["chapterGitStatus", event.chapterId] });
				qc.invalidateQueries({ queryKey: ["gitStatus", event.chapterId] });
				notifications.show({
					title: t("commitSyncErrorTitle"),
					message:
						event.reason ??
						event.message ??
						event.error ??
						event.code ??
						t("commitSyncErrorFallback"),
					color: "yellow",
					autoClose: 5000,
				});
			},
			onCompacting: () => {
				dispatchStatus({
					type: "patch",
					payload: {
						compactProgress: { phase: "thinking", thinkingChars: 0, outputChars: 0 },
					},
				});
			},
			onCompactProgress: ({ phase, thinkingChars, outputChars }) => {
				dispatchStatus({
					type: "patch",
					payload: { compactProgress: { phase, thinkingChars, outputChars } },
				});
			},
			onCompactDone: (
				contextPercentAfter?: number,
				isSegment?: boolean,
				_mode?: "blocking" | "background",
			) => {
				suppressMessageDerivedCompactingRef.current = true;
				const nextSubstatus = withoutCompactingSubstatus(statusState.substatus);
				dispatchStatus({
					type: "patch",
					payload: {
						substatus: nextSubstatus,
						pruneBoundaryMessageId: null,
						prunedPercent: null,
						contextStale: true,
						compactProgress: null,
					},
				});
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, substatus: withoutCompactingSubstatus(old.substatus) } : old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				if (contextPercentAfter != null) {
					notifications.show({
						title: t(isSegment ? "segmentCompactSuccess" : "compactSuccess"),
						message: t("compactSuccessDesc", { percent: Math.round(contextPercentAfter) }),
						color: "green",
						autoClose: 3000,
					});
				}
			},
			onNarratorError: (error, errorCode, diagnostics) => {
				const localizedError = localizeNarratorError(error, t, errorCode, diagnostics) ?? error;
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old
						? { ...old, status: "idle", substatus: ["error"], errorMessage: localizedError }
						: old,
				);
				notifications.show({
					title: t("narratorError"),
					message: localizedError,
					color: "red",
					autoClose: 8000,
				});
			},
			onNarratorWarning: (info) => {
				// Localize via the structured diagnostics so a retry toast explains the
				// actual cause instead of echoing the provider's raw English text.
				const localizedWarning =
					localizeNarratorError(info.message, t, undefined, info.diagnostics) ?? info.message;
				if (info.retryCount != null && info.maxRetries != null && info.delayMs != null) {
					const ri = {
						message: localizedWarning,
						retryCount: info.retryCount,
						maxRetries: info.maxRetries,
						retryAt: Date.now() + info.delayMs,
					};
					retryInfoRef.current = ri;
					setRetryInfo(ri);
				}
				notifications.show({
					title: t("narratorRetrying"),
					message: localizedWarning,
					color: "yellow",
					autoClose: 10000,
				});
			},
			onLeakedToolCall: (info) => {
				if (info.phase === "stream_captured") return;
				setLeakedToolEvent({
					phase: info.phase,
					apiRequestId: info.apiRequestId,
					toolNames: info.toolNames,
					snippet: info.snippet,
				});
			},
			onModelChanged: (model) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, model } : old,
				);
			},
			onSubagentSuspended: (subagentNarratorId: string) => {
				qc.invalidateQueries({ queryKey: ["narrators", subagentNarratorId] });
			},
			onSubagentStatusChanged: (
				subagentNarratorId: string,
				status: string,
				substatus?: string[],
			) => {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator shape
				qc.setQueryData(["narrators", subagentNarratorId], (old: any) =>
					old
						? {
								...old,
								status,
								...(substatus !== undefined ? { substatus } : {}),
								_retryInfo: undefined,
							}
						: old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", subagentNarratorId] });
			},
			onSubagentWarning: (
				subagentNarratorId: string,
				info: { message: string; retryCount?: number; maxRetries?: number; delayMs?: number },
			) => {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator shape
				qc.setQueryData(["narrators", subagentNarratorId], (old: any) =>
					old
						? {
								...old,
								_retryInfo: {
									message: info.message,
									retryCount: info.retryCount,
									maxRetries: info.maxRetries,
									retryAt: info.delayMs != null ? Date.now() + info.delayMs : undefined,
								},
							}
						: old,
				);
			},
			onSubagentConclusionUpdated: (subagentNarratorId: string) => {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator shape
				qc.setQueryData(["narrators", subagentNarratorId], (old: any) =>
					old ? { ...old, _retryInfo: undefined } : old,
				);
			},
			onBackgroundTaskStatusChanged: (taskId: string) => {
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
				// An expanded task row watches its own bounded output tail; refresh it so
				// the final output lands without waiting for the next poll tick.
				qc.invalidateQueries({ queryKey: ["background-task-tail", narratorId, taskId] });
			},
			onBackgroundTaskOutput: (taskId: string) => {
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
				qc.invalidateQueries({ queryKey: ["background-task-tail", narratorId, taskId] });
			},
			onPresenceUpdate: (v) => {
				setViewers(v);
			},
		},
		undefined, // cursor — panel does not participate in catch-up
		{
			kind: "panel",
			excludeTypes: PANEL_EXCLUDED_EVENT_TYPES,
		},
	);

	// Keep refs in sync
	sendPermissionDecisionRef.current = sendPermissionDecision;

	// --- Load pending permissions on mount/reconnect ---
	const prevConnectedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetch on mount and reconnect
	useEffect(() => {
		if (!connected && prevConnectedRef.current) {
			prevConnectedRef.current = false;
			return;
		}
		if (connected) prevConnectedRef.current = true;

		const permissionGeneration = permissionGenerationRef.current;
		const permissionLifecycle = permissionLifecycleRef.current;
		api
			.getPendingPermissions(narratorId)
			.then((perms) => {
				replacePendingPermissions(perms, permissionGeneration, permissionLifecycle);
			})
			.catch(() => {});
		reconcileBufferedMessages();
	}, [narratorId, connected, reconcileBufferedMessages]);

	// --- Fallback polling for permissions ---
	useEffect(() => {
		if (narratorStatus !== "waiting" || pendingPermissions.length > 0) return;
		let cancelled = false;
		const poll = () => {
			const permissionGeneration = permissionGenerationRef.current;
			const permissionLifecycle = permissionLifecycleRef.current;
			api
				.getPendingPermissions(narratorId)
				.then((perms) => {
					if (cancelled) return;
					replacePendingPermissions(perms, permissionGeneration, permissionLifecycle);
				})
				.catch(() => {});
		};
		poll();
		const timer = setInterval(poll, 5000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [narratorId, narratorStatus, pendingPermissions.length, replacePendingPermissions]);

	// --- Mark "done" narrator as read ---
	const hasUnreadSubstatus = substatus.includes("unread");
	useEffect(() => {
		if (!pageVisible) return;
		if (isSubagent) return;
		if (narratorStatus === "idle" && hasUnreadSubstatus && !narratorErrorMessage) {
			const nextSubstatus = withoutSubstatusTag(statusState.substatus, "unread");
			dispatchStatus({ type: "patch", payload: { substatus: nextSubstatus } });
			qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
				old
					? { ...old, status: "idle", substatus: withoutSubstatusTag(old.substatus, "unread") }
					: old,
			);
			api.markNarratorRead(narratorId).catch(() => {});
		}
	}, [
		narratorId,
		narratorStatus,
		hasUnreadSubstatus,
		narratorErrorMessage,
		isSubagent,
		pageVisible,
		qc,
		statusState.substatus,
	]);

	// --- Initialize context/prune state from initial message data ---
	const contextInitRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when narratorId changes
	useEffect(() => {
		contextInitRef.current = false;
		dispatchStatus({ type: "patch", payload: { contextStale: false } });
	}, [narratorId]);
	useEffect(() => {
		if (contextInitRef.current) return;
		if (!initialMessageStatus?.statusReady) return;
		const patch: Partial<StatusState> = {};
		if (initialMessageStatus.pruneBoundaryMessageId !== undefined) {
			patch.pruneBoundaryMessageId = initialMessageStatus.pruneBoundaryMessageId ?? null;
		}
		if (initialMessageStatus.prunedPercent !== undefined) {
			patch.prunedPercent = initialMessageStatus.prunedPercent ?? null;
		}
		if (initialMessageStatus.contextPercent != null) {
			patch.contextPercent = initialMessageStatus.contextPercent;
			const tu = initialMessageStatus.turnUsageJson as Record<string, unknown> | null | undefined;
			if (tu) {
				const restoredPromptTokens = promptTokensFromTurnUsage(tu);
				if (restoredPromptTokens != null) patch.promptTokens = restoredPromptTokens;
				if (tu.context_window != null) patch.contextWindow = tu.context_window as number;
				patch.isEstimated = !!tu.is_estimated;
			}
		}
		if (Object.keys(patch).length > 0) {
			dispatchStatus({ type: "patch", payload: patch });
		}
		contextInitRef.current = true;
	}, [initialMessageStatus]);

	return useMemo(
		() => ({
			connected,
			disconnected,
			reconnect,
			sendBufferMessage,
			cancelBuffer,
			sendPermissionDecision,
			pendingPermission,
			pendingPermissions,
			renderPermCb,
			queuedMessages,
			setQueuedMessages,
			reconcileBufferedMessages,
			substatus,
			contextPercent,
			setContextPercent,
			contextStale,
			promptTokens,
			contextWindow,
			isEstimated,
			activePruneStart,
			activeCompactStart,
			pruneBoundaryMessageId,
			prunedPercent,
			compactProgress,
			quotaBalance,
			detailedQuotaBalance,
			browserSessionCount,
			browserVisualChange,
			retryInfo,
			paymentRequired,
			setPaymentRequired,
			leakedToolEvent,
			setLeakedToolEvent,
			expandedToolUseId,
			setExpandedToolUseId,
			unreadCount,
			setUnreadCount,
			viewers,
		}),
		[
			connected,
			disconnected,
			reconnect,
			sendBufferMessage,
			cancelBuffer,
			sendPermissionDecision,
			pendingPermission,
			pendingPermissions,
			renderPermCb,
			queuedMessages,
			reconcileBufferedMessages,
			substatus,
			contextPercent,
			setContextPercent,
			contextStale,
			promptTokens,
			contextWindow,
			isEstimated,
			activePruneStart,
			activeCompactStart,
			pruneBoundaryMessageId,
			prunedPercent,
			compactProgress,
			quotaBalance,
			detailedQuotaBalance,
			browserSessionCount,
			browserVisualChange,
			retryInfo,
			paymentRequired,
			leakedToolEvent,
			expandedToolUseId,
			unreadCount,
			viewers,
		],
	);
}
