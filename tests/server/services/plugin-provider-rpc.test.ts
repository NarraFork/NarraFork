import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { JsonRpcNotification, ProviderStreamEvent } from "@server/lib/plugins/protocol";
import {
	PluginProviderRpcClient,
	ProviderRpcError,
	type ProviderRpcRequestOptions,
	type ProviderRpcTransport,
	type ProviderStreamWindow,
} from "@server/services/plugin-provider-rpc";

const protocolVersion = "1.0";

function notification(
	operationId: string,
	seq: number,
	event: ProviderStreamEvent,
): JsonRpcNotification {
	return {
		jsonrpc: "2.0",
		method: "provider.event",
		params: { protocolVersion, operationId, seq, event },
	};
}

function describeResult() {
	return {
		selectedProtocolVersion: protocolVersion,
		plugin: { id: "com.example.provider", name: "Example Provider", version: "2.3.0" },
		providers: [
			{
				localId: "main",
				displayName: "Example",
				configSchema: {
					type: "object",
					properties: { apiKey: { type: "string", writeOnly: true, "x-narrafork-secret": true } },
				},
				capabilities: {
					validateConfig: true,
					listModels: true,
					chat: true,
					generate: true,
				},
			},
		],
	};
}

function modelCatalog() {
	return {
		catalogVersion: "catalog-1",
		models: [
			{
				id: "model:one",
				displayName: "Model One",
				capabilities: {
					chat: true,
					generate: true,
					streaming: true,
					tools: true,
					sessionMode: "stateful",
				},
			},
		],
	};
}

class MockTransport implements ProviderRpcTransport {
	readonly requests: Array<{
		method: string;
		params: unknown;
		options?: ProviderRpcRequestOptions;
	}> = [];
	readonly notifications: Array<{ method: string; params: unknown }> = [];
	readonly killed: string[] = [];
	private notificationHandler?: (message: JsonRpcNotification, bodyBytes?: number) => void;
	private closeHandler?: (error?: Error) => void;
	private readonly pendingResponses = new Map<string, unknown>();
	private operationResponse: "accepted" | "reject" = "accepted";

	request<T = unknown>(
		method: string,
		params?: unknown,
		options?: ProviderRpcRequestOptions,
	): Promise<T> {
		this.requests.push({ method, params, options });
		if (method === "provider.describe") return Promise.resolve(describeResult() as T);
		if (method === "provider.validateConfig") {
			return Promise.resolve({ valid: true, issues: [] } as T);
		}
		if (method === "provider.listModels") return Promise.resolve(modelCatalog() as T);
		if (method === "provider.cancel") {
			const operationId = getOperationId(params);
			return Promise.resolve({ operationId, state: "cancelling" } as T);
		}
		if (method === "provider.chat" || method === "provider.generate") {
			if (this.operationResponse === "reject") {
				return Promise.reject(new Error("not accepted"));
			}
			const operationId = getOperationId(params);
			return Promise.resolve({ accepted: true, operationId } as T);
		}
		const response = this.pendingResponses.get(method);
		return Promise.resolve(response as T);
	}

	notify(method: string, params?: unknown): Promise<void> {
		this.notifications.push({ method, params });
		return Promise.resolve();
	}

	onNotification(handler: (message: JsonRpcNotification, bodyBytes?: number) => void): () => void {
		this.notificationHandler = handler;
		return () => {
			if (this.notificationHandler === handler) this.notificationHandler = undefined;
		};
	}

	onClose(handler: (error?: Error) => void): () => void {
		this.closeHandler = handler;
		return () => {
			if (this.closeHandler === handler) this.closeHandler = undefined;
		};
	}

	kill(reason: string): void {
		this.killed.push(reason);
	}

	emit(message: JsonRpcNotification, bodyBytes?: number): void {
		this.notificationHandler?.(message, bodyBytes);
	}

	crash(error = new Error("fixture crashed")): void {
		this.closeHandler?.(error);
	}

	setOperationResponse(response: "accepted" | "reject"): void {
		this.operationResponse = response;
	}
}

function getRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function getOperationId(value: unknown): string {
	const operationId = getRecord(value).operationId;
	if (typeof operationId !== "string") throw new Error("missing operationId in test request");
	return operationId;
}

function baseParams() {
	return {
		providerTypeId: "com.example.provider/main",
		providerInstanceId: "instance-1",
		providerPrefix: "example",
		config: { endpoint: "https://provider.example.test" },
		modelId: "model:one",
	};
}

