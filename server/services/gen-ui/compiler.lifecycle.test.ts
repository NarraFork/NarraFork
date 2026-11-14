import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WorkerHandle } from "@server/lib/worker-runtime/lifecycle";
import { GEN_UI_FILE_LIMITS } from "@shared/gen-ui-files";
import { closeGenUiCompilerWorkers, compilePreview } from "./compiler";

const files = [{ path: "App.tsx", bytes: new TextEncoder().encode("export default ()=>null") }];
const native = WorkerHandle.bunThread;
const handles: WorkerHandle<Worker>[] = [];
const urls: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
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
		if (Date.now() >= end) throw new Error("Compiler synchronization timed out");
		await Bun.sleep(0);
	}
}
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	await Promise.all(handles.splice(0).map((handle) => handle.close()));
	for (const url of urls.splice(0)) URL.revokeObjectURL(url);
});

describe("one-shot compiler ownership", () => {
	test("constructor failure does not compile on the host and releases only the uncreated slot", async () => {
		const build = spyOn(Bun, "build");
		const create = spyOn(WorkerHandle, "bunThread").mockImplementation(() => {
			throw new Error("fixture create failure");
		});
		try {
			await expect(compilePreview(files, new AbortController().signal)).rejects.toThrow(
				"fixture create failure",
			);
			expect(create).toHaveBeenCalledTimes(1);
			expect(build).not.toHaveBeenCalled();
		} finally {
			create.mockRestore();
			build.mockRestore();
		}
		const result = await compilePreview(files, new AbortController().signal);
		expect(result.js).toContain("__nfGenUiApp");
	});
	for (const [phase, source] of [
		["startup", 'throw new Error("fixture startup failure")'],
		["execution", 'self.onmessage=()=>{throw new Error("fixture execution failure")}'],
	] as const)
		test(`${phase} failure waits for its real Worker exit, with no host build`, async () => {
			const build = spyOn(Bun, "build");
			spies.push(build);
			fault(source);
			await expect(compilePreview(files, new AbortController().signal)).rejects.toThrow("fixture");
			expect(handles).toHaveLength(1);
			expect(typeof (await handles[0].exited)).toBe("number");
			expect(build).not.toHaveBeenCalled();
		});
	test("a never-responsive Worker is stopped by the unchanged compilation watchdog", async () => {
		fault("self.onmessage=()=>{}");
		const schedule = globalThis.setTimeout;
		let watchdog = false;
		spies.push(
			spyOn(globalThis, "setTimeout").mockImplementation(((
				callback: (...args: unknown[]) => void,
				delay: number,
				...args: unknown[]
			) => {
				if (delay === GEN_UI_FILE_LIMITS.timeoutMs) {
					watchdog = true;
					return schedule(callback, 1, ...args);
				}
				return schedule(callback, delay, ...args);
			}) as typeof setTimeout),
		);
		await expect(compilePreview(files, new AbortController().signal)).rejects.toThrow("15 seconds");
		expect(watchdog).toBe(true);
		expect(typeof (await handles[0].exited)).toBe("number");
	});
	test("capacity is not released between a reply and confirmed native cleanup", async () => {
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		fault('self.onmessage=()=>postMessage({js:"compiled",css:""})', barrier);
		const first = compilePreview(files, new AbortController().signal);
		const second = compilePreview(files, new AbortController().signal);
		try {
			await eventually(() => handles.length === 2);
			await Promise.all(handles.map((handle) => handle.exited));
			await expect(compilePreview(files, new AbortController().signal)).rejects.toThrow("busy");
		} finally {
			release();
		}
		expect((await first).js).toBe("compiled");
		expect((await second).js).toBe("compiled");
	});
	test("throwing scalar diagnostic sink cannot replace a successful result or bypass exit", async () => {
		fault('self.onmessage=()=>postMessage({js:"compiled",css:""})');
		const { logger } = await import("@server/lib/logger");
		const warn = spyOn(logger, "warn").mockImplementation(() => {
			throw new Error("fixture sink failure");
		});
		spies.push(warn);
		let now = Date.now();
		spies.push(
			spyOn(Date, "now").mockImplementation(() => {
				now += 1001;
				return now;
			}),
		);
		const result = await compilePreview(files, new AbortController().signal);
		expect(result.js).toBe("compiled");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(Object.keys(warn.mock.calls[0][1] as object).sort()).toEqual(["elapsedMs", "files"]);
		expect(typeof (await handles[0].exited)).toBe("number");
	});
	test("production close aborts active work, waits for exit and permanently disables HMR aliases", async () => {
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const create = fault("self.onmessage=()=>{}", barrier);
		const running = compilePreview(files, new AbortController().signal);
		void running.catch(() => {});
		await eventually(() => handles.length === 1);
		let closed = false;
		const closing = closeGenUiCompilerWorkers().then(() => {
			closed = true;
		});
		try {
			await handles[0].exited;
			expect(closed).toBe(false);
			await expect(compilePreview(files, new AbortController().signal)).rejects.toThrow("closed");
			const alias = "./compiler.ts?compiler-closed-alias";
			const reloaded = await import(alias);
			await expect(reloaded.compilePreview(files, new AbortController().signal)).rejects.toThrow(
				"closed",
			);
			expect(create).toHaveBeenCalledTimes(1);
		} finally {
			release();
		}
		await closing;
		await expect(running).rejects.toThrow("closed");
		expect(closed).toBe(true);
	});
});
