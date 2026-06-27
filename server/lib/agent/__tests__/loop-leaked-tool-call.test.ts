import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent } from "../types";

// The provider emits a COMPLETE leaked <invoke> block as plain text, simulating the
// case where the streaming accumulator failed to lift it out of the text deltas.
// The loop's stateless safety net must recover it into an executable tool call.
let scenario: "leaked_block" | "no_leak" | "unrecovered" | "stream_captured" = "leaked_block";

const LEAKED = [
	"先检查一下目录。",
	"",
	"call",
	'<invoke name="Bash">',
	'<parameter name="command">echo hi</parameter>',
	"</invoke>",
].join("\n");

// An <invoke> opening with no closing tag — cannot be parsed into a tool call.
const UNRECOVERED = '准备执行。\n\n<invoke name="Bash"><parameter name="command">echo hi';

const testProvider: ProviderAdapter = {
	mayLeakXmlToolCalls: true,
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		// has raw data to force-persist.
		params.requestDump?.setRequest({ transport: "test", body: { hello: "world" } });
		params.requestDump?.setResponseBodyText('data: {"content":"..."}\n\n');
		if (scenario === "leaked_block") {
			// Emit the whole block as a single plain-text event (no toolUses lifted).
			yield { text: LEAKED };
			return;
		}
		if (scenario === "unrecovered") {
			yield { text: UNRECOVERED };
			return;
		}
		if (scenario === "stream_captured") {
			// Simulate the streaming accumulator successfully lifting an XML tool call:
			yield {
				text: "好的。",
			};
			return;
		}
		yield { text: "plain answer, no tools" };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

mock.module("../provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: testProvider,
		model: "test:model",
	}),
}));

const { agentLoop } = await import("../loop");

afterAll(() => {
	mock.restore();
});

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-leak",
		conversationId: "conv-leak",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		retryBackoffCeilMs: 1,
		maxTurns: 1,
		...overrides,
	};
}

describe("agentLoop leaked XML tool-call safety net", () => {
	test("recovers a complete <invoke> block left in assistant text", async () => {
		scenario = "leaked_block";
		const ac = new AbortController();
		const events: AgentEvent[] = [];
		for await (const event of agentLoop(makeConfig(ac.signal), "go", [])) {
			events.push(event);
			// Stop after the first assistant_message so the 1-turn loop doesn't spin
			// waiting for a follow-up turn after tool execution.
			if (event.type === "assistant_message") break;
		}

		const assistantMsg = events.find((e) => e.type === "assistant_message") as
			| {
					type: "assistant_message";
					text: string;
					toolUses: Array<{ name: string; input: Record<string, unknown> }>;
			  }
			| undefined;
		expect(assistantMsg).toBeDefined();
		// The leaked block was lifted out of the text.
		expect(assistantMsg?.text.includes("<invoke")).toBe(false);
		expect(assistantMsg?.text).toBe("先检查一下目录。\n\n");
		// The tool call was recovered.
		expect(assistantMsg?.toolUses.map((t) => t.name)).toEqual(["Bash"]);
		expect(assistantMsg?.toolUses[0].input).toEqual({ command: "echo hi" });
		// The frontend was told to discard the raw streamed text.
		expect(events.some((e) => e.type === "stream_reset")).toBe(true);

		// A `recovered` diagnostic was emitted carrying the loop requestId.
		const recovered = events.find(
			(e) => e.type === "leaked_tool_call" && e.phase === "recovered",
		) as { type: "leaked_tool_call"; phase: string; requestId: string } | undefined;
		expect(recovered).toBeDefined();
		expect(typeof recovered?.requestId).toBe("string");

		// The api_request_end forces the raw dump to persist, and a real dump exists.
		const apiEnd = events.find((e) => e.type === "api_request_end") as
			| { type: "api_request_end"; forceDumpPersist?: boolean; rawDump?: unknown }
			| undefined;
		expect(apiEnd?.forceDumpPersist).toBe(true);
		// The collector was created (provider may leak) and captured the request, so the
		// dump is non-null — this is what makes the download endpoint work.
		expect(apiEnd?.rawDump).toBeTruthy();
		expect((apiEnd?.rawDump as { request?: unknown }).request).toBeTruthy();
	});

	test("flags unrecovered leaked <invoke> text and force-persists the dump", async () => {
		scenario = "unrecovered";
		const ac = new AbortController();
		const events: AgentEvent[] = [];
		for await (const event of agentLoop(makeConfig(ac.signal), "go", [])) {
			events.push(event);
			if (event.type === "assistant_message") break;
		}

		const unrecovered = events.find(
			(e) => e.type === "leaked_tool_call" && e.phase === "unrecovered",
		) as { type: "leaked_tool_call"; phase: string; snippet?: string } | undefined;
		expect(unrecovered).toBeDefined();
		expect(unrecovered?.snippet?.includes("<invoke")).toBe(true);

		const apiEnd = events.find((e) => e.type === "api_request_end") as
			| { type: "api_request_end"; forceDumpPersist?: boolean }
			| undefined;
		expect(apiEnd?.forceDumpPersist).toBe(true);

		// No tool was recovered, so the leaked text remains as the assistant message.
		const assistantMsg = events.find((e) => e.type === "assistant_message") as
			| { type: "assistant_message"; toolUses: unknown[] }
			| undefined;
		expect(assistantMsg?.toolUses).toHaveLength(0);
	});

	test("emits stream_captured for XML tool calls lifted during streaming", async () => {
		scenario = "stream_captured";
		const ac = new AbortController();
		const events: AgentEvent[] = [];
		for await (const event of agentLoop(makeConfig(ac.signal), "go", [])) {
			events.push(event);
			if (event.type === "assistant_message") break;
		}

		const captured = events.find(
			(e) => e.type === "leaked_tool_call" && e.phase === "stream_captured",
		) as { type: "leaked_tool_call"; phase: string; toolUseIds?: string[] } | undefined;
		expect(captured).toBeDefined();

		// A stream-captured tool call is not a failure → dump is NOT force-persisted.
		const apiEnd = events.find((e) => e.type === "api_request_end") as
			| { type: "api_request_end"; forceDumpPersist?: boolean }
			| undefined;
		expect(apiEnd?.forceDumpPersist).toBeFalsy();
	});

	test("does not fire for plain text without leaked blocks", async () => {
		scenario = "no_leak";
		const ac = new AbortController();
		const events: AgentEvent[] = [];
		for await (const event of agentLoop(makeConfig(ac.signal), "go", [])) {
			events.push(event);
			if (event.type === "assistant_message") break;
		}
		const assistantMsg = events.find((e) => e.type === "assistant_message") as
			| { type: "assistant_message"; text: string; toolUses: unknown[] }
			| undefined;
		expect(assistantMsg?.text).toBe("plain answer, no tools");
		expect(assistantMsg?.toolUses).toHaveLength(0);
		expect(events.some((e) => e.type === "stream_reset")).toBe(false);
	});
});