function chatParams() {
	return {
		...baseParams(),
		conversation: { conversationId: "conversation-1" },
		request: {
			history: [],
			current: { text: "hello", toolResults: [] },
			tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
		},
	};
}

function generateParams() {
	return { ...baseParams(), request: { mode: "prompt" as const, text: "title" } };
}

async function setup(
	options: { window?: Partial<ProviderStreamWindow>; limits?: Record<string, number> } = {},
) {
	const transport = new MockTransport();
	const client = new PluginProviderRpcClient({
		transport,
		expectedPluginId: "com.example.provider",
		streamWindow: options.window,
		limits: {
			streamIdleTimeoutMs: 10_000,
			operationTimeoutMs: 10_000,
			cancelGraceMs: 100,
			...options.limits,
		},
	});
	await client.describe({ protocolVersions: ["1.0"] });
	return { client, transport };
}

let clients: PluginProviderRpcClient[] = [];

beforeEach(() => {
	clients = [];
});

afterEach(async () => {
	await Promise.all(clients.map((client) => client.dispose()));
});

describe("PluginProviderRpcClient describe and unary methods", () => {
	it("negotiates versions and normalizes descriptors/model catalogs", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const descriptor = client.descriptor;
		expect(descriptor?.selectedProtocolVersion).toBe("1.0");
		expect(descriptor?.providers[0]).toMatchObject({
			providerTypeId: "com.example.provider/main",
			limits: { maxConcurrentChat: 1, maxConcurrentGenerate: 1 },
		});
		await expect(
			client.validateConfig({
				providerTypeId: "com.example.provider/main",
				providerInstanceId: "instance-1",
				config: {},
				mode: "syntax",
			}),
		).resolves.toMatchObject({ valid: true, issues: [] });
		await expect(
			client.listModels({
				providerTypeId: "com.example.provider/main",
				providerInstanceId: "instance-1",
				config: {},
				limit: 1,
			}),
		).resolves.toMatchObject({ models: [{ id: "model:one" }] });
		expect(transport.requests.map((request) => request.method)).toEqual([
			"provider.describe",
			"provider.validateConfig",
			"provider.listModels",
		]);
	});

	it("rejects incompatible selected versions and requires describe before calls", async () => {
		const transport = new MockTransport();
		const client = new PluginProviderRpcClient({ transport });
		clients.push(client);
		await expect(client.listModels({ ...baseParams() })).rejects.toMatchObject({
			code: "NOT_DESCRIBED",
		});
		transport.request = async () =>
			({ ...describeResult(), selectedProtocolVersion: "2.0" }) as never;
		await expect(client.describe()).rejects.toMatchObject({ code: "INCOMPATIBLE_PROTOCOL" });
	});
});

describe("accepted streaming and operation registry", () => {
	it("registers operation before request, streams events, sends ACK, and closes on done", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.chat(chatParams());
		const request = transport.requests.find((item) => item.method === "provider.chat");
		expect(getOperationId(request?.params)).toBe(operation.operationId);
		expect(request?.options?.requestId).toBe(operation.requestId);
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "request_started",
				upstreamRequestId: "req-1",
			}),
		);
		transport.emit(notification(operation.operationId, 2, { type: "text.delta", text: "hello" }));
		transport.emit(
			notification(operation.operationId, 3, {
				type: "done",
				status: "completed",
				stopReason: "end_turn",
			}),
		);
		const events = [await stream.next(), await stream.next(), await stream.next()];
		expect(events.map((item) => item.value?.type)).toEqual([
			"request_started",
			"text.delta",
			"done",
		]);
		expect((await stream.next()).done).toBe(true);
		expect(transport.notifications).toContainEqual(
			expect.objectContaining({ method: "provider.streamAck" }),
		);
		expect(client.getDiagnostics().activeOperations).toBe(0);
	});

	it("fails closed on duplicate, skipped, or out-of-order sequence numbers", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.chat(chatParams());
		const stream = operation.events();
		transport.emit(notification(operation.operationId, 2, { type: "text.delta", text: "bad" }));
		await expect(stream.next()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
		expect(transport.killed.length).toBe(1);
		expect(client.getDiagnostics().protocolErrors).toBe(1);
	});

	it("delivers done to a next() waiter instead of resolving it as an empty iterator", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.generate(generateParams());
		const stream = operation.events();
		const pending = stream.next();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "done",
				status: "completed",
				stopReason: "end_turn",
			}),
		);
		await expect(pending).resolves.toMatchObject({ value: { type: "done" }, done: false });
		await expect(stream.next()).resolves.toMatchObject({ done: true });
	});
});

