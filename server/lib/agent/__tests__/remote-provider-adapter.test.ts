import { describe, expect, test } from "bun:test";
import type { ProviderStreamEvent } from "@server/lib/plugins/protocol";
import {
	type ProviderOperation,
	type ProviderOperationKind,
	ProviderRpcError,
} from "@server/services/plugin-provider-rpc";
import type { ChatParams, DbMessage } from "../provider";
import { RemoteProviderAdapter, type RemoteProviderRpcClient } from "../remote-provider-adapter";
import type { ResolvedToolDefinition } from "../types";

const MODEL = {
	id: "model-1",
	displayName: "Model 1",
	capabilities: {
		chat: true,
		generate: true,
		streaming: true,
		tools: true,
		sessionMode: "stateless" as const,
	},
};

function makeOperation(
	events: ProviderStreamEvent[] | (() => AsyncGenerator<ProviderStreamEvent>),
	kind: ProviderOperationKind = "chat",
	cancel?: () => Promise<void>,
): ProviderOperation {
	const eventGenerator =
		typeof events === "function"
			? events
			: async function* () {
					for (const event of events) yield event;
				};
	return {
		operationId: "op_test",
		requestId: "rpc_test",
		kind,
		state: "streaming",
		accepted: true,
		exposedToolCall: false,
		replaySafe: true,
		events: eventGenerator,
		cancel: async () => {
			await cancel?.();
			return { operationId: "op_test", state: "cancelling" };
		},
	} as ProviderOperation;
}

function makeRpc(
	chatEvents: ProviderStreamEvent[] | (() => AsyncGenerator<ProviderStreamEvent>) = [],
	generateEvents: ProviderStreamEvent[] | (() => AsyncGenerator<ProviderStreamEvent>) = [],
): RemoteProviderRpcClient & {
	chatParams?: Record<string, unknown>;
	generateParams?: Record<string, unknown>;
} {
	const rpc: RemoteProviderRpcClient & {
		chatParams?: Record<string, unknown>;
		generateParams?: Record<string, unknown>;
	} = {
		chat: async (params) => {
			rpc.chatParams = params as unknown as Record<string, unknown>;
			return makeOperation(chatEvents);
		},
		generate: async (params) => {
			rpc.generateParams = params as unknown as Record<string, unknown>;
			return makeOperation(generateEvents, "generate");
		},
	};
	return rpc;
}

function makeAdapter(rpc: RemoteProviderRpcClient): RemoteProviderAdapter {
	return new RemoteProviderAdapter({
		rpc,
		providerTypeId: "com.example/provider",
		providerInstanceId: "instance-1",
		providerPrefix: "remote",
		config: { apiKey: "secret-value", endpoint: "https://example.invalid" },
		modelCatalog: new Map([[MODEL.id, MODEL]]),
	});
}

function chatParams(overrides: Partial<ChatParams> = {}): ChatParams {
	return {
		conversationId: "conversation-1",
		content: "hello",
		model: "remote:model-1",
		cwd: "/private/worktree",
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		...overrides,
	};
}

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of stream) result.push(item);
	return result;
}

function event(
	type: ProviderStreamEvent["type"],
	value: Record<string, unknown>,
): ProviderStreamEvent {
	return { type, ...value } as ProviderStreamEvent;
}

