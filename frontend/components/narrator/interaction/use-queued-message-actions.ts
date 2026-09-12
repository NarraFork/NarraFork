import type { DragEndEvent } from "@dnd-kit/core";
import { notifications } from "@mantine/notifications";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BufferMessageSummary } from "../../../lib/api";
import { api } from "../../../lib/api";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";

/** Number of queued messages before the queue collapses into a summary bar. */
const QUEUE_COLLAPSE_THRESHOLD = 2;

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
		composerRef,
		handleSendRef,
		handleSendWithModeRef,
		ctrlEnterQueueModeRef,
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
			// Restore the first queued message text to the input
			composerRef.current?.restoreInput(
				queuedMessages[0].text,
				(queuedMessages[0].fileReferences ?? []).map((reference) => ({
					...reference,
					inputRange: undefined,
				})),
			);
			setQueuedMessages([]);
		}
	}, [queuedMessages, cancelBuffer, narratorId, composerRef, setQueuedMessages]);

	const handleRemoveQueued = useCallback(
		(messageId: string) => {
			const msg = queuedMessages.find((m) => m.id === messageId);
			const snapshot = queuedMessages;
			setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
			// If removing the only message, restore its text to input
			if (queuedMessages.length === 1 && msg) {
				composerRef.current?.restoreInput(
					msg.text,
					(msg.fileReferences ?? []).map((reference) => ({ ...reference, inputRange: undefined })),
				);
			}
			api.removeBufferedMessage(narratorId, messageId).catch(() => {
				// Rollback on failure
				setQueuedMessages(snapshot);
				if (queuedMessages.length === 1 && msg) {
					composerRef.current?.restoreInput("", []);
				}
			});
		},
		[queuedMessages, setQueuedMessages, narratorId, composerRef],
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

	const handleDragEndQueued = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const oldIndex = queuedMessages.findIndex((m) => m.id === active.id);
			const newIndex = queuedMessages.findIndex((m) => m.id === over.id);
			if (oldIndex === -1 || newIndex === -1) return;
			const newOrder = [...queuedMessages];
			const [moved] = newOrder.splice(oldIndex, 1);
			newOrder.splice(newIndex, 0, moved);
			const snapshot = queuedMessages;
			setQueuedMessages(newOrder);
			api
				.reorderBufferedMessages(
					narratorId,
					newOrder.map((m) => m.id),
				)
				.catch(() => {
					setQueuedMessages(snapshot);
				});
		},
		[queuedMessages, narratorId, setQueuedMessages],
	);

	const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
	const [queueExpanded, setQueueExpanded] = useState(false);

	// Auto-reset expanded state when queue shrinks to ≤2
	useEffect(() => {
		if (queuedMessages.length <= QUEUE_COLLAPSE_THRESHOLD) setQueueExpanded(false);
	}, [queuedMessages.length]);

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
			const snapshot = queuedMessages;
			setQueuedMessages((prev) =>
				prev.map((m) =>
					m.id === msg.id ? { ...m, text, bufferedAt: new Date().toISOString() } : m,
				),
			);
			try {
				await api.updateBufferedMessage(narratorId, msg.id, text, payload);
				return true;
			} catch (err) {
				setQueuedMessages(snapshot);
				notifications.show({
					color: "red",
					title: t("editQueuedFailed"),
					message: err instanceof Error ? err.message : String(err),
				});
				return false;
			}
		},
		[queuedMessages, setQueuedMessages, narratorId, t],
	);

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
		editingQueuedId,
		queueExpanded,
		setQueueExpanded,
		handleStartEditQueued,
		handleCancelEditQueued,
		handleSaveEditQueued,
	};
}
