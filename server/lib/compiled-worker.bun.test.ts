import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compiledBuildArguments } from "../../scripts/lib/compiled-build";
import { connectCompiledBunWorker } from "./compiled-worker";
import { WorkerCleanupError, WorkerHandle } from "./worker-runtime/lifecycle";

const exec = promisify(execFile);
const readySource = `self.onmessage = event => {
 if (event.data?.action === "ping") self.postMessage({ ready: true });
 else self.postMessage({ echoed: event.data });
};
self.postMessage({ ready: true });`;
let dir: string;
let handles: WorkerHandle<globalThis.Worker>[];
let starts: ReturnType<typeof spyOn<typeof WorkerHandle, "bunThread">>;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "nf-bun-connect-"));
	handles = [];
	const create = WorkerHandle.bunThread;
	starts = spyOn(WorkerHandle, "bunThread").mockImplementation((...args) => {
		const handle = create(...args);
		handles.push(handle);
		return handle;
	});
});
afterEach(async () => {
	await Promise.allSettled(handles.map((handle) => handle.close()));
	starts.mockRestore();
	await rm(dir, { recursive: true, force: true });
});
async function fixture(name: string, source = readySource): Promise<string> {
	const path = join(dir, `${name}.ts`);
	await writeFile(path, source);
	return pathToFileURL(path).href;
}

describe("native Bun worker connections", () => {
	test("preserves file href/self messages and does not consume the first business input", async () => {
		const entry = await fixture("ready");
		const node = spyOn(WorkerHandle, "thread");
		try {
			const connected = await connectCompiledBunWorker([entry], { sendPing: false });
			expect(connected.worker).toBeInstanceOf(globalThis.Worker);
			expect(starts.mock.calls[0]?.[0]).toBe(entry);
			expect(node).not.toHaveBeenCalled();
			const reply = once(connected.worker, "message", { signal: AbortSignal.timeout(2_000) });
			connected.worker.postMessage({ task: "first-input" });
			expect(((await reply)[0] as MessageEvent).data).toEqual({ echoed: { task: "first-input" } });
			await connected.handle.close();
			expect(typeof (await connected.handle.exited)).toBe("number");
		} finally {
			node.mockRestore();
		}
	});

	test("uses the shared successful-entry cache without retaining startup resources", async () => {
		const missing = pathToFileURL(join(dir, "missing.ts")).href;
		const entry = await fixture("winner");
		const first = await connectCompiledBunWorker([missing, entry], { sendPing: false });
		expect(first.specifier).toBe(entry);
		await first.handle.close();
		starts.mockClear();
		const next = await connectCompiledBunWorker([missing, entry], { sendPing: false });
		expect(next.specifier).toBe(entry);
		expect(starts).toHaveBeenCalledTimes(1);
		expect(starts.mock.calls[0]?.[0]).toBe(entry);
		await next.handle.close();
		expect(handles.every((handle) => handle.closed)).toBe(true);
	});

	test("all candidates share an absolute budget and timeout waits for the real close event", async () => {
		const never = await fixture("never", "self.onmessage = () => {};");
		const next = await fixture("must-not-start");
		const rejected = await connectCompiledBunWorker([never, next], {
			sendPing: false,
			deadlineAt: Date.now() + 50,
		}).catch((error: unknown) => error);
		expect(rejected).toBeInstanceOf(Error);
		expect(starts).toHaveBeenCalledTimes(1);
		expect(typeof (await handles[0]?.exited)).toBe("number");
	});

	test("startup cancellation never dispatches or probes another entry", async () => {
		const never = await fixture("cancel", "self.onmessage = () => {};");
		const controller = new AbortController();
		const reason = new Error("cancel native startup");
		const pending = connectCompiledBunWorker([never, await fixture("unused")], {
			signal: controller.signal,
			sendPing: false,
		});
		controller.abort(reason);
		expect(await pending.catch((error: unknown) => error)).toBe(reason);
		expect(starts).toHaveBeenCalledTimes(1);
		expect(typeof (await handles[0]?.exited)).toBe("number");
	});

	test("custom readiness/build identity failures remain failures and stop the native worker", async () => {
		const entry = await fixture(
			"wrong-build",
			'self.onmessage = () => {}; self.postMessage({ buildId: "old" });',
		);
		const failure = new Error("wrong worker build identity");
		const result = await connectCompiledBunWorker([entry], {
			sendPing: false,
			isReady: (message) => {
				if (
					!message ||
					typeof message !== "object" ||
					!("buildId" in message) ||
					message.buildId !== "current"
				)
					throw failure;
				return true;
			},
		}).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).cause).toBe(failure);
		expect(typeof (await handles[0]?.exited)).toBe("number");
	});

	test("failed startup cleanup exposes its actual Bun handle and never probes a replacement", async () => {
		const never = await fixture("cleanup", "self.onmessage = () => {};");
		const pending = connectCompiledBunWorker([never, await fixture("unused")], {
			sendPing: false,
			timeoutMs: 40,
			deadlineAt: Date.now() + 5_000,
		});
		const handle = handles[0];
		if (!handle) throw new Error("native creation must reserve before awaiting startup");
		const failure = new Error("Bun close was not confirmed");
		const stop = spyOn(handle, "close").mockRejectedValue(failure);
		try {
			const error = await pending.catch((value: unknown) => value);
			expect(error).toBeInstanceOf(WorkerCleanupError);
			if (!(error instanceof WorkerCleanupError))
				throw new Error("missing native cleanup ownership");
			expect(error.handle).toBe(handle);
			expect(error.cause).toBe(failure);
			expect(starts).toHaveBeenCalledTimes(1);
		} finally {
			stop.mockRestore();
			await handle.close();
		}
	});
});

