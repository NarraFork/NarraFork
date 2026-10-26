import { notifications } from "@mantine/notifications";
import { quotaProviderLabel } from "@shared/agent-protocol/quota-exhausted";
import { type ContextUsageSnapshot, parseContextUsageSnapshot } from "@shared/context-usage";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import type { ProgressSnapshot } from "@shared/progress-phase";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApplyAsyncQuestionChange } from "../../hooks/useAsyncQuestions";
import { useCurrentUser } from "../../hooks/useAuth";
import { invalidateGitStatusPushQueries } from "../../hooks/useGit";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { useNarratorPermissionsCapability } from "../../hooks/usePlatform";
import { api, type BufferMessageSummary } from "../../lib/api";
import { formatFullLocaleDateTime } from "../../lib/format";
import {
	createPanelReconcileRestartScheduler,
	type PanelConnectionState,
	type PanelReconcileRestartScheduler,
	panelConnectionRead,
	reconcilePanelStatePages,
	shouldFallbackPanelState,
} from "../../lib/narrator-panel-state";
import { statusRegistry } from "../../lib/status-registry";
import {
	contextSnapshotFields,
	contextSnapshotFromHistory,
	legacyContextSnapshot,
} from "./context-management/context-usage-state";
import { localizeNarratorError } from "./error-localization";
import { withQueueSubstatus } from "./header/narrator-status-bar";
import { isForeignSubagentRow } from "./message/nested-rows";
import type {
	ContentBlock,
	NarratorMsg,
	PendingPermission,
	PermissionCallbacks,
} from "./narrator-panel-types";
import {
	reconcilePendingPermissions,
	upsertPendingPermissionMap,
} from "./pending-permissions-reconcile";
import {
	clearAllReflectionProgress,
	clearReflectionProgress,
	setReflectionProgress,
} from "./reflection-progress-store";

/**
 * Message-layer events owned by the message-list subscription, not the panel.
 *
 * The panel never receives these: they are unconditionally excluded from its
 * `kind: "panel"` subscription, so the list is the single consumer that applies
 * them to the document.
 */
