import { describe, expect, it, spyOn } from "bun:test";
import {
	type JsonRpcEnvelope,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	PROVIDER_REQUEST_MAX_BYTES,
} from "../../../server/lib/plugins/protocol";
import { PluginHostDispatcher } from "../../../server/services/plugin-host-dispatcher";
import {
	PluginPriorityWriter,
	PluginRpcConnection,
	type PluginRpcTransport,
} from "../../../server/services/plugin-rpc-connection";

class MemoryTransport implements PluginRpcTransport {
	readonly writes: JsonRpcEnvelope[] = [];
	private readonly messageHandlers = new Set<(message: JsonRpcEnvelope) => void>();
	private readonly errorHandlers = new Set<(error: Error) => void>();
	private readonly exitHandlers = new Set<(exitCode: number) => void>();
	onSend?: (message: JsonRpcEnvelope) => void;

	send(message: JsonRpcEnvelope): Promise<void> {
		this.writes.push(message);
		this.onSend?.(message);
		return Promise.resolve();
	}

	onMessage(handler: (message: JsonRpcEnvelope) => void): () => void {
		this.messageHandlers.add(handler);
		return () => this.messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.errorHandlers.add(handler);
		return () => this.errorHandlers.delete(handler);
	}

	onExit(handler: (exitCode: number) => void): () => void {
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	emit(message: JsonRpcEnvelope): void {
		for (const handler of this.messageHandlers) handler(message);
	}

	emitError(error: Error): void {
		for (const handler of this.errorHandlers) handler(error);
	}

	emitExit(exitCode: number): void {
		for (const handler of this.exitHandlers) handler(exitCode);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await sleep(1);
	if (!predicate()) throw new Error("condition did not become true before timeout");
}

function responseFor(id: string | number, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result: result as never };
}

function notification(method: string, params?: unknown): JsonRpcNotification {
	return {
		jsonrpc: "2.0",
		method,
		...(params === undefined ? {} : { params: params as never }),
	};
}

describe("PluginRpcConnection", () => {
	it("serializes outbound bodies once and accounts for UTF-8 framing and control reserve", async () => {
		const transport = new MemoryTransport();
		const message = notification("bytes", { text: "中文" });
		const bodyBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
		const frameBytes =
			bodyBytes +
			new TextEncoder().encode(
				`Content-Length: ${bodyBytes}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
			).byteLength;
		const connection = new PluginRpcConnection({
			transport,
			maxOutboundFrameBytes: bodyBytes,
			maxQueuedBytes: frameBytes + 1,
			controlReserveBytes: 1,
		});
		let release!: () => void;
		transport.send = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const stringify = spyOn(JSON, "stringify");
		let pending: Promise<void>;
		try {
			pending = connection.notify("bytes", { text: "中文" });
			expect(stringify.mock.calls.filter(([value]) => value?.method === "bytes")).toHaveLength(1);
		} finally {
			stringify.mockRestore();
		}
		expect(connection.queuedBytes).toBe(frameBytes);
		await expect(connection.notify("bytes", { text: "中文" })).rejects.toMatchObject({
			code: "OUTBOUND_QUEUE_FULL",
		});
		release();
		await pending;
		await expect(connection.notify("bytes", { text: "中文a" })).rejects.toMatchObject({
			code: "OUTBOUND_FRAME_LIMIT",
		});
		await connection.close();
	});

	it("keeps outbound and inbound request ids in separate maps", async () => {
		const transport = new MemoryTransport();
		const dispatcher = new PluginHostDispatcher({
			pluginId: "com.example.rpc",
			runtimeId: "rt-test",
			runtimeGeneration: 1,
			methods: {
				"plugin.echo": {
					method: "plugin.echo",
					handler: async (params) => ({ echoed: params }),
				},
			},
		});
		const connection = new PluginRpcConnection({
			transport,
			generation: 1,
			dispatcher,
			idFactory: () => "same-id",
		});

		const outbound = connection.request("host.echo", { value: 1 }, { id: "same-id" });
		transport.emit({
			jsonrpc: "2.0",
			id: "same-id",
			method: "plugin.echo",
			params: { value: 2 },
		});
		transport.emit(responseFor("same-id", { host: true }));

		await expect(outbound).resolves.toMatchObject({ result: { host: true } });
		await eventually(() =>
			transport.writes.some(
				(message) =>
					"id" in message &&
					message.id === "same-id" &&
					"result" in message &&
					(message.result as { echoed?: unknown }).echoed !== undefined,
			),
		);
		expect(connection.outboundPending.size).toBe(0);
		expect(connection.inboundActive.size).toBe(0);
		await connection.close();
	});

	it("sends a full 64 MiB image request, rejects one extra byte, and preserves inbound limits", async () => {
		expect(PROVIDER_REQUEST_MAX_BYTES).toBe(64 * 1024 * 1024);
		const transport = new MemoryTransport();
		const connection = new PluginRpcConnection({
			transport,
			maxFrameBytes: 1024,
			maxOutboundFrameBytes: PROVIDER_REQUEST_MAX_BYTES,
		});
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			id: "image-boundary",
			method: "provider.chat",
			params: {
				protocolVersion: "1.0",
				operationId: "op-boundary",
				request: {
					current: {
						text: "图片边界",
						images: [{ mediaType: "image/png", dataBase64: "" }],
						toolResults: [],
					},
					history: [],
					tools: [],
				},
			},
		};
		const params = request.params as {
			request: {
				current: { text: string; images: Array<{ mediaType: string; dataBase64: string }> };
			};
		};
		// Size the complete UTF-8 JSON body, not decoded image bytes or the framing header.
		const overhead = Buffer.byteLength(JSON.stringify(request), "utf8");
		const available = PROVIDER_REQUEST_MAX_BYTES - overhead;
		params.request.current.text += "x".repeat(available % 4);
		params.request.current.images[0].dataBase64 = "A".repeat(available - (available % 4));
		expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBe(PROVIDER_REQUEST_MAX_BYTES);
		transport.onSend = (message) => {
			if ("id" in message && message.id !== undefined)
				transport.emit(responseFor(message.id, true));
		};
		try {
			await expect(
				connection.request(request.method, params, { id: request.id }),
			).resolves.toMatchObject({ result: true });
			await eventually(() => connection.queuedMessages === 0);
			expect(transport.writes.length).toBe(1);
			expect(connection.getDiagnostics()).toMatchObject({
				outboundPending: 0,
				queuedBytes: 0,
				queuedMessages: 0,
			});
			// Drop the successful frame reference before constructing the oversized request.
			transport.writes.length = 0;
			params.request.current.text += "x";
			expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBe(
				PROVIDER_REQUEST_MAX_BYTES + 1,
			);
			await expect(
				connection.request(request.method, params, { id: request.id }),
			).rejects.toMatchObject({ code: "OUTBOUND_FRAME_LIMIT" });
			expect(transport.writes.length).toBe(0);
			expect(connection.isClosed).toBe(false);
			expect(connection.getDiagnostics()).toMatchObject({
				outboundPending: 0,
				queuedBytes: 0,
				queuedMessages: 0,
			});
			await expect(
				connection.request("plugin.health", {}, { id: "health-after-limit" }),
			).resolves.toMatchObject({ result: true });
			await eventually(() => connection.queuedMessages === 0);
			expect(transport.writes.length).toBe(1);
			expect(transport.writes[0]).toMatchObject({ method: "plugin.health" });
			expect(connection.getDiagnostics()).toMatchObject({
				outboundPending: 0,
				queuedBytes: 0,
				queuedMessages: 0,
			});
			expect(connection.getLimits().maxInboundFrameBytes).toBe(1024);
			expect(connection.getLimits().maxQueuedBytes).toBeGreaterThan(PROVIDER_REQUEST_MAX_BYTES);
			transport.emit(notification("too-large", { text: "x".repeat(2048) }));
			await eventually(() => connection.isClosed);
		} finally {
			await connection.close();
		}
	});

	it("measures full UTF-8 outbound frames and keeps a rejected connection usable", async () => {
		const transport = new MemoryTransport();
		const text = "界".repeat(30);
		const max = Buffer.byteLength(
			JSON.stringify({ jsonrpc: "2.0", id: "cap", method: "echo", params: { text } }),
		);
		const connection = new PluginRpcConnection({
			transport,
			maxFrameBytes: 64,
			maxOutboundFrameBytes: max,
		});
		transport.onSend = (message) => {
			if ("id" in message && message.id !== undefined)
				transport.emit(responseFor(message.id, true));
		};
		try {
			await expect(connection.request("echo", { text }, { id: "cap" })).resolves.toMatchObject({
				result: true,
			});
			await expect(
				connection.request("echo", { text: `${text}界` }, { id: "cap" }),
			).rejects.toMatchObject({ code: "OUTBOUND_FRAME_LIMIT" });
			expect(connection.isClosed).toBe(false);
			expect(connection.outboundPending.size).toBe(0);
			await expect(
				connection.request("echo", { text: "ok" }, { id: "cap" }),
			).resolves.toMatchObject({ result: true });
		} finally {
			await connection.close();
		}
	});

	it("removes outbound pending state when the bounded queue rejects a request", async () => {
		const transport = new MemoryTransport();
		const connection = new PluginRpcConnection({
			transport,
			maxQueuedBytes: 256,
			controlReserveBytes: 64,
			maxQueuedMessages: 4,
			controlReserveMessages: 1,
		});
		const pending = connection.request("oversized", { value: "x".repeat(512) });
		await expect(pending).rejects.toMatchObject({ code: "OUTBOUND_QUEUE_FULL" });
		expect(connection.outboundPending.size).toBe(0);
		await connection.close();
	});

	it("rejects a cancelled message waiter instead of leaving it pending forever", async () => {
		const transport = new MemoryTransport();
		const connection = new PluginRpcConnection({ transport });
		const waiter = connection.createWaiter(() => false, 500, "test-waiter");
		waiter.cancel();
		await expect(waiter.promise).rejects.toMatchObject({ code: "WAITER_CANCELLED" });
		await connection.close();
	});

	it("closes on an inbound frame that exceeds the configured byte limit", async () => {
		const transport = new MemoryTransport();
		const connection = new PluginRpcConnection({ transport, maxFrameBytes: 32 });
		transport.emit({ jsonrpc: "2.0", method: "large", params: { value: "x".repeat(64) } });
		await eventually(() => connection.isClosed);
		expect(connection.isClosed).toBe(true);
	});

	it("returns a generic JSON-RPC error for duplicate inbound ids", async () => {
		const transport = new MemoryTransport();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const dispatcher = new PluginHostDispatcher({
			pluginId: "com.example.rpc",
			runtimeId: "rt-test",
			runtimeGeneration: 1,
			methods: {
				wait: {
					method: "wait",
					sideEffect: "none",
					handler: async () => {
						calls++;
						await gate;
						return { ok: true };
					},
				},
			},
		});
		const connection = new PluginRpcConnection({ transport, generation: 1, dispatcher });
		const request = { jsonrpc: "2.0" as const, id: "duplicate", method: "wait" };
		transport.emit(request);
		await eventually(() => calls === 1);
		transport.emit(request);
		await eventually(() =>
			transport.writes.some(
				(message) =>
					"id" in message &&
					message.id === "duplicate" &&
					"error" in message &&
					(message.error.data as { code?: string } | undefined)?.code === "DUPLICATE_REQUEST_ID",
			),
		);
		expect(calls).toBe(1);
		release();
		await eventually(() => connection.inboundActive.size === 0);
		await connection.close();
	});

	it("propagates plugin cancellation to the handler AbortSignal without a second response", async () => {
		const transport = new MemoryTransport();
		let started = false;
		let aborted = false;
		const dispatcher = new PluginHostDispatcher({
			pluginId: "com.example.rpc",
			runtimeId: "rt-test",
			runtimeGeneration: 1,
			methods: {
				cancelable: {
					method: "cancelable",
					sideEffect: "none",
					handler: async (_params, context) => {
						started = true;
						await new Promise<void>((resolve) => {
							context.signal.addEventListener(
								"abort",
								() => {
									aborted = true;
									resolve();
								},
								{ once: true },
							);
						});
						return { shouldNotSend: true };
					},
				},
			},
		});
		const connection = new PluginRpcConnection({ transport, generation: 1, dispatcher });
		transport.emit({ jsonrpc: "2.0", id: "cancel-me", method: "cancelable" });
		await eventually(() => started);
		transport.emit(notification("$/cancelRequest", { requestId: "cancel-me", reason: "user" }));
		await eventually(() =>
			transport.writes.some(
				(message) =>
					"id" in message &&
					message.id === "cancel-me" &&
					"error" in message &&
					(message.error.data as { code?: string } | undefined)?.code === "CANCELLED",
			),
		);
		expect(aborted).toBe(true);
		const responses = transport.writes.filter(
			(message) => "id" in message && message.id === "cancel-me",
		);
		expect(responses).toHaveLength(1);
		await connection.close();
	});

	it("denies Plugin -> Host methods until required features are negotiated", async () => {
		const transport = new MemoryTransport();
		let calls = 0;
		const dispatcher = new PluginHostDispatcher({
			pluginId: "com.example.rpc",
			runtimeId: "rt-test",
			runtimeGeneration: 1,
			methods: {
				"queries.execute": {
					method: "queries.execute",
					handler: async () => {
						calls++;
						return { ok: true };
					},
				},
			},
		});
		const connection = new PluginRpcConnection({
			transport,
			generation: 1,
			dispatcher,
			enforceFeatureNegotiation: true,
			negotiatedFeatures: [],
		});
		transport.emit({ jsonrpc: "2.0", id: "denied", method: "queries.execute" });
		await eventually(() =>
			transport.writes.some(
				(message) =>
					"id" in message &&
					message.id === "denied" &&
					"error" in message &&
					(message.error.data as { code?: string } | undefined)?.code === "INCOMPATIBLE",
			),
		);
		expect(calls).toBe(0);
		connection.setNegotiatedFeatures(["host_api.requests"], true);
		transport.emit({ jsonrpc: "2.0", id: "allowed", method: "queries.execute" });
		await eventually(() => calls === 1);
		await connection.close();
	});

	it("discards stale generation responses and notifications", async () => {
		const transport = new MemoryTransport();
		const late: JsonRpcEnvelope[] = [];
		const connection = new PluginRpcConnection({
			transport,
			generation: 1,
			idFactory: () => "request-1",
			onLateMessage: (message) => late.push(message),
		});
		const pending = connection.request("echo", undefined, { timeoutMs: 500 });
		connection.setGeneration(2);
		transport.emit(responseFor("request-1", { stale: true }));
		transport.emit(notification("event", { generation: 1 }));
		await expect(pending).rejects.toMatchObject({ code: "STALE_GENERATION" });
		expect(connection.lateMessages).toBe(2);
		expect(late).toHaveLength(2);
		await connection.close();
	});
});

describe("PluginPriorityWriter", () => {
	it("reserves capacity for control frames and sends control before queued ordinary frames", async () => {
		const sent: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		const writer = new PluginPriorityWriter(
			async (message) => {
				if (first) {
					first = false;
					await gate;
				}
				sent.push("method" in message ? message.method : `response:${String(message.id)}`);
			},
			{
				maxQueuedBytes: 512,
				controlReserveBytes: 160,
				maxQueuedMessages: 8,
				controlReserveMessages: 2,
			},
		);
		const ordinary = (method: string) => ({
			jsonrpc: "2.0" as const,
			method,
			params: { x: "ordinary" },
		});
		const firstWrite = writer.enqueue(ordinary("ordinary-1"), "unary");
		const queuedWrite = writer.enqueue(ordinary("ordinary-2"), "unary");
		const controlWrite = writer.enqueue(
			notification("$/cancelRequest", { requestId: "x", reason: "test" }),
			"control",
		);
		release();
		await Promise.all([firstWrite, queuedWrite, controlWrite]);
		expect(sent[0]).toBe("ordinary-1");
		expect(sent[1]).toBe("$/cancelRequest");
		expect(writer.queuedBytes).toBe(0);
	});

	it("resolves flush after closing a stalled writer", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writer = new PluginPriorityWriter(async () => gate);
		const write = writer.enqueue({ jsonrpc: "2.0", method: "stalled" }, "stream");
		const flushed = writer.flush();
		writer.close();
		await expect(write).rejects.toMatchObject({ code: "RPC_CONNECTION_CLOSED" });
		await expect(flushed).resolves.toBeUndefined();
		release();
	});
});
