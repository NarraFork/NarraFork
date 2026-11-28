import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { db } from "@server/db";
import { integrationAuthorities } from "@server/db/schema";
import { ValidationError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import {
	PLUGIN_TOOL_OUTPUT_FRAME_MAX_BYTES,
	PROVIDER_REQUEST_MAX_BYTES,
} from "@server/lib/plugins/protocol";
import { WorkerCleanupError, WorkerHandle } from "@server/lib/worker-runtime/lifecycle";
import type { BundledPluginDescriptor } from "@server/services/bundled-plugin-assets";
import { integrationAuthorityService } from "@server/services/integration-authority-service";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginCatalog } from "@server/services/plugin-catalog";
import { PluginHostDispatcher } from "@server/services/plugin-host-dispatcher";
import { PluginHostServices } from "@server/services/plugin-host-services";
import { pluginInstallationAuthorityId } from "@server/services/plugin-integration-authority-service";
import {
	PluginLifecycleRevokeCoordinator,
	type PluginLifecycleRevokeEvent,
} from "@server/services/plugin-lifecycle-revoke-coordinator";
import {
	initializePluginServices,
	type PluginLifecycleRevokeCoordinatorLike,
	PluginManager,
	type PluginRuntimeSupervisorLike,
	pluginManager,
} from "@server/services/plugin-manager";
import type { PackageSource } from "@server/services/plugin-package-store";
import { PluginPermissionStore } from "@server/services/plugin-permission-store";
import {
	createPluginPlatformServices,
	pluginPlatformServices,
} from "@server/services/plugin-platform-services";
import { PodmanRunner } from "@server/services/plugin-podman-runner";
import {
	LocalProcessRunner,
	PluginRuntimeError,
	type PluginRuntimeOptions,
	type RuntimeDiagnostics,
	type RuntimeState,
	RuntimeSupervisor,
	type stagePluginPackage,
} from "@server/services/plugin-runtime";
import {
	createPluginSignaturePayload,
	digestPluginDirectory,
	PluginTrustKeyring,
	type TrustedPluginKey,
} from "@server/services/plugin-signature";
import { createPluginStateRecord, PluginStateStore } from "@server/services/plugin-state-store";
import archiver from "archiver";
import { and, eq, inArray } from "drizzle-orm";

const fixturePackage = fileURLToPath(
	new URL("../../fixtures/plugins/packages/valid-package", import.meta.url),
);
const tempRoots: string[] = [];
const drainBeforeCleanup: Array<() => Promise<void>> = [];
const managerFixtures: Array<{ release: () => void; drain: () => Promise<void> }> = [];

async function makeTempRoot(base = tmpdir()): Promise<string> {
	const created = await mkdtemp(join(base, "narrafork-plugin-manager-"));
	// macOS /var and Windows short-name TEMP paths can alias the real directory.
	// Give both the catalog and cleanup the newly-created canonical private root.
	const root = await realpath(created);
	tempRoots.push(root);
	return root;
}

async function makePackage(
	root: string,
	pluginId: string,
	mutate?: (manifest: Record<string, unknown>) => void,
): Promise<string> {
	const source = join(root, `source-${pluginId.replaceAll(".", "-")}`);
	await cp(fixturePackage, source, { recursive: true });
	const manifestPath = join(source, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
	manifest.pluginId = pluginId;
	manifest.displayName = pluginId;
	const engine = manifest.engine as Record<string, unknown>;
	engine.os = [process.platform];
	engine.arch = [process.arch];
	mutate?.(manifest);
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return source;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Delay the host's Worker admission while leaving package computation in the real Worker. */
function packageStaging(manager: PluginManager) {
	return manager as unknown as {
		stagePackage(
			source: PackageSource,
			signal?: AbortSignal,
			digest?: string,
		): ReturnType<typeof stagePluginPackage>;
	};
}

async function expectPending(work: Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		expect(
			await Promise.race([
				work.then(() => "finished"),
				new Promise<string>((resolve) => {
					timer = setTimeout(() => resolve("pending"), 30);
				}),
			]),
		).toBe("pending");
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Await actual fire-and-forget lifecycle work, including handlers queued by another handler. */
function trackRuntimeLifecycle(manager: PluginManager): () => Promise<void> {
	const pending: Promise<void>[] = [];
	const internal = manager as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
	for (const name of ["handleRuntimeStateChange", "observeRuntimeLifecycle"]) {
		const original = internal[name]?.bind(manager);
		if (!original) continue;
		internal[name] = (...args) => {
			const result = original(...args);
			pending.push(result);
			return result;
		};
	}
	return async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};
}

/** Every test manager owns a tracked lifecycle; the imported production singleton is untouched. */
function makeManager(options: ConstructorParameters<typeof PluginManager>[0] = {}): PluginManager {
	const manager = new PluginManager(options);
	const settle = trackRuntimeLifecycle(manager);
	const supervisor = manager.runtimeSupervisor;
	managerFixtures.push({
		release: () => {
			if (supervisor instanceof FakeSupervisor) {
				for (const gate of supervisor.gates.values()) gate.release.resolve();
			}
		},
		drain: async () => {
			await manager.shutdown();
			await supervisor.shutdown();
			await settle();
		},
	});
	return manager;
}

async function makeBundledFixture(
	root: string,
	pluginId: string,
	version = "1.0.1",
	prepare?: (source: string) => Promise<void>,
) {
	const source = await makePackage(root, pluginId, (manifest) => {
		manifest.version = version;
		manifest.activationEvents = ["onStartup"];
		(manifest.permissions as Record<string, unknown>).host = [
			"quota.provide",
			"provider.connection.request",
		];
	});
	await prepare?.(source);
	const archivePath = join(root, `${pluginId}.nfplugin`);
	const archive = archiver("zip");
	const sink = createWriteStream(archivePath);
	const completed = pipeline(archive, sink);
	const timer = setTimeout(() => {
		archive.abort();
		sink.destroy(new Error("bundled fixture archive timeout"));
	}, 10_000);
	try {
		archive.directory(source, false);
		await Promise.all([archive.finalize(), completed]);
	} finally {
		clearTimeout(timer);
	}
	const bytes = await readFile(archivePath);
	if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("bundled fixture byte limit exceeded");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	let loads = 0;
	const descriptor: BundledPluginDescriptor = {
		pluginId,
		version,
		load: async () => {
			loads++;
			return { bytes, sha256 };
		},
	};
	return { source, bytes, sha256, descriptor, loadCount: () => loads };
}

function packageSigner(pluginId: string) {
	const keys = generateKeyPairSync("ed25519");
	const key: TrustedPluginKey = {
		keyId: "manager-race-test",
		publicKey: keys.publicKey,
		pluginIds: [pluginId],
	};
	return {
		key,
		keyring: new PluginTrustKeyring([key]),
		sign: async (source: string, version: string) => {
			// Explicit fixture preparation; production still verifies only in the real Worker.
			const digest = await digestPluginDirectory(source);
			const payload = {
				algorithm: "ed25519" as const,
				keyId: key.keyId,
				pluginId,
				version,
				packageDigest: digest.packageDigest,
				files: digest.files,
			};
			await writeFile(
				join(source, "signature.json"),
				JSON.stringify({
					...payload,
					signature: sign(null, createPluginSignaturePayload(payload), keys.privateKey).toString(
						"base64",
					),
				}),
			);
		},
	};
}

class FakeRuntime {
	state: RuntimeState = "stopped";
	generation: number;
	readonly runtimeId: string;

	constructor(readonly options: PluginRuntimeOptions) {
		this.runtimeId = options.runtimeId ?? `fake-${options.pluginId}`;
		this.generation = options.generation ?? 0;
	}

	getDiagnostics(): RuntimeDiagnostics {
		return {
			pluginId: this.options.pluginId,
			pluginVersion: this.options.pluginVersion,
			runtimeId: this.runtimeId,
			generation: this.generation,
			state: this.state,
			inFlight: 0,
			capabilities: [...(this.options.grantedCapabilities ?? [])],
			stderr: "",
			lateMessages: 0,
		};
	}
}

class FakeSupervisor implements PluginRuntimeSupervisorLike {
	readonly runtimes = new Map<string, FakeRuntime>();
	readonly startCount = new Map<string, number>();
	readonly disableCount = new Map<string, number>();
	readonly failures = new Set<string>();
	readonly gates = new Map<
		string,
		{ entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
	>();

	register(options: PluginRuntimeOptions): FakeRuntime {
		const existing = this.runtimes.get(options.pluginId);
		if (existing && existing.options.command.join("\u0000") === options.command.join("\u0000")) {
			return existing;
		}
		if (existing) this.runtimes.delete(options.pluginId);
		const runtime = new FakeRuntime(options);
		this.runtimes.set(options.pluginId, runtime);
		return runtime;
	}

	async start(options: PluginRuntimeOptions, signal?: AbortSignal): Promise<FakeRuntime>;
	async start(pluginId: string, signal?: AbortSignal): Promise<FakeRuntime>;
	async start(
		optionsOrPluginId: PluginRuntimeOptions | string,
		signal?: AbortSignal,
	): Promise<FakeRuntime> {
		signal?.throwIfAborted();
		const runtime =
			typeof optionsOrPluginId === "string"
				? this.runtimes.get(optionsOrPluginId)
				: this.register(optionsOrPluginId);
		if (!runtime) throw new Error(`Runtime is not registered: ${optionsOrPluginId}`);
		const pluginId = runtime.options.pluginId;
		this.startCount.set(pluginId, (this.startCount.get(pluginId) ?? 0) + 1);
		const previous = runtime.state;
		runtime.state = "starting";
		runtime.generation += 1;
		runtime.options.onStateChange?.("starting", previous);
		const gate = this.gates.get(pluginId);
		if (gate) {
			gate.entered.resolve();
			await gate.release.promise;
		}
		signal?.throwIfAborted();
		if (this.failures.has(pluginId)) {
			const error = new PluginRuntimeError("simulated handshake failure", {
				code: "HELLO_PLUGIN_ID_MISMATCH",
				phase: "hello",
				kind: "handshake",
			});
			const beforeFailure = runtime.state;
			runtime.state = "failed";
			runtime.options.onStateChange?.("failed", beforeFailure);
			throw error;
		}
		const beforeActive = runtime.state;
		runtime.state = "active";
		runtime.options.onStateChange?.("active", beforeActive);
		return runtime;
	}

	async disable(pluginId: string): Promise<void> {
		const runtime = this.runtimes.get(pluginId);
		if (!runtime || runtime.state === "stopped") return;
		this.disableCount.set(pluginId, (this.disableCount.get(pluginId) ?? 0) + 1);
		const previous = runtime.state;
		runtime.state = "draining";
		runtime.options.onStateChange?.("draining", previous);
		const beforeStopped = runtime.state;
		runtime.state = "stopped";
		runtime.options.onStateChange?.("stopped", beforeStopped);
	}

	async drain(pluginId: string): Promise<void> {
		const runtime = this.runtimes.get(pluginId);
		if (runtime?.state === "active") runtime.state = "draining";
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.runtimes.keys()].map((pluginId) => this.disable(pluginId)));
	}

	get(pluginId: string): FakeRuntime | undefined {
		return this.runtimes.get(pluginId);
	}

	getDiagnostics(pluginId?: string): RuntimeDiagnostics[] {
		return (
			pluginId
				? [this.runtimes.get(pluginId)].filter(
						(runtime): runtime is FakeRuntime => runtime !== undefined,
					)
				: [...this.runtimes.values()]
		).map((runtime) => runtime.getDiagnostics());
	}

	quarantine(pluginId: string, reason: string): void {
		const runtime = this.runtimes.get(pluginId);
		if (!runtime) return;
		const previous = runtime.state;
		runtime.state = "quarantine";
		runtime.options.onStateChange?.("quarantine", previous);
		void reason;
	}

	gate(pluginId: string): { entered: Promise<void>; release: () => void } {
		const entered = deferred();
		const release = deferred();
		this.gates.set(pluginId, { entered, release });
		return { entered: entered.promise, release: release.resolve };
	}
}

async function makeLifecycleRaceFixture(pluginId: string) {
	const root = await makeTempRoot();
	const storeRoot = join(root, "plugins");
	const supervisor = new FakeSupervisor();
	const stateStore = new PluginStateStore(storeRoot);
	const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
	const capabilityBroker = new CapabilityBroker();
	const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
	const platform = createPluginPlatformServices({
		runtimeSupervisor: supervisor as never,
		stateStore,
		permissionStore,
		capabilityBroker,
		hostServices,
	});
	const crashEntered = deferred();
	const releaseCrash = deferred();
	const restored = deferred();
	const effects: string[] = [];
	let blockCrash = false;
	let failRevokes = false;
	let providerEnabled = false;
	const revoke: PluginLifecycleRevokeCoordinatorLike["revoke"] = async (event) => {
		if (blockCrash && event.kind === "crash") {
			crashEntered.resolve();
			await releaseCrash.promise;
		}
		const report = await platform.lifecycleRevokeCoordinator.revoke(event);
		providerEnabled = false;
		effects.push(`revoke:${event.kind}:${event.runtimeGeneration ?? "all"}`);
		if (failRevokes && ["crash", "runtime_generation"].includes(event.kind)) {
			throw new Error("Injected lifecycle adapter failure");
		}
		return report;
	};
	const manager = makeManager({
		root: storeRoot,
		disabled: false,
		stateStore,
		permissionStore,
		hostServices,
		runtimeSupervisor: supervisor,
		lifecycleRevokeCoordinator: { revoke },
		restorePluginLifecycle: async (id) => {
			await platform.restorePlugin(id);
			providerEnabled = true;
			effects.push("restore");
			if (blockCrash) restored.resolve();
		},
	});
	const settle = trackRuntimeLifecycle(manager);
	drainBeforeCleanup.push(async () => {
		releaseCrash.resolve();
		await settle();
	});
	const source = await makePackage(root, pluginId, (manifest) => {
		(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
	});
	await manager.install(source);
	await manager.enable(pluginId);
	await manager.activate(pluginId);
	await settle();
	const runtime = supervisor.get(pluginId);
	if (!runtime) throw new Error("Runtime was not registered");
	effects.length = 0;
	return {
		manager,
		supervisor,
		runtime,
		stateStore,
		hostServices,
		effects,
		settle,
		crashEntered,
		releaseCrash,
		restored,
		failRevokes() {
			failRevokes = true;
		},
		crash() {
			blockCrash = true;
			runtime.state = "crashed";
			runtime.options.onStateChange?.("crashed", "active");
			runtime.options.onCrash?.(new Error("old generation crashed"));
		},
		async callProvider() {
			// Controllable provider adapter: availability is an effect of lifecycle
			// revoke/restore, independent of whether a host binding exists.
			if (!providerEnabled) throw new Error("Provider disabled");
			const current = supervisor.get(pluginId);
			if (!current) throw new Error("Provider runtime missing");
			const binding = hostServices.getRuntimeBinding(pluginId, current.runtimeId);
			if (!binding) throw new Error("Provider runtime not bound");
			const response = await binding.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: "race-provider-call",
				method: "diagnostics.getOwn",
				params: {},
			});
			expect("result" in response).toBe(true);
			return binding.plugin;
		},
	};
}

