import { useInstanceSettings } from "@frontend/hooks/useInstanceSettings";
import {
	useNarratorComposerOptimizeTask,
	usePromptOptimizeTask,
} from "@frontend/hooks/usePromptOptimizeTask";
import {
	acknowledgePromptOptimizeDelivery,
	cancelPromptOptimizeTask,
	claimPromptOptimizeDelivery,
	getPromptOptimizeTask,
	type OptimizeStyle,
	type PromptOptimizeSnapshot,
	promptOptimizeTaskKey,
	releasePromptOptimizeSurface,
	startPromptOptimizeTask,
} from "@frontend/lib/prompt-optimize-tasks";
import { notifications } from "@mantine/notifications";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type { OptimizeStyle };

const STORAGE_KEY = "narrafork_optimize_with_context";

/** How long delivery keeps retrying while the target surface is not renderable yet. */
const DELIVERY_RETRY_MS = 250;
const DELIVERY_MAX_ATTEMPTS = 20;

export interface UsePromptOptimizeOptions {
	narratorId: string;
	messageId?: string; // For editing message context
	withContext?: boolean; // Shared context preference for an alternate editor
	/** False while a draft is hydrating or an alternate view is closed. */
	ready?: boolean;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/**
	 * Callback after successful optimization.
	 * NOT called when using document.execCommand (browser handles it).
	 */
	onOptimized?: (text: string) => void;
	/** Structured editors capture a versioned text-only transformation; atoms never enter the prompt. */
	target?: (snapshot?: PromptOptimizeSnapshot) => {
		text: string;
		snapshot: PromptOptimizeSnapshot;
		apply: (text: string) => boolean;
	} | null;
}

export interface UsePromptOptimizeResult {
	loading: boolean;
	withContext: boolean;
	contextMessageCount: number;
	toggleContext: () => void;
	setContextMessageCount: (count: number) => void;
	handleOptimize: (style: OptimizeStyle) => Promise<void>;
	cancelOptimize: () => void;
	/**
	 * Stop targeting this surface without cancelling the request.
	 *
	 * Used when a surface closes but the work should still finish — the fullscreen
	 * composer calling this keeps the request (and its result, for the inline
	 * composer to pick up if it is the same draft) alive, where a cancel would
	 * throw it away.
	 */
	releaseSurface: () => void;
}

