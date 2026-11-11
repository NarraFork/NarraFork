import { afterEach, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../scripts/build-runtime";
import { collectBuildModules } from "../../scripts/lib/build-materials";
import { compiledBuildArguments, runtimeBuildDefines } from "../../scripts/lib/compiled-build";
import { runRuntimeBuildCommand } from "../../scripts/lib/runtime-build-process";
import { compileRuntimeBundle, runtimeAssets } from "../../scripts/lib/runtime-compiler";
import { createHelperDistributionDependencies } from "../../shared/helper-distribution";

const ROOT = resolve(import.meta.dir, "../..");
const directories: string[] = [];
function temporary() {
	const path = mkdtempSync(join(tmpdir(), "nf-runtime-build-test-"));
	directories.push(path);
	return path;
}
function put(path: string, content: string | Uint8Array) {
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, content);
}
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("release and local builds share identity defines and isolation options", () => {
	expect(runtimeBuildDefines("A", true)).toEqual({
		__NARRAFORK_RUNTIME_BUILD_ID__: '"A"',
		__NARRAFORK_LOCAL_RUNTIME__: "true",
	});
	expect(runtimeBuildDefines("A", false).__NARRAFORK_LOCAL_RUNTIME__).toBe("false");
	expect(compiledBuildArguments()).toContain("--minify");
	expect(compiledBuildArguments()).toContain("--asset-naming=[dir]/[name].[ext]");
	expect(compiledBuildArguments()).toContain("--no-compile-autoload-bunfig");
});

test("backend assets need no frontend build; full frontend refuses missing index", () => {
	const root = temporary();
	put(join(root, "frontend/public/favicon.svg"), "brand");
	put(join(root, "dist/frontend/plugin-runtime/vendor.js"), "runtime");
	put(join(root, "dist/frontend/plugin-runtime/vendor.css"), "runtime-css");
	put(join(root, "dist/frontend/unrelated.js"), "omit in dev");
	expect([...runtimeAssets(root, false).keys()]).toEqual([
		"/favicon.svg",
		"/plugin-runtime/vendor.js",
		"/plugin-runtime/vendor.css",
	]);
	expect(() => runtimeAssets(root, true)).toThrow("bun run build");
	put(join(root, "dist/frontend/index.html"), "index");
	expect(runtimeAssets(root, true).has("/unrelated.js")).toBe(true);
});

test("asset budgets reject excessive input before collecting migration data", () => {
	const root = temporary();
	const path = join(root, "oversized.asset");
	put(path, "");
	truncateSync(path, 64 * 1024 * 1024 + 1);
	const info = {
		version: "0.0.0",
		commit: "fixture",
		platform: "fixture",
		repository: "fixture/repository",
		helperDistribution: createHelperDistributionDependencies(),
	};
	expect(() => collectBuildModules(root, new Map([["/oversized.asset", path]]), info)).toThrow(
		"Build asset budget exceeded",
	);
	const entries = new Map(Array.from({ length: 20_001 }, (_, index) => [`/${index}`, path]));
	expect(() => collectBuildModules(root, entries, info)).toThrow("20000 files");
});

test("missing inputs and cancellation never start source, run migrations, or reuse old artifacts", async () => {
	const root = temporary();
	const home = join(root, "home");
	put(
		join(root, "server/index.ts"),
		`await Bun.write(${JSON.stringify(join(root, "ran-source"))}, "bad");`,
	);
	put(
		join(root, "server/db/migrate.ts"),
		`await Bun.write(${JSON.stringify(join(root, "ran-migration"))}, "bad");`,
	);
	put(join(home, "runtime/old/narrafork"), "old artifact");
	await expect(buildRuntime({ root, home, frontend: true })).rejects.toThrow("bun run build");
	await expect(buildRuntime({ root, home })).rejects.toThrow("Runtime build failed");
	await expect(buildRuntime({ root, home, signal: AbortSignal.abort() })).rejects.toThrow();
	put(join(root, "server/broken.ts"), 'import "./missing-build-input";');
	await expect(
		compileRuntimeBundle({
			root,
			entrypoints: [join(root, "server/broken.ts")],
			outfile: join(root, "failed-runtime"),
			buildId: "failed",
			repository: "fixture/repository",
			modules: new Map(),
		}),
	).rejects.toThrow("Could not resolve");
	expect(existsSync(join(root, "failed-runtime"))).toBe(false);
	expect(existsSync(join(root, "ran-source"))).toBe(false);
	expect(existsSync(join(root, "ran-migration"))).toBe(false);
	expect(existsSync(join(home, "narrafork.db"))).toBe(false);
	expect(readdirSync(join(home, "runtime"))).toEqual(["old"]);
	expect(readFileSync(join(home, "runtime/old/narrafork"), "utf8")).toBe("old artifact");
});

