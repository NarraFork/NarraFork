import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Worker as NodeWorker } from "node:worker_threads";
import { compiledBuildArguments } from "../../scripts/lib/compiled-build";
import {
	compiledWorkerSpecifiers,
	connectCompiledWorker,
	workerEntryFromSpecifier,
} from "./compiled-worker";
import { WorkerCleanupError, WorkerHandle } from "./worker-runtime/lifecycle";

const source = "file:///project/server/services/git-line-stats.ts";
const binary = "file:///$bunfs/root/narrafork";
const windows = "file:///C:/%7EBUN/root/narrafork.exe";

test("source runs resolve the worker next to the caller", () => {
	expect(
		compiledWorkerSpecifiers(
			"services/git-untracked-line-worker.ts",
			"./git-untracked-line-worker.ts",
			source,
			false,
		),
	).toEqual(["file:///project/server/services/git-untracked-line-worker.ts"]);
});

test("compiled runs probe server-root, repo-root, and basename layouts", () => {
	expect(
		compiledWorkerSpecifiers(
			"services/git-untracked-line-worker.ts",
			"./git-untracked-line-worker.ts",
			binary,
			true,
		),
	).toEqual([
		"file:///$bunfs/root/services/git-untracked-line-worker.js",
		"file:///$bunfs/root/server/services/git-untracked-line-worker.js",
		"file:///$bunfs/root/git-untracked-line-worker.js",
	]);
	expect(
		compiledWorkerSpecifiers("lib/db-worker/worker-entry.ts", "./worker-entry.ts", binary, true),
	).toEqual([
		"file:///$bunfs/root/lib/db-worker/worker-entry.js",
		"file:///$bunfs/root/server/lib/db-worker/worker-entry.js",
		"file:///$bunfs/root/worker-entry.js",
	]);
});

test("Worker accepts URL objects on POSIX and forward-slash virtual keys on Windows", () => {
	const posix = workerEntryFromSpecifier(
		"file:///$bunfs/root/services/git-untracked-line-worker.js",
	);
	expect(posix).toBeInstanceOf(URL);
	expect(String(posix)).toBe("file:///$bunfs/root/services/git-untracked-line-worker.js");
	expect(
		compiledWorkerSpecifiers(
			"services/git-untracked-line-worker.ts",
			"./git-untracked-line-worker.ts",
			windows,
			true,
		).map((specifier) => workerEntryFromSpecifier(specifier)),
	).toEqual([
		"C:/~BUN/root/services/git-untracked-line-worker.js",
		"C:/~BUN/root/server/services/git-untracked-line-worker.js",
		"C:/~BUN/root/git-untracked-line-worker.js",
	]);
	expect(workerEntryFromSpecifier("file:///B:/~BUN/root/lib/worker.js")).toBe(
		"B:/~BUN/root/lib/worker.js",
	);
	for (const real of ["file:///C:/workspace%20name/worker.ts", "file:///workspace/worker.ts"]) {
		const entry = workerEntryFromSpecifier(real);
		expect(entry).toBeInstanceOf(URL);
		expect(String(entry)).toBe(real);
	}
	expect(workerEntryFromSpecifier("/tmp/worker.js")).toBe("/tmp/worker.js");
	expect(workerEntryFromSpecifier("./worker.ts")).toBe("./worker.ts");
});

