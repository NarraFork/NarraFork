import { describe, expect, test } from "bun:test";
import enSettings from "../../frontend/locales/en/settings.json";
import zhCnSettings from "../../frontend/locales/zh-CN/settings.json";

async function loadCodexTiers() {
	return import("../../frontend/lib/codex-tiers");
}

const translateKey = (key: string) => key;

describe("Codex tier metadata", () => {
	test("uses K12 as the English and Simplified Chinese display label", () => {
		expect(enSettings.codexQuotaTierK12).toBe("K12");
		expect(zhCnSettings.codexQuotaTierK12).toBe("K12");
	});

	test("exports the exact display and priority orders", async () => {
		const { CODEX_DEFAULT_TIER_ORDER, CODEX_DISPLAY_TIERS, CODEX_TIER_ORDER_VALUES } =
			await loadCodexTiers();

		expect(CODEX_DISPLAY_TIERS).toEqual(["free", "plus", "team", "k12", "prolite", "pro"]);
		expect(CODEX_TIER_ORDER_VALUES).toEqual([
			"pro",
			"prolite",
			"plus",
			"team",
			"k12",
			"free",
			"other",
		]);
		expect(CODEX_DEFAULT_TIER_ORDER).toEqual(["pro", "prolite", "plus", "team", "k12", "free"]);
		expect(CODEX_DEFAULT_TIER_ORDER.indexOf("k12")).toBe(
			CODEX_DEFAULT_TIER_ORDER.indexOf("team") + 1,
		);
		expect(CODEX_DEFAULT_TIER_ORDER.indexOf("k12")).toBe(
			CODEX_DEFAULT_TIER_ORDER.indexOf("free") - 1,
		);
	});

	test("normalizes only recognized K12 and existing plan names", async () => {
		const { normalizeCodexPlanTier } = await loadCodexTiers();

		expect(normalizeCodexPlanTier("k12")).toBe("k12");
		expect(normalizeCodexPlanTier("enterprise")).toBe("other");
		expect(normalizeCodexPlanTier("edu")).toBe("other");
		expect(normalizeCodexPlanTier("K12 School")).toBe("other");
		expect(normalizeCodexPlanTier("")).toBe("other");
		expect(normalizeCodexPlanTier("   ")).toBe("other");
		expect(normalizeCodexPlanTier(null)).toBe("other");
		expect(normalizeCodexPlanTier(undefined)).toBe("other");
	});

	test("provides K12 labels, colors, and chart strokes", async () => {
		const { CODEX_TIER_COLORS, CODEX_TIER_STROKES, getCodexTierLabel } = await loadCodexTiers();

		expect(getCodexTierLabel(translateKey, "k12")).toBe("codexQuotaTierK12");
		expect(CODEX_TIER_COLORS.k12).toBe("orange");
		expect(CODEX_TIER_COLORS.other).toBe("dark");
		expect(CODEX_TIER_STROKES.k12).toBe("var(--mantine-color-orange-6)");
	});

	test("localizes known plan types and preserves unknown non-empty names", async () => {
		const { getCodexPlanTypeLabel } = await loadCodexTiers();

		expect(getCodexPlanTypeLabel(translateKey, "k12")).toBe("codexQuotaTierK12");
		expect(getCodexPlanTypeLabel(translateKey, "business")).toBe("codexQuotaTierTeam");
		expect(getCodexPlanTypeLabel(translateKey, "  Enterprise Academic  ")).toBe(
			"Enterprise Academic",
		);
		expect(getCodexPlanTypeLabel(translateKey, "K12 School")).toBe("K12 School");
		expect(getCodexPlanTypeLabel(translateKey, "   ")).toBe("codexQuotaTierOther");
		expect(getCodexPlanTypeLabel(translateKey, null)).toBe("codexQuotaTierOther");
	});
});
