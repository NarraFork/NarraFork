/**
 * Wire-shape legality rules the Anthropic Messages API enforces on replayed
 * history, both of which used to produce a request that could never succeed —
 * and, because the offending block sits in replayed history, failed identically
 * on every subsequent turn rather than transiently:
 *
 *   messages.N.content.M: Invalid `signature` in `thinking` block
 *   messages.N: role 'system' must precede an 'assistant' message or end the array
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AnthropicProviderConfig } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import type { ChatParams } from "../provider";

const ORIGINAL_FETCH = globalThis.fetch;
const MODEL = "claude-opus-5";
const SYSTEM_PROMPT = "NarraFork wire-legality system prompt.";

interface WireBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	tool_use_id?: string;
}

interface WireMessage {
	role: string;
	content: string | WireBlock[];
}

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

/** Drive one chat request and return the messages array it put on the wire. */
async function wireMessages(options: {
	history: unknown[];
	content?: string;
	model?: string;
	officialApi?: boolean;
}): Promise<WireMessage[]> {
	let body: Record<string, unknown> = {};
	globalThis.fetch = (async (_input, init) => {
		body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return new Response("upstream stubbed", { status: 500 });
	}) as typeof fetch;

	const model = options.model ?? MODEL;
	const provider = new AnthropicProvider({
		id: "legality",
		name: "Legality",
		prefix: "legality",
		apiKey: "sk-test",
		baseUrl: "https://example.invalid/v1",
		defaultModel: model,
		officialApi: options.officialApi ?? true,
	} as AnthropicProviderConfig);

	const history = structuredClone(options.history) as unknown[];
	provider.injectSystemPrompt(history, SYSTEM_PROMPT, model);

	const params: ChatParams = {
		conversationId: "legality-conversation",
		content: options.content ?? "current turn",
		model,
		cwd: process.cwd(),
		history,
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		reasoningEffort: "high",
	} as ChatParams;

	const iterator = provider.chat(params)[Symbol.asyncIterator]();
	try {
		await iterator.next();
	} catch {
		// Expected: the stub always fails the request.
	}
	return body.messages as WireMessage[];
}

/** Read a system message's text out of either the string or block content shape. */
function systemText(message: WireMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n\n");
}

/** Assert the API's positional rule for every system message in the array. */
function expectLegalSystemPlacement(messages: WireMessage[]): void {
	for (let index = 0; index < messages.length; index++) {
		if (messages[index].role !== "system") continue;
		// Preceded by a user turn: the only predecessor the CLI ever emits, and the
		// one that keeps user/assistant alternation intact across the system entry.
		expect(messages[index - 1]?.role).toBe("user");
		const next = messages[index + 1];
		// Followed by an assistant turn, or ending the array.
		if (next) expect(next.role).toBe("assistant");
	}
}

const USER = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const ASSISTANT = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const SYSTEM = (text: string) => ({ role: "system", content: text });

describe("mid-conversation system placement", () => {
	test("a sys row landing in front of a user turn is moved behind it", async () => {
		// `sys` rows are injected asynchronously (container events, review feedback,
		// merge summaries), so this is the ordinary case, not an edge case.
		const messages = await wireMessages({
			history: [USER("first"), ASSISTANT("reply"), SYSTEM("directive"), USER("second")],
		});
		expectLegalSystemPlacement(messages);
		expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
		expect(JSON.stringify(messages)).toContain("directive");
	});

	test("a sys row in front of the current user turn ends the array instead", async () => {
		// `chat` appends the current user message last, so a trailing `sys` row would
		// otherwise always be followed by a user turn.
		const messages = await wireMessages({
			history: [USER("first"), ASSISTANT("reply"), SYSTEM("trailing directive")],
			content: "current turn",
		});
		expectLegalSystemPlacement(messages);
		expect(messages.at(-1)?.role).toBe("system");
		expect(messages.at(-2)?.role).toBe("user");
	});

	test("consecutive sys rows merge into one system message", async () => {
		// `system, system` is illegal: the first precedes a system, not an assistant.
		const messages = await wireMessages({
			history: [USER("first"), SYSTEM("directive one"), SYSTEM("directive two")],
			content: "",
		});
		expectLegalSystemPlacement(messages);
		const systems = messages.filter((message) => message.role === "system");
		expect(systems).toHaveLength(1);
		// Trailing system messages take the conversation breakpoint, which turns the
		// content into the block form (mirroring the CLI's own trailing api_system).
		expect(systemText(systems[0])).toBe("directive one\n\ndirective two");
	});

	test("a sys row whose predecessor is an assistant is delivered as user content", async () => {
		// No legal position exists there, so the directive is downgraded exactly as
		// claude-cli does when its pending reminder cannot follow a user turn.
		const messages = await wireMessages({
			history: [USER("first"), ASSISTANT("reply"), SYSTEM("directive"), ASSISTANT("second reply")],
			content: "",
		});
		expect(messages.some((message) => message.role === "system")).toBe(false);
		expect(JSON.stringify(messages)).toContain("directive");
	});

	test("a system message never survives on the compatible path", async () => {
		const messages = await wireMessages({
			history: [USER("first"), ASSISTANT("reply"), SYSTEM("directive"), USER("second")],
			officialApi: false,
		});
		expect(messages.some((message) => message.role === "system")).toBe(false);
		expect(JSON.stringify(messages)).toContain("directive");
	});

	test("stays legal when the assistant turn behind a sys row is pruned", async () => {
		// The thinking sanitizers can delete a whole assistant message. Placing the
		// system entry before pruning would leave it in front of a user turn — the
		// exact 400 this normalizer exists to prevent.
		for (const orphan of [
			// Removed by filterThinkingOnlyAssistantMessages (signed, but thinking-only).
			[{ type: "thinking", thinking: "orphan reasoning", signature: "sig-abc" }],
			// Removed by dropUnreplayableThinkingBlocks (nothing survives the drop).
			[{ type: "thinking", thinking: "orphan reasoning", signature: "" }],
		]) {
			const messages = await wireMessages({
				history: [
					USER("first"),
					SYSTEM("directive"),
					{ role: "assistant", content: orphan },
					USER("second"),
				],
			});
			expectLegalSystemPlacement(messages);
			expect(JSON.stringify(messages)).toContain("directive");
			expect(JSON.stringify(messages)).not.toContain("orphan reasoning");
		}
	});
});

