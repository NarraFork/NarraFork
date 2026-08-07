import { describe, expect, test } from "bun:test";
import {
	appendCurrentTurn,
	convertHistory,
	convertTools,
	flattenToolResultContent,
	type OpenAiMessage,
	withSystemPrompt,
} from "../../../../examples/plugins/cline-external/src/history";

/**
 * Canonical host history → OpenAI messages.
 *
 * This is the translation the plugin exists to perform, and the one place where reusing the
 * built-in adapter was impossible: the built-in consumes database rows, a plugin receives the
 * host's normalised `ProviderMessage[]`. Every fixture here is shaped the way
 * `remote-provider-adapter.ts` actually emits it, so a change in the host's normalisation
 * shows up as a failure here rather than as a malformed upstream request.
 */

/** A canonical message, in the shape `RemoteProviderAdapter.buildHistory` produces. */
function message(role: string, content: unknown[]): Record<string, unknown> {
	return { role, content };
}

describe("cline-external history: text and roles", () => {
	test("system, user and assistant text become plain string content", () => {
		const messages = convertHistory([
			message("system", [{ type: "text", text: "You are helpful." }]),
			message("user", [{ type: "text", text: "hi" }]),
			message("assistant", [{ type: "text", text: "hello" }]),
		]);
		expect(messages).toEqual([
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
	});

	test("multiple text blocks in one message are joined, not emitted separately", () => {
		// The host can split one logical message across blocks (an interrupted stream, a
		// reasoning block between two text runs). Emitting one OpenAI message per block would
		// change the conversation's turn structure.
		const messages = convertHistory([
			message("user", [
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			]),
		]);
		expect(messages).toEqual([{ role: "user", content: "first\nsecond" }]);
	});

	test("an unknown role is dropped rather than forwarded", () => {
		// `canonicalRole` maps everything to four roles, so anything else means the payload was
		// not produced by the host. Sending it upstream would be rejected for the whole request.
		expect(convertHistory([message("moderator", [{ type: "text", text: "x" }])])).toEqual([]);
	});

	test("a message with no usable content produces nothing", () => {
		expect(convertHistory([message("user", []), message("system", [])])).toEqual([]);
	});
});

describe("cline-external history: reasoning is dropped", () => {
	test("reasoning and redacted_reasoning never reach the request", () => {
		// Parity with the built-in adapter, whose `_reasoningBlocks` parameter is unused. Also
		// why the manifest declares `reasoningContinuation: false`.
		const messages = convertHistory([
			message("assistant", [
				{ type: "reasoning", text: "thinking out loud" },
				{ type: "redacted_reasoning", data: "encrypted" },
				{ type: "text", text: "the answer" },
			]),
		]);
		expect(messages).toEqual([{ role: "assistant", content: "the answer" }]);
		expect(JSON.stringify(messages)).not.toContain("thinking out loud");
		expect(JSON.stringify(messages)).not.toContain("encrypted");
	});

	test("an assistant message that was only reasoning is skipped entirely", () => {
		// Not merely emptied: upstream rejects an assistant message with neither content nor
		// tool calls, so emitting `{role:"assistant", content:""}` would fail the turn.
		expect(
			convertHistory([message("assistant", [{ type: "reasoning", text: "just thinking" }])]),
		).toEqual([]);
	});
});

describe("cline-external history: tool calls and results", () => {
	test("a tool call becomes tool_calls with JSON-stringified arguments", () => {
		const messages = convertHistory([
			message("assistant", [
				{ type: "text", text: "checking" },
				{ type: "tool_call", toolUseId: "call-1", name: "Read", input: { path: "a.ts" } },
			]),
		]);
		expect(messages).toEqual([
			{
				role: "assistant",
				content: "checking",
				tool_calls: [
					{
						id: "call-1",
						type: "function",
						function: { name: "Read", arguments: '{"path":"a.ts"}' },
					},
				],
			},
		]);
	});

	test("a tool call with no input still sends an object, never undefined", () => {
		// `arguments` is parsed by upstream; `undefined` or a bare value is rejected.
		const messages = convertHistory([
			message("assistant", [{ type: "tool_call", toolUseId: "c", name: "Now" }]),
		]);
		expect((messages[0].tool_calls ?? [])[0].function.arguments).toBe("{}");
	});

	test("an assistant message with only tool calls sends empty string content", () => {
		const messages = convertHistory([
			message("assistant", [{ type: "tool_call", toolUseId: "c", name: "Read", input: {} }]),
		]);
		expect(messages[0].content).toBe("");
		expect(messages[0].tool_calls).toHaveLength(1);
	});

	test("a tool call missing an id or a name is dropped", () => {
		// The host cannot execute either, and inventing one would create a call it then tries to
		// answer.
		const messages = convertHistory([
			message("assistant", [
				{ type: "tool_call", name: "NoId", input: {} },
				{ type: "tool_call", toolUseId: "no-name", input: {} },
				{ type: "text", text: "kept" },
			]),
		]);
		expect(messages).toEqual([{ role: "assistant", content: "kept" }]);
	});

	test("each tool result becomes its own role:tool message", () => {
		const messages = convertHistory([
			message("tool", [
				{
					type: "tool_result",
					toolUseId: "call-1",
					name: "Read",
					content: [{ type: "text", text: "file body" }],
					isError: false,
				},
				{
					type: "tool_result",
					toolUseId: "call-2",
					name: "Bash",
					content: [{ type: "text", text: "exit 0" }],
					isError: false,
				},
			]),
		]);
		expect(messages).toEqual([
			{ role: "tool", tool_call_id: "call-1", content: "file body" },
			{ role: "tool", tool_call_id: "call-2", content: "exit 0" },
		]);
	});

	test("a failed tool result is still delivered", () => {
		// An unanswered tool call fails the whole turn upstream, so an error result must be sent
		// rather than filtered. `isError` has no OpenAI equivalent; the text carries the failure.
		const messages = convertHistory([
			message("tool", [
				{
					type: "tool_result",
					toolUseId: "call-1",
					content: [{ type: "text", text: "ENOENT" }],
					isError: true,
				},
			]),
		]);
		expect(messages).toEqual([{ role: "tool", tool_call_id: "call-1", content: "ENOENT" }]);
	});

	test("an empty tool result still produces a message", () => {
		// A tool that legitimately returned nothing must still answer its call.
		const messages = convertHistory([
			message("tool", [{ type: "tool_result", toolUseId: "call-1", content: [] }]),
		]);
		expect(messages).toEqual([{ role: "tool", tool_call_id: "call-1", content: "" }]);
	});

	test("a full assistant/tool round trip keeps call and result adjacent and paired", () => {
		const messages = convertHistory([
			message("user", [{ type: "text", text: "read it" }]),
			message("assistant", [
				{ type: "tool_call", toolUseId: "call-9", name: "Read", input: { path: "x" } },
			]),
			message("tool", [
				{ type: "tool_result", toolUseId: "call-9", content: [{ type: "text", text: "ok" }] },
			]),
			message("assistant", [{ type: "text", text: "done" }]),
		]);
		expect(messages.map((entry) => entry.role)).toEqual(["user", "assistant", "tool", "assistant"]);
		const call = (messages[1].tool_calls ?? [])[0];
		expect(messages[2].tool_call_id).toBe(call.id);
	});

	test("tool results attached to a user message are emitted before the user text", () => {
		// Defensive: the host emits tool results as their own message. Handled anyway because a
		// dropped result leaves a call unanswered, which upstream rejects.
		const messages = convertHistory([
			message("user", [
				{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "r" }] },
				{ type: "text", text: "next" },
			]),
		]);
		expect(messages).toEqual([
			{ role: "tool", tool_call_id: "c1", content: "r" },
			{ role: "user", content: "next" },
		]);
	});
});

