import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import type { DbMessage, ParsedStreamEvent } from "../provider";
import { ApiRequestDumpCollector } from "../request-dump";

interface TestGeminiProvider {
	formatTools(tools: unknown[]): unknown[];
	buildHistory(
		messages: DbMessage[],
		model: string,
	): Promise<{
		history: unknown[];
		trailingToolResults: unknown[];
	}>;
	chat(params: Record<string, unknown>): AsyncGenerator<ParsedStreamEvent>;
	formatToolResult(
		toolUseId: string,
		output: string,
		isError: boolean,
		images?: Array<{ format: string; base64: string }>,
		toolName?: string,
	): unknown;
	pushUserTurn(history: unknown[], content: string, model: string, toolResults: unknown[]): void;
	pushAssistantTurn(
		history: unknown[],
		text: string,
		toolUses: Array<{
			toolUseId: string;
			name: string;
			input: Record<string, unknown>;
			outputIndex?: number;
			thoughtSignature?: string;
			thoughtSignatureSource?: string;
		}>,
		reasoningBlocks?: Array<{
			text: string;
			outputIndex?: number;
			providerMetadata?: Record<string, unknown>;
		}>,
		webSearches?: unknown[],
		messageId?: string,
		imageGenerations?: unknown[],
		textOutputIndex?: number,
	): void;
	generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: {
			reasoningEffort?: string;
			signal?: AbortSignal;
			onTextDelta?: (delta: string) => void | Promise<void>;
		},
	): Promise<{
		text: string;
		usage?: {
			inputTokens: number;
			outputTokens: number;
			cachedInputTokens?: number;
			cacheCreationInputTokens?: number;
			reasoningTokens?: number;
		} | null;
	}>;
}

let GeminiProvider: new (config: Record<string, unknown>) => TestGeminiProvider;
let GeminiGenerateContentProvider: new (config: Record<string, unknown>) => TestGeminiProvider;
let createGeminiProvider: (config: Record<string, unknown>) => TestGeminiProvider;
let setOutboundFetchOverrideForTest: (
	override: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | null,
) => void;
let maxSseEventBytes = 0;
let maxStreamBytes = 0;
let testHome = "";
let originalNarraforkHome: string | undefined;

beforeAll(async () => {
	originalNarraforkHome = process.env.NARRAFORK_HOME;
	testHome = mkdtempSync(join(tmpdir(), "narrafork-gemini-interactions-"));
	process.env.NARRAFORK_HOME = testHome;
	const [interactionsModule, generateModule, factoryModule, outboundFetchModule] =
		await Promise.all([
			import("../gemini-interactions-provider"),
			import("../gemini-provider"),
			import("../provider"),
			import("../../net/outbound-fetch"),
		]);
	GeminiProvider =
		interactionsModule.GeminiInteractionsProvider as unknown as typeof GeminiProvider;
	GeminiGenerateContentProvider =
		generateModule.GeminiProvider as unknown as typeof GeminiGenerateContentProvider;
	createGeminiProvider =
		factoryModule.createGeminiProvider as unknown as typeof createGeminiProvider;
	maxSseEventBytes = interactionsModule.GEMINI_MAX_SSE_EVENT_BYTES;
	maxStreamBytes = interactionsModule.GEMINI_MAX_STREAM_BYTES;
	setOutboundFetchOverrideForTest = outboundFetchModule.setOutboundFetchOverrideForTest;
});

afterEach(() => {
	setOutboundFetchOverrideForTest(null);
});

afterAll(() => {
	setOutboundFetchOverrideForTest(null);
	if (originalNarraforkHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = originalNarraforkHome;
	if (testHome) rmSync(testHome, { recursive: true, force: true });
});

function makeProvider(): TestGeminiProvider {
	return new GeminiProvider({
		id: "gem-test",
		name: "Gemini Test",
		prefix: "gemini-test",
		apiKey: "test-key",
		baseUrl: "https://gemini.example.test/v1beta",
		defaultModel: "gemini-3-flash-preview",
		geminiTransport: "interactions",
	});
}

function makeGenerateContentProvider(): TestGeminiProvider {
	return new GeminiGenerateContentProvider({
		id: "gem-generate-test",
		name: "Gemini Generate Test",
		prefix: "gemini-generate-test",
		apiKey: "test-key",
		baseUrl: "https://gemini.example.test/v1beta",
		defaultModel: "gemini-2.5-flash",
	});
}

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
	const body = events
		.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function baseChatParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		conversationId: "conv-gemini",
		content: "hello",
		model: "gemini-test:gemini-3-flash-preview",
		cwd: "/tmp",
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		...overrides,
	};
}