afterEach(async () => {
	// Release controlled start gates before any drain can wait on the lifecycle mutex.
	for (const fixture of managerFixtures) fixture.release();
	for (const drain of drainBeforeCleanup.splice(0)) await drain();
	// Runtime callbacks can enqueue more state writes while shutdown is running. The factory's
	// tracked drain awaits all of them before any private fixture directory is removed.
	while (managerFixtures.length) {
		for (const fixture of managerFixtures.splice(0)) await fixture.drain();
	}
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginManager", () => {
	test("shutdown preserves disable failure after successful persistence, supervisor cleanup and callback drain", async () => {
		const root = await makeTempRoot();
		const writing = deferred();
		const release = deferred();
		let holdWrites = false;
		const stateStore = new PluginStateStore({
			root: join(root, "plugins"),
			renameFile: async (from, to) => {
				if (holdWrites) {
					writing.resolve();
					await release.promise;
				}
				await rename(from, to);
			},
		});
		const supervisor = new FakeSupervisor();
		const manager = new PluginManager({
			root: stateStore.root,
			stateStore,
			runtimeSupervisor: supervisor,
			disabled: false,
		});
		const settle = trackRuntimeLifecycle(manager);
		const pluginId = "com.example.shutdown-disable-failure";
		const source = await makePackage(root, pluginId);
		await manager.install(source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		await settle();
		const failure = new Error("injected disable failure");
		const originalDisable = supervisor.disable.bind(supervisor);
		const disable = spyOn(supervisor, "disable").mockRejectedValue(failure);
		// This custom supervisor successfully cleans its resource despite the earlier disable error.
		const shutdown = spyOn(supervisor, "shutdown").mockImplementation(async () => {
			holdWrites = true;
			await originalDisable(pluginId);
		});
		let closing: Promise<void> | undefined;
		drainBeforeCleanup.push(async () => {
			release.resolve();
			await closing?.catch(() => {});
			await settle();
		});
		try {
			let settled = false;
			closing = manager.shutdown();
			void closing.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await writing.promise; // The real stop callback has reached its atomic StateStore rename.
			expect(disable).toHaveBeenCalledTimes(1);
			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(supervisor.get(pluginId)?.state).toBe("stopped");
			expect(manager.hasPendingShutdownWork()).toBe(true);
			expect(settled).toBe(false);
			release.resolve();
			await expect(closing).rejects.toBe(failure);
			await settle();
			expect(settled).toBe(true);
			expect(manager.hasPendingShutdownWork()).toBe(false);
			expect((await stateStore.getState(pluginId))?.lastError?.message).toBe(failure.message);
			const operations = await stateStore.listOperations(pluginId);
			expect(
				operations.some(
					(operation) =>
						operation.operation === "deactivate" &&
						operation.status === "failed" &&
						operation.error?.message === failure.message,
				),
			).toBe(true);
		} finally {
			release.resolve();
			await closing?.catch(() => {});
			disable.mockRestore();
			shutdown.mockRestore();
			await supervisor.shutdown();
			await settle();
		}
	});
	test("health canaries are scalar-only while persisted failure details survive a throwing sink", async () => {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = new PluginManager({ root, runtimeSupervisor: supervisor });
		await manager.initialize();
		const pluginId = "com.example.health-canary";
		await manager.stateStore.upsert(createPluginStateRecord(pluginId));
		const runtime = supervisor.register({
			pluginId,
			command: ["fixture"],
			cwd: root,
			generation: 1,
		});
		const canary = "plugin-secret-/private/root-raw-error-body";
		const records: { message: string; data?: Record<string, unknown> }[] = [];
		const logs = (["warn", "error"] as const).map((level) =>
			spyOn(logger, level).mockImplementation((message, data) => {
				records.push({ message, data });
				throw new Error(canary);
			}),
		);
		const internal = manager as unknown as {
			persistRuntimeState(
				id: string,
				event: { runtime: FakeRuntime; diagnostics: RuntimeDiagnostics; state: string },
			): Promise<void>;
			handleObservedLifecycleRevokeFailure(
				id: string,
				state: string,
				error: unknown,
				sourceError?: unknown,
			): Promise<void>;
		};
		try {
			const update = spyOn(manager.stateStore, "updateState").mockRejectedValueOnce(
				new Error(canary),
			);
			try {
				await internal.persistRuntimeState(pluginId, {
					runtime,
					diagnostics: runtime.getDiagnostics(),
					state: "stopped",
				});
			} finally {
				update.mockRestore();
			}
			await internal.handleObservedLifecycleRevokeFailure(
				pluginId,
				"quarantine",
				new Error(canary),
				new Error(canary),
			);
			expect((await manager.stateStore.getState(pluginId))?.lastError?.message).toContain(canary);
			expect(records.length).toBeGreaterThanOrEqual(2);
			expect(JSON.stringify(records)).not.toContain(canary);
			for (const record of records) {
				expect(record.message).toBe("Plugin runtime health");
				for (const [key, value] of Object.entries(record.data ?? {})) {
					expect([
						"code",
						"generation",
						"failures",
						"attempt",
						"quarantined",
						"sourceError",
					]).toContain(key);
					expect(["string", "number", "boolean"]).toContain(typeof value);
				}
			}
		} finally {
			for (const log of logs) log.mockRestore();
			await manager.shutdown();
		}
	});
	test.each([
		"uninitialized",
		"metadata-read-failure",
		"callback-write-failure",
	] as const)("shutdown still exits real processes and drains actual StateStore callbacks (%s)", async (mode) => {
		const root = await makeTempRoot();
		const writeError = new Error("terminal callback rename failed");
		const writing = deferred();
		const release = deferred();
		let delayWrites = false;
		const stateStore = new PluginStateStore({
			root,
			renameFile: async (from, to) => {
				if (delayWrites) {
					writing.resolve();
					await release.promise;
					if (mode === "callback-write-failure") throw writeError;
				}
				await rename(from, to);
			},
		});
		const supervisor = new RuntimeSupervisor();
		const manager = new PluginManager({ root, stateStore, runtimeSupervisor: supervisor });
		let closing: Promise<void> | undefined;
		drainBeforeCleanup.push(async () => {
			release.resolve();
			await supervisor.shutdown().catch(() => {});
			await closing?.catch(() => {});
		});
		if (mode === "metadata-read-failure") await manager.initialize();
		const pluginId = "com.example.runtime";
		await stateStore.upsert(createPluginStateRecord(pluginId));
		const internal = manager as unknown as {
			handleRuntimeStateChange(
				id: string,
				event: {
					runtime: ReturnType<RuntimeSupervisor["register"]>;
					diagnostics: RuntimeDiagnostics;
					state: string;
				},
			): Promise<void>;
		};
		let observe = false;
		const cwd = fileURLToPath(new URL("../../fixtures/plugins/runtime", import.meta.url));
		const runtime = supervisor.register({
			pluginId,
			version: "1.0.0",
			cwd,
			command: [process.execPath, join(cwd, "fixture.ts"), "normal"],
			runnerOptions: { allowUnboundedResourceUsage: true },
			onStateChange(state) {
				if (!observe) return;
				void internal
					.handleRuntimeStateChange(pluginId, {
						runtime,
						diagnostics: runtime.getDiagnostics(),
						state,
					})
					.catch(() => {});
			},
		});
		expect(manager.hasPendingShutdownWork()).toBe(false); // Registered, never started.
		await supervisor.start(pluginId);
		const pid = runtime.pid;
		expect(manager.hasPendingShutdownWork()).toBe(true);
		const exited = Promise.withResolvers<void>();
		const shutdown = supervisor.shutdown.bind(supervisor);
		const shutdownSpy = spyOn(supervisor, "shutdown").mockImplementation(() => {
			const pending = shutdown();
			void pending.then(exited.resolve, exited.reject);
			return pending;
		});
		let restoreRead = () => {};
		const metadataError = new Error("state metadata read failed");
		try {
			observe = true;
			delayWrites = true;
			await runtime.drain();
			await writing.promise; // An actual atomic StateStore rename is now held by the callback.
			if (mode === "metadata-read-failure") {
				const read = spyOn(stateStore, "listStates").mockRejectedValueOnce(metadataError);
				restoreRead = () => read.mockRestore();
			}
			let settled = false;
			closing = manager.shutdown();
			void closing.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await exited.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(shutdownSpy).toHaveBeenCalledTimes(1);
			expect(() => process.kill(pid as number, 0)).toThrow();
			expect(supervisor.hasPendingShutdownWork()).toBe(false);
			expect(manager.hasPendingShutdownWork()).toBe(true); // Atomic StateStore rename still owned.
			expect(settled).toBe(false);
			release.resolve();
			if (mode === "metadata-read-failure") await expect(closing).rejects.toBe(metadataError);
			else if (mode === "callback-write-failure") await expect(closing).rejects.toBe(writeError);
			else await expect(closing).resolves.toBeUndefined();
			expect(settled).toBe(true);
			expect(manager.hasPendingShutdownWork()).toBe(false);
			const persisted = JSON.parse(await readFile(stateStore.statePath, "utf8"));
			// Persistence deliberately maps a stopped runtime to the existing inactive business state.
			expect(persisted.plugins[pluginId].runtimeState).toBe("inactive");
			expect(persisted.plugins[pluginId].runtimeGeneration).toBe(
				mode === "callback-write-failure" ? 0 : runtime.generation,
			);
		} finally {
			release.resolve();
			restoreRead();
			await closing?.catch(() => {});
			await supervisor.shutdown().catch(() => {});
			shutdownSpy.mockRestore();
		}
	});

	test("shutdown timeout retains its real deactivate journal and disable until the last write settles", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.journal-deadline";
		const journalEntered = deferred();
		const releaseWrite = deferred();
		const disableEntered = deferred();
		const releaseDisable = deferred();
		let holdWrite = false;
		const store = new PluginStateStore({
			root,
			renameFile: async (from, to) => {
				if (holdWrite && to === join(root, "journal.json")) {
					journalEntered.resolve();
					await releaseWrite.promise;
				}
				await rename(from, to);
			},
		});
		const supervisor = new FakeSupervisor();
		const manager = new PluginManager({ root, stateStore: store, runtimeSupervisor: supervisor });
		await manager.initialize();
		await store.upsert({ ...createPluginStateRecord(pluginId), runtimeState: "active" });
		supervisor.register({ pluginId, command: ["fixture"], cwd: root });
		await supervisor.start(pluginId);
		const disable = supervisor.disable.bind(supervisor);
		supervisor.shutdown = () => disable(pluginId); // No runtime callback is holding the write.
		supervisor.disable = async (id) => {
			disableEntered.resolve();
			await releaseDisable.promise;
			await disable(id);
		};
		// Give just the metadata read a settled snapshot so even a zero remaining budget reaches
		// the real journal. No assertions depend on racing the filesystem against a short timer.
		const states = await store.listStates();
		const read = spyOn(store, "listStates").mockResolvedValueOnce(states);
		const waits = spyOn(
			manager as unknown as {
				awaitShutdownWork<T>(work: Promise<T>, until: number): Promise<T>;
			},
			"awaitShutdownWork",
		);
		const settle = () => Promise.allSettled(waits.mock.calls.map(([work]) => work));
		try {
			holdWrite = true;
			const result = manager.shutdown({ timeoutMs: 0 });
			await expect(result).rejects.toMatchObject({ code: "PLUGIN_SHUTDOWN_TIMEOUT" });
			await journalEntered.promise;
			expect(supervisor.get(pluginId)?.state).toBe("stopped");
			expect(manager.hasPendingShutdownWork()).toBe(true);
			releaseWrite.resolve();
			await disableEntered.promise;
			expect(manager.hasPendingShutdownWork()).toBe(true);
			releaseDisable.resolve();
			await settle(); // Observe late children; don't initiate a second shutdown/repair.
			expect(manager.hasPendingShutdownWork()).toBe(false);
			expect((await store.listOperations(pluginId))[0]).toMatchObject({
				operation: "deactivate",
				status: "succeeded",
			});
		} finally {
			releaseWrite.resolve();
			releaseDisable.resolve();
			await settle();
			read.mockRestore();
			waits.mockRestore();
		}
	});

	test("shutdown fences new lifecycle requests but retains an admitted deactivate write", async () => {
		const root = await makeTempRoot();
		const writing = deferred();
		const release = deferred();
		let hold = false;
		const store = new PluginStateStore({
			root,
			renameFile: async (from, to) => {
				if (hold) {
					writing.resolve();
					await release.promise;
				}
				await rename(from, to);
			},
		});
		const manager = new PluginManager({
			root,
			stateStore: store,
			runtimeSupervisor: new RuntimeSupervisor(),
		});
		const id = "com.example.admitted-write";
		await manager.initialize();
		await store.upsert(createPluginStateRecord(id));
		hold = true;
		const waits = spyOn(
			manager as unknown as {
				awaitShutdownWork<T>(work: Promise<T>, until: number): Promise<T>;
			},
			"awaitShutdownWork",
		);
		const settle = () => Promise.allSettled(waits.mock.calls.map(([work]) => work));
		const admitted = manager.deactivate(id);
		try {
			await writing.promise;
			manager.beginShutdown();
			for (const operation of ["disable", "deactivate"] as const) {
				await expect(manager[operation](id)).rejects.toMatchObject({
					code: "PLUGIN_MANAGER_SHUTTING_DOWN",
				});
			}
			await expect(manager.shutdown({ timeoutMs: 0 })).rejects.toMatchObject({
				code: "PLUGIN_SHUTDOWN_TIMEOUT",
			});
			expect(manager.hasPendingShutdownWork()).toBe(true);
			release.resolve();
			await admitted;
			await settle(); // The underlying drain aggregate, not the already timed-out waiter.
			expect(manager.hasPendingShutdownWork()).toBe(false);
		} finally {
			release.resolve();
			await admitted;
			await settle();
			waits.mockRestore();
		}
	});

	test("shutdown retains a real runner process even when its runtime renders stopped", async () => {
		const root = await makeTempRoot();
		const supervisor = new RuntimeSupervisor();
		const manager = new PluginManager({ root, runtimeSupervisor: supervisor });
		const command = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
		const runtime = supervisor.register({
			pluginId: "com.example.runner-owner",
			command,
			cwd: root,
			runnerOptions: { allowUnboundedResourceUsage: true },
		});
		try {
			// This process belongs to the runner, not to an activated protocol generation.
			const handle = await runtime.startRunner({ command, cwd: root });
			manager.beginShutdown();
			expect(runtime.state).toBe("stopped");
			expect(manager.hasPendingShutdownWork()).toBe(true);
			await manager.shutdown();
			expect(Bun.peek.status(handle.exited)).toBe("fulfilled");
			expect(() => process.kill(handle.pid as number, 0)).toThrow();
			expect(manager.hasPendingShutdownWork()).toBe(false);
		} finally {
			await supervisor.shutdown();
		}
	});

	test("shutdown timeout retains the underlying supervisor close even with no runtime records", async () => {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const release = deferred();
		supervisor.shutdown = () => release.promise;
		const manager = new PluginManager({ root, runtimeSupervisor: supervisor });
		try {
			await expect(manager.shutdown({ timeoutMs: 0 })).rejects.toMatchObject({
				code: "PLUGIN_SHUTDOWN_TIMEOUT",
			});
			expect(manager.hasPendingShutdownWork()).toBe(true);
			release.resolve();
			await release.promise;
			expect(manager.hasPendingShutdownWork()).toBe(false);
		} finally {
			release.resolve();
			await release.promise;
		}
	});

	test("propagates unconfirmed supervisor cleanup instead of reporting clean shutdown", async () => {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = new PluginManager({ root, runtimeSupervisor: supervisor });
		await manager.initialize();
		supervisor.shutdown = async () => {
			throw new Error("resource exit unconfirmed");
		};
		await expect(manager.shutdown()).rejects.toThrow("resource exit unconfirmed");
	});

	test("retains a failed package Worker owner after its lifecycle call has already rejected", async () => {
		const root = await makeTempRoot();
		const manager = new PluginManager({ root, runtimeSupervisor: new FakeSupervisor() });
		const exit = Promise.withResolvers<number>();
		let stops = 0;
		const handle = new WorkerHandle({}, exit.promise, () => {
			stops++;
			throw new Error("package worker exit unconfirmed");
		});
		const failure = new WorkerCleanupError(handle, new Error("initial package stop failed"));
		const internal = manager as unknown as {
			trackLifecycleOperation<T>(work: Promise<T>): Promise<T>;
		};
		try {
			await expect(internal.trackLifecycleOperation(Promise.reject(failure))).rejects.toBe(failure);
			const error = await manager.shutdown().then(
				() => undefined,
				(reason: unknown) => reason,
			);
			expect(error).toBeInstanceOf(WorkerCleanupError);
			expect((error as WorkerCleanupError).handle).toBe(handle);
			expect(stops).toBe(1);
			await expect(manager.shutdown()).rejects.toBeInstanceOf(WorkerCleanupError);
			exit.resolve(0);
			await handle.exited;
			await expect(manager.shutdown()).resolves.toBeUndefined();
		} finally {
			exit.resolve(0);
			await handle.exited;
			await manager.shutdown();
		}
	});

	test.each([
		false,
		true,
	])("production frame options preserve ordinary and mixed plugins (%s)", async (mixed) => {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const settle = trackRuntimeLifecycle(manager);
		try {
			const source = await makePackage(root, `com.example.frames-${mixed}`, (manifest) => {
				if (!mixed) return;
				const contributes = manifest.contributes as Record<string, unknown>;
				contributes.tools = [
					{
						id: "echo",
						title: "Echo",
						execution: "server",
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
					},
				];
				contributes.providers = [{ id: "model", title: "Model" }];
				(manifest.permissions as Record<string, unknown>).host = [
					"provider.register",
					"provider.use",
				];
			});
			const installed = await manager.install(source);
			await manager.enable(installed.pluginId);
			await manager.activate(installed.pluginId);
			const options = supervisor.get(installed.pluginId)?.options;
			expect(options).toBeDefined();
			expect(options?.maxFrameBytes).toBe(mixed ? PLUGIN_TOOL_OUTPUT_FRAME_MAX_BYTES : undefined);
			expect(options?.maxOutboundFrameBytes).toBe(mixed ? PROVIDER_REQUEST_MAX_BYTES : undefined);
		} finally {
			await manager.shutdown();
			await settle();
		}
	});

	test("canonicalizes an aliased temporary parent before scanning fixture packages", async () => {
		const parent = await makeTempRoot();
		const actual = join(parent, "actual");
		const alias = join(parent, "temp-alias");
		await mkdir(actual);
		await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
		const root = await makeTempRoot(alias);
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const installed = await manager.install(await makePackage(root, "com.example.temp-alias"));
		expect(installed.compatibility).toBe("compatible");
		expect(root).toBe(await realpath(root));
		expect(root.startsWith(actual)).toBe(true);
		await manager.enable(installed.pluginId);
		expect((await manager.getStatus(installed.pluginId))?.desiredState).toBe("enabled");
		expect(supervisor.startCount.size).toBe(0);
	});

	// This exercises production catalog compatibility decisions for every host OS,
	// not native filesystem/runner behavior (the hosted matrix covers those).
	test.each([
		"linux",
		"darwin",
		"win32",
	] as const)("fixture manifests support the %s host and still reject a different OS", async (hostOS) => {
		const root = await makeTempRoot();
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		if (!original) throw new Error("Missing process.platform descriptor");
		try {
			Object.defineProperty(process, "platform", { ...original, value: hostOS });
			const supervisor = new FakeSupervisor();
			const manager = makeManager({
				root: join(root, "plugins"),
				disabled: false,
				runtimeSupervisor: supervisor,
			});
			const matching = await makePackage(root, `com.example.matching-${hostOS}`);
			const manifest = JSON.parse(await readFile(join(matching, "manifest.json"), "utf8"));
			expect(manifest.engine.os).toEqual([hostOS]);
			expect(manifest.engine.arch).toEqual([process.arch]);
			const installed = await manager.install(matching);
			expect(installed.compatibility).toBe("compatible");
			await manager.enable(installed.pluginId);
			expect((await manager.getStatus(installed.pluginId))?.desiredState).toBe("enabled");
			const mismatching = await makePackage(
				root,
				`com.example.mismatching-${hostOS}`,
				(manifest) => {
					(manifest.engine as Record<string, unknown>).os = [
						hostOS === "linux" ? "darwin" : "linux",
					];
				},
			);
			const incompatible = await manager.install(mismatching);
			expect(incompatible.compatibility).toBe("incompatible");
			await expect(manager.enable(incompatible.pluginId)).rejects.toMatchObject({
				code: "PLUGIN_INCOMPATIBLE",
			});
			expect((await manager.getStatus(incompatible.pluginId))?.desiredState).toBe("disabled");
			expect(supervisor.startCount.size).toBe(0);
		} finally {
			Object.defineProperty(process, "platform", original);
		}
	});

	test("the production singleton wires the shared provider catalog refresher", () => {
		// Injection-based lifecycle tests explicitly supply this dependency. The exported
		// singleton also injects services, so it does NOT take the constructor's shared-default
		// branch; omitting this one dependency leaves real startup catalogs empty.
		const production = pluginManager as unknown as { providerCatalogRefresher?: unknown };
		expect(production.providerCatalogRefresher).toBe(
			pluginPlatformServices.providerCatalogRefresher,
		);
	});

	test("installs without executing entry and supports idempotent lifecycle operations", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const source = await makePackage(root, "com.example.lifecycle");
		const supervisor = new FakeSupervisor();
		const revokedUiSessions: string[] = [];
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: supervisor,
			revokeUiSessions: (pluginId) => {
				revokedUiSessions.push(pluginId);
			},
		});

		const installed = await manager.install(source);
		if (!installed.current) throw new Error("Installed plugin has no current package");
		// Authorization is keyed by the stable UUID identity, never the package
		// hash (a hash-keyed record would never be consulted by the runtime).
		const permissionSet = await manager.getPermissions(installed.pluginId);
		const authorityId = pluginInstallationAuthorityId(
			installed.pluginId,
			permissionSet.installationId,
		);
		expect(installed.desiredState).toBe("disabled");
		expect(installed.runtimeState).toBe("inactive");
		expect(supervisor.startCount.size).toBe(0);

		await manager.enable(installed.pluginId);
		await manager.enable(installed.pluginId);
		expect((await manager.getStatus(installed.pluginId))?.desiredState).toBe("enabled");
		expect(
			(await manager.stateStore.listOperations(installed.pluginId)).filter(
				(operation) => operation.operation === "enable",
			),
		).toHaveLength(1);

		const active = await manager.activate(installed.pluginId);
		expect(active.runtimeState).toBe("active");
		expect(active.runtimeGeneration).toBe(1);
		expect(supervisor.startCount.get(installed.pluginId)).toBe(1);
		expect(supervisor.get(installed.pluginId)?.options.packageDigest).toBe(installed.current?.hash);
		await manager.activate(installed.pluginId);
		expect(supervisor.startCount.get(installed.pluginId)).toBe(1);

		await manager.disable(installed.pluginId);
		await manager.disable(installed.pluginId);
		expect((await manager.getStatus(installed.pluginId))?.desiredState).toBe("disabled");
		expect((await manager.getStatus(installed.pluginId))?.runtimeState).toBe("inactive");
		expect(supervisor.disableCount.get(installed.pluginId)).toBe(1);
		expect(revokedUiSessions).toEqual([installed.pluginId]);

		await manager.uninstall(installed.pluginId);
		await manager.uninstall(installed.pluginId);
		expect((await integrationAuthorityService.requireSnapshot(authorityId)).authority.state).toBe(
			"revoked",
		);
		expect(revokedUiSessions).toEqual([installed.pluginId, installed.pluginId]);
		expect(await manager.getStatus(installed.pluginId)).toBeUndefined();
		expect((await manager.packageStore.readCurrent()).plugins[installed.pluginId]).toBeUndefined();
		expect((await manager.stateStore.listOperations(installed.pluginId)).at(-1)?.status).toBe(
			"succeeded",
		);

		const reinstalled = await manager.install(source);
		expect(reinstalled.current).toEqual(installed.current);
		expect(reinstalled.authorityInstallationId).toBeTruthy();
		expect(reinstalled.authorityInstallationId).not.toBe(installed.current.hash);
		const replacementAuthorityId = pluginInstallationAuthorityId(
			reinstalled.pluginId,
			reinstalled.authorityInstallationId as string,
		);
		expect((await integrationAuthorityService.requireSnapshot(authorityId)).authority.state).toBe(
			"revoked",
		);
		expect(
			(await integrationAuthorityService.requireSnapshot(replacementAuthorityId)).authority.state,
		).toBe("active");
		expect(
			(await manager.list()).filter((item) => item.pluginId === installed.pluginId),
		).toHaveLength(1);

		const repeated = await manager.install(source);
		expect(repeated.authorityInstallationId).toBe(reinstalled.authorityInstallationId);
		expect(
			(await manager.list()).filter((item) => item.pluginId === installed.pluginId),
		).toHaveLength(1);
	});

	test("binds each runtime generation and refreshes or revokes access with grant lifecycle changes", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.runtime-binding";
		const supervisor = new FakeSupervisor();
		const stateStore = new PluginStateStore(storeRoot);
		const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
		const unsafeDispatcher = new PluginHostDispatcher({
			identity: {
				pluginId,
				runtimeId: "unsafe-runtime",
				runtimeGeneration: 0,
			},
			methods: {
				unsafe: { method: "unsafe", handler: async () => ({ allowed: true }) },
			},
		});
		const platform = createPluginPlatformServices({
			runtimeSupervisor: supervisor as never,
			stateStore,
			permissionStore,
			capabilityBroker,
			hostServices,
		});
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			permissionStore,
			hostServices,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: async (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				packageDigest: context.package.hash,
				command: ["fake-runtime"],
				cwd: context.packagePath,
				dispatcher: unsafeDispatcher,
			}),
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});
		const source = await makePackage(root, pluginId, (manifest) => {
			const permissions = manifest.permissions as Record<string, unknown>;
			permissions.host = ["diagnostics.readOwnLogs"];
		});
		const installed = await manager.install(source);
		if (!installed.current) throw new Error("Installed plugin has no current package");
		const granted = await manager.replacePermissions(pluginId, {
			expectedRevision: 1,
			grantedBy: "admin-user-1",
			grants: [
				{
					grantId: "grant-diagnostics",
					capability: "diagnostics.readOwnLogs",
					scope: { type: "global" },
					grantedBy: "admin-user-1",
				},
			],
		});
		expect(granted.permissions.revision).toBe(2);
		// replacePermissions already lazily migrated the identity to a stable UUID.
		const migratedUuid = granted.permissions.installationId;
		expect(migratedUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		const mirrorBeforeEdit = await permissionStore.getSet(pluginId, migratedUuid);
		expect(mirrorBeforeEdit.authorityRevision).toBe(2);
		await permissionStore.replace(pluginId, migratedUuid, [], {
			expectedRevision: mirrorBeforeEdit.revision,
			grantedBy: "legacy-file-editor",
		});
		expect((await permissionStore.getSet(pluginId, migratedUuid)).grants).toEqual([]);

		await manager.enable(pluginId);
		const active = await manager.activate(pluginId);
		const runtime = supervisor.get(pluginId);
		if (!runtime) throw new Error("Runtime was not registered");
		expect(active.runtimeGeneration).toBe(1);
		expect(runtime.options.generation).toBe(0);
		expect(runtime.generation).toBe(1);
		expect(runtime.options.dispatcher).not.toBe(unsafeDispatcher);
		const binding = hostServices.getRuntimeBinding(pluginId, runtime.runtimeId);
		expect(binding).toMatchObject({
			plugin: {
				pluginId,
				installationId: migratedUuid,
				runtimeId: runtime.runtimeId,
				runtimeGeneration: 1,
			},
			grantRevision: 2,
		});
		expect(capabilityBroker.hasBinding(pluginId, runtime.runtimeId)).toBe(true);
		if (!binding) throw new Error("Runtime binding was not created");
		const allowed = await binding.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "diagnostics-before-revoke",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect("result" in allowed).toBe(true);

		hostServices.revokeRuntime(pluginId, runtime.runtimeId);
		const healed = await manager.replacePermissions(pluginId, {
			expectedRevision: 2,
			grantedBy: "admin-user-1",
			grants: [
				{
					grantId: "grant-diagnostics",
					capability: "diagnostics.readOwnLogs",
					scope: { type: "global" },
					grantedBy: "admin-user-1",
				},
			],
		});
		expect(healed.permissions.revision).toBe(2);
		expect(hostServices.getRuntimeBinding(pluginId, runtime.runtimeId)?.dispatcher).toBe(
			binding.dispatcher,
		);

		await expect(
			manager.replacePermissions(pluginId, {
				expectedRevision: 1,
				grantedBy: "stale-admin",
				grants: [],
			}),
		).rejects.toMatchObject({ code: "PERMISSION_REVISION_CONFLICT" });
		const revoked = await manager.revokePermissions(pluginId, {
			expectedRevision: 2,
			grantedBy: "admin-user-1",
			grantIds: ["grant-diagnostics"],
		});
		expect(revoked.permissions).toMatchObject({ revision: 3, grants: [] });
		const refreshed = hostServices.getRuntimeBinding(pluginId, runtime.runtimeId);
		expect(refreshed?.grantRevision).toBe(3);
		expect(refreshed?.dispatcher).toBe(binding.dispatcher);
		const runtimeDispatcher = runtime.options.dispatcher;
		if (!runtimeDispatcher) throw new Error("Runtime dispatcher was not injected");
		expect(runtimeDispatcher).toBe(binding.dispatcher);
		const denied = await binding.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "diagnostics-after-revoke",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect("error" in denied).toBe(true);

		await manager.disable(pluginId);
		expect(hostServices.hasRuntimeBinding(pluginId, runtime.runtimeId)).toBe(false);
		expect(capabilityBroker.hasBinding(pluginId, runtime.runtimeId)).toBe(false);
		await manager.uninstall(pluginId);
		expect(await permissionStore.listSets(pluginId)).toEqual([]);
	});

	test("grants the capabilities a Manifest declares when an installation first binds", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.seeded-grants";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const source = await makePackage(root, pluginId, (manifest) => {
			const permissions = manifest.permissions as Record<string, unknown>;
			permissions.host = ["diagnostics.readOwnLogs", "query.read.projects"];
		});
		await manager.install(source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);

		// Installing is the trust decision, so the declared capabilities arrive granted
		// instead of waiting for a separate approval step.
		const permissions = await manager.getPermissions(pluginId);
		expect(permissions.grants.map((grant) => grant.capability).sort()).toEqual([
			"diagnostics.readOwnLogs",
			"query.read.projects",
		]);
	});

	/**
	 * Declaring a wide capability must not break installation.
	 *
	 * `capabilitySchema` accepts open tokens (`admin`, `*`, `network.any`, vendor names), but
	 * a grant has to be expressible in the authority kernel, which is keyed by
	 * `PLUGIN_CAPABILITY_ADAPTER`. Seeding an unmappable token used to reach
	 * `toAuthorityGrants()`, which threw `IntegrationAuthorityConflictError`, so the *install*
	 * failed with a 409 worded in internal terms — the parse-layer relaxation never reached the
	 * path that matters. Seeding now filters, so the declaration parses, produces no grant, and
	 * leaves the broker fail-closed at call time.
	 */
	test("installs a plugin declaring wide capabilities without granting the unmappable ones", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.wide-permission";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const source = await makePackage(root, pluginId, (manifest) => {
			const permissions = manifest.permissions as Record<string, unknown>;
			permissions.host = [
				"admin",
				"*",
				"network.any",
				"com.acme.custom.thing",
				"diagnostics.readOwnLogs",
				"query.read.projects",
			];
		});

		// The install itself is the regression: this threw before the seed filter existed.
		const installed = await manager.install(source);
		if (!installed.current) throw new Error("Installed plugin has no current package");
		await manager.enable(pluginId);
		await manager.activate(pluginId);

		// Mappable declarations still arrive granted; the wide tokens produce nothing at all,
		// so there is no grant for the broker to match and no phantom authority row.
		const permissions = await manager.getPermissions(pluginId);
		const granted = permissions.grants.map((grant) => grant.capability).sort();
		expect(granted).toEqual(["diagnostics.readOwnLogs", "query.read.projects"]);
		for (const wide of ["admin", "*", "network.any", "com.acme.custom.thing"]) {
			expect(granted).not.toContain(wide);
		}
		expect(
			(await manager.getStatus(pluginId))?.grants?.capabilities?.includes("admin") ?? false,
		).toBe(false);
	});

	test("installs a plugin whose every declared capability is unmappable", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.only-wide";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const source = await makePackage(root, pluginId, (manifest) => {
			const permissions = manifest.permissions as Record<string, unknown>;
			permissions.host = ["admin", "*"];
		});

		// The all-ignored case is the one that would leave `capabilities: []` with a non-zero
		// count if the filter forgot to bail out, so it gets its own assertion.
		await manager.install(source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		expect((await manager.getPermissions(pluginId)).grants).toEqual([]);
	});

	test("does not re-seed grants once an installation has a grant list", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.no-reseed";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const source = await makePackage(root, pluginId, (manifest) => {
			const permissions = manifest.permissions as Record<string, unknown>;
			permissions.host = ["diagnostics.readOwnLogs", "query.read.projects"];
		});
		await manager.install(source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);

		// Narrow the grants, the way an admin revoking one capability would.
		const seeded = await manager.getPermissions(pluginId);
		await manager.replacePermissions(pluginId, {
			expectedRevision: seeded.revision,
			grantedBy: "admin-user-1",
			grants: [
				{
					grantId: "grant-kept",
					capability: "diagnostics.readOwnLogs",
					scope: { type: "global" },
					grantedBy: "admin-user-1",
				},
			],
		});

		// Re-activating must not restore the removed capability. Seeding is a first-install
		// convenience; once a grant list exists it owns the answer, otherwise revocation
		// would be undone on every restart.
		await manager.deactivate(pluginId);
		await manager.activate(pluginId);
		const after = await manager.getPermissions(pluginId);
		expect(after.grants.map((grant) => grant.capability)).toEqual(["diagnostics.readOwnLogs"]);
	});

	test("copies complete grants to a new package without widening scope during upgrade", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.permission-upgrade";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await manager.install(await makePackage(root, pluginId));
		if (!installed.current) throw new Error("Installed plugin has no current package");
		const granted = await manager.replacePermissions(pluginId, {
			expectedRevision: 1,
			grantedBy: "admin-user-1",
			grants: [
				{
					grantId: "grant-upgrade-project",
					capability: "query.read.projects",
					scope: { type: "project", id: "project-1" },
					constraints: { fields: ["id"], resourceIds: ["project-1"] },
					expiresAt: "2026-08-18T12:00:00.000Z",
					grantedBy: "admin-user-1",
				},
			],
		});
		// Identity is a stable UUID from the first grant operation; upgrades never
		// change it, so grants survive the package hash change below.
		const stableUuid = granted.permissions.installationId;
		const upgraded = await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				manifest.version = "2.0.0";
			}),
		);
		if (!upgraded.current) throw new Error("Upgraded plugin has no current package");
		expect(upgraded.current.hash).not.toBe(installed.current.hash);
		const permissions = await manager.getPermissions(pluginId);
		expect(permissions).toMatchObject({
			installationId: stableUuid,
			revision: 2,
			grants: [
				{
					grantId: "grant-upgrade-project",
					capability: "query.read.projects",
					scope: { type: "project", id: "project-1" },
					constraints: { fields: ["id"], resourceIds: ["project-1"] },
					expiresAt: "2026-08-18T12:00:00.000Z",
					grantedBy: "admin-user-1",
					revision: 2,
				},
			],
		});
		// The legacy hash set may linger for back-compat, but the active UUID set
		// must carry the complete grants after the upgrade.
		const sets = await manager.permissionStore.listSets(pluginId);
		expect(sets.some((set) => set.installationId === stableUuid)).toBe(true);
		expect(
			sets.find((set) => set.installationId === stableUuid)?.grants.map((g) => g.capability),
		).toContain("query.read.projects");
	});

	test("withholds newly-declared capabilities on upgrade and queues them for approval", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.upgrade-new-capability";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
			}),
		);
		if (!installed.current) throw new Error("Installed plugin has no current package");
		await manager.replacePermissions(pluginId, {
			expectedRevision: 1,
			grantedBy: "admin-user-1",
			grants: [
				{
					grantId: "grant-logs",
					capability: "diagnostics.readOwnLogs",
					scope: { type: "global" },
					grantedBy: "admin-user-1",
				},
			],
		});
		const before = await manager.getPermissions(pluginId);
		const stableUuid = before.installationId;
		expect(before.grants.map((g) => g.capability)).toEqual(["diagnostics.readOwnLogs"]);

		// The new manifest declares a capability that was never granted. Because the
		// installation identity is stable, the upgrade inherits the old grants — so the
		// added capability must NOT ride in on that inheritance. It is withheld and
		// queued for approval; the upgrade itself still succeeds.
		const upgraded = await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				manifest.version = "2.0.0";
				(manifest.permissions as Record<string, unknown>).host = [
					"diagnostics.readOwnLogs",
					"query.read.projects",
				];
			}),
		);
		if (!upgraded.current) throw new Error("Upgraded plugin has no current package");
		expect(upgraded.current.version).toBe("2.0.0");

		const after = await manager.getPermissions(pluginId);
		expect(after.installationId).toBe(stableUuid);
		// Only the previously approved capability is granted, with its grant identity
		// intact — the upgrade neither widened nor rewrote it.
		expect(after.grants.map((g) => g.capability)).toEqual(["diagnostics.readOwnLogs"]);
		expect(after.grants.find((g) => g.capability === "diagnostics.readOwnLogs")?.grantId).toBe(
			"grant-logs",
		);

		const pending = await manager.listPendingPermissionRequests(pluginId);
		expect(pending.map((req) => req.capability)).toEqual(["query.read.projects"]);
		const request = pending[0];
		if (!request) throw new Error("Upgrade did not queue an approval request");
		expect(request.source).toBe("upgrade");
		expect(request.requestedForVersion).toBe("2.0.0");
		expect(request.status).toBe("pending");

		// Approving the request is what finally grants it, attributed to the admin who
		// decided — not to "system".
		await manager.approvePermissionRequest(pluginId, request.requestId, "admin-user-1");
		const approved = await manager.getPermissions(pluginId);
		expect(approved.grants.map((g) => g.capability).sort()).toEqual([
			"diagnostics.readOwnLogs",
			"query.read.projects",
		]);
		expect(approved.grants.find((g) => g.capability === "query.read.projects")?.grantedBy).toBe(
			"admin-user-1",
		);
		expect(await manager.listPendingPermissionRequests(pluginId)).toHaveLength(0);
	});

	test("denying an upgrade capability leaves the upgrade in place without the grant", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.upgrade-denied-capability";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
			}),
		);
		const upgraded = await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				manifest.version = "2.0.0";
				(manifest.permissions as Record<string, unknown>).host = [
					"diagnostics.readOwnLogs",
					"query.read.projects",
				];
			}),
		);
		const pending = await manager.listPendingPermissionRequests(pluginId);
		expect(pending).toHaveLength(1);
		const request = pending[0];
		if (!request) throw new Error("Upgrade did not queue an approval request");

		expect(await manager.denyPermissionRequest(pluginId, request.requestId)).toBeTruthy();

		// The chosen semantics: a denial costs the plugin one capability, not the whole
		// update. The new version stays installed and everything previously approved
		// keeps working.
		expect((await manager.getStatus(pluginId))?.current?.version).toBe("2.0.0");
		expect(upgraded.current?.version).toBe("2.0.0");
		const after = await manager.getPermissions(pluginId);
		expect(after.grants.map((g) => g.capability)).toEqual(["diagnostics.readOwnLogs"]);
		expect(await manager.listPendingPermissionRequests(pluginId)).toHaveLength(0);
	});

	test("re-running the same upgrade does not stack duplicate approval requests", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.upgrade-idempotent-request";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
			}),
		);
		const upgradeManifest = (manifest: Record<string, unknown>) => {
			manifest.version = "2.0.0";
			(manifest.permissions as Record<string, unknown>).host = [
				"diagnostics.readOwnLogs",
				"query.read.projects",
			];
		};
		await manager.install(await makePackage(root, pluginId, upgradeManifest));
		const first = await manager.listPendingPermissionRequests(pluginId);
		expect(first).toHaveLength(1);

		// Reinstalling the same version must not queue a second row for the same
		// (capability, scope): the pending list is the admin's to-do list, and a
		// re-install is not a new decision.
		await manager.install(await makePackage(root, pluginId, upgradeManifest));
		const second = await manager.listPendingPermissionRequests(pluginId);
		expect(second).toHaveLength(1);
		expect(second[0]?.requestId).toBe(first[0]?.requestId);
	});

	test("a first install still auto-grants its declared capabilities", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.first-install-seeds";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		// Installing is the trust decision, so a FIRST install is unchanged: declared
		// capabilities are granted and nothing waits for approval. Only upgrades are
		// fail-closed.
		await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				(manifest.permissions as Record<string, unknown>).host = [
					"diagnostics.readOwnLogs",
					"query.read.projects",
				];
			}),
		);
		const permissions = await manager.getPermissions(pluginId);
		expect(permissions.grants.map((g) => g.capability).sort()).toEqual([
			"diagnostics.readOwnLogs",
			"query.read.projects",
		]);
		expect(await manager.listPendingPermissionRequests(pluginId)).toHaveLength(0);
	});

	test("rejects enabling a package whose compatibility becomes unknown", async () => {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const installed = await manager.install(await makePackage(root, "com.example.unknown"));
		expect(installed.compatibility).toBe("compatible");
		if (!installed.current) throw new Error("Installed plugin has no current package");
		await writeFile(
			join(
				manager.root,
				"packages",
				installed.pluginId,
				installed.current.version,
				installed.current.hash,
				"manifest.json",
			),
			"{",
		);
		await expect(manager.enable(installed.pluginId)).rejects.toMatchObject({
			code: "PLUGIN_INCOMPATIBLE",
		});
		const status = await manager.getStatus(installed.pluginId);
		expect(status?.packageStatus).toBe("corrupt");
		expect(status?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"MANIFEST_INVALID_JSON",
		);
		expect(status?.desiredState).toBe("disabled");
		expect(supervisor.startCount.size).toBe(0);
	});

	test("rejects enabling an incompatible package", async () => {
		const root = await makeTempRoot();
		const source = await makePackage(root, "com.example.incompatible", (manifest) => {
			const engine = manifest.engine as Record<string, unknown>;
			engine.os = [process.platform === "linux" ? "darwin" : "linux"];
		});
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await manager.install(source);

		expect(installed.compatibility).toBe("incompatible");
		await expect(manager.enable(installed.pluginId)).rejects.toMatchObject({
			code: "PLUGIN_INCOMPATIBLE",
		});
		expect((await manager.getStatus(installed.pluginId))?.desiredState).toBe("disabled");
	});

	test("quarantines a failed plugin without blocking another plugin", async () => {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const pluginA = await manager.install(await makePackage(root, "com.example.failurea"));
		const pluginB = await manager.install(await makePackage(root, "com.example.failureb"));
		await Promise.all([manager.enable(pluginA.pluginId), manager.enable(pluginB.pluginId)]);
		supervisor.failures.add(pluginA.pluginId);

		await expect(manager.activate(pluginA.pluginId)).rejects.toThrow("handshake failure");
		const statusA = await manager.getStatus(pluginA.pluginId);
		expect(statusA?.runtimeState).toBe("quarantine");
		expect(statusA?.crashCount).toBeGreaterThan(0);
		expect(statusA?.lastError?.code).toBe("HELLO_PLUGIN_ID_MISMATCH");

		const statusB = await manager.activate(pluginB.pluginId);
		expect(statusB.runtimeState).toBe("active");
		expect(supervisor.startCount.get(pluginB.pluginId)).toBe(1);
	});

	test("serializes one plugin while allowing another plugin to activate in parallel", async () => {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const pluginA = await manager.install(await makePackage(root, "com.example.concurrencya"));
		const pluginB = await manager.install(await makePackage(root, "com.example.concurrencyb"));
		await Promise.all([manager.enable(pluginA.pluginId), manager.enable(pluginB.pluginId)]);
		const gate = supervisor.gate(pluginA.pluginId);
		const activations = [manager.activate(pluginA.pluginId)];
		let draining: Promise<void> | undefined;
		const drain = () =>
			(draining ??= (async () => {
				gate.release();
				await Promise.allSettled(activations);
			})());
		drainBeforeCleanup.push(drain);
		try {
			await gate.entered;
			activations.push(manager.activate(pluginA.pluginId));
			expect(supervisor.startCount.get(pluginA.pluginId)).toBe(1);
			const activatingB = manager.activate(pluginB.pluginId);
			activations.push(activatingB);
			// B must finish while A's gate is still held; this tests independence,
			// not whether real Windows journal IO finishes inside an arbitrary 250ms.
			const statusB = await activatingB;
			expect(statusB.runtimeState).toBe("active");
			gate.release();
			const [statusA1, statusA2] = await Promise.all(activations.slice(0, 2));
			expect(statusA1?.runtimeState).toBe("active");
			expect(statusA2?.runtimeState).toBe("active");
			expect(supervisor.startCount.get(pluginA.pluginId)).toBe(1);
		} finally {
			await drain();
		}
	});

	test("isolates a revoked residual plugin during initialization", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const first = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const badSource = await makePackage(root, "com.example.revoked-residual");
		const bad = await first.install(badSource);
		const healthy = await first.install(await makePackage(root, "com.example.healthy-residual"));
		if (!bad.current || !healthy.current) throw new Error("Installed plugin has no package");
		await first.uninstall(bad.pluginId);

		const residual = await first.packageStore.install(badSource);
		await first.stateStore.updateState(bad.pluginId, {
			current: { version: residual.version, hash: residual.hash },
			authorityInstallationId: residual.hash,
			desiredState: "enabled",
			compatibility: "compatible",
			runtimeState: "inactive",
		});

		const recovered = makeManager({
			root: storeRoot,
			disabled: true,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await expect(recovered.initialize()).resolves.toBeDefined();
		const badStatus = await recovered.getStatus(bad.pluginId);
		expect(badStatus).toMatchObject({
			desiredState: "disabled",
			runtimeState: "failed",
			lastError: { code: "INTEGRATION_AUTHORITY_CONFLICT" },
		});
		const healthyStatus = await recovered.getStatus(healthy.pluginId);
		expect(healthyStatus?.lastError?.code).not.toBe("INTEGRATION_AUTHORITY_CONFLICT");
		expect(healthyStatus?.current).toEqual(healthy.current);
	});

	test("rebuilds enabled onStartup providers and refreshes catalogs after activation on restart", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.startup-catalog";
		const disabledId = "com.example.disabled-startup";
		const first = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		for (const id of [pluginId, disabledId]) {
			await first.install(
				await makePackage(root, id, (manifest) => {
					manifest.activationEvents = ["onStartup"];
				}),
			);
		}
		await first.enable(pluginId);
		await first.shutdown();
		const supervisor = new FakeSupervisor();
		const refreshStates: Array<RuntimeState | undefined> = [];
		const recovered = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: supervisor,
			providerCatalogRefresher: {
				refreshStale: async () => {
					refreshStates.push(supervisor.get(pluginId)?.state);
					return [];
				},
			},
		});
		try {
			await recovered.initialize();
			expect((await recovered.getStatus(pluginId))?.runtimeState).toBe("active");
			expect(supervisor.startCount.get(pluginId)).toBe(1);
			expect(supervisor.startCount.get(disabledId)).toBeUndefined();
			expect(refreshStates).toEqual(["active"]);
			await recovered.initialize();
			expect(refreshStates).toHaveLength(1);
		} finally {
			await recovered.shutdown();
		}
	});

	test("recovers incomplete journal operations by disabling automatic activation", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const first = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await first.install(await makePackage(root, "com.example.recovery"));
		await first.enable(installed.pluginId);
		await first.stateStore.updateState(installed.pluginId, { runtimeState: "starting" });
		const interrupted = await first.stateStore.beginOperation({
			pluginId: installed.pluginId,
			operation: "activate",
			status: "running",
		});

		const recovered = makeManager({
			root: storeRoot,
			disabled: true,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await recovered.initialize();
		const status = await recovered.getStatus(installed.pluginId);
		expect(status?.desiredState).toBe("disabled");
		expect(status?.runtimeState).toBe("inactive");
		expect(status?.lastError?.code).toBe("PLUGIN_OPERATION_RECOVERED");
		expect((await recovered.stateStore.getOperation(interrupted.id))?.status).toBe("failed");
	});

	test("restores an interrupted upgrade pointer and removes stale staging on restart", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.upgrade-recovery";
		const first = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await first.install(await makePackage(root, pluginId));
		if (!installed.current) throw new Error("Installed plugin has no current package");
		const upgradeSource = await makePackage(root, pluginId, (manifest) => {
			manifest.version = "2.0.0";
		});
		const candidate = await first.packageStore.install(upgradeSource);
		const interrupted = await first.stateStore.beginOperation({
			pluginId,
			operation: "upgrade",
			status: "running",
			context: {
				from: installed.current,
				to: { version: candidate.version, hash: candidate.hash },
			},
		});
		await mkdir(join(storeRoot, "staging", "interrupted-upgrade"), { recursive: true });
		await writeFile(join(storeRoot, "staging", "interrupted-upgrade", "leftover"), "stale");

		const recovered = makeManager({
			root: storeRoot,
			disabled: true,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await recovered.initialize();
		expect((await recovered.packageStore.readCurrent()).plugins[pluginId]).toEqual(
			installed.current,
		);
		expect((await recovered.stateStore.getOperation(interrupted.id))?.status).toBe("rolled_back");
		expect(await readdir(join(storeRoot, "staging"))).toEqual([]);
	});

	test("removes a pointer created by an interrupted first install on restart", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.install-recovery";
		const first = makeManager({
			root: storeRoot,
			disabled: true,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await first.initialize();
		const candidate = await first.packageStore.install(await makePackage(root, pluginId));
		const interrupted = await first.stateStore.beginOperation({
			pluginId,
			operation: "install",
			status: "running",
			context: {
				from: null,
				to: { version: candidate.version, hash: candidate.hash },
			},
		});

		const recovered = makeManager({
			root: storeRoot,
			disabled: true,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await recovered.initialize();
		expect((await recovered.packageStore.readCurrent()).plugins[pluginId]).toBeUndefined();
		expect((await recovered.stateStore.getOperation(interrupted.id))?.status).toBe("rolled_back");
	});

	test("selects LocalProcessRunner or PodmanRunner from manifest.engine.runner", async () => {
		const root = await makeTempRoot();
		const localSupervisor = new FakeSupervisor();
		const localManager = makeManager({
			root: join(root, "local-plugins"),
			disabled: false,
			runtimeSupervisor: localSupervisor,
		});
		const local = await localManager.install(await makePackage(root, "com.example.local-runner"));
		await localManager.enable(local.pluginId);
		await localManager.activate(local.pluginId);
		expect(localSupervisor.get(local.pluginId)?.options.runner).toBeInstanceOf(LocalProcessRunner);

		const podmanSupervisor = new FakeSupervisor();
		const podmanManager = makeManager({
			root: join(root, "podman-plugins"),
			disabled: false,
			runtimeSupervisor: podmanSupervisor,
			podman: { image: "nf/plugin", imageDigest: "sha256:abc", options: { available: true } },
		});
		const podman = await podmanManager.install(
			await makePackage(root, "com.example.podman-runner", (manifest) => {
				(manifest.engine as Record<string, unknown>).runner = "podman";
			}),
		);
		await podmanManager.enable(podman.pluginId);
		await podmanManager.activate(podman.pluginId);
		expect(podmanSupervisor.get(podman.pluginId)?.options.runner).toBeInstanceOf(PodmanRunner);

		const unavailableSupervisor = new FakeSupervisor();
		const unavailableManager = makeManager({
			root: join(root, "unavailable-plugins"),
			disabled: false,
			runtimeSupervisor: unavailableSupervisor,
			podman: { image: "nf/plugin", imageDigest: "sha256:abc", options: { available: false } },
		});
		const unavailable = await unavailableManager.install(
			await makePackage(root, "com.example.podman-unavailable", (manifest) => {
				(manifest.engine as Record<string, unknown>).runner = "podman";
			}),
		);
		await unavailableManager.enable(unavailable.pluginId);
		await expect(unavailableManager.activate(unavailable.pluginId)).rejects.toMatchObject({
			code: "PLUGIN_RUNNER_UNAVAILABLE",
		});
	}, 15_000);

	test("activates an unsigned package under a trust policy that does not require a signature", async () => {
		// Used to assert the opposite. A `trustTier === "T3"` check refused activation whenever
		// a trust policy was enabled, and since install always produced T3 with no route to
		// raise it, enabling the policy meant no plugin could activate at all. The tier axis is
		// gone; an enabled policy now only enforces what it can actually read from the package.
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
			trustPolicy: { enabled: true },
		});
		const installed = await manager.install(await makePackage(root, "com.example.unsigned"));
		await manager.enable(installed.pluginId);
		const active = await manager.activate(installed.pluginId);
		expect(active.runtimeState).toBe("active");
	}, 15_000);

	test("fails closed when the trust policy requires a signature", async () => {
		const root = await makeTempRoot();
		const requiredSignature = makeManager({
			root: join(root, "required-signature"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			trustPolicy: { enabled: true, requireSignature: true },
		});
		await expect(
			requiredSignature.install(await makePackage(root, "com.example.signature-required")),
		).rejects.toMatchObject({ code: "PLUGIN_SIGNATURE_REQUIRED" });
	}, 15_000);

	test.each([
		"install",
		"source-update",
	] as const)("rechecks signed keys after delayed %s journals before publication", async (kind) => {
		const root = await makeTempRoot();
		const pluginId = `com.example.signed-journal-${kind}`;
		const signer = packageSigner(pluginId);
		let fixture = await makeBundledFixture(root, pluginId, "1.0.0", (source) =>
			signer.sign(source, "1.0.0"),
		);
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
			trustPolicy: { enabled: true, requireSignature: true, keyring: signer.keyring },
		});
		let updateOptions: Parameters<PluginManager["updateFromSource"]>[1] | undefined;
		if (kind === "source-update") {
			const installed = await manager.install(new File([fixture.bytes], "signed.nfplugin"));
			if (!installed.current || !installed.installationId)
				throw new Error("Signed installation did not persist its identity");
			const binding = await manager.setSource(
				pluginId,
				{ type: "github", owner: "fixture", repo: "signed", assetName: "signed.nfplugin" },
				{ expectedRevision: 0 },
			);
			updateOptions = {
				pluginId,
				expectedCurrent: installed.current,
				expectedInstallationId: installed.installationId,
				expectedSourceRevision: binding.binding.revision,
				expectedVersion: "2.0.0",
				automatic: false,
			};
			fixture = await makeBundledFixture(root, pluginId, "2.0.0", (source) =>
				signer.sign(source, "2.0.0"),
			);
		}
		const previous = (await manager.packageStore.readCurrent()).plugins[pluginId];
		const entered = deferred();
		const release = deferred();
		let journalId = "";
		const originalJournal = manager.stateStore.beginOperation.bind(manager.stateStore);
		const journal = spyOn(manager.stateStore, "beginOperation").mockImplementation(
			async (input) => {
				const result = await originalJournal(input);
				if (input.operation === (kind === "install" ? "install" : "upgrade")) {
					journalId = result.id;
					entered.resolve();
					await release.promise;
				}
				return result;
			},
		);
		const commits = spyOn(manager.packageStore, "setCurrent");
		const work = (
			updateOptions
				? manager.updateFromSource(fixture.source, updateOptions)
				: manager.install(new File([fixture.bytes], "signed.nfplugin"))
		).then(
			() => new Error("Revoked signed package was published"),
			(error: unknown) => error,
		);
		try {
			// Both paths have completed real Worker verification before creating this journal.
			await entered.promise;
			signer.key.revokedAt = new Date().toISOString();
			release.resolve();
			expect(await work).toMatchObject({ code: "PLUGIN_SIGNATURE_UNTRUSTED", statusCode: 422 });
			expect(commits).not.toHaveBeenCalled();
			expect((await manager.packageStore.readCurrent()).plugins[pluginId]).toEqual(previous);
			expect((await manager.stateStore.getOperation(journalId))?.status).toBe("failed");
			expect(supervisor.get(pluginId)).toBeUndefined();
		} finally {
			release.resolve();
			await work;
			journal.mockRestore();
			commits.mockRestore();
		}
	}, 15_000);

	test("rechecks signed keys after delayed runtime options before starting a process", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.signed-runtime-options";
		const signer = packageSigner(pluginId);
		const fixture = await makeBundledFixture(root, pluginId, "1.0.0", (source) =>
			signer.sign(source, "1.0.0"),
		);
		const entered = deferred();
		const release = deferred();
		const supervisor = new RuntimeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
			trustPolicy: { enabled: true, requireSignature: true, keyring: signer.keyring },
			runtimeOptionsFactory: async (context) => {
				entered.resolve();
				await release.promise;
				return {
					pluginId: context.pluginId,
					pluginVersion: context.manifest.version,
					command: [
						process.execPath,
						join(import.meta.dir, "../../fixtures/plugins/runtime/fixture.ts"),
					],
					cwd: context.packagePath,
					runner: new LocalProcessRunner({
						allowedCwds: [context.packagePath],
						allowUnboundedResourceUsage: process.platform === "win32",
					}),
				};
			},
		});
		const installed = await manager.install(fixture.source);
		if (!installed.current) throw new Error("Missing installed package reference fixture");
		await manager.enable(pluginId);
		const starts = spyOn(supervisor, "start");
		const work = manager.activate(pluginId).then(
			() => new Error("Revoked signed plugin started"),
			(error: unknown) => error,
		);
		try {
			await entered.promise;
			signer.key.revokedAt = new Date().toISOString();
			release.resolve();
			expect(await work).toMatchObject({ code: "PLUGIN_SIGNATURE_UNTRUSTED", statusCode: 422 });
			expect(starts).not.toHaveBeenCalled();
			expect(supervisor.getDiagnostics()).toEqual([]);
			expect((await manager.packageStore.readCurrent()).plugins[pluginId]).toEqual(
				installed.current,
			);
			expect((await manager.stateStore.getState(pluginId))?.lastError?.code).toBe(
				"PLUGIN_SIGNATURE_UNTRUSTED",
			);
		} finally {
			release.resolve();
			await work;
			starts.mockRestore();
		}
	}, 15_000);

	test("a disabled trust policy preserves signed package activation with a revoked key", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.disabled-signed-trust";
		const signer = packageSigner(pluginId);
		const fixture = await makeBundledFixture(root, pluginId, "1.0.0", (source) =>
			signer.sign(source, "1.0.0"),
		);
		signer.key.revokedAt = new Date().toISOString();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			trustPolicy: { enabled: false, requireSignature: true, keyring: signer.keyring },
		});
		await manager.install(new File([fixture.bytes], "signed.nfplugin"));
		await manager.enable(pluginId);
		expect((await manager.activate(pluginId)).runtimeState).toBe("active");
	}, 15_000);

	test("ordinary installation and activation trust checks stay in owned Workers", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.worker-only-trust";
		let refuseWorker = false;
		let created = 0;
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			trustPolicy: { enabled: true },
			packageStageWorkerFactory: () => {
				created++;
				if (refuseWorker) throw new Error("package Worker creation unavailable");
				return new Worker(
					new URL("../../../server/services/plugin-package-stage-worker.ts", import.meta.url),
				);
			},
		});
		const hostInstall = spyOn(manager.packageStore, "install").mockImplementation(async () => {
			throw new Error("Package computation reached the host thread");
		});
		try {
			const source = await makePackage(root, pluginId);
			refuseWorker = true;
			await expect(manager.install(source)).rejects.toThrow("package Worker creation unavailable");
			expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
			expect(hostInstall).not.toHaveBeenCalled();
			refuseWorker = false;
			const installed = await manager.install(source);
			if (!installed.current) throw new Error("Missing installed package reference fixture");
			await manager.enable(pluginId);
			const pointer = (await manager.packageStore.readCurrent()).plugins[pluginId];
			const stagingBefore = await readdir(join(manager.root, "staging"));
			refuseWorker = true;
			await expect(manager.activate(pluginId)).rejects.toThrow(
				"package Worker creation unavailable",
			);
			expect(manager.runtimeSupervisor.get(pluginId)).toBeUndefined();
			expect((await manager.packageStore.readCurrent()).plugins[pluginId]).toEqual(pointer);
			refuseWorker = false;
			expect((await manager.activate(pluginId)).runtimeState).toBe("active");
			expect((await manager.packageStore.readCurrent()).plugins[pluginId]).toEqual(
				installed.current,
			);
			expect(await readdir(join(manager.root, "staging"))).toEqual(stagingBefore);
			expect(created).toBe(4);
			expect(hostInstall).not.toHaveBeenCalled();
		} finally {
			hostInstall.mockRestore();
		}
	}, 15_000);

	test("a changed installed data file blocks activation and repeated installation before any publish", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.installed-hash-check";
		const source = await makePackage(root, pluginId);
		await writeFile(join(source, "data.txt"), "original sample\n");
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
			trustPolicy: { enabled: true },
		});
		const installed = await manager.install(source);
		if (!installed.current) throw new Error("Missing package pointer");
		await manager.enable(pluginId);
		const grants = await manager.getPermissions(pluginId);
		const dataPath = join(
			manager.root,
			"packages",
			pluginId,
			installed.current.version,
			installed.current.hash,
			"data.txt",
		);
		await writeFile(dataPath, "modified sample\n");
		const starts = spyOn(supervisor, "start");
		const commits = spyOn(manager.packageStore, "setCurrent");
		try {
			await expect(manager.activate(pluginId)).rejects.toMatchObject({
				code: "PLUGIN_PACKAGE_HASH_MISMATCH",
				statusCode: 422,
			});
			await expect(manager.install(source)).rejects.toMatchObject({
				code: "PLUGIN_PACKAGE_HASH_MISMATCH",
				statusCode: 422,
			});
			expect(starts).not.toHaveBeenCalled();
			expect(commits).not.toHaveBeenCalled();
			expect((await manager.packageStore.readCurrent()).plugins[pluginId]).toEqual(
				installed.current,
			);
			expect(await manager.getPermissions(pluginId)).toEqual(grants);
			await writeFile(dataPath, "original sample\n");
			expect((await manager.activate(pluginId)).runtimeState).toBe("active");
			expect(starts).toHaveBeenCalledTimes(1);
		} finally {
			starts.mockRestore();
			commits.mockRestore();
		}
	}, 20_000);

	test("malformed archive uploads preserve input errors while Worker faults stay internal failures", async () => {
		const root = await makeTempRoot();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const malformed = await manager.install(new File(["not a zip"], "bad.nfplugin")).then(
			() => new Error("Malformed upload was accepted"),
			(error: unknown) => error,
		);
		expect(malformed).toBeInstanceOf(ValidationError);
		expect(malformed).toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
		expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
		const broken = makeManager({
			root: join(root, "worker-fault"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			packageStageWorkerFactory: () => {
				throw new Error("native Worker creation failed");
			},
		});
		const failure = await broken.install(new File(["not a zip"], "bad.nfplugin")).then(
			() => new Error("Worker failure was accepted"),
			(error: unknown) => error,
		);
		expect(failure).not.toBeInstanceOf(ValidationError);
		expect(failure).toMatchObject({ message: "native Worker creation failed" });
		expect((await broken.packageStore.readCurrent()).plugins).toEqual({});
	});

	test("keeps management queries available while the feature flag is disabled", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const enabled = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await enabled.install(await makePackage(root, "com.example.featureflag"));
		const disabled = makeManager({
			root: storeRoot,
			disabled: true,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await disabled.initialize();

		expect(disabled.isEnabled()).toBe(false);
		expect((await disabled.getStatus(installed.pluginId))?.pluginId).toBe(installed.pluginId);
		expect((await disabled.list()).map((status) => status.pluginId)).toContain(installed.pluginId);
		expect((await disabled.getDiagnostics(installed.pluginId)).plugins).toHaveLength(1);
		await expect(disabled.enable(installed.pluginId)).rejects.toMatchObject({
			code: "PLUGINS_DISABLED",
		});
		await expect(disabled.activate(installed.pluginId)).rejects.toMatchObject({
			code: "PLUGINS_DISABLED",
		});
	});

	test("loads persisted state before the first contribution refresh", async () => {
		const storeRoot = await makeTempRoot();
		const stateStore = new PluginStateStore({ root: storeRoot });
		const order: string[] = [];
		const realInitialize = stateStore.initialize.bind(stateStore);
		stateStore.initialize = async () => {
			order.push("state-initialize");
			return realInitialize();
		};

		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			contributionCoordinator: {
				// `refreshCatalog("initialize")` dispatches to the coordinator's `initialize`.
				initialize: async () => {
					order.push("contribution-refresh");
					return { changed: true, revision: 1 };
				},
				refresh: async () => ({ changed: false, revision: 1 }),
			} as never,
		});
		await manager.initialize();

		// Provider registration reads persisted config synchronously via
		// `getCachedState()`, which returns undefined until the first load completes. If a
		// refresh ever ran first, every provider would register with empty config and the
		// user's settings would appear to have been reset.
		expect(order[0]).toBe("state-initialize");
		expect(order).toContain("contribution-refresh");
		expect(order.indexOf("state-initialize")).toBeLessThan(order.indexOf("contribution-refresh"));
	});

	test("migrates legacy hash identity to a stable UUID and keeps grants across upgrades", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.identity-migration";
		const supervisor = new FakeSupervisor();
		const stateStore = new PluginStateStore(storeRoot);
		const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
		const migrationDispatcher = new PluginHostDispatcher({
			identity: {
				pluginId,
				runtimeId: "migration-runtime",
				runtimeGeneration: 0,
			},
			methods: {},
		});
		const platform = createPluginPlatformServices({
			runtimeSupervisor: supervisor as never,
			stateStore,
			permissionStore,
			capabilityBroker,
			hostServices,
		});
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			permissionStore,
			hostServices,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: async (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				packageDigest: context.package.hash,
				command: ["fake-runtime"],
				cwd: context.packagePath,
				dispatcher: migrationDispatcher,
			}),
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});
		await manager.initialize();

		// Install in the legacy hash-identity era and grant by hash. The first
		// grant operation already lazily migrates the identity to a stable UUID.
		const source = await makePackage(root, pluginId, (manifest) => {
			(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
		});
		const installed = await manager.install(source);
		if (!installed.current) throw new Error("Installed plugin has no current package");
		const legacyHash = installed.current.hash;
		const granted = await manager.replacePermissions(pluginId, {
			expectedRevision: 1,
			grantedBy: "admin-user-1",
			grants: [
				{
					grantId: "grant-identity",
					capability: "diagnostics.readOwnLogs",
					scope: { type: "global" },
					grantedBy: "admin-user-1",
				},
			],
		});
		// Migrated to a stable UUID, distinct from the legacy package hash.
		expect(granted.permissions.installationId).not.toBe(legacyHash);
		expect(granted.permissions.installationId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(granted.permissions.revision).toBe(2);
		expect(granted.permissions.grants.map((g) => g.capability)).toContain(
			"diagnostics.readOwnLogs",
		);

		// First permission read lazily migrates to a stable UUID, inheriting the
		// legacy hash's grants via sourceInstallationId.
		const migrated = await manager.getPermissions(pluginId);
		expect(migrated.installationId).not.toBe(legacyHash);
		expect(migrated.installationId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(migrated.grants.map((g) => g.capability)).toContain("diagnostics.readOwnLogs");

		// UUID is persisted and idempotent on subsequent reads.
		const persisted = await stateStore.getState(pluginId);
		expect(persisted?.installationId).toBe(migrated.installationId);
		const again = await manager.getPermissions(pluginId);
		expect(again.installationId).toBe(migrated.installationId);

		// Simulate an upgrade (package hash changes): identity and grants survive.
		await stateStore.updateState(pluginId, (current) => ({
			...current,
			current: { version: "9.9.9", hash: "aa".repeat(32) },
		}));
		const upgraded = await manager.getPermissions(pluginId);
		expect(upgraded.installationId).toBe(migrated.installationId);
		expect(upgraded.grants.map((g) => g.capability)).toContain("diagnostics.readOwnLogs");
	});

	test("re-seeds declared grants on enable when the persisted summary is empty", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.reseed-on-enable";
		const supervisor = new FakeSupervisor();
		const stateStore = new PluginStateStore(storeRoot);
		const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
		const platform = createPluginPlatformServices({
			runtimeSupervisor: supervisor as never,
			stateStore,
			permissionStore,
			capabilityBroker,
			hostServices,
		});
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			permissionStore,
			hostServices,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: async (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				packageDigest: context.package.hash,
				command: ["fake-runtime"],
				cwd: context.packagePath,
				dispatcher: new PluginHostDispatcher({
					identity: {
						pluginId,
						runtimeId: "reseed-runtime",
						runtimeGeneration: 0,
					},
					methods: {},
				}),
			}),
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});
		await manager.initialize();
		const source = await makePackage(root, pluginId, (manifest) => {
			(manifest.permissions as Record<string, unknown>).host = [
				"diagnostics.readOwnLogs",
				"query.read.projects",
			];
		});
		await manager.install(source);

		// Simulate a legacy/restored state whose grant summary was lost: the
		// enable path must re-seed the manifest-declared capabilities instead of
		// binding an empty permission set.
		await stateStore.updateState(pluginId, (current) => ({
			...current,
			grants: { count: 0, capabilities: [], revision: 0 },
		}));
		await manager.enable(pluginId);
		await manager.activate(pluginId);

		const permissions = await manager.getPermissions(pluginId);
		expect(permissions.grants.map((grant) => grant.capability).sort()).toEqual([
			"diagnostics.readOwnLogs",
			"query.read.projects",
		]);
	});

	for (const stoppedRuntime of [false, true]) {
		for (const recovery of ["enable", "disable"] as const) {
			test(`${recovery} retries failed revocation for a disabled plugin with ${stoppedRuntime ? "a stopped runtime" : "no runtime"}`, async () => {
				const root = await makeTempRoot();
				const pluginId = `com.example.revoke-recovery-${recovery}-${stoppedRuntime}`;
				const supervisor = new FakeSupervisor();
				const events: PluginLifecycleRevokeEvent[] = [];
				let failNextRevoke = false;
				let providerEnabled = false;
				let restores = 0;
				const coordinator = new PluginLifecycleRevokeCoordinator({
					adapters: {
						ui_session: () => undefined,
						capability_broker: () => undefined,
						event_gateway: () => undefined,
						scheduler: () => undefined,
						secret_broker: () => undefined,
						tool_registry: () => undefined,
						mcp_adapter: () => undefined,
						quota_registry: () => undefined,
						provider_registry: ({ event }) => {
							events.push(event);
							if (failNextRevoke) {
								failNextRevoke = false;
								throw new Error("Transient provider adapter failure");
							}
							providerEnabled = false;
						},
					},
				});
				const manager = makeManager({
					root: join(root, "plugins"),
					disabled: false,
					runtimeSupervisor: supervisor,
					lifecycleRevokeCoordinator: coordinator,
					restorePluginLifecycle: () => {
						providerEnabled = true;
						restores++;
					},
				});
				await manager.install(
					await makePackage(root, pluginId, (manifest) => {
						(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
					}),
				);
				if (stoppedRuntime) {
					supervisor.register({
						pluginId,
						pluginVersion: "1.0.0",
						command: ["fake-runtime"],
						cwd: root,
					});
				}
				const permissions = await manager.getPermissions(pluginId);
				failNextRevoke = true;
				await expect(
					manager.replacePermissions(pluginId, {
						grants: [],
						expectedRevision: permissions.revision,
						grantedBy: "recovery-test-admin",
					}),
				).rejects.toThrow("Plugin lifecycle revocation failed");
				expect((await manager.getStatus(pluginId))?.desiredState).toBe("disabled");
				expect(providerEnabled).toBe(false);
				expect(restores).toBe(0);
				expect(events).toHaveLength(1);
				const failedEvent = events[0];
				if (!failedEvent) throw new Error("Missing failed revoke event");
				// The real coordinator caches failed deterministic events. A retry of
				// that same ID cannot recover even though the adapter is healthy now.
				await expect(coordinator.revoke(failedEvent)).rejects.toThrow(
					"Plugin lifecycle revocation failed",
				);
				expect(events).toHaveLength(1);
				// A recovery attempt that also fails must not bypass the fence. A later
				// explicit attempt must use yet another ID, not that cached failure.
				failNextRevoke = true;
				await expect(manager[recovery](pluginId)).rejects.toThrow(
					"Plugin lifecycle revocation failed",
				);
				expect((await manager.getStatus(pluginId))?.desiredState).toBe("disabled");
				expect(providerEnabled).toBe(false);
				expect(restores).toBe(0);
				expect(events).toHaveLength(2);
				if (recovery === "disable") {
					await manager.disable(pluginId);
					expect(providerEnabled).toBe(false);
					expect(restores).toBe(0);
					expect(events).toHaveLength(3);
				}
				const enabled = await manager.enable(pluginId);
				expect(enabled.desiredState).toBe("enabled");
				expect(providerEnabled).toBe(true);
				expect(restores).toBe(1);
				expect(events).toHaveLength(3);
				expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
				expect(events[2]?.kind).toBe("disable");
				expect((await manager.getPermissions(pluginId)).grants).toEqual([]);
			});
		}
	}

	test("serializes a blocked crash before new-generation provider restoration", async () => {
		const fixture = await makeLifecycleRaceFixture("com.example.ordered-crash");
		const { runtime, supervisor, effects, stateStore, manager } = fixture;
		fixture.crash();
		await fixture.crashEntered.promise;
		await supervisor.start(runtime.options.pluginId);
		// A bounded observation window only detects an illegal concurrent restore;
		// the deferred controls the race and settle waits for all actual handlers.
		let restoredBeforeRevokeCompleted = false;
		try {
			restoredBeforeRevokeCompleted = await Promise.race([
				fixture.restored.promise.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 60)),
			]);
		} finally {
			fixture.releaseCrash.resolve();
			await fixture.settle();
		}
		expect(restoredBeforeRevokeCompleted).toBe(false);
		expect(effects.filter((effect) => effect === "revoke:crash:1")).toHaveLength(1);
		expect(effects.at(-1)).toBe("restore");
		const identity = await fixture.callProvider();
		expect(identity.runtimeGeneration).toBe(2);
		expect(identity.runtimeId).toBe(runtime.runtimeId);
		expect(identity).toMatchObject({
			installationId: (await manager.getStatus(runtime.options.pluginId))?.installationId,
		});
		const state = await stateStore.getState(runtime.options.pluginId);
		expect(state?.runtimeState).toBe("active");
		expect(state?.runtimeGeneration).toBe(2);
		expect(state?.lastError).toBeNull();
		const effectsAfterRecovery = [...effects];
		runtime.options.onCrash?.(new Error("duplicate old crash notification"));
		await fixture.settle();
		expect(effects).toEqual(effectsAfterRecovery);
		await fixture.callProvider();
	});

	test("failed revocation fences a delayed active restore without mixing generations", async () => {
		const fixture = await makeLifecycleRaceFixture("com.example.failed-revoke-race");
		const { runtime, supervisor, stateStore } = fixture;
		fixture.failRevokes();
		fixture.crash();
		await fixture.crashEntered.promise;
		await supervisor.start(runtime.options.pluginId);
		fixture.releaseCrash.resolve();
		await fixture.settle();
		expect(fixture.effects).not.toContain("restore");
		await expect(fixture.callProvider()).rejects.toThrow("Provider disabled");
		const state = await stateStore.getState(runtime.options.pluginId);
		expect(state?.runtimeGeneration).toBe(2);
		expect(state?.runtimeState).toBe("quarantine");
		expect(state?.lastError?.phase).toBe("lifecycle-revoke");
	});

	test("a delayed active event cannot restore revoked grants", async () => {
		const fixture = await makeLifecycleRaceFixture("com.example.revoked-grant-race");
		const { runtime, manager, supervisor, hostServices } = fixture;
		const pluginId = runtime.options.pluginId;
		const permissions = await manager.getPermissions(pluginId);
		fixture.crash();
		await fixture.crashEntered.promise;
		const revoking = manager.revokePermissions(pluginId, {
			expectedRevision: permissions.revision,
			grantIds: permissions.grants.map((grant) => grant.grantId),
			grantedBy: "race-test-admin",
		});
		await Promise.resolve();
		await Promise.resolve();
		await supervisor.start(pluginId);
		fixture.releaseCrash.resolve();
		await revoking;
		await fixture.settle();
		const binding = hostServices.getRuntimeBinding(pluginId, runtime.runtimeId);
		expect(binding?.grantRevision).toBe(permissions.revision + 1);
		if (!binding) throw new Error("New generation was not rebound");
		const denied = await binding.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "after-delayed-active",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect("error" in denied).toBe(true);
		expect((await manager.getPermissions(pluginId)).grants).toEqual([]);
	});

	test("a delayed active event cannot undo an explicit disable", async () => {
		const fixture = await makeLifecycleRaceFixture("com.example.disable-race");
		const { runtime, manager, supervisor } = fixture;
		fixture.crash();
		await fixture.crashEntered.promise;
		const disabling = manager.disable(runtime.options.pluginId);
		// Let disable enqueue its operation before the subsequent active event.
		await Promise.resolve();
		await Promise.resolve();
		await supervisor.start(runtime.options.pluginId);
		fixture.releaseCrash.resolve();
		await disabling;
		await fixture.settle();
		expect((await manager.getStatus(runtime.options.pluginId))?.desiredState).toBe("disabled");
		expect((await manager.getStatus(runtime.options.pluginId))?.runtimeState).toBe("inactive");
		await expect(fixture.callProvider()).rejects.toThrow("Provider disabled");
		expect(
			fixture.hostServices.hasRuntimeBinding(runtime.options.pluginId, runtime.runtimeId),
		).toBe(false);
	});

	test("callbacks from a replaced runtime cannot revoke or overwrite the new instance", async () => {
		const fixture = await makeLifecycleRaceFixture("com.example.replaced-runtime");
		const { runtime, supervisor, manager } = fixture;
		const pluginId = runtime.options.pluginId;
		await manager.deactivate(pluginId);
		await fixture.settle();
		supervisor.runtimes.delete(pluginId);
		await manager.activate(pluginId);
		await fixture.settle();
		const replacement = supervisor.get(pluginId);
		if (!replacement) throw new Error("Replacement runtime missing");
		expect(replacement).not.toBe(runtime);
		fixture.effects.length = 0;
		runtime.state = "crashed";
		runtime.options.onStateChange?.("crashed", "active");
		runtime.options.onCrash?.(new Error("late retired process exit"));
		await fixture.settle();
		expect(fixture.effects).toEqual([]);
		const identity = await fixture.callProvider();
		expect(identity.runtimeId).toBe(replacement.runtimeId);
		expect(identity.runtimeGeneration).toBe(replacement.generation);
		expect((await manager.getStatus(pluginId))?.runtimeState).toBe("active");
	});

	test("keeps the capability binding after an idle-style runtime restart (generation change)", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.idle-restart-binding";
		const supervisor = new FakeSupervisor();
		const stateStore = new PluginStateStore(storeRoot);
		const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
		const unsafeDispatcher = new PluginHostDispatcher({
			identity: { pluginId, runtimeId: "unsafe-runtime", runtimeGeneration: 0 },
			methods: { unsafe: { method: "unsafe", handler: async () => ({ allowed: true }) } },
		});
		const platform = createPluginPlatformServices({
			runtimeSupervisor: supervisor as never,
			stateStore,
			permissionStore,
			capabilityBroker,
			hostServices,
		});
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			permissionStore,
			hostServices,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: async (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				packageDigest: context.package.hash,
				command: ["fake-runtime"],
				cwd: context.packagePath,
				dispatcher: unsafeDispatcher,
			}),
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});
		const settle = trackRuntimeLifecycle(manager);
		drainBeforeCleanup.push(settle);
		const source = await makePackage(root, pluginId, (manifest) => {
			(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
		});
		await manager.install(source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		const runtime = supervisor.get(pluginId);
		if (!runtime) throw new Error("Runtime was not registered");
		const runtimeId = runtime.runtimeId;
		expect(hostServices.hasRuntimeBinding(pluginId, runtimeId)).toBe(true);
		expect(capabilityBroker.hasBinding(pluginId, runtimeId)).toBe(true);

		// Simulate the supervisor's idle-timeout restart: the same runtime object
		// starts again, bumping the generation and emitting "active".
		const generationBefore = runtime.generation;
		await supervisor.start(pluginId);
		expect(runtime.generation).toBe(generationBefore + 1);

		// onStateChange enqueues revoke+rebind without awaiting it. Drain the actual
		// handler promises instead of racing a fixed timer against filesystem work.
		await settle();

		// After the generation change the manager must have revoked the stale
		// binding and re-registered it for the (still same) runtimeId.
		expect(hostServices.hasRuntimeBinding(pluginId, runtimeId)).toBe(true);
		expect(capabilityBroker.hasBinding(pluginId, runtimeId)).toBe(true);
		const binding = hostServices.getRuntimeBinding(pluginId, runtimeId);
		expect(binding?.plugin.runtimeGeneration).toBe(runtime.generation);
	});

	test("reconciles host access when an active runtime lost its binding", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.active-binding-heal";
		const supervisor = new FakeSupervisor();
		const stateStore = new PluginStateStore(storeRoot);
		const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
		const unsafeDispatcher = new PluginHostDispatcher({
			identity: { pluginId, runtimeId: "unsafe-runtime", runtimeGeneration: 0 },
			methods: { unsafe: { method: "unsafe", handler: async () => ({ allowed: true }) } },
		});
		const platform = createPluginPlatformServices({
			runtimeSupervisor: supervisor as never,
			stateStore,
			permissionStore,
			capabilityBroker,
			hostServices,
		});
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			permissionStore,
			hostServices,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: async (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				packageDigest: context.package.hash,
				command: ["fake-runtime"],
				cwd: context.packagePath,
				dispatcher: unsafeDispatcher,
			}),
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});
		const source = await makePackage(root, pluginId, (manifest) => {
			(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
		});
		await manager.install(source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		const runtime = supervisor.get(pluginId);
		if (!runtime) throw new Error("Runtime was not registered");
		expect(hostServices.hasRuntimeBinding(pluginId, runtime.runtimeId)).toBe(true);

		// Simulate a revocation that removed the host binding and plugin-level
		// broker access while the runtime kept running (crash revoke followed
		// by a failed restart leaves exactly this stuck state).
		hostServices.revokeRuntime(pluginId, runtime.runtimeId);
		capabilityBroker.revoke(pluginId);
		expect(hostServices.hasRuntimeBinding(pluginId, runtime.runtimeId)).toBe(false);

		// Re-activating while the runtime is already active must heal access.
		const status = await manager.activate(pluginId);
		expect(status.runtimeState).toBe("active");
		expect(hostServices.hasRuntimeBinding(pluginId, runtime.runtimeId)).toBe(true);
		const binding = hostServices.getRuntimeBinding(pluginId, runtime.runtimeId);
		expect(binding?.plugin.runtimeGeneration).toBe(runtime.generation);
		if (!binding) throw new Error("Runtime binding was not healed");
		const allowed = await binding.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "healed-by-activate",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect("result" in allowed).toBe(true);
	});

	test("heals a same-generation active event after the binding was torn down", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.active-event-heal";
		const supervisor = new FakeSupervisor();
		const stateStore = new PluginStateStore(storeRoot);
		const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
		const unsafeDispatcher = new PluginHostDispatcher({
			identity: { pluginId, runtimeId: "unsafe-runtime", runtimeGeneration: 0 },
			methods: { unsafe: { method: "unsafe", handler: async () => ({ allowed: true }) } },
		});
		const platform = createPluginPlatformServices({
			runtimeSupervisor: supervisor as never,
			stateStore,
			permissionStore,
			capabilityBroker,
			hostServices,
		});
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			permissionStore,
			hostServices,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: async (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				packageDigest: context.package.hash,
				command: ["fake-runtime"],
				cwd: context.packagePath,
				dispatcher: unsafeDispatcher,
			}),
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});
		const settle = trackRuntimeLifecycle(manager);
		drainBeforeCleanup.push(settle);
		const source = await makePackage(root, pluginId, (manifest) => {
			(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
		});
		await manager.install(source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		const runtime = supervisor.get(pluginId);
		if (!runtime) throw new Error("Runtime was not registered");
		hostServices.revokeRuntime(pluginId, runtime.runtimeId);
		capabilityBroker.revoke(pluginId);
		expect(hostServices.hasRuntimeBinding(pluginId, runtime.runtimeId)).toBe(false);

		// A same-generation "active" notification (no generation bump) must
		// trigger reconciliation instead of being skipped: this is what the
		// runtime emits after a restart whose generation persisted state
		// already covered.
		const beforeActive = runtime.state;
		runtime.state = "active";
		runtime.options.onStateChange?.("active", beforeActive);
		await settle();

		expect(hostServices.hasRuntimeBinding(pluginId, runtime.runtimeId)).toBe(true);
		const binding = hostServices.getRuntimeBinding(pluginId, runtime.runtimeId);
		expect(binding?.plugin.runtimeGeneration).toBe(runtime.generation);
		if (!binding) throw new Error("Runtime binding was not healed");
		const allowed = await binding.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "healed-by-event",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect("result" in allowed).toBe(true);
	});

	test("activate after an upgrade starts the new package command, not the stale record", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const pluginId = "com.example.upgrade-restart";
		const supervisor = new FakeSupervisor();
		const stateStore = new PluginStateStore(storeRoot);
		const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
		const platform = createPluginPlatformServices({
			runtimeSupervisor: supervisor as never,
			stateStore,
			permissionStore,
			capabilityBroker,
			hostServices,
		});
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			permissionStore,
			hostServices,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: async (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				packageDigest: context.package.hash,
				command: ["fake-runtime", context.package.hash],
				cwd: context.packagePath,
			}),
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});
		const settle = trackRuntimeLifecycle(manager);
		let cleanup: Promise<void> | undefined;
		const drain = () =>
			(cleanup ??= (async () => {
				await manager.shutdown();
				await supervisor.shutdown();
				await settle();
			})());
		drainBeforeCleanup.push(drain);

		// First install + activate (v1).
		const v1Source = await makePackage(root, pluginId, (manifest) => {
			manifest.version = "1.0.0";
			(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
		});
		await manager.install(v1Source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		const v1Runtime = supervisor.get(pluginId);
		if (!v1Runtime) throw new Error("Runtime was not registered after first activate");
		expect(v1Runtime.options.command.join(" ")).toContain(v1Runtime.options.command[1]);

		// Upgrade to v2: install a new package over the same pluginId, then activate.
		const v2Source = await makePackage(root, pluginId, (manifest) => {
			manifest.version = "2.0.0";
			(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
		});
		await manager.install(v2Source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);

		const v2Runtime = supervisor.get(pluginId);
		if (!v2Runtime) throw new Error("Runtime was not registered after upgrade");
		// The upgraded package must be the one running — the stale v1 record must
		// have been replaced instead of restarted.
		expect(v2Runtime.options.command.join(" ")).not.toContain(v1Runtime.options.command[1]);
		expect(v2Runtime.options.command[1]).not.toBe(v1Runtime.options.command[1]);
		const status = await manager.getStatus(pluginId);
		expect(status?.current?.version).toBe("2.0.0");
		await drain();
	});

	test("approve writes the canonical grant to the DB authority, surviving a manager rebuild", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.approve-canonical";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
			}),
		);
		const installationId = await manager.getCurrentInstallationId(pluginId);
		// Simulate a runtime capability request that surfaced as a pending request.
		const pending = await manager.permissionStore.addPendingRequest(pluginId, installationId, {
			capability: "query.read.projects",
			scope: { type: "global" },
			requestedByRuntimeId: "rt-test",
		});
		if (!pending) throw new Error("expected a queued pending request");
		await manager.approvePermissionRequest(pluginId, pending.requestId, "admin-approve");

		// The canonical grant must live in the DB authority, not only the mirror.
		const snapshot = await integrationAuthorityService.getSnapshot(
			pluginInstallationAuthorityId(pluginId, installationId),
		);
		expect(snapshot?.grants.some((grant) => grant.capabilityId === "project.read")).toBe(true);

		// A brand-new manager over the same root re-reads the authority and still
		// sees the approved grant (a mirror-only grant would be lost here).
		const rebuilt = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const permissions = await rebuilt.getPermissions(pluginId);
		expect(permissions.installationId).toBe(installationId);
		expect(
			permissions.grants.some(
				(grant) =>
					grant.capability === "query.read.projects" && grant.grantedBy === "admin-approve",
			),
		).toBe(true);
	});

	test("permanent deny records the pair and blocks every future request for it", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.deny-permanent";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
			}),
		);
		const installationId = await manager.getCurrentInstallationId(pluginId);
		const pending = await manager.permissionStore.addPendingRequest(pluginId, installationId, {
			capability: "query.read.projects",
			scope: { type: "global" },
			requestedByRuntimeId: "rt-test",
		});
		if (!pending) throw new Error("expected a queued pending request");

		await manager.denyPermissionRequest(pluginId, pending.requestId, {
			permanent: true,
			deniedBy: "admin-deny",
		});

		// The denial is listed with its metadata ...
		const denials = await manager.listPermanentDenials(pluginId);
		expect(denials).toHaveLength(1);
		expect(denials[0]).toMatchObject({
			capability: "query.read.projects",
			scope: { type: "global" },
			deniedBy: "admin-deny",
		});

		// ... and the same pair can never be queued again, runtime or upgrade path.
		const reRequest = await manager.permissionStore.addPendingRequest(pluginId, installationId, {
			capability: "query.read.projects",
			scope: { type: "global" },
		});
		expect(reRequest).toBeUndefined();
		expect(await manager.listPendingPermissionRequests(pluginId)).toHaveLength(0);

		// Lifting the denial lets the plugin ask again.
		await manager.removePermanentDenial(pluginId, "query.read.projects", { type: "global" });
		expect(await manager.listPermanentDenials(pluginId)).toHaveLength(0);
		const reRequestAfterLift = await manager.permissionStore.addPendingRequest(
			pluginId,
			installationId,
			{ capability: "query.read.projects", scope: { type: "global" } },
		);
		expect(reRequestAfterLift).toBeDefined();
	});

	test("denying an already approved request fails instead of reporting success", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.deny-after-approve";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
			}),
		);
		const installationId = await manager.getCurrentInstallationId(pluginId);
		const pending = await manager.permissionStore.addPendingRequest(pluginId, installationId, {
			capability: "query.read.projects",
			scope: { type: "global" },
		});
		if (!pending) throw new Error("expected a queued pending request");

		await manager.approvePermissionRequest(pluginId, pending.requestId, "admin-approve");
		// Bun's promise matcher can starve the reused DB read Worker. Settle the real
		// operation first so cleanup cannot race a still-running authority lookup.
		const rejection = await manager
			.denyPermissionRequest(pluginId, pending.requestId, { permanent: true })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(rejection).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
		expect(await manager.listPermanentDenials(pluginId)).toHaveLength(0);
		expect(await manager.listPendingPermissionRequests(pluginId)).toHaveLength(0);
		expect((await manager.getPermissions(pluginId)).grants).toContainEqual(
			expect.objectContaining({ capability: "query.read.projects", grantedBy: "admin-approve" }),
		);
	});

	test("restores the stable UUID from the authority and retires legacy hash authorities on initialize", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.legacy-restore";
		const manager = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
			}),
		);
		const uuid = await manager.getCurrentInstallationId(pluginId);
		const hash = installed.current?.hash;
		if (!hash) throw new Error("Installed plugin has no package hash");

		// Simulate a legacy state that lost its UUID (crash between authority
		// write and state write, or a pre-UUID state file) while a legacy
		// hash-keyed authority still exists.
		const statePath = join(root, "plugins", "state.json");
		const state = JSON.parse(await readFile(statePath, "utf8")) as {
			plugins: Record<string, Record<string, unknown>>;
		};
		const pluginState = state.plugins[pluginId] as Record<string, unknown>;
		delete pluginState.installationId;
		await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
		const legacyAuthorityId = pluginInstallationAuthorityId(pluginId, hash);
		await integrationAuthorityService.create({
			id: legacyAuthorityId,
			kind: "plugin_installation",
			integrationId: pluginId,
			metadataJson: { installationId: hash },
			grants: [
				{
					id: "legacy-grant",
					capabilityId: "diagnostics.read",
					scope: { type: "global" },
					createdBy: { type: "system" },
				},
			],
		});

		const manager2 = makeManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager2.initialize();
		// The UUID is restored from the existing authority instead of a new one.
		expect(await manager2.getCurrentInstallationId(pluginId)).toBe(uuid);
		// The legacy hash-keyed authority is retired so only one identity root lives on.
		const legacy = await integrationAuthorityService.getSnapshot(legacyAuthorityId, {
			includeExpired: true,
		});
		expect(legacy?.authority.state).toBe("revoked");
	});
});