const PANEL_EXCLUDED_EVENT_TYPES = [
	"user_message",
	"message_updated",
	"reasoning_translation_patch",
	"tool_use_chunk",
	"tool_completed",
	"tool_long_running",
	"timeout_updated",
	// Message-layer only: patches the Await card's resolved child id. The panel has
	// no card to update, so delivering it here would be pure traffic.
	"await_agent_resolved",
	"send_delivery_resolved",
	// Message-layer only, same reason: it patches the blocked Agent/Await CARD's
	// takeover badge. The panel already learns the same fact from
	// `subagent_status_changed`'s substatus, which drives the status chip.
	"subagent_takeover_changed",
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

/**
 * A narrator parked on an exhausted Kimi quota window.
 *
 * Only the reset instant is needed: the label is `status_quota_exhausted` and the
 * reset time is appended to it. Null when the server knew the wall but not the
 * clock, so the label stays generic rather than inventing a time.
 */
export interface QuotaWaitInfo {
	resumeAt: number | null;
	/** Which plan the wait belongs to; absent from older servers (always Kimi). */
	quotaProvider?: "kimi" | "opencode";
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
	recordingRequestId?: string;
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

interface InitialMessageStatus {
	statusReady?: boolean;
	contextPercent?: number | null;
	turnUsageJson?: NarratorMsg["turnUsageJson"] | null;
}

/**
 * Live compact progress as kept by the panel status reducer: the shared
 * two-phase snapshot plus the retry state broadcast when a failed summary
 * attempt is being retried (`retryCount` 0 = not retrying).
 */
export interface CompactProgressState extends ProgressSnapshot {
	retryCount: number;
	retryError?: string;
	/** Provenance of the summary model's context window (`fallback` = unset). */
	contextWindowSource?: string;
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
	/** Reconnect/page-load reconciles carry draft metadata only; the composer fetches the body when newer. */
	onDraftMeta?: (meta: { hasDraft: boolean; revision: number; updatedAt: string | null }) => void;
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
	contextSnapshot: ContextUsageSnapshot | null;
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
	activeCompactStart: number | null;
	compactProgress: CompactProgressState | null;
	/**
	 * Last compact failure observed over WS, kept until the next compact starts,
	 * a compact succeeds, a new message is sent, or the panel switches narrators.
	 * Blocking failures also surface through the narrator's `error` substatus;
	 * this state exists chiefly so a BACKGROUND failure is visible somewhere
	 * besides the inline timeline marker.
	 */
	compactFailure: { error: string } | null;
	quotaBalance: string | null;
	detailedQuotaBalance: string | null;
	// Browser sessions
	browserSessionCount: number;
	browserVisualChange: { sessionId: string; seq: number } | null;
	// Retry
	retryInfo: RetryInfo | null;
	/**
	 * Set while the narrator is parked on an exhausted Kimi quota window. Outlives
	 * hours of waiting, so it is cleared when the WAIT ends (recovered frame, a
	 * non-waiting status, or a narrator switch) rather than on every stream delta,
	 * which is what `retryInfo` above does.
	 */
	quotaWaitInfo: QuotaWaitInfo | null;
	paymentRequired: PaymentRequiredInfo | null;
	setPaymentRequired: React.Dispatch<React.SetStateAction<PaymentRequiredInfo | null>>;
	leakedToolEvent: LeakedToolEvent | null;
	setLeakedToolEvent: React.Dispatch<React.SetStateAction<LeakedToolEvent | null>>;
	// Unread
	unreadCount: number;
	setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
	// Viewers
	viewers: ViewerInfo[];
}

// --- Reducer for co-updated state ---
// These fields are frequently set together in the same WS callback
// (onStatusChange, onContextUsage, onCompactDone, etc.).
// Merging them into a single useReducer avoids multiple independent re-renders
// per callback since React batches reducer dispatches into one update.

interface StatusState {
	substatus: string[];
	contextSnapshot: ContextUsageSnapshot | null;
	contextPercent: number | null;
	contextStale: boolean;
	promptTokens: number | null;
	contextWindow: number | null;
	isEstimated: boolean;
	activeCompactStart: number | null;
	compactProgress: CompactProgressState | null;
	compactFailure: { error: string } | null;
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
		onDraftMeta,
		onQueuedNewNarratorCreated,
	} = opts;
	const { t, i18n } = useTranslation("narrator");
	const qc = useQueryClient();
	const { data: currentUser } = useCurrentUser();
	const panelScope = JSON.stringify([currentUser?.id ?? null, narratorId]);
	const connectionReconcileRef = useRef<PanelConnectionState | null>(null);
	const activeReconcileRef = useRef<{
		controller: AbortController;
		promise: Promise<void>;
		generation: number;
		lifecycle: number;
		bufferEpoch: number;
	} | null>(null);
	const reconcileRestartSchedulerRef = useRef<PanelReconcileRestartScheduler | null>(null);
	const reconcilePanelStateRef = useRef<(fresh?: boolean) => Promise<void>>(async () => {});
	const requestPanelReconcileRef = useRef<() => void>(() => {});
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
		if (activeReconcileRef.current) requestPanelReconcileRef.current();
	}, []);

	// Writes pushed async-question transitions into the query cache that owns them.
	const applyAsyncQuestionChange = useApplyAsyncQuestionChange(narratorId);

	const upsertPendingPermission = useCallback(
		(permission: PendingPermission) => {
			if (resolvedPermissionIdsRef.current.has(permission.id)) return;
			bumpPermissionGeneration();
			// Even a duplicate WS event invalidates older REST snapshots.
			setPendingPermsByRequestId((prev) => upsertPendingPermissionMap(prev, permission));
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
		(
			perms: PendingPermission[],
			generation: number,
			lifecycle: number,
			complete = true,
			onDiscard?: () => void,
		) => {
			if (
				permissionGenerationRef.current !== generation ||
				permissionLifecycleRef.current !== lifecycle
			) {
				onDiscard?.();
				return false;
			}
			setPendingPermsByRequestId((prev) => {
				// React may apply a queued update after a WS event or narrator switch.
				if (
					permissionGenerationRef.current !== generation ||
					permissionLifecycleRef.current !== lifecycle
				) {
					onDiscard?.();
					return prev;
				}
				// A partial page must not erase permissions whose next page is still in flight.
				const snapshot = complete
					? perms
					: [...new Map([...prev, ...perms.map((perm) => [perm.id, perm] as const)]).values()];
				return reconcilePendingPermissions(prev, snapshot, resolvedPermissionIdsRef.current);
			});
			return true;
		},
		[],
	);

	// Reset the permission lifecycle when a Dockview panel changes narrator or account.
	// biome-ignore lint/correctness/useExhaustiveDependencies: panelScope defines the lifecycle boundary.
	useEffect(() => {
		connectionReconcileRef.current = null;
		activeReconcileRef.current?.controller.abort();
		activeReconcileRef.current = null;
		permissionLifecycleRef.current += 1;
		permissionGenerationRef.current += 1;
		bufferEpochRef.current += 1;
		resolvedPermissionIdsRef.current = new Set();
		reconcileRestartSchedulerRef.current?.dispose();
		const lifecycle = permissionLifecycleRef.current;
		const userId = currentUser?.id ?? null;
		reconcileRestartSchedulerRef.current = createPanelReconcileRestartScheduler(
			() => {
				void reconcilePanelStateRef.current(true);
			},
			() =>
				permissionLifecycleRef.current === lifecycle &&
				(qc.getQueryData<{ id?: string }>(["auth", "me"])?.id ?? null) === userId,
		);
		setPendingPermsByRequestId(new Map());
		setQueuedMessages([]);
		return () => {
			permissionLifecycleRef.current += 1;
			bufferEpochRef.current += 1;
			reconcileRestartSchedulerRef.current?.dispose();
			reconcileRestartSchedulerRef.current = null;
			activeReconcileRef.current?.controller.abort();
			activeReconcileRef.current = null;
		};
	}, [panelScope]);

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
		if (activeReconcileRef.current) requestPanelReconcileRef.current();
	}, []);
	// Fetch the authoritative queue but only apply it when no WS buffer event
	// superseded this request in the meantime.
	const reconcileBufferedMessages = useCallback(() => {
		const epochAtRequest = bufferEpochRef.current;
		const lifecycle = permissionLifecycleRef.current;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		const alive = () =>
			!controller.signal.aborted &&
			permissionLifecycleRef.current === lifecycle &&
			(qc.getQueryData<{ id?: string }>(["auth", "me"])?.id ?? null) === (currentUser?.id ?? null);
		api
			.getBufferedMessages(narratorId, controller.signal)
			.then((msgs) => {
				if (bufferEpochRef.current !== epochAtRequest || !alive()) return;
				setQueuedMessages((previous) =>
					bufferEpochRef.current === epochAtRequest && alive() ? (msgs ?? []) : previous,
				);
			})
			.catch(() => {})
			.finally(() => clearTimeout(timer));
	}, [narratorId, qc, currentUser?.id]);
	const [statusState, dispatchStatus] = useReducer(statusReducer, {
		substatus: [],
		contextSnapshot: null,
		contextPercent: null,
		contextStale: false,
		promptTokens: null,
		contextWindow: null,
		isEstimated: false,
		activeCompactStart: null,
		compactProgress: null,
		compactFailure: null,
	});
	const {
		substatus,
		contextSnapshot,
		contextPercent,
		contextStale,
		promptTokens,
		contextWindow,
		isEstimated,
		activeCompactStart,
		compactProgress,
		compactFailure,
	} = statusState;
	const contextInitRef = useRef(false);
	const contextLiveRef = useRef(false);
	const contextCompositionSignatureRef = useRef<string | null>(null);
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
		contextInitRef.current = false;
		contextLiveRef.current = false;
		contextCompositionSignatureRef.current = null;
		dispatchStatus({
			type: "patch",
			payload: {
				contextSnapshot: null,
				contextPercent: null,
				promptTokens: null,
				contextWindow: null,
				isEstimated: false,
				contextStale: false,
			},
		});
		suppressMessageDerivedCompactingRef.current = false;
		dispatchStatus({
			type: "patch",
			payload: { substatus: [], compactProgress: null, compactFailure: null },
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
					...contextSnapshotFields(
						legacyContextSnapshot(
							typeof v === "function" ? v(statusState.contextPercent) : v,
							null,
							statusState.contextWindow,
							true,
						),
					),
					contextStale: true,
				},
			});
		},
		[statusState.contextPercent, statusState.contextWindow],
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
	const [quotaWaitInfo, setQuotaWaitInfo] = useState<QuotaWaitInfo | null>(null);
	const [paymentRequired, setPaymentRequired] = useState<PaymentRequiredInfo | null>(null);
	const [leakedToolEvent, setLeakedToolEvent] = useState<LeakedToolEvent | null>(null);
	const retryInfoRef = useRef<RetryInfo | null>(null);
	const clearRetryIfActive = useCallback(() => {
		if (retryInfoRef.current) {
			retryInfoRef.current = null;
			setRetryInfo(null);
		}
	}, []);
	const quotaWaitInfoRef = useRef<QuotaWaitInfo | null>(null);
	const clearQuotaWaitIfActive = useCallback(() => {
		if (quotaWaitInfoRef.current) {
			quotaWaitInfoRef.current = null;
			setQuotaWaitInfo(null);
		}
	}, []);
	/** Set both the state and its ref: the clearing paths read the ref to stay cheap. */
	const applyQuotaWaitInfo = useCallback((info: QuotaWaitInfo | null) => {
		quotaWaitInfoRef.current = info;
		setQuotaWaitInfo(info);
	}, []);
	// A panel switch must not inherit the previous narrator's wait.
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId is the reset trigger.
	useEffect(() => {
		applyQuotaWaitInfo(null);
	}, [narratorId, applyQuotaWaitInfo]);
	const [unreadCount, setUnreadCount] = useState(0);

	// --- Viewers ---
	const [viewers, setViewers] = useState<ViewerInfo[]>([]);

	// --- Initialize context state from initial message data ---
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

	/**
	 * Settle a decision that had to go over HTTP because the WebSocket was down.
	 *
	 * The card may only be removed once the request actually landed. Removing it
	 * optimistically looks harmless — the narrator is the one waiting, not the UI —
	 * but resolveAndRemovePerm also records the id as resolved, and that record is
	 * what the 5s "waiting with no pending permission" poll consults before
	 * restoring a card. So a dropped decision took out the recovery path with it:
	 * the card vanished, the narrator stayed suspended, and nothing short of a
	 * reload brought the prompt back.
	 */
	const settleViaHttp = useCallback(
		(requestId: string, request: Promise<unknown>) => {
			request
				.then(() => {
					resolveAndRemovePerm(requestId);
				})
				.catch(() => {
					notifications.show({
						message: t("permissionDecisionFailed"),
						color: "red",
						autoClose: 4000,
					});
				});
		},
		[resolveAndRemovePerm, t],
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
				settleViaHttp(
					requestId,
					decision === "allow"
						? api.approvePermission(requestId, payload)
						: api.denyPermission(requestId, payload),
				);
				return;
			}
			resolveAndRemovePerm(requestId);
		},
		[
			permissionDecisionsSupported,
			resolveAndRemovePerm,
			settleViaHttp,
			updatedPermissionInputSupported,
		],
	);

	const handleQuestionSubmit = useCallback(
		(requestId: string, answers: Record<string, string>) => {
			if (!permissionDecisionsSupported || !updatedPermissionInputSupported) return;
			const wsSent = sendPermissionDecisionRef.current?.(requestId, "allow", undefined, answers);
			if (!wsSent) {
				settleViaHttp(requestId, api.approvePermission(requestId, { answers }));
				return;
			}
			resolveAndRemovePerm(requestId);
		},
		[
			permissionDecisionsSupported,
			resolveAndRemovePerm,
			settleViaHttp,
			updatedPermissionInputSupported,
		],
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
				settleViaHttp(requestId, api.denyPermission(requestId, { message }));
				return;
			}
			resolveAndRemovePerm(requestId);
		},
		[permissionDecisionsSupported, resolveAndRemovePerm, settleViaHttp],
	);

	/**
	 * "Answer later": release the loop and move the question to the async inbox.
	 *
	 * HTTP-only, unlike submit/deny. Those have a WS path because they are the hot,
	 * latency-sensitive actions; deferring is a rare deliberate choice, and the WS
	 * `permission_decision` frame carries no field for it — adding one would mean a new
	 * protocol member for an action that is fine at HTTP latency.
	 *
	 * The pending row is removed locally on success; the inbox picks the question up from
	 * its own `async_question_changed` event.
	 */
	const handleQuestionDefer = useCallback(
		async (requestId: string) => {
			if (!permissionDecisionsSupported) return;
			try {
				await api.deferPermissionQuestion(requestId);
				resolveAndRemovePerm(requestId);
			} catch {
				notifications.show({
					message: t("deferQuestionFailed"),
					color: "red",
					autoClose: 3000,
				});
			}
		},
		[permissionDecisionsSupported, resolveAndRemovePerm, t],
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
		onQuestionDefer: handleQuestionDefer,
	};
	const stablePermCb = useMemo<PermissionCallbacks>(
		() => ({
			pendingPermission: null,
			pendingPermissions: [],
			onPermissionDecision: (...args) => permCbRef.current?.onPermissionDecision(...args),
			onQuestionSubmit: (...args) => permCbRef.current?.onQuestionSubmit(...args),
			onQuestionReflect: (...args) => permCbRef.current?.onQuestionReflect(...args),
			onQuestionDeny: (...args) => permCbRef.current?.onQuestionDeny(...args),
			onQuestionDefer: (...args) => permCbRef.current?.onQuestionDefer?.(...args),
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
				// A subagent's row is dual-broadcast to this page too, tagged with
				// `parentToolUseId` (see `isForeignSubagentRow`). Nothing derived from it may
				// touch THIS conversation's state — most visibly it used to look like an
				// assistant answer, so a subagent finishing its turn cleared this panel's
				// queued-message and retry chips while the parent was still running.
				if (isForeignSubagentRow(wsData.message, !!isSubagent)) return;
				const blocks = messageBody(wsData.message);
				const compactBlock = blocks.find(
					(b: ContentBlock) =>
						(b.type === "compact" && b.subtype !== "plan") || b.type === "segment_compact",
				);
				if (compactBlock) {
					const patch: Partial<StatusState> = {};
					const tu = wsData.message?.turnUsageJson as Record<string, unknown> | null | undefined;
					if (compactBlock.status === "compacted" && !contextLiveRef.current) {
						Object.assign(
							patch,
							contextSnapshotFields(contextSnapshotFromHistory(wsData.message?.contextPercent, tu)),
						);
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
			// Asynchronous questions live in the query cache rather than this hook's
			// pending-permission map: nothing here is suspended waiting for them, and every
			// consumer of `pendingPermissions` treats an entry as "the session is blocked".
			onAsyncQuestionChanged: ({ change, question }) => {
				applyAsyncQuestionChange(change, question);
			},
			onStatusChange: (status, turnStartedAt, eventSubstatus) => {
				clearRetryIfActive();
				// A self-recovering wait is only meaningful while the narrator is still
				// parked on it. Leaving `waiting` is the single signal that it ended —
				// whether it recovered, was interrupted, or was reported as a wall — and
				// unlike `retryInfo` it outlives hours, so it must not survive the wait
				// that produced it. The persistent notice goes with it: leaving it up
				// would keep describing a wait that is over.
				if (status !== "waiting") {
					clearQuotaWaitIfActive();
					notifications.hide(`model-unavailable-${narratorId}`);
				}
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
				// A fresh turn supersedes the previous turn's compact failure display.
				if (status === "working") patch.compactFailure = null;
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
			onContextUsage: (percentage, pTokens, ctxWindow, isEst, compactStart, snapshot) => {
				contextLiveRef.current = true;
				contextInitRef.current = true;
				const resolved =
					parseContextUsageSnapshot(snapshot) ??
					legacyContextSnapshot(percentage, pTokens, ctxWindow, isEst);
				const signature = JSON.stringify([
					resolved.requestId,
					resolved.composition?.generation,
					resolved.occupiedTokens,
					resolved.percentage,
					resolved.contextWindow,
					resolved.source,
				]);
				if (signature !== contextCompositionSignatureRef.current) {
					contextCompositionSignatureRef.current = signature;
					void qc.invalidateQueries({ queryKey: ["contextComposition", narratorId], exact: true });
				}
				dispatchStatus({
					type: "patch",
					payload: {
						...contextSnapshotFields(resolved),
						contextStale: false,
						activeCompactStart: compactStart ?? null,
					},
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
				// The narrator is parked on a self-recovering block: a NUG credential
				// pool coming back, or a Kimi / OpenCode Go quota window resetting. Reflect the
				// waiting status locally and surface a dismissible notice that says
				// which of the two it is.
				const isQuota = info.waitKind === "quota";
				const substatus = isQuota ? "quota_exhausted" : "model_unavailable";
				applyQuotaWaitInfo(
					isQuota ? { resumeAt: info.resumeAt ?? null, quotaProvider: info.quotaProvider } : null,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				notifications.show({
					id: `model-unavailable-${narratorId}`,
					title: t(isQuota ? "quotaExhaustedWaitingTitle" : "modelUnavailableWaitingTitle", {
						provider: quotaProviderLabel(info.quotaProvider),
					}),
					message: isQuota
						? t("quotaExhaustedWaitingDesc", {
								model: info.model,
								provider: quotaProviderLabel(info.quotaProvider),
								resetAt: info.resumeAt
									? formatFullLocaleDateTime(new Date(info.resumeAt), i18n.language)
									: t("quotaExhaustedResetUnknown"),
							})
						: t("modelUnavailableWaitingDesc", { model: info.model }),
					// Blue-toned neutral, not yellow: nothing here is actionable.
					color: statusRegistry.accentColor(statusRegistry.narratorSubstatus(substatus)),
					autoClose: false,
				});
			},
			onModelUnavailableRecovered: (info) => {
				const isQuota = info.waitKind === "quota";
				notifications.hide(`model-unavailable-${narratorId}`);
				clearQuotaWaitIfActive();
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, status: "working", substatus: [] } : old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				notifications.show({
					title: t(isQuota ? "quotaExhaustedRecoveredTitle" : "modelUnavailableRecoveredTitle"),
					message: t(isQuota ? "quotaExhaustedRecoveredDesc" : "modelUnavailableRecoveredDesc", {
						model: info.model,
					}),
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
			onGitStatus: () => {
				// The workspace bar reads workspace-keyed gitStatus queries; open Git panels
				// additionally have their own workspace subscription. Double invalidation is
				// idempotent.
				invalidateGitStatusPushQueries(qc, narratorId);
			},
			onCompacting: () => {
				dispatchStatus({
					type: "patch",
					payload: {
						compactProgress: {
							phase: "thinking",
							thinkingChars: 0,
							outputChars: 0,
							retryCount: 0,
						},
						// A new compact run supersedes any earlier failure display.
						compactFailure: null,
					},
				});
			},
			onCompactProgress: ({
				phase,
				thinkingChars,
				outputChars,
				retryCount,
				retryError,
				contextWindowSource,
			}) => {
				dispatchStatus({
					type: "patch",
					payload: {
						compactProgress: {
							phase,
							thinkingChars,
							outputChars,
							retryCount,
							...(retryError ? { retryError } : {}),
							...(contextWindowSource ? { contextWindowSource } : {}),
						},
					},
				});
			},
			onCompactFailed: (error) => {
				dispatchStatus({
					type: "patch",
					payload: { compactFailure: { error: error ?? "" } },
				});
				notifications.show({
					title: t("compactFailed"),
					message: error || t("compactFailedDesc"),
					color: "red",
					autoClose: 6000,
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
						contextStale: true,
						compactProgress: null,
						// A successful compact clears any earlier failure; a FAILED compact
						// arrives here with no percent and must leave the just-set
						// compactFailure (from onCompactFailed) untouched.
						...(contextPercentAfter != null ? { compactFailure: null } : {}),
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
					recordingRequestId: info.recordingRequestId,
					toolNames: info.toolNames,
					snippet: info.snippet,
				});
			},
			onModelChanged: (model) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, model } : old,
				);
			},
			onModelInheritanceChanged: (modelInheritance) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, modelInheritance } : old,
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
			// The task LIST is not invalidated here: it is patched in place from
			// `background_task_list_delta` (see useBackgroundTaskList). Invalidating on
			// these frames would refetch the whole first page for every status change
			// and every 2 s output tick — the traffic paging was introduced to remove.
			onBackgroundTaskStatusChanged: (taskId: string) => {
				// An expanded task row watches its own bounded output tail; refresh it so
				// the final output lands promptly.
				qc.invalidateQueries({ queryKey: ["background-task-tail", narratorId, taskId] });
			},
			onBackgroundTaskOutput: (taskId: string) => {
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

	// Ref-mirrored so the reconcile callback keeps its identity (its promise dedup
	// depends on it) while always calling the latest handler.
	const onDraftMetaRef = useRef(onDraftMeta);
	onDraftMetaRef.current = onDraftMeta;

	// --- Initial REST is shared with the composer; every WS connection edge closes its event gap. ---
	const reconcilePanelState = useCallback(
		(fresh = false) => {
			if (!fresh && activeReconcileRef.current) return activeReconcileRef.current.promise;
			reconcileRestartSchedulerRef.current?.cancel();
			if (fresh) activeReconcileRef.current?.controller.abort();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15_000);
			const generation = permissionGenerationRef.current;
			const lifecycle = permissionLifecycleRef.current;
			const bufferEpoch = bufferEpochRef.current;
			const alive = () =>
				!controller.signal.aborted &&
				permissionLifecycleRef.current === lifecycle &&
				(qc.getQueryData<{ id?: string }>(["auth", "me"])?.id ?? null) ===
					(currentUser?.id ?? null);
			const onDiscard = () => {
				if (alive()) requestPanelReconcileRef.current();
			};
			const applyBuffer = (messages: BufferMessageSummary[], complete = true) => {
				if (!alive() || bufferEpochRef.current !== bufferEpoch) {
					onDiscard();
					return;
				}
				setQueuedMessages((previous) => {
					if (!alive() || bufferEpochRef.current !== bufferEpoch) {
						onDiscard();
						return previous;
					}
					return complete
						? messages
						: [
								...new Map(
									[...previous, ...messages].map((message) => [message.id, message]),
								).values(),
							];
				});
			};
			const promise = reconcilePanelStatePages(
				(options) => api.getNarratorPanelState(narratorId, options),
				(snapshot) => {
					if (!alive()) return;
					replacePendingPermissions(
						snapshot.permissions,
						generation,
						lifecycle,
						!snapshot.hasMore.permissions,
						onDiscard,
					);
					applyBuffer(snapshot.buffer, !snapshot.hasMore.buffer);
					// Draft metadata rides every page; the composer no-ops it unless it
					// proves a live draft_changed was missed while disconnected.
					onDraftMetaRef.current?.(snapshot.draft);
				},
				{ signal: controller.signal, fresh },
			)
				.catch(async (error) => {
					if (!alive() || !shouldFallbackPanelState(error)) return;
					// Independent fallbacks: a draft/network failure must never hide safety permissions.
					await Promise.allSettled([
						api.getPendingPermissions(narratorId, controller.signal).then((permissions) => {
							if (alive())
								replacePendingPermissions(permissions, generation, lifecycle, true, onDiscard);
						}),
						api
							.getBufferedMessages(narratorId, controller.signal)
							.then((messages) => applyBuffer(messages ?? [])),
					]);
				})
				.finally(() => {
					clearTimeout(timer);
					if (activeReconcileRef.current?.controller === controller)
						activeReconcileRef.current = null;
				});
			activeReconcileRef.current = { controller, promise, generation, lifecycle, bufferEpoch };
			return promise;
		},
		[narratorId, replacePendingPermissions, qc, currentUser?.id],
	);
	reconcilePanelStateRef.current = reconcilePanelState;
	requestPanelReconcileRef.current = () => {
		const active = activeReconcileRef.current;
		// A newer read already covers an older queued React updater's rejection.
		if (
			active &&
			active.generation === permissionGenerationRef.current &&
			active.lifecycle === permissionLifecycleRef.current &&
			active.bufferEpoch === bufferEpochRef.current
		)
			return;
		reconcileRestartSchedulerRef.current?.schedule();
	};

	useEffect(() => {
		const transition = panelConnectionRead(connectionReconcileRef.current, panelScope, connected);
		connectionReconcileRef.current = transition.state;
		if (!transition.read) return;
		if (transition.read === "fresh") {
			bumpPermissionGeneration();
			bumpBufferEpoch();
		}
		void reconcilePanelState(transition.read === "fresh");
	}, [panelScope, connected, reconcilePanelState, bumpPermissionGeneration, bumpBufferEpoch]);

	// --- Fallback polling for permissions ---
	useEffect(() => {
		if (narratorStatus !== "waiting" || pendingPermissions.length > 0) return;
		const poll = () => {
			void reconcilePanelState();
		};
		poll();
		const timer = setInterval(poll, 5000);
		return () => clearInterval(timer);
	}, [narratorStatus, pendingPermissions.length, reconcilePanelState]);

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

	// --- Initialize context state from initial message data ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: narrator reset must rehydrate even when the initial object is unchanged
	useEffect(() => {
		if (contextInitRef.current) return;
		if (!initialMessageStatus?.statusReady) return;
		const patch = contextSnapshotFields(
			contextSnapshotFromHistory(
				initialMessageStatus.contextPercent,
				initialMessageStatus.turnUsageJson as Record<string, unknown> | null | undefined,
			),
		);
		if (Object.keys(patch).length > 0) {
			dispatchStatus({ type: "patch", payload: patch });
		}
		contextInitRef.current = true;
	}, [initialMessageStatus, narratorId]);

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
			contextSnapshot,
			contextPercent,
			setContextPercent,
			contextStale,
			promptTokens,
			contextWindow,
			isEstimated,
			activeCompactStart,
			compactProgress,
			compactFailure,
			quotaBalance,
			detailedQuotaBalance,
			browserSessionCount,
			browserVisualChange,
			retryInfo,
			quotaWaitInfo,
			paymentRequired,
			setPaymentRequired,
			leakedToolEvent,
			setLeakedToolEvent,
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
			contextSnapshot,
			contextPercent,
			setContextPercent,
			contextStale,
			promptTokens,
			contextWindow,
			isEstimated,
			activeCompactStart,
			compactProgress,
			compactFailure,
			quotaBalance,
			detailedQuotaBalance,
			browserSessionCount,
			browserVisualChange,
			retryInfo,
			quotaWaitInfo,
			paymentRequired,
			leakedToolEvent,
			unreadCount,
			viewers,
		],
	);
}