export function usePromptOptimize(options: UsePromptOptimizeOptions): UsePromptOptimizeResult {
	const { t } = useTranslation("narrator");
	const is = useInstanceSettings();
	const [contextMessageCount, setContextMessageCount] = useState(
		is.promptOptimizeContextMaxMessages,
	);

	// Sync with settings when it changes
	useEffect(() => {
		setContextMessageCount(is.promptOptimizeContextMaxMessages);
	}, [is.promptOptimizeContextMaxMessages]);

	const [withContext, setWithContext] = useState(() => {
		try {
			return localStorage.getItem(STORAGE_KEY) === "true";
		} catch {
			return false;
		}
	});

	const key = promptOptimizeTaskKey(options.narratorId, options.messageId);
	// The request lives in the registry, not here — see `prompt-optimize-tasks`.
	// Reading it (instead of holding it) is what lets the work survive this
	// component unmounting when the user switches narrator.
	const ownTask = usePromptOptimizeTask(options.narratorId, options.messageId);
	// A composer rebuilt by a narrator switch holds no task of its own, but the
	// request it started is still running under the narrator. Adopt it so the
	// toolbar reports what the status badge already shows.
	const narratorComposerTask = useNarratorComposerOptimizeTask(
		options.messageId ? undefined : options.narratorId,
	);
	const task = ownTask?.status === "running" ? ownTask : (ownTask ?? narratorComposerTask);
	const loading = task?.status === "running";

	// `options` is a fresh object every render at some call sites, so the delivery
	// effect reads it through a ref rather than re-running on every render.
	const optionsRef = useRef(options);
	optionsRef.current = options;
	/** requestIds already applied, so a StrictMode double-effect cannot apply twice. */
	const deliveredRef = useRef<Set<string>>(new Set());
	/** Rationale already shown, so a repeated summary does not raise a second popup. */
	const shownSummaryRef = useRef<string | null>(null);

	const notifyFailure = useCallback(
		(rawMessage: string) => {
			let errorMessage = rawMessage || t("optimizeFailedGeneric");
			if (errorMessage.includes("timed out") || errorMessage.includes("timeout")) {
				errorMessage = t("optimizeTimeout");
			} else if (errorMessage.includes("context") && errorMessage.includes("available")) {
				errorMessage = t("optimizeNoContext");
			}
			notifications.show({
				title: t("optimizeFailed"),
				message: errorMessage,
				color: "red",
				autoClose: 10000,
			});
		},
		[t],
	);

	/**
	 * Deliver a finished result into THIS composer.
	 *
	 * Returns true when the result is settled (applied, or deliberately dropped) —
	 * false while the surface simply is not ready yet, which the caller retries.
	 */
	const deliverOnce = useCallback(
		(current: NonNullable<ReturnType<typeof getPromptOptimizeTask>>): boolean => {
			const opts = optionsRef.current;
			if (opts.ready === false) return false;
			const target = opts.target?.(current.snapshot);
			const textarea = opts.textareaRef.current;
			const text = current.resultText ?? "";
			const errorText = current.error ?? "";

			// Never reserve a delivery for a surface that cannot apply it yet.
			if (current.status !== "failed" && !target && !textarea) return false;
			if (!claimPromptOptimizeDelivery(current.key, current.requestId)) return false;

			if (current.status === "failed") {
				// Reported once, then released — a failed task has nothing to deliver.
				deliveredRef.current.add(current.requestId);
				notifyFailure(errorText);
				return true;
			}

			let applied = true;
			try {
				if (target) {
					if (!target.apply(text)) throw new Error(t("richComposer.optimizeChanged"));
				} else if (textarea) {
					// A late result must never overwrite intervening input.
					if (textarea.value !== current.originalText) {
						throw new Error(t("richComposer.optimizeChanged"));
					}
					textarea.focus();
					textarea.setSelectionRange(0, textarea.value.length);
					const success = textarea.ownerDocument.execCommand("insertText", false, text);
					if (!success && opts.onOptimized) opts.onOptimized(text);
				}
			} catch (err) {
				applied = false;
				notifications.show({
					title: t("optimizeFailed"),
					message: (err as Error).message || t("optimizeFailedGeneric"),
					color: "red",
					autoClose: 10000,
				});
			}

			deliveredRef.current.add(current.requestId);
			if (applied) {
				notifications.show({
					message: t("optimizeSuccess"),
					color: "green",
					autoClose: 8000,
				});
				// Presentation only: the rationale is shown beside the result and never
				// enters the composer.
				const summary = current.summary?.trim();
				if (summary && shownSummaryRef.current !== summary) {
					shownSummaryRef.current = summary;
					notifications.show({
						title: t("optimizeSummaryTitle"),
						message: summary,
						color: "indigo",
						autoClose: 12000,
						withCloseButton: true,
					});
				}
			}
			return true;
		},
		[t, notifyFailure],
	);

	/**
	 * Claim a pending result.
	 *
	 * Keyed on primitives so it re-runs exactly when the task moves to a finished
	 * state, never on every render. If the surface is not ready the effect returns
	 * without acknowledging, and the task stays pending for the next attempt or the
	 * next mount — that is how a result survives the composer being unmounted.
	 */
	const pendingRequestId = task?.pendingDelivery ? task.requestId : undefined;
	const pendingStatus = task?.status;
	/** The key the claimed task actually lives under — it may be a sibling's. */
	const pendingKey = task?.key ?? key;
	useEffect(() => {
		if (options.ready === false || !pendingRequestId || pendingStatus === "running") return;
		if (deliveredRef.current.has(pendingRequestId)) {
			// Already applied by an earlier mount of this component.
			acknowledgePromptOptimizeDelivery(pendingKey, pendingRequestId);
			return;
		}
		let cancelled = false;
		let attempts = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const attempt = () => {
			if (cancelled) return;
			const current = getPromptOptimizeTask(pendingKey);
			// A superseding request replaced this one — nothing to deliver.
			if (!current || current.requestId !== pendingRequestId) return;
			if (deliverOnce(current)) {
				acknowledgePromptOptimizeDelivery(pendingKey, pendingRequestId);
				return;
			}
			if (++attempts < DELIVERY_MAX_ATTEMPTS) {
				timer = setTimeout(attempt, DELIVERY_RETRY_MS);
			}
		};
		attempt();

		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [pendingRequestId, pendingStatus, pendingKey, deliverOnce, options.ready]);

	const handleOptimize = useCallback(
		async (style: OptimizeStyle) => {
			const textarea = optionsRef.current.textareaRef.current;
			const target = optionsRef.current.target?.();
			const originalText = target?.text ?? textarea?.value ?? "";
			if (!originalText.trim()) return;

			const useContext = optionsRef.current.withContext ?? withContext;
			try {
				localStorage.setItem(STORAGE_KEY, String(useContext));
			} catch {
				// Ignore localStorage errors
			}

			shownSummaryRef.current = null;
			// The registry owns the request from here: it keeps running if this
			// composer unmounts, and its result is attributed to this narrator.
			startPromptOptimizeTask({
				narratorId: optionsRef.current.narratorId,
				messageId: optionsRef.current.messageId,
				text: originalText,
				snapshot: target?.snapshot,
				style,
				withContext: useContext,
			});
		},
		[withContext],
	);

	/**
	 * Cancel whichever task this toolbar is currently reporting.
	 *
	 * It may be a task this composer instance did not start (see `task` above), so
	 * cancelling the local key only would leave the X button doing nothing.
	 */
	const cancelOptimize = useCallback(() => {
		cancelPromptOptimizeTask(task?.status === "running" ? task.key : key);
	}, [task, key]);

	/**
	 * Give up this surface's claim on the result without killing the request.
	 *
	 * The task stays in the registry: whoever is still showing this draft (the
	 * inline composer, or this surface when it reopens) can claim it. This is the
	 * difference between "I closed the fullscreen view" and "I don't want this
	 * anymore", and only the latter should abort.
	 */
	const releaseSurface = useCallback(() => {
		releasePromptOptimizeSurface(key);
	}, [key]);

	const toggleContext = useCallback(() => {
		setWithContext((prev) => !prev);
	}, []);

	return {
		loading,
		withContext,
		contextMessageCount,
		toggleContext,
		setContextMessageCount,
		handleOptimize,
		cancelOptimize,
		releaseSurface,
	};
}
