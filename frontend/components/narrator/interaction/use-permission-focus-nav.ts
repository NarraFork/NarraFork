import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";

/** Value shape published on PermEnterHintCtx (see tool-call-contexts). */
export interface PermEnterHintCtxValue {
	focusIndex: number | null;
	setFocusIndex: (i: number | null) => void;
	setButtonCount: (n: number) => void;
	setHasFeedback: (has: boolean) => void;
	registerActions: (actions: (() => void)[]) => void;
	activePermissionId: string | null;
}

export interface UsePermissionFocusNavOptions {
	/** id of the earliest pending permission, or null when none. */
	pendingPermissionId: string | null;
	/** toolName of the pending permission (AskUserQuestion suppresses the hint). */
	pendingPermissionToolName: string | undefined;
	/** Whether the composer currently has sendable content (suppresses the hint). */
	composerSendable: boolean;
	/** Shared composer handle — the keydown guard reads its live textarea state. */
	composerRef: React.RefObject<NarratorComposerHandle | null>;
}

export interface UsePermissionFocusNavResult {
	/** Resolved focus index (null when the hint is inactive). */
	effectiveFocusIndex: number | null;
	/** Context value to publish on PermEnterHintCtx.Provider. */
	permEnterHintCtxValue: PermEnterHintCtxValue;
}

/**
 * Index-based keyboard navigation for permission buttons, extracted from
 * NarratorPanel: left/right arrows shift the highlighted button and Enter fires
 * its registered action, defaulting to Allow (first) or Deny (last, when the
 * permission has feedback).
 *
 * Kept lifted (called from the panel) rather than sunk into the permission card:
 * the ctx value it produces wraps the whole panel via PermEnterHintCtx.Provider
 * (consumed by deeply nested permission children), and the global keydown handler
 * reads the shared `composerRef` to avoid stealing arrow/Enter keys while typing.
 */
export function usePermissionFocusNav(
	options: UsePermissionFocusNavOptions,
): UsePermissionFocusNavResult {
	const { pendingPermissionId, pendingPermissionToolName, composerSendable, composerRef } = options;

	const permHintActive =
		!composerSendable && !!pendingPermissionId && pendingPermissionToolName !== "AskUserQuestion";

	// focusIndex tracks which button is highlighted; left/right arrows shift it.
	const [permFocusIndex, setPermFocusIndex] = useState<number | null>(null);
	const [permButtonCount, setPermButtonCount] = useState(0);
	const [permHasFeedback, setPermHasFeedback] = useState(false);

	// Reset when permission changes (render-phase, matching the panel's original).
	const prevPermIdRef = useRef<string | null>(null);
	const currentPermId = pendingPermissionId;
	if (prevPermIdRef.current !== currentPermId) {
		prevPermIdRef.current = currentPermId;
		if (permFocusIndex !== null) setPermFocusIndex(null);
		if (permHasFeedback) setPermHasFeedback(false);
	}

	const handlePermFeedbackChange = useCallback((has: boolean) => {
		setPermHasFeedback(has);
		// When feedback changes, reset manual override so default kicks in
		setPermFocusIndex(null);
	}, []);

	const handlePermSetButtonCount = useCallback((n: number) => {
		setPermButtonCount(n);
	}, []);

	// Ref holding the onClick handlers for each permission button, registered by the child.
	const permActionsRef = useRef<(() => void)[]>([]);
	const handlePermRegisterActions = useCallback((actions: (() => void)[]) => {
		permActionsRef.current = actions;
	}, []);

	// Effective focus index: when no manual override, default to 0 (first button = Allow)
	// or last button (Deny) when feedback is present.
	const effectiveFocusIndex = permHintActive
		? (permFocusIndex ?? (permHasFeedback ? permButtonCount - 1 : 0))
		: null;

	const permEnterHintCtxValue = useMemo(
		() => ({
			focusIndex: effectiveFocusIndex,
			setFocusIndex: setPermFocusIndex,
			setButtonCount: handlePermSetButtonCount,
			setHasFeedback: handlePermFeedbackChange,
			registerActions: handlePermRegisterActions,
			activePermissionId: pendingPermissionId,
		}),
		[
			effectiveFocusIndex,
			handlePermSetButtonCount,
			handlePermFeedbackChange,
			handlePermRegisterActions,
			pendingPermissionId,
		],
	);

	useEffect(() => {
		if (effectiveFocusIndex == null) return;
		const handler = (e: KeyboardEvent) => {
			// Don't intercept if user is typing in an input/textarea (other than the main one)
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
			) {
				// Allow only if it's our main textarea AND it's empty. The composer
				// owns the text now; both checks read its live state through the handle.
				if (!composerRef.current?.ownsTextarea(target)) return;
				if (!composerRef.current.isTextEmpty()) return;
			}

			if (
				(e.key === "ArrowLeft" || e.key === "ArrowRight") &&
				!e.shiftKey &&
				!e.ctrlKey &&
				!e.metaKey
			) {
				e.preventDefault();
				const count = permButtonCount;
				if (count <= 1) return;
				setPermFocusIndex((prev) => {
					const cur = prev ?? effectiveFocusIndex ?? 0;
					if (e.key === "ArrowLeft") return cur <= 0 ? count - 1 : cur - 1;
					return cur >= count - 1 ? 0 : cur + 1;
				});
				return;
			}

			if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
				const action = permActionsRef.current[effectiveFocusIndex];
				if (!action) return;
				e.preventDefault();
				action();
				setPermFocusIndex(null);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [effectiveFocusIndex, permButtonCount, composerRef]);

	return { effectiveFocusIndex, permEnterHintCtxValue };
}