describe("RemoteProviderAdapter", () => {
	test("formatTools emits only canonical tool definitions", () => {
		const adapter = makeAdapter(makeRpc());
		const tool = {
			name: "Read",
			description: "Read a file",
			parameters: {},
			rawJsonSchema: { type: "object", properties: { path: { type: "string" } } },
			execute: async () => ({ output: "never called" }),
		} as unknown as ResolvedToolDefinition;

		expect(adapter.formatTools([tool])).toEqual([
			{
				name: "Read",
				description: "Read a file",
				inputSchema: { type: "object", properties: { path: { type: "string" } } },
			},
		]);
		expect(JSON.stringify(adapter.formatTools([tool]))).not.toContain("execute");
	});

	test("buildHistory strips DB identity, JWT-like fields, and ToolContext", async () => {
		const adapter = makeAdapter(makeRpc());
		const message: DbMessage = {
			id: "db-secret-id",
			narratorId: "narrator-secret",
			role: "assistant",
			contentJson: [
				{
					type: "text",
					text: "done",
					jwt: "should-not-cross-rpc",
					context: { cwd: "/private/worktree", requestPermission: () => true },
				},
				{
					type: "tool_use",
					id: "call-1",
					name: "Read",
					input: { path: "README.md" },
				},
			],
			contentText: "done",
			parentToolUseId: "parent-secret",
			messageUuid: "uuid-secret",
			toolCalls: [
				{
					toolUseId: "call-1",
					toolName: "Read",
					inputJson: { path: "README.md" },
					outputJson: "contents",
					status: "success",
				},
			],
		};

		const result = await adapter.buildHistory([message], "remote:model-1");
		const serialized = JSON.stringify(result);
		expect(result.history).toHaveLength(1);
		expect(result.history[0]).toMatchObject({ role: "assistant" });
		expect(result.trailingToolResults).toEqual([
			{
				type: "tool_result",
				toolUseId: "call-1",
				name: "Read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
			},
		]);
		expect(serialized).not.toContain("db-secret-id");
		expect(serialized).not.toContain("narrator-secret");
		expect(serialized).not.toContain("should-not-cross-rpc");
		expect(serialized).not.toContain("requestPermission");
	});

	test("push methods and tool results keep canonical roles and media blocks", () => {
		const adapter = makeAdapter(makeRpc());
		const history: unknown[] = [];
		adapter.injectSystemPrompt(history, "System instruction", "remote:model-1");
		adapter.pushUserTurn(
			history,
			"Question",
			"remote:model-1",
			[
				adapter.formatToolResult(
					"call-1",
					"output",
					true,
					[{ format: "png", base64: "abc" }],
					"Read",
				),
			],
			[{ format: "jpeg", base64: "def" }],
		);
		adapter.pushAssistantTurn(
			history,
			"Answer",
			[{ toolUseId: "call-2", name: "Write", input: { path: "a" }, outputIndex: 1 }],
			[{ text: "thinking", outputIndex: 0 }],
			undefined,
			"message-1",
			undefined,
			2,
		);

		expect(history).toEqual([
			{ role: "system", content: [{ type: "text", text: "System instruction" }] },
			{
				role: "tool",
				content: [
					{
						type: "tool_result",
						toolUseId: "call-1",
						name: "Read",
						content: [
							{ type: "text", text: "output" },
							{ type: "image", mediaType: "image/png", dataBase64: "abc" },
						],
						isError: true,
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "Question" },
					{ type: "image", mediaType: "image/jpeg", dataBase64: "def" },
				],
			},
			{
				role: "assistant",
				messageId: "message-1",
				content: [
					{ type: "reasoning", text: "thinking", outputIndex: 0 },
					{
						type: "tool_call",
						toolUseId: "call-2",
						name: "Write",
						input: { path: "a" },
						outputIndex: 1,
					},
					{ type: "text", text: "Answer", outputIndex: 2 },
				],
			},
		]);
	});

	test("canonical chat history preserves prior tool messages", async () => {
		const rpc = makeRpc([event("done", { status: "completed", stopReason: "end_turn" })]);
		const history = [
			{
				role: "tool",
				content: [
					{
						type: "tool_result",
						toolUseId: "call-1",
						content: [{ type: "text", text: "result" }],
						isError: false,
					},
				],
			},
		];
		const adapter = makeAdapter(rpc);
		await collect(adapter.chat(chatParams({ history })));
		expect(rpc.chatParams).toMatchObject({
			request: { history },
		});
	});

	test("chat maps text, request_started, and done metadata", async () => {
		let requestStarted: { credentialId?: string } | undefined;
		const rpc = makeRpc([
			event("request_started", {
				credentialId: "credential-1",
				reasoningSource: "remote:channel-a",
			}),
			event("text.delta", { text: "hello", outputIndex: 3 }),
			event("done", {
				status: "completed",
				stopReason: "end_turn",
				messageId: "message-1",
				conversationId: "conversation-2",
			}),
		]);
		const adapter = makeAdapter(rpc);
		const events = await collect(
			adapter.chat(chatParams({ onRequestStart: (info) => (requestStarted = info) })),
		);

		expect(requestStarted).toEqual({ credentialId: "credential-1" });
		expect(events).toEqual([
			{ text: "hello", textOutputIndex: 3 },
			{ messageId: "message-1", conversationId: "conversation-2", stopReason: "end_turn" },
		]);
		expect(adapter.getActiveReasoningSource()).toBe("remote:channel-a");
	});

	test("chat maps streaming tool chunks and complete tool calls", async () => {
		const rpc = makeRpc([
			event("tool_call.start", { toolUseId: "call-1", name: "Read", outputIndex: 0 }),
			event("tool_call.delta", { toolUseId: "call-1", argumentsDelta: '{"path":' }),
			event("tool_call.delta", { toolUseId: "call-1", argumentsDelta: '"a"}' }),
			event("tool_call.end", { toolUseId: "call-1" }),
			event("tool_call.complete", {
				toolUseId: "call-2",
				name: "Write",
				input: { path: "b" },
				outputIndex: 1,
			}),
			event("done", { status: "completed", stopReason: "tool_use" }),
		]);
		const events = await collect(makeAdapter(rpc).chat(chatParams()));

		expect(events).toEqual([
			{ toolUseChunk: { toolUseId: "call-1", name: "Read", input: "", outputIndex: 0 } },
			{ toolUseChunk: { toolUseId: "call-1", input: '{"path":' } },
			{ toolUseChunk: { toolUseId: "call-1", input: '"a"}' } },
			{ toolUseChunk: { toolUseId: "call-1", stop: true } },
			{ toolUses: [{ toolUseId: "call-2", name: "Write", input: { path: "b" }, outputIndex: 1 }] },
			{ stopReason: "tool_use" },
		]);
	});

	test("chat preserves plugin reasoning metadata and metadata-only events", async () => {
		const rpc = makeRpc([
			event("reasoning.delta", {
				blockId: "reason-1",
				text: "plan",
				outputIndex: 2,
				metadata: { source: "plugin:source", format: "opaque", data: { token: "x" } },
			}),
			event("reasoning.metadata", {
				blockId: "reason-1",
				outputIndex: 2,
				metadata: { source: "plugin:source", format: "opaque", data: { token: "y" } },
			}),
			event("done", { status: "completed", stopReason: "end_turn" }),
		]);
		const events = await collect(makeAdapter(rpc).chat(chatParams()));

		expect(events[0]).toMatchObject({ reasoning: "plan", reasoningOutputIndex: 2 });
		expect(events[0].reasoningMetadata).toMatchObject({ signatureSource: "plugin:source" });
		expect((events[0].reasoningMetadata as { plugin?: unknown }).plugin).toEqual({
			providerTypeId: "com.example/provider",
			source: "plugin:source",
			format: "opaque",
			data: { token: "x" },
		});
		expect(events[1]).toMatchObject({ reasoningOutputIndex: 2 });
		expect(events[1].reasoning).toBeUndefined();
	});

	test("chat maps max-output done into completion-limit invalidState", async () => {
		const rpc = makeRpc([event("done", { status: "completed", stopReason: "max_output_tokens" })]);
		const events = await collect(makeAdapter(rpc).chat(chatParams()));

		expect(events[0].invalidState).toMatchObject({
			reason: "max_output_tokens",
			message: "Provider output reached the maximum token limit",
		});
	});

	test("chat maps usage snapshots, context percentage, and metering", async () => {
		const rpc = makeRpc([
			event("usage", {
				usage: {
					promptTokens: 10,
					inputTokens: 8,
					completionTokens: 4,
					reasoningTokens: 2,
					contextWindow: 100,
					contextUsagePercentage: 12.5,
					metering: { unit: "credit", unitPlural: "credits", usage: 1.5 },
				},
			}),
			event("done", {
				status: "completed",
				stopReason: "end_turn",
				usage: { inputTokens: 9, completionTokens: 5 },
			}),
		]);
		const events = await collect(makeAdapter(rpc).chat(chatParams()));

		expect(events[0]).toMatchObject({
			usage: {
				promptTokens: 10,
				inputTokens: 8,
				completionTokens: 4,
				reasoningTokens: 2,
				contextWindow: 100,
			},
			contextUsagePercentage: 12.5,
			metering: { unit: "credit", unitPlural: "credits", usage: 1.5 },
		});
		expect(events[1]).toMatchObject({
			usage: { inputTokens: 9, completionTokens: 5 },
			stopReason: "end_turn",
		});
	});

	test("AbortSignal cancels the active operation and surfaces AbortError", async () => {
		const controller = new AbortController();
		let cancelled = false;
		let release: (() => void) | undefined;
		const operation = makeOperation(
			async function* () {
				await new Promise<void>((resolve) => (release = resolve));
				yield event("done", { status: "cancelled", stopReason: "cancelled" });
			},
			"chat",
			async () => {
				cancelled = true;
				release?.();
			},
		);
		const rpc: RemoteProviderRpcClient = {
			chat: async () => operation,
			generate: async () => operation,
		};
		const iterator = makeAdapter(rpc).chat(chatParams({ signal: controller.signal }));
		const pending = iterator.next();
		await Promise.resolve();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(cancelled).toBe(true);
	});

	test("generate accumulates text and returns final usage metadata", async () => {
		const rpc = makeRpc(
			[event("request_started", { credentialId: "cred-generate" })],
			[
				event("text.delta", { text: "one" }),
				event("text.delta", { text: " two" }),
				event("usage", {
					usage: {
						inputTokens: 3,
						completionTokens: 2,
						contextUsagePercentage: 4,
						metering: { unit: "u", unitPlural: "us", usage: 0.5 },
					},
				}),
				event("done", { status: "completed", stopReason: "end_turn" }),
			],
		);
		const adapter = makeAdapter(rpc);
		const result = await adapter.generateWithMeta("prompt", "remote:model-1", "system", {
			reasoningEffort: "low",
		});

		expect(result).toEqual({
			text: "one two",
			contextPercent: 4,
			usage: {
				inputTokens: 3,
				outputTokens: 2,
				cachedInputTokens: 0,
				cacheCreationInputTokens: 0,
				cacheCreation5mInputTokens: 0,
				cacheCreation1hInputTokens: 0,
				reasoningTokens: 0,
			},
			credentialId: undefined,
			meterUsage: 0.5,
			meterUnit: "u",
		});
		expect(rpc.generateParams).toMatchObject({
			modelId: "model-1",
			request: { mode: "prompt", text: "prompt", systemInstruction: "system" },
			options: { reasoningEffort: "low" },
		});
	});

	test("generateWithHistory uses history mode and rejects tool events", async () => {
		const rpc = makeRpc(
			[],
			[
				event("text.delta", { text: "title" }),
				event("done", { status: "completed", stopReason: "end_turn" }),
			],
		);
		const adapter = makeAdapter(rpc);
		expect(
			await adapter.generateWithHistory("instruction", "content", "remote:model-1", "zh-CN"),
		).toBe("title");
		expect(rpc.generateParams).toMatchObject({
			request: {
				mode: "history",
				systemInstruction: "instruction",
				content: "content",
				locale: "zh-CN",
			},
		});

		const badRpc = makeRpc(
			[],
			[
				event("tool_call.complete", { toolUseId: "call-1", name: "Read", input: {} }),
				event("done", { status: "completed", stopReason: "end_turn" }),
			],
		);
		await expect(makeAdapter(badRpc).generate("prompt", "remote:model-1")).rejects.toThrow(
			"tool event",
		);
	});

	test("RPC unknown-result errors are not retried or rewritten", async () => {
		const unknown = new ProviderRpcError("UNKNOWN_RESULT", "transport ended", {
			unknownResult: true,
			retryable: true,
		});
		const operation = makeOperation(async function* () {
			await Promise.resolve();
			if (process.env.NARRAFORK_TEST_UNREACHABLE === "1") {
				yield event("done", { status: "completed", stopReason: "end_turn" });
			}
			throw unknown;
		});
		let calls = 0;
		const rpc: RemoteProviderRpcClient = {
			chat: async () => {
				calls++;
				return operation;
			},
			generate: async () => operation,
		};
		await expect(makeAdapter(rpc).generate("prompt", "remote:model-1")).rejects.toBe(unknown);
		expect(calls).toBe(0);
	});

	test("chat exposes provider errors as invalidState diagnostics without retrying", async () => {
		let calls = 0;
		const rpc = makeRpc([
			event("error", {
				error: {
					classification: "transport",
					code: "UPSTREAM_RESET",
					message: "upstream reset",
					reason: "connection_reset",
					retryable: true,
					phase: "stream",
				},
			}),
			event("done", { status: "failed", stopReason: "error" }),
		]);
		const originalChat = rpc.chat;
		rpc.chat = async (params, options) => {
			calls++;
			return originalChat(params, options);
		};
		const events = await collect(makeAdapter(rpc).chat(chatParams()));

		expect(events[0].invalidState).toMatchObject({
			reason: "connection_reset",
			message: "upstream reset",
		});
		expect(events[0].invalidState?.diagnostics).toMatchObject({
			source: "provider",
			code: "UPSTREAM_RESET",
			provider: "remote",
			transport: "plugin-stdio",
			retryable: true,
		});
		expect(calls).toBe(1);
	});
});
