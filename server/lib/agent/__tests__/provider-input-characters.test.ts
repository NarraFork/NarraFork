import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ContextInputCharacters } from "@shared/context-usage";
import NodeWebSocket from "ws";
import { settings } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import { CodexProvider } from "../codex-provider";
import { clearCodexResponsesWebSocketSessions } from "../codex-websocket";
import { GeminiInteractionsProvider } from "../gemini-interactions-provider";
import { GeminiProvider } from "../gemini-provider";
import { countInputCharacters } from "../input-characters";
import {
	dedupOpenAIHistoryImages,
	imageRefForBase64,
	restoreOpenAIHistoryImages,
} from "../nug-image-dedup";
import { CODEX_DEFAULT_INSTRUCTIONS, OpenAIProvider } from "../openai-provider";
import type { ChatParams, ProviderAdapter } from "../provider";
import { resetUnsupportedParameterMemory } from "../unsupported-parameter-fallback";

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
const NativeNodeWebSocket = NodeWebSocket;
afterEach(async () => {
	globalThis.fetch = realFetch;
	globalThis.WebSocket = realWebSocket;
	resetUnsupportedParameterMemory();
	await clearCodexResponsesWebSocketSessions();
});
function params(overrides: Partial<ChatParams> = {}): ChatParams {
	return {
		conversationId: "input-test",
		content: "current😀",
		model: "input:glm-5.1",
		cwd: process.cwd(),
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		...overrides,
	};
}
function openai(codexWebSocket = false): OpenAIProvider {
	return new OpenAIProvider({
		id: "input",
		name: "input",
		prefix: "input",
		apiKey: "test",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "glm-5.1",
		apiMode: codexWebSocket ? "codex" : "responses",
		codexWebSocket,
	});
}
async function drive(provider: ProviderAdapter, chat: ChatParams): Promise<void> {
	for await (const _event of provider.chat(chat)) {
		/* Drain. */
	}
}