describe("thinking blocks must carry a replayable signature", () => {
	test("a blank signature is dropped, a real one survives", async () => {
		// A blank signature is what buildAnthropicHistory leaves behind when the
		// stored signatureSource does not match this provider (cross-provider fork,
		// renamed prefix, message persisted before the field existed).
		const messages = await wireMessages({
			history: [
				USER("first"),
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "unsignable reasoning", signature: "" },
						{ type: "text", text: "answer one" },
					],
				},
				USER("second"),
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "signed reasoning", signature: "sig-abc" },
						{ type: "text", text: "answer two" },
					],
				},
			],
		});

		const thinking = messages
			.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
			.filter((block) => block.type === "thinking");
		expect(thinking).toEqual([
			{ type: "thinking", thinking: "signed reasoning", signature: "sig-abc" },
		]);
		// Only the block goes; the assistant turn keeps its answer.
		expect(JSON.stringify(messages)).toContain("answer one");
	});

	test("an assistant turn holding only unsignable thinking is removed", async () => {
		// Interrupted stream: content_block_start opened a thinking block and the
		// connection died before signature_delta. Leaving `content: []` behind would
		// only trade the signature error for an empty-content one.
		const messages = await wireMessages({
			history: [
				USER("first"),
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "orphaned reasoning", signature: "" }],
				},
				USER("second"),
			],
		});

		expect(JSON.stringify(messages)).not.toContain("orphaned reasoning");
		for (const message of messages) {
			expect(Array.isArray(message.content) ? message.content.length : 1).toBeGreaterThan(0);
		}
	});

	test("thinking that precedes a tool_use is dropped without losing the call", async () => {
		const messages = await wireMessages({
			history: [
				USER("first"),
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "unsignable reasoning", signature: "" },
						{ type: "tool_use", id: "toolu_1", name: "Read", input: {} },
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }],
				},
			],
		});

		const blocks = messages.flatMap((message) =>
			Array.isArray(message.content) ? message.content : [],
		);
		expect(blocks.some((block) => block.type === "thinking")).toBe(false);
		expect(blocks.some((block) => block.id === "toolu_1")).toBe(true);
		expect(blocks.some((block) => block.tool_use_id === "toolu_1")).toBe(true);
	});

	test("DeepSeek keeps its placeholder signature instead of losing the reasoning", async () => {
		// DeepSeek never mints signatures and requires thinking on assistant turns,
		// so the drop must not apply there — its own compatibility path fills the
		// signature in and the real reasoning text is preserved.
		const messages = await wireMessages({
			history: [
				USER("first"),
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "real reasoning", signature: "" },
						{ type: "text", text: "answer" },
					],
				},
				USER("second"),
			],
			model: "deepseek-v4-pro",
			officialApi: false,
		});

		const thinking = messages
			.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
			.filter((block) => block.type === "thinking");
		expect(thinking[0]).toEqual({
			type: "thinking",
			thinking: "real reasoning",
			signature: "narrafork-deepseek-compat",
		});
	});
});
