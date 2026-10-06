/**
 * progress-label.ts — Localized labels for the two-phase progress of auxiliary
 * model calls (compaction, reflection gates).
 *
 * One composer for every chunked-path call site (compact indicator, status bar,
 * reflection notice) so the phrasing cannot drift between them. The exact vlist
 * composes its compact label inside `shared/pretext-layout/segment-adapter.ts`
 * instead, because that text is MEASURED and therefore has to reach the pure
 * layer through the adapter's label map — the two share the same i18n keys and
 * the same `shouldShowThinkingChars` threshold.
 */

import { type ProgressSnapshot, shouldShowThinkingChars } from "@shared/progress-phase";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The count fragment for a compact indicator / status line.
 *
 * Thinking phase: a bare "thinking" until the count crosses the display
 * threshold, then "thinking · N chars" — a two-character count conveys nothing
 * and just makes the label flicker while the stream warms up.
 *
 * A retry in flight takes priority over the counts: the whole point of the
 * retry broadcast is that "0 chars" alone reads as a stall while the summary
 * model is actually failing and recovering.
 */
export function compactProgressLabel(
	t: Translate,
	progress: (ProgressSnapshot & { retryCount?: number }) | null,
): string {
	if (progress?.retryCount && progress.retryCount > 0) {
		return t("compactRetrying", { count: progress.retryCount });
	}
	if (!progress || progress.phase === "output") {
		return t("compactOutputChars", { count: progress?.outputChars ?? 0 });
	}
	const thinking = t("compactThinking");
	if (!shouldShowThinkingChars(progress.thinkingChars)) return thinking;
	return `${thinking} · ${t("compactThinkingChars", { count: progress.thinkingChars })}`;
}

/** The same fragment for a running reflection gate. */
export function reflectionProgressLabel(t: Translate, progress: ProgressSnapshot): string {
	if (progress.phase === "output") {
		return t("reflectionOutputChars", { count: progress.outputChars });
	}
	if (!shouldShowThinkingChars(progress.thinkingChars)) return t("reflectionThinking");
	return t("reflectionThinkingChars", { count: progress.thinkingChars });
}
