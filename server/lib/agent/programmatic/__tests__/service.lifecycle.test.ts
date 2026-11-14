import { describe, expect, test } from "bun:test";
import { WorkerHandle } from "../../../worker-runtime/lifecycle";
import type { IsolationDriver, SandboxPolicy } from "../sandbox";
import {
	closeProgrammaticServices,
	createProgrammaticService,
	type ExecutionOptions,
} from "../service";
import { NdjsonFrames, WireBudget } from "../wire";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const policy: SandboxPolicy = {
	kind: "podman",
	uid: 1000,
	memoryBytes: 128 * 1024 * 1024,
	maxPids: 32,
	cpuCores: 1,
	cpuSeconds: 2,
};
function input(runId: string): ExecutionOptions {
	return {
		source: "globalThis.__fixtureMustNotExecute = true; return 42",
		signal: new AbortController().signal,
		wallMs: 4000,
		identity: { runId, actorUserId: "user", narratorId: "narrator", outerToolCallId: "outer" },
		receivers: [],
		authorize: async () => true,
		audit: async () => {},
	};
}

// Real native child processes exercise lifetime accounting, not Podman policy. The
// driver is intentionally injected; container qualification stays in integration.test.ts.
describe("programmatic process ownership and permanent production gate", () => {
	test("global close owns active and pending launch across HMR, without constructing idle sandboxes", async () => {
		const handles: WorkerHandle<Bun.Subprocess<"ignore", "pipe", "ignore">>[] = [];
		const reads: Promise<void>[] = [];
		const gate = deferred<void>();
		const entered = deferred<void>();
		const cleanup = deferred<void>();
		const activeEntered = deferred<void>();
		let sends = 0;
		let launches = 0;
		function driver(late: boolean): IsolationDriver {
			return {
				policy,
				checkAvailable: async () => {},
				async launch() {
					launches++;
					if (late) {
						entered.resolve();
						await gate.promise;
					}
					const handle = WorkerHandle.subprocess(
						[process.execPath, "--eval", "setInterval(()=>{},1000)"],
						{ stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 },
					);
					handles.push(handle);
					if (!late) activeEntered.resolve();
					const frames = new NdjsonFrames(new WireBudget(), () => {
						void handle.close();
					});
					reads.push(
						(async () => {
							for await (const chunk of handle.resource.stdout) frames.push(chunk);
							frames.finish();
						})(),
					);
					let termination: Promise<{ confirmed: true; exitCode: number }> | undefined;
					return {
						policy,
						frames,
						exited: handle.exited,
						verifyIsolation: async () => {},
						send: async () => {
							sends++;
						},
						stderr: () => "",
						terminate() {
							termination ??= (async () => {
								await handle.close();
								await cleanup.promise;
								return { confirmed: true as const, exitCode: await handle.exited };
							})();
							return termination;
						},
					};
				},
			};
		}
		const active = createProgrammaticService({ driver: driver(false) });
		const late = createProgrammaticService({ driver: driver(true) });
		const idle = createProgrammaticService({ driver: driver(false) });
		const running = [active.execute(input("active")), late.execute(input("late"))];
		await Promise.all([entered.promise, activeEntered.promise]);
		let closed = false;
		const closing = closeProgrammaticServices().then(() => {
			closed = true;
		});
		try {
			expect(launches).toBe(2);
			await expect(idle.execute(input("unused"))).rejects.toMatchObject({ code: "CLOSED" });
			const alias = "../service.ts?programmatic-closed-alias";
			const reloaded = await import(alias);
			expect(() => reloaded.createProgrammaticService({ driver: driver(false) })).toThrow("closed");
			await handles[0].exited;
			expect(closed).toBe(false);
			expect(active.activeRuns()).toBe(1);
			expect(late.activeRuns()).toBe(1);
			gate.resolve();
			while (handles.length < 2) await Bun.sleep(0);
			await handles[1].exited;
			expect(closed).toBe(false);
			expect(sends).toBe(0);
			expect(
				(globalThis as unknown as Record<string, unknown>).__fixtureMustNotExecute,
			).toBeUndefined();
			cleanup.resolve();
			await closing;
			for (const result of await Promise.all(running)) {
				expect(result.ok).toBe(false);
				expect(result.error?.code).toBe("CLOSED");
				expect(result.resourcesReleased).toBe(true);
			}
			expect(active.activeRuns()).toBe(0);
			expect(late.activeRuns()).toBe(0);
			expect(launches).toBe(2);
		} finally {
			gate.resolve();
			cleanup.resolve();
			await Promise.all(handles.map((handle) => handle.close()));
			await Promise.allSettled([...running, ...reads, closing]);
		}
	});
});
