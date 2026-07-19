import { afterEach, describe, expect, it } from "bun:test";
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

	finish(exitCode: number): void {
		if (this.exitCode !== undefined) return;
		this.exitCode = exitCode;
		this.resolveExited(exitCode);
		for (const handler of this.exitHandlers) handler(exitCode);
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
