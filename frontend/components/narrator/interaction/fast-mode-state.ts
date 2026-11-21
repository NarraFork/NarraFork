export type FastModeOverride = "inherit" | "on" | "off";

export interface FastModePresentationInput {
	fastModeOverride?: unknown;
	effectiveFastMode?: unknown;
	fastModeSource?: unknown;
}

/** Older details can resolve explicit choices, but never another user's inherited default. */
export function fastModePresentation(input: FastModePresentationInput) {
	const override: FastModeOverride =
		input.fastModeOverride === "on" || input.fastModeOverride === "off"
			? input.fastModeOverride
			: "inherit";
	const hasEffectiveValue = typeof input.effectiveFastMode === "boolean";
	return {
		override,
		enabled: hasEffectiveValue ? input.effectiveFastMode === true : override === "on",
		sourceUnavailable:
			override === "inherit" && (input.fastModeSource === "unavailable" || !hasEffectiveValue),
	};
}

export function fastModeDetailLabel(
	input: FastModePresentationInput,
	isSubagent: boolean,
	t: (key: string, options?: Record<string, unknown>) => string,
) {
	const { override, enabled, sourceUnavailable } = fastModePresentation(input);
	const state = enabled ? t("details.on") : t("details.off");
	if (override !== "inherit") return t("details.fastModeIndependent", { state });
	if (sourceUnavailable) return t("fast_mode_source_unavailable");
	return t(isSubagent ? "details.fastModePrimary" : "details.fastModeInherited", { state });
}

/** Details normalize subagent identity to a variant; accept the persisted type for snapshots. */
export function isFastModeSubagent(input: { variant?: unknown; type?: unknown }) {
	return (
		(typeof input.variant === "string" && input.variant.startsWith("subagent:")) ||
		input.type === "subagent"
	);
}
