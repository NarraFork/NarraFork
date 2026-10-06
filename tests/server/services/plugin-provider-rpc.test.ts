import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { JsonRpcNotification, ProviderStreamEvent } from "@server/lib/plugins/protocol";
import {
	PluginProviderRpcClient,
	type ProviderOperation,
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
	private operationResponseDeferred = false;
	private acceptOperation?: () => void;

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
			if (this.operationResponseDeferred) {
				return new Promise<T>((resolve) => {
					this.acceptOperation = () => resolve({ accepted: true, operationId } as T);
				});
			}
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

	deferOperationAcceptance(): void {
		this.operationResponseDeferred = true;
	}

	acceptOperationRequest(): void {
		const accept = this.acceptOperation;
		this.acceptOperation = undefined;
		accept?.();
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
	options: {
		window?: Partial<ProviderStreamWindow>;
		limits?: Record<string, number>;
		idFactory?: (prefix: "op" | "rpc") => string;
	} = {},
) {
	const transport = new MockTransport();
	const client = new PluginProviderRpcClient({
		transport,
		expectedPluginId: "com.example.provider",
		streamWindow: options.window,
		idFactory: options.idFactory,
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
		expect(transport.killed.length).toBe(0);
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

	it("does not enforce the provider-declared generate concurrency limit in the host", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const first = await client.generate(generateParams());
		const second = await client.generate(generateParams());

		expect(first.operationId).not.toBe(second.operationId);
		expect(
			transport.requests.filter((request) => request.method === "provider.generate"),
		).toHaveLength(2);
		expect(client.getDiagnostics().activeOperations).toBe(2);

		for (const operation of [first, second]) {
			const stream = operation.events();
			transport.emit(
				notification(operation.operationId, 1, {
					type: "done",
					status: "completed",
					stopReason: "end_turn",
				}),
			);
			await expect(stream.next()).resolves.toMatchObject({ value: { type: "done" }, done: false });
			await expect(stream.next()).resolves.toMatchObject({ done: true });
		}

		expect(client.getDiagnostics().activeOperations).toBe(0);
	});

	it("releases a failed operation even when its event iterator is idle", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.generate(generateParams());
		const stream = operation.events();
		transport.emit(notification(operation.operationId, 1, { type: "text.delta", text: "partial" }));
		await expect(stream.next()).resolves.toMatchObject({
			value: { type: "text.delta" },
			done: false,
		});

		transport.crash(new Error("plugin exited"));

		expect(client.getDiagnostics().activeOperations).toBe(0);
		await expect(stream.next()).rejects.toMatchObject({ code: "UNKNOWN_RESULT" });
	});
});