test("a native self/onmessage worker runs from a minified binary outside the source cwd", async () => {
	const project = join(import.meta.dir, "../..");
	const server = join(project, "server");
	const sourceDir = await mkdtemp(join(import.meta.dir, ".bun-compiled-probe-"));
	const artifacts = await mkdtemp(join(dir, "compiled-"));
	try {
		const worker = join(sourceDir, "worker.ts");
		await writeFile(worker, readySource);
		const entry = relative(server, worker).replaceAll("\\", "/");
		const main = join(sourceDir, "main.ts");
		await writeFile(
			main,
			`
import { once } from "node:events";
import { connectCompiledBunWorker, compiledWorkerSpecifiers, type CompiledWorkerEntry } from ${JSON.stringify(join(import.meta.dir, "compiled-worker.ts"))};
import { isCompiledRuntime } from ${JSON.stringify(join(import.meta.dir, "runtime-target.ts"))};
const specifiers = compiledWorkerSpecifiers(${JSON.stringify(entry)} as CompiledWorkerEntry, "./worker.ts", import.meta.url);
const connected = await connectCompiledBunWorker(specifiers, { sendPing: false });
let data;
try {
 const reply = once(connected.worker, "message", { signal: AbortSignal.timeout(2000) });
 connected.worker.postMessage("native-business");
 data = (await reply)[0].data;
} finally { await connected.handle.close(); }
console.log(JSON.stringify({ compiled: isCompiledRuntime(), data, closed: connected.handle.closed, exited: await connected.handle.exited, specifier: connected.specifier }));
`,
		);
		const binary = join(artifacts, `native-worker${process.platform === "win32" ? ".exe" : ""}`);
		const cwd = join(artifacts, "empty");
		const home = join(artifacts, "home");
		await mkdir(cwd);
		await mkdir(home);
		const env = { ...process.env, HOME: home, USERPROFILE: home, NARRAFORK_HOME: home };
		const source = await exec(process.execPath, [main], {
			cwd,
			env,
			timeout: 10_000,
			maxBuffer: 32 * 1024,
		});
		expect(JSON.parse(source.stdout.trim())).toMatchObject({
			compiled: false,
			data: { echoed: "native-business" },
			closed: true,
		});
		await exec(
			process.execPath,
			["build", main, worker, "--root", server, ...compiledBuildArguments(), "--outfile", binary],
			{
				cwd: project,
				env,
				timeout: 60_000,
				maxBuffer: 256 * 1024,
			},
		);
		await rm(sourceDir, { recursive: true, force: true });
		const compiled = await exec(binary, [], { cwd, env, timeout: 10_000, maxBuffer: 32 * 1024 });
		const result = JSON.parse(compiled.stdout.trim());
		expect(result).toMatchObject({
			compiled: true,
			data: { echoed: "native-business" },
			closed: true,
		});
		expect(typeof result.exited).toBe("number");
		expect(result.specifier).toMatch(/\$bunfs|~BUN|%7EBUN/i);
		expect((await stat(binary)).size).toBeGreaterThan(0);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
	}
}, 90_000);