describe("host bundled plugin defaults", () => {
	test("fresh defaults install once, activate and grant only manifest capabilities as system", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-fresh");
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const results = await Promise.all([
			manager.bootstrapBundledPlugin(fixture.descriptor),
			manager.bootstrapBundledPlugin(fixture.descriptor),
		]);
		for (const result of results)
			expect(result).toMatchObject({
				desiredState: "enabled",
				runtimeState: "active",
				compatibility: "compatible",
			});
		expect(fixture.loadCount()).toBe(1);
		expect(supervisor.startCount.get(fixture.descriptor.pluginId)).toBe(1);
		const permissions = await manager.getPermissions(fixture.descriptor.pluginId);
		expect(permissions.grants.map((grant) => grant.capability).sort()).toEqual([
			"provider.connection.request",
			"quota.provide",
		]);
		expect(permissions.grants.every((grant) => grant.grantedBy === "system")).toBe(true);
		expect(
			(await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId))?.status,
		).toBe("seeded");
	}, 15_000);

	test("a disabled bundled plugin stays disabled across bootstrap and a new manager", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-disabled");
		const storeRoot = join(root, "store");
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.bootstrapBundledPlugin(fixture.descriptor);
		await manager.disable(fixture.descriptor.pluginId);
		const permissions = await manager.getPermissions(fixture.descriptor.pluginId);
		expect((await manager.bootstrapBundledPlugin(fixture.descriptor))?.desiredState).toBe(
			"disabled",
		);
		await manager.shutdown();
		const reloaded = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		expect((await reloaded.bootstrapBundledPlugin(fixture.descriptor))?.desiredState).toBe(
			"disabled",
		);
		expect((await reloaded.getPermissions(fixture.descriptor.pluginId)).grants).toEqual(
			permissions.grants,
		);
		expect(fixture.loadCount()).toBe(1);
	}, 15_000);

	test("uninstall survives restart, and explicit File reinstall can restore the plugin", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-removed");
		const storeRoot = join(root, "store");
		const manager = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.bootstrapBundledPlugin(fixture.descriptor);
		await manager.uninstall(fixture.descriptor.pluginId);
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect(
			(await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId))?.status,
		).toBe("removed");
		await manager.shutdown();
		const reloaded = makeManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		expect(await reloaded.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect(await reloaded.list()).toEqual([]);
		await reloaded.install(new File([fixture.bytes], "provider-quota.nfplugin"));
		await reloaded.enable(fixture.descriptor.pluginId);
		await reloaded.activate(fixture.descriptor.pluginId);
		expect((await reloaded.bootstrapBundledPlugin(fixture.descriptor))?.runtimeState).toBe(
			"active",
		);
		expect(fixture.loadCount()).toBe(1);
	}, 15_000);

	test("adopts a manually installed version without overwriting state or grants", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-adopted", "2.0.0");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await manager.install(fixture.source);
		const permissions = await manager.getPermissions(fixture.descriptor.pluginId);
		const status = await manager.bootstrapBundledPlugin({
			...fixture.descriptor,
			version: "1.0.1",
		});
		expect(status?.current).toEqual(installed.current);
		expect(status?.desiredState).toBe("disabled");
		expect((await manager.getPermissions(fixture.descriptor.pluginId)).grants).toEqual(
			permissions.grants,
		);
		expect(
			(await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId))?.status,
		).toBe("adopted");
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);

	test("uninstall history from before the ledger suppresses default installation", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-old-removal");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.install(fixture.source);
		await manager.uninstall(fixture.descriptor.pluginId);
		expect(
			await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId),
		).toBeUndefined();
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect(
			(await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId))?.status,
		).toBe("removed");
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);

	test("interrupted initialization never silently retries or resurrects a package", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-interrupted");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.stateStore.setBundledBootstrap(fixture.descriptor.pluginId, {
			status: "initializing",
			version: fixture.descriptor.version,
			archiveSha256: fixture.sha256,
		});
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect(fixture.loadCount()).toBe(0);
		expect(
			(await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId))?.status,
		).toBe("initializing");
	});

	test("corrupt persistence prevents automatic defaults before loading code", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-corrupt");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await mkdir(manager.root, { recursive: true });
		await writeFile(manager.stateStore.statePath, "{broken");
		await expect(manager.bootstrapBundledPlugin(fixture.descriptor)).rejects.toMatchObject({
			code: "PLUGIN_BUNDLED_STATE_UNAVAILABLE",
		});
		expect(fixture.loadCount()).toBe(0);
	});

	test("the feature kill switch skips default installation", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-kill-switch");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: true,
			runtimeSupervisor: new FakeSupervisor(),
		});
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect(
			await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId),
		).toBeUndefined();
		expect(fixture.loadCount()).toBe(0);
	});

	test("digest and manifest-version checks cannot publish an unexpected package", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-integrity");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await expect(
			manager.bootstrapBundledPlugin({
				...fixture.descriptor,
				load: async () => ({ bytes: fixture.bytes, sha256: "0".repeat(64) }),
			}),
		).rejects.toMatchObject({ code: "PLUGIN_BUNDLED_INTEGRITY_FAILED" });
		expect(
			await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId),
		).toBeUndefined();
		await expect(
			manager.bootstrapBundledPlugin({ ...fixture.descriptor, version: "9.0.0" }),
		).rejects.toMatchObject({ code: "PLUGIN_IDENTITY_MISMATCH" });
		expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
		expect(await manager.stateStore.getState(fixture.descriptor.pluginId)).toBeUndefined();
	});

	test("bundled identity is not a bypass for an explicit signature policy", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-signature");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			trustPolicy: { enabled: true, requireSignature: true },
		});
		await expect(manager.bootstrapBundledPlugin(fixture.descriptor)).rejects.toThrow();
		expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
		expect(await manager.stateStore.getState(fixture.descriptor.pluginId)).toBeUndefined();
	});

	test("a concurrent File upload waits to publish and is never started by defaults", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-upload-race");
		const winner = await makeBundledFixture(
			await makeTempRoot(),
			fixture.descriptor.pluginId,
			"2.0.0",
		);
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const entered = deferred();
		const release = deferred();
		const staged = deferred();
		const upload = new File([winner.bytes], "winner.nfplugin");
		const originalInstall = packageStaging(manager).stagePackage.bind(manager);
		const spy = spyOn(packageStaging(manager), "stagePackage").mockImplementation(
			async (source, ...args) => {
				const installed = await originalInstall(source, ...args);
				if (source === upload) {
					expect(installed.currentUpdated).toBe(false);
					staged.resolve();
				}
				return installed;
			},
		);
		try {
			const bootstrap = manager.bootstrapBundledPlugin({
				...fixture.descriptor,
				load: async () => {
					entered.resolve();
					await release.promise;
					return { bytes: fixture.bytes, sha256: fixture.sha256 };
				},
			});
			await entered.promise;
			const installation = manager.install(upload);
			await staged.promise;
			expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
			release.resolve();
			const bootstrapped = await bootstrap;
			expect(bootstrapped?.current?.version).toBe(fixture.descriptor.version);
			expect(supervisor.startCount.get(fixture.descriptor.pluginId)).toBe(1);
			expect(supervisor.get(fixture.descriptor.pluginId)?.options.pluginVersion).toBe(
				fixture.descriptor.version,
			);
			const installed = await installation;
			expect(installed.current?.version).toBe("2.0.0");
			expect(installed.desiredState).toBe("disabled");
			expect(supervisor.get(fixture.descriptor.pluginId)?.state).toBe("stopped");
			expect((await manager.getStatus(fixture.descriptor.pluginId))?.current).toEqual(
				installed.current,
			);
			expect(
				(await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId))?.status,
			).toBe("seeded");
		} finally {
			release.resolve();
			spy.mockRestore();
		}
	}, 15_000);

	test("File trust failures and directory identity hints cannot publish current", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.upload-validation");
		const untrusted = makeManager({
			root: join(root, "untrusted-store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			trustPolicy: { enabled: true, requireSignature: true },
		});
		await expect(
			untrusted.install(new File([fixture.bytes], "unsigned.nfplugin")),
		).rejects.toThrow();
		expect((await untrusted.packageStore.readCurrent()).plugins).toEqual({});
		expect(await untrusted.stateStore.getState(fixture.descriptor.pluginId)).toBeUndefined();
		const hinted = makeManager({
			root: join(root, "hinted-store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await expect(
			hinted.install(fixture.source, { pluginId: "com.example.wrong-hint" }),
		).rejects.toMatchObject({ code: "PLUGIN_IDENTITY_MISMATCH" });
		expect((await hinted.packageStore.readCurrent()).plugins).toEqual({});
		expect(await hinted.stateStore.getState(fixture.descriptor.pluginId)).toBeUndefined();
	}, 15_000);

	test("a File upload after default commit cannot replace the command before enable/activate", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-post-commit");
		const uploadFixture = await makeBundledFixture(
			await makeTempRoot(),
			fixture.descriptor.pluginId,
			"2.0.0",
		);
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				command: ["fixture-runtime", context.manifest.version, context.packagePath],
				cwd: context.packagePath,
			}),
		});
		const entered = deferred();
		const release = deferred();
		const staged = deferred();
		const upload = new File([uploadFixture.bytes], "replacement.nfplugin");
		let uploadedPointerPublished: boolean | undefined;
		const originalSetId = manager.stateStore.setInstallationId.bind(manager.stateStore);
		const committing = spyOn(manager.stateStore, "setInstallationId").mockImplementation(
			async (pluginId, installationId) => {
				const result = await originalSetId(pluginId, installationId);
				entered.resolve();
				await release.promise;
				return result;
			},
		);
		const originalInstall = packageStaging(manager).stagePackage.bind(manager);
		const staging = spyOn(packageStaging(manager), "stagePackage").mockImplementation(
			async (source, ...args) => {
				const result = await originalInstall(source, ...args);
				if (source === upload) {
					uploadedPointerPublished = result.currentUpdated;
					staged.resolve();
				}
				return result;
			},
		);
		const starts = spyOn(supervisor, "start");
		try {
			const bootstrap = manager.bootstrapBundledPlugin(fixture.descriptor);
			await entered.promise;
			const defaultPointer = (await manager.packageStore.readCurrent()).plugins[
				fixture.descriptor.pluginId
			];
			expect(defaultPointer?.version).toBe(fixture.descriptor.version);
			expect((await manager.stateStore.getState(fixture.descriptor.pluginId))?.desiredState).toBe(
				"disabled",
			);
			const installation = manager.install(upload);
			await staged.promise;
			expect(uploadedPointerPublished).toBe(false);
			expect(
				(await manager.packageStore.readCurrent()).plugins[fixture.descriptor.pluginId],
			).toEqual(defaultPointer);
			release.resolve();
			const bootstrapped = await bootstrap;
			const installed = await installation;
			expect(bootstrapped?.current).toEqual(defaultPointer);
			expect(starts).toHaveBeenCalledTimes(1);
			const defaultPath = join(
				manager.root,
				"packages",
				fixture.descriptor.pluginId,
				fixture.descriptor.version,
				defaultPointer?.hash ?? "missing default pointer",
			);
			expect(starts).toHaveBeenCalledWith(
				expect.objectContaining({
					pluginVersion: fixture.descriptor.version,
					command: ["fixture-runtime", fixture.descriptor.version, defaultPath],
					cwd: defaultPath,
				}),
				expect.any(AbortSignal),
			);
			expect(installed.current?.version).toBe("2.0.0");
			expect(installed.desiredState).toBe("disabled");
			expect(supervisor.get(fixture.descriptor.pluginId)?.state).toBe("stopped");
		} finally {
			release.resolve();
			committing.mockRestore();
			staging.mockRestore();
			starts.mockRestore();
		}
	}, 15_000);

	test("shutdown drains delayed runtime options and never starts a late process", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.runtime", "1.0.0");
		const entered = deferred();
		const release = deferred();
		const supervisor = new RuntimeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: async (context) => {
				entered.resolve();
				await release.promise;
				return {
					pluginId: context.pluginId,
					pluginVersion: context.manifest.version,
					command: [
						process.execPath,
						join(import.meta.dir, "../../fixtures/plugins/runtime/fixture.ts"),
					],
					cwd: context.packagePath,
					runner: new LocalProcessRunner({
						allowedCwds: [context.packagePath],
						allowUnboundedResourceUsage: process.platform === "win32",
					}),
				};
			},
		});
		const starts = spyOn(supervisor, "start");
		const bootstrap = manager.bootstrapBundledPlugin(fixture.descriptor);
		const rejected = bootstrap.then(
			() => new Error("bootstrap unexpectedly completed after shutdown"),
			(error: unknown) => error,
		);
		try {
			await entered.promise;
			const shutdown = manager.shutdown();
			expect(manager.isShuttingDown()).toBe(true);
			await expectPending(shutdown);
			release.resolve();
			await shutdown;
			expect(await rejected).toMatchObject({ message: "Plugin manager is shutting down" });
			expect(starts).not.toHaveBeenCalled();
			expect(supervisor.get(fixture.descriptor.pluginId)).toBeUndefined();
			expect(supervisor.getDiagnostics()).toEqual([]);
		} finally {
			release.resolve();
			await rejected;
			await manager.shutdown();
			starts.mockRestore();
		}
	}, 15_000);

	test("shutdown drains delayed staging without publishing current or starting a process", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-stage-cancel");
		const entered = deferred();
		const release = deferred();
		const supervisor = new RuntimeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const originalInstall = packageStaging(manager).stagePackage.bind(manager);
		const staging = spyOn(packageStaging(manager), "stagePackage").mockImplementation(
			async (source, ...args) => {
				entered.resolve();
				await release.promise;
				return originalInstall(source, ...args);
			},
		);
		const starts = spyOn(supervisor, "start");
		const bootstrap = manager.bootstrapBundledPlugin(fixture.descriptor);
		const rejected = bootstrap.then(
			() => new Error("bootstrap unexpectedly completed after shutdown"),
			(error: unknown) => error,
		);
		try {
			await entered.promise;
			const shutdown = manager.shutdown();
			await expectPending(shutdown);
			release.resolve();
			await shutdown;
			expect(await rejected).toMatchObject({ message: "Plugin manager is shutting down" });
			expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
			expect(await manager.stateStore.getState(fixture.descriptor.pluginId)).toBeUndefined();
			expect(starts).not.toHaveBeenCalled();
			expect(supervisor.getDiagnostics()).toEqual([]);
		} finally {
			release.resolve();
			await rejected;
			await manager.shutdown();
			staging.mockRestore();
			starts.mockRestore();
		}
	}, 15_000);

	test("startup isolates a bundled failure and starts quota only after contributions are ready", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-startup-order");
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const events: string[] = [];
		expect(
			await initializePluginServices(
				manager,
				[
					{
						...fixture.descriptor,
						load: async () => ({ bytes: fixture.bytes, sha256: "0".repeat(64) }),
					},
					fixture.descriptor,
				],
				{
					startQuota: () => {
						expect(supervisor.get(fixture.descriptor.pluginId)?.state).toBe("active");
						events.push("quota.start");
					},
					onBootstrapError: () => events.push("bootstrap.error"),
				},
			),
		).toBe(true);
		expect(events).toEqual(["bootstrap.error", "quota.start"]);
		expect(fixture.loadCount()).toBe(1);
	}, 15_000);

	test("late startup cannot call quota.start after beginShutdown and quota.stop", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-startup-cancel");
		const entered = deferred();
		const release = deferred();
		const events: string[] = [];
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const startup = initializePluginServices(
			manager,
			[
				{
					...fixture.descriptor,
					load: async () => {
						entered.resolve();
						await release.promise;
						return { bytes: fixture.bytes, sha256: fixture.sha256 };
					},
				},
				fixture.descriptor,
			],
			{
				startQuota: () => {
					events.push("quota.start");
				},
				onBootstrapError: () => events.push("bootstrap.error"),
			},
		);
		try {
			await entered.promise;
			manager.beginShutdown();
			events.push("quota.stop");
			const shutdown = manager.shutdown();
			await expectPending(shutdown);
			release.resolve();
			expect(await startup).toBe(false);
			await shutdown;
			expect(events).toEqual(["quota.stop"]);
			expect(fixture.loadCount()).toBe(0);
			expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
		} finally {
			release.resolve();
			await startup;
			await manager.shutdown();
		}
	}, 15_000);

	test("shutdown before initialization completes drains it and skips defaults and quota", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-initialize-cancel");
		const entered = deferred();
		const release = deferred();
		const events: string[] = [];
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const originalInitialize = manager.stateStore.initialize.bind(manager.stateStore);
		const initializing = spyOn(manager.stateStore, "initialize").mockImplementation(async () => {
			const snapshot = await originalInitialize();
			entered.resolve();
			await release.promise;
			return snapshot;
		});
		const startup = initializePluginServices(manager, [fixture.descriptor], {
			startQuota: () => {
				events.push("quota.start");
			},
			onBootstrapError: () => events.push("bootstrap.error"),
		});
		try {
			await entered.promise;
			const shutdown = manager.shutdown();
			await expectPending(shutdown);
			release.resolve();
			expect(await startup).toBe(false);
			await shutdown;
			expect(events).toEqual([]);
			expect(fixture.loadCount()).toBe(0);
		} finally {
			release.resolve();
			await startup;
			await manager.shutdown();
			initializing.mockRestore();
		}
	}, 15_000);

	test("late runtime events cannot write or restore host access after shutdown", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-late-events");
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const settle = trackRuntimeLifecycle(manager);
		await manager.bootstrapBundledPlugin(fixture.descriptor);
		await manager.shutdown();
		const runtime = supervisor.get(fixture.descriptor.pluginId);
		if (!runtime) throw new Error("expected the retired test runtime");
		const persisted = await readFile(manager.stateStore.statePath, "utf8");
		const writes = spyOn(manager.stateStore, "updateState");
		const binds = spyOn(manager.hostServices, "bindRuntime");
		try {
			runtime.options.onStateChange?.("active", "stopped");
			runtime.options.onStateChange?.("starting", "stopped");
			await settle();
			expect(writes).not.toHaveBeenCalled();
			expect(binds).not.toHaveBeenCalled();
			expect(await readFile(manager.stateStore.statePath, "utf8")).toBe(persisted);
			expect(runtime.state).toBe("stopped");
		} finally {
			writes.mockRestore();
			binds.mockRestore();
		}
	}, 15_000);

	test("a shutdown drain timeout is a failure and late staging still cannot publish", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-drain-timeout");
		const entered = deferred();
		const release = deferred();
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const originalInstall = packageStaging(manager).stagePackage.bind(manager);
		const staging = spyOn(packageStaging(manager), "stagePackage").mockImplementation(
			async (source, ...args) => {
				entered.resolve();
				await release.promise;
				return originalInstall(source, ...args);
			},
		);
		const rejected = manager.bootstrapBundledPlugin(fixture.descriptor).then(
			() => new Error("bootstrap unexpectedly completed after shutdown"),
			(error: unknown) => error,
		);
		try {
			await entered.promise;
			const error = await manager.shutdown({ timeoutMs: 30 }).then(
				() => new Error("shutdown unexpectedly completed before its drain"),
				(failure: unknown) => failure,
			);
			expect(error).toMatchObject({ code: "PLUGIN_SHUTDOWN_TIMEOUT" });
			release.resolve();
			expect(await rejected).toMatchObject({ message: "Plugin manager is shutting down" });
			await manager.shutdown();
			expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
			expect(supervisor.getDiagnostics()).toEqual([]);
		} finally {
			release.resolve();
			await rejected;
			await manager.shutdown();
			staging.mockRestore();
		}
	}, 15_000);

	test("manager shutdown cancels a still-loading default without installing it", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.bundled-cancel");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.initialize();
		const entered = deferred();
		const bootstrap = manager.bootstrapBundledPlugin({
			...fixture.descriptor,
			load: (signal) =>
				new Promise((_resolve, reject) => {
					if (!signal) throw new Error("missing bootstrap cancellation signal");
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					entered.resolve();
				}),
		});
		const rejected = bootstrap.then(
			() => {
				throw new Error("bootstrap unexpectedly completed after shutdown");
			},
			(error: unknown) => error,
		);
		await entered.promise;
		await manager.shutdown();
		expect(await rejected).toMatchObject({ message: "Plugin manager is shutting down" });
		expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
		expect(
			await manager.stateStore.getBundledBootstrap(fixture.descriptor.pluginId),
		).toBeUndefined();
	}, 15_000);
});

