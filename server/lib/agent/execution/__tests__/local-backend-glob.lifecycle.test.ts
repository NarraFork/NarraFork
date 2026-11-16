import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WorkerHandle } from "../../../worker-runtime/lifecycle";
import { closeLocalGlobWorkers, LocalBackend } from "../local-backend";

const native = WorkerHandle.bunThread;
const handles: WorkerHandle<Worker>[] = [];
const urls: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const backend = new LocalBackend();
function fault(source: string, delayExit?: Promise<void>) {
	const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
	urls.push(url);
	const create = spyOn(WorkerHandle, "bunThread").mockImplementation((_entry, options) => {
		const real = native.call(WorkerHandle, url, options);
		handles.push(real);
		return delayExit
			? new WorkerHandle(
					real.resource,
					real.exited.then(async (code) => {
						await delayExit;
						return code;
					}),
					() => real.close(),
				)
			: real;
	});
	spies.push(create);
	return create;
}
async function eventually(predicate: () => boolean) {
	const end = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() >= end) throw new Error("Glob synchronization timed out");
		await Bun.sleep(0);
	}
}
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	await Promise.all(handles.splice(0).map((handle) => handle.close()));
	for (const url of urls.splice(0)) URL.revokeObjectURL(url);
});

describe("bounded one-shot local glob owner", () => {
	test("construction fails closed without invoking Bun.Glob.scan on the host", async () => {
		const scan = spyOn(Bun.Glob.prototype, "scan");
		const create = spyOn(WorkerHandle, "bunThread").mockImplementation(() => {
			throw new Error("fixture create failure");
		});
		try {
			await expect(backend.glob("**/*", { cwd: import.meta.dir })).rejects.toThrow(
				"fixture create failure",
			);
			expect(create).toHaveBeenCalledTimes(1);
			expect(scan).not.toHaveBeenCalled();
		} finally {
			scan.mockRestore();
			create.mockRestore();
		}
	});
	for (const source of [
		'throw new Error("fixture startup failure")',
		'self.onmessage=()=>{throw new Error("fixture execution failure")}',
	])
		test("real Worker failure never scans inline", async () => {
			fault(source);
			const scan = spyOn(Bun.Glob.prototype, "scan");
			spies.push(scan);
			await expect(backend.glob("**/*", { cwd: import.meta.dir })).rejects.toThrow("fixture");
			expect(typeof (await handles[0].exited)).toBe("number");
			expect(scan).not.toHaveBeenCalled();
		});
	test("unresponsive startup is terminated by the original per-scan timeout", async () => {
		fault("self.onmessage=()=>{}");
		const schedule = globalThis.setTimeout;
		let watchdog = false;
		spies.push(
			spyOn(globalThis, "setTimeout").mockImplementation(((
				callback: (...args: unknown[]) => void,
				delay: number,
				...args: unknown[]
			) => {
				if (delay === 2179) {
					watchdog = true;
					return schedule(callback, 1, ...args);
				}
				return schedule(callback, delay, ...args);
			}) as typeof setTimeout),
		);
		await expect(backend.glob("**/*", { cwd: import.meta.dir, timeoutMs: 2179 })).rejects.toThrow(
			"2179ms",
		);
		expect(watchdog).toBe(true);
		expect(typeof (await handles[0].exited)).toBe("number");
	});
	test("production close drains pending admission and delayed exit, then survives HMR", async () => {
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const create = fault("self.onmessage=()=>{}", barrier);
		const work = Array.from({ length: 5 }, () => backend.glob("**/*", { cwd: import.meta.dir }));
		for (const pending of work) void pending.catch(() => {});
		await eventually(() => handles.length === 4);
		await expect(
			backend.glob("**/*", { cwd: import.meta.dir, query: "x".repeat(1024 * 1024) }),
		).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		let closed = false;
		const closing = closeLocalGlobWorkers().then(() => {
			closed = true;
		});
		try {
			await Promise.all(handles.map((handle) => handle.exited));
			expect(closed).toBe(false);
			await expect(work[4]).rejects.toThrow("closed");
			await expect(backend.glob("**/*", { cwd: import.meta.dir })).rejects.toThrow("closed");
			const alias = "../local-backend.ts?glob-closed-alias";
			const reloaded = await import(alias);
			await expect(
				new reloaded.LocalBackend().glob("**/*", { cwd: import.meta.dir }),
			).rejects.toThrow("closed");
			expect(create).toHaveBeenCalledTimes(4);
		} finally {
			release();
		}
		await closing;
		for (const pending of work) await expect(pending).rejects.toThrow("closed");
		expect(closed).toBe(true);
	});
});
