import { describe, expect, test } from "bun:test";
import {
	PLUGIN_REQUEST_DUMP_MAX_BYTES,
	type ProviderStreamEvent,
	providerStreamEventSchema,
} from "@server/lib/plugins/protocol";
import {
	type ProviderOperation,
	type ProviderOperationKind,
	ProviderRpcError,
} from "@server/services/plugin-provider-rpc";
import type { ChatParams, DbMessage } from "../provider";
import { RemoteProviderAdapter, type RemoteProviderRpcClient } from "../remote-provider-adapter";
import { ApiRequestDumpCollector } from "../request-dump";
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

	test("chat bridges only remote final-input counts and old plugins report unknown", async () => {
		const counts = { totalChars: 120, systemChars: 20, toolsChars: 40 };
		const classified = {
			...counts,
			compositionSegments: [
				{ category: "system", chars: 15 },
				{ category: "summary", chars: 5 },
				{ category: "toolDefinition", chars: 40 },
				{ category: "user", chars: 20 },
				{ category: "assistant", chars: 10 },
				{ category: "toolCall", chars: 5 },
				{ category: "toolResult", chars: 10 },
				{ category: "attachment", chars: 10 },
				{ category: "other", chars: 5 },
			],
		};
		for (const reported of [
			classified,
			{ ...counts, compositionSegments: null },
			counts,
			undefined,
			null,
		]) {
			const snapshots: unknown[] = [];
			const rpc = makeRpc([
				event("request_started", {
					...(reported ? { inputCharacters: reported } : {}),
				}),
				event("text.delta", { text: "hello" }),
			]);
			await collect(
				makeAdapter(rpc).chat(
					chatParams({
						onInputCharacters: (value) => {
							snapshots.push(value);
						},
					}),
				),
			);
			expect(snapshots).toEqual([null, reported ?? null]);
		}
		expect(
			providerStreamEventSchema.safeParse({
				type: "request_started",
				inputCharacters: { ...counts, totalChars: 1 },
			}).success,
		).toBe(false);
		expect(
			providerStreamEventSchema.safeParse({
				type: "request_started",
				inputCharacters: { ...counts, totalChars: Infinity },
			}).success,
		).toBe(false);
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

	/**
	 * `text.citation` is the plugin-side equivalent of a Responses API annotation.
	 * It must map onto the same `textCitations` field the loop already consumes —
	 * otherwise a plugin's sources would be silently discarded while its inline
	 * markers still reached the UI.
	 */
	test("chat maps plugin text.citation events onto textCitations", async () => {
		const rpc = makeRpc([
			event("text.delta", { text: "answer" }),
			event("text.citation", {
				citations: [
					{
						startIndex: 0,
						endIndex: 6,
						url: "https://example.test/a",
						title: "A",
						outputIndex: 0,
					},
					{ endIndex: 6, sourceRef: "plugin-ref-1" },
				],
			}),
			event("done", { status: "completed", stopReason: "end_turn" }),
		]);
		const events = await collect(makeAdapter(rpc).chat(chatParams()));

		expect(events).toEqual([
			{ text: "answer", textOutputIndex: undefined },
			{
				textCitations: [
					{
						startIndex: 0,
						endIndex: 6,
						url: "https://example.test/a",
						title: "A",
						outputIndex: 0,
					},
					{ endIndex: 6, sourceRef: "plugin-ref-1" },
				],
			},
			{ stopReason: "end_turn" },
		]);
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

	test("optional content boundaries retain text/reasoning lane identities after metadata", async () => {
		const input: ProviderStreamEvent[] = [
			providerStreamEventSchema.parse({ type: "text.delta", text: "legacy" }),
			providerStreamEventSchema.parse({
				type: "text.delta",
				text: "new",
				blockId: "text-1",
				outputIndex: 0,
			}),
			providerStreamEventSchema.parse({
				type: "text.citation",
				blockId: "text-1",
				citations: [{ endIndex: 3, url: "https://example.test", outputIndex: 0 }],
			}),
			providerStreamEventSchema.parse({
				type: "content.boundary",
				kind: "text",
				phase: "complete",
				blockId: "text-1",
				outputIndex: 0,
			}),
			providerStreamEventSchema.parse({
				type: "reasoning.delta",
				blockId: "reason-1",
				text: "first",
			}),
			providerStreamEventSchema.parse({
				type: "reasoning.delta",
				blockId: "reason-2",
				text: "second",
			}),
			providerStreamEventSchema.parse({
				type: "reasoning.metadata",
				blockId: "reason-1",
				metadata: { source: "plugin:source", format: "opaque", data: "final" },
			}),
			providerStreamEventSchema.parse({
				type: "content.boundary",
				kind: "reasoning",
				phase: "complete",
				blockId: "reason-1",
			}),
			event("done", { status: "completed", stopReason: "end_turn" }),
		];
		const events = await collect(makeAdapter(makeRpc(input)).chat(chatParams()));
		expect(events[0]).toMatchObject({ text: "legacy" });
		expect(events[0].textBlockId).toBeUndefined();
		expect(events[1].textBlockId).toBe("text-1");
		expect(events[2].textBlockId).toBe("text-1");
		expect(events[3].contentBoundary).toEqual({
			kind: "text",
			phase: "complete",
			blockId: "text-1",
			outputIndex: 0,
		});
		expect(events[4].reasoningBlockId).toBe("reason-1");
		expect(events[5].reasoningBlockId).toBe("reason-2");
		expect(events[6].reasoningBlockId).toBe("reason-1");
		expect(events[7].contentBoundary?.phase).toBe("complete");
	});

	test("ordered replay preserves text-tool-text and opaque reasoning/native items", async () => {
		const adapter = makeAdapter(makeRpc());
		const source = adapter.getActiveReasoningSource();
		const rpc = makeRpc([
			event("reasoning.metadata", {
				blockId: "reason-1",
				metadata: { source, format: "opaque", data: "final-secret" },
			}),
			event("done", { status: "completed", stopReason: "end_turn" }),
		]);
		const metadata = (await collect(makeAdapter(rpc).chat(chatParams())))[0].reasoningMetadata;
		const history: unknown[] = [];
		adapter.pushAssistantTurn(
			history,
			"ignored",
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			[
				{ type: "reasoning", text: "", providerMetadata: metadata },
				{ type: "text", text: "before", outputIndex: 9 },
				{
					type: "tool_use",
					toolUseId: "call-1",
					name: "Read",
					input: {},
					outputIndex: 0,
					thoughtSignature: "tool-signature",
					thoughtSignatureSource: source,
				},
				{ type: "text", text: "after", outputIndex: 1 },
				{ type: "image_generation", id: "image-1", result: "base64-image" },
			],
		);
		const content = (history[0] as { content: Array<Record<string, unknown>> }).content;
		expect(content.map((block) => block.type)).toEqual([
			"reasoning",
			"text",
			"tool_call",
			"text",
			"image_generation",
		]);
		expect(content[0].continuation).toEqual({ source, format: "opaque", data: "final-secret" });
		expect(content[2].continuation).toEqual({
			source,
			format: "tool-continuation",
			data: "tool-signature",
		});
		expect(content[4].result).toBe("base64-image");
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

	for (const kind of ["chat", "generate"] as const) {
		const run = (adapter: RemoteProviderAdapter, signal = new AbortController().signal) =>
			kind === "chat"
				? collect(adapter.chat(chatParams({ signal })))
				: adapter.generateWithMeta("hello", "remote:model-1", undefined, { signal });

		for (const code of ["STREAM_IDLE_TIMEOUT", "OUTPUT_LIMIT"] as const) {
			test(`${kind} preserves ${code} thrown after cancelled done`, async () => {
				const original = new ProviderRpcError(code, "original transport failure", {
					retryable: true,
				});
				const events = async function* () {
					yield event("done", { status: "cancelled", stopReason: "cancelled" });
					throw original;
				};
				await expect(run(makeAdapter(makeRpc(events, events)))).rejects.toBe(original);
			});
		}

		test(`${kind} surfaces AbortError for cancelled done without an original error`, async () => {
			let drained = false;
			const events = async function* () {
				yield event("done", { status: "cancelled", stopReason: "cancelled" });
				drained = true;
			};
			await expect(run(makeAdapter(makeRpc(events, events)))).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(drained).toBe(true);
		});

		test(`${kind} preserves active user cancellation and its reason`, async () => {
			const controller = new AbortController();
			let notifyStarted: () => void = () => undefined;
			const started = new Promise<void>((resolve) => {
				notifyStarted = resolve;
			});
			let release: () => void = () => undefined;
			const cancelled = new Promise<void>((resolve) => {
				release = resolve;
			});
			let cancelCalls = 0;
			const operation = makeOperation(
				async function* () {
					notifyStarted();
					await cancelled;
					yield event("done", { status: "cancelled", stopReason: "cancelled" });
				},
				kind,
				async () => {
					cancelCalls++;
					release();
				},
			);
			const adapter = makeAdapter({
				chat: async () => operation,
				generate: async () => operation,
			});
			const pending = run(adapter, controller.signal);
			await started;
			controller.abort(new Error("Stopped by user"));
			await expect(pending).rejects.toMatchObject({
				name: "AbortError",
				message: "Stopped by user",
			});
			expect(cancelCalls).toBe(1);
		});
	}

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
		const deltas: string[] = [];
		const result = await adapter.generateWithMeta("prompt", "remote:model-1", "system", {
			reasoningEffort: "low",
			onTextDelta: async (delta) => {
				deltas.push(delta);
			},
		});

		expect(deltas).toEqual(["one", " two"]);
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

describe("RemoteProviderAdapter request dump", () => {
	const done = () => event("done", { status: "completed", stopReason: "end_turn" });

	test("chat params carry the requestDump hint only when a collector is attached", async () => {
		const withDump = makeRpc([done()]);
		await collect(
			makeAdapter(withDump).chat(chatParams({ requestDump: new ApiRequestDumpCollector() })),
		);
		const hinted = withDump.chatParams?.requestDump as { maxBytes?: number } | undefined;
		expect(typeof hinted?.maxBytes).toBe("number");
		expect(hinted?.maxBytes).toBeGreaterThan(0);
		expect(hinted?.maxBytes).toBeLessThanOrEqual(PLUGIN_REQUEST_DUMP_MAX_BYTES);

		const withoutDump = makeRpc([done()]);
		await collect(makeAdapter(withoutDump).chat(chatParams()));
		expect(withoutDump.chatParams?.requestDump).toBeUndefined();
	});

	test("dump events populate the collector and never reach the parsed stream", async () => {
		const rpc = makeRpc([
			event("dump.request", {
				transport: "http-sse",
				url: "https://upstream.invalid/v1/chat",
				headers: { "content-type": "application/json" },
			}),
			event("dump.request", { bodyChunk: '{"model":"model-1",', final: false }),
			event("dump.request", { bodyChunk: '"input":"hello"}', final: true }),
			event("dump.response", { status: 200, headers: { "content-type": "text/event-stream" } }),
			event("dump.response", { bodyChunk: "data: chunk-1\n", final: true }),
			event("text.delta", { text: "answer" }),
			done(),
		]);
		const collector = new ApiRequestDumpCollector();
		const events = await collect(makeAdapter(rpc).chat(chatParams({ requestDump: collector })));

		// Dump events are a diagnostic side channel: only the real model output remains.
		expect(events).toEqual([
			{ text: "answer", textOutputIndex: undefined },
			{ stopReason: "end_turn" },
		]);
		const dump = collector.snapshot();
		expect(dump.request).toMatchObject({
			transport: "http-sse",
			url: "https://upstream.invalid/v1/chat",
			headers: { "content-type": "application/json" },
			body: { model: "model-1", input: "hello" },
		});
		expect(dump.response).toMatchObject({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			bodyText: "data: chunk-1\n",
			bodyIncomplete: false,
		});
	});

	test("config secrets are masked in reported url, headers, and bodies", async () => {
		// makeAdapter's config carries apiKey "secret-value": the host knows it, so the
		// plugin can report verbatim and the host still masks every occurrence.
		const rpc = makeRpc([
			event("dump.request", {
				url: "https://upstream.invalid/v1/chat?key=secret-value",
				headers: { authorization: "Bearer secret-value", "x-other": "secret-value" },
				bodyChunk: '{"auth":"secret-value"}',
				final: true,
			}),
			event("dump.response", { status: 200, bodyChunk: "echo: secret-value", final: true }),
			done(),
		]);
		const collector = new ApiRequestDumpCollector();
		await collect(makeAdapter(rpc).chat(chatParams({ requestDump: collector })));

		const serialized = JSON.stringify(collector.snapshot());
		expect(serialized).not.toContain("secret-value");
		const dump = collector.snapshot();
		// authorization is masked by header name; x-other only by the known secret value.
		expect(dump.request?.headers?.authorization).toBe("Bear********alue");
		expect(dump.request?.headers?.["x-other"]).toBe("secr********alue");
		expect(dump.request?.url).toBe("https://upstream.invalid/v1/chat?key=secr********alue");
	});

	test("masks secrets split across chunks in both requests and responses of every retry", async () => {
		const events: ProviderStreamEvent[] = [];
		for (let retry = 0; retry < 3; retry++) {
			events.push(
				event("dump.request", {
					url: `https://upstream.invalid/${retry}`,
					bodyChunk: '{"auth":"secret-',
				}),
			);
			events.push(event("dump.request", { bodyChunk: 'value"}', final: true }));
			events.push(
				event("dump.response", { status: retry === 2 ? 200 : 429, bodyChunk: "secret-" }),
			);
			events.push(event("dump.response", { bodyChunk: "value", final: true }));
		}
		events.push(done());
		const collector = new ApiRequestDumpCollector();
		await collect(makeAdapter(makeRpc(events)).chat(chatParams({ requestDump: collector })));
		const dump = collector.snapshot();
		expect(dump.attempts).toHaveLength(2);
		expect(JSON.stringify(dump)).not.toContain("secret-value");
		expect(dump.request?.body).toEqual({ auth: "secr********alue" });
		expect(dump.response?.bodyText).toBe("secr********alue");
		for (const attempt of dump.attempts ?? [])
			expect(attempt.response?.bodyText).toBe("secr********alue");
	});

	test("masks encoded secret forms even when chunks split inside escape sequences", async () => {
		for (const encoded of [
			"s\\u0065cret-value",
			"secret%2Dvalue",
			"%73%65cret-value",
			Buffer.from("secret-value").toString("base64"),
			"secret\\u002dvalue",
		]) {
			const collector = new ApiRequestDumpCollector();
			const rpc = makeRpc([
				event("dump.request", {
					url: "https://upstream.invalid",
					bodyChunk: `{"auth":"${encoded.slice(0, 4)}`,
				}),
				event("dump.request", { bodyChunk: `${encoded.slice(4)}"}`, final: true }),
				event("dump.response", { bodyChunk: encoded.slice(0, 4) }),
				event("dump.response", { bodyChunk: encoded.slice(4), final: true }),
				done(),
			]);
			await collect(makeAdapter(rpc).chat(chatParams({ requestDump: collector })));
			expect(collector.snapshot().request?.body).toEqual({ auth: "secr********alue" });
			expect(collector.snapshot().response?.bodyText).toBe("secr********alue");
		}
	});

	test("plugin-internal retries archive earlier attempts", async () => {
		const rpc = makeRpc([
			event("dump.request", { url: "https://upstream.invalid/attempt-1", final: true }),
			event("dump.response", { status: 429, bodyChunk: "rate limited", final: true }),
			event("dump.request", { url: "https://upstream.invalid/attempt-2", final: true }),
			event("dump.response", { status: 200, bodyChunk: "ok", final: true }),
			done(),
		]);
		const collector = new ApiRequestDumpCollector();
		await collect(makeAdapter(rpc).chat(chatParams({ requestDump: collector })));

		const dump = collector.snapshot();
		expect(dump.attempts).toHaveLength(1);
		expect(dump.attempts?.[0]?.requestText).toContain("attempt-1");
		expect(dump.attempts?.[0]?.response).toMatchObject({ status: 429 });
		expect(dump.request?.url).toBe("https://upstream.invalid/attempt-2");
		expect(dump.response).toMatchObject({ status: 200, bodyText: "ok" });
	});

	test("a request without a response is preserved when the stream ends", async () => {
		const rpc = makeRpc([
			event("dump.request", {
				url: "https://upstream.invalid/v1/chat",
				bodyChunk: "{}",
				final: true,
			}),
			event("error", {
				error: {
					classification: "transport",
					code: "CONNECT_FAILED",
					message: "connect failed",
				},
			}),
			done(),
		]);
		const collector = new ApiRequestDumpCollector();
		await collect(makeAdapter(rpc).chat(chatParams({ requestDump: collector })));

		const dump = collector.snapshot();
		expect(dump.request?.url).toBe("https://upstream.invalid/v1/chat");
	});

	test("dump events are dropped silently when no collector is attached", async () => {
		const rpc = makeRpc([
			event("dump.request", { url: "https://upstream.invalid/v1/chat", final: true }),
			event("dump.response", { status: 200, bodyChunk: "ok", final: true }),
			event("text.delta", { text: "answer" }),
			done(),
		]);
		const events = await collect(makeAdapter(rpc).chat(chatParams()));

		expect(events).toEqual([
			{ text: "answer", textOutputIndex: undefined },
			{ stopReason: "end_turn" },
		]);
	});
});
