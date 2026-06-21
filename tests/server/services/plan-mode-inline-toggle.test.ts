import { describe, expect, it } from "bun:test";
import { exitPlanModeTool } from "../../../server/lib/agent/tools/plan-mode";
import type { AgentConfig } from "../../../server/lib/agent/types";
import { getPlanModeSystemReminder } from "../../../server/lib/prompt-i18n";

function makeConfig(planAllowInlinePlan?: boolean): AgentConfig {
	return {
		narratorId: "n1",
		conversationId: "c1",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal: new AbortController().signal,
		planAllowInlinePlan,
		permissionHandler: async () => ({ behavior: "allow" }),
	} as AgentConfig;
}

function resolveDescription(config: AgentConfig): string {
	const { description } = exitPlanModeTool;
	return typeof description === "function" ? description(config) : description;
}

describe("ExitPlanMode inline-plan toggle", () => {
	it("includes the inline plan param and Mode A when inline is allowed", () => {
		const config = makeConfig(true);
		const schema = exitPlanModeTool.getRawJsonSchema?.(config) as {
			properties: Record<string, unknown>;
		};
		expect(schema.properties.plan).toBeDefined();
		expect(schema.properties.allowedPrompts).toBeDefined();

		const desc = resolveDescription(config);
		expect(desc).toContain("Mode A");
		expect(desc).toContain("`plan` parameter");
	});

	it("drops the inline plan param and Mode A when inline is disabled", () => {
		const config = makeConfig(false);
		const schema = exitPlanModeTool.getRawJsonSchema?.(config) as {
			properties: Record<string, unknown>;
		};
		expect(schema.properties.plan).toBeUndefined();
		expect(schema.properties.allowedPrompts).toBeDefined();

		const desc = resolveDescription(config);
		expect(desc).not.toContain("Mode A");
		expect(desc).toContain("only the file-based plan flow is supported");
	});

	it("treats undefined inline setting as allowed (backward compatible)", () => {
		const config = makeConfig(undefined);
		const schema = exitPlanModeTool.getRawJsonSchema?.(config) as {
			properties: Record<string, unknown>;
		};
		expect(schema.properties.plan).toBeDefined();
		// Static fallback schema also keeps the inline param.
		const fallback = exitPlanModeTool.rawJsonSchema as {
			properties: Record<string, unknown>;
		};
		expect(fallback.properties.plan).toBeDefined();
	});
});

describe("getPlanModeSystemReminder inline-plan toggle", () => {
	it("renders the two-mode submission section when inline is allowed", () => {
		const en = getPlanModeSystemReminder("en", "abc", true);
		expect(en).toContain("Mode A: Inline");
		expect(en).toContain("Mode B: File-based");

		const zh = getPlanModeSystemReminder("zh-CN", "abc", true);
		expect(zh).toContain("模式 A：内联");
	});

	it("renders only the file-based section when inline is disabled", () => {
		const en = getPlanModeSystemReminder("en", "abc", false);
		expect(en).not.toContain("Mode A: Inline");
		expect(en).toContain("File-based only");
		expect(en).toContain(".narrafork/plan-abc.md");

		const zh = getPlanModeSystemReminder("zh-CN", "abc", false);
		expect(zh).not.toContain("模式 A：内联");
		expect(zh).toContain("仅支持文件模式");
	});
});