describe("cline-external history: tool result content flattening", () => {
	test("text blocks are joined", () => {
		expect(
			flattenToolResultContent([
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			]),
		).toBe("one\ntwo");
	});

	test("an image becomes a marker rather than disappearing", () => {
		// A role:tool message cannot carry an image. Silently dropping it would make a screenshot
		// tool look like it returned nothing at all.
		const flattened = flattenToolResultContent([
			{ type: "text", text: "captured" },
			{ type: "image", mediaType: "image/png", dataBase64: "AAAA" },
		]);
		expect(flattened).toContain("captured");
		expect(flattened).toContain("image omitted");
		expect(flattened).not.toContain("AAAA");
	});

	test("a plain string is passed through", () => {
		expect(flattenToolResultContent("raw")).toBe("raw");
	});
});

describe("cline-external history: images", () => {
	test("a user image becomes a data URL in the parts form", () => {
		const messages = convertHistory([
			message("user", [
				{ type: "text", text: "look" },
				{ type: "image", mediaType: "image/png", dataBase64: "QUJD" },
			]),
		]);
		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
				],
			},
		]);
	});

	test("an image with no accompanying text gets a placeholder", () => {
		// A parts array with no text is accepted upstream but leaves the model no instruction.
		const messages = convertHistory([
			message("user", [{ type: "image", mediaType: "image/jpeg", dataBase64: "WA==" }]),
		]);
		const parts = messages[0].content as Array<{ type: string; text?: string }>;
		expect(parts[0]).toEqual({ type: "text", text: "[user sent image(s)]" });
	});

	test("a bare format is completed into a media type", () => {
		// The host normalises to "image/png", but a hand-built payload can carry "png"; emitting
		// `data:png;base64,...` would be an invalid data URL.
		const messages = convertHistory([
			message("user", [{ type: "image", mediaType: "png", dataBase64: "WA==" }]),
		]);
		const parts = messages[0].content as Array<{ image_url?: { url: string } }>;
		expect(parts[1].image_url?.url).toBe("data:image/png;base64,WA==");
	});

	test("an image missing its data is dropped", () => {
		const messages = convertHistory([
			message("user", [
				{ type: "image", mediaType: "image/png" },
				{ type: "text", text: "still here" },
			]),
		]);
		expect(messages).toEqual([{ role: "user", content: "still here" }]);
	});
});

