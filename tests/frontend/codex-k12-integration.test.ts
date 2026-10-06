import { describe, expect, test } from "bun:test";

async function readSource(relativePath: string): Promise<string> {
	return Bun.file(new URL(`../../${relativePath}`, import.meta.url)).text();
}

function getNamedImport(source: string, modulePath: string): string {
	const escapedModulePath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = source.match(
		new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escapedModulePath}["'];`),
	);
	return match?.[1] ?? "";
}

describe("Codex K12 shared tier metadata integration", () => {
	test("trend chart uses shared tier strokes and labels without local duplicates", async () => {
		const source = await readSource("frontend/components/providers/CodexQuotaTrendChart.tsx");
		const sharedImport = getNamedImport(source, "../../lib/codex-tiers");

		expect(sharedImport).toContain("CODEX_TIER_STROKES");
		expect(sharedImport).toContain("getCodexTierLabel");
		expect(source).not.toMatch(/(?:export\s+)?const CODEX_TIER_COLORS\b/);
		expect(source).not.toMatch(/(?:export\s+)?const CODEX_TIER_STROKES\b/);
		expect(source).not.toMatch(/(?:export\s+)?function getCodexTierLabel\b/);
	});

	test("CodexSection consumes all shared tier display metadata and helpers", async () => {
		const source = await readSource("frontend/components/providers/CodexSection.tsx");
		const sharedImport = getNamedImport(source, "../../lib/codex-tiers");

		for (const importedName of [
			"CODEX_DEFAULT_TIER_ORDER",
			"CODEX_TIER_COLORS",
			"getCodexDisplayTierOrder",
			"getCodexTierLabel",
		]) {
			expect(sharedImport).toContain(importedName);
		}

		expect(source).not.toMatch(/const CODEX_DISPLAY_TIERS\b/);
		expect(source).not.toMatch(/const CODEX_TIER_ORDER_VALUES\b/);
		expect(source).not.toMatch(/const CODEX_DEFAULT_TIER_ORDER\b/);
		expect(source).not.toMatch(/const CODEX_TIER_COLORS\b/);
		expect(source).not.toMatch(/function getCodexTierLabel\b/);
		expect(source).not.toMatch(/function getDisplayTierOrder\b/);
	});

	test("Settings quota overview follows tier order and refreshes the public overview", async () => {
		const sectionSource = await readSource("frontend/components/providers/CodexSection.tsx");
		const overviewSource = await readSource("frontend/components/providers/CodexQuotaOverview.tsx");

		expect(sectionSource).toContain("tierOrder={tierOrder}");
		expect(overviewSource).toMatch(/getCodexDisplayTierOrder\(tierOrder\)/);
		expect(sectionSource).toContain(
			'qc.invalidateQueries({ queryKey: ["codex", "quota-overview"] });',
		);
	});

	test("Settings syncs changed status tier order without resetting optimistic drag state", async () => {
		const source = await readSource("frontend/components/providers/CodexSection.tsx");

		expect(source).toContain("const lastSyncedTierOrderRef = useRef<string | null>(null);");
		expect(source).toContain("const statusTierOrder = status ? status.tierOrder : null;");
		expect(source).toMatch(
			/useEffect\(\(\) => \{\s*if \(statusTierOrder === null\) return;\s*const nextTierOrder = getCodexDisplayTierOrder\(statusTierOrder\);\s*const nextTierOrderKey = nextTierOrder\.join\(","\);/,
		);
		expect(source).toContain("if (lastSyncedTierOrderRef.current === nextTierOrderKey) return;");
		expect(source).toMatch(
			/setTierOrder\(\(currentTierOrder\) =>\s*currentTierOrder\.join\(","\) === nextTierOrderKey\s*\? currentTierOrder\s*: nextTierOrder/,
		);
		expect(source).toContain("}, [statusTierOrder]);");
		expect(source).not.toContain("tierOrderInitialized");
	});

	test("UsageDisplay normalizes plan types, localizes labels, and preserves unknown names", async () => {
		const source = await readSource("frontend/components/providers/CodexUsageDisplay.tsx");

		expect(source).toMatch(
			/const\s+\w*[Tt]ier\w*\s*=\s*normalizeCodexPlanTier\(usage\.plan_type\);/,
		);
		expect(source).toMatch(/color=\{CODEX_TIER_COLORS\[\w*[Tt]ier\w*\]\}/);
		expect(source).toContain("getCodexPlanTypeLabel(t, usage.plan_type)");
		expect(source).not.toMatch(/\{\s*usage\.plan_type\s*\}/);
	});

	test("narrator quota indicator imports shared metadata separately from chart helpers", async () => {
		const source = await readSource("frontend/components/narrator/model/CodexQuotaIndicator.tsx");
		const sharedImport = getNamedImport(source, "../../../lib/codex-tiers");
		const chartImport = getNamedImport(source, "../../providers/CodexQuotaTrendChart");

		expect(sharedImport).toContain("CODEX_TIER_STROKES");
		expect(sharedImport).toContain("getCodexTierLabel");
		expect(chartImport).toContain("CodexQuotaTrendChart");
		expect(chartImport).toContain("formatAccountEquivalent");
		expect(chartImport).toContain("formatResetTimestamp");
		expect(chartImport).not.toContain("CODEX_TIER_STROKES");
		expect(chartImport).not.toContain("getCodexTierLabel");
	});
});