test("compiler deadline, cancellation and output budget fail with bounded diagnostics", async () => {
	const cwd = temporary();
	await expect(
		runRuntimeBuildCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			cwd,
			timeoutMs: 100,
		}),
	).rejects.toThrow("timed out");
	const controller = new AbortController();
	const running = runRuntimeBuildCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		cwd,
		signal: controller.signal,
	});
	controller.abort(new Error("fixture cancellation"));
	await expect(running).rejects.toThrow("fixture cancellation");
	try {
		await runRuntimeBuildCommand(
			[process.execPath, "-e", 'for (;;) console.log("x".repeat(8192))'],
			{ cwd, timeoutMs: 5000, maxOutputBytes: 64 * 1024 },
		);
		throw new Error("Output flood unexpectedly succeeded");
	} catch (error) {
		expect(String(error)).toContain("byte budget");
		expect(String(error).length).toBeLessThan(34_000);
	}
});

test("full backend builds from a foreign cwd retain distinct artifacts without writing generated source or databases", async () => {
	const directory = temporary();
	const home = join(directory, "home");
	const generated = () =>
		Object.fromEntries(
			[...new Bun.Glob("server/generated/**/*.ts").scanSync({ cwd: ROOT })]
				.sort()
				.map((path) => [path, Bun.hash(readFileSync(join(ROOT, path))).toString()]),
		);
	const before = generated();
	const resultPath = join(directory, "results.json");
	await runRuntimeBuildCommand(
		[
			process.execPath,
			"--no-install",
			"-e",
			`import { buildRuntime } from ${JSON.stringify(join(ROOT, "scripts/build-runtime.ts"))};
const results = [await buildRuntime(), await buildRuntime()];
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(results));`,
		],
		{ cwd: directory, env: { HOME: directory, NARRAFORK_HOME: home }, timeoutMs: 90_000 },
	);
	const results = JSON.parse(readFileSync(resultPath, "utf8")) as Array<{
		executable: string;
		buildId: string;
		elapsedMs: number;
		bytes: number;
	}>;
	expect(results).toHaveLength(2);
	expect(results[0].buildId).not.toBe(results[1].buildId);
	for (const result of results) {
		expect(result.executable.startsWith(join(home, "runtime", result.buildId))).toBe(true);
		expect(statSync(result.executable).size).toBe(result.bytes);
		expect(result.bytes).toBeGreaterThan(1_000_000);
		expect(result.elapsedMs).toBeGreaterThan(0);
		expect(
			JSON.parse(readFileSync(join(home, "runtime", result.buildId, "build.json"), "utf8")),
		).toEqual({ ...result, frontend: false });
	}
	expect(generated()).toEqual(before);
	expect(existsSync(join(home, "narrafork.db"))).toBe(false);
}, 120_000);

