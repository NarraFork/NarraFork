import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import type { JsonRpcEnvelope } from "../../../server/lib/plugins/protocol";
import {
	buildLocalProcessCommand,
	type ContentLengthFrameError,
	ContentLengthFrameParser,
	encodeContentLengthFrame,
	LocalProcessRunner,
	type PluginProcessHandle,
	type PluginProcessSpawner,
	type PluginRunner,
	PluginRuntime,
	type RunnerProcess,
	RuntimeSupervisor,
	type RuntimeSupervisorOptions,
} from "../../../server/services/plugin-runtime";

const encoder = new TextEncoder();
const fixturePath = join(import.meta.dir, "../../fixtures/plugins/runtime/fixture.ts");
const fixtureCwd = join(import.meta.dir, "../../fixtures/plugins/runtime");
const bunPath = process.execPath;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await sleep(5);
	if (!predicate()) throw new Error("condition did not become true before timeout");
}

function makeFrame(
	body: string,
	headers = "Content-Type: application/json; charset=utf-8",
): Uint8Array {
	const bytes = encoder.encode(body);
	return encoder.encode(`Content-Length: ${bytes.byteLength}\r\n${headers}\r\n\r\n${body}`);
}

function makeRawProcess(onWrite?: (message: JsonRpcEnvelope) => void): {
	process: RunnerProcess;
	pushStdout: (bytes: Uint8Array) => void;
	pushStderr: (bytes: Uint8Array) => void;
	finish: (exitCode?: number) => void;
	wasKilled: () => boolean;
	writes: JsonRpcEnvelope[];
} {
	let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let resolveExited!: (exitCode: number) => void;
	let killed = false;
	const writes: JsonRpcEnvelope[] = [];
	const process: RunnerProcess = {
		pid: 12_345,
		stdin: {
			write(data: Uint8Array) {
				const parser = new ContentLengthFrameParser();
				const messages = parser.feed(data);
				writes.push(...messages);
				for (const message of messages) onWrite?.(message);
				return data.byteLength;
			},
			flush() {},
			end() {},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				stdoutController = controller;
			},
		}),
		stderr: new ReadableStream<Uint8Array>({
			start(controller) {
				stderrController = controller;
			},
		}),
		exited: new Promise<number>((resolve) => {
			resolveExited = resolve;
		}),
		kill() {
			killed = true;
			resolveExited(137);
			stdoutController?.close();
			stderrController?.close();
		},
	};
	return {
		process,
		pushStdout: (bytes) => stdoutController?.enqueue(bytes),
		pushStderr: (bytes) => stderrController?.enqueue(bytes),
		finish: (exitCode = 0) => {
			resolveExited(exitCode);
			stdoutController?.close();
			stderrController?.close();
		},
		wasKilled: () => killed,
		writes,
	};
}

type LifecycleMethod = "initialize" | "activate" | "health";

class FakeProcessHandle implements PluginProcessHandle {
	readonly writes: JsonRpcEnvelope[] = [];
	readonly cancelled: string[] = [];
	private readonly messageHandlers = new Set<(message: JsonRpcEnvelope) => void>();
	private readonly errorHandlers = new Set<(error: Error) => void>();
	private readonly exitHandlers = new Set<(exitCode: number) => void>();
	private resolveExited!: (exitCode: number) => void;
	private exitCode: number | undefined;
	private killed = false;
	readonly exited: Promise<number>;

	constructor(
		private readonly mode: "response" | "notification" = "response",
		private readonly errorMethod?: LifecycleMethod,
	) {
		this.exited = new Promise((resolve) => {
			this.resolveExited = resolve;
		});
	}

