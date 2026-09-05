import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { JsonRpcNotification, ProviderStreamEvent } from "@server/lib/plugins/protocol";
import {
	PluginProviderClientPool,
	type ProviderRuntimeLike,
} from "@server/services/plugin-provider-client";
import type { PluginProviderRpcClient } from "@server/services/plugin-provider-rpc";
import { LocalProcessRunner, PluginRuntime } from "@server/services/plugin-runtime";

const pluginId = "com.example.provider";
const providerTypeId = `${pluginId}/main`;
const providerInstanceId = `${pluginId}/main`;
const pools: PluginProviderClientPool[] = [];

afterEach(() => {
	for (const pool of pools.splice(0)) pool.clear();
});

function describeResult() {
	return {
		selectedProtocolVersion: "1.0",
		plugin: { id: pluginId, name: "Example Provider", version: "1.0.0" },
		providers: [
			{
				localId: "main",
				displayName: "Example",
				configSchema: { type: "object", additionalProperties: true },
				capabilities: { validateConfig: true, listModels: true, chat: true, generate: true },
				limits: {
					maxConcurrentChat: 1,
					maxConcurrentGenerate: 1,
					maxConfigBytes: 4096,
					maxModelPageSize: 20,
				},
			},
		],
	};
}

function deferredValue<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

class CloseableRuntime implements ProviderRuntimeLike {
	describeCalls = 0;
	readonly describeResponses: Promise<unknown>[] = [];
	readonly quarantines: string[] = [];
	readonly notificationHandlers = new Set<
		(notification: JsonRpcNotification, bodyBytes?: number) => void
	>();
	readonly closeHandlers = new Set<(error?: Error) => void>();

	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		if (method === "provider.describe") {
			this.describeCalls += 1;
			return (this.describeResponses.shift() ?? Promise.resolve(describeResult())) as Promise<T>;
		}
		const { operationId } = params as { operationId: string };
		if (method === "provider.chat") return Promise.resolve({ accepted: true, operationId } as T);
		if (method === "provider.cancel") {
			return Promise.resolve({ operationId, state: "cancelling" } as T);
		}
		return Promise.reject(new Error(`unexpected method: ${method}`));
	}

	notify(): Promise<void> {
		return Promise.resolve();
	}

	quarantine(reason: string): void {
		this.quarantines.push(reason);
	}

	onNotification(handler: (notification: never, bodyBytes?: number) => void): () => void {
		const typedHandler = handler as unknown as (
			notification: JsonRpcNotification,
			bodyBytes?: number,
		) => void;
		this.notificationHandlers.add(typedHandler);
		return () => this.notificationHandlers.delete(typedHandler);
	}

	onClose(handler: (error?: Error) => void): () => void {
		this.closeHandlers.add(handler);
		return () => this.closeHandlers.delete(handler);
	}

	close(error = new Error("runtime closed")): void {
		for (const handler of [...this.closeHandlers]) handler(error);
	}

	emit(operationId: string, seq: number, event: ProviderStreamEvent): void {
		for (const handler of this.notificationHandlers) {
			handler({
				jsonrpc: "2.0",
				method: "provider.event",
				params: { protocolVersion: "1.0", operationId, seq, event },
			});
		}
	}
}

function createPool(resolveRuntime: () => Promise<ProviderRuntimeLike>) {
	const pool = new PluginProviderClientPool(resolveRuntime);
	pools.push(pool);
	return { pool, deferred: pool.get({ pluginId, providerTypeId, providerInstanceId }) };
}

function chatParams(typeId = providerTypeId) {
	return {
		providerTypeId: typeId,
		providerInstanceId,
		providerPrefix: "example",
		modelId: "example/offline",
		config: {},
		conversation: { conversationId: "reconnected" },
		request: { history: [], current: { text: "hello", toolResults: [] }, tools: [] },
	};
}

async function expectHealthyStream(client: PluginProviderRpcClient, runtime: CloseableRuntime) {
	const operation = await client.chat(chatParams());
	const expected: ProviderStreamEvent[] = [
		...Array.from({ length: 4 }, (_, index) => ({ type: "text.delta" as const, text: `${index}` })),
		{ type: "done", status: "completed", stopReason: "end_turn" },
	];
	for (const [index, event] of expected.entries())
		runtime.emit(operation.operationId, index + 1, event);
	const events: ProviderStreamEvent[] = [];
	for await (const event of operation.events()) events.push(event);
	expect(events).toEqual(expected);
	expect(client.getDiagnostics()).toMatchObject({
		activeOperations: 0,
		lateEvents: 0,
		protocolErrors: 0,
		transportKilled: false,
	});
	expect(runtime.quarantines).toEqual([]);
}