describe("compiled worker connection ownership", () => {
	let dir: string;
	let handles: WorkerHandle<NodeWorker>[];
	let spawns: ReturnType<typeof spyOn<typeof WorkerHandle, "thread">>;
	const readySource = `parentPort.on("message", (message) => {
		if (message.action === "ping") parentPort.postMessage({ ready: true });
		else parentPort.postMessage(message);
	});`;

	async function fixture(name: string, body = readySource): Promise<string> {
		const path = join(dir, `${name}.ts`);
		await writeFile(path, `import { parentPort, workerData } from "node:worker_threads";\n${body}`);
		return pathToFileURL(path).href;
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "nf-compiled-worker-"));
		handles = [];
		const create = WorkerHandle.thread;
		spawns = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
			const handle = create(entry, options);
			handles.push(handle);
			return handle;
		});
	});

	afterEach(async () => {
		await Promise.allSettled(handles.map((handle) => handle.close()));
		spawns.mockRestore();
		await rm(dir, { recursive: true, force: true });
	});

	test("every candidate, including the final one, has a readiness timeout", async () => {
		const slow = await fixture("slow", `await Bun.sleep(300); ${readySource}`);
		await expect(
			connectCompiledWorker([slow, pathToFileURL(join(dir, "missing.ts")).href], {
				timeoutMs: 50,
			}),
		).rejects.toThrow("worker did not become ready");
		await expect(connectCompiledWorker([slow], { timeoutMs: 50 })).rejects.toThrow(
			"worker did not become ready",
		);
		const started = await connectCompiledWorker([slow], { timeoutMs: 2_000 });
		expect(started.specifier).toBe(slow);
		expect(started.handle.resource).toBe(started.worker);
		await started.handle.close();
	});

	test("self-announcing one-shot workers reserve their first input for the business request", async () => {
		const entry = await fixture(
			"self-ready-one-shot",
			`parentPort.once("message", message => {
	 parentPort.postMessage({ firstInput: message });
	 parentPort.close();
	});
	parentPort.postMessage({ ready: true });`,
		);
		const connected = await connectCompiledWorker([entry], { sendPing: false });
		const reply = once(connected.worker, "message", { signal: AbortSignal.timeout(1_000) });
		connected.worker.postMessage("actual-business-path");
		expect((await reply)[0]).toEqual({ firstInput: "actual-business-path" });
		await connected.handle.exited;
		expect(handles).toHaveLength(1);
		expect(connected.handle.closed).toBe(true);
	});

	test("disabled startup pings still enforce readiness timeout and confirmed exit", async () => {
		const marker = join(dir, "unexpected-probe");
		const entry = await fixture(
			"silent-one-shot",
			`import { writeFileSync } from "node:fs";
	parentPort.once("message", () => writeFileSync(${JSON.stringify(marker)}, "received"));`,
		);
		await expect(
			connectCompiledWorker([entry], { sendPing: false, timeoutMs: 40 }),
		).rejects.toThrow("worker did not become ready");
		expect(await Bun.file(marker).exists()).toBe(false);
		expect(handles).toHaveLength(1);
		expect(typeof (await handles[0]?.exited)).toBe("number");
	});
	test("a never-ready worker is gone before startup rejects", async () => {
		const never = await fixture("never", `parentPort.on("message", () => {});`);
		await expect(connectCompiledWorker([never], { timeoutMs: 40 })).rejects.toThrow(
			"worker did not become ready",
		);
		expect(handles).toHaveLength(1);
		expect(handles[0]?.closed).toBe(true);
		expect(typeof (await handles[0]?.exited)).toBe("number");
	});

	test("one absolute startup deadline covers all attempts", async () => {
		const never = await fixture("never", `parentPort.on("message", () => {});`);
		await expect(
			connectCompiledWorker([never, await fixture("must-not-start")], {
				timeoutMs: 5_000,
				deadlineAt: Date.now() + 40,
			}),
		).rejects.toThrow("worker startup deadline exceeded");
		expect(spawns).toHaveBeenCalledTimes(1);
		await handles[0]?.exited;
	});

	test("expired or invalid startup budgets do not construct a worker", async () => {
		const entry = await fixture("ready");
		await expect(connectCompiledWorker([entry], { deadlineAt: Date.now() - 1 })).rejects.toThrow(
			"deadline",
		);
		for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])
			await expect(connectCompiledWorker([entry], { timeoutMs })).rejects.toThrow(RangeError);
		await expect(connectCompiledWorker([entry], { deadlineAt: Number.NaN })).rejects.toThrow(
			RangeError,
		);
		expect(spawns).not.toHaveBeenCalled();
	});

	test("an already-aborted caller never starts a thread", async () => {
		const reason = new Error("cancelled before startup");
		await expect(
			connectCompiledWorker([await fixture("ready")], { signal: AbortSignal.abort(reason) }),
		).rejects.toBe(reason);
		expect(spawns).not.toHaveBeenCalled();
	});

	test("cancellation during startup does not probe another candidate", async () => {
		const never = await fixture("never", `parentPort.on("message", () => {});`);
		const other = await fixture("other");
		const signal = AbortSignal.timeout(40);
		const error = await connectCompiledWorker([never, other], { signal }).catch(
			(error: unknown) => error,
		);
		expect(signal.aborted).toBe(true);
		expect(error).toBe(signal.reason);
		expect(spawns).toHaveBeenCalledTimes(1);
		await handles[0]?.exited;
	});

	test("early exit is observed before the next layout is tried", async () => {
		const exited = await fixture("early-exit", "process.exit(0);");
		const ready = await fixture("ready");
		const started = await connectCompiledWorker([exited, ready]);
		expect(started.specifier).toBe(ready);
		expect(handles).toHaveLength(2);
		expect(await handles[0]?.exited).toBe(0);
		expect(handles[0]?.closed).toBe(true);
		await started.handle.close();
	});

	test("bad readiness predicates reject and stop their thread instead of throwing on main", async () => {
		await expect(
			connectCompiledWorker([await fixture("ready")], {
				isReady: () => {
					throw new Error("invalid ready protocol");
				},
			}),
		).rejects.toThrow("invalid ready protocol");
		expect(handles[0]?.closed).toBe(true);
		await handles[0]?.exited;
	});

	test("a failed cleanup stops probing instead of replacing an unconfirmed worker", async () => {
		const never = await fixture("never", `parentPort.on("message", () => {});`);
		const other = await fixture("other");
		const pending = connectCompiledWorker([never, other], {
			timeoutMs: 40,
			deadlineAt: Date.now() + 5_000,
		});
		const handle = handles[0];
		if (!handle) throw new Error("startup must construct its first worker synchronously");
		const failure = new Error("worker exit was not confirmed");
		const stop = spyOn(handle, "close").mockRejectedValue(failure);
		try {
			const rejected = await pending.catch((error: unknown) => error);
			expect(rejected).toBeInstanceOf(WorkerCleanupError);
			if (!(rejected instanceof WorkerCleanupError)) throw new Error("Missing cleanup resource");
			expect(rejected.handle).toBe(handle);
			expect(rejected.cause).toBe(failure);
			expect(Object.keys(rejected)).not.toContain("handle");
			expect(spawns).toHaveBeenCalledTimes(1);
		} finally {
			stop.mockRestore();
			await handle.close();
		}
	});

	test("successful entry resolution is reused without repeating failed probes", async () => {
		const missing = pathToFileURL(join(dir, "missing.ts")).href;
		const ready = await fixture("ready");
		const first = await connectCompiledWorker([missing, ready]);
		expect(spawns).toHaveBeenCalledTimes(2);
		await first.handle.close();
		spawns.mockClear();
		const second = await connectCompiledWorker([missing, ready]);
		expect(second.specifier).toBe(ready);
		expect(spawns).toHaveBeenCalledTimes(1);
		expect(String(spawns.mock.calls[0]?.[0])).toBe(ready);
		await second.handle.close();
	});

	test("a stale cached entry can probe the remaining layout again", async () => {
		const alternative = pathToFileURL(join(dir, "alternative.ts")).href;
		const cached = await fixture("cached");
		const first = await connectCompiledWorker([alternative, cached]);
		await first.handle.close();
		await rm(join(dir, "cached.ts"));
		await fixture("alternative");
		spawns.mockClear();
		const second = await connectCompiledWorker([alternative, cached]);
		expect(String(spawns.mock.calls[0]?.[0])).toBe(cached);
		expect(second.specifier).toBe(alternative);
		expect(spawns).toHaveBeenCalledTimes(2);
		await second.handle.close();
	});

	test("worker options and custom ready protocols are preserved", async () => {
		const entry = await fixture(
			"worker-data",
			`parentPort.on("message", () => parentPort.postMessage({ kind: "ready", value: workerData.value }));`,
		);
		let value: unknown;
		const started = await connectCompiledWorker([entry], {
			workerOptions: { workerData: { value: 23 } },
			isReady: (message) => {
				if (!message || typeof message !== "object" || !("kind" in message)) return false;
				if ("value" in message) value = message.value;
				return message.kind === "ready";
			},
		});
		expect(value).toBe(23);
		await started.handle.close();
	});

	test("the startup caller's abort listener is removed after ready", async () => {
		const controller = new AbortController();
		const started = await connectCompiledWorker([await fixture("ready")], {
			signal: controller.signal,
		});
		controller.abort();
		expect(started.handle.closed).toBe(false);
		const reply = once(started.worker, "message");
		started.worker.postMessage({ value: 7 });
		expect(await reply).toEqual([{ value: 7 }]);
		await started.handle.close();
	});
});

