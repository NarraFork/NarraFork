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
import { assembleContent, splitEnvelope } from "@shared/narrator-blocks/storage";
import type { AnthropicProviderConfig } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import { buildAdapterHistory } from "../history-build";
import { LoopTranscript } from "../loop-transcript";
import type { ChatParams, DbMessage } from "../provider";

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
	test("typed context update stays after tool results as later user text is appended", async () => {
		const provider = new AnthropicProvider({
			id: "legality",
			name: "Legality",
			prefix: "legality",
			apiKey: "sk-test",
			baseUrl: "https://example.invalid/v1",
			defaultModel: MODEL,
			officialApi: true,
		});
		const transcript = new LoopTranscript([
			{
				id: "first-user",
				role: "user",
				contentText: "first",
				contentJson: [{ type: "text", text: "first" }],
				parentToolUseId: null,
				messageUuid: null,
			},
		]);
		transcript.appendStep([{ type: "tool_use", toolUseId: "read", name: "Read", input: {} }]);
		transcript.settleTool("read", { output: "result-before-update" });
		const update: DbMessage = {
			id: "update",
			role: "sys",
			parentToolUseId: null,
			messageUuid: null,
			contentText: "frozen-update",
			contentJson: [
				{ type: "text", text: "frozen-update" },
				{
					type: "context_update",
					epochId: "epoch-1",
					changes: [{ key: "workspace", value: "/b" }],
				},
			],
		};
		transcript.replace([...transcript.rows, update]);
		const build = async (rows: DbMessage[]) =>
			(await buildAdapterHistory(provider, rows, { provider: "legality", model: MODEL })).history;
		const history = await build(transcript.rows);
		const before = await wireMessages({ history, content: "" });
		const after = await wireMessages({ history, content: "later-user-input" });
		const restored = transcript.rows.map((row) => ({
			...structuredClone(row),
			contentJson: assembleContent(splitEnvelope(row).blocks),
		}));
		expect(after).toEqual(
			await wireMessages({ history: await build(restored), content: "later-user-input" }),
		);
		expect(before.some((message) => message.role === "system")).toBe(false);
		expect(after.some((message) => message.role === "system")).toBe(false);
		// Same-role merging appends content blocks; it does not rewrite the existing
		// tool result or update. Cache-control markers are request-local, not content.
		const withoutCache = (value: unknown) =>
			JSON.parse(
				JSON.stringify(value, (key, entry) => (key === "cache_control" ? undefined : entry)),
			);
		expect(withoutCache(after.slice(0, -1))).toEqual(withoutCache(before.slice(0, -1)));
		const oldTail = before.at(-1)?.content as WireBlock[];
		const newTail = after.at(-1)?.content as WireBlock[];
		expect(withoutCache(newTail.slice(0, oldTail.length))).toEqual(withoutCache(oldTail));
		const encoded = JSON.stringify(after);
		expect(encoded.split("frozen-update")).toHaveLength(2);
		expect(encoded.indexOf("result-before-update")).toBeLessThan(encoded.indexOf("frozen-update"));
		expect(encoded.indexOf("frozen-update")).toBeLessThan(encoded.indexOf("later-user-input"));
	});
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

	test("DeepSeek keeps its reasoning with an empty signature", async () => {
		// DeepSeek never mints signatures and requires thinking on assistant turns,
		// so the drop must not apply there — its relay path echoes the text with an
		// empty signature instead (the placeholder-signature compat value is gone:
		// strict relays that reject an empty string are a documented tradeoff).
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
			signature: "",
		});
	});

	test("relay models keep unsigned thinking across upstream switches", async () => {
		// A GLM-class relay mints no signatures at all, so there is no ownership to
		// prove: the reasoning text crosses providers and is echoed back verbatim.
		const messages = await wireMessages({
			history: [
				USER("first"),
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "glm reasoning", signature: "" },
						{ type: "text", text: "answer" },
					],
				},
				USER("second"),
			],
			model: "GLM-5.1",
			officialApi: false,
		});

		const thinking = messages
			.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
			.filter((block) => block.type === "thinking");
		expect(thinking[0]).toEqual({
			type: "thinking",
			thinking: "glm reasoning",
			signature: "",
		});
		expect(JSON.stringify(messages)).toContain("answer");
	});

	test("relay models drop redacted_thinking and patch missing thinking blocks", async () => {
		const messages = await wireMessages({
			history: [
				USER("first"),
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "b3BhcXVl" },
						{ type: "text", text: "opaque answer" },
					],
				},
				// A thinking-less assistant turn: relay gateways in thinking mode
				// require one, so the sanitizer patches a single-space placeholder.
				{ role: "assistant", content: [{ type: "text", text: "plain answer" }] },
				USER("second"),
			],
			model: "kimi-k2.6",
			officialApi: false,
		});

		const blocks = messages.flatMap((message) =>
			Array.isArray(message.content) ? message.content : [],
		);
		expect(blocks.some((block) => block.type === "redacted_thinking")).toBe(false);
		expect(JSON.stringify(messages)).toContain("opaque answer");
		const patched = blocks.find((block) => block.type === "thinking" && block.thinking === " ");
		expect(patched).toEqual({ type: "thinking", thinking: " ", signature: "" });
	});
});
