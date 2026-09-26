import type { SubagentModelInheritance } from "@shared/model-inheritance";

export interface ModelInheritanceLabel {
	/** Short label for wide slots: "Follow · Y" / "Fallback · X". */
	label: string;
	/** Bare model for narrow slots, paired with an icon. */
	model: string;
	/** Only a fallback carries a reason; followed parents need no explanation. */
	reason?: string;
	fallback: boolean;
}

/**
 * Label a `__parent__` child by what it actually runs. Without an inheritance
 * decision (never resolved, or resolution failed) the caller keeps the plain
 * "follow parent" text rather than guessing a model.
 */
export function modelInheritanceLabel(
	inheritance: SubagentModelInheritance | null | undefined,
	t: (key: string, opts?: Record<string, unknown>) => string,
): ModelInheritanceLabel | null {
	if (!inheritance) return null;
	const fallback = inheritance.source === "pool-fallback";
	return {
		label: t(fallback ? "inheritance.fallbackLabel" : "inheritance.followLabel", {
			model: inheritance.model,
		}),
		model: inheritance.model,
		fallback,
		...(fallback && {
			reason: t("inheritance.fallbackReason", {
				parentModel: inheritance.parentModel,
				pool: inheritance.poolKey ?? "general",
			}),
		}),
	};
}
