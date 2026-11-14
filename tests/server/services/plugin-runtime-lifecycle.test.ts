import { describe, expect, spyOn, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../../../server/lib/logger";
import { WorkerCleanupError } from "../../../server/lib/worker-runtime/lifecycle";
import {
	LocalProcessRunner,
	type RunnerProcess,
	RuntimeSupervisor,
} from "../../../server/services/plugin-runtime";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const cwd = join(import.meta.dir, "../../fixtures/plugins/runtime");
const command = [process.execPath, join(cwd, "fixture.ts"), "normal"];

function pendingProcess() {
	const exit = Promise.withResolvers<number>();
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	let stderr!: ReadableStreamDefaultController<Uint8Array>;
	let kills = 0;
	let finished = false;
	const process: RunnerProcess = {
		stdin: { write: (data: Uint8Array) => data.byteLength, flush() {}, end() {} },
		stdout: new ReadableStream({
			start(controller) {
				stdout = controller;
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				stderr = controller;
			},
		}),
		exited: exit.promise,
		kill() {
			kills++;
		},
	};
	return {
		process,
		kills: () => kills,
		pushStdout(bytes: Uint8Array) {
			stdout.enqueue(bytes);
		},
		pushStderr(bytes: Uint8Array) {
			stderr.enqueue(bytes);
		},
		finish() {
			if (finished) return;
			finished = true;
			stdout.close();
			stderr.close();
			exit.resolve(0);
		},
	};
}

function runnerFor(process: RunnerProcess) {
	return new LocalProcessRunner({ spawn: () => process, allowUnboundedResourceUsage: true });
}

async function reevaluateOwnerModule(url: URL) {
	const file = Bun.file(url);
	if (file.size > 512 * 1024) throw new Error("Owner module fixture exceeded its input budget");
	const source = await file.text();
	const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
	let code = transpiler.transformSync(source);
	for (const entry of transpiler.scanImports(source)) {
		if (!entry.path.startsWith(".") && !entry.path.startsWith("@server/")) continue;
		const resolved = Bun.resolveSync(entry.path, dirname(fileURLToPath(url)));
		code = code.replaceAll(
			JSON.stringify(entry.path),
			JSON.stringify(pathToFileURL(resolved).href),
		);
	}
	// Unlike query-string imports (which Bun aliases to its cache), this evaluates the actual
	// owner module again while sharing original dependencies/globalThis, just as HMR must.
	code += "\nexport const __reevaluatedOwnerForTest = true;\n";
	return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

describe("plugin process ownership", () => {
	test("health logger failures cannot skip creation/exit or erase bounded plugin stderr", async () => {
		const canary = "plugin-console-/private/root-user-log-body";
		const records: unknown[] = [];
		const log = spyOn(logger, "warn").mockImplementation((message, data) => {
			records.push({ message, data });
			throw new Error(canary);
		});
		const raw = pendingProcess();
		const runner = runnerFor(raw.process);
		try {
			const handle = await runner.start({ command, cwd });
			raw.pushStderr(new TextEncoder().encode(canary));
			await turn();
			expect(handle.getStderr()).toContain(canary);
			const terminating = handle.terminate?.(canary);
			await turn();
			expect(raw.kills()).toBe(1);
			raw.finish();
			await terminating;
			await runner.close();
			expect(records).toHaveLength(1);
			expect(JSON.stringify(records)).not.toContain(canary);
			expect(records[0]).toEqual({
				message: "Plugin runtime health",
				data: { code: "resource_limits_disabled" },
			});
		} finally {
			raw.finish();
			await runner.close().catch(() => {});
			log.mockRestore();
		}
	});
	test("HMR retains actual platform and manager owners, not a fresh empty supervisor", async () => {
		const platform = await import("../../../server/services/plugin-platform-services");
		const manager = await import("../../../server/services/plugin-manager");
		const reloadedPlatform = await reevaluateOwnerModule(
			new URL("../../../server/services/plugin-platform-services.ts", import.meta.url),
		);
		const reloadedManager = await reevaluateOwnerModule(
			new URL("../../../server/services/plugin-manager.ts", import.meta.url),
		);
		expect(reloadedPlatform.__reevaluatedOwnerForTest).toBe(true);
		expect(reloadedManager.__reevaluatedOwnerForTest).toBe(true);
		expect(reloadedPlatform.pluginPlatformServices).toBe(platform.pluginPlatformServices);
		expect(reloadedPlatform.pluginPlatformServices.runtimeSupervisor).toBe(
			platform.pluginPlatformServices.runtimeSupervisor,
		);
		expect(reloadedPlatform.pluginPlatformServices.scheduler).toBe(
			platform.pluginPlatformServices.scheduler,
		);
		expect(reloadedManager.pluginManager).toBe(manager.pluginManager);
	});
	test("termination request keeps the launch slot until actual exit", async () => {
		const raw = pendingProcess();
		const runner = runnerFor(raw.process);
		const handle = await runner.start({ command, cwd });
		const terminating = handle.terminate?.("test exit barrier");
		let exited = false;
		void terminating?.then(() => {
			exited = true;
		});
		await turn();
		expect(raw.kills()).toBe(1);
		expect(exited).toBe(false);
		await expect(runner.start({ command, cwd })).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		raw.finish();
		await terminating;
		expect(exited).toBe(true);
		await runner.close();
		await expect(runner.start({ command, cwd })).rejects.toThrow("closed");
	});

	test("spawn timeout retains unresolved create and close waits for its late resource", async () => {
		const raw = pendingProcess();
		const create = Promise.withResolvers<RunnerProcess>();
		let timeout: (() => void) | undefined;
		const original = globalThis.setTimeout;
		const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			delay?: number,
		) => {
			if (delay === 15_000) timeout = callback;
			return original(callback, delay);
		}) as typeof setTimeout);
		const runner = new LocalProcessRunner({
			spawn: () => create.promise,
			allowUnboundedResourceUsage: true,
		});
		const starting = runner.start({ command, cwd });
		void starting.catch(() => {});
		try {
			await turn();
			expect(timeout).toBeFunction();
			timeout?.(); // Fire the production deadline, not a smaller business timeout.
			await turn();
			await expect(runner.start({ command, cwd })).rejects.toMatchObject({
				code: "TASK_QUEUE_FULL",
			});
			let closed = false;
			const closing = runner.close().then(() => {
				closed = true;
			});
			create.resolve(raw.process);
			await turn();
			expect(raw.kills()).toBe(1);
			expect(closed).toBe(false);
			raw.finish();
			await expect(starting).rejects.toMatchObject({ code: "SPAWN_TIMEOUT" });
			await closing;
			expect(closed).toBe(true);
		} finally {
			timerSpy.mockRestore();
		}
	});

	test("parent exit is not an ACK for descendants and failed cleanup remains owned", async () => {
		const raw = pendingProcess();
		const tree = Promise.withResolvers<void>();
		raw.process.terminate = () => tree.promise;
		const runner = runnerFor(raw.process);
		const handle = await runner.start({ command, cwd });
		let exited = false;
		void handle.exited.then(
			() => {
				exited = true;
			},
			() => {},
		);
		raw.finish();
		await turn();
		expect(exited).toBe(false);
		await expect(runner.start({ command, cwd })).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		tree.reject(new Error("tree exit not confirmed"));
		await expect(handle.terminate?.()).rejects.toBeInstanceOf(WorkerCleanupError);
		await expect(runner.close()).rejects.toBeInstanceOf(AggregateError);
		await expect(runner.start({ command, cwd })).rejects.toThrow("closed");
	});

	test("stdin backpressure has a bounded queue and termination unblocks pending writes", async () => {
		const raw = pendingProcess();
		raw.process.stdin = { write: () => new Promise<number>(() => {}), end() {} };
		const runner = runnerFor(raw.process);
		const handle = await runner.start({ command, cwd });
		const writes = Array.from({ length: 66 }, (_, index) =>
			handle.send({ jsonrpc: "2.0", id: index, method: "work" }),
		);
		for (const write of writes) void write.catch(() => {});
		await expect(writes[65]).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		const terminating = handle.terminate?.();
		await turn();
		raw.finish();
		await terminating;
		expect((await Promise.allSettled(writes)).every((result) => result.status === "rejected")).toBe(
			true,
		);
		await runner.close();
	});

	test("throwing error/exit observers cannot skip stop or turn exit into failure", async () => {
		const raw = pendingProcess();
		let errors = 0;
		const runner = new LocalProcessRunner({
			spawn: () => raw.process,
			maxStdoutBytes: 1,
			allowUnboundedResourceUsage: true,
		});
		const handle = await runner.start({
			command,
			cwd,
			onError() {
				errors++;
				throw new Error("observer failed");
			},
			onExit() {
				throw new Error("exit observer failed");
			},
		});
		handle.onError(() => {
			throw new Error("error observer failed");
		});
		handle.onExit(() => {
			throw new Error("exit listener failed");
		});
		raw.pushStdout(new Uint8Array([1, 2]));
		await turn();
		expect(errors).toBe(1);
		expect(raw.kills()).toBe(1);
		raw.finish();
		await expect(handle.exited).resolves.toBe(0);
		await runner.close();
	});

	test("creation failure never executes a local protocol fallback", async () => {
		let creates = 0;
		const runner = new LocalProcessRunner({
			spawn: () => {
				creates++;
				throw new Error("spawn denied");
			},
		});
		await expect(runner.start({ command, cwd })).rejects.toThrow("spawn denied");
		expect(creates).toBe(1);
		await runner.close();
	});

	test("real descendant process tree is gone before terminate returns", async () => {
		const script = `
const child = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {stdin:'ignore',stdout:'ignore',stderr:'ignore'});
process.on('SIGTERM', () => { void child.exited.then(() => process.exit(0)); });
const body = JSON.stringify({jsonrpc:'2.0',method:'fixture',params:{pid:child.pid}});
process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);
setInterval(()=>{},1000);
`;
		const runner = new LocalProcessRunner({ allowUnboundedResourceUsage: true });
		const handle = await runner.start({ command: [process.execPath, "-e", script], cwd });
		const ready = Promise.withResolvers<number>();
		handle.onMessage((message) => {
			if ("method" in message && message.method === "fixture")
				ready.resolve((message.params as { pid: number }).pid);
		});
		let child: number | undefined;
		try {
			child = await ready.promise;
			expect(() => process.kill(child as number, 0)).not.toThrow();
			await handle.terminate?.("test process-tree cleanup");
			expect(() => process.kill(child as number, 0)).toThrow();
			expect(() => process.kill(handle.pid as number, 0)).toThrow();
			await runner.close();
		} finally {
			await handle.terminate?.();
			if (child) {
				try {
					process.kill(child, "SIGKILL");
				} catch {}
			}
		}
	});

	test("real subprocess activation, RPC, drain and permanent supervisor close", async () => {
		const supervisor = new RuntimeSupervisor();
		const runtime = await supervisor.start({
			pluginId: "com.example.runtime",
			version: "1.0.0",
			command,
			cwd,
			runnerOptions: { allowUnboundedResourceUsage: true },
		});
		const pid = runtime.pid;
		expect(pid).toBeGreaterThan(0);
		expect(runtime.state).toBe("active");
		supervisor.stopProducers();
		await expect(supervisor.start("com.example.runtime")).rejects.toThrow("closed");
		expect(runtime.state).toBe("active");
		await expect(runtime.request("echo", { text: "ok" })).resolves.toEqual({ ok: true });
		await supervisor.shutdown();
		expect(runtime.state).toBe("stopped");
		expect(() => globalThis.process.kill(pid as number, 0)).toThrow();
		await expect(supervisor.start("com.example.runtime")).rejects.toThrow("closed");
	});
});
