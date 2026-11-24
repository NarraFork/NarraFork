import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import archiver from "archiver";
import { logger } from "../../../server/lib/logger";
import { WorkerCleanupError, WorkerHandle } from "../../../server/lib/worker-runtime/lifecycle";
import {
	PLUGIN_PACKAGE_STAGE_MAX_BUFFERED_BYTES,
	PLUGIN_PACKAGE_STAGE_MAX_RESPONSE_BYTES,
	PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
} from "../../../server/services/plugin-package-stage-protocol";
import * as packageStore from "../../../server/services/plugin-package-store";
import {
	LocalProcessRunner,
	type PluginPackageStageWorker,
	type RunnerProcess,
	RuntimeSupervisor,
	stagePluginPackage,
} from "../../../server/services/plugin-runtime";
import * as pluginSignatures from "../../../server/services/plugin-signature";

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

type PackageStageFault =
	| "normal"
	| "not-ready"
	| "stage-error"
	| "stage-exit"
	| "stage-timeout"
	| "verify-timeout"
	| "false-verify"
	| "bad-result"
	| "oversized-response"
	| "late-error";
const packageStageFixtures: PackageStageFixture[] = [];
const packageStageRoots: string[] = [];

class PackageStageFixture extends EventEmitter implements PluginPackageStageWorker {
	readonly requests: Array<{ action?: string; id?: number }> = [];
	readonly terminating = Promise.withResolvers<void>();
	readonly staging = Promise.withResolvers<void>();
	readonly verifying = Promise.withResolvers<void>();
	readonly exit = Promise.withResolvers<number>();
	terminations = 0;
	private finished = false;

	constructor(
		private readonly root: string,
		readonly fault: PackageStageFault = "normal",
		private readonly autoExit = true,
		private readonly terminateError?: Error,
	) {
		super();
		packageStageFixtures.push(this);
	}

	postMessage(input: unknown): void {
		const request = input as { action?: string; id?: number };
		this.requests.push(request);
		if (request.action === "plugin_package_stage") this.staging.resolve();
		if (request.action === "plugin_package_verify") this.verifying.resolve();
		queueMicrotask(() => {
			if (request.action === "ping") {
				if (this.fault !== "not-ready")
					this.emit("message", {
						packageStageReady: true,
						protocolVersion: PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
					});
				return;
			}
			if (request.action === "plugin_package_stage") {
				if (this.fault === "stage-timeout") return;
				if (this.fault === "stage-error") {
					this.emit("error", new Error("stage worker crashed"));
					return;
				}
				if (this.fault === "stage-exit") {
					this.finish();
					return;
				}
				const pluginId = "com.example.stage-fixture";
				const version = "1.0.0";
				const hash = "a".repeat(64);
				const path = resolve(this.root, "packages", pluginId, version, hash);
				const resultJson =
					this.fault === "oversized-response"
						? " ".repeat(PLUGIN_PACKAGE_STAGE_MAX_RESPONSE_BYTES + 1)
						: JSON.stringify({
								pluginId,
								version,
								hash,
								path,
								packagePath: path,
								currentUpdated: false,
								alreadyInstalled: false,
								manifest: this.fault === "bad-result" ? null : { pluginId, version },
								signatureIdentity: null,
								previousSignatureIdentity: null,
							});
				this.emit("message", {
					type: "staged",
					id: request.id,
					protocolVersion: PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
					resultJson,
				});
				return;
			}
			if (request.action === "plugin_package_verify" && this.fault !== "verify-timeout")
				this.emit("message", {
					type: "verified",
					id: request.id,
					protocolVersion: PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
					verified: this.fault !== "false-verify",
				});
		});
	}

	terminate(): Promise<number> {
		this.terminations++;
		this.terminating.resolve();
		if (this.terminateError) return Promise.reject(this.terminateError);
		if (this.fault === "late-error") this.emit("error", new Error("worker failed after verify"));
		if (this.autoExit) queueMicrotask(() => this.finish());
		return Promise.resolve(0); // A termination ACK deliberately does not prove exit.
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.emit("exit", 0);
		this.exit.resolve(0);
	}
}

