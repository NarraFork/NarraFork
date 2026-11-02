import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestRecording } from "@shared/request-recording";
import { z } from "zod/v4";
import {
	customApiProviderToGemini,
	geminiProviderToCustomApi,
} from "../../settings/custom-api-providers";
import type { CustomApiProviderConfig } from "../../settings/types";
import type { DbMessage, ParsedStreamEvent } from "../provider";
import { ApiRequestDumpCollector } from "../request-dump";

interface TestGeminiProvider {
	formatTools(tools: unknown[]): unknown[];
	buildHistory(
		messages: DbMessage[],
		model: string,
		owner?: string,
	): Promise<{ history: unknown[] }>;
	chat(params: Record<string, unknown>): AsyncGenerator<ParsedStreamEvent>;
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
		outputTruncated?: boolean;
		usage?: {
			inputTokens: number;
			outputTokens: number;
			cachedInputTokens?: number;
			cacheCreationInputTokens?: number;
			reasoningTokens?: number;
		} | null;
	}>;
	generateWithHistoryWithMeta(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: Parameters<TestGeminiProvider["generateWithMeta"]>[3],
	): ReturnType<TestGeminiProvider["generateWithMeta"]>;
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

describe("Gemini parallel tool media attribution", () => {
	test("preserves source IDs for live and replayed audio/video without changing images", async () => {
		const audioBytes = Buffer.from(
			"524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000",
			"hex",
		);
		const videoBytes = Buffer.from("000000146674797069736f6d0000000069736f6d", "hex");
		const audio = { type: "audio", mediaType: "audio/wav", base64: audioBytes.toString("base64") };
		const video = { type: "video", mediaType: "video/mp4", base64: videoBytes.toString("base64") };
		for (const [kind, provider] of [
			["generate", makeGenerateContentProvider()],
			["interactions", makeProvider()],
		] as const) {
			type Part = {
				text?: string;
				type?: string;
				data?: string;
				inlineData?: { mimeType: string; data: string };
				functionResponse?: { name: string; response: Record<string, unknown> };
			};
			type Step = {
				type?: string;
				parts?: Part[];
				content?: Part[];
				call_id?: string;
				name?: string;
			};
			const requests: Array<{ contents: Step[]; input: Step[] }> = [];
			setOutboundFetchOverrideForTest(async (_input, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return kind === "generate"
					? sseResponse([
							{
								event: "message",
								data: {
									candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
								},
							},
						])
					: sseResponse([
							{
								event: "interaction.completed",
								data: { event_type: "interaction.completed", interaction: { status: "completed" } },
							},
						]);
			});
			const ids = ["read-audio", "read-video"];
			const media = [audio, video];
			const toolResults = ids.map((id, index) =>
				kind === "generate"
					? {
							name: "Read",
							toolUseId: id,
							response: { output: "ok" },
							mediaParts: [
								{ inlineData: { mimeType: media[index].mediaType, data: media[index].base64 } },
							],
						}
					: {
							type: "function_result",
							call_id: id,
							name: "Read",
							result: "ok",
							_nativeMedia: [media[index]],
						},
			);
			await collect(provider.chat(baseChatParams({ content: "", toolResults })));
			const turns = [
				{
					kind: "tool_results",
					envelopeId: "a",
					results: ids.map((wireId, index) => ({
						wireId,
						name: "Read",
						text: "ok",
						isError: false,
						images: [],
						media: [media[index]],
					})),
				},
			];
			const projector = provider as unknown as {
				geminiWireHistory(turns: unknown[]): unknown[];
				interactionsWireHistory(turns: unknown[]): unknown[];
			};
			const history =
				kind === "generate"
					? projector.geminiWireHistory(turns)
					: projector.interactionsWireHistory(turns);
			await collect(provider.chat(baseChatParams({ content: "", history })));
			for (const request of requests) {
				const steps = kind === "generate" ? request.contents : request.input;
				if (kind === "generate") {
					const responses = steps.flatMap((step) =>
						(step.parts ?? []).flatMap((part) =>
							part.functionResponse ? [part.functionResponse] : [],
						),
					);
					expect(responses).toEqual(
						ids.map((toolCallId) => ({ name: "Read", response: { output: "ok", toolCallId } })),
					);
				} else {
					expect(
						steps
							.filter((step) => step.type === "function_result")
							.map(({ name, call_id }) => ({ name, call_id })),
					).toEqual(ids.map((call_id) => ({ name: "Read", call_id })));
				}
				const mediaContainer =
					kind === "generate"
						? steps.find((step) =>
								step.parts?.some((part) => part.inlineData?.mimeType?.startsWith("audio/")),
							)?.parts
						: steps.find(
								(step) =>
									step.type === "user_input" &&
									Array.isArray(step.content) &&
									step.content.some((part) => part.type === "audio"),
							)?.content;
				if (!mediaContainer) throw new Error("Missing media container");
				for (const [index, item] of media.entries()) {
					const position = mediaContainer.findIndex((part) =>
						kind === "generate" ? part.inlineData?.data === item.base64 : part.data === item.base64,
					);
					expect(position).toBeGreaterThan(0);
					expect(mediaContainer[position - 1].text).toBe(
						`Tool result media source: ${JSON.stringify({ toolCallId: ids[index] })}`,
					);
				}
			}
			const imageResult =
				kind === "generate"
					? {
							name: "Read",
							toolUseId: "image",
							response: { output: "ok" },
							mediaParts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }],
						}
					: {
							type: "function_result",
							call_id: "image",
							name: "Read",
							result: [{ type: "image", mime_type: "image/png", data: "aW1hZ2U=" }],
						};
			await collect(provider.chat(baseChatParams({ content: "", toolResults: [imageResult] })));
			expect(JSON.stringify(requests[2])).not.toContain("Tool result media source:");
			if (kind === "generate") {
				const response = requests[2].contents
					.flatMap((step) => step.parts ?? [])
					.find((part) => part.functionResponse)?.functionResponse;
				expect(response).toEqual({ name: "Read", response: { output: "ok" } });
			}
		}
	});
});

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
		expect(events).toContainEqual({
			text: "ok",
			textOutputIndex: 0,
			textBlockId: "gemini:0:part:0",
		});
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

	test("does not replay opaque signatures across Gemini transports", async () => {
		const call = (toolUseId: string, source: string): DbMessage[] => [
			{
				id: `assistant-${toolUseId}`,
				role: "assistant",
				contentJson: [
					{
						type: "tool_use",
						id: toolUseId,
						name: "Read",
						input: { file_path: "/tmp/a" },
						thoughtSignature: "opaque-signature",
						thoughtSignatureSource: source,
					},
				],
				contentText: null,
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [
					{
						toolUseId,
						toolName: "Read",
						inputJson: { file_path: "/tmp/a" },
						outputJson: "contents",
						status: "success",
					},
				],
			},
		];
		const interactions = await makeProvider().buildHistory(
			call("cross-transport", "gemini:gemini-test:generate-content"),
			"gemini-test:model",
		);
		expect(interactions.history[0]).toEqual({
			type: "function_call",
			id: "cross-transport",
			name: "Read",
			arguments: { file_path: "/tmp/a" },
		});

		const generate = await makeGenerateContentProvider().buildHistory(
			call("same-transport", "gemini:gemini-generate-test:generate-content"),
			"gemini-generate-test:model",
		);
		expect(generate.history[0]).toEqual({
			role: "model",
			parts: [
				{
					functionCall: { name: "Read", args: { file_path: "/tmp/a" } },
					thoughtSignature: "opaque-signature",
				},
			],
		});
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
				// promptTokenCount 7 含缓存 1，归一到「input 不含缓存」后为 6。
				inputTokens: 6,
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

describe("Gemini input token accounting", () => {
	for (const api of ["generateContent", "interactions"] as const) {
		const model =
			api === "generateContent"
				? "gemini-generate-test:gemini-2.5-flash"
				: "gemini-test:gemini-3-flash-preview";
		const make = () => (api === "generateContent" ? makeGenerateContentProvider() : makeProvider());
		for (const prompt of [100, 0, undefined]) {
			for (const cached of [0, 40, 100, 120]) {
				test(`${api} total=${prompt} cached=${cached} normalizes JSON and SSE`, async () => {
					const usage =
						api === "generateContent"
							? {
									promptTokenCount: prompt,
									cachedContentTokenCount: cached,
									candidatesTokenCount: 7,
									thoughtsTokenCount: 2,
								}
							: {
									total_input_tokens: prompt,
									total_cached_tokens: cached,
									total_output_tokens: 7,
									total_thought_tokens: 2,
								};
					const data =
						api === "generateContent" ? { usageMetadata: usage } : { status: "completed", usage };
					const frames = [
						{
							event: api === "generateContent" ? "message" : "interaction.completed",
							data: api === "generateContent" ? data : { interaction: data },
						},
					];
					const expected = Math.max((prompt ?? 0) - cached, 0);
					for (const transport of ["JSON", "SSE"]) {
						setOutboundFetchOverrideForTest(async () =>
							transport === "SSE"
								? sseResponse(frames)
								: new Response(JSON.stringify(data), {
										headers: { "content-type": "application/json" },
									}),
						);
						const result = await make().generateWithMeta("hello", model);
						expect(result.usage).toEqual({
							inputTokens: expected,
							outputTokens: 7,
							cachedInputTokens: cached,
							cacheCreationInputTokens: 0,
							reasoningTokens: 2,
						});
					}
					setOutboundFetchOverrideForTest(async () => sseResponse(frames));
					const events = await collect(make().chat(baseChatParams({ model })));
					expect(events.find((event) => event.usage)?.usage).toMatchObject({
						promptTokens: prompt ?? 0,
						inputTokens: expected,
						completionTokens: 7,
					});
				});
			}
		}

		for (const inputTokens of [undefined, 0, 17]) {
			test(`${api} stream conversion preserves normalized input=${inputTokens}`, async () => {
				const provider = make() as TestGeminiProvider & {
					parseSSEStream: () => AsyncGenerator<ParsedStreamEvent>;
				};
				provider.parseSSEStream = async function* () {
					yield {
						usage: {
							promptTokens: 100,
							inputTokens,
							cachedInputTokens: 40,
							cacheCreationInputTokens: 20,
							completionTokens: 7,
							reasoningTokens: 2,
						},
					};
				};
				setOutboundFetchOverrideForTest(async () => sseResponse([]));
				const result = await provider.generateWithMeta("hello", model);
				expect(result.usage).toEqual({
					inputTokens: inputTokens ?? 40,
					outputTokens: 7,
					cachedInputTokens: 40,
					cacheCreationInputTokens: 20,
					reasoningTokens: 2,
				});
			});
		}
	}
});

describe("Gemini lightweight partial output regression", () => {
	const partialText = "  partial\ntext\t";
	for (const api of ["generateContent", "interactions"] as const) {
		for (const transport of ["SSE", "JSON"] as const) {
			for (const method of ["generateWithMeta", "generateWithHistoryWithMeta"] as const) {
				async function run(withText: boolean, withError = false) {
					const provider =
						api === "generateContent" ? makeGenerateContentProvider() : makeProvider();
					const model =
						api === "generateContent"
							? "gemini-generate-test:gemini-2.5-flash"
							: "gemini-test:gemini-3-flash-preview";
					const error = {
						code: 503,
						status: "UNAVAILABLE",
						message: "upstream unavailable max_tokens",
					};
					const text = withText ? partialText : "";
					const usage =
						api === "generateContent"
							? {
									promptTokenCount: 11,
									candidatesTokenCount: 7,
									cachedContentTokenCount: 3,
									thoughtsTokenCount: 2,
								}
							: {
									total_input_tokens: 11,
									total_output_tokens: 7,
									total_cached_tokens: 3,
									total_thought_tokens: 2,
								};
					const candidate = { content: { parts: [{ text }] }, finishReason: "MAX_TOKENS" };
					const incomplete = {
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					};
					const frames: Array<{ event: string; data: unknown }> =
						api === "generateContent"
							? [
									// The only text is carried by the finish chunk, with accounting following it.
									{ event: "message", data: { candidates: [candidate] } },
									{ event: "message", data: { usageMetadata: usage } },
								]
							: [
									{
										event: "step.start",
										data: { index: 0, step: { type: "model_output", content: text } },
									},
									{ event: "interaction.incomplete", data: { interaction: incomplete } },
									{
										event: "interaction.incomplete",
										data: { interaction: { ...incomplete, usage } },
									},
								];
					if (withError) frames.push({ event: "error", data: { error } });
					const json =
						api === "generateContent"
							? {
									candidates: [candidate],
									usageMetadata: usage,
									...(withError && { error }),
								}
							: {
									...incomplete,
									steps: [{ type: "model_output", content: text }],
									usage,
									...(withError && { status: "failed", error }),
								};
					setOutboundFetchOverrideForTest(async () =>
						transport === "SSE"
							? sseResponse(frames)
							: new Response(JSON.stringify(json), {
									headers: { "content-type": "application/json" },
								}),
					);
					const deltas: string[] = [];
					const options = {
						onTextDelta: async (delta: string) => {
							deltas.push(delta);
						},
					};
					const result =
						method === "generateWithMeta"
							? await provider.generateWithMeta("prompt", model, "system", options)
							: await provider.generateWithHistoryWithMeta(
									"system",
									"prompt",
									model,
									"en",
									options,
								);
					return { result, deltas };
				}

				test(`${api} ${method} ${transport} retains partial text and full trailing usage`, async () => {
					const { result, deltas } = await run(true);
					expect(result).toMatchObject({
						text: partialText,
						outputTruncated: true,
						usage: {
							// promptTokenCount 11 含缓存 3，归一到「input 不含缓存」后为 8。
							inputTokens: 8,
							outputTokens: 7,
							cachedInputTokens: 3,
							cacheCreationInputTokens: 0,
							reasoningTokens: 2,
						},
					});
					expect(deltas).toEqual([partialText]);
				});

				test(`${api} ${method} ${transport} still rejects a completion limit without text`, async () => {
					await expect(run(false)).rejects.toMatchObject({
						status: 422,
						message:
							api === "generateContent"
								? "Response truncated: model reached maximum token limit."
								: "Gemini interaction stopped after reaching its output budget.",
					});
				});

				test(`${api} ${method} ${transport} does not swallow a real error after partial output`, async () => {
					await expect(run(true, true)).rejects.toMatchObject({
						message: expect.stringContaining("upstream unavailable max_tokens"),
					});
				});
			}
		}
	}
});

describe("Gemini HTTP error diagnostics", () => {
	test("a non-2xx response carries status, envelope and retry-after in diagnostics", async () => {
		setOutboundFetchOverrideForTest(async () =>
			Response.json(
				{
					error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "5-hour usage limit reached" },
				},
				{ status: 429, headers: { "retry-after": "1800" } },
			),
		);
		const error = await makeGenerateContentProvider()
			.generateWithMeta("hello", "gemini-generate-test:gemini-2.5-flash")
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect(error).toMatchObject({
			status: 429,
			message: expect.stringContaining("Gemini API error 429:"),
			diagnostics: {
				statusCode: 429,
				message: "5-hour usage limit reached",
				responseHeaders: { "retry-after": "1800" },
			},
		});
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
			reasoningBlockId: "gemini:step:thought_1",
			reasoningMetadata: { gemini: { stepId: "thought_1", stepIndex: 0 } },
			reasoningOutputIndex: 0,
		});
		expect(events).toContainEqual({
			reasoningMetadata: {
				gemini: { stepId: "thought_1", stepIndex: 0, thoughtSignature: "sig_1" },
			},
			reasoningBlockId: "gemini:step:thought_1",
			reasoningOutputIndex: 0,
		});
		expect(events).toContainEqual({
			contentBoundary: {
				kind: "reasoning",
				phase: "complete",
				blockId: "gemini:step:thought_1",
				outputIndex: 0,
			},
		});
		expect(events).toContainEqual({
			text: "I'll read it.",
			textOutputIndex: 1,
			textBlockId: "gemini:step:1",
		});
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
		await collect(provider.chat(baseChatParams() as never));
		// The second request is the projection of the conversation so far.
		const { history } = await provider.buildHistory(
			[
				{
					id: "user-1",
					role: "user",
					contentJson: [{ type: "text", text: "hello" }],
					contentText: "hello",
					parentToolUseId: null,
					messageUuid: null,
				},
				{
					id: "assistant-1",
					role: "assistant",
					contentJson: [
						{
							type: "tool_use",
							id: "call_upstream",
							name: "Read",
							input: { file_path: "/tmp/a" },
							outputIndex: 0,
						},
					],
					contentText: null,
					parentToolUseId: null,
					messageUuid: null,
					toolCalls: [
						{
							toolUseId: "call_upstream",
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
		await collect(
			provider.chat(baseChatParams({ content: "", history, toolResults: [] }) as never),
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

	test("buildHistory keeps ordering, indices, and thought signatures", async () => {
		const provider = makeProvider();
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

		// Encounter order; the thought keeps its same-source signature, the call (whose
		// signature names no source) does not carry one.
		expect(rebuilt.history).toEqual([
			{ type: "user_input", content: "question" },
			{
				type: "thought",
				id: "thought_roundtrip",
				signature: "sig_roundtrip",
				summary: [{ type: "text", text: "reasoning summary" }],
			},
			{ type: "model_output", content: "answer prefix" },
			{
				type: "function_call",
				id: "call_roundtrip",
				name: "Read",
				arguments: { file_path: "/tmp/a" },
			},
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
				// total_input_tokens 9 含缓存 2，归一到「input 不含缓存」后为 7。
				inputTokens: 7,
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

	test("enforces per-SSE-event hard limit and records the error on the recording", async () => {
		const metas: Record<string, unknown>[] = [];
		let chunkBytes = 0;
		const recording: RequestRecording = {
			requestId: "gemini-hard-limit",
			pin: () => {},
			request: () => {},
			responseMeta: (meta) => metas.push(meta),
			responseChunk: (chunk) => {
				chunkBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
			},
			frame: () => {},
			finish: () => {},
		};
		const dump = new ApiRequestDumpCollector(recording);
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
		// The raw bytes reach the recorder (bounded by its ring window, not an in-memory copy).
		expect(chunkBytes).toBeGreaterThan(0);
		expect(metas.find((meta) => typeof meta.error === "string")?.error).toContain("hard limit");
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

// Exercise both transports through the real outbound request path.
for (const transport of ["generate-content", "interactions"] as const) {
	describe(`Gemini ${transport} request compatibility`, () => {
		function provider(config: Record<string, unknown> = {}): TestGeminiProvider {
			const Constructor =
				transport === "interactions" ? GeminiProvider : GeminiGenerateContentProvider;
			const converted = customApiProviderToGemini({
				id: "gem-headers",
				name: "Gemini",
				prefix: "gem-headers",
				protocol: "gemini-compatible",
				defaultModel: "gemini-2.5-flash",
				geminiTransport: transport,
				apiKey: "test-key",
				baseUrl: "https://opencode.ai/inference/go/v1",
				userAgentMode: "narrafork",
				...config,
			} as CustomApiProviderConfig);
			if (!converted) throw new Error("Gemini conversion failed");
			// Include legacy round-tripping so fingerprint settings cannot disappear in projections.
			const roundTrip = customApiProviderToGemini(geminiProviderToCustomApi(converted));
			return new Constructor(roundTrip as unknown as Record<string, unknown>);
		}

		function captureRequests(): Array<{ headers: Headers; body: Record<string, unknown> }> {
			const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
			setOutboundFetchOverrideForTest(async (_input, init) => {
				requests.push({
					headers: new Headers(init?.headers),
					body: JSON.parse(String(init?.body)),
				});
				return transport === "interactions"
					? sseResponse([
							{
								event: "interaction.completed",
								data: {
									event_type: "interaction.completed",
									interaction: { status: "completed" },
								},
							},
						])
					: sseResponse([
							{
								event: "message",
								data: {
									candidates: [
										{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" },
									],
								},
							},
						]);
			});
			return requests;
		}

		test("sends stable per-conversation OpenCode identity and the configured fingerprint", async () => {
			const requests = captureRequests();
			const adapter = provider({
				userAgentMode: "custom",
				customUserAgent: "Gemini-Test/1",
				extraHeaders: { "X-Test": "configured" },
			});
			for (const conversationId of ["conv-one", "conv-one", "conv-two"]) {
				await collect(adapter.chat(baseChatParams({ conversationId })));
			}
			const first = requests[0].headers;
			expect(first.get("user-agent")).toBe("Gemini-Test/1");
			expect(first.get("x-test")).toBe("configured");
			expect(first.get("x-goog-api-key")).toBe("test-key");
			expect(first.get("x-opencode-session")).toBeTruthy();
			expect(requests[1].headers.get("x-opencode-session")).toBe(first.get("x-opencode-session"));
			expect(requests[2].headers.get("x-opencode-session")).not.toBe(
				first.get("x-opencode-session"),
			);
		});

		test("extra headers override defaults case-insensitively without duplicate values", async () => {
			const requests = captureRequests();
			await collect(
				provider({
					extraHeaders: {
						"USER-AGENT": "Override/2",
						"X-OpenCode-Session": "manual-session",
						"X-Goog-Api-Key": "override-key",
						"content-type": "application/json; charset=utf-8",
					},
				}).chat(baseChatParams()),
			);
			expect(requests[0].headers.get("user-agent")).toBe("Override/2");
			expect(requests[0].headers.get("x-opencode-session")).toBe("manual-session");
			expect(requests[0].headers.get("x-goog-api-key")).toBe("override-key");
			expect(requests[0].headers.get("content-type")).toBe("application/json; charset=utf-8");
		});

		test("does not add OpenCode identity to other hosts", async () => {
			const requests = captureRequests();
			await collect(
				provider({ baseUrl: "https://generativelanguage.googleapis.com/v1beta" }).chat(
					baseChatParams(),
				),
			);
			expect(requests[0].headers.has("x-opencode-session")).toBe(false);
			expect(requests[0].headers.get("user-agent")).toMatch(/narrafork/i);
		});

		test("auxiliary generation also applies fingerprint and fallback session headers", async () => {
			const requests = captureRequests();
			const adapter = provider({ extraHeaders: { "user-agent": "Auxiliary/1", "X-Test": "aux" } });
			await adapter.generateWithMeta("hello", "gemini-2.5-flash");
			await adapter.generateWithMeta("hello again", "gemini-2.5-flash");
			expect(requests[0].headers.get("user-agent")).toBe("Auxiliary/1");
			expect(requests[0].headers.get("x-test")).toBe("aux");
			expect(requests[0].headers.get("accept")).toBe("text/event-stream");
			expect(requests[0].headers.get("x-opencode-session")).toBeTruthy();
			expect(requests[1].headers.get("x-opencode-session")).toBe(
				requests[0].headers.get("x-opencode-session"),
			);
		});

		test("emits valid nested function schemas for literal and enum constraints", async () => {
			const requests = captureRequests();
			const adapter = provider();
			const properties = {
				confirm: { type: "boolean", const: true },
				cancel: { type: "boolean", const: false },
				count: { type: "integer", const: 1, minimum: 0 },
				action: { type: "string", const: "approve" },
				flag: { type: "boolean", enum: [true, false] },
				numbers: { type: "array", items: { type: "number", enum: [1, 2] } },
				mixed: {
					anyOf: [
						{ type: "boolean", const: true },
						{ type: "string", enum: ["yes", "no"] },
					],
				},
				// A property named const or enum must not itself be interpreted as a keyword.
				const: { type: "boolean", const: true },
				enum: { type: "string", const: "literal" },
			};
			const tools = adapter.formatTools([
				{
					name: "DangerConfirm",
					description: "Confirm",
					parameters: z.object({ confirm: z.literal(true) }),
					rawJsonSchema: { type: "object", properties, required: ["confirm"] },
				},
			]);
			await collect(adapter.chat(baseChatParams({ tools })));
			const body = requests[0].body;
			const declarations = body.tools as Array<{
				parameters?: unknown;
				functionDeclarations?: Array<{ parameters: unknown }>;
			}>;
			const parameters =
				transport === "interactions"
					? declarations[0].parameters
					: declarations[0].functionDeclarations?.[0].parameters;
			expect(parameters).toEqual({
				type: "object",
				required: ["confirm"],
				properties: {
					confirm: { type: "boolean" },
					cancel: { type: "boolean" },
					count: { type: "integer", minimum: 0 },
					action: { type: "string", enum: ["approve"] },
					flag: { type: "boolean" },
					numbers: { type: "array", items: { type: "number" } },
					mixed: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["yes", "no"] }] },
					const: { type: "boolean" },
					enum: { type: "string", enum: ["literal"] },
				},
			});
		});
	});
}