test("compiled A keeps new/recreated workers, lazy imports, assets and real ws after source/dependency loss", async () => {
	const directory = temporary();
	const source = join(directory, "source");
	const executable = join(directory, process.platform === "win32" ? "runtime.exe" : "runtime");
	const worker = "services/token-recalculation-worker.ts";
	const runtimeTarget = JSON.stringify(join(ROOT, "server/lib/runtime-target.ts"));
	const compiledWorker = JSON.stringify(join(ROOT, "server/lib/compiled-worker.ts"));
	put(join(source, "node_modules/pinned-dependency/package.json"), '{"main":"index.js"}');
	put(join(source, "node_modules/pinned-dependency/index.js"), 'exports.value = "A";');
	cpSync(join(ROOT, "node_modules/ws"), join(source, "node_modules/ws"), { recursive: true });
	put(join(source, "server/generated/build-info.ts"), 'throw new Error("must use memory module");');
	put(join(source, "server/vendor/generated/build-info.ts"), 'export const other = "vendor";');
	put(join(source, "server/asset.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
	put(
		join(source, "server/late.ts"),
		`
import { value } from "pinned-dependency";
import asset from "./asset.wasm" with { type: "file" };
export async function late() {
  const module = await WebAssembly.compile(await Bun.file(asset).arrayBuffer());
  return { value, wasm: module instanceof WebAssembly.Module };
}
`,
	);
	put(
		join(source, `server/${worker}`),
		`
import { parentPort } from "node:worker_threads";
import { RUNTIME_BUILD_ID, IS_LOCAL_RUNTIME } from ${runtimeTarget};
import { value } from "pinned-dependency";
parentPort.on("message", async () => {
  const { late } = await import("../late");
  parentPort.postMessage({ ready: true, buildId: RUNTIME_BUILD_ID, local: IS_LOCAL_RUNTIME, value, late: await late() });
});
`,
	);
	put(
		join(source, "server/index.ts"),
		`
import { RUNTIME_BUILD_ID, IS_LOCAL_RUNTIME } from ${runtimeTarget};
import { compiledWorkerSpecifiers, connectCompiledWorker } from ${compiledWorker};
import { version } from "./generated/build-info";
import { other } from "./vendor/generated/build-info";
// Production memory-profile-transport deliberately imports this npm file, not Bun's ws shim.
import WebSocket from "../node_modules/ws/lib/websocket.js";
process.send({ ready: true, buildId: RUNTIME_BUILD_ID, local: IS_LOCAL_RUNTIME, version, other, realWs: typeof WebSocket.prototype.setSocket === "function" });
process.on("message", async (message) => {
  try {
    let data;
    if (message.action === "worker") {
      const { worker } = await connectCompiledWorker(compiledWorkerSpecifiers(${JSON.stringify(worker)}, "./${worker}", import.meta.url), { signal: AbortSignal.timeout(5000) });
      try {
        data = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); worker.postMessage({ read: true }); });
      } finally { await worker.terminate(); }
    } else if (message.action === "lazy") { data = await (await import("./late")).late(); }
    process.send({ id: message.id, data });
  } catch (error) { process.send({ id: message.id, error: String(error) }); }
});
`,
	);
	await compileRuntimeBundle({
		root: source,
		entrypoints: [join(source, "server/index.ts"), join(source, "server", worker)],
		outfile: executable,
		buildId: "fixture-A",
		repository: "fixture/repository",
		modules: new Map([["build-info.ts", 'export const version = "memory-A";']]),
	});
	expect(readFileSync(join(source, "server/generated/build-info.ts"), "utf8")).toContain(
		"must use memory",
	);
	const launch = () => {
		let sequence = 0;
		const pending = new Map<number, (message: { data?: unknown; error?: string }) => void>();
		const ready = Promise.withResolvers<unknown>();
		const child = Bun.spawn([executable], {
			cwd: directory,
			env: { ...process.env, HOME: directory, NARRAFORK_HOME: join(directory, "home") },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			ipc(message) {
				if (message.ready) ready.resolve(message);
				else pending.get(message.id)?.(message);
			},
		});
		void child.exited.then((code) => ready.reject(new Error(`Compiled fixture exited: ${code}`)));
		const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
		const request = (action: string) =>
			new Promise<unknown>((resolveRequest, reject) => {
				const id = ++sequence;
				const timer = setTimeout(() => reject(new Error("Fixture request timed out")), 6000);
				pending.set(id, (message) => {
					clearTimeout(timer);
					pending.delete(id);
					if (message.error) reject(new Error(message.error));
					else resolveRequest(message.data);
				});
				child.send({ id, action });
			});
		const close = async () => {
			clearTimeout(watchdog);
			child.kill("SIGKILL");
			await child.exited;
		};
		return { ready: ready.promise, request, close };
	};
	const expectedWorker = {
		ready: true,
		buildId: "fixture-A",
		local: true,
		value: "A",
		late: { value: "A", wasm: true },
	};
	const original = launch();
	try {
		expect(await original.ready).toEqual({
			ready: true,
			buildId: "fixture-A",
			local: true,
			version: "memory-A",
			other: "vendor",
			realWs: true,
		});
		expect(await original.request("worker")).toEqual(expectedWorker);
		renameSync(source, join(directory, "moved-source"));
		put(join(source, "server/index.ts"), "<<<<<<< unresolved source conflict");
		put(join(source, "node_modules/pinned-dependency/index.js"), 'exports.value = "B";');
		expect(await original.request("worker")).toEqual(expectedWorker);
		expect(await original.request("worker")).toEqual(expectedWorker);
		expect(await original.request("lazy")).toEqual({ value: "A", wasm: true });
		// Even invalid cwd configuration must not be consulted by the standalone runtime.
		put(join(directory, "package.json"), "<<<<<<< invalid package");
		put(join(directory, "bunfig.toml"), "<<<<<<< invalid config");
		put(join(directory, "tsconfig.json"), "<<<<<<< invalid typescript");
		rmSync(source, { recursive: true });
		rmSync(join(directory, "moved-source"), { recursive: true });
		const fresh = launch();
		try {
			expect(await fresh.ready).toMatchObject({ buildId: "fixture-A", realWs: true });
			expect(await fresh.request("worker")).toEqual(expectedWorker);
			expect(await fresh.request("lazy")).toEqual({ value: "A", wasm: true });
		} finally {
			await fresh.close();
		}
	} finally {
		await original.close();
	}
}, 60_000);