function forbidMainPackageWork() {
	const install = spyOn(packageStore.PluginPackageStore.prototype, "install").mockRejectedValue(
		new Error("Forbidden main-thread package staging fallback"),
	);
	const verify = spyOn(pluginSignatures, "verifyPluginPackageSignature").mockRejectedValue(
		new Error("Forbidden main-thread package trust fallback"),
	);
	const hash = spyOn(packageStore, "computePackageHash").mockRejectedValue(
		new Error("Forbidden main-thread package hashing fallback"),
	);
	return {
		assert() {
			expect(install).not.toHaveBeenCalled();
			expect(verify).not.toHaveBeenCalled();
			expect(hash).not.toHaveBeenCalled();
		},
		restore() {
			install.mockRestore();
			verify.mockRestore();
			hash.mockRestore();
		},
	};
}

async function makeSignedStagePackage(fault = "valid") {
	const root = await realpath(await mkdtemp(join(tmpdir(), "narrafork-package-stage-")));
	packageStageRoots.push(root);
	const source = join(root, "source");
	await cp(join(import.meta.dir, "../../fixtures/plugins/packages/valid-package"), source, {
		recursive: true,
	});
	if (fault !== "missing-sbom")
		await writeFile(
			join(source, "sbom.spdx.json"),
			JSON.stringify({
				spdxVersion: "SPDX-2.3",
				packages: [
					{
						SPDXID: "SPDXRef-fixture",
						name: "fixture",
						versionInfo: "1.0.0",
						licenseConcluded: fault === "sbom-policy" ? "GPL-3.0-only" : "MIT",
					},
				],
			}),
		);
	const keys = generateKeyPairSync("ed25519");
	// Explicit pure-core fixture preparation is not a production Worker failure fallback.
	const digest = await pluginSignatures.digestPluginDirectory(source);
	const unsigned = {
		algorithm: "ed25519" as const,
		keyId: "stage-test",
		publisherId: "stage-publisher",
		pluginId: fault === "signature-identity" ? "com.example.other" : "com.example.hello",
		version: "1.0.0",
		packageDigest: digest.packageDigest,
		files: digest.files,
	};
	await writeFile(
		join(source, "signature.json"),
		JSON.stringify({
			...unsigned,
			signature: sign(
				null,
				pluginSignatures.createPluginSignaturePayload(unsigned),
				keys.privateKey,
			).toString("base64"),
		}),
	);
	if (fault === "artifact-bytes")
		await writeFile(join(source, "signature.json"), "x".repeat(1024 * 1024 + 1));
	if (fault === "manifest" || fault === "manifest-digest") {
		const manifestPath = join(source, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		if (fault === "manifest") manifest.pluginId = "../escape";
		else manifest.displayName = "Changed after signing";
		await writeFile(manifestPath, JSON.stringify(manifest));
	}
	if (fault === "package-digest")
		await writeFile(join(source, "server/index.js"), "// changed after signing\n");
	const archivePath = join(root, "fixture.nfplugin");
	const archive = archiver("zip", { zlib: { level: 1 } });
	const sink = createWriteStream(archivePath);
	const completed = pipeline(archive, sink);
	const timer = setTimeout(() => {
		archive.abort();
		sink.destroy(new Error("package fixture ZIP timeout"));
	}, 5_000);
	try {
		archive.directory(source, false);
		await Promise.all([archive.finalize(), completed]);
	} finally {
		clearTimeout(timer);
	}
	const bytes = await readFile(archivePath);
	if (bytes.byteLength > 2 * 1024 * 1024)
		throw new Error("Package fixture exceeded its input budget");
	return {
		root,
		source,
		archivePath,
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		trustPolicy: {
			enabled: true,
			requireSignature: true,
			keyring:
				fault === "unknown-key"
					? undefined
					: new pluginSignatures.PluginTrustKeyring([
							{
								keyId: "stage-test",
								publicKey: keys.publicKey,
								pluginIds: ["com.example.hello"],
								revokedAt: fault === "revoked-key" ? "2025-01-01T00:00:00.000Z" : undefined,
							},
						]),
			sbomPolicy: {
				requireSbom: true,
				allowedFormats: ["spdx"] as const,
				allowedLicenses: ["MIT"],
				maxComponents: 4,
			},
		},
	};
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
	describe("HMR owner retention", () => {
		let platform: typeof import("../../../server/services/plugin-platform-services");
		let manager: typeof import("../../../server/services/plugin-manager");
		beforeAll(async () => {
			// A hot reload starts with loaded owners. Bound cold module/DB initialization separately
			// from the existing HMR budget; the file's total wall time still includes preparation.
			[platform, manager] = await Promise.all([
				import("../../../server/services/plugin-platform-services"),
				import("../../../server/services/plugin-manager"),
			]);
		}, 30_000);
		test("HMR retains actual platform and manager owners, not a fresh empty supervisor", async () => {
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
		}, 15_000);
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
			allowUnboundedResourceUsage: true,
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
		try {
			const options = {
				pluginId: "com.example.runtime",
				version: "1.0.0",
				command,
				cwd,
				runnerOptions: { allowUnboundedResourceUsage: true },
			};
			const runtime = await supervisor.start(options);
			const pid = runtime.pid;
			expect(pid).toBeGreaterThan(0);
			expect(runtime.state).toBe("active");
			supervisor.stopProducers();
			supervisor.stopProducers();
			await expect(supervisor.start("com.example.runtime")).rejects.toThrow("closed");
			await expect(supervisor.start("com.example.unregistered")).rejects.toThrow("closed");
			await expect(supervisor.start(options)).rejects.toThrow("closed");
			expect(() => supervisor.register(options)).toThrow("closed");
			expect(runtime.state).toBe("active");
			// Await real pipe IO before entering Bun's promise matcher, which can starve native
			// stdio polling on Windows. Keep the same RPC/result assertion and real subprocess.
			expect(await runtime.request("echo", { text: "ok" })).toEqual({ ok: true });
			const closing = supervisor.shutdown();
			expect(supervisor.shutdown()).toBe(closing);
			await closing;
			expect(runtime.state).toBe("stopped");
			expect(() => globalThis.process.kill(pid as number, 0)).toThrow();
			await expect(supervisor.start("com.example.runtime")).rejects.toThrow("closed");
		} finally {
			await supervisor.shutdown();
		}
	}, 15_000);
});