test("reinstalling a live bundled archive stops it and explicit activation restores active state", async () => {
	const root = await makeTempRoot();
	const fixture = await makeBundledFixture(root, "com.example.bundled-live-reinstall");
	const supervisor = new FakeSupervisor();
	const manager = makeManager({
		root: join(root, "store"),
		disabled: false,
		runtimeSupervisor: supervisor,
	});
	const initialized = await manager.bootstrapBundledPlugin(fixture.descriptor);
	if (!initialized) throw new Error("expected a freshly initialized bundled plugin");
	const before = await manager.getPermissions(fixture.descriptor.pluginId);
	expect(initialized.runtimeState).toBe("active");
	const installed = await manager.install(new File([fixture.bytes], "provider-quota.nfplugin"));
	expect(installed.current).toEqual(initialized.current);
	expect(installed).toMatchObject({ desiredState: "disabled", runtimeState: "inactive" });
	expect(supervisor.get(fixture.descriptor.pluginId)?.state).toBe("stopped");
	expect((await manager.getPermissions(fixture.descriptor.pluginId)).grants).toEqual(before.grants);
	await manager.enable(fixture.descriptor.pluginId);
	const activated = await manager.activate(fixture.descriptor.pluginId);
	expect(activated).toMatchObject({ desiredState: "enabled", runtimeState: "active" });
	expect(supervisor.startCount.get(fixture.descriptor.pluginId)).toBe(2);
}, 15_000);

