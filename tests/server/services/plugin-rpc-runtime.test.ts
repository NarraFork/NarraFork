import { expect, test } from "bun:test";
import type { JsonRpcEnvelope } from "../../../server/lib/plugins/protocol";
import { PluginHostDispatcher } from "../../../server/services/plugin-host-dispatcher";
import {
	type PluginProcessHandle,
	type PluginRunner,
	PluginRuntime,
} from "../../../server/services/plugin-runtime";

class RuntimeHandle implements PluginProcessHandle {
	readonly writes: JsonRpcEnvelope[] = [];
	private readonly messageHandlers = new Set<(message: JsonRpcEnvelope) => void>();
	private readonly errorHandlers = new Set<(error: Error) => void>();
	private readonly exitHandlers = new Set<(exitCode: number) => void>();
	private resolveExit!: (code: number) => void;
	private exitedCode: number | undefined;
	readonly exited = new Promise<number>((resolve) => {
		this.resolveExit = resolve;
	});

	send(message: JsonRpcEnvelope): Promise<void> {
		this.writes.push(message);
		if (!("method" in message) || !("id" in message)) return Promise.resolve();
		const event =
			message.method === "initialize"
				? "initialized"
				: message.method === "activate"
					? "activated"
					: message.method === "health"
						? "healthy"
						: message.method === "deactivate"
							? "deactivated"
							: message.method === "shutdown"
								? "shutdown"
								: undefined;
		if (event) {
			this.emit({ jsonrpc: "2.0", id: message.id, result: { [event]: true } });
		}
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
		if (this.exitedCode !== undefined) handler(this.exitedCode);
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	getStderr(): string {
		return "";
	}

	kill(): void {
		this.finish(137);
	}

	async close(): Promise<void> {
		this.finish(0);
	}

	emit(message: JsonRpcEnvelope): void {
		for (const handler of this.messageHandlers) handler(message);
	}

	private finish(code: number): void {
		if (this.exitedCode !== undefined) return;
		this.exitedCode = code;
		this.resolveExit(code);
		for (const handler of this.exitHandlers) handler(code);
	}
}

class RuntimeRunner implements PluginRunner {
	readonly handles: RuntimeHandle[] = [];

	async start(): Promise<PluginProcessHandle> {
		const handle = new RuntimeHandle();
		this.handles.push(handle);
		setTimeout(() =>
			handle.emit({
				jsonrpc: "2.0",
				method: "hello",
				params: {
					pluginId: "com.example.runtime",
					version: "1.0.0",
					rpcProtocol: "narrafork.rpc/1",
					features: ["host_api.requests"],
				},
			}),
		);
		return handle;
	}
}

test("PluginRuntime closes the bidirectional loop with an injected Host dispatcher", async () => {
	const runner = new RuntimeRunner();
	const dispatcher = new PluginHostDispatcher({
		identity: {
			pluginId: "com.example.attacker",
			packageVersion: "9.9.9",
			installationId: "attacker-installation",
			runtimeId: "attacker-runtime",
			runtimeGeneration: 999,
		},
		methods: {
			"queries.execute": {
				method: "queries.execute",
				handler: async (params, context) => ({
					value: params,
					pluginId: context.plugin.pluginId,
					userId: context.invocation.userId ?? null,
				}),
			},
		},
	});
	let closeCount = 0;
	const runtime = new PluginRuntime({
		pluginId: "com.example.runtime",
		pluginVersion: "1.0.0",
		runtimeId: "rt-injected",
		command: [process.execPath, "unused"],
		cwd: process.cwd(),
		runner,
		dispatcher,
		timeouts: { handshakeMs: 200, activationMs: 200, rpcMs: 200, shutdownMs: 50, drainMs: 20 },
	});
	runtime.onClose(() => {
		closeCount++;
	});

	await runtime.start();
	const handle = runner.handles[0];
	const initialize = handle.writes.find(
		(message) => "method" in message && message.method === "initialize",
	);
	expect(initialize).toMatchObject({
		params: { features: ["host_api.requests"] },
	});
	handle.emit({
		jsonrpc: "2.0",
		id: "plugin-request",
		method: "queries.execute",
		params: {
			pluginId: "com.example.attacker",
			userId: "admin",
			value: "host-owned",
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	const response = handle.writes.find(
		(message) => "id" in message && message.id === "plugin-request",
	);
	expect(response).toMatchObject({
		jsonrpc: "2.0",
		id: "plugin-request",
		result: {
			value: {
				pluginId: "com.example.attacker",
				userId: "admin",
				value: "host-owned",
			},
			pluginId: "com.example.runtime",
			userId: null,
		},
	});
	expect(runtime.rpcConnection?.outboundPending.size).toBe(0);
	expect(runtime.rpcConnection?.inboundActive.size).toBe(0);
	await runtime.shutdown();
	expect(closeCount).toBe(1);
});
