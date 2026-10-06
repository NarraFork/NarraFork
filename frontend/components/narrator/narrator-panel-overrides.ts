/**
 * narrator-panel-overrides.ts — the panel's three-state override vocabulary.
 *
 * Extracted from `NarratorPanel.tsx` unchanged. Every per-narrator setting the panel
 * exposes is really THREE states, not two: follow the global default (`"inherit"`), or
 * override it on (`"on"` / a level), or override it off. The normalizers below are what
 * keep an unknown stored value from being read as a deliberate override — a narrator
 * written by an older build must fall back to following the default, not to whatever
 * `undefined` happens to coerce to at the call site.
 *
 * `resolveDangerReflectionLevel` is the one with a non-obvious rule: `"on"` means "keep
 * following the global LEVEL, just do not be off", so it resolves to the global level
 * unless that is itself off (then the mildest real level).
 *
 * Pure and React-free, which is why they live here rather than in the component: they
 * are the part of the panel that can be reasoned about without mounting anything.
 */

import { DEFAULT_CONTEXT_THRESHOLDS } from "@shared/context-thresholds";
import type { AsyncQuestion } from "../../types/narrator";
import type { ContentBlock, NarratorMsg } from "./narrator-panel-types";
import { PERM_MODES } from "./narrator-panel-types";
import type { PaymentRequiredInfo } from "./useNarratorPanelWS";

export function parsePersistedPaymentRequired(value: unknown): Partial<PaymentRequiredInfo> | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (parsed.type !== "payment_required") return null;
		const resumeAction = parsed.resumeAction === "continue" ? "continue" : "retry";
		const balance = typeof parsed.balance === "number" ? parsed.balance : undefined;
		const required = typeof parsed.required === "number" ? parsed.required : undefined;
		return {
			providerId: typeof parsed.providerId === "string" ? parsed.providerId : undefined,
			providerPrefix: typeof parsed.providerPrefix === "string" ? parsed.providerPrefix : undefined,
			balance,
			required,
			resumeAction,
		};
	} catch {
		return null;
	}
}

export const PERM_MODE_DATA = PERM_MODES.map((m) => ({ value: m, label: `perm_${m}` }));
export const BOOLEAN_OVERRIDE_VALUES = ["inherit", "on", "off"] as const;
export type BooleanOverride = (typeof BOOLEAN_OVERRIDE_VALUES)[number];
export const DANGER_REFLECTION_LEVEL_VALUES = ["off", "light", "standard", "strict"] as const;
export type DangerReflectionLevel = (typeof DANGER_REFLECTION_LEVEL_VALUES)[number];
export const DANGER_REFLECTION_OVERRIDE_VALUES = [
	"inherit",
	"on",
	...DANGER_REFLECTION_LEVEL_VALUES,
] as const;
export type DangerReflectionOverride = (typeof DANGER_REFLECTION_OVERRIDE_VALUES)[number];

export type ContextThresholdsDraft = {
	standard: { compactStart: number };
	large: { compactStart: number };
};

export type ContextManagementDraft = {
	contextThresholds: ContextThresholdsDraft;
	autoCompactKeepPairs: number;
};

export const DEFAULT_CONTEXT_THRESHOLDS_DRAFT: ContextThresholdsDraft = DEFAULT_CONTEXT_THRESHOLDS;
export const DEFAULT_AUTO_COMPACT_KEEP_PAIRS = 2;

export function normalizeBooleanOverride(value: unknown): BooleanOverride {
	return BOOLEAN_OVERRIDE_VALUES.includes(value as BooleanOverride)
		? (value as BooleanOverride)
		: "inherit";
}

export function normalizeDangerReflectionLevel(
	value: unknown,
	legacyEnabled = true,
): DangerReflectionLevel {
	return DANGER_REFLECTION_LEVEL_VALUES.includes(value as DangerReflectionLevel)
		? (value as DangerReflectionLevel)
		: legacyEnabled
			? "standard"
			: "off";
}

export function normalizeDangerReflectionOverride(value: unknown): DangerReflectionOverride {
	return DANGER_REFLECTION_OVERRIDE_VALUES.includes(value as DangerReflectionOverride)
		? (value as DangerReflectionOverride)
		: "inherit";
}

export function resolveDangerReflectionLevel(
	override: unknown,
	globalLevel: DangerReflectionLevel,
): DangerReflectionLevel {
	const normalizedOverride = normalizeDangerReflectionOverride(override);
	if (normalizedOverride === "inherit") return globalLevel;
	if (normalizedOverride === "on") return globalLevel === "off" ? "standard" : globalLevel;
	return normalizedOverride;
}

export function formatDangerReflectionLevel(
	level: DangerReflectionLevel,
	t: (key: string) => string,
): string {
	return t(`dangerReflectionLevel_${level}`);
}

export function resolveBooleanOverride(value: unknown, globalDefault: boolean): boolean {
	const override = normalizeBooleanOverride(value);
	if (override === "inherit") return globalDefault;
	return override === "on";
}

/** Number of queued messages before the queue collapses into a summary bar. */
export const QUEUE_COLLAPSE_THRESHOLD = 2;

/**
 * Stable empty list for the async-question inbox.
 *
 * A fresh `[]` per render would give the slot memo a new dependency every time and
 * rebuild the map (and with it every mounted question form) on unrelated renders.
 */
export const EMPTY_ASYNC_QUESTIONS: AsyncQuestion[] = [];

export type CompactingMarkerKind = "context" | "segment";

export function _getCompactingMarkerKind(
	message: Pick<NarratorMsg, "contentJson">,
): CompactingMarkerKind | null {
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const block = blocks.find(
		(block: ContentBlock) =>
			(block.type === "compact" || block.type === "segment_compact") &&
			block.status === "compacting",
	);
	if (!block) return null;
	return block.type === "segment_compact" ? "segment" : "context";
}

export type BufferedSendResult = {
	buffered?: boolean;
	id?: string;
	bufferedAt?: string;
	/** Set when a busy `/goal` was queued; used to show a "queued task" toast. */
	specGoalQueued?: boolean;
	/** The protected task text carried by a queued `/goal`. */
	objective?: string;
};

export function getMessageViewportScrollBottom(scroller: HTMLElement) {
	return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

export function _getMessageViewportDistanceFromBottom(scroller: HTMLElement) {
	return getMessageViewportScrollBottom(scroller) - scroller.scrollTop;
}

/**
 * Modal with a searchable Select to change the global default or summary model.
 * Used from the per-narrator model menu so users with many models can filter by
 * typing instead of scrolling. Excludes meta sentinels (follow-default /
 * follow-summary) to avoid self/circular references.
 */