describe("plugin package staging ownership", () => {
	let previousDisabled: string | undefined;
	const realWorkers: Array<ReturnType<typeof WorkerHandle.thread>> = [];
	beforeEach(() => {
		previousDisabled = process.env.NF_PLUGIN_PACKAGE_STAGE_DISABLED;
		delete process.env.NF_PLUGIN_PACKAGE_STAGE_DISABLED;
	});
	afterEach(async () => {
		try {
			for (const fixture of packageStageFixtures.splice(0)) {
				fixture.finish();
				await fixture.exit.promise;
			}
			for (const handle of realWorkers.splice(0)) {
				await handle.close();
				await handle.exited;
			}
			for (const root of packageStageRoots.splice(0))
				await rm(root, { recursive: true, force: true });
		} finally {
			if (previousDisabled === undefined) delete process.env.NF_PLUGIN_PACKAGE_STAGE_DISABLED;
			else process.env.NF_PLUGIN_PACKAGE_STAGE_DISABLED = previousDisabled;
		}
	});
	function trackWorkers() {
		const created: Array<ReturnType<typeof WorkerHandle.thread>> = [];
		const exited = new Set<ReturnType<typeof WorkerHandle.thread>>();
		const original = WorkerHandle.thread;
		const spy = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
			const handle = original(entry, options);
			created.push(handle);
			realWorkers.push(handle);
			void handle.exited.then(
				() => exited.add(handle),
				() => {},
			);
			return handle;
		});
		return { created, exited, restore: () => spy.mockRestore() };
	}

	test("oversized buffered input is rejected before Worker creation", async () => {
		const guards = forbidMainPackageWork();
		let creates = 0;
		try {
			await expect(
				stagePluginPackage(cwd, new Uint8Array(PLUGIN_PACKAGE_STAGE_MAX_BUFFERED_BYTES + 1), {
					workerFactory: () => {
						creates++;
						return new PackageStageFixture(cwd);
					},
				}),
			).rejects.toThrow("bounded on-disk download");
			expect(creates).toBe(0);
			guards.assert();
		} finally {
			guards.restore();
		}
	});

	test.each([
		"disabled",
		"creation",
		"not-ready",
		"stage-error",
		"stage-exit",
		"stage-timeout",
		"verify-timeout",
		"false-verify",
		"bad-result",
		"oversized-response",
		"late-error",
	] as const)("package Worker failure never performs package/trust work on the host (%s)", async (fault) => {
		const guards = forbidMainPackageWork();
		let creates = 0;
		const worker = new PackageStageFixture(
			cwd,
			fault === "disabled" || fault === "creation" ? "normal" : fault,
		);
		try {
			if (fault === "disabled") process.env.NF_PLUGIN_PACKAGE_STAGE_DISABLED = "1";
			const work = stagePluginPackage(cwd, cwd, {
				timeoutMs: 100,
				startupTimeoutMs: 30,
				exitTimeoutMs: 100,
				workerFactory: () => {
					creates++;
					if (fault === "creation") throw new Error("package worker creation denied");
					return worker;
				},
			});
			await expect(work).rejects.toBeInstanceOf(Error);
			expect(creates).toBe(fault === "disabled" ? 0 : 1);
			if (fault === "disabled" || fault === "creation") expect(worker.requests).toHaveLength(0);
			guards.assert();
		} finally {
			guards.restore();
			worker.finish();
		}
	});

	test("successful verify and a terminate ACK retain admission until real exit", async () => {
		const guards = forbidMainPackageWork();
		const worker = new PackageStageFixture(cwd, "normal", false);
		const work = stagePluginPackage(cwd, cwd, {
			workerFactory: () => worker,
			exitTimeoutMs: 1_000,
		});
		let settled = false;
		void work.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await worker.terminating.promise;
			await turn();
			expect(worker.terminations).toBe(1);
			expect(settled).toBe(false);
			let creates = 0;
			await expect(
				stagePluginPackage(cwd, cwd, {
					timeoutMs: 30,
					workerFactory: () => {
						creates++;
						return new PackageStageFixture(cwd);
					},
				}),
			).rejects.toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
			expect(creates).toBe(0);
			worker.finish();
			await expect(work).resolves.toMatchObject({ currentUpdated: false });
			expect(settled).toBe(true);
			guards.assert();
		} finally {
			worker.finish();
			await work.catch(() => {});
			guards.restore();
		}
	});

	test.each([
		"terminate-rejected",
		"exit-timeout",
	] as const)("failed real-exit confirmation retains its handle and slot (%s)", async (fault) => {
		const guards = forbidMainPackageWork();
		const worker = new PackageStageFixture(
			cwd,
			"normal",
			false,
			fault === "terminate-rejected" ? new Error("package terminate denied") : undefined,
		);
		let error: WorkerCleanupError | undefined;
		try {
			const result = await stagePluginPackage(cwd, cwd, {
				workerFactory: () => worker,
				exitTimeoutMs: 30,
			}).then(
				() => undefined,
				(reason: unknown) => reason,
			);
			expect(result).toBeInstanceOf(WorkerCleanupError);
			error = result as WorkerCleanupError;
			let exited = false;
			void error.handle.exited.then(() => {
				exited = true;
			});
			await turn();
			expect(exited).toBe(false);
			let creates = 0;
			await expect(
				stagePluginPackage(cwd, cwd, {
					timeoutMs: 30,
					workerFactory: () => {
						creates++;
						return new PackageStageFixture(cwd);
					},
				}),
			).rejects.toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
			expect(creates).toBe(0);
			worker.finish();
			await error.handle.exited;
			expect(exited).toBe(true);
			await expect(
				stagePluginPackage(cwd, cwd, {
					workerFactory: () => new PackageStageFixture(cwd),
				}),
			).resolves.toMatchObject({ currentUpdated: false });
			guards.assert();
		} finally {
			worker.finish();
			await error?.handle.exited;
			guards.restore();
		}
	});

	test.each([
		"stage-timeout",
		"verify-timeout",
	] as const)("cancellation waits for actual Worker exit (%s)", async (fault) => {
		const guards = forbidMainPackageWork();
		const controller = new AbortController();
		const worker = new PackageStageFixture(cwd, fault, false);
		const work = stagePluginPackage(cwd, cwd, {
			workerFactory: () => worker,
			signal: controller.signal,
			exitTimeoutMs: 1_000,
		});
		let settled = false;
		void work.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await (fault === "stage-timeout" ? worker.staging.promise : worker.verifying.promise);
			controller.abort(new Error("cancel package staging"));
			await worker.terminating.promise;
			await turn();
			expect(settled).toBe(false);
			worker.finish();
			await expect(work).rejects.toMatchObject({ name: "AbortError" });
			guards.assert();
		} finally {
			worker.finish();
			await work.catch(() => {});
			guards.restore();
		}
	});

	test("startup timeout owns unresolved creation and stops its late Worker before rejecting", async () => {
		const guards = forbidMainPackageWork();
		const create = Promise.withResolvers<PluginPackageStageWorker>();
		const startupTimer = Promise.withResolvers<() => void>();
		const original = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) => {
			const handle = original(callback, delay, ...args);
			if (delay !== undefined && delay <= 20) startupTimer.resolve(() => callback(...args));
			return handle;
		}) as typeof setTimeout);
		const worker = new PackageStageFixture(cwd, "normal", false);
		const work = stagePluginPackage(cwd, cwd, {
			workerFactory: () => create.promise,
			startupTimeoutMs: 20,
			exitTimeoutMs: 1_000,
		});
		let settled = false;
		void work.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			(await startupTimer.promise)();
			await turn();
			expect(settled).toBe(false);
			create.resolve(worker);
			await worker.terminating.promise;
			expect(worker.requests).toHaveLength(0);
			expect(settled).toBe(false);
			worker.finish();
			await expect(work).rejects.toMatchObject({ code: "PACKAGE_STAGE_TIMEOUT" });
			guards.assert();
		} finally {
			create.resolve(worker);
			await turn();
			worker.finish();
			await work.catch(() => {});
			timer.mockRestore();
			guards.restore();
		}
	});

	test.each([
		"modified",
		"added",
		"removed",
		"manifest",
	] as const)("installed inspection binds ordinary package files to the stored hash (%s)", async (change) => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "nf-inspected-package-")));
		packageStageRoots.push(directory);
		const source = join(directory, "source");
		await cp(join(import.meta.dir, "../../fixtures/plugins/packages/valid-package"), source, {
			recursive: true,
		});
		await writeFile(join(source, "data.txt"), "original sample\n");
		const root = join(directory, "store");
		const guards = forbidMainPackageWork();
		const tracking = trackWorkers();
		try {
			const staged = await stagePluginPackage(root, source);
			const inspectPackage = {
				pluginId: staged.pluginId,
				version: staged.version,
				hash: staged.hash,
			};
			const before = await new packageStore.PluginPackageStore(root).readCurrent();
			const inspected = await stagePluginPackage(root, staged.path, { inspectPackage });
			expect(inspected).toMatchObject({
				...inspectPackage,
				currentUpdated: false,
				alreadyInstalled: true,
			});
			if (change === "modified")
				await writeFile(join(staged.path, "data.txt"), "modified sample\n");
			if (change === "added")
				await writeFile(join(staged.path, "extra.txt"), "additional sample\n");
			if (change === "removed") await rm(join(staged.path, "data.txt"));
			if (change === "manifest") {
				const manifest = JSON.parse(await readFile(join(staged.path, "manifest.json"), "utf8"));
				manifest.displayName = "Different label, same identity";
				await writeFile(join(staged.path, "manifest.json"), JSON.stringify(manifest));
			}
			await expect(stagePluginPackage(root, staged.path, { inspectPackage })).rejects.toMatchObject(
				{
					code: "PLUGIN_PACKAGE_HASH_MISMATCH",
				},
			);
			// A repeated install must not authorize different retained bytes via an intact source.
			await expect(stagePluginPackage(root, source)).rejects.toMatchObject({
				code: "PLUGIN_PACKAGE_HASH_MISMATCH",
			});
			expect(await new packageStore.PluginPackageStore(root).readCurrent()).toEqual(before);
			expect(tracking.created.length).toBeGreaterThanOrEqual(4);
			expect(tracking.exited.size).toBe(tracking.created.length);
			guards.assert();
		} finally {
			tracking.restore();
			guards.restore();
		}
	}, 20_000);

	test("installed inspection retains the host's file and byte limits", async () => {
		const fixture = await makeSignedStagePackage();
		const root = join(fixture.root, "store");
		const guards = forbidMainPackageWork();
		const tracking = trackWorkers();
		try {
			const staged = await stagePluginPackage(root, fixture.bytes, {
				trustPolicy: fixture.trustPolicy,
			});
			const inspectPackage = {
				pluginId: staged.pluginId,
				version: staged.version,
				hash: staged.hash,
			};
			for (const limits of [{ maxFiles: 1 }, { maxFileBytes: 1 }, { maxUnpackedBytes: 1 }]) {
				await expect(
					stagePluginPackage(root, staged.path, { inspectPackage, limits }),
				).rejects.toMatchObject({
					code: "PLUGIN_TRUST_ARTIFACT_TOO_LARGE",
				});
			}
			await expect(
				stagePluginPackage(root, staged.path, { inspectPackage, limits: { maxFiles: 0 } }),
			).rejects.toThrow("Package limits exceed");
			expect((await new packageStore.PluginPackageStore(root).readCurrent()).plugins).toEqual({});
			expect(tracking.exited.size).toBe(tracking.created.length);
			guards.assert();
		} finally {
			tracking.restore();
			guards.restore();
		}
	}, 20_000);

	test("installed inspection rechecks stored bytes after the host policy exchange", async () => {
		const fixture = await makeSignedStagePackage();
		const root = join(fixture.root, "store");
		const guards = forbidMainPackageWork();
		const tracking = trackWorkers();
		try {
			const staged = await stagePluginPackage(root, fixture.bytes, {
				trustPolicy: fixture.trustPolicy,
			});
			const keyring = fixture.trustPolicy.keyring;
			if (!keyring) throw new Error("Missing fixture keyring");
			const signaturePath = join(staged.path, "signature.json");
			const bytes = await readFile(signaturePath);
			const original = keyring.get.bind(keyring);
			const policy = spyOn(keyring, "get").mockImplementation((id) => {
				// The Worker has already read the identity and signature. Whitespace does not
				// change the verified signature, but it does change the stored package bytes.
				writeFileSync(signaturePath, Buffer.concat([bytes, Buffer.from("\n")]));
				return original(id);
			});
			try {
				await expect(
					stagePluginPackage(root, staged.path, {
						inspectPackage: {
							pluginId: staged.pluginId,
							version: staged.version,
							hash: staged.hash,
						},
						trustPolicy: fixture.trustPolicy,
					}),
				).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_HASH_MISMATCH" });
				expect(policy).toHaveBeenCalledTimes(1);
			} finally {
				policy.mockRestore();
			}
			expect((await new packageStore.PluginPackageStore(root).readCurrent()).plugins).toEqual({});
			expect(tracking.exited.size).toBe(tracking.created.length);
			guards.assert();
		} finally {
			tracking.restore();
			guards.restore();
		}
	}, 20_000);

	test("real signed ZIP verifies archive/package identity, signature and SBOM before returning after exit", async () => {
		const fixture = await makeSignedStagePackage();
		const guards = forbidMainPackageWork();
		const tracking = trackWorkers();
		const root = join(fixture.root, "store");
		try {
			const result = await stagePluginPackage(root, fixture.bytes, {
				expectedArchiveSha256: fixture.sha256,
				trustPolicy: fixture.trustPolicy,
				timeoutMs: 10_000,
			});
			expect(result).toMatchObject({
				pluginId: "com.example.hello",
				version: "1.0.0",
				currentUpdated: false,
			});
			expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
			expect(result.signatureIdentity).toBe("ed25519:stage-test:stage-publisher");
			expect(result.previousSignatureIdentity).toBeNull();
			expect((await new packageStore.PluginPackageStore(root).readCurrent()).plugins).toEqual({});
			expect(tracking.created.length).toBeGreaterThan(0);
			for (const handle of tracking.created) expect(handle.closed).toBe(true);
			expect(tracking.exited.size).toBe(tracking.created.length);
			const previous = tracking.created.length;
			const repeated = await stagePluginPackage(root, pathToFileURL(fixture.archivePath), {
				oldPackagePath: result.path,
				trustPolicy: fixture.trustPolicy,
				timeoutMs: 10_000,
			});
			expect(repeated).toMatchObject({
				hash: result.hash,
				alreadyInstalled: true,
				previousSignatureIdentity: result.signatureIdentity,
				currentUpdated: false,
			});
			expect(tracking.created.length).toBeGreaterThan(previous);
			expect(tracking.exited.size).toBe(tracking.created.length);
			guards.assert();
		} finally {
			tracking.restore();
			guards.restore();
		}
	}, 30_000);

	test.each([
		"archive-digest",
		"manifest",
		"manifest-digest",
		"package-digest",
		"signature-identity",
		"revoked-key",
		"unknown-key",
		"missing-sbom",
		"sbom-policy",
		"artifact-bytes",
	] as const)("real trust failure leaves current untouched and never falls back to the host (%s)", async (fault) => {
		const fixture = await makeSignedStagePackage(fault);
		const guards = forbidMainPackageWork();
		const tracking = trackWorkers();
		const root = join(fixture.root, "store");
		try {
			await expect(
				stagePluginPackage(root, fixture.bytes, {
					expectedArchiveSha256: fault === "archive-digest" ? "0".repeat(64) : fixture.sha256,
					trustPolicy: fixture.trustPolicy,
					timeoutMs: 10_000,
				}),
			).rejects.toBeInstanceOf(Error);
			expect((await new packageStore.PluginPackageStore(root).readCurrent()).plugins).toEqual({});
			expect(tracking.created.length).toBeGreaterThan(0);
			for (const handle of tracking.created) expect(handle.closed).toBe(true);
			expect(tracking.exited.size).toBe(tracking.created.length);
			guards.assert();
		} finally {
			tracking.restore();
			guards.restore();
		}
	}, 20_000);
});
