import { type ContextUsageSnapshot, parseContextUsageSnapshot } from "@shared/context-usage";

function nonnegative(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Legacy percentages describe occupancy, not the independently billed prompt. */
export function legacyContextSnapshot(
	percentage: unknown,
	promptTokens: unknown,
	contextWindow: unknown,
	isEstimated = false,
): ContextUsageSnapshot {
	const pct = nonnegative(percentage);
	const window = nonnegative(contextWindow);
	const tokens =
		pct != null && window != null && window > 0 ? (pct * window) / 100 : nonnegative(promptTokens);
	return {
		requestId: "legacy",
		startedAt: "",
		source: isEstimated ? "estimate" : pct != null ? "upstream" : "usage",
		percentage:
			pct ?? (tokens != null && window != null && window > 0 ? (tokens / window) * 100 : null),
		contextWindow: window,
		occupiedTokens: tokens,
		inputCharacters: null,
		composition: null,
	};
}

export function contextSnapshotFromHistory(
	percentage: unknown,
	usage?: Record<string, unknown> | null,
): ContextUsageSnapshot {
	const snapshot = parseContextUsageSnapshot(usage?.context_snapshot);
	if (snapshot) return snapshot;
	const prompt = nonnegative(usage?.prompt_tokens);
	const input = nonnegative(usage?.input_tokens);
	return legacyContextSnapshot(
		percentage,
		prompt ??
			(input == null
				? null
				: input +
					(nonnegative(usage?.cached_input_tokens) ?? 0) +
					(nonnegative(usage?.cache_creation_input_tokens) ?? 0)),
		usage?.context_window,
		usage?.is_estimated === true,
	);
}

export function contextSnapshotFields(snapshot: ContextUsageSnapshot) {
	return {
		contextSnapshot: snapshot,
		contextPercent: snapshot.percentage,
		promptTokens: snapshot.occupiedTokens,
		contextWindow: snapshot.contextWindow,
		isEstimated: snapshot.source === "estimate",
	};
}
