import type { DragEndEvent } from "@dnd-kit/core";
import { notifications } from "@mantine/notifications";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BufferMessageSummary } from "../../../lib/api";
import { api } from "../../../lib/api";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";

import type { QueueMode } from "../composer/SendOptionsSplitButton";
import { moveQueuedTurn, queuedMessageMode } from "./queue-message-mode";

export interface UrgentDispatch {
	message: BufferMessageSummary;
	status: "sending" | "failed" | "sent";
	error?: string;
}

export interface QueuedEditPayload {
	keepImageIds: string[];
	keepTextFiles: { index: number; filename: string }[];
	newImages: File[];
	newTextFiles: File[];
}

export interface UseQueuedMessageActionsOptions {
	narratorId: string;
	queuedMessages: BufferMessageSummary[];
	setQueuedMessages: React.Dispatch<React.SetStateAction<BufferMessageSummary[]>>;
	reconcileBufferedMessages: () => void;
	cancelBuffer: (narratorId: string) => void;
	composerRef: React.RefObject<NarratorComposerHandle | null>;
	/** Stable ref to the panel's send handler (used by the queue click). */
	handleSendRef: React.RefObject<() => void | Promise<void>>;
	/** Stable ref to the send-with-mode handler (used by the long-press hold). */
	handleSendWithModeRef: React.RefObject<
		(mode: "turn" | "tool" | "interrupt") => void | Promise<void>
	>;
	/** Stable ref to the current ctrl+enter queue mode (fired on hold completion). */
	ctrlEnterQueueModeRef: React.RefObject<"turn" | "tool" | "interrupt">;
	/**
	 * Optional bridge back to the panel: the vlist row handlers resolve
	 * queued-message actions through these refs, but they are declared before
	 * this hook's callbacks exist, so the hook fills them every render.
	 */
	queuedEditRef?: React.RefObject<(id: string) => void>;
	queuedCancelRef?: React.RefObject<(id: string) => void>;
	queuedRetryRef?: React.RefObject<(id: string) => void>;
	t: (key: string) => string;
}

/**
 * All queue-buffer interactions extracted from NarratorPanel: the press-and-hold
 * "priority queue" gesture (with its progress bar + suppression refs), plus the
 * cancel/remove/retry/reorder/edit handlers and the editing/expanded UI state.
 *
 * Ownership split: this hook owns the hold refs, `queueHoldProgress`,
 * `editingQueuedId` and `queueExpanded`. The buffered-message list itself
 * (`queuedMessages`/`setQueuedMessages`/reconcile/cancel) lives in the panel's WS
 * layer and is injected, as are the stable send refs it fires on gestures.
 */
