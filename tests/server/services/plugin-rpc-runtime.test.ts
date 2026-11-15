import { expect, test } from "bun:test";
import type { JsonRpcEnvelope } from "../../../server/lib/plugins/protocol";
import { PluginHostDispatcher } from "../../../server/services/plugin-host-dispatcher";
import {
	LocalProcessRunner,
	type PluginProcessHandle,
	type PluginRunner,
	PluginRuntime,
	PluginRuntimeError,
	type RunnerStartOptions,
	RuntimeSupervisor,
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

	constructor(
		private readonly pauseAt?: "hello" | "activate",
		private readonly onPause?: () => void,
	) {}

	send(message: JsonRpcEnvelope): Promise<void> {
		this.writes.push(message);
		if (!("method" in message) || !("id" in message)) return Promise.resolve();
		if (message.method === this.pauseAt) {
			this.onPause?.();
			return Promise.resolve();
		}
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

	emitError(error: Error): void {
		for (const handler of this.errorHandlers) handler(error);
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
	readonly starts: RunnerStartOptions[] = [];
	readonly paused = Promise.withResolvers<void>();

	constructor(private readonly pauseAt?: "hello" | "activate") {}

	async start(options: RunnerStartOptions): Promise<PluginProcessHandle> {
		this.starts.push(options);
		const handle = new RuntimeHandle(this.pauseAt, () => this.paused.resolve());
		this.handles.push(handle);
		if (this.pauseAt !== "hello") {
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
		}
		return handle;
	}
}

test("PluginRuntime advertises actual directional frame and writer limits", async () => {
	const runner = new RuntimeRunner();
	const runtime = new PluginRuntime({
		pluginId: "com.example.runtime",
		pluginVersion: "1.0.0",
		command: [process.execPath, "unused"],
		cwd: process.cwd(),
		runner,
		maxFrameBytes: 1024,
		maxOutboundFrameBytes: 12 * 1024 * 1024,
		timeouts: { handshakeMs: 500, activationMs: 500, shutdownMs: 50, drainMs: 20 },
	});
	try {
		await runtime.start();
		expect(runner.starts[0].maxOutboundBodyBytes).toBe(12 * 1024 * 1024);
		const limits = runtime.rpcConnection?.getLimits();
		expect(limits?.maxInboundFrameBytes).toBe(1024);
		expect(limits?.maxQueuedBytes).toBeGreaterThan(12 * 1024 * 1024);
		const initialize = runner.handles[0].writes.find(
			(message) => "method" in message && message.method === "initialize",
		);
		expect(initialize).toMatchObject({ params: { limits } });
	} finally {
		await runtime.shutdown();
	}
});

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

test.each([
	"hello",
	"activate",
] as const)("PluginRuntime keeps host idle reclamation during %s out of recovery", async (phase) => {
	const runner = new RuntimeRunner(phase);
	const supervisor = new RuntimeSupervisor();
	const handshaking = Promise.withResolvers<void>();
	const states: string[] = [];
	try {
		const starting = supervisor.start({
			pluginId: "com.example.runtime",
			pluginVersion: "1.0.0",
			command: [process.execPath, "unused"],
			cwd: process.cwd(),
			runner,
			onStateChange: (state) => {
				states.push(state);
				if (state === "handshaking") handshaking.resolve();
			},
		});
		await handshaking.promise;
		if (phase === "activate") await runner.paused.promise;
		runner.starts[0].onIdleTimeout?.();
		runner.handles[0].emitError(
			new PluginRuntimeError("Plugin runtime idle timeout", {
				code: "IDLE_TIMEOUT",
				phase: "idle",
				kind: "timeout",
			}),
		);
		runner.handles[0].kill();
		const runtime = await starting;
		expect(runtime.state).toBe("stopped");
		expect(states).not.toContain("failed");
		expect(states).not.toContain("crashed");
		expect(runtime.getDiagnostics().restartCount).toBe(0);
		expect(runner.handles).toHaveLength(1);
	} finally {
		await supervisor.shutdown();
	}
});

test("PluginRuntime continues persisted recovery counts across ordinary starts", async () => {
	const runner = new RuntimeRunner();
	const runtime = new PluginRuntime({
		pluginId: "com.example.runtime",
		pluginVersion: "1.0.0",
		command: [process.execPath, "unused"],
		cwd: process.cwd(),
		runner,
		restartCount: 3,
		generation: 8,
	});
	try {
		await runtime.start();
		expect(runtime.getDiagnostics()).toMatchObject({ generation: 9, restartCount: 3 });
		await runtime.restart();
		expect(runtime.getDiagnostics()).toMatchObject({ generation: 10, restartCount: 4 });
		await runtime.shutdown();
		await runtime.start();
		expect(runtime.getDiagnostics()).toMatchObject({ generation: 11, restartCount: 4 });
	} finally {
		await runtime.shutdown();
	}
});

test("LocalProcessRunner preserves a real exit as a failure while stdout stays open", async () => {
	const exited = Promise.withResolvers<number>();
	const timeout = Promise.withResolvers<Error>();
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	let streamsClosed = false;
	let idleReclaims = 0;
	const closeStreams = () => {
		if (streamsClosed) return;
		streamsClosed = true;
		stdout.close();
	};
	const runner = new LocalProcessRunner({
		allowUnboundedResourceUsage: true,
		killProcessTree: false,
		spawn: () => ({
			stdin: {},
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					stdout = controller;
				},
			}),
			stderr: new ReadableStream<Uint8Array>({
				start: (controller) => controller.close(),
			}),
			exited: exited.promise,
			kill: closeStreams,
		}),
	});
	const handle = await runner.start({
		command: ["fixture"],
		cwd: process.cwd(),
		idleTimeoutMs: 20,
		onIdleTimeout: () => {
			idleReclaims += 1;
		},
		onError: (error) => timeout.resolve(error),
	});
	try {
		exited.resolve(1);
		await expect(timeout.promise).resolves.toMatchObject({ code: "IDLE_TIMEOUT" });
		expect(idleReclaims).toBe(0);
		// Latest main acknowledges the complete stdio drain, not root PID exit alone.
		closeStreams();
		expect(await handle.exited).toBe(1);
	} finally {
		closeStreams();
		await handle.terminate?.("test cleanup");
	}
});
