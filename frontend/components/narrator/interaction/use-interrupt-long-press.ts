import { notifications } from "@mantine/notifications";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseInterruptLongPressOptions {
	narratorId: string;
	// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough from useInterruptNarrator.
	interruptMutation: any;
	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface UseInterruptLongPressResult {
	/** 0..1 progress of the hold gesture (drives the button's fill ring). */
	interruptProgress: number;
	/** Mouse-down handler that starts the hold timer. */
	startInterruptPress: (e: React.MouseEvent) => void;
	/** Callback ref for the button element — wires passive touch listeners. */
	interruptBtnRef: (btn: HTMLButtonElement | null) => void;
	/** Mouse-up handler: hints if released early, always clears the timer. */
	handleInterruptMouseUp: () => void;
	/** Cancels the hold timer and resets progress. */
	clearInterruptTimer: () => void;
}

/**
 * Press-and-hold interrupt gesture for the narrator's stop button. Holding for
 * 600ms fires the interrupt mutation; releasing early shows a hint. Extracted
 * verbatim from NarratorPanel — the ref mirrors (`interruptMutationRef` /
 * `narratorIdRef` / `clearInterruptTimerRef` / `handleInterruptMouseUpRef`)
 * keep the callbacks stable while still seeing the latest values, so the touch
 * listeners bound once in `interruptBtnRef` never go stale.
 */
export function useInterruptLongPress(
	options: UseInterruptLongPressOptions,
): UseInterruptLongPressResult {
	const { narratorId, interruptMutation, t } = options;

	const [interruptProgress, setInterruptProgress] = useState(0);
	const interruptTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const interruptFiredRef = useRef(false);
	const clearInterruptTimer = useCallback(() => {
		if (interruptTimerRef.current) {
			clearInterval(interruptTimerRef.current);
			interruptTimerRef.current = null;
		}
		setInterruptProgress(0);
		interruptFiredRef.current = false;
	}, []);
	const interruptMutationRef = useRef(interruptMutation);
	interruptMutationRef.current = interruptMutation;
	const narratorIdRef = useRef(narratorId);
	narratorIdRef.current = narratorId;
	const clearInterruptTimerRef = useRef(clearInterruptTimer);
	clearInterruptTimerRef.current = clearInterruptTimer;

	const startInterruptPress = useCallback((_e: React.MouseEvent) => {
		interruptFiredRef.current = false;
		const start = Date.now();
		const duration = 600;
		interruptTimerRef.current = setInterval(() => {
			const elapsed = Date.now() - start;
			const pct = Math.min(elapsed / duration, 1);
			setInterruptProgress(pct);
			if (pct >= 1 && !interruptFiredRef.current) {
				interruptFiredRef.current = true;
				if (interruptTimerRef.current != null) clearInterval(interruptTimerRef.current);
				interruptTimerRef.current = null;
				interruptMutationRef.current.mutate({ id: narratorIdRef.current });
			}
		}, 16);
	}, []);
	const interruptBtnCleanupRef = useRef<(() => void) | null>(null);
	const interruptBtnRef = useCallback((btn: HTMLButtonElement | null) => {
		if (interruptBtnCleanupRef.current) {
			interruptBtnCleanupRef.current();
			interruptBtnCleanupRef.current = null;
		}
		if (!btn) return;
		const onTouchStart = (e: TouchEvent) => {
			e.preventDefault();
			interruptFiredRef.current = false;
			const start = Date.now();
			const duration = 600;
			interruptTimerRef.current = setInterval(() => {
				const elapsed = Date.now() - start;
				const pct = Math.min(elapsed / duration, 1);
				setInterruptProgress(pct);
				if (pct >= 1 && !interruptFiredRef.current) {
					interruptFiredRef.current = true;
					if (interruptTimerRef.current != null) clearInterval(interruptTimerRef.current);
					interruptTimerRef.current = null;
					interruptMutationRef.current.mutate({ id: narratorIdRef.current });
				}
			}, 16);
		};
		const onTouchEnd = () => handleInterruptMouseUpRef.current();
		const onTouchCancel = () => clearInterruptTimerRef.current();
		btn.addEventListener("touchstart", onTouchStart, { passive: false });
		btn.addEventListener("touchend", onTouchEnd);
		btn.addEventListener("touchcancel", onTouchCancel);
		interruptBtnCleanupRef.current = () => {
			btn.removeEventListener("touchstart", onTouchStart);
			btn.removeEventListener("touchend", onTouchEnd);
			btn.removeEventListener("touchcancel", onTouchCancel);
		};
	}, []);
	const handleInterruptMouseUp = useCallback(() => {
		if (!interruptFiredRef.current && interruptTimerRef.current) {
			notifications.show({
				message: t("interruptHoldHint"),
				color: "yellow",
			});
		}
		clearInterruptTimer();
	}, [clearInterruptTimer, t]);
	const handleInterruptMouseUpRef = useRef(handleInterruptMouseUp);
	handleInterruptMouseUpRef.current = handleInterruptMouseUp;

	useEffect(() => clearInterruptTimer, [clearInterruptTimer]);

	return {
		interruptProgress,
		startInterruptPress,
		interruptBtnRef,
		handleInterruptMouseUp,
		clearInterruptTimer,
	};
}
