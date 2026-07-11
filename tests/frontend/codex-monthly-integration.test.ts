import { describe, expect, test } from "bun:test";

async function readSource(relativePath: string): Promise<string> {
	return Bun.file(new URL(`../../${relativePath}`, import.meta.url)).text();
}

describe("Codex monthly frontend integration contract", () => {
	test("uses one additive usage and coverage type contract", async () => {
		const types = await readSource("frontend/lib/api/types.ts");
		const misc = await readSource("frontend/lib/api/misc.ts");

		expect(types).toContain(
			'export type CodexUsageWindowType = "5h" | "weekly" | "monthly" | "unknown";',
		);
		expect(types).toMatch(/limit_window_seconds\?: number;/);
		for (const field of [
			"modeledUsageCount?",
			"unmodeledUsageCount?",
			"totalModeledUsageAccounts?",
			"totalUnmodeledUsageAccounts?",
			"trackedAccountCount?",
			"modeledAccountCount?",
			"unmodeledAccountCount?",
		]) {
			expect(types).toContain(field);
		}
		expect(misc).toContain("request<CodexUsageData>");
		expect(misc).not.toMatch(/codexCredentialGetUsage:[\s\S]*?primary_window\?:\s*\{/);
	});

	test("CodexSection consumes extracted shared display components", async () => {
		const source = await readSource("frontend/components/providers/CodexSection.tsx");
		expect(source).toContain('import { CodexQuotaOverview } from "./CodexQuotaOverview";');
		expect(source).toContain('import { CodexUsageDisplay } from "./CodexUsageDisplay";');
		expect(source).not.toContain("function CodexQuotaOverview(");
		expect(source).not.toContain("function UsageDisplay(");
		expect(source).toContain("<CodexUsageDisplay usage={usage} />");
	});

	test("coverage fields stay optional for old backend compatibility", async () => {
		const types = await readSource("frontend/lib/api/types.ts");
		for (const field of [
			"modeledUsageCount",
			"unmodeledUsageCount",
			"totalModeledUsageAccounts",
			"totalUnmodeledUsageAccounts",
			"trackedAccountCount",
			"modeledAccountCount",
			"unmodeledAccountCount",
		]) {
			expect(types).toMatch(new RegExp(`${field}\\?: number;`));
		}
	});
});