describe("providers report their final logical inputs", () => {
	test("Anthropic, OpenAI Responses/completions and Gemini report before HTTP transport", async () => {
		const cases: Array<{
			provider: ProviderAdapter;
			history: unknown[];
			model: string;
			tools: unknown[];
			completions?: boolean;
			responses?: boolean;
		}> = [
			{
				provider: new AnthropicProvider({
					id: "input",
					name: "input",
					prefix: "input",
					apiKey: "test",
					baseUrl: "https://example.invalid/v1",
					defaultModel: "claude-sonnet-4-6",
					officialApi: true,
				}),
				history: [{ role: "user", content: [{ type: "text", text: "history" }] }],
				model: "input:claude-sonnet-4-6",
				tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
			},
			{
				provider: openai(),
				history: [
					{ role: "user", content: "history" },
					{ role: "system", content: "historical-system" },
					{ role: "developer", content: "historical-developer" },
				],
				model: "input:glm-5.1",
				responses: true,
				tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
			},
			{
				provider: new OpenAIProvider({
					id: "input",
					name: "input",
					prefix: "input",
					apiKey: "test",
					baseUrl: "https://example.invalid/v1",
					defaultModel: "glm-5.1",
					apiMode: "completions",
				}),
				history: [
					{ role: "user", content: "history" },
					{ role: "system", content: "historical-system" },
					{ role: "developer", content: "historical-developer" },
				],
				model: "input:glm-5.1",
				completions: true,
				tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
			},
			{
				provider: new GeminiProvider({
					id: "input",
					name: "input",
					prefix: "input",
					apiKey: "test",
					baseUrl: "https://example.invalid",
					defaultModel: "gemini-2.5-pro",
				}),
				history: [{ role: "user", parts: [{ text: "history" }] }],
				model: "input:gemini-2.5-pro",
				tools: [{ functionDeclarations: [{ name: "Read", parameters: { type: "object" } }] }],
			},
		];
		for (const item of cases) {
			const snapshots: Array<ContextInputCharacters | null> = [];
			let sent: unknown;
			globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
				expect(snapshots).toHaveLength(1);
				sent = JSON.parse(String(init?.body));
				return new Response("test failure", { status: 500 });
			}) as unknown as typeof fetch;
			item.provider.injectSystemPrompt(item.history, "system", item.model);
			try {
				await drive(
					item.provider,
					params({
						history: item.history,
						model: item.model,
						tools: item.tools,
						onInputCharacters: (counts) => snapshots.push(counts),
					}),
				);
			} catch {
				/* Mocked upstream failure. */
			}
			expect(sent).toBeDefined();
			expect(snapshots).toEqual([
				await countInputCharacters(sent, undefined, {
					firstMessageIsRuntimeSystem: item.completions,
					instructionsFixedChars: item.responses
						? (item.history[0] as { content: string }).content.length
						: undefined,
				}),
			]);
			if (item.responses) {
				const body = sent as { instructions: string };
				const runtime = (item.history[0] as { content: string }).content;
				expect(body.instructions).toBe(`${runtime}\n\nhistorical-system\n\nhistorical-developer`);
				expect(snapshots[0]?.systemChars).toBe(runtime.length);
				expect(snapshots[0]?.totalChars).toBe(
					body.instructions.length + "historycurrent😀".length + (snapshots[0]?.toolsChars ?? 0),
				);
			}
			if (item.completions) {
				const body = sent as { messages: Array<{ role: string; content: string }> };
				expect(body.messages[0].role).toBe("system");
				expect(snapshots[0]?.systemChars).toBe(body.messages[0].content.length);
				const allText = body.messages.reduce((sum, message) => sum + message.content.length, 0);
				expect(snapshots[0]?.totalChars).toBe(allText + (snapshots[0]?.toolsChars ?? 0));
				expect(body.messages.some((message) => message.content === "historical-system")).toBe(true);
				expect(body.messages.some((message) => message.content === "historical-developer")).toBe(
					true,
				);
			}
			expect(snapshots[0]?.totalChars).toBeGreaterThan("historycurrent😀system".length);
			expect(snapshots[0]?.systemChars).toBeGreaterThanOrEqual(6);
			expect(snapshots[0]?.toolsChars).toBeGreaterThan(0);
		}
	});

	test("Completions first historical system/developer is not mistaken for runtime injection", async () => {
		const provider = new OpenAIProvider({
			id: "input",
			name: "input",
			prefix: "input",
			apiKey: "test",
			baseUrl: "https://example.invalid",
			defaultModel: "glm-5.1",
			apiMode: "completions",
		});
		globalThis.fetch = (async () =>
			new Response("test failure", { status: 500 })) as unknown as typeof fetch;
		for (const role of ["system", "developer"]) {
			const snapshots: Array<ContextInputCharacters | null> = [];
			try {
				await drive(
					provider,
					params({
						history: [
							{ role, content: "historical prefix" },
							{ role: "user", content: "old user" },
						],
						onInputCharacters: (value) => snapshots.push(value),
					}),
				);
			} catch {
				/* Mocked failure. */
			}
			expect(snapshots).toEqual([
				{ systemChars: 0, toolsChars: 0, totalChars: "historical prefixold usercurrent😀".length },
			]);
		}
	});

	test("runtime provenance survives delegate replacement, not identical historical text or JSON clones", async () => {
		const injecting = new OpenAIProvider({
			id: "input",
			name: "input",
			prefix: "input",
			apiKey: "test",
			baseUrl: "https://example.invalid",
			defaultModel: "glm-5.1",
			apiMode: "completions",
		});
		const delegate = new OpenAIProvider({
			id: "input",
			name: "input",
			prefix: "input",
			apiKey: "test",
			baseUrl: "https://example.invalid",
			defaultModel: "glm-5.1",
			apiMode: "completions",
		});
		const history: unknown[] = [];
		injecting.injectSystemPrompt(history, "runtime", "input:glm-5.1");
		const original = history[0] as { role: string; content: string };
		globalThis.fetch = (async () =>
			new Response("test failure", { status: 500 })) as unknown as typeof fetch;
		for (const message of [original, structuredClone(original)]) {
			const snapshots: Array<ContextInputCharacters | null> = [];
			const currentHistory = [
				message,
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }],
				},
			];
			const dedup = dedupOpenAIHistoryImages(currentHistory, new Set([imageRefForBase64("AQID")]));
			expect(dedup.stripped.size).toBe(1);
			expect(currentHistory[0]).toBe(message);
			try {
				await drive(
					delegate,
					params({ history: currentHistory, onInputCharacters: (value) => snapshots.push(value) }),
				);
			} catch {
				/* Mocked failure. */
			} finally {
				restoreOpenAIHistoryImages(currentHistory, dedup.stripped);
			}
			expect(snapshots[0]?.systemChars).toBe(message === original ? original.content.length : 0);
			expect(snapshots[0]?.totalChars).toBe(original.content.length + "current😀".length);
		}
	});

	test("Codex HTTP generated default instructions are fixed, identical historical text is not", async () => {
		const provider = new OpenAIProvider({
			id: "input",
			name: "input",
			prefix: "input",
			apiKey: "test",
			baseUrl: "https://example.invalid",
			defaultModel: "gpt-5.5",
			apiMode: "codex",
			codexWebSocket: false,
			codexWebSearch: false,
			codexImageGeneration: false,
		});
		globalThis.fetch = (async () =>
			new Response("test failure", { status: 500 })) as unknown as typeof fetch;
		for (const historical of [false, true]) {
			const snapshots: Array<ContextInputCharacters | null> = [];
			try {
				await drive(
					provider,
					params({
						model: "codex:gpt-5.5",
						history: historical ? [{ role: "developer", content: CODEX_DEFAULT_INSTRUCTIONS }] : [],
						onInputCharacters: (value) => snapshots.push(value),
					}),
				);
			} catch {
				/* Mocked failure. */
			}
			expect(snapshots[0]?.systemChars).toBe(historical ? 0 : CODEX_DEFAULT_INSTRUCTIONS.length);
			expect((snapshots[0]?.totalChars ?? 0) - (snapshots[0]?.toolsChars ?? 0)).toBe(
				CODEX_DEFAULT_INSTRUCTIONS.length + "current😀".length,
			);
		}
	});

	test("Gemini generateContent final native functionResponse parts exclude image bytes", async () => {
		const provider = new GeminiProvider({
			id: "input",
			name: "input",
			prefix: "input",
			apiKey: "test",
			baseUrl: "https://example.invalid",
			defaultModel: "gemini-2.5-pro",
		});
		const response = { inlineData: { data: "legal user JSON" }, signature: "legal" };
		const native = {
			name: "Read",
			id: "call-1",
			response,
			parts: [
				{ inlineData: { mimeType: "image/png", data: "image-bytes".repeat(10000) } },
				{ text: "attached text" },
			],
		};
		const snapshots: Array<ContextInputCharacters | null> = [];
		let sent: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body));
			return new Response("test failure", { status: 500 });
		}) as unknown as typeof fetch;
		try {
			await drive(
				provider,
				params({
					model: "input:gemini-2.5-pro",
					history: [{ role: "user", parts: [{ functionResponse: native }] }],
					onInputCharacters: (value) => snapshots.push(value),
				}),
			);
		} catch {
			/* Mocked upstream failure. */
		}
		expect(sent.contents).toEqual([
			{ role: "user", parts: [{ functionResponse: native }] },
			{ role: "user", parts: [{ text: "current😀" }] },
		]);
		expect(snapshots).toEqual([
			{
				totalChars:
					JSON.stringify({ name: "Read", id: "call-1", response }).length +
					"attached textcurrent😀".length,
				systemChars: 0,
				toolsChars: 0,
			},
		]);
	});

	test("Gemini Interactions reports complete final input and rejects upstream-only chain denominators", async () => {
		const provider = new GeminiInteractionsProvider({
			id: "input",
			name: "input",
			prefix: "input",
			apiKey: "test",
			baseUrl: "https://example.invalid",
			defaultModel: "gemini-2.5-pro",
		});
		const args = { signature: "legal user JSON", encrypted_content: "also legal" };
		const tools = [{ type: "function", name: "Read", parameters: { type: "object" } }];
		const history: unknown[] = [
			{ type: "user_input", content: "history" },
			{
				type: "thought",
				signature: "cipher".repeat(10000),
				summary: [{ type: "text", text: "thought" }],
			},
			{
				type: "function_call",
				id: "call-1",
				name: "Read",
				arguments: args,
				signature: "cipher".repeat(10000),
			},
			{ type: "model_output", content: [{ type: "text", text: "reply" }] },
		];
		provider.injectSystemPrompt(history, "system", "input:gemini-2.5-pro");
		const toolResult = provider.formatToolResult(
			"call-1",
			"result",
			false,
			[{ format: "png", base64: "image-bytes".repeat(10000) }],
			"Read",
		);
		const snapshots: Array<ContextInputCharacters | null> = [];
		let sent: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			expect(snapshots).toHaveLength(1);
			sent = JSON.parse(String(init?.body));
			return new Response("test failure", { status: 500 });
		}) as unknown as typeof fetch;
		const chat = params({
			model: "input:gemini-2.5-pro",
			history,
			tools,
			toolResults: [toolResult],
			onInputCharacters: (value) => snapshots.push(value),
		});
		try {
			await drive(provider, chat);
		} catch {
			/* Mocked upstream failure. */
		}
		const systemChars = String(sent.system_instruction).length;
		const toolsChars = JSON.stringify(tools[0]).length;
		expect(sent.previous_interaction_id).toBeUndefined();
		expect(sent.store).toBe(false);
		expect(snapshots[0]).toEqual({
			systemChars,
			toolsChars,
			totalChars:
				systemChars +
				toolsChars +
				"historythoughtreplyresultcurrent😀".length +
				JSON.stringify({ name: "Read", arguments: args }).length,
		});
		// Simulate a future chained transport path: the upstream-only prefix is not reconstructible.
		const builder = provider as unknown as {
			buildRequestBody: (options: unknown) => Record<string, unknown>;
		};
		const originalBuilder = builder.buildRequestBody.bind(provider);
		builder.buildRequestBody = (options) => ({
			...originalBuilder(options),
			previous_interaction_id: "upstream-prefix",
			input: [{ type: "user_input", content: "delta" }],
		});
		snapshots.length = 0;
		try {
			await drive(provider, chat);
		} catch {
			/* Mocked upstream failure. */
		}
		expect(sent.previous_interaction_id).toBe("upstream-prefix");
		expect(snapshots).toEqual([null]);
	});

	test("OpenAI internal unsupported-field retry overwrites rather than accumulating", async () => {
		const snapshots: Array<ContextInputCharacters | null> = [];
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			if (requests === 1)
				return new Response(
					JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;
		await drive(
			openai(),
			params({ maxOutputTokens: 128, onInputCharacters: (counts) => snapshots.push(counts) }),
		);
		expect(requests).toBe(2);
		expect(snapshots).toHaveLength(2);
		expect(snapshots[1]).toEqual(snapshots[0]);
		expect(snapshots[0]?.totalChars).toBe("current😀".length);
	});

	for (const managed of [false, true]) {
		test(`${managed ? "managed Codex" : "OpenAI Codex"} WS counts full history even when transport sends delta`, async () => {
			const frames: Array<Record<string, unknown>> = [];
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch(request, server) {
					if (server.upgrade(request)) return;
					return new Response("no", { status: 400 });
				},
				websocket: {
					message(ws, message) {
						frames.push(JSON.parse(String(message)));
						ws.send(
							JSON.stringify({
								type: "response.created",
								response: { id: `response-${frames.length}` },
							}),
						);
						ws.send(
							JSON.stringify({
								type: "response.completed",
								response: {
									id: `response-${frames.length}`,
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 0 },
								},
							}),
						);
					},
				},
			});
			const target = `ws://127.0.0.1:${server.port}/responses`;
			mock.module("ws", () => ({
				default: class extends NativeNodeWebSocket {
					constructor(_url: string | URL, options?: NodeWebSocket.ClientOptions) {
						super(target, options);
					}
				},
			}));
			const provider = managed
				? new CodexProvider({ useWebSocket: true, useWebSearch: false, useImageGeneration: false })
				: openai(true);
			let restore = () => {};
			if (managed) {
				const manager = (provider as unknown as { manager: Record<string, unknown> }).manager;
				const keys = ["acquireContext", "refreshUsageOnUseIfNeeded", "snapshot", "reportSuccess"];
				const saved = keys.map((key) => manager[key]);
				manager.acquireContext = async () => ({
					id: "test-credential",
					token: "test",
					authorization: "Bearer test",
					credential: {
						accountId: "test",
						disabled: false,
						expiresAt: Date.now() + 3600000,
						authMode: "oauth",
					},
				});
				manager.refreshUsageOnUseIfNeeded = async () => {};
				manager.snapshot = () => ({ available: 1, entries: [] });
				manager.reportSuccess = () => {};
				restore = () => {
					keys.forEach((key, index) => {
						manager[key] = saved[index];
					});
				};
			}
			const oldProxy = settings.codex?.proxy;
			if (settings.codex) settings.codex.proxy = { mode: "direct" };
			const snapshots: Array<ContextInputCharacters | null> = [];
			const history: unknown[] = [];
			provider.injectSystemPrompt(history, "system", "codex:gpt-5.5");
			try {
				const chat = params({
					model: "codex:gpt-5.5",
					history,
					content: "first",
					conversationId: `input-ws-${managed}`,
					onInputCharacters: (counts) => snapshots.push(counts),
				});
				await drive(provider, chat);
				provider.pushUserTurn(history, "first", chat.model, []);
				await drive(provider, { ...chat, content: "second" });
				expect(frames).toHaveLength(2);
				expect(frames[1].previous_response_id).toBe("response-1");
				expect(frames[1].input).toHaveLength(1);
				expect(snapshots).toHaveLength(2);
				expect(snapshots[0]).not.toBeNull();
				expect(snapshots[1]?.totalChars).toBe((snapshots[0]?.totalChars ?? 0) + "second".length);
				expect(snapshots[1]?.totalChars).toBeGreaterThan(
					(await countInputCharacters(frames[1]))?.totalChars ?? Infinity,
				);
				await drive(provider, {
					...chat,
					history: [],
					content: "default turn",
					conversationId: `input-ws-default-${managed}`,
					resetUpstreamSession: true,
				});
				expect(snapshots[2]?.systemChars).toBe(CODEX_DEFAULT_INSTRUCTIONS.length);
				expect((snapshots[2]?.totalChars ?? 0) - (snapshots[2]?.toolsChars ?? 0)).toBe(
					CODEX_DEFAULT_INSTRUCTIONS.length + "default turn".length,
				);
			} finally {
				restore();
				if (settings.codex) settings.codex.proxy = oldProxy;
				await clearCodexResponsesWebSocketSessions();
				server.stop(true);
				mock.module("ws", () => ({ default: NativeNodeWebSocket }));
			}
		});
	}
});