describe("outbound request byte limits", () => {
	async function completeOperation(transport: MockTransport, operation: ProviderOperation) {
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "done",
				status: "completed",
				stopReason: "end_turn",
			}),
		);
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "done" }, done: false });
		await expect(stream.next()).resolves.toMatchObject({ done: true });
	}

	it.each([
		"chat",
		"generate",
	] as const)("enforces the full UTF-8 %s params boundary and recovers after rejection", async (kind) => {
		let nextId = 0;
		const idFactory = (prefix: "op" | "rpc") => `${prefix}_${String(++nextId).padStart(4, "0")}`;
		const start = (client: PluginProviderRpcClient, text: string) => {
			if (kind === "generate") {
				return client.generate({
					...generateParams(),
					request: { mode: "prompt", text },
				});
			}
			const params = chatParams();
			return client.chat({
				...params,
				request: {
					...params.request,
					current: {
						...params.request.current,
						text,
						images: [{ mediaType: "image/png", dataBase64: "AQID".repeat(16) }],
					},
				},
			});
		};
		// Capture the actual params, including the host's fixed-width IDs and stream window.
		const probe = await setup({ idFactory });
		clients.push(probe.client);
		const probeOperation = await start(probe.client, "");
		const probeRequest = probe.transport.requests.find(
			(request) => request.method === `provider.${kind}`,
		);
		expect(probeRequest).toBeDefined();
		const probeParams = getRecord(probeRequest?.params);
		expect(probeParams.protocolVersion).toBe(protocolVersion);
		expect(probeParams.operationId).toBe(probeOperation.operationId);
		expect(probeParams.streamWindow).toMatchObject({ maxUnackedEvents: 64 });
		const overhead = Buffer.byteLength(JSON.stringify(probeParams), "utf8");
		await completeOperation(probe.transport, probeOperation);

		// Multi-byte text plus JSON-escaped characters catches UTF-16/string-length accounting.
		const text = `${"界".repeat(16)}"\\`;
		const textJsonBytes = Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
		const maxRequestBytes = overhead + textJsonBytes;
		const { client, transport } = await setup({ limits: { maxRequestBytes }, idFactory });
		clients.push(client);
		const operation = await start(client, text);
		const sent = transport.requests.find((request) => request.method === `provider.${kind}`);
		const sentParams = getRecord(sent?.params);
		expect(Buffer.byteLength(JSON.stringify(sentParams), "utf8")).toBe(maxRequestBytes);
		const {
			protocolVersion: _protocolVersion,
			operationId: _operationId,
			streamWindow: _streamWindow,
			...callerParams
		} = sentParams;
		expect(Buffer.byteLength(JSON.stringify(callerParams), "utf8")).toBeLessThan(maxRequestBytes);
		expect(JSON.stringify(sentParams).length).toBeLessThan(maxRequestBytes);
		await completeOperation(transport, operation);

		const requestsBeforeRejection = transport.requests.length;
		expect(Buffer.byteLength(JSON.stringify(`${text}x`), "utf8") - 2 + overhead).toBe(
			maxRequestBytes + 1,
		);
		await expect(start(client, `${text}x`)).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
		expect(transport.requests.length).toBe(requestsBeforeRejection);
		expect(client.getDiagnostics()).toMatchObject({
			activeOperations: 0,
			queuedBytes: 0,
			operations: [],
			transportKilled: false,
		});
		expect(transport.killed).toHaveLength(0);
		const recovered = await start(client, "ok");
		await completeOperation(transport, recovered);
		expect(client.getDiagnostics().activeOperations).toBe(0);
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
		await new Promise((resolve) => queueMicrotask(resolve));
		expect(client.getDiagnostics().lateEvents).toBe(1);
		await expect(stream.next()).resolves.toMatchObject({ done: true });
	});

	it("validates malformed provider.event notifications instead of silently dropping them", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		transport.emit({ jsonrpc: "2.0", method: "provider.event", params: {} });
		await new Promise((resolve) => queueMicrotask(resolve));
		expect(client.getDiagnostics()).toMatchObject({ protocolErrors: 1, transportKilled: true });
		expect(transport.killed).toHaveLength(1);
	});

	it("records an unknown operation event as late instead of silently dropping it", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		transport.emit(notification("unknown-operation", 1, { type: "text.delta", text: "unknown" }));
		await new Promise((resolve) => queueMicrotask(resolve));
		expect(client.getDiagnostics()).toMatchObject({ lateEvents: 1, protocolErrors: 0 });
		expect(transport.killed).toHaveLength(0);
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
	it("defaults to a 300000ms stream idle budget while retaining the total timeout", async () => {
		const client = new PluginProviderRpcClient({ transport: new MockTransport() });
		clients.push(client);
		await client.describe();
		const timer = spyOn(globalThis, "setTimeout");
		try {
			await client.chat(chatParams());
			expect(timer.mock.calls.map((call) => call[1])).toEqual([30 * 60_000, 300_000]);
		} finally {
			timer.mockRestore();
		}
	});

	it.each([
		false,
		true,
	])("preserves idle timeout after cancelled done (partial output: %s)", async (partialOutput) => {
		const streamIdleTimeoutMs = 20;
		const { client, transport } = await setup({ limits: { streamIdleTimeoutMs } });
		clients.push(client);
		const operation = await client.chat(chatParams());
		expect(operation.accepted).toBe(true);
		const stream = operation.events();
		let seq = 1;
		if (partialOutput) {
			transport.emit(
				notification(operation.operationId, seq++, { type: "text.delta", text: "partial" }),
			);
			await expect(stream.next()).resolves.toMatchObject({
				value: { type: "text.delta", text: "partial" },
			});
		}
		const request = transport.request.bind(transport);
		transport.request = <T = unknown>(
			method: string,
			params?: unknown,
			options?: ProviderRpcRequestOptions,
		) => {
			const result = request<T>(method, params, options);
			if (method === "provider.cancel") {
				transport.emit(
					notification(operation.operationId, seq++, {
						type: "done",
						status: "cancelled",
						stopReason: "cancelled",
					}),
				);
			}
			return result;
		};
		await expect(stream.next()).resolves.toMatchObject({
			done: false,
			value: { type: "done", status: "cancelled" },
		});
		await expect(stream.next()).rejects.toMatchObject({
			code: "STREAM_IDLE_TIMEOUT",
			message: `Provider stream idle timeout after ${streamIdleTimeoutMs}ms`,
			operationId: operation.operationId,
			requestId: operation.requestId,
		});
		const cancellations = transport.requests.filter((item) => item.method === "provider.cancel");
		expect(cancellations).toHaveLength(1);
		expect(cancellations[0].params).toMatchObject({
			operationId: operation.operationId,
			reason: "timeout",
		});
		expect(transport.killed).toHaveLength(0);
		expect(client.getDiagnostics().activeOperations).toBe(0);
	});

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
		expect(transport.killed).toHaveLength(0);
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
		await new Promise((resolve) => queueMicrotask(resolve));
		transport.crash();
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "tool_call.start" } });
		await expect(stream.next()).rejects.toMatchObject({
			code: "UNKNOWN_RESULT",
			exposedToolCall: true,
			retryable: false,
			unknownResult: true,
		});
	});

	it("accepts an event received in the same input batch as the accepted response", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		transport.deferOperationAcceptance();
		const operationPromise = client.chat(chatParams());
		const request = transport.requests.find((item) => item.method === "provider.chat");
		const operationId = getOperationId(request?.params);

		// The host receives the response frame and the first notification synchronously before
		// either Promise continuation runs, which is exactly what one stdout chunk can produce.
		transport.acceptOperationRequest();
		transport.emit(notification(operationId, 1, { type: "text.delta", text: "first" }));
		const operation = await operationPromise;
		const stream = operation.events();
		await expect(stream.next()).resolves.toMatchObject({
			value: { type: "text.delta", text: "first" },
		});
		transport.emit(
			notification(operationId, 2, {
				type: "done",
				status: "completed",
				stopReason: "end_turn",
			}),
		);
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "done" } });
	});

	it.each([
		1, 3, 32,
	])("flushes %i early frames then consumes live frames and done", async (count) => {
		const { client, transport } = await setup();
		clients.push(client);
		transport.deferOperationAcceptance();
		const operationPromise = client.chat(chatParams());
		const request = transport.requests.find((item) => item.method === "provider.chat");
		const operationId = getOperationId(request?.params);
		for (let seq = 1; seq <= count; seq++) {
			transport.emit(notification(operationId, seq, { type: "text.delta", text: `early-${seq}` }));
		}
		// Force the early frames into the buffer, not the same-batch microtask path.
		await Promise.resolve();
		expect(client.getDiagnostics().operations[0]?.state).toBe("accepting");
		transport.acceptOperationRequest();
		const operation = await operationPromise;
		expect(client.getDiagnostics().operations[0]?.nextSeq).toBe(count + 1);
		transport.emit(notification(operationId, count + 1, { type: "text.delta", text: "live" }));
		transport.emit(
			notification(operationId, count + 2, {
				type: "done",
				status: "completed",
				stopReason: "end_turn",
			}),
		);
		const events: ProviderStreamEvent[] = [];
		for await (const event of operation.events()) events.push(event);
		const expected: ProviderStreamEvent[] = [
			...Array.from({ length: count }, (_, index) => ({
				type: "text.delta" as const,
				text: `early-${index + 1}`,
			})),
			{ type: "text.delta", text: "live" },
			{ type: "done", status: "completed", stopReason: "end_turn" },
		];
		expect(events).toEqual(expected);
		expect(
			transport.notifications
				.filter((item) => item.method === "provider.streamAck")
				.map((item) => getRecord(item.params).throughSeq),
		).toEqual(Array.from({ length: count + 1 }, (_, index) => index + 1));
		expect(client.getDiagnostics()).toMatchObject({
			activeOperations: 0,
			queuedBytes: 0,
			protocolErrors: 0,
			lateEvents: 0,
		});
		expect(transport.killed).toHaveLength(0);
	});

	it("keeps buffered terminal reserve and drops frames after buffered done", async () => {
		const { client, transport } = await setup({ window: { maxUnackedEvents: 1 } });
		clients.push(client);
		transport.deferOperationAcceptance();
		const operationPromise = client.generate(generateParams());
		const request = transport.requests.find((item) => item.method === "provider.generate");
		const operationId = getOperationId(request?.params);
		const expected: ProviderStreamEvent[] = [
			{ type: "text.delta", text: "early" },
			{ type: "error", error: { classification: "api", code: "UPSTREAM", message: "failed" } },
			{ type: "done", status: "failed", stopReason: "error" },
		];
		for (const [index, event] of expected.entries()) {
			transport.emit(notification(operationId, index + 1, event));
		}
		transport.emit(notification(operationId, 4, { type: "text.delta", text: "must not leak" }));
		await Promise.resolve();
		transport.acceptOperationRequest();
		const operation = await operationPromise;
		const events: ProviderStreamEvent[] = [];
		for await (const event of operation.events()) events.push(event);
		expect(events).toEqual(expected);
		expect(client.getDiagnostics()).toMatchObject({
			activeOperations: 0,
			queuedBytes: 0,
			protocolErrors: 0,
			lateEvents: 1,
		});
		expect(transport.killed).toEqual([]);
	});

	it("preserves buffered cancelled done and its AbortError", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		transport.deferOperationAcceptance();
		const operationPromise = client.generate(generateParams());
		const operationId = getOperationId(transport.requests.at(-1)?.params);
		transport.emit(
			notification(operationId, 1, {
				type: "done",
				status: "cancelled",
				stopReason: "cancelled",
			}),
		);
		await Promise.resolve();
		transport.acceptOperationRequest();
		const stream = (await operationPromise).events();
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "done" } });
		await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
		expect(transport.killed).toEqual([]);
	});

	it.each([
		{ sequences: [2] },
		{ sequences: [1, 1] },
		{ sequences: [1, 3] },
		{ sequences: [1, 2, 1] },
	])("rejects invalid early sequences %j", async ({ sequences }) => {
		const { client, transport } = await setup();
		clients.push(client);
		transport.deferOperationAcceptance();
		const operationPromise = client.chat(chatParams());
		const operationId = getOperationId(transport.requests.at(-1)?.params);
		for (const seq of sequences) {
			transport.emit(notification(operationId, seq, { type: "text.delta", text: "early" }));
		}
		await Promise.resolve();
		transport.acceptOperationRequest();
		await expect(operationPromise).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
		expect(client.getDiagnostics().activeOperations).toBe(0);
		expect(transport.killed).toHaveLength(0);
	});

	it.each([
		{ count: 33, bodyBytes: 128 },
		{ count: 3, bodyBytes: 128 * 1024 },
	])("bounds pre-accepted buffering: %j", async ({ count, bodyBytes }) => {
		const { client, transport } = await setup();
		clients.push(client);
		transport.deferOperationAcceptance();
		const operationPromise = client.chat(chatParams());
		const operationId = getOperationId(transport.requests.at(-1)?.params);
		for (let seq = 1; seq <= count; seq++) {
			transport.emit(
				notification(operationId, seq, { type: "text.delta", text: "early" }),
				bodyBytes,
			);
		}
		await Promise.resolve();
		transport.acceptOperationRequest();
		await expect(operationPromise).rejects.toMatchObject({ code: "QUEUE_LIMIT" });
		expect(client.getDiagnostics().activeOperations).toBe(0);
		expect(transport.killed).toHaveLength(0);
	});

	it("still rejects failed done without error when flushing", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		transport.deferOperationAcceptance();
		const operationPromise = client.chat(chatParams());
		const operationId = getOperationId(transport.requests.at(-1)?.params);
		transport.emit(
			notification(operationId, 1, { type: "done", status: "failed", stopReason: "error" }),
		);
		await Promise.resolve();
		transport.acceptOperationRequest();
		const operation = await operationPromise;
		await expect(operation.events().next()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
		expect(transport.killed).toHaveLength(0);
	});

	it("disposes crashed operations without replacing their unknown-result safety metadata", async () => {
		const { client, transport } = await setup({ limits: { cancelGraceMs: 10 } });
		clients.push(client);
		const operation = await client.chat(chatParams());
		transport.emit(
			notification(operation.operationId, 1, {
				type: "tool_call.start",
				toolUseId: "tool-before-crash",
				name: "echo",
			}),
		);
		await Promise.resolve();
		transport.crash();
		await client.dispose();
		await expect(operation.events().next()).rejects.toMatchObject({
			code: "UNKNOWN_RESULT",
			exposedToolCall: true,
			retryable: false,
			unknownResult: true,
		});
		expect(client.getDiagnostics()).toMatchObject({ activeOperations: 0, queuedBytes: 0 });
		expect(transport.requests.some((item) => item.method === "provider.cancel")).toBe(false);
		await Bun.sleep(20);
		expect(transport.killed).toEqual([]);
	});

	it("disposes active operations without leaving a timer that can kill a reused runtime", async () => {
		const { client, transport } = await setup({ limits: { cancelGraceMs: 10 } });
		clients.push(client);
		const operation = await client.chat(chatParams());
		const stream = operation.events();
		const pending = stream.next();
		const rejected = pending.catch((error: unknown) => error);
		await client.dispose();
		expect(await rejected).toMatchObject({ code: "CANCELLED" });
		expect(client.getDiagnostics().activeOperations).toBe(0);
		expect(transport.requests.filter((item) => item.method === "provider.cancel")).toHaveLength(1);
		await Bun.sleep(20);
		expect(transport.killed).toEqual([]);
	});
});

