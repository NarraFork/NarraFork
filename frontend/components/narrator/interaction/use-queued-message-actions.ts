import type { DragEndEvent } from "@dnd-kit/core";
import { notifications } from "@mantine/notifications";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BufferMessageSummary } from "../../../lib/api";
import { api } from "../../../lib/api";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";

import type { QueueMode } from "../composer/SendOptionsSplitButton";
import { moveQueuedTurn, queuedMessageMode } from "./queue-message-mode";

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
		if (queuedMessages.length > 0) {
			cancelBuffer(narratorId);
			setQueuedMessages([]);
		}
	}, [queuedMessages, cancelBuffer, narratorId, setQueuedMessages]);

	const handleRemoveQueued = useCallback(
		(messageId: string) => {
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
			const newOrder = moveQueuedTurn(queuedMessages, id, targetId);
			if (newOrder === queuedMessages) return;
			setQueuedMessages(newOrder);
			api
				.reorderBufferedMessages(
					narratorId,
					newOrder.map((m) => m.id),
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
			const ordinary = queuedMessages.filter((m) => queuedMessageMode(m) === "turn");
			const index = ordinary.findIndex((m) => m.id === id);
			const target = index >= 0 ? ordinary[index + direction] : undefined;
			if (target) reorderQueued(id, target.id);
		},
		[queuedMessages, reorderQueued],
	);
	const handleChangeMode = useCallback(
		async (id: string, mode: QueueMode) => {
			try {
				await api.setBufferedMessageMode(narratorId, id, mode);
				reconcileBufferedMessages();
				return true;
			} catch (error) {
				notifications.show({
					color: "red",
					title: t("queuedModeFailed"),
					message: error instanceof Error ? error.message : String(error),
				});
				reconcileBufferedMessages();
				return false;
			}
		},
		[narratorId, reconcileBufferedMessages, t],
	);

	const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
	const [queueExpanded, setQueueExpanded] = useState(true);

	const handleStartEditQueued = useCallback((msg: { id: string }) => {
		setEditingQueuedId(msg.id);
	}, []);

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
	if (queuedEditRef) queuedEditRef.current = (id) => setEditingQueuedId(id);
	if (queuedCancelRef) queuedCancelRef.current = handleRemoveQueued;
	if (queuedRetryRef)
		queuedRetryRef.current = (id) => {
			void handleRetryQueued(id);
		};

	return {
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