const exec = promisify(execFile);
const project = join(import.meta.dir, "../..");
const probeSource = `
import { once } from "node:events";
import { compiledWorkerSpecifiers, connectCompiledWorker } from ${JSON.stringify(join(import.meta.dir, "compiled-worker.ts"))};
import { WorkerHandle } from ${JSON.stringify(join(import.meta.dir, "worker-runtime/lifecycle.ts"))};
import { isCompiledRuntime } from ${JSON.stringify(join(import.meta.dir, "runtime-target.ts"))};
const specifiers = compiledWorkerSpecifiers(
  "services/git-untracked-line-worker.ts",
  ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../services/git-untracked-line-worker.ts")).href)},
  import.meta.url,
);
const handles = [];
const confirmedExits = new Set();
const posts = [];
const attempts = [];
const create = WorkerHandle.thread;
WorkerHandle.thread = (entry, options) => {
  if (handles.some((handle) => !confirmedExits.has(handle))) throw new Error("overlapping startup candidates");
  attempts.push(String(entry));
  const handle = create(entry, options);
  handles.push(handle);
  void handle.exited.then(() => confirmedExits.add(handle));
  const post = handle.resource.postMessage.bind(handle.resource);
  handle.resource.postMessage = (message) => {
    posts.push({ entry: String(entry), action: message.action });
    return post(message);
  };
  return handle;
};
const began = Date.now();
let result;
try {
  const started = await connectCompiledWorker(specifiers, { timeoutMs: 1500 });
  const reply = once(started.worker, "message", { signal: AbortSignal.timeout(2000) });
  started.worker.postMessage({ action: "read", cwd: process.cwd(), paths: [] });
  const [message] = await reply;
  await started.handle.close();
  const attemptsBeforeCache = attempts.length;
  const cached = await connectCompiledWorker(specifiers, { timeoutMs: 1500 });
  await cached.handle.close();
  result = { ok: true, specifier: started.specifier, message, attemptsBeforeCache };
} catch (error) {
  result = { ok: false, error: String(error) };
} finally {
  await Promise.all(handles.map((handle) => handle.close()));
}
console.log(JSON.stringify({
  ...result, compiled: isCompiledRuntime(), specifiers, attempts, posts,
  closed: handles.every((handle) => handle.closed), created: handles.length,
  exits: await Promise.all(handles.map((handle) => handle.exited)),
  elapsedMs: Date.now() - began, cwd: process.cwd(), home: process.env.HOME,
  nfHome: process.env.NARRAFORK_HOME,
}));
`;