	send(message: JsonRpcEnvelope): Promise<void> {
		this.writes.push(message);
		if (!("method" in message)) return Promise.resolve();
		if (message.method === "$/cancelRequest") {
			const params = message.params as { requestId?: string } | undefined;
			if (params?.requestId) this.cancelled.push(params.requestId);
			return Promise.resolve();
		}
		if (!("id" in message)) return Promise.resolve();
		if (message.method === this.errorMethod) {
			this.emit({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32001, message: `${message.method} rejected` },
			});
			return Promise.resolve();
		}
		if (message.method === "initialize")
			return this.respond(message.id, "initialized", { initialized: true });
		if (message.method === "activate")
			return this.respond(message.id, "activated", { activated: true });
		if (message.method === "health") return this.respond(message.id, "healthy", { healthy: true });
		if (message.method === "deactivate")
			return this.respond(message.id, "deactivated", { deactivated: true });
		if (message.method === "shutdown") {
			return this.respond(message.id, "shutdown", { shutdown: true });
		}
		if (message.method === "slow") return Promise.resolve();
		return this.respond(message.id, undefined, { value: "new-generation" });
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
		if (this.exitCode !== undefined) {
			handler(this.exitCode);
			return () => undefined;
		}
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	getStderr(): string {
		return "fake stderr";
	}

	kill(): void {
		this.killed = true;
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

	queueExit(exitCode: number): () => void {
		// A transport may already have dispatched exit before error cleanup
		// unsubscribes its observers; deliver that queued event deterministically.
		const handlers = [...this.exitHandlers];
		return () => {
			if (this.exitCode !== undefined) return;
			this.exitCode = exitCode;
			this.resolveExited(exitCode);
			for (const handler of handlers) handler(exitCode);
		};
	}

	finish(exitCode: number): void {
		this.queueExit(exitCode)();
	}

	isKilled(): boolean {
		return this.killed;
	}

	private respond(
		id: string | number,
		notificationMethod: string | undefined,
		result: unknown,
	): Promise<void> {
		if (this.mode === "notification" && notificationMethod) {
			this.emit({ jsonrpc: "2.0", method: notificationMethod, params: result as never });
		} else {
			this.emit({ jsonrpc: "2.0", id, result: result as never });
		}
		return Promise.resolve();
	}
}

class FakeRunner implements PluginRunner {
	readonly handles: FakeProcessHandle[] = [];

	constructor(
		private readonly mode: "response" | "notification" = "response",
		private readonly errorMethod?: LifecycleMethod,
	) {}

