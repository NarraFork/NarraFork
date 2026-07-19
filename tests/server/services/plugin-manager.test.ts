import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginHostDispatcher } from "@server/services/plugin-host-dispatcher";
import { PluginHostServices } from "@server/services/plugin-host-services";
import { PluginManager, type PluginRuntimeSupervisorLike } from "@server/services/plugin-manager";
import { PluginPermissionStore } from "@server/services/plugin-permission-store";
import { createPluginPlatformServices } from "@server/services/plugin-platform-services";
import { PodmanRunner } from "@server/services/plugin-podman-runner";
import {
	LocalProcessRunner,
	PluginRuntimeError,
	type PluginRuntimeOptions,
	type RuntimeDiagnostics,
	type RuntimeState,
} from "@server/services/plugin-runtime";
import { PluginStateStore } from "@server/services/plugin-state-store";

const fixturePackage = fileURLToPath(
	new URL("../../fixtures/plugins/packages/valid-package", import.meta.url),
);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-manager-"));
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		if (existing) return existing;
		const runtime = new FakeRuntime(options);
		this.runtimes.set(options.pluginId, runtime);
		return runtime;
	}

	async start(options: PluginRuntimeOptions): Promise<FakeRuntime>;
	async start(pluginId: string, signal?: AbortSignal): Promise<FakeRuntime>;
	async start(optionsOrPluginId: PluginRuntimeOptions | string): Promise<FakeRuntime> {
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

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginManager", () => {
	test("installs without executing entry and supports idempotent lifecycle operations", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const source = await makePackage(root, "com.example.lifecycle");
		const supervisor = new FakeSupervisor();
		const revokedUiSessions: string[] = [];
		const manager = new PluginManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: supervisor,
			revokeUiSessions: (pluginId) => {
				revokedUiSessions.push(pluginId);
			},
		});

		const installed = await manager.install(source);
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
		expect(revokedUiSessions).toEqual([installed.pluginId, installed.pluginId]);
		expect(await manager.getStatus(installed.pluginId)).toBeUndefined();
		expect((await manager.packageStore.readCurrent()).plugins[installed.pluginId]).toBeUndefined();
		expect((await manager.stateStore.listOperations(installed.pluginId)).at(-1)?.status).toBe(
			"succeeded",
		);
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
		const manager = new PluginManager({
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
		await stateStore.updateState(pluginId, { trustTier: "T2" });
		const granted = await manager.replacePermissions(pluginId, {
			expectedRevision: 0,
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
		expect(granted.permissions.revision).toBe(1);

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
				installationId: installed.current.hash,
				runtimeId: runtime.runtimeId,
				runtimeGeneration: 1,
			},
			grantRevision: 1,
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
		expect(healed.permissions.revision).toBe(1);
		expect(hostServices.getRuntimeBinding(pluginId, runtime.runtimeId)?.dispatcher).toBe(
			binding.dispatcher,
		);

		const revoked = await manager.replacePermissions(pluginId, {
			expectedRevision: 1,
			grantedBy: "admin-user-1",
			grants: [],
		});
		expect(revoked.permissions).toMatchObject({ revision: 2, grants: [] });
		const refreshed = hostServices.getRuntimeBinding(pluginId, runtime.runtimeId);
		expect(refreshed?.grantRevision).toBe(2);
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

	test("copies complete grants to a new package without widening scope during upgrade", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.permission-upgrade";
		const manager = new PluginManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await manager.install(await makePackage(root, pluginId));
		if (!installed.current) throw new Error("Installed plugin has no current package");
		await manager.replacePermissions(pluginId, {
			expectedRevision: 0,
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
		const upgraded = await manager.install(
			await makePackage(root, pluginId, (manifest) => {
				manifest.version = "2.0.0";
			}),
		);
		if (!upgraded.current) throw new Error("Upgraded plugin has no current package");
		expect(upgraded.current.hash).not.toBe(installed.current.hash);
		const permissions = await manager.getPermissions(pluginId);
		expect(permissions).toMatchObject({
			installationId: upgraded.current.hash,
			revision: 1,
			grants: [
				{
					grantId: "grant-upgrade-project",
					capability: "query.read.projects",
					scope: { type: "project", id: "project-1" },
					constraints: { fields: ["id"], resourceIds: ["project-1"] },
					expiresAt: "2026-08-18T12:00:00.000Z",
					grantedBy: "admin-user-1",
					revision: 1,
				},
			],
		});
		expect(await manager.permissionStore.listSets(pluginId)).toHaveLength(2);
	});

	test("rejects enabling an incompatible package", async () => {
		const root = await makeTempRoot();
		const source = await makePackage(root, "com.example.incompatible", (manifest) => {
			const engine = manifest.engine as Record<string, unknown>;
			engine.os = [process.platform === "linux" ? "darwin" : "linux"];
		});
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
		});
		const pluginA = await manager.install(await makePackage(root, "com.example.concurrencya"));
		const pluginB = await manager.install(await makePackage(root, "com.example.concurrencyb"));
		await Promise.all([manager.enable(pluginA.pluginId), manager.enable(pluginB.pluginId)]);
		const gate = supervisor.gate(pluginA.pluginId);
		const firstA = manager.activate(pluginA.pluginId);
		await gate.entered;
		const secondA = manager.activate(pluginA.pluginId);
		await sleep(10);
		expect(supervisor.startCount.get(pluginA.pluginId)).toBe(1);

		const statusB = await Promise.race([
			manager.activate(pluginB.pluginId),
			sleep(250).then(() => {
				throw new Error("plugin B was blocked by plugin A");
			}),
		]);
		expect(statusB.runtimeState).toBe("active");
		gate.release();
		const [statusA1, statusA2] = await Promise.all([firstA, secondA]);
		expect(statusA1.runtimeState).toBe("active");
		expect(statusA2.runtimeState).toBe("active");
		expect(supervisor.startCount.get(pluginA.pluginId)).toBe(1);
	});

	test("recovers incomplete journal operations by disabling automatic activation", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const first = new PluginManager({
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

		const recovered = new PluginManager({
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
		const first = new PluginManager({
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

		const recovered = new PluginManager({
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
		const first = new PluginManager({
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

		const recovered = new PluginManager({
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
		const localManager = new PluginManager({
			root: join(root, "local-plugins"),
			disabled: false,
			runtimeSupervisor: localSupervisor,
		});
		const local = await localManager.install(await makePackage(root, "com.example.local-runner"));
		await localManager.enable(local.pluginId);
		await localManager.activate(local.pluginId);
		expect(localSupervisor.get(local.pluginId)?.options.runner).toBeInstanceOf(LocalProcessRunner);

		const podmanSupervisor = new FakeSupervisor();
		const podmanManager = new PluginManager({
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
		const unavailableManager = new PluginManager({
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
	});

	test("fails closed for T3 activation and required signature policy", async () => {
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = new PluginManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
			trustPolicy: { enabled: true },
		});
		const unapproved = await manager.install(await makePackage(root, "com.example.unapproved"));
		await manager.enable(unapproved.pluginId);
		await expect(manager.activate(unapproved.pluginId)).rejects.toMatchObject({
			code: "PLUGIN_TRUST_REQUIRED",
		});

		const requiredSignature = new PluginManager({
			root: join(root, "required-signature"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			trustPolicy: { enabled: true, requireSignature: true },
		});
		await expect(
			requiredSignature.install(await makePackage(root, "com.example.signature-required"), {
				trustTier: "T2",
			}),
		).rejects.toMatchObject({ code: "PLUGIN_SIGNATURE_REQUIRED" });
	});

	test("keeps management queries available while the feature flag is disabled", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const enabled = new PluginManager({
			root: storeRoot,
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
		});
		const installed = await enabled.install(await makePackage(root, "com.example.featureflag"));
		const disabled = new PluginManager({
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
});