function expectUnsubscribed(runtime: CloseableRuntime) {
	expect(runtime.notificationHandlers.size).toBe(0);
	expect(runtime.closeHandlers.size).toBe(0);
}

describe("PluginProviderClientPool runtime lifecycle", () => {
	it("drops a cached client on close and streams normally when the runtime object is reused", async () => {
		const runtime = new CloseableRuntime();
		const { deferred } = createPool(async () => runtime);
		const first = await deferred.acquire();
		expect(runtime.describeCalls).toBe(1);
		expect(deferred.peek()).toBe(first);
		await expectHealthyStream(first, runtime);

		runtime.close();
		expect(deferred.peek()).toBeUndefined();
		expectUnsubscribed(runtime);
		await expect(first.describe()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });

		const second = await deferred.acquire();
		expect(second).not.toBe(first);
		expect(runtime.describeCalls).toBe(2);
		expect(runtime.notificationHandlers.size).toBe(1);
		await expectHealthyStream(second, runtime);
		expect(first.getDiagnostics().lateEvents).toBe(0);
	});

	it.each(["reset", "evict", "clear"])("releases all subscriptions on %s", async (action) => {
		const runtime = new CloseableRuntime();
		const { pool, deferred } = createPool(async () => runtime);
		const first = await deferred.acquire();
		const oldCloseHandlers = [...runtime.closeHandlers];
		// Notifications already queued for an old client are harmless after disposal.
		runtime.emit("old-operation", 1, { type: "text.delta", text: "queued before reset" });
		if (action === "reset") deferred.reset();
		else if (action === "evict") expect(pool.evictPlugin(pluginId)).toBe(1);
		else pool.clear();
		expectUnsubscribed(runtime);
		const replacement = pool.get({ pluginId, providerTypeId, providerInstanceId });
		const second = await replacement.acquire();
		for (const handler of oldCloseHandlers) handler(new Error("old delayed close"));
		expect(replacement.peek()).toBe(second);
		expect(first.getDiagnostics().lateEvents).toBe(0);
		await expectHealthyStream(second, runtime);
	});

	it.each([
		"reject",
		"invalid",
	])("releases subscriptions after a %s describe handshake", async (kind) => {
		const runtime = new CloseableRuntime();
		const response = deferredValue<unknown>();
		runtime.describeResponses.push(response.promise);
		const { deferred } = createPool(async () => runtime);
		const pending = deferred.acquire();
		const rejected = pending.catch((error: unknown) => error);
		await Promise.resolve();
		expect(runtime.describeCalls).toBe(1);
		const oldCloseHandlers = [...runtime.closeHandlers];
		if (kind === "reject") response.reject(new Error("handshake failed"));
		else response.resolve({});
		expect(await rejected).toBeInstanceOf(Error);
		expectUnsubscribed(runtime);
		expect(deferred.peek()).toBeUndefined();
		const client = await deferred.acquire();
		for (const handler of oldCloseHandlers) handler(new Error("late close from failed handshake"));
		expect(deferred.peek()).toBe(client);
		expect(runtime.describeCalls).toBe(2);
		await expectHealthyStream(client, runtime);
	});

	it("does not subscribe a reset activation or let its finally clear a newer pending activation", async () => {
		const oldRuntime = new CloseableRuntime();
		const runtime = new CloseableRuntime();
		const firstResolution = deferredValue<ProviderRuntimeLike>();
		const secondResolution = deferredValue<ProviderRuntimeLike>();
		let resolutions = 0;
		const { deferred } = createPool(() => {
			resolutions += 1;
			return resolutions === 1 ? firstResolution.promise : secondResolution.promise;
		});
		const first = deferred.acquire();
		const rejected = first.catch((error: unknown) => error);
		deferred.reset();
		const second = deferred.acquire();
		firstResolution.resolve(oldRuntime);
		expect(await rejected).toMatchObject({ message: "Provider client activation was reset" });
		expectUnsubscribed(oldRuntime);
		expect(oldRuntime.describeCalls).toBe(0);
		const concurrent = deferred.acquire();
		expect(resolutions).toBe(2);
		secondResolution.resolve(runtime);
		const client = await second;
		expect(await concurrent).toBe(client);
		expect(runtime.describeCalls).toBe(1);
		await expectHealthyStream(client, runtime);
	});

	it("releases a pending handshake on reset and ignores its old close and completion", async () => {
		const runtime = new CloseableRuntime();
		const firstResponse = deferredValue<unknown>();
		const secondResponse = deferredValue<unknown>();
		runtime.describeResponses.push(firstResponse.promise, secondResponse.promise);
		const { deferred } = createPool(async () => runtime);
		const first = deferred.acquire();
		const rejected = first.catch((error: unknown) => error);
		await Promise.resolve();
		expect(runtime.describeCalls).toBe(1);
		const oldCloseHandlers = [...runtime.closeHandlers];
		deferred.reset();
		expectUnsubscribed(runtime);
		const second = deferred.acquire();
		await Promise.resolve();
		firstResponse.resolve(describeResult());
		expect(await rejected).toMatchObject({ message: "Provider client activation was reset" });
		const concurrent = deferred.acquire();
		for (const handler of oldCloseHandlers) handler(new Error("delayed old close"));
		secondResponse.resolve(describeResult());
		const client = await second;
		expect(await concurrent).toBe(client);
		for (const handler of oldCloseHandlers) handler(new Error("old close after replacement"));
		expect(deferred.peek()).toBe(client);
		expect(runtime.describeCalls).toBe(2);
		expect(runtime.notificationHandlers.size).toBe(1);
		await expectHealthyStream(client, runtime);
	});

	it("reconnects immediately after close during describe without reviving the old activation", async () => {
		const runtime = new CloseableRuntime();
		const response = deferredValue<unknown>();
		runtime.describeResponses.push(response.promise);
		const { deferred } = createPool(async () => runtime);
		const first = deferred.acquire();
		const rejected = first.catch((error: unknown) => error);
		await Promise.resolve();
		expect(runtime.describeCalls).toBe(1);
		runtime.close();
		expectUnsubscribed(runtime);
		const replacement = await deferred.acquire();
		response.resolve(describeResult());
		expect(await rejected).toMatchObject({ message: "Provider runtime closed during activation" });
		expect(deferred.peek()).toBe(replacement);
		expect(runtime.describeCalls).toBe(2);
		await expectHealthyStream(replacement, runtime);
	});

	it("reuses one isolated PluginRuntime across a real process restart with no stale listeners", async () => {
		// This is the audited, offline reference process only, not a running application runtime.
		const root = resolve(process.cwd(), "examples/plugins/provider");
		const runtime = new PluginRuntime({
			pluginId,
			pluginVersion: "1.0.1",
			command: [process.execPath, resolve(root, "server/index.js")],
			cwd: root,
			runner: new LocalProcessRunner({
				allowedCwds: [root],
				spawnTimeoutMs: 5_000,
				idleTimeoutMs: 10_000,
				totalTimeoutMs: 15_000,
				allowUnboundedResourceUsage: process.platform === "win32",
			}),
			timeouts: { handshakeMs: 5_000, activationMs: 5_000, shutdownMs: 500, drainMs: 100 },
		});
		const { pool } = createPool(async () => {
			await runtime.start();
			return runtime as unknown as ProviderRuntimeLike;
		});
		const typeId = `${pluginId}/example-provider`;
		const deferred = pool.get({ pluginId, providerTypeId: typeId, providerInstanceId: typeId });
		try {
			const first = await deferred.acquire();
			await runtime.restart();
			expect(runtime.generation).toBe(2);
			expect(deferred.peek()).toBeUndefined();
			const second = await deferred.acquire();
			expect(second).not.toBe(first);
			const operation = await second.chat(chatParams(typeId));
			const events: ProviderStreamEvent[] = [];
			for await (const event of operation.events()) events.push(event);
			expect(events.filter((event) => event.type === "text.delta").length).toBeGreaterThan(3);
			expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
			for (const client of [first, second]) {
				expect(client.getDiagnostics()).toMatchObject({
					lateEvents: 0,
					protocolErrors: 0,
					transportKilled: false,
				});
			}
			expect(runtime.state).toBe("active");
		} finally {
			pool.clear();
			await runtime.terminate("isolated client lifecycle test cleanup");
		}
	}, 15_000);
});