export function useQueuedMessageActions(options: UseQueuedMessageActionsOptions) {
	const {
		narratorId,
		queuedMessages,
		setQueuedMessages,
		reconcileBufferedMessages,
		cancelBuffer,
		handleSendRef,
		handleSendWithModeRef,
		ctrlEnterQueueModeRef,
		queuedEditRef,
		queuedCancelRef,
		queuedRetryRef,
		t,
	} = options;

	const scopeRef = useRef({
		narratorId,
		dispatches: new Map<string, UrgentDispatch>(),
	});
	if (scopeRef.current.narratorId !== narratorId) {
		scopeRef.current = { narratorId, dispatches: new Map() };
	}
	const [, refreshDispatches] = useState(0);
	const dispatches = scopeRef.current.dispatches;
	const rawIds = new Set(queuedMessages.map((message) => message.id));
	const visibleQueuedMessages = queuedMessages.filter((message) => {
		const status = dispatches.get(message.id)?.status;
		return status !== "sending" && status !== "sent" && status !== "failed";
	});
	useEffect(() => {
		const scope = scopeRef.current;
		if (scope.narratorId !== narratorId) return;
		const terminalIds = new Set(
			[...scope.dispatches].filter(([, dispatch]) => dispatch.status === "sent").map(([id]) => id),
		);
		if (queuedMessages.some((message) => terminalIds.has(message.id))) {
			setQueuedMessages((previous) => previous.filter((message) => !terminalIds.has(message.id)));
		}
	}, [narratorId, queuedMessages, setQueuedMessages]);
	// Missing raw rows may only be claimed, not materialized: a failed claim can
	// return to queued/failed. Only an explicit delivery receipt is terminal.
	const urgentDispatches = [...dispatches.values()]
		.filter(
			(dispatch) =>
				dispatch.status === "sending" ||
				(dispatch.status === "failed" && rawIds.has(dispatch.message.id)),
		)
		.map((dispatch) =>
			dispatch.status === "failed"
				? {
						...dispatch,
						message:
							queuedMessages.find((message) => message.id === dispatch.message.id) ??
							dispatch.message,
					}
				: dispatch,
		);

	const [queueHoldProgress, setQueueHoldProgress] = useState(0);
	const queueHoldTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const queueHoldFiredRef = useRef(false);
	const queueClickSuppressedRef = useRef(false);

	const clearQueueHoldTimer = useCallback(() => {
		if (queueHoldTimerRef.current) {
			clearInterval(queueHoldTimerRef.current);
			queueHoldTimerRef.current = null;
		}
		setQueueHoldProgress(0);
	}, []);
	const startQueueHold = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			clearQueueHoldTimer();
			queueHoldFiredRef.current = false;
			queueClickSuppressedRef.current = false;
			const start = Date.now();
			const duration = 600;
			queueHoldTimerRef.current = setInterval(() => {
				const elapsed = Date.now() - start;
				const pct = Math.min(elapsed / duration, 1);
				setQueueHoldProgress(pct);
				if (pct >= 1 && !queueHoldFiredRef.current) {
					queueHoldFiredRef.current = true;
					queueClickSuppressedRef.current = true;
					if (queueHoldTimerRef.current != null) {
						clearInterval(queueHoldTimerRef.current);
						queueHoldTimerRef.current = null;
					}
					void handleSendWithModeRef.current(ctrlEnterQueueModeRef.current);
				}
			}, 16);
		},
		[clearQueueHoldTimer, handleSendWithModeRef, ctrlEnterQueueModeRef],
	);
	const cancelQueueHold = useCallback(() => {
		if (queueHoldFiredRef.current) queueClickSuppressedRef.current = true;
		clearQueueHoldTimer();
		queueHoldFiredRef.current = false;
	}, [clearQueueHoldTimer]);
	const handleQueuePointerUp = useCallback(() => {
		if (queueHoldFiredRef.current) queueClickSuppressedRef.current = true;
		clearQueueHoldTimer();
		queueHoldFiredRef.current = false;
	}, [clearQueueHoldTimer]);
	const handleQueueClick = useCallback(() => {
		if (queueClickSuppressedRef.current) {
			queueClickSuppressedRef.current = false;
			return;
		}
		void handleSendRef.current();
	}, [handleSendRef]);
	useEffect(() => cancelQueueHold, [cancelQueueHold]);

	const handleCancelAllQueued = useCallback(() => {
		const ordinary = queuedMessages.filter(
			(m) => queuedMessageMode(m) !== "interrupt" && !scopeRef.current.dispatches.has(m.id),
		);
		if (ordinary.length === queuedMessages.length) {
			if (ordinary.length > 0) cancelBuffer(narratorId);
			setQueuedMessages([]);
		} else {
			const ids = new Set(ordinary.map((m) => m.id));
			setQueuedMessages((prev) => prev.filter((m) => !ids.has(m.id)));
			for (const id of ids) {
				void api.removeBufferedMessage(narratorId, id).catch(() => reconcileBufferedMessages());
			}
		}
	}, [queuedMessages, cancelBuffer, narratorId, setQueuedMessages, reconcileBufferedMessages]);

	const handleRemoveQueued = useCallback(
		(messageId: string) => {
			const status = scopeRef.current.dispatches.get(messageId)?.status;
			if (status === "sending" || status === "sent") return;
			setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
			api.removeBufferedMessage(narratorId, messageId).catch((error) => {
				reconcileBufferedMessages();
				notifications.show({
					color: "red",
					title: t("queuedRemoveFailed"),
					message: error instanceof Error ? error.message : String(error),
				});
			});
		},
		[setQueuedMessages, narratorId, reconcileBufferedMessages, t],
	);

	const handleRetryQueued = useCallback(
		async (messageId: string) => {
			const result = await api.retryBufferedMessage(narratorId, messageId);
			// Refresh authoritative state; do not resurrect a row already consumed over WS.
			reconcileBufferedMessages();
			return result;
		},
		[narratorId, reconcileBufferedMessages],
	);

	const reorderQueued = useCallback(
		(id: string, targetId: string) => {
			const dispatches = scopeRef.current.dispatches;
			const reorderInput = queuedMessages.map((message) =>
				dispatches.has(message.id) ? { ...message, queueMode: "interrupt" as const } : message,
			);
			const newOrder = moveQueuedTurn(reorderInput, id, targetId);
			if (newOrder === reorderInput) return;
			setQueuedMessages((previous) => {
				const current = new Map(previous.map((message) => [message.id, message]));
				const orderedIds = new Set(newOrder.map((message) => message.id));
				// Never resurrect a row consumed between the action and React's state update.
				return [
					...newOrder.flatMap((message) => {
						const live = current.get(message.id);
						return live ? [live] : [];
					}),
					...previous.filter((message) => !orderedIds.has(message.id)),
				];
			});
			api
				.reorderBufferedMessages(
					narratorId,
					newOrder
						.filter(
							(message) => queuedMessageMode(message) === "turn" && !dispatches.has(message.id),
						)
						.map((message) => message.id),
				)
				.catch((error) => {
					reconcileBufferedMessages();
					notifications.show({
						color: "red",
						title: t("queuedReorderFailed"),
						message: error instanceof Error ? error.message : String(error),
					});
				});
		},
		[queuedMessages, narratorId, setQueuedMessages, reconcileBufferedMessages, t],
	);
	const handleDragEndQueued = useCallback(
		({ active, over }: DragEndEvent) => {
			if (over) reorderQueued(String(active.id), String(over.id));
		},
		[reorderQueued],
	);
	const handleMoveQueued = useCallback(
		(id: string, direction: -1 | 1) => {
			const ordinary = queuedMessages.filter(
				(m) => queuedMessageMode(m) === "turn" && !scopeRef.current.dispatches.has(m.id),
			);
			const index = ordinary.findIndex((m) => m.id === id);
			const target = index >= 0 ? ordinary[index + direction] : undefined;
			if (target) reorderQueued(id, target.id);
		},
		[queuedMessages, reorderQueued],
	);
	const handleChangeMode = useCallback(
		async (id: string, mode: QueueMode) => {
			const scope = scopeRef.current;
			const previous = scope.dispatches.get(id);
			if (previous?.status === "sending" || previous?.status === "sent") return false;
			const message = queuedMessages.find((m) => m.id === id) ?? previous?.message;
			if (!message) return false;
			if (mode === "interrupt") {
				if (!scope.dispatches.has(id) && scope.dispatches.size >= 64) {
					const evict = [...scope.dispatches].find(([, value]) => value.status !== "sending");
					if (!evict) return false;
					scope.dispatches.delete(evict[0]);
				}
				scope.dispatches.set(id, { message, status: "sending" });
				refreshDispatches((n) => n + 1);
			}
			try {
				// Failed admission must be explicitly restored before requesting interruption.
				if (mode === "interrupt" && message.state === "failed") {
					await api.retryBufferedMessage(narratorId, id);
					if (scopeRef.current !== scope) return false;
				}
				const response = await api.setBufferedMessageMode(narratorId, id, mode);
				if (scopeRef.current !== scope) return false;
				if (mode === "interrupt") {
					if (response.delivered !== true) throw new Error(t("queuedUrgentUnconfirmed"));
					scope.dispatches.set(id, { message, status: "sent" });
					setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
					refreshDispatches((n) => n + 1);
				}
				reconcileBufferedMessages();
				return true;
			} catch (error) {
				if (scopeRef.current !== scope) return false;
				const detail = error instanceof Error ? error.message : String(error);
				if (mode === "interrupt") {
					scope.dispatches.set(id, {
						...scope.dispatches.get(id),
						message,
						status: "failed",
						error: detail,
					});
					refreshDispatches((n) => n + 1);
				}
				notifications.show({ color: "red", title: t("queuedModeFailed"), message: detail });
				reconcileBufferedMessages();
				return false;
			}
		},
		[narratorId, queuedMessages, setQueuedMessages, reconcileBufferedMessages, t],
	);

	const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
	const [queueExpanded, setQueueExpanded] = useState(true);

	// biome-ignore lint/correctness/useExhaustiveDependencies: narrator changes invalidate the previous editor scope.
	useEffect(() => setEditingQueuedId(null), [narratorId]);
	const handleStartEditQueued = useCallback(
		(msg: { id: string }) => {
			if (
				scopeRef.current.dispatches.has(msg.id) ||
				queuedMessages.some((m) => m.id === msg.id && queuedMessageMode(m) === "interrupt")
			)
				return;
			setEditingQueuedId(msg.id);
		},
		[queuedMessages],
	);

	const handleCancelEditQueued = useCallback(() => {
		setEditingQueuedId(null);
	}, []);

	/**
	 * Persist an edited queued message.
	 *
	 * Only the text is updated optimistically. Attachments are not: the client
	 * cannot invent the imageId of an upload the server has not accepted yet, and
	 * a wrong guess would render a broken thumbnail. The authoritative
	 * `buffer_set` broadcast that follows a successful edit carries the real set.
	 *
	 * Returns false on failure so the row keeps the draft open with the user's
	 * selected files intact.
	 */
	const handleSaveEditQueued = useCallback(
		async (
			msg: BufferMessageSummary,
			text: string,
			payload: QueuedEditPayload,
		): Promise<boolean> => {
			setQueuedMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, text } : m)));
			try {
				await api.updateBufferedMessage(narratorId, msg.id, text, payload);
				reconcileBufferedMessages();
				return true;
			} catch (err) {
				reconcileBufferedMessages();
				notifications.show({
					color: "red",
					title: t("editQueuedFailed"),
					message: err instanceof Error ? err.message : String(err),
				});
				return false;
			}
		},
		[setQueuedMessages, narratorId, reconcileBufferedMessages, t],
	);

	// Fill the panel's bridge refs with the live handlers (render-time
	// assignment mirrors the pattern the panel uses for its own send refs).
	if (queuedEditRef) queuedEditRef.current = (id) => handleStartEditQueued({ id });
	if (queuedCancelRef) queuedCancelRef.current = handleRemoveQueued;
	if (queuedRetryRef)
		queuedRetryRef.current = (id) => {
			void handleRetryQueued(id);
		};

	return {
		visibleQueuedMessages,
		urgentDispatches,
		queueHoldProgress,
		startQueueHold,
		cancelQueueHold,
		handleQueuePointerUp,
		handleQueueClick,
		handleCancelAllQueued,
		handleRemoveQueued,
		handleRetryQueued,
		handleDragEndQueued,
		handleMoveQueued,
		handleChangeMode,
		editingQueuedId,
		queueExpanded,
		setQueueExpanded,
		handleStartEditQueued,
		handleCancelEditQueued,
		handleSaveEditQueued,
	};
}
