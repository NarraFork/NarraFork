import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FOLLOW_DEFAULT_MODEL } from "./constants";
import { followDefaultLabel, followOptionLabel } from "./follow-model-label";

const t = (key: string, options?: Record<string, unknown>) =>
	options?.model !== undefined ? `${key}(${options.model})` : key;

describe("follow-model labels", () => {
	test("an option names its target, else the target value, else the unset text", () => {
		expect(followOptionLabel("GPT Astra", "openai:astra", "unset")).toBe("GPT Astra");
		expect(followOptionLabel("", "openai:astra", "unset")).toBe("openai:astra");
		expect(followOptionLabel(undefined, "", "Default model (not configured)")).toBe(
			"Default model (not configured)",
		);
		expect(followOptionLabel(undefined, "  ", "unset")).toBe("unset");
	});

	test("no configured default never shows the sentinel or an empty interpolation", () => {
		expect(followDefaultLabel(t, "openai:astra")).toBe("followDefault(openai:astra)");
		for (const empty of ["", "   ", null, undefined]) {
			const label = followDefaultLabel(t, empty);
			expect(label).toBe("followDefaultUnset");
			expect(label).not.toContain(FOLLOW_DEFAULT_MODEL);
		}
	});

	test("both namespaces that render the label translate it in both locales", () => {
		for (const locale of ["en", "zh-CN"])
			for (const namespace of ["narrator", "narrators"]) {
				const resources = JSON.parse(
					readFileSync(new URL(`../locales/${locale}/${namespace}.json`, import.meta.url), "utf8"),
				) as Record<string, unknown>;
				expect(resources.followDefault).toBeString();
				expect(resources.followDefaultUnset).toBeString();
				expect(resources.followDefaultUnset).not.toContain("__");
				if (namespace === "narrator") {
					expect(resources.followSummaryUnset).toBeString();
					expect(resources.modelGroupDefault).toBeString();
					expect(resources.modelGroupSummary).toBeString();
				}
			}
	});

	test("the model hook passes the unset texts instead of falling back to the sentinel", () => {
		const hook = readFileSync(new URL("../hooks/useModels.ts", import.meta.url), "utf8");
		expect(hook).toContain('t("followDefaultUnset")');
		expect(hook).toContain('t("followSummaryUnset")');
		expect(hook).not.toMatch(/label: target\?\.label \|\| targetValue \|\| value/);
	});
});