describe("provider dump events", () => {
	function dumpChatParams(maxBytes = 1024) {
		return { ...chatParams(), requestDump: { maxBytes } };
	}

	it("delivers solicited dump events without marking the operation as visible output", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.chat(dumpChatParams());
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "dump.request",
				url: "https://upstream.example.test/v1/chat",
				headers: { "content-type": "application/json" },
				bodyChunk: "{}",
				final: true,
			}),
		);
		transport.emit(
			notification(operation.operationId, 2, {
				type: "dump.response",
				status: 200,
				bodyChunk: "data: ok",
				final: true,
			}),
		);
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "dump.request" } });
		// Dump events are diagnostic metadata: the operation must stay replay-safe until
		// real model output arrives, otherwise an upstream retry would be blocked by
		// evidence collection alone.
		expect(operation.replaySafe).toBe(true);
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "dump.response" } });
		transport.emit(notification(operation.operationId, 3, { type: "text.delta", text: "hi" }));
		transport.emit(
			notification(operation.operationId, 4, {
				type: "done",
				status: "completed",
				stopReason: "end_turn",
			}),
		);
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "text.delta" } });
		await expect(stream.next()).resolves.toMatchObject({ value: { type: "done" } });
		await expect(stream.next()).resolves.toMatchObject({ done: true });
		expect(transport.killed).toHaveLength(0);
	});

	it("rejects unsolicited dump events as a protocol violation", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		// No requestDump hint: the plugin may not emit dump events, because hosts that
		// predate them would kill the transport on the unknown event type.
		const operation = await client.chat(chatParams());
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "dump.request",
				url: "https://upstream.example.test/v1/chat",
				final: true,
			}),
		);
		await expect(stream.next()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
		expect(client.getDiagnostics().protocolErrors).toBe(1);
		expect(transport.killed).toHaveLength(0);
	});

	it("rejects dump events on generate operations as a protocol violation", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.generate(generateParams());
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "dump.response",
				status: 200,
				bodyChunk: "ok",
				final: true,
			}),
		);
		await expect(stream.next()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
		expect(client.getDiagnostics().protocolErrors).toBe(1);
		expect(transport.killed).toHaveLength(0);
	});

	it("cancels the operation when dump output exceeds the advertised budget", async () => {
		const { client, transport } = await setup();
		clients.push(client);
		const operation = await client.chat(dumpChatParams(4));
		const stream = operation.events();
		transport.emit(
			notification(operation.operationId, 1, {
				type: "dump.response",
				status: 200,
				bodyChunk: "toolong",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const cancellations = transport.requests.filter((item) => item.method === "provider.cancel");
		expect(cancellations).toHaveLength(1);
		expect(cancellations[0].params).toMatchObject({
			operationId: operation.operationId,
			reason: "output_limit",
		});
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
});