test("activation repairs persisted inactive state when the same runtime is already active", async () => {
	const root = await makeTempRoot();
	const fixture = await makeBundledFixture(root, "com.example.bundled-active-state");
	const supervisor = new FakeSupervisor();
	const manager = makeManager({
		root: join(root, "store"),
		disabled: false,
		runtimeSupervisor: supervisor,
	});
	await manager.bootstrapBundledPlugin(fixture.descriptor);
	await manager.stateStore.updateState(fixture.descriptor.pluginId, { runtimeState: "inactive" });
	const activated = await manager.activate(fixture.descriptor.pluginId);
	expect(activated.runtimeState).toBe("active");
	expect((await manager.stateStore.getState(fixture.descriptor.pluginId))?.runtimeState).toBe(
		"active",
	);
	expect(supervisor.startCount.get(fixture.descriptor.pluginId)).toBe(1);
}, 15_000);

// The shared authority service uses preload's isolated file database. Restrict cleanup
// to these test-owned migration IDs; every package, permission mirror and ledger is real.
describe("retired builtin quota default choice migration", () => {
	const legacyId = "com.narrafork.apikey-quota";
	const quotaId = "io.narrafork.provider-quota";
	const managers: PluginManager[] = [];
	const clearFixtureAuthorities = () => {
		if (process.env.NARRAFORK_TEST !== "1")
			throw new Error("migration fixtures require isolated preload");
		db.delete(integrationAuthorities)
			.where(
				and(
					eq(integrationAuthorities.kind, "plugin_installation"),
					inArray(integrationAuthorities.integrationId, [legacyId, quotaId]),
				),
			)
			.run();
	};
	beforeEach(clearFixtureAuthorities);
	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.shutdown();
		clearFixtureAuthorities();
	});

	function managerFor(root: string, options: ConstructorParameters<typeof PluginManager>[0] = {}) {
		const manager = makeManager({
			root,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			...options,
		});
		managers.push(manager);
		return manager;
	}

	async function oldBuiltin(root: string) {
		const source = await makePackage(root, legacyId, (manifest) => {
			manifest.activationEvents = ["onCommand:hello"];
			(manifest.permissions as Record<string, unknown>).host = ["provider.use"];
		});
		const storeRoot = join(root, "store");
		const manager = managerFor(storeRoot, {
			catalog: new PluginCatalog({ root: storeRoot, builtinRoots: [source] }),
		});
		await manager.initialize();
		expect((await manager.getStatus(legacyId))?.desiredState).toBe("enabled");
		expect(
			(await manager.getPermissions(legacyId)).grants.map((grant) => grant.capability),
		).toEqual(["provider.use"]);
		return { manager, storeRoot };
	}

	test("without old or replacement history the quota archive is installed and enabled normally", async () => {
		const root = await makeTempRoot();
		const manager = managerFor(join(root, "store"));
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toMatchObject({
			desiredState: "enabled",
			runtimeState: "active",
			builtin: false,
			current: { version: "1.0.2" },
		});
		expect(await manager.stateStore.getBundledBootstrap(legacyId)).toBeUndefined();
		expect(fixture.loadCount()).toBe(1);
	}, 15_000);

	test("an explicit old builtin disable suppresses the replacement across restart and old-state removal", async () => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		await old.disable(legacyId);
		const grants = (await old.getPermissions(legacyId)).grants;
		await old.shutdown();
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		const manager = managerFor(storeRoot);
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect(fixture.loadCount()).toBe(0);
		expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
		expect(await manager.stateStore.getState(quotaId)).toBeUndefined();
		expect(await manager.integrationAuthorityService.listAuthorities(quotaId)).toEqual([]);
		expect((await manager.getPermissions(legacyId)).grants).toEqual(grants);
		const refusal = await manager.stateStore.getBundledBootstrap(quotaId);
		expect(refusal).toMatchObject({
			status: "removed",
			defaultChoice: "disabled",
			inheritedFrom: legacyId,
			version: "1.0.2",
		});
		await manager.stateStore.removeState(legacyId);
		await manager.shutdown();
		const reloaded = managerFor(storeRoot);
		expect(await reloaded.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect(await reloaded.stateStore.getBundledBootstrap(quotaId)).toEqual(refusal);
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);

	test("a pre-ledger disabled state is captured before missing-package reconciliation", async () => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		// Existing hosts persisted desiredState without a bundled ledger.
		await old.stateStore.updateState(legacyId, {
			desiredState: "disabled",
			runtimeState: "inactive",
		});
		expect(await old.stateStore.getBundledBootstrap(legacyId)).toBeUndefined();
		await old.shutdown();
		const manager = managerFor(storeRoot);
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect((await manager.stateStore.getBundledBootstrap(legacyId))?.defaultChoice).toBe(
			"disabled",
		);
		expect((await manager.stateStore.getBundledBootstrap(quotaId))?.inheritedFrom).toBe(legacyId);
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);

	test("an enabled old builtin still permits first defaults after shutdown before bootstrap, without grant copying", async () => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		const oldState = await old.getStatus(legacyId);
		const grants = (await old.getPermissions(legacyId)).grants;
		await old.shutdown();
		const first = managerFor(storeRoot);
		await first.initialize();
		expect((await first.stateStore.getState(legacyId))?.desiredState).toBe("disabled");
		expect((await first.stateStore.getBundledBootstrap(legacyId))?.defaultChoice).toBe("enabled");
		await first.shutdown();
		const manager = managerFor(storeRoot);
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toMatchObject({
			desiredState: "enabled",
			runtimeState: "active",
			current: { version: "1.0.2" },
		});
		const newState = await manager.stateStore.getState(quotaId);
		expect(newState?.installationId).not.toBe(oldState?.installationId);
		const newGrants = (await manager.getPermissions(quotaId)).grants;
		expect(newGrants.map((grant) => grant.capability).sort()).toEqual([
			"provider.connection.request",
			"quota.provide",
		]);
		expect(newGrants.every((grant) => grant.grantedBy === "system")).toBe(true);
		expect(
			newGrants.some((grant) => grants.some((oldGrant) => oldGrant.grantId === grant.grantId)),
		).toBe(false);
		expect((await manager.getPermissions(legacyId)).grants).toEqual(grants);
		expect((await manager.stateStore.getBundledBootstrap(quotaId))?.status).toBe("seeded");
		expect(fixture.loadCount()).toBe(1);
	}, 15_000);

	test("a retired hash authority does not override the enabled canonical installation", async () => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		const legacyHash = "a".repeat(64);
		await old.integrationAuthorityService.ensureInstallation(legacyId, legacyHash, {
			count: 1,
			capabilities: ["provider.use"],
			revision: 1,
			updatedAt: new Date().toISOString(),
		});
		await integrationAuthorityService.revoke({
			authorityId: pluginInstallationAuthorityId(legacyId, legacyHash),
			reason: "test legacy hash authority retired",
		});
		await old.shutdown();
		const manager = managerFor(storeRoot);
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toMatchObject({
			desiredState: "enabled",
			runtimeState: "active",
		});
		expect(fixture.loadCount()).toBe(1);
	}, 15_000);

	test("ambiguous active legacy authorities fail closed before any archive is loaded", async () => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		await old.integrationAuthorityService.ensureInstallation(legacyId, randomUUID(), {
			count: 1,
			capabilities: ["provider.use"],
			revision: 1,
			updatedAt: new Date().toISOString(),
		});
		await old.shutdown();
		const manager = managerFor(storeRoot);
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		await expect(manager.bootstrapBundledPlugin(fixture.descriptor)).rejects.toMatchObject({
			code: "PLUGIN_LEGACY_QUOTA_AUTHORIZATION_AMBIGUOUS",
		});
		expect(fixture.loadCount()).toBe(0);
		expect(await manager.stateStore.getBundledBootstrap(quotaId)).toBeUndefined();
		expect(await manager.integrationAuthorityService.listAuthorities(quotaId)).toEqual([]);
	}, 15_000);

	test("a refusal commit failure cannot fall through to install and does not leak cached metadata", async () => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		await old.disable(legacyId);
		await old.shutdown();
		let failRefusal = true;
		const store = new PluginStateStore({
			root: storeRoot,
			renameFile: async (from, to) => {
				const value = JSON.parse(await readFile(from, "utf8"));
				if (failRefusal && value.bundledBootstrap?.[quotaId]?.inheritedFrom) {
					throw new Error("injected refusal commit failure");
				}
				await rename(from, to);
			},
		});
		const manager = managerFor(storeRoot, { stateStore: store });
		await manager.initialize();
		const before = await readFile(store.statePath, "utf8");
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		await expect(manager.bootstrapBundledPlugin(fixture.descriptor)).rejects.toThrow(
			"refusal commit failure",
		);
		expect(await readFile(store.statePath, "utf8")).toBe(before);
		expect(await store.getBundledBootstrap(quotaId)).toBeUndefined();
		expect((await manager.packageStore.readCurrent()).plugins).toEqual({});
		expect(fixture.loadCount()).toBe(0);
		failRefusal = false;
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect(
			(await new PluginStateStore(storeRoot).getBundledBootstrap(quotaId))?.defaultChoice,
		).toBe("disabled");
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);

	test("an old uninstall stays removed under the replacement ID", async () => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		await old.uninstall(legacyId);
		await old.shutdown();
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		const manager = managerFor(storeRoot);
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect((await manager.stateStore.getBundledBootstrap(quotaId))?.defaultChoice).toBe("removed");
		expect(await manager.stateStore.getState(quotaId)).toBeUndefined();
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);

	test.each([
		"authority",
		"provider-use-grant",
	] as const)("an old %s revocation is not repaired by an automatic ID replacement", async (revocation) => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		if (revocation === "authority") {
			await old.integrationAuthorityService.revokePlugin(
				legacyId,
				"test operator revoked quota authorization",
			);
			await old.stateStore.removeState(legacyId);
		} else {
			const permissions = await old.getPermissions(legacyId);
			await old.revokePermissions(legacyId, {
				grantIds: permissions.grants.map((grant) => grant.grantId),
				expectedRevision: permissions.revision,
				grantedBy: "test-admin",
			});
			expect((await old.stateStore.getState(legacyId))?.desiredState).toBe("enabled");
		}
		await old.shutdown();
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		const manager = managerFor(storeRoot);
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		expect((await manager.stateStore.getBundledBootstrap(quotaId))?.defaultChoice).toBe("revoked");
		expect(await manager.integrationAuthorityService.listAuthorities(quotaId)).toEqual([]);
		expect(await manager.permissionStore.listSets(quotaId)).toEqual([]);
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);

	test.each([
		"disabled",
		"enabled",
		"removed",
		"revoked",
		"disposition",
	] as const)("the replacement's own %s history wins over an old disable", async (history) => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		await old.disable(legacyId);
		await old.shutdown();
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		const manager = managerFor(storeRoot);
		let before = await manager.stateStore.getBundledBootstrap(quotaId);
		if (history === "removed" || history === "disposition") {
			before = await manager.stateStore.setBundledBootstrap(quotaId, {
				status: history === "removed" ? "removed" : "seeded",
				version: "1.0.1",
				archiveSha256: null,
			});
		} else {
			await manager.install(new File([fixture.bytes], "explicit-quota.nfplugin"));
			if (history === "enabled") {
				await manager.enable(quotaId);
				await manager.activate(quotaId);
			}
			if (history === "revoked")
				await manager.integrationAuthorityService.revokePlugin(
					quotaId,
					"test explicit replacement revocation",
				);
		}
		const state = await manager.stateStore.getState(quotaId);
		const permissions = await manager.permissionStore.listSets(quotaId);
		const result = await manager.bootstrapBundledPlugin(fixture.descriptor);
		if (state) {
			expect(result?.current).toEqual(state.current);
			expect(result?.desiredState).toBe(state.desiredState);
			expect(result?.installationId).toBe(state.installationId);
			expect(await manager.permissionStore.listSets(quotaId)).toEqual(permissions);
			expect((await manager.stateStore.getBundledBootstrap(quotaId))?.status).toBe("adopted");
		} else {
			expect(result).toBeNull();
			expect(await manager.stateStore.getBundledBootstrap(quotaId)).toEqual(before);
		}
		expect((await manager.stateStore.getBundledBootstrap(quotaId))?.inheritedFrom).toBeUndefined();
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);

	test("an explicit replacement reinstall can override inherited refusal without restoring provider.use", async () => {
		const root = await makeTempRoot();
		const { manager: old, storeRoot } = await oldBuiltin(root);
		await old.disable(legacyId);
		await old.shutdown();
		const fixture = await makeBundledFixture(await makeTempRoot(), quotaId, "1.0.2");
		const manager = managerFor(storeRoot);
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		await manager.install(new File([fixture.bytes], "explicit-reinstall.nfplugin"));
		await manager.enable(quotaId);
		await manager.activate(quotaId);
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toMatchObject({
			desiredState: "enabled",
			runtimeState: "active",
		});
		expect(
			(await manager.getPermissions(quotaId)).grants.map((grant) => grant.capability).sort(),
		).toEqual(["provider.connection.request", "quota.provide"]);
		await manager.shutdown();
		const reloaded = managerFor(storeRoot);
		expect(await reloaded.bootstrapBundledPlugin(fixture.descriptor)).toMatchObject({
			desiredState: "enabled",
			runtimeState: "active",
		});
		expect(fixture.loadCount()).toBe(0);
	}, 15_000);
});

