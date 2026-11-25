import { afterEach, expect, mock, test } from "bun:test";
import type { RecallMessagePage } from "../../../recall-contract";
import type { AgentConfig, AgentToolUse, ToolCallBinding, ToolResult } from "../../types";

let messagePage: RecallMessagePage | null = null;
let toolPage: ToolResult | null = null;
mock.module("../../../../services/search/recall-store", () => ({
	recallConversation: async () => {
		throw new Error("not used");
	},
	recallMessage: async () => messagePage,
	recallToolCallPage: async () => toolPage,
}));
const { recallTool } = await import("../recall");
const { executeTool } = await import("../../tool-executor");
const { toolRegistry } = await import("../../tool-registry");
const original = toolRegistry.get("Recall");
afterEach(() => {
	toolRegistry.unregister("Recall");
	if (original) toolRegistry.register(original);
});

function config(): AgentConfig {
	return {
		narratorId: "recall-output-self",
		conversationId: "recall-output-test",
		model: "test",
		provider: "test",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		requireToolCallBinding: true,
		toolExecutionBindings: new (class extends WeakMap<AgentToolUse, ToolCallBinding> {
			override get(tool: AgentToolUse): ToolCallBinding {
				return super.get(tool) ?? { toolCallId: `test-${tool.toolUseId}`, attempt: 1 };
			}
		})(),
		onToolExecutionStarting: async (_id, binding) => binding,
		onToolExecutionFinalAuthorization: async () => ({ assertStillCurrent() {} }),
		recordToolNoDispatch: async () => {},
	};
}
function body(text: string, hasMore: boolean): RecallMessagePage {
	return {
		messageId: "message",
		narratorId: "recall-output-self",
		narratorTitle: "Source",
		seq: 1,
		role: "user",
		origin: "user",
		originLabel: null,
		createdAt: "2026-01-01",
		bodyRevision: 1,
		text,
		offset: 0,
		totalChars: [...text].length + (hasMore ? 1 : 0),
		hasMore,
		nextOffset: hasMore ? [...text].length : null,
	};
}

for (const [name, text, hasMore] of [
	["many-line first page", `start\n${"\n".repeat(7994)}`, true],
	["many-line final page", `start\n${"\n".repeat(7994)}`, false],
	["large UTF-8 complete page", "\u{1F600}".repeat(20000), false],
] as const) {
	test(`executor delivers the exact bounded ${name}, not only its tail`, async () => {
		toolRegistry.register(recallTool);
		messagePage = body(text, hasMore);
		const input = { action: "read_message", message_id: "message", max_chars: 20000 };
		const expected = await recallTool.execute(input, {
			narratorId: "recall-output-self",
			signal: new AbortController().signal,
		} as never);
		expect(expected.truncated).toBe(true);
		const actual = await executeTool(
			{ toolUseId: `recall-${name}`, name: "Recall", input },
			config(),
		);
		expect(actual.isError).not.toBe(true);
		expect(actual.output).toBe(expected.output);
		expect(actual.output).toContain("--- Stored message text ---");
		expect(actual.output).not.toContain("OUTPUT TRUNCATED");
	});
}

test("executor also preserves a complete/last tool-field page exceeding its generic line budget", async () => {
	toolRegistry.register(recallTool);
	toolPage = {
		output: `begin tool field\n${"\n".repeat(8000)}`,
		truncated: false,
		metadata: {
			narratorId: "recall-output-self",
			pages: { output: { hasMore: false, nextOffset: null } },
		},
	};
	const input = { action: "read_tool_call", tool_call_id: "use", part: "output", max_chars: 20000 };
	const expected = await recallTool.execute(input, {
		narratorId: "recall-output-self",
		signal: new AbortController().signal,
	} as never);
	const actual = await executeTool(
		{ toolUseId: "recall-last-tool-page", name: "Recall", input },
		config(),
	);
	expect(actual.isError).not.toBe(true);
	expect(actual.output).toBe(expected.output);
	expect(actual.output).toContain("begin tool field");
});

test("own output budget fails explicitly rather than disabling every truncation bound", async () => {
	toolPage = { output: "x".repeat(512 * 1024 + 1) };
	const result = await recallTool.execute({ action: "read_tool_call", tool_call_id: "use" }, {
		narratorId: "recall-output-self",
		signal: new AbortController().signal,
	} as never);
	expect(result.isError).toBe(true);
	expect(result.output).toContain("No partial page was returned");
});