describe("credit, cancellation, and late events", () => {
	it("uses terminal reserve after normal credit is consumed and resumes after ACK", async () => {
		const { client, transport } = await setup({
			window: {
				maxUnackedEvents: 1,
				maxUnackedBytes: 1024,
				terminalReserveEvents: 2,
				terminalReserveBytes: 4096,
			},
		});
		clients.push(client);
		const operation = await client.chat(chatParams());
		const stream = operation.events();
		transport.emit(notification(operation.operationId, 1, { type: "text.delta", text: "one" }));
		const first = await stream.next();
		expect(first.value).toMatchObject({ type: "text.delta", text: "one" });
		transport.emit(
			notification(operation.operationId, 2, {
				type: "error",
				error: {
					classification: "api",
					code: "UPSTREAM",
					message: "failed",
				},
			}),
		);
		transport.emit(
			notification(operation.operationId, 3, {
				type: "done",
				status: "failed",
				stopReason: "error",
			}),
		);
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "error" } });
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "done" } });
		expect(
			transport.notifications.filter((item) => item.method === "provider.streamAck"),
		).toHaveLength(1);
	});

	it("cancels exactly once and allows cancelled done to arrive within the grace period", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const controller = new AbortController();
		const operation = await client.chat(chatParams(), { signal: controller.signal });
		const stream = operation.events();
		controller.abort("user stopped");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(transport.requests.filter((item) => item.method === "provider.cancel")).toHaveLength(1);
		transport.emit(
			notification(operation.operationId, 1, {
				type: "done",
				status: "cancelled",
				stopReason: "cancelled",
			}),
		);
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "done" } });
		await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
	});

	it("drops a late event after done without returning it to the Agent Loop", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.generate(generateParams());
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "done",
				status: "completed",
				stopReason: "end_turn",
			}),
		);
		await stream.next();
		transport.emit(notification(operation.operationId, 2, { type: "text.delta", text: "late" }));
		expect(client.getDiagnostics().lateEvents).toBe(1);
		await expect(stream.next()).resolves.toMatchObject({ done: true });
	});

	it("kills the transport after cancel grace when the plugin never sends done", async () => {
		const { client, transport } = await setup({ limits: { cancelGraceMs: 10 } });
		clients.push(client);
		const controller = new AbortController();
		const operation = await client.chat(chatParams(), { signal: controller.signal });
		const stream = operation.events();
		const pending = stream.next();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(transport.killed).toHaveLength(1);
	});
});

describe("operation limits and crash semantics", () => {
	it("rejects tool calls from generate as a protocol error", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.generate(generateParams());
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "tool_call.complete",
				toolUseId: "tool-1",
				name: "echo",
				input: {},
			}),
		);
		await expect(stream.next()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
		expect(transport.killed).toHaveLength(1);
	});

	it("cancels on operation output limits and preserves terminal reserve", async () => {
		const { client, transport } = await setup({ limits: { maxTextBytes: 3 } });
		clients.push(client);
		const operation = await client.chat(chatParams());
		const stream = operation.events();
		transport.emit(notification(operation.operationId, 1, { type: "text.delta", text: "toolong" }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(transport.requests.some((item) => item.method === "provider.cancel")).toBe(true);
		transport.emit(
			notification(operation.operationId, 2, {
				type: "error",
				error: { classification: "cancelled", code: "OUTPUT_LIMIT", message: "limited" },
			}),
		);
		transport.emit(
			notification(operation.operationId, 3, {
				type: "done",
				status: "failed",
				stopReason: "error",
			}),
		);
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "error" } });
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "done" } });
		await expect(stream.next()).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
	});

	it("reports an unknown result after a provider crash and never marks tool output replay-safe", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.chat(chatParams());
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "tool_call.start",
				toolUseId: "tool-1",
				name: "echo",
			}),
		);
		transport.crash();
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "tool_call.start" } });
		await expect(stream.next()).rejects.toMatchObject({
			code: "UNKNOWN_RESULT",
			exposedToolCall: true,
			retryable: false,
			unknownResult: true,
		});
	});

	it("fails accepted-before-event violations closed", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operationPromise = client.chat(chatParams());
		const request = transport.requests.find((item) => item.method === "provider.chat");
		const operationId = getOperationId(request?.params);
		transport.emit(notification(operationId, 1, { type: "text.delta", text: "early" }));
		await expect(operationPromise).rejects.toBeInstanceOf(ProviderRpcError);
		expect(transport.killed).toHaveLength(1);
	});
});