describe("plugin sources and controlled updates", () => {
	const sourceHint = {
		type: "github" as const,
		owner: "example",
		repo: "plugin",
		assetName: "plugin-{version}.nfplugin",
	};
	async function sourcePackage(
		root: string,
		pluginId: string,
		version: string,
		hint: typeof sourceHint | null = sourceHint,
		change?: (manifest: Record<string, unknown>) => void,
	) {
		const source = await makePackage(root, pluginId, (manifest) => {
			manifest.version = version;
			manifest.activationEvents = ["onStartup"];
			(manifest.permissions as Record<string, unknown>).host = ["diagnostics.readOwnLogs"];
			(manifest.contributes as Record<string, unknown>).providers = [
				{ id: "relay", title: "Relay" },
			];
			change?.(manifest);
		});
		if (hint)
			await writeFile(
				join(source, "plugin-source.json"),
				JSON.stringify({ schemaVersion: 1, pluginId, source: hint }),
			);
		else await rm(join(source, "plugin-source.json"), { force: true });
		return source;
	}
	async function fixture(
		pluginId: string,
		enabled = true,
		change?: (manifest: Record<string, unknown>) => void,
	) {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
			runtimeOptionsFactory: (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				command: ["fixture-runtime", context.package.hash],
				cwd: context.packagePath,
			}),
		});
		await manager.install(await sourcePackage(root, pluginId, "1.0.0", sourceHint, change));
		await manager.stateStore.updateState(pluginId, {
			providerConfigs: { relay: { note: "saved" } },
			providerPrefixes: { relay: "saved_prefix" },
			providerProxies: { relay: { mode: "system" } },
		});
		if (enabled) {
			await manager.enable(pluginId);
			await manager.activate(pluginId);
		}
		const state = await manager.stateStore.getState(pluginId);
		if (!state?.current || !state.installationId)
			throw new Error("missing actual fixture installation");
		return {
			root,
			supervisor,
			manager,
			state: { ...state, current: state.current, installationId: state.installationId },
			options: {
				pluginId,
				expectedCurrent: state.current,
				expectedInstallationId: state.installationId,
				expectedSourceRevision: state.sourceBinding?.revision ?? 0,
				expectedVersion: "2.0.0",
				automatic: false,
			},
		};
	}

	test("old packages without source retain ordinary runtime operations and cannot auto-update", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.old-source-optional";
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.install(await makePackage(root, pluginId));
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		expect(await manager.getSource(pluginId)).toMatchObject({
			binding: { revision: 0, mode: "inherit", source: null, autoUpdate: false },
			declaredSource: null,
			origin: "none",
		});
		await expect(
			manager.setAutoUpdate(pluginId, true, { expectedRevision: 0 }),
		).rejects.toMatchObject({ code: "PLUGIN_SOURCE_REQUIRED" });
		expect((await manager.getStatus(pluginId))?.runtimeState).toBe("active");
		expect(manager.getHostApiVersion()).toBeString();
		expect(manager.getHostApiVersion().length).toBeGreaterThan(0);
	});

	test("invalid source metadata is isolated from a valid installed runtime", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.invalid-source-optional";
		const source = await makePackage(root, pluginId);
		await writeFile(join(source, "plugin-source.json"), "{broken");
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		await manager.install(source);
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		const view = await manager.getSource(pluginId);
		expect(view.binding.source).toBeNull();
		expect(view.diagnostics[0]?.code).toBe("SOURCE_INVALID");
		expect((await manager.getStatus(pluginId))?.runtimeState).toBe("active");
	});

	test("source selection and auto preference use durable revisions and notify invalidation", async () => {
		const f = await fixture("com.example.source-revisions");
		const events: string[] = [];
		const unsubscribe = f.manager.onSourceChanged((id) => events.push(id));
		const configured = {
			...sourceHint,
			repo: "configured",
			homepage: "https://example.test/plugin",
		};
		await f.manager.setSource(f.state.pluginId, configured, { expectedRevision: 0 });
		await expect(
			f.manager.setAutoUpdate(f.state.pluginId, true, { expectedRevision: 0 }),
		).rejects.toMatchObject({ code: "PLUGIN_SOURCE_REVISION_CONFLICT" });
		const auto = await f.manager.setAutoUpdate(f.state.pluginId, true, { expectedRevision: 1 });
		expect(auto.binding).toMatchObject({
			revision: 2,
			mode: "configured",
			source: configured,
			autoUpdate: true,
		});
		expect(
			(await new PluginStateStore(f.manager.root).getState(f.state.pluginId))?.sourceBinding,
		).toEqual(auto.binding);
		await f.manager.setSource(f.state.pluginId, null, { expectedRevision: 2 });
		expect(await f.manager.getSource(f.state.pluginId)).toMatchObject({
			binding: { revision: 3, mode: "none", source: null, autoUpdate: false },
			declaredSource: sourceHint,
			origin: "none",
		});
		expect(events).toEqual([f.state.pluginId, f.state.pluginId, f.state.pluginId]);
		unsubscribe();
	});

	test.each([
		true,
		false,
	])("source update preserves enabled=%s, UUID, config and grants without adopting new source hints", async (enabled) => {
		const f = await fixture(`com.example.source-state-${enabled}`, enabled);
		const permissions = await f.manager.getPermissions(f.state.pluginId);
		const auto = await f.manager.setAutoUpdate(f.state.pluginId, true, { expectedRevision: 0 });
		const nextHint = { ...sourceHint, repo: "unapproved-new-source" };
		const next = await sourcePackage(f.root, f.state.pluginId, "2.0.0", nextHint);
		const updated = await f.manager.updateFromSource(next, {
			...f.options,
			expectedSourceRevision: auto.binding.revision,
			automatic: true,
		});
		expect(updated.current?.version).toBe("2.0.0");
		expect(updated.desiredState).toBe(enabled ? "enabled" : "disabled");
		expect(updated.runtimeState).toBe(enabled ? "active" : "inactive");
		expect(updated.installationId).toBe(f.state.installationId);
		expect(updated.providerConfigs).toEqual(f.state.providerConfigs);
		expect(updated.providerPrefixes).toEqual(f.state.providerPrefixes);
		expect(updated.providerProxies).toEqual(f.state.providerProxies);
		expect((await f.manager.getPermissions(f.state.pluginId)).grants).toEqual(permissions.grants);
		expect(await f.manager.getSource(f.state.pluginId)).toMatchObject({
			binding: auto.binding,
			declaredSource: nextHint,
		});
		expect(f.supervisor.startCount.get(f.state.pluginId) ?? 0).toBe(enabled ? 2 : 0);
	});

	test.each([
		"current",
		"revision",
		"installation",
		"version",
	] as const)("stale %s source candidates never publish or stop the current runtime", async (conflict) => {
		const f = await fixture(`com.example.source-conflict-${conflict}`);
		const next = await sourcePackage(f.root, f.state.pluginId, "2.0.0");
		const options = { ...f.options };
		if (conflict === "current")
			options.expectedCurrent = { version: "0.9.0", hash: "a".repeat(64) };
		if (conflict === "revision") options.expectedSourceRevision = 9;
		if (conflict === "installation") options.expectedInstallationId = randomUUID();
		if (conflict === "version") options.expectedVersion = "3.0.0";
		await expect(f.manager.updateFromSource(next, options)).rejects.toThrow();
		expect((await f.manager.packageStore.readCurrent()).plugins[f.state.pluginId]).toEqual(
			f.state.current,
		);
		expect(f.supervisor.get(f.state.pluginId)?.state).toBe("active");
		expect(f.supervisor.startCount.get(f.state.pluginId)).toBe(1);
	});

	test.each([
		"host",
		"runner",
		"network",
		"filesystem",
		"process",
		"secrets",
		"dependencies",
		"signature",
	] as const)("automatic %s trust changes require manual confirmation before current changes", async (change) => {
		const f = await fixture(`com.example.source-growth-${change}`);
		const auto = await f.manager.setAutoUpdate(f.state.pluginId, true, { expectedRevision: 0 });
		const next = await sourcePackage(f.root, f.state.pluginId, "2.0.0", sourceHint, (manifest) => {
			const permissions = manifest.permissions as Record<string, unknown>;
			if (change === "host") permissions.host = ["diagnostics.readOwnLogs", "provider.use"];
			if (change === "runner") (manifest.engine as Record<string, unknown>).runner = "podman";
			if (change === "network")
				permissions.network = { mode: "allowlist", allow: ["api.example.test"] };
			if (change === "filesystem") permissions.filesystem = { workspace: "readWrite" };
			if (change === "process") permissions.process = { spawn: "declared" };
			if (change === "secrets")
				manifest.secrets = [
					{
						id: "api-key",
						label: "API key",
						required: false,
						scope: ["user"],
						usage: "outbound-network",
						inject: "ephemeral-reference",
					},
				];
			if (change === "dependencies")
				(manifest.dependencies as Record<string, unknown>).runtime = { dependency: "^2.0.0" };
		});
		if (change === "signature")
			await writeFile(
				join(next, "signature.json"),
				JSON.stringify({
					algorithm: "ed25519",
					keyId: "new-key",
					signature: "unused-test-value",
					pluginId: f.state.pluginId,
					version: "2.0.0",
					packageDigest: "a".repeat(64),
				}),
			);
		const permissions = await f.manager.getPermissions(f.state.pluginId);
		await expect(
			f.manager.updateFromSource(next, {
				...f.options,
				expectedSourceRevision: auto.binding.revision,
				automatic: true,
				allowTrustChange: true,
			}),
		).rejects.toMatchObject({ code: "PLUGIN_UPDATE_MANUAL_REQUIRED" });
		expect((await f.manager.packageStore.readCurrent()).plugins[f.state.pluginId]).toEqual(
			f.state.current,
		);
		expect((await f.manager.getPermissions(f.state.pluginId)).grants).toEqual(permissions.grants);
		expect(f.supervisor.get(f.state.pluginId)?.state).toBe("active");
	});

	test.each([
		"add",
		"match",
		"path",
		"auth",
		"headers",
	] as const)("quota %s declarations cannot expand an already granted connection through automatic update", async (change) => {
		const declaration = {
			id: "quota",
			title: "Quota",
			match: { hosts: ["quota.example.test"] },
			requests: [{ path: "/usage", auth: "bearer", headers: ["accept"] }],
		};
		const baseline = (manifest: Record<string, unknown>) => {
			(manifest.permissions as Record<string, unknown>).host = [
				"quota.provide",
				"provider.connection.request",
			];
			(manifest.contributes as Record<string, unknown>).quotaSources = [declaration];
		};
		const f = await fixture(`com.example.source-quota-${change}`, true, baseline);
		const auto = await f.manager.setAutoUpdate(f.state.pluginId, true, { expectedRevision: 0 });
		const next = await sourcePackage(f.root, f.state.pluginId, "2.0.0", sourceHint, (manifest) => {
			baseline(manifest);
			const changed = structuredClone(declaration);
			if (change === "match") changed.match.hosts = ["another.example.test"];
			if (change === "path") changed.requests[0].path = "/api/user/self";
			if (change === "auth") changed.requests[0].auth = "site-token";
			if (change === "headers") changed.requests[0].headers.push("user-agent");
			(manifest.contributes as Record<string, unknown>).quotaSources =
				change === "add" ? [declaration, { ...changed, id: "second-quota" }] : [changed];
		});
		const permissions = await f.manager.getPermissions(f.state.pluginId);
		const options = { ...f.options, expectedSourceRevision: auto.binding.revision };
		await expect(
			f.manager.updateFromSource(next, { ...options, automatic: true, allowTrustChange: true }),
		).rejects.toMatchObject({ code: "PLUGIN_UPDATE_MANUAL_REQUIRED" });
		await expect(f.manager.updateFromSource(next, options)).rejects.toMatchObject({
			code: "PLUGIN_UPDATE_MANUAL_REQUIRED",
		});
		expect((await f.manager.packageStore.readCurrent()).plugins[f.state.pluginId]).toEqual(
			f.state.current,
		);
		expect(f.supervisor.get(f.state.pluginId)?.state).toBe("active");
		expect((await f.manager.getPermissions(f.state.pluginId)).grants).toEqual(permissions.grants);
		const accepted = await f.manager.updateFromSource(next, { ...options, allowTrustChange: true });
		expect(accepted.current?.version).toBe("2.0.0");
		expect((await f.manager.getPermissions(f.state.pluginId)).grants).toEqual(permissions.grants);
	}, 20000);

	test("manual trust-change confirmation still withholds new capabilities instead of granting them", async () => {
		const f = await fixture("com.example.source-manual-growth");
		const permissions = await f.manager.getPermissions(f.state.pluginId);
		const next = await sourcePackage(f.root, f.state.pluginId, "2.0.0", sourceHint, (manifest) => {
			(manifest.permissions as Record<string, unknown>).host = [
				"diagnostics.readOwnLogs",
				"provider.use",
			];
		});
		await expect(f.manager.updateFromSource(next, f.options)).rejects.toMatchObject({
			code: "PLUGIN_UPDATE_MANUAL_REQUIRED",
		});
		expect(
			await f.manager.updateFromSource(next, { ...f.options, allowTrustChange: true }),
		).toMatchObject({ desiredState: "enabled", runtimeState: "active" });
		expect((await f.manager.getPermissions(f.state.pluginId)).grants).toEqual(permissions.grants);
		expect(
			(await f.manager.listPendingPermissionRequests(f.state.pluginId)).some(
				(request) => request.capability === "provider.use",
			),
		).toBe(true);
	});

	test("cancellation during real package staging keeps old current and never enters commit", async () => {
		const f = await fixture("com.example.source-precommit-cancel");
		const next = await sourcePackage(f.root, f.state.pluginId, "2.0.0");
		const entered = deferred();
		const release = deferred();
		const controller = new AbortController();
		const original = f.manager.catalog.scan.bind(f.manager.catalog);
		const staging = spyOn(f.manager.catalog, "scan").mockImplementation(async () => {
			const scanned = await original();
			entered.resolve();
			await release.promise;
			return scanned;
		});
		let commits = 0;
		const result = f.manager
			.updateFromSource(next, {
				...f.options,
				signal: controller.signal,
				onCommit: () => commits++,
			})
			.then(
				() => ({ ok: true }),
				(error: unknown) => ({ ok: false, error }),
			);
		try {
			await entered.promise;
			controller.abort(new Error("test source cancellation"));
			release.resolve();
			expect(await result).toMatchObject({ ok: false, error: expect.any(Error) });
			expect(commits).toBe(0);
			expect((await f.manager.packageStore.readCurrent()).plugins[f.state.pluginId]).toEqual(
				f.state.current,
			);
			expect(f.supervisor.get(f.state.pluginId)?.state).toBe("active");
		} finally {
			release.resolve();
			await result;
			staging.mockRestore();
		}
	});

	test("request cancellation at the commit hook does not misreport a successful source update as cancelled", async () => {
		const f = await fixture("com.example.source-postcommit-cancel");
		const next = await sourcePackage(f.root, f.state.pluginId, "2.0.0");
		const controller = new AbortController();
		let commits = 0;
		const result = await f.manager.updateFromSource(next, {
			...f.options,
			signal: controller.signal,
			onCommit: () => {
				commits++;
				controller.abort(new Error("too late to cancel publication"));
			},
		});
		expect(commits).toBe(1);
		expect(result).toMatchObject({ current: { version: "2.0.0" }, runtimeState: "active" });
	});

	test("activation failure rolls back pointer, desired state, config, UUID and grants", async () => {
		const f = await fixture("com.example.source-activation-rollback");
		const permissions = await f.manager.getPermissions(f.state.pluginId);
		const original = f.supervisor.start.bind(f.supervisor);
		const start = spyOn(f.supervisor, "start").mockImplementation(
			async (options: PluginRuntimeOptions | string, signal?: AbortSignal) => {
				if (typeof options !== "string" && options.pluginVersion === "2.0.0") {
					f.supervisor.register(options);
					throw new PluginRuntimeError("test new-version handshake failure", {
						code: "HELLO_PLUGIN_ID_MISMATCH",
						phase: "hello",
						kind: "handshake",
					});
				}
				return typeof options === "string" ? original(options, signal) : original(options, signal);
			},
		);
		try {
			const next = await sourcePackage(f.root, f.state.pluginId, "2.0.0");
			await expect(f.manager.updateFromSource(next, f.options)).rejects.toThrow(
				"test new-version handshake failure",
			);
			const restored = await f.manager.stateStore.getState(f.state.pluginId);
			expect((await f.manager.packageStore.readCurrent()).plugins[f.state.pluginId]).toEqual(
				f.state.current,
			);
			expect(restored).toMatchObject({
				current: f.state.current,
				desiredState: "enabled",
				runtimeState: "active",
				installationId: f.state.installationId,
				providerConfigs: f.state.providerConfigs,
				sourceBinding: f.state.sourceBinding,
			});
			expect((await f.manager.getPermissions(f.state.pluginId)).grants).toEqual(permissions.grants);
			expect(f.supervisor.get(f.state.pluginId)?.options.pluginVersion).toBe("1.0.0");
			expect(
				(await f.manager.stateStore.listOperations(f.state.pluginId)).some(
					(operation) => operation.operation === "upgrade" && operation.status === "rolled_back",
				),
			).toBe(true);
		} finally {
			start.mockRestore();
		}
	});

	test("an interrupted source switch restores the journal's approved old state on restart", async () => {
		const f = await fixture("com.example.source-restart-rollback");
		await f.manager.shutdown();
		const checkpoint = await f.manager.stateStore.getState(f.state.pluginId);
		if (!checkpoint?.current) throw new Error("missing durable checkpoint");
		const staged = await f.manager.packageStore.install(
			await sourcePackage(f.root, f.state.pluginId, "2.0.0"),
			{ updateCurrent: false },
		);
		const next = { version: staged.version, hash: staged.hash };
		const operation = await f.manager.stateStore.beginOperation({
			pluginId: f.state.pluginId,
			operation: "upgrade",
			status: "running",
			context: {
				from: checkpoint.current,
				to: next,
				sourceUpdate: true,
				rollbackState: JSON.parse(JSON.stringify(checkpoint)),
			},
		});
		await f.manager.packageStore.setCurrent(f.state.pluginId, next, {
			expectedCurrent: checkpoint.current,
		});
		await f.manager.stateStore.updateState(f.state.pluginId, {
			current: next,
			desiredState: "disabled",
			providerConfigs: {},
			sourceBinding: { revision: 9, mode: "none", source: null, autoUpdate: false },
		});
		const supervisor = new FakeSupervisor();
		const reloaded = makeManager({
			root: f.manager.root,
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		await reloaded.initialize();
		expect((await reloaded.packageStore.readCurrent()).plugins[f.state.pluginId]).toEqual(
			checkpoint.current,
		);
		expect(await reloaded.stateStore.getState(f.state.pluginId)).toMatchObject({
			desiredState: "enabled",
			runtimeState: "active",
			installationId: checkpoint.installationId,
			providerConfigs: checkpoint.providerConfigs,
			sourceBinding: checkpoint.sourceBinding,
		});
		expect((await reloaded.stateStore.getOperation(operation.id))?.status).toBe("rolled_back");
		expect(supervisor.get(f.state.pluginId)?.options.pluginVersion).toBe("1.0.0");
	});

	test("builtin installation is an explicit ordinary reinstallation after uninstall, not bootstrap resurrection", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.explicit-builtin", "1.0.3");
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		await manager.bootstrapBundledPlugin(fixture.descriptor);
		const oldId = (await manager.stateStore.getState(fixture.descriptor.pluginId))?.installationId;
		await manager.uninstall(fixture.descriptor.pluginId);
		expect(await manager.bootstrapBundledPlugin(fixture.descriptor)).toBeNull();
		let commits = 0;
		const result = await manager.installBuiltin(fixture.descriptor, { onCommit: () => commits++ });
		expect(result).toMatchObject({
			desiredState: "enabled",
			runtimeState: "active",
			current: { version: "1.0.3" },
		});
		expect(result.installationId).not.toBe(oldId);
		expect(commits).toBe(1);
		expect(
			(await manager.getPermissions(fixture.descriptor.pluginId)).grants.some(
				(grant) => grant.capability === "provider.use",
			),
		).toBe(false);
	});

	test("invalid builtin payloads and downgrades do not stop an already active plugin", async () => {
		const root = await makeTempRoot();
		const fixture = await makeBundledFixture(root, "com.example.builtin-guard", "2.0.0");
		const supervisor = new FakeSupervisor();
		const manager = makeManager({
			root: join(root, "store"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		await manager.bootstrapBundledPlugin(fixture.descriptor);
		await expect(
			manager.installBuiltin({
				...fixture.descriptor,
				load: async () => ({ bytes: fixture.bytes, sha256: "0".repeat(64) }),
			}),
		).rejects.toMatchObject({ code: "PLUGIN_BUNDLED_INTEGRITY_FAILED" });
		await expect(
			manager.installBuiltin({ ...fixture.descriptor, version: "1.0.3" }),
		).rejects.toMatchObject({ code: "PLUGIN_UPDATE_NOT_NEWER" });
		expect(supervisor.get(fixture.descriptor.pluginId)?.state).toBe("active");
		expect(supervisor.startCount.get(fixture.descriptor.pluginId)).toBe(1);
	});
});