	async start(): Promise<PluginProcessHandle> {
		const handle = new FakeProcessHandle(this.mode, this.errorMethod);
		this.handles.push(handle);
		setTimeout(() => {
			handle.emit({
				jsonrpc: "2.0",
				method: "hello",
				params: {
					pluginId: "com.example.runtime",
					version: "1.0.0",
					rpcProtocol: "narrafork.rpc/1",
				},
			});
		}, 0);
		return handle;
	}
}

const baseRuntimeOptions = {
	pluginId: "com.example.runtime",
	pluginVersion: "1.0.0",
	command: [bunPath, fixturePath],
	cwd: fixtureCwd,
};

afterEach(() => {
	// Let process-exit microtasks and stream readers settle between tests.
	return sleep(5);
});

describe("ContentLengthFrameParser", () => {
	it("parses arbitrary拆包 and measures Content-Length in UTF-8 bytes", () => {
		const parser = new ContentLengthFrameParser();
		const envelope = { jsonrpc: "2.0" as const, method: "hello", params: { text: "你好 🌍" } };
		const frame = encodeContentLengthFrame(envelope);
		const parsed: JsonRpcEnvelope[] = [];
		for (const byte of frame) parsed.push(...parser.feed(Uint8Array.of(byte)));
		expect(parsed).toEqual([envelope]);
		parser.end();
	});

	it("parses multiple frames from one chunk", () => {
		const parser = new ContentLengthFrameParser();
		const first = encodeContentLengthFrame({ jsonrpc: "2.0", method: "one" });
		const second = encodeContentLengthFrame({ jsonrpc: "2.0", id: "2", result: { ok: true } });
		const combined = new Uint8Array(first.length + second.length);
		combined.set(first);
		combined.set(second, first.length);
		expect(parser.feed(combined)).toEqual([
			{ jsonrpc: "2.0", method: "one" },
			{ jsonrpc: "2.0", id: "2", result: { ok: true } },
		]);
	});

	it("rejects missing header, invalid length, invalid UTF-8, invalid JSON and batch", () => {
		const cases: Array<{ input: Uint8Array; code: ContentLengthFrameError["code"] }> = [
			{ input: encoder.encode('{"jsonrpc":"2.0"}'), code: "missing_content_length" },
			{ input: encoder.encode("Content-Length: -1\r\n\r\n"), code: "invalid_content_length" },
			{ input: encoder.encode("Content-Length: 1\r\n\r\n\xff"), code: "invalid_utf8" },
			{ input: makeFrame("not json"), code: "invalid_json" },
			{ input: makeFrame("[]"), code: "batch_not_allowed" },
		];
		for (const testCase of cases) {
			expect(() => new ContentLengthFrameParser().feed(testCase.input)).toThrowError(
				expect.objectContaining({ code: testCase.code }) as unknown as Error,
			);
		}
	});

	it("enforces header and body limits", () => {
		expect(() =>
			new ContentLengthFrameParser({ maxHeaderBytes: 4 }).feed(encoder.encode("abcde")),
		).toThrow("header");
		const body = JSON.stringify({ jsonrpc: "2.0", method: "long" });
		expect(() => new ContentLengthFrameParser({ maxBodyBytes: 4 }).feed(makeFrame(body))).toThrow(
			"body",
		);
	});
});

describe("LocalProcessRunner", () => {
	it("encodes once and limits UTF-8 body bytes without counting headers", async () => {
		const message: JsonRpcEnvelope = { jsonrpc: "2.0", method: "bytes", params: "中文" };
		const bodyBytes = encoder.encode(JSON.stringify(message)).byteLength;
		const raw = makeRawProcess();
		const runner = new LocalProcessRunner({
			spawn: () => raw.process,
			maxOutboundBodyBytes: bodyBytes,
			allowUnboundedResourceUsage: true,
		});
		const handle = await runner.start({ command: ["fixture"], cwd: fixtureCwd });
		try {
			const stringify = spyOn(JSON, "stringify");
			try {
				await handle.send(message);
				expect(stringify).toHaveBeenCalledTimes(1);
			} finally {
				stringify.mockRestore();
			}
			expect(raw.writes).toEqual([message]);
			await expect(handle.send({ ...message, params: "中文a" })).rejects.toMatchObject({
				code: "OUTBOUND_FRAME_LIMIT",
			});
			const invalid = { jsonrpc: "2.0", method: "bytes", params: Number.NaN } as JsonRpcEnvelope;
			expect(() => encodeContentLengthFrame(invalid)).toThrow("invalid JSON-RPC");
			expect(() => handle.send(invalid)).toThrow("invalid JSON-RPC");
			expect(raw.writes).toHaveLength(1);
		} finally {
			handle.kill();
			await handle.exited;
		}
	});

	it("uses argument arrays, controlled cwd and an environment allowlist", async () => {
		let captured:
			| {
					command: string[];
					options: { cwd: string; env: Record<string, string>; detached?: boolean };
			  }
			| undefined;
		const raw = makeRawProcess();
		const spawn: PluginProcessSpawner = (command, options) => {
			captured = { command, options };
			return raw.process;
		};
		const runner = new LocalProcessRunner({
			spawn,
			allowedCwds: [fixtureCwd],
			envAllowlist: ["PATH", "LANG"],
		});
		const handle = await runner.start({
			command: ["bun", fixturePath, "normal"],
			cwd: fixtureCwd,
			env: { PATH: "/safe", LANG: "zh_CN.UTF-8", HOME: "/secret", JWT_SECRET: "jwt" },
		});
		expect(captured?.command).toEqual(buildLocalProcessCommand(["bun", fixturePath, "normal"]));
		expect(captured?.options.cwd).toBe(fixtureCwd);
		expect(captured?.options.env).toEqual({ PATH: "/safe", LANG: "zh_CN.UTF-8" });
		expect(captured?.options.detached).toBe(process.platform !== "win32");
		handle.kill();
		await handle.exited;
	});

	it("delivers buffered stdout frames before notifying process exit", async () => {
		const raw = makeRawProcess();
		const events: string[] = [];
		const runner = new LocalProcessRunner({
			spawn: () => raw.process,
			allowUnboundedResourceUsage: true,
		});
		const handle = await runner.start({ command: ["fixture"], cwd: fixtureCwd });
		handle.onMessage((message) => {
			if ("id" in message) events.push(`message:${String(message.id)}`);
		});
		handle.onExit((exitCode) => events.push(`exit:${exitCode}`));

		raw.pushStdout(
			encodeContentLengthFrame({
				jsonrpc: "2.0",
				id: "tail",
				result: { ok: true },
			}),
		);
		raw.finish(0);

		await handle.exited;
		await eventually(() => events.length === 2);
		expect(events).toEqual(["message:tail", "exit:0"]);
	});

	it("keeps stderr in a bounded ring and kills on stdout output limit", async () => {
		const raw = makeRawProcess();
		const errors: Error[] = [];
		const runner = new LocalProcessRunner({
			spawn: () => raw.process,
			stderrRingBytes: 8,
			maxStdoutBytes: 16,
		});
		const handle = await runner.start({
			command: ["fixture"],
			cwd: fixtureCwd,
			onError: (error) => errors.push(error),
		});
		raw.pushStderr(encoder.encode("123456789"));
		await eventually(() => handle.getStderr() === "23456789");
		raw.pushStdout(new Uint8Array(17));
		await eventually(() => raw.wasKilled());
		expect(errors.some((error) => error.message.includes("output limit"))).toBe(true);
	});

	it("applies hard POSIX CPU-time and virtual-memory limits before exec", () => {
		const command = buildLocalProcessCommand(
			["bun", fixturePath],
			{ cpuTimeSeconds: 7, memoryBytes: 12_345 },
			"linux",
		);
		expect(command[0]).toBe("/bin/sh");
		expect(command[1]).toBe("-c");
		expect(command[3]).toBe("narrafork-resource-limit");
		expect(command[4]).toBe("7");
		expect(command[5]).toBe("13");
		expect(command.slice(6)).toEqual(["bun", fixturePath]);
	});

	it("fails closed on Windows unless an external sandbox is explicitly declared", async () => {
		const raw = makeRawProcess();
		const blocked = new LocalProcessRunner({ platform: "win32", spawn: () => raw.process });
		await expect(blocked.start({ command: ["plugin.exe"], cwd: fixtureCwd })).rejects.toMatchObject(
			{ code: "RESOURCE_LIMITS_UNAVAILABLE" },
		);
		expect(raw.wasKilled()).toBe(false);

		let capturedCommand: string[] | undefined;
		let capturedDetached: boolean | undefined;
		const allowed = new LocalProcessRunner({
			platform: "win32",
			allowUnboundedResourceUsage: true,
			spawn: (command, options) => {
				capturedCommand = command;
				capturedDetached = options.detached;
				return raw.process;
			},
		});
		const handle = await allowed.start({ command: ["plugin.exe"], cwd: fixtureCwd });
		expect(capturedCommand).toEqual(["plugin.exe"]);
		expect(capturedDetached).toBe(false);
		handle.kill();
		await handle.exited;
	});
});

describe("PluginRuntime", () => {
	it("performs hello/initialize/activate/health and grants no capabilities by default", async () => {
		const runner = new FakeRunner();
		const runtime = new PluginRuntime({ ...baseRuntimeOptions, runner });
		await runtime.start();
		expect(runtime.state).toBe("active");
		expect(runtime.runtimeId.startsWith("rt_")).toBe(true);
		expect(runtime.generation).toBe(1);
		expect(runtime.getDiagnostics().capabilities).toEqual([]);
		await runtime.shutdown();
		expect(runtime.state).toBe("stopped");
	});

	it("supports notification-based control handshake", async () => {
		const runtime = new PluginRuntime({
			...baseRuntimeOptions,
			runner: new FakeRunner("notification"),
		});
		await runtime.start();
		expect(runtime.state).toBe("active");
		expect(runtime.getDiagnostics().inFlight).toBe(0);
		await runtime.shutdown();
	});

	it("fails closed on lifecycle JSON-RPC error responses", async () => {
		for (const method of ["initialize", "activate", "health"] as const) {
			const runner = new FakeRunner("response", method);
			const runtime = new PluginRuntime({ ...baseRuntimeOptions, runner });
			await expect(runtime.start()).rejects.toMatchObject({
				code: "-32001",
				phase: method,
			});
			expect(runtime.state).toBe("failed");
			expect(runner.handles[0]?.isKilled()).toBe(true);
		}
	});

	it("rejects handshake identity mismatch and fails closed", async () => {
		const runner = new FakeRunner();
		const runtime = new PluginRuntime({ ...baseRuntimeOptions, runner });
		runner.start = async () => {
			const handle = new FakeProcessHandle();
			setTimeout(
				() =>
					handle.emit({
						jsonrpc: "2.0",
						method: "hello",
						params: {
							pluginId: "com.example.attacker",
							version: "1.0.0",
							rpcProtocol: "narrafork.rpc/1",
						},
					}),
				0,
			);
			return handle;
		};
		await expect(runtime.start()).rejects.toThrow("identity mismatch");
		expect(runtime.state).toBe("failed");
	});

	it("cancels in-flight requests and ignores a late old-generation response", async () => {
		const runner = new FakeRunner();
		const runtime = new PluginRuntime({
			...baseRuntimeOptions,
			runner,
			timeouts: { rpcMs: 500, drainMs: 20, cancelGraceMs: 5, shutdownMs: 20 },
		});
		await runtime.start();
		const abort = new AbortController();
		const slowRequest = runtime.request("slow", undefined, { signal: abort.signal });
		await sleep(5);
		abort.abort();
		await expect(slowRequest).rejects.toMatchObject({ name: "AbortError" });
		expect(runner.handles[0].cancelled.length).toBe(1);

		const oldHandle = runner.handles[0];
		oldHandle.finish(1);
		await runtime.restart();
		oldHandle.emit({ jsonrpc: "2.0", id: "late", result: { value: "old" } });
		await expect(runtime.request("echo")).resolves.toEqual({ value: "new-generation" });
		expect(runtime.generation).toBe(2);
		await runtime.shutdown();
	});

	it("drains and shuts down active requests", async () => {
		const runner = new FakeRunner();
		const runtime = new PluginRuntime({
			...baseRuntimeOptions,
			runner,
			timeouts: { rpcMs: 500, drainMs: 10, cancelGraceMs: 2, shutdownMs: 20 },
		});
		await runtime.start();
		const pending = runtime.request("slow");
		await runtime.shutdown();
		await expect(pending).rejects.toThrow("shut down");
		expect(runtime.state).toBe("stopped");
	});
});

describe("RuntimeSupervisor", () => {
	function recoveryHarness(options: RuntimeSupervisorOptions = {}) {
		// Capture only supervisor delays, leaving handshake/RPC timers real. Explicit
		// firing also models a callback already dequeued before clearTimeout ran.
		const baseDelay = 54_321;
		const timers = spyOn(globalThis, "setTimeout");
		const scheduled = () =>
			timers.mock.calls.flatMap(([callback, delay], index) => {
				const result = timers.mock.results[index];
				return result.type === "return" && (delay === baseDelay || delay === baseDelay * 2)
					? [{ callback, delay, timer: result.value }]
					: [];
			});
		const runner = new FakeRunner();
		const supervisor = new RuntimeSupervisor({
			restartBaseDelayMs: baseDelay,
			restartMaxDelayMs: baseDelay * 2,
			restartJitterRatio: 0,
			...options,
		});
		return {
			runner,
			supervisor,
			scheduled,
			fire(index: number) {
				const timer = scheduled()[index];
				expect(timer).toBeDefined();
				clearTimeout(timer.timer);
				timer.callback();
			},
			async cleanup() {
				for (const { timer } of scheduled()) clearTimeout(timer);
				timers.mockRestore();
				await supervisor.shutdown();
			},
		};
	}

	it("recovery counts error plus exit only once against the restart budget", async () => {
		const h = recoveryHarness({ maxRestarts: 1, maxTotalRestarts: 10 });
		try {
			const runtime = await h.supervisor.start({ ...baseRuntimeOptions, runner: h.runner });
			const exit = h.runner.handles[0].queueExit(1);
			h.runner.handles[0].emitError(new Error("transport failed"));
			expect(runtime.state).toBe("failed");
			exit();
			expect(runtime.state).toBe("crashed");
			expect(h.scheduled()).toHaveLength(1);
			h.fire(0);
			await eventually(() => runtime.state === "active");
			expect(runtime.generation).toBe(2);
			h.runner.handles[1].finish(1);
			expect(runtime.state).toBe("quarantine");
			expect(h.scheduled()).toHaveLength(1);
		} finally {
			await h.cleanup();
		}
	});

	it("recovery retries new generations with exponential backoff and the total budget", async () => {
		const h = recoveryHarness({ maxRestarts: 10, maxTotalRestarts: 2 });
		try {
			const runtime = await h.supervisor.start({ ...baseRuntimeOptions, runner: h.runner });
			for (let generation = 1; generation <= 2; generation++) {
				const handle = h.runner.handles[generation - 1];
				const exit = handle.queueExit(1);
				handle.emitError(new Error("transport failed"));
				exit();
				expect(h.scheduled()).toHaveLength(generation);
				h.fire(generation - 1);
				await eventually(() => runtime.state === "active");
				expect(runtime.generation).toBe(generation + 1);
			}
			expect(h.scheduled().map(({ delay }) => delay)).toEqual([54_321, 108_642]);
			h.runner.handles[2].finish(1);
			expect(runtime.state).toBe("quarantine");
			expect(h.scheduled()).toHaveLength(2);
		} finally {
			await h.cleanup();
		}
	});

	it("recovery rechecks the generation after waiting behind manual start's mutex", async () => {
		const h = recoveryHarness();
		try {
			const runtime = await h.supervisor.start({ ...baseRuntimeOptions, runner: h.runner });
			const restart = spyOn(runtime, "restart");
			h.runner.handles[0].finish(1);
			const manualStart = h.supervisor.start(runtime.pluginId);
			h.fire(0);
			await manualStart;
			// This no-op start is a FIFO barrier after the timer callback.
			await h.supervisor.start(runtime.pluginId);
			expect(restart).not.toHaveBeenCalled();
			expect(runtime.state).toBe("active");
			expect(runtime.generation).toBe(2);
			expect(h.runner.handles).toHaveLength(2);
		} finally {
			await h.cleanup();
		}
	});

	it("recovery leaves a newer generation's pending timer intact when an old callback runs", async () => {
		const h = recoveryHarness();
		try {
			const runtime = await h.supervisor.start({ ...baseRuntimeOptions, runner: h.runner });
			h.runner.handles[0].finish(1);
			// Direct recovery does not cancel the supervisor's first timer.
			await runtime.restart();
			const restart = spyOn(runtime, "restart");
			h.runner.handles[1].finish(1);
			expect(h.scheduled()).toHaveLength(2);
			h.fire(0);
			// The free mutex enters its callback on the next microtask.
			await Promise.resolve();
			expect(restart).not.toHaveBeenCalled();
			expect(runtime.state).toBe("crashed");
			h.fire(1);
			await eventually(() => runtime.state === "active");
			expect(restart).toHaveBeenCalledTimes(1);
			expect(runtime.generation).toBe(3);
		} finally {
			await h.cleanup();
		}
	});

	it("recovery ignores a replaced runtime even when the new identity has the same generation", async () => {
		const h = recoveryHarness();
		try {
			const old = await h.supervisor.start({ ...baseRuntimeOptions, runner: h.runner });
			const restart = spyOn(old, "restart");
			h.runner.handles[0].finish(1);
			const replacement = await h.supervisor.start({
				...baseRuntimeOptions,
				command: [...baseRuntimeOptions.command, "replacement"],
				runner: h.runner,
			});
			expect(replacement.runtimeId).not.toBe(old.runtimeId);
			expect(replacement.generation).toBe(old.generation);
			h.fire(0);
			await h.supervisor.start(replacement.pluginId);
			expect(restart).not.toHaveBeenCalled();
			expect(old.state).toBe("stopped");
			expect(replacement.state).toBe("active");
			expect(h.runner.handles).toHaveLength(2);
		} finally {
			await h.cleanup();
		}
	});

	it("recovery does not revive a stopped same-generation runtime", async () => {
		const h = recoveryHarness();
		try {
			const runtime = await h.supervisor.start({ ...baseRuntimeOptions, runner: h.runner });
			const restart = spyOn(runtime, "restart");
			h.runner.handles[0].finish(1);
			await runtime.shutdown();
			h.fire(0);
			// disable is queued after the callback and leaves the runtime stopped.
			await h.supervisor.disable(runtime.pluginId);
			expect(restart).not.toHaveBeenCalled();
			expect(runtime.generation).toBe(1);
			expect(h.runner.handles).toHaveLength(1);
		} finally {
			await h.cleanup();
		}
	});

	it.each([
		"supervisor",
		"runtime",
	] as const)("recovery does not revive a runtime quarantined by %s through an already dequeued timer", async (source) => {
		const h = recoveryHarness();
		try {
			const runtime = await h.supervisor.start({ ...baseRuntimeOptions, runner: h.runner });
			const restart = spyOn(runtime, "restart");
			h.runner.handles[0].finish(1);
			if (source === "supervisor") {
				h.supervisor.quarantine(runtime.pluginId, "operator quarantine");
			} else {
				runtime.quarantine("runtime quarantine");
			}
			h.fire(0);
			await expect(h.supervisor.start(runtime.pluginId)).rejects.toMatchObject({
				code: "QUARANTINED",
			});
			expect(restart).not.toHaveBeenCalled();
			expect(runtime.state).toBe("quarantine");
			expect(runtime.generation).toBe(1);
		} finally {
			await h.cleanup();
		}
	});

	it("quarantines after the restart budget is exhausted", async () => {
		const supervisor = new RuntimeSupervisor({
			maxRestarts: 1,
			maxTotalRestarts: 1,
			restartBaseDelayMs: 1,
			restartMaxDelayMs: 1,
			restartJitterRatio: 0,
		});
		const runtime = supervisor.register({
			...baseRuntimeOptions,
			command: [bunPath, fixturePath, "crash"],
		});
		await supervisor.start("com.example.runtime");
		await eventually(() => runtime.state === "quarantine", 1_500);
		expect(supervisor.getDiagnostics("com.example.runtime")[0]?.state).toBe("quarantine");
	});

	it("handles slow and malformed real-process fixtures", async () => {
		const slow = new PluginRuntime({
			...baseRuntimeOptions,
			command: [bunPath, fixturePath, "slow"],
			timeouts: { handshakeMs: 20, activationMs: 20, rpcMs: 20 },
		});
		await expect(slow.start()).rejects.toThrow(/hello|timeout/i);
		await slow.shutdown();

		const malformedSupervisor = new RuntimeSupervisor({ restartJitterRatio: 0 });
		const malformed = malformedSupervisor.register({
			...baseRuntimeOptions,
			command: [bunPath, fixturePath, "malformed"],
			timeouts: { handshakeMs: 500, activationMs: 50, rpcMs: 50 },
		});
		await expect(malformedSupervisor.start("com.example.runtime")).rejects.toThrow();
		await eventually(() => malformed.state === "quarantine", 1_000);
	});
});