describe("cline-external history: the current turn", () => {
	test("text is appended as a user message", () => {
		const messages: OpenAiMessage[] = [];
		appendCurrentTurn(messages, { text: "go", toolResults: [] });
		expect(messages).toEqual([{ role: "user", content: "go" }]);
	});

	test("pending tool results precede the user text", () => {
		const messages: OpenAiMessage[] = [];
		appendCurrentTurn(messages, {
			text: "and now this",
			toolResults: [
				{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "done" }] },
			],
		});
		expect(messages).toEqual([
			{ role: "tool", tool_call_id: "c1", content: "done" },
			{ role: "user", content: "and now this" },
		]);
	});

	test('the "." continuation marker never becomes a message', () => {
		// The host sends "." to mean "keep going" after delivering tool results. Forwarding it
		// would put a literal period into the conversation.
		const messages: OpenAiMessage[] = [];
		appendCurrentTurn(messages, {
			text: ".",
			toolResults: [
				{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "r" }] },
			],
		});
		expect(messages).toEqual([{ role: "tool", tool_call_id: "c1", content: "r" }]);
	});

	test('a "." marker with images still sends the images', () => {
		// The marker means "no text", not "nothing to send" — the images are the payload.
		const messages: OpenAiMessage[] = [];
		appendCurrentTurn(messages, {
			text: ".",
			images: [{ mediaType: "image/png", dataBase64: "WA==" }],
			toolResults: [],
		});
		expect(messages).toHaveLength(1);
		const parts = messages[0].content as Array<{ type: string }>;
		expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
	});

	test("an empty current turn adds nothing", () => {
		const messages: OpenAiMessage[] = [];
		appendCurrentTurn(messages, { text: "", toolResults: [] });
		expect(messages).toEqual([]);
	});
});

describe("cline-external history: tools and system prompt", () => {
	test("canonical tool definitions become OpenAI function tools", () => {
		const tools = convertTools([
			{
				name: "Read",
				description: "Read a file",
				inputSchema: { type: "object", properties: { path: { type: "string" } } },
			},
		]);
		expect(tools).toEqual([
			{
				type: "function",
				function: {
					name: "Read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			},
		]);
	});

	test("a tool with no schema still declares parameters", () => {
		// Upstream requires the field to be present for a function tool.
		const tools = convertTools([{ name: "Now", description: "" }]);
		expect(tools[0].function.parameters).toEqual({ type: "object", properties: {} });
	});

	test("a nameless tool is dropped", () => {
		expect(convertTools([{ description: "no name" }])).toEqual([]);
	});

	test("the system prompt is prepended only when present", () => {
		const base: OpenAiMessage[] = [{ role: "user", content: "q" }];
		expect(withSystemPrompt(base, "be brief")).toEqual([
			{ role: "system", content: "be brief" },
			{ role: "user", content: "q" },
		]);
		expect(withSystemPrompt(base, undefined)).toBe(base);
	});
});
