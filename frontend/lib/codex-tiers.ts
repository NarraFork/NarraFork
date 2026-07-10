import type { CodexPlanTier, PublicCodexPlanTier } from "./api/types";

export const CODEX_DISPLAY_TIERS: PublicCodexPlanTier[] = [
	"free",
	"plus",
	"team",
	"k12",
	"prolite",
	"pro",
];

export const CODEX_TIER_ORDER_VALUES: CodexPlanTier[] = [
	"pro",
	"prolite",
	"plus",
	"team",
	"k12",
	"free",
	"other",
];

export const CODEX_DEFAULT_TIER_ORDER: PublicCodexPlanTier[] = [
	"pro",
	"prolite",
	"plus",
	"team",
	"k12",
	"free",
];

export function getCodexDisplayTierOrder(order?: readonly string[] | null): PublicCodexPlanTier[] {
	const result: PublicCodexPlanTier[] = [];
	for (const tier of order ?? CODEX_DEFAULT_TIER_ORDER) {
		const displayTier = CODEX_DEFAULT_TIER_ORDER.find((candidate) => candidate === tier);
		if (displayTier && !result.includes(displayTier)) result.push(displayTier);
	}
	for (const tier of CODEX_DEFAULT_TIER_ORDER) {
		if (!result.includes(tier)) result.push(tier);
	}
	return result;
}

export const CODEX_TIER_COLORS: Record<CodexPlanTier, string> = {
	free: "gray",
	plus: "blue",
	team: "cyan",
	k12: "orange",
	prolite: "violet",
	pro: "green",
	other: "dark",
};

export const CODEX_TIER_STROKES: Record<CodexPlanTier, string> = {
	free: "var(--mantine-color-gray-6)",
	plus: "var(--mantine-color-blue-6)",
	team: "var(--mantine-color-cyan-6)",
	k12: "var(--mantine-color-orange-6)",
	prolite: "var(--mantine-color-violet-6)",
	pro: "var(--mantine-color-green-6)",
	other: "var(--mantine-color-dark-4)",
};

type Translate = (key: string) => string;

export function normalizeCodexPlanTier(planType?: string | null): CodexPlanTier {
	if (!planType) return "other";
	const normalized = planType.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!normalized) return "other";
	if (normalized === "k12") return "k12";
	if (normalized.includes("prolite") || normalized.includes("litepro")) return "prolite";
	if (normalized.includes("plus")) return "plus";
	if (normalized.includes("team") || normalized.includes("business")) return "team";
	if (normalized.includes("free")) return "free";
	if (normalized === "pro" || normalized.endsWith("pro") || normalized.includes("chatgptpro")) {
		return "pro";
	}
	return "other";
}

export function getCodexTierLabel(t: Translate, tier: CodexPlanTier): string {
	if (tier === "free") return t("codexQuotaTierFree");
	if (tier === "plus") return t("codexQuotaTierPlus");
	if (tier === "team") return t("codexQuotaTierTeam");
	if (tier === "k12") return t("codexQuotaTierK12");
	if (tier === "prolite") return t("codexQuotaTierProLite");
	if (tier === "pro") return t("codexQuotaTierPro");
	return t("codexQuotaTierOther");
}

export function getCodexPlanTypeLabel(t: Translate, planType?: string | null): string {
	const trimmedPlanType = planType?.trim() ?? "";
	if (!trimmedPlanType) return getCodexTierLabel(t, "other");

	const tier = normalizeCodexPlanTier(trimmedPlanType);
	return tier === "other" ? trimmedPlanType : getCodexTierLabel(t, tier);
}