interface CompiledProbeResult {
	ok: boolean;
	compiled: boolean;
	specifier?: string;
	error?: string;
	message?: unknown;
	attemptsBeforeCache?: number;
	specifiers: string[];
	attempts: string[];
	posts: { entry: string; action: string }[];
	closed: boolean;
	created: number;
	exits: number[];
	elapsedMs: number;
	cwd: string;
	home: string;
	nfHome: string;
}

test.each([
	"local runtime API",
	"release CLI",
] as const)("%s embeds a runnable worker and bounds missing-entry failure outside the source cwd", async (recipe) => {
	// Keep both compile entrypoints under server/, just like the real application.
	const sourceDir = await mkdtemp(join(import.meta.dir, ".compiled-worker-probe-"));
	let artifacts: string | undefined;
	try {
		artifacts = await mkdtemp(join(tmpdir(), "nf-worker-layout-"));
		const cwd = join(artifacts, "empty-cwd");
		const home = join(artifacts, "home");
		await mkdir(cwd);
		await mkdir(home);
		const env = { ...process.env, HOME: home, USERPROFILE: home, NARRAFORK_HOME: home };
		const probe = join(sourceDir, "probe.ts");
		await writeFile(probe, probeSource);
		const driver = join(sourceDir, "compile.ts");
		await writeFile(
			driver,
			`import { compileRuntimeBundle } from ${JSON.stringify(join(project, "scripts/lib/runtime-compiler.ts"))};
await compileRuntimeBundle({ ...JSON.parse(process.argv[2]), modules: new Map() });`,
		);
		const binaries: string[] = [];
		for (const present of [true, false]) {
			const binary = join(
				artifacts,
				`probe-${present}${process.platform === "win32" ? ".exe" : ""}`,
			);
			binaries.push(binary);
			const entrypoints = [
				probe,
				...(present ? [join(project, "server/services/git-untracked-line-worker.ts")] : []),
			];
			const args =
				recipe === "local runtime API"
					? [
							driver,
							JSON.stringify({
								root: project,
								entrypoints,
								outfile: binary,
								buildId: "compiled-worker-layout-test",
								repository: "test/compiled-worker",
							}),
						]
					: ["build", ...entrypoints, ...compiledBuildArguments(), "--outfile", binary];
			await exec(process.execPath, args, {
				cwd: project,
				env,
				timeout: 60_000,
				maxBuffer: 256 * 1024,
			});
		}
		// Source mode must still use its one real file URL, independently of process.cwd().
		const sourceRun = await exec(process.execPath, [probe], {
			cwd,
			env,
			timeout: 10_000,
			maxBuffer: 32 * 1024,
		});
		const sourceResult = JSON.parse(sourceRun.stdout.trim()) as CompiledProbeResult;
		expect(sourceResult.compiled).toBe(false);
		expect(sourceResult.ok).toBe(true);
		expect(sourceResult.specifiers).toHaveLength(1);
		expect(sourceResult.specifier).toBe(
			pathToFileURL(join(project, "server/services/git-untracked-line-worker.ts")).href,
		);
		await rm(sourceDir, { recursive: true, force: true });
		expect(await readdir(cwd)).toEqual([]);
		for (const [index, binary] of binaries.entries()) {
			const { stdout } = await exec(binary, [], {
				cwd,
				env,
				timeout: 10_000,
				maxBuffer: 32 * 1024,
			});
			const result = JSON.parse(stdout.trim()) as CompiledProbeResult;
			expect(result.compiled).toBe(true);
			expect(result.cwd).toBe(cwd);
			expect(result.home).toBe(home);
			expect(result.nfHome).toBe(home);
			expect(result.closed).toBe(true);
			expect(result.exits).toHaveLength(result.created);
			expect(result.specifiers).toHaveLength(3);
			if (index === 0) {
				expect(result.ok, JSON.stringify(result)).toBe(true);
				if (!result.specifier) throw new Error("Compiled probe returned no worker entry");
				// Both current recipes preserve the common server/ root on this real entry graph.
				expect(result.specifier).toBe(result.specifiers[0]);
				expect(result.message).toEqual({ value: { complete: true, files: [], readFiles: 0 } });
				expect(result.posts.filter((post) => post.action !== "ping")).toEqual([
					{ entry: result.specifier, action: "read" },
				]);
				expect(result.attempts.slice(result.attemptsBeforeCache)).toEqual([result.specifier]);
			} else {
				expect(result.ok).toBe(false);
				expect(result.error).toContain("No worker entry loaded");
				expect(result.elapsedMs).toBeLessThan(3_000);
				expect(result.attempts).toEqual(result.specifiers);
				expect(result.posts.every((post) => post.action === "ping")).toBe(true);
			}
		}
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		if (artifacts) await rm(artifacts, { recursive: true, force: true });
	}
}, 180_000);