function byteLengthForTest(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

async function collect(stream: AsyncGenerator<ParsedStreamEvent>): Promise<ParsedStreamEvent[]> {
	const events: ParsedStreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Gemini transport selection", () => {
	test("factory defaults missing transport to generateContent and never calls /interactions", async () => {
		const urls: string[] = [];
		setOutboundFetchOverrideForTest(async (input) => {
			urls.push(String(input));
			return new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		const provider = createGeminiProvider({
			id: "factory-default",
			name: "Factory Default",
			prefix: "factory-default",
			apiKey: "test-key",
			baseUrl: "https://gemini.example.test/v1beta",
			defaultModel: "gemini-2.5-flash",
		});
		const events = await collect(
			provider.chat(baseChatParams({ model: "factory-default:gemini-2.5-flash" }) as never),
		);
		expect(events).toContainEqual({ text: "ok", textOutputIndex: undefined });
		expect(urls).toEqual([
			"https://gemini.example.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		]);
		expect(urls.some((url) => url.includes("/interactions"))).toBe(false);
	});

	test("factory uses /interactions only for explicit interactions transport", async () => {
		let url = "";
		setOutboundFetchOverrideForTest(async (input) => {
			url = String(input);
			return sseResponse([
				{
					event: "interaction.completed",
					data: { event_type: "interaction.completed", interaction: { status: "completed" } },
				},
			]);
		});
		const provider = createGeminiProvider({
			id: "factory-interactions",
			name: "Factory Interactions",
			prefix: "factory-interactions",
			apiKey: "test-key",
			baseUrl: "https://gemini.example.test/v1beta",
			defaultModel: "gemini-3-flash-preview",
			geminiTransport: "interactions",
		});
		await collect(
			provider.chat(
				baseChatParams({ model: "factory-interactions:gemini-3-flash-preview" }) as never,
			),
		);
		expect(url).toBe("https://gemini.example.test/v1beta/interactions");
	});

	test("does not replay opaque signatures across Gemini transports", () => {
		const interactionsHistory: unknown[] = [];
		makeProvider().pushAssistantTurn(interactionsHistory, "", [
			{
				toolUseId: "cross-transport",
				name: "Read",
				input: { file_path: "/tmp/a" },
				thoughtSignature: "opaque-signature",
				thoughtSignatureSource: "gemini:gemini-test:generate-content",
			},
		]);
		expect(interactionsHistory).toEqual([
			{
				type: "function_call",
				id: "cross-transport",
				name: "Read",
				arguments: { file_path: "/tmp/a" },
			},
		]);

		const generateHistory: unknown[] = [];
		makeGenerateContentProvider().pushAssistantTurn(generateHistory, "", [
			{
				toolUseId: "same-transport",
				name: "Read",
				input: { file_path: "/tmp/a" },
				thoughtSignature: "opaque-signature",
				thoughtSignatureSource: "gemini:gemini-generate-test:generate-content",
			},
		]);
		expect(generateHistory).toEqual([
			{
				role: "model",
				parts: [
					{
						functionCall: { name: "Read", args: { file_path: "/tmp/a" } },
						thoughtSignature: "opaque-signature",
					},
				],
			},
		]);
	});

	test("generateContent lightweight generation streams deltas and usage", async () => {
		let url = "";
		let headers = new Headers();
		let signal: AbortSignal | null | undefined;
		const deltas: string[] = [];
		const controller = new AbortController();
		setOutboundFetchOverrideForTest(async (input, init) => {
			url = String(input);
			headers = new Headers(init?.headers);
			signal = init?.signal;
			return new Response(
				[
					`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "gener" }] } }] })}\n\n`,
					`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ated" }] } }] })}\n\n`,
					`data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, cachedContentTokenCount: 1, thoughtsTokenCount: 3 } })}\n\n`,
				].join(""),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		const result = await makeGenerateContentProvider().generateWithMeta(
			"hello",
			"gemini-generate-test:gemini-2.5-flash",
			undefined,
			{
				signal: controller.signal,
				onTextDelta: async (delta) => {
					deltas.push(delta);
					await Promise.resolve();
				},
			},
		);
		expect(result).toEqual({
			text: "generated",
			usage: {
				inputTokens: 7,
				outputTokens: 2,
				cachedInputTokens: 1,
				cacheCreationInputTokens: 0,
				reasoningTokens: 3,
			},
		});
		expect(deltas).toEqual(["gener", "ated"]);
		expect(url).toBe(
			"https://gemini.example.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(headers.get("Accept")).toBe("text/event-stream");
		expect(signal).toBe(controller.signal);
	});
});

describe("Gemini Interactions API provider", () => {
	test("uses the current Interactions revision, store:false, flat tools, and full input steps", async () => {
		let requestUrl = "";
		let requestHeaders = new Headers();
		let requestBody: Record<string, unknown> = {};
		setOutboundFetchOverrideForTest(async (input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse([
				{
					event: "interaction.completed",
					data: { event_type: "interaction.completed", interaction: { status: "completed" } },
				},
			]);
		});

		const provider = makeProvider();
		const tools = provider.formatTools([
			{
				name: "Read",
				description: "Read a file",
				parameters: z.object({ file_path: z.string() }),
			} as never,
		]);
		await collect(
			provider.chat(
				baseChatParams({
					history: [{ type: "user_input", content: "old question" }],
					tools,
					reasoningEffort: "none",
				}) as never,
			),
		);

		expect(requestUrl).toBe("https://gemini.example.test/v1beta/interactions");
		expect(requestHeaders.get("Api-Revision")).toBe("2026-05-20");
		expect(requestHeaders.get("x-goog-api-key")).toBe("test-key");
		expect(requestBody.store).toBe(false);
		expect(requestBody.stream).toBe(true);
		expect(requestBody.generation_config).toEqual({
			thinking_level: "minimal",
			thinking_summaries: "auto",
		});
		expect(requestBody.tools).toEqual([
			{
				type: "function",
				name: "Read",
				description: "Read a file",
				parameters: {
					type: "object",
					properties: { file_path: { type: "string" } },
					required: ["file_path"],
				},
			},
		]);
		expect(requestBody.input).toEqual([
			{ type: "user_input", content: "old question" },
			{ type: "user_input", content: "hello" },
		]);
	});

	test("parses interaction/step SSE with function_call id, args, thoughts, text, and usage", async () => {
		setOutboundFetchOverrideForTest(async () =>
			sseResponse([
				{
					event: "interaction.created",
					data: {
						event_type: "interaction.created",
						interaction: { id: "int_1", status: "in_progress" },
					},
				},
				{
					event: "step.start",
					data: {
						event_type: "step.start",
						index: 0,
						step: { type: "thought", id: "thought_1", summary: [] },
					},
				},
				{
					event: "step.delta",
					data: {
						event_type: "step.delta",
						index: 0,
						delta: { type: "thought_summary", content: [{ type: "text", text: "considering" }] },
					},
				},
				{
					event: "step.delta",
					data: {
						event_type: "step.delta",
						index: 0,
						delta: { type: "thought_signature", signature: "sig_1" },
					},
				},
				{
					event: "step.stop",
					data: { event_type: "step.stop", index: 0, step: { type: "thought" } },
				},
				{
					event: "step.start",
					data: { event_type: "step.start", index: 1, step: { type: "model_output", content: "" } },
				},
				{
					event: "step.delta",
					data: { event_type: "step.delta", index: 1, delta: { text: "I'll read it." } },
				},
				{
					event: "step.start",
					data: {
						event_type: "step.start",
						index: 2,
						step: { type: "function_call", id: "call_1", name: "Read", arguments: {} },
					},
				},
				{
					event: "step.delta",
					data: {
						event_type: "step.delta",
						index: 2,
						delta: { type: "arguments_delta", arguments_delta: '{"file_path":' },
					},
				},
				{
					event: "step.delta",
					data: {
						event_type: "step.delta",
						index: 2,
						delta: { type: "arguments_delta", arguments_delta: '"/tmp/a"}' },
					},
				},
				{
					event: "step.stop",
					data: { event_type: "step.stop", index: 2 },
				},
				{
					event: "interaction.requires_action",
					data: {
						type: "interaction.requires_action",
						interaction: {
							status: "requires_action",
							usage: {
								total_input_tokens: 12,
								total_cached_tokens: 2,
								total_output_tokens: 4,
								total_thought_tokens: 2,
							},
						},
					},
				},
			]),
		);

		const events = await collect(makeProvider().chat(baseChatParams() as never));
		expect(events[0]).toEqual({ messageId: "int_1" });
		expect(events).toContainEqual({
			reasoning: "considering",
			reasoningMetadata: { gemini: { stepId: "thought_1", stepIndex: 0 } },
			reasoningOutputIndex: 0,
		});
		expect(events).toContainEqual({
			reasoningMetadata: {
				gemini: { stepId: "thought_1", stepIndex: 0, thoughtSignature: "sig_1" },
			},
			reasoningOutputIndex: 0,
		});
		expect(events).toContainEqual({ text: "I'll read it.", textOutputIndex: 1 });
		expect(events).toContainEqual({
			toolUseChunk: { toolUseId: "call_1", name: "Read", input: "", outputIndex: 2 },
		});
		expect(events).toContainEqual({
			toolUseChunk: { toolUseId: "call_1", input: '{"file_path":', outputIndex: 2 },
		});
		expect(events).toContainEqual({
			toolUseChunk: { toolUseId: "call_1", name: "Read", stop: true, outputIndex: 2 },
		});
		expect(events).toContainEqual({
			usage: {
				promptTokens: 12,
				inputTokens: 10,
				completionTokens: 4,
				reasoningTokens: 2,
				cachedInputTokens: 2,
			},
		});
	});

	test("two-turn tool trajectory preserves function_call id and function_result call_id", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		setOutboundFetchOverrideForTest(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return sseResponse([
				{
					event: "interaction.completed",
					data: { event_type: "interaction.completed", interaction: { status: "completed" } },
				},
			]);
		});
		const provider = makeProvider();
		const history: unknown[] = [];
		await collect(provider.chat(baseChatParams() as never));
		provider.pushUserTurn(history, "hello", "gemini-test:model", []);
		provider.pushAssistantTurn(history, "", [
			{ toolUseId: "call_upstream", name: "Read", input: { file_path: "/tmp/a" }, outputIndex: 0 },
		]);
		const result = provider.formatToolResult(
			"call_upstream",
			"file contents",
			false,
			undefined,
			"Read",
		);
		provider.pushUserTurn(history, "", "gemini-test:model", [result]);
		await collect(
			provider.chat(baseChatParams({ content: ".", history, toolResults: [] }) as never),
		);

		expect(bodies[1].input).toEqual([
			{ type: "user_input", content: "hello" },
			{
				type: "function_call",
				id: "call_upstream",
				name: "Read",
				arguments: { file_path: "/tmp/a" },
			},
			{
				type: "function_result",
				call_id: "call_upstream",
				name: "Read",
				result: "file contents",
			},
		]);
	});

	test("pushAssistantTurn and buildHistory round-trip ordering, indices, and thought signature", async () => {
		const provider = makeProvider();
		const pushed: unknown[] = [];
		provider.pushUserTurn(pushed, "question", "gemini-test:model", []);
		provider.pushAssistantTurn(
			pushed,
			"answer prefix",
			[
				{
					toolUseId: "call_roundtrip",
					name: "Read",
					input: { file_path: "/tmp/a" },
					outputIndex: 2,
					thoughtSignature: "sig_roundtrip",
				},
			],
			[
				{
					text: "reasoning summary",
					outputIndex: 0,
					providerMetadata: {
						gemini: {
							stepId: "thought_roundtrip",
							stepIndex: 0,
							thoughtSignature: "sig_roundtrip",
						},
						signatureSource: "gemini:gemini-test:interactions",
					},
				},
			],
			undefined,
			undefined,
			undefined,
			1,
		);

		const rebuilt = await provider.buildHistory(
			[
				{
					id: "user-1",
					role: "user",
					contentJson: [{ type: "text", text: "question" }],
					contentText: "question",
					parentToolUseId: null,
					messageUuid: null,
				},
				{
					id: "assistant-1",
					role: "assistant",
					contentJson: [
						{
							type: "reasoning",
							text: "reasoning summary",
							outputIndex: 0,
							providerMetadata: {
								gemini: {
									stepId: "thought_roundtrip",
									stepIndex: 0,
									thoughtSignature: "sig_roundtrip",
								},
								signatureSource: "gemini:gemini-test:interactions",
							},
						},
						{ type: "text", text: "answer prefix", outputIndex: 1 },
						{
							type: "tool_use",
							id: "call_roundtrip",
							name: "Read",
							input: { file_path: "/tmp/a" },
							outputIndex: 2,
							thoughtSignature: "sig_roundtrip",
						},
					],
					contentText: "answer prefix",
					parentToolUseId: null,
					messageUuid: null,
					toolCalls: [
						{
							toolUseId: "call_roundtrip",
							toolName: "Read",
							inputJson: { file_path: "/tmp/a" },
							outputJson: "file contents",
							status: "success",
						},
					],
				},
			],
			"gemini-test:model",
		);

		expect(rebuilt.history).toEqual(pushed);
		expect(rebuilt.trailingToolResults).toEqual([
			{
				type: "function_result",
				call_id: "call_roundtrip",
				name: "Read",
				result: "file contents",
			},
		]);
	});

	test("lightweight generation streams Interactions deltas and usage", async () => {
		let requestUrl = "";
		let requestHeaders = new Headers();
		let requestBody: Record<string, unknown> = {};
		const deltas: string[] = [];
		setOutboundFetchOverrideForTest(async (input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse([
				{
					event: "step.start",
					data: {
						event_type: "step.start",
						index: 0,
						step: { type: "model_output", content: "Hello" },
					},
				},
				{
					event: "step.delta",
					data: { event_type: "step.delta", index: 0, delta: { text: " world" } },
				},
				{
					event: "interaction.completed",
					data: {
						event_type: "interaction.completed",
						interaction: {
							status: "completed",
							usage: {
								total_input_tokens: 9,
								total_cached_tokens: 2,
								total_output_tokens: 3,
								total_thought_tokens: 1,
							},
						},
					},
				},
			]);
		});

		const result = await makeProvider().generateWithMeta(
			"hello",
			"gemini-test:gemini-3-flash-preview",
			undefined,
			{
				reasoningEffort: "none",
				onTextDelta: async (delta) => {
					deltas.push(delta);
					await Promise.resolve();
				},
			},
		);

		expect(requestUrl).toBe("https://gemini.example.test/v1beta/interactions");
		expect(requestHeaders.get("Accept")).toBe("text/event-stream");
		expect(requestBody.stream).toBe(true);
		expect(requestBody.store).toBe(false);
		// `none` lands on `minimal` for a Gemini 3 model: that family exposes the
		// full ladder including `minimal`, so the lowest real tier is used. (The
		// retired 2.5 family had no `minimal`, so the same request clamped to `low`.)
		expect(requestBody.generation_config).toEqual({
			thinking_level: "minimal",
			thinking_summaries: "auto",
		});
		expect(deltas).toEqual(["Hello", " world"]);
		expect(result).toEqual({
			text: "Hello world",
			usage: {
				inputTokens: 9,
				outputTokens: 3,
				cachedInputTokens: 2,
				cacheCreationInputTokens: 0,
				reasoningTokens: 1,
			},
		});
	});

	test("streaming lightweight generation maps failed Interactions status", async () => {
		let requestBody: Record<string, unknown> = {};
		setOutboundFetchOverrideForTest(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse([
				{
					event: "interaction.failed",
					data: {
						event_type: "interaction.failed",
						interaction: {
							status: "failed",
							incomplete_details: { reason: "safety", message: "blocked by policy" },
						},
					},
				},
			]);
		});
		let thrown: Error | undefined;
		try {
			await makeProvider().generateWithMeta(
				"hello",
				"gemini-test:gemini-3-flash-preview",
				undefined,
				{
					reasoningEffort: "none",
				},
			);
		} catch (error) {
			thrown = error as Error;
		}
		expect(requestBody.stream).toBe(true);
		expect(thrown?.message).toContain("blocked by policy");
	});

	test("clamps thinking levels to each model family and omits them for non-thinking models", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		setOutboundFetchOverrideForTest(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(
				JSON.stringify({
					status: "completed",
					steps: [{ type: "model_output", content: "ok" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const provider = makeProvider();
		await provider.generateWithMeta("hello", "gemini-test:gemini-3.1-pro-preview", undefined, {
			reasoningEffort: "medium",
		});
		await provider.generateWithMeta("hello", "gemini-test:gemini-3-pro-preview", undefined, {
			reasoningEffort: "medium",
		});
		await provider.generateWithMeta(
			"hello",
			"gemini-test:gemini-3.1-flash-lite-image-preview",
			undefined,
			{ reasoningEffort: "medium" },
		);
		await provider.generateWithMeta("hello", "gemini-test:gemma-3-27b-it", undefined, {
			reasoningEffort: "high",
		});

		expect(bodies.map((body) => body.generation_config)).toEqual([
			// 3.1-pro: low/medium/high ladder, so medium passes through.
			{ thinking_level: "medium", thinking_summaries: "auto" },
			// 3-pro: low/high only, so medium clamps up to high.
			{ thinking_level: "high", thinking_summaries: "auto" },
			// 3.1-flash-lite-image: minimal/high only, so medium clamps up to high.
			{ thinking_level: "high", thinking_summaries: "auto" },
			// gemma is not a thinking model: no generation_config at all.
			undefined,
		]);
	});

	test("enforces per-SSE-event hard limit without cloning the whole stream dump", async () => {
		const dump = new ApiRequestDumpCollector();
		const huge = "x".repeat(maxSseEventBytes + 1);
		setOutboundFetchOverrideForTest(
			async () =>
				new Response(`event: step.delta\ndata: ${huge}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		let thrown: Error | undefined;
		try {
			await collect(makeProvider().chat(baseChatParams({ requestDump: dump }) as never));
		} catch (error) {
			thrown = error as Error;
		}
		expect(thrown?.message).toContain("SSE event exceeded hard limit");
		const snapshot = dump.snapshot();
		expect(snapshot.response?.bodyText?.length ?? 0).toBeLessThanOrEqual(1024 * 1024 + 40);
		expect(snapshot.response?.error).toContain("hard limit");
	});

	test("accepts one chunk whose complete small frames exceed the per-event limit in aggregate", async () => {
		const padding = "x".repeat(Math.floor(maxSseEventBytes / 3));
		const frames = Array.from(
			{ length: 4 },
			(_, index) =>
				`event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: `int-small-${index}` }, padding })}\r\n\r\n`,
		);
		const payload = frames.join("");
		expect(frames.every((frame) => byteLengthForTest(frame) < maxSseEventBytes)).toBe(true);
		expect(byteLengthForTest(payload)).toBeGreaterThan(maxSseEventBytes);
		setOutboundFetchOverrideForTest(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(payload));
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		const events = await collect(makeProvider().chat(baseChatParams() as never));
		expect(events.length).toBe(frames.length);
	});

	test("rejects a stream that exceeds the total stream limit", async () => {
		const oversized = new Uint8Array(maxStreamBytes + 1);
		setOutboundFetchOverrideForTest(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(oversized);
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		await expect(collect(makeProvider().chat(baseChatParams() as never))).rejects.toThrow(
			"SSE stream exceeded",
		);
	});

	test("maps SSE error and HTTP status without masking upstream details", async () => {
		setOutboundFetchOverrideForTest(async () =>
			sseResponse([
				{
					event: "error",
					data: {
						event_type: "error",
						error: { status: "RESOURCE_EXHAUSTED", code: 429, message: "quota exhausted" },
					},
				},
			]),
		);
		const events = await collect(makeProvider().chat(baseChatParams() as never));
		expect(events).toEqual([
			{ invalidState: { reason: "resource_exhausted", message: "quota exhausted" } },
		]);

		setOutboundFetchOverrideForTest(
			async () =>
				new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
		);
		let thrown: { status?: number; message?: string } | undefined;
		try {
			await collect(makeProvider().chat(baseChatParams() as never));
		} catch (error) {
			thrown = error as { status?: number; message?: string };
		}
		expect(thrown?.status).toBe(429);
		expect(thrown?.message).toContain("rate limited");
	});
});
