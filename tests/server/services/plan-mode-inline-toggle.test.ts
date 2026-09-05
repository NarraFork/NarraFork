import { describe, expect, it } from "bun:test";
import { ensureNonEmptySchema } from "../../../server/lib/agent/tool-registry";
import { exitPlanModeTool } from "../../../server/lib/agent/tools/plan-mode";
import type { AgentConfig } from "../../../server/lib/agent/types";
import {
	getPlanModeSystemReminder,
	getToolMessageWithParams,
} from "../../../server/lib/prompt-i18n";

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
	it("offers both modes and the inline plan param when inline is allowed", () => {
		const config = makeConfig(true);
		const schema = exitPlanModeTool.getRawJsonSchema?.(config) as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		// Model-facing param is `inline_plan`; the ambiguous `plan` name is never exposed.
		expect(schema.properties.inline_plan).toBeDefined();
		expect(schema.properties.plan).toBeUndefined();
		// Retired: advertising it made models fabricate permission declarations.
		expect(schema.properties.allowedPrompts).toBeUndefined();
		// `mode` is the tool's one real required parameter.
		expect(schema.required).toEqual(["mode"]);
		expect((schema.properties.mode as { enum?: string[] }).enum).toEqual(["inline", "file"]);

		const desc = resolveDescription(config);
		expect(desc).toContain('`mode: "inline"`');
		expect(desc).toContain('`mode: "file"`');
		expect(desc).toContain("`inline_plan` parameter");
	});

	it("drops the inline plan param and narrows mode when inline is disabled", () => {
		const config = makeConfig(false);
		const schema = exitPlanModeTool.getRawJsonSchema?.(config) as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		expect(schema.properties.inline_plan).toBeUndefined();
		expect(schema.properties.plan).toBeUndefined();
		expect(schema.properties.allowedPrompts).toBeUndefined();
		expect(schema.required).toEqual(["mode"]);
		// A mode the resolution layer would always reject is not advertised.
		expect((schema.properties.mode as { enum?: string[] }).enum).toEqual(["file"]);

		const desc = resolveDescription(config);
		expect(desc).not.toContain('`mode: "inline"`');
		expect(desc).toContain("only the file-based plan flow is supported");
	});

	it("keeps mode required but never lets it be promoted away by NUG padding", () => {
		// `ensureNonEmptySchema` only injects its dummy when nothing is required;
		// a real `mode` means ExitPlanMode no longer needs that crutch.
		const schema = exitPlanModeTool.getRawJsonSchema?.(makeConfig(true)) as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		const padded = ensureNonEmptySchema(schema as unknown as Record<string, unknown>);
		expect(padded.required).toEqual(["mode"]);
		expect((padded.properties as Record<string, unknown>).confirm).toBeUndefined();
	});

	it("treats undefined inline setting as allowed (backward compatible)", () => {
		const config = makeConfig(undefined);
		const schema = exitPlanModeTool.getRawJsonSchema?.(config) as {
			properties: Record<string, unknown>;
		};
		expect(schema.properties.inline_plan).toBeDefined();
		// Static fallback schema also keeps the inline param.
		const fallback = exitPlanModeTool.rawJsonSchema as {
			properties: Record<string, unknown>;
		};
		expect(fallback.properties.inline_plan).toBeDefined();
	});
});

describe("getPlanModeSystemReminder inline-plan toggle", () => {
	it("renders the two-mode submission section when inline is allowed", () => {
		const en = getPlanModeSystemReminder("en", "abc", true);
		expect(en).toContain('`mode: "inline"`');
		expect(en).toContain('`mode: "file"`');
		// The reminder must state that a declared inline plan is not a file fallback.
		expect(en).toContain("will NOT fall back to reading the plan file");

		const zh = getPlanModeSystemReminder("zh-CN", "abc", true);
		expect(zh).toContain('`mode: "inline"`');
		expect(zh).toContain("不会回退去读计划文件");
	});

	it("renders only the file-based section when inline is disabled", () => {
		// The reminder is handed the resolved plan path, not a plan identity.
		const en = getPlanModeSystemReminder("en", ".narrafork/plans/plan-abc.md", false);
		expect(en).not.toContain('`mode: "inline"`');
		expect(en).toContain("File-based only");
		expect(en).toContain(".narrafork/plans/plan-abc.md");

		const zh = getPlanModeSystemReminder("zh-CN", "abc", false);
		expect(zh).not.toContain('`mode: "inline"`');
		expect(zh).toContain("仅支持文件模式");
	});

	it("announces the inline refusal once the plan file already holds content", () => {
		// The resolution layer refuses inline submission in this state. The model has
		// to learn that from the prompt, not from a rejected tool call.
		const en = getPlanModeSystemReminder("en", "abc", true, 1234);
		expect(en).toContain("1234 bytes");
		expect(en).toContain('`mode: "inline"` is refused');
		expect(en).toContain('only `mode: "file"` is accepted');

		const zh = getPlanModeSystemReminder("zh-CN", "abc", true, 1234);
		expect(zh).toContain("1234 字节");
		expect(zh).toContain('`mode: "inline"` 会被拒绝');

		// A fresh plan cycle must not carry the narrowing.
		const fresh = getPlanModeSystemReminder("en", "abc", true);
		expect(fresh).not.toContain('`mode: "inline"` is refused');
	});
});

/**
 * Every model-facing correction has to name a route that is actually open.
 *
 * These messages predate the required `mode` parameter and used to say "call
 * ExitPlanMode WITHOUT the 'inline_plan' parameter". Under a verified `mode` that
 * instruction is a dead end, and for a declared `file` plan it is worse than
 * useless: inline fallback is refused there, so following it loops.
 */
describe("ExitPlanMode correction messages name a live route", () => {
	const KEYS = [
		"exitPlanModeEmptyPlan",
		"exitPlanModeEmptyPlanFallback",
		"exitPlanModePathReference",
		"exitPlanModeDeniedFile",
		"exitPlanModeDeniedFileWithMessage",
		"exitPlanModeInlineWithExistingPlanFile",
		"exitPlanModeInlineModeDisabled",
		"exitPlanModeInlineWithoutBody",
	] as const;

	it("tells the model which mode to declare, never to omit a parameter", () => {
		for (const key of KEYS) {
			for (const locale of ["en", "zh-CN"] as const) {
				const message = getToolMessageWithParams(key, locale, {
					planFile: ".narrafork/plan-abc.md",
					maxBytes: 1000,
					bytes: 42,
					message: "feedback",
				});
				expect(message).toContain("mode=");
				// The retired "just leave the parameter out" instruction.
				expect(message).not.toContain("WITHOUT the 'inline_plan'");
				expect(message).not.toContain("without the 'inline_plan'");
				expect(message).not.toContain("不传 'inline_plan'");
				expect(message).not.toContain("不带 'inline_plan'");
			}
		}
	});
});
