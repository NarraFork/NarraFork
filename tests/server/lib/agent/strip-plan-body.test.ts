import { describe, expect, it } from "bun:test";
import { z } from "zod/v4";
import type { DbMessage } from "../../../../server/lib/agent/provider";
import { stripPlanBodyForModel } from "../../../../server/lib/agent/strip-plan-body";

// Mirror of ExitPlanMode's Zod schema (server/lib/agent/tools/plan-mode.ts).
// Reconstructed locally so this test stays free of the DB-loading import chain
// (plan-mode → prompt-i18n → i18n → db). The point of the assertion below is to
// verify Zod's default object behavior (strip unknown keys), which is identical
// for the real schema; if the real schema's shape changes, keep this in sync.
const exitPlanModeSchema = z.object({
	plan: z.string().optional(),
	allowedPrompts: z.array(z.object({ tool: z.string(), prompt: z.string() })).optional(),
});

const PLAN_FILE = ".narrafork/plan-abc123.md";
const PLAN_BODY = "## Step 1\n\nDo the thing.\n\n## Step 2\n\nDo the other thing.";

function makeExitPlanMessage(
	input: Record<string, unknown>,
	opts: { withContentBlock?: boolean } = {},
): DbMessage {
	const toolUseId = "tu-exit-plan";
	return {
		id: "msg-1",
		role: "assistant",
		contentText: null,
		parentToolUseId: null,
		messageUuid: null,
		contentJson: opts.withContentBlock
			? [
					{ type: "text", text: "Here is the plan." },
					{ type: "tool_use", id: toolUseId, name: "ExitPlanMode", input },
				]
			: [],
		toolCalls: [
			{
				toolUseId,
				toolName: "ExitPlanMode",
				inputJson: input,
				outputJson: null,
				status: "success",
			},
		],
	};
}

describe("stripPlanBodyForModel", () => {
	it("replaces a file-based plan body with a path reference", () => {
		const msg = makeExitPlanMessage(
			{ plan: PLAN_BODY, _planFile: PLAN_FILE },
			{ withContentBlock: true },
		);
		stripPlanBodyForModel([msg]);

		const tc = msg.toolCalls?.[0];
		const tcInput = tc?.inputJson as Record<string, unknown>;
		// Full plan body is gone; a short reference mentioning the path takes its place.
		expect(tcInput.plan).not.toContain("Do the thing");
		expect(String(tcInput.plan)).toContain(PLAN_FILE);
		// Provenance marker is preserved.
		expect(tcInput._planFile).toBe(PLAN_FILE);

		// contentJson block.input is rewritten too (OpenAI Responses fallback safety).
		const blocks = msg.contentJson as Array<Record<string, unknown>>;
		const toolBlock = blocks.find((b) => b.type === "tool_use");
		const blockInput = toolBlock?.input as Record<string, unknown>;
		expect(String(blockInput.plan)).toContain(PLAN_FILE);
		expect(String(blockInput.plan)).not.toContain("Do the thing");
		expect(blockInput._planFile).toBe(PLAN_FILE);
	});

	it("leaves inline plans (no _planFile) untouched", () => {
		const msg = makeExitPlanMessage({ plan: PLAN_BODY }, { withContentBlock: true });
		stripPlanBodyForModel([msg]);

		const tcInput = msg.toolCalls?.[0]?.inputJson as Record<string, unknown>;
		expect(tcInput.plan).toBe(PLAN_BODY);

		const blocks = msg.contentJson as Array<Record<string, unknown>>;
		const toolBlock = blocks.find((b) => b.type === "tool_use");
		expect((toolBlock?.input as Record<string, unknown>).plan).toBe(PLAN_BODY);
	});

	it("does not touch non-ExitPlanMode tool calls", () => {
		const msg: DbMessage = {
			id: "msg-2",
			role: "assistant",
			contentText: null,
			parentToolUseId: null,
			messageUuid: null,
			contentJson: [],
			toolCalls: [
				{
					toolUseId: "tu-read",
					toolName: "Read",
					inputJson: { file_path: "/foo", _planFile: PLAN_FILE, plan: PLAN_BODY },
					outputJson: null,
					status: "success",
				},
			],
		};
		stripPlanBodyForModel([msg]);
		const tcInput = msg.toolCalls?.[0]?.inputJson as Record<string, unknown>;
		expect(tcInput.plan).toBe(PLAN_BODY);
	});

	it("ignores file-based marker without a usable plan body", () => {
		const msg = makeExitPlanMessage({ plan: "   ", _planFile: PLAN_FILE });
		stripPlanBodyForModel([msg]);
		const tcInput = msg.toolCalls?.[0]?.inputJson as Record<string, unknown>;
		// Nothing meaningful to strip; left as-is.
		expect(tcInput.plan).toBe("   ");
	});

	it("rewrites tool call input even when contentJson has no tool_use block", () => {
		const msg = makeExitPlanMessage({ plan: PLAN_BODY, _planFile: PLAN_FILE });
		stripPlanBodyForModel([msg]);
		const tcInput = msg.toolCalls?.[0]?.inputJson as Record<string, unknown>;
		expect(String(tcInput.plan)).toContain(PLAN_FILE);
	});
});

describe("ExitPlanMode schema accepts the _planFile marker", () => {
	it("strips the unknown _planFile key without failing validation", () => {
		// Mirrors the tool-executor safeParse path: a file-based effectiveInput carries
		// `_planFile`, which must not cause an "Invalid parameters" failure.
		const result = exitPlanModeSchema.safeParse({
			plan: PLAN_BODY,
			_planFile: PLAN_FILE,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			// Default Zod object strips unknown keys.
			expect("_planFile" in result.data).toBe(false);
			expect(result.data.plan).toBe(PLAN_BODY);
		}
	});
});
