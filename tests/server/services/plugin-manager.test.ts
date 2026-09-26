import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { integrationAuthorityService } from "@server/services/integration-authority-service";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginHostDispatcher } from "@server/services/plugin-host-dispatcher";
import { PluginHostServices } from "@server/services/plugin-host-services";
import { pluginInstallationAuthorityId } from "@server/services/plugin-integration-authority-service";
import {
	PluginLifecycleRevokeCoordinator,
	type PluginLifecycleRevokeEvent,
} from "@server/services/plugin-lifecycle-revoke-coordinator";
import {
	type PluginLifecycleRevokeCoordinatorLike,
	PluginManager,
	type PluginRuntimeSupervisorLike,
	pluginManager,
} from "@server/services/plugin-manager";
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
		if (existing && existing.options.command.join("\u0000") === options.command.join("\u0000")) {
			return existing;
		}
		if (existing) this.runtimes.delete(options.pluginId);
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
	const manager = new PluginManager({
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
	// Observe the actual fire-and-forget handler promises, not a sleep followed by
	// a binding-presence check. This also works before the serialization fix.
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
	const settle = async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};
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
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginManager", () => {
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
		const manager = new PluginManager({
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
		await permissionStore.replace(pluginId, migratedUuid, [], {
			expectedRevision: 2,
			targetRevision: 3,
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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

	test("isolates a revoked residual plugin during initialization", async () => {
		const root = await makeTempRoot();
		const storeRoot = join(root, "plugins");
		const first = new PluginManager({
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

		const recovered = new PluginManager({
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
		const first = new PluginManager({
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
		const recovered = new PluginManager({
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

	test("activates an unsigned package under a trust policy that does not require a signature", async () => {
		// Used to assert the opposite. A `trustTier === "T3"` check refused activation whenever
		// a trust policy was enabled, and since install always produced T3 with no route to
		// raise it, enabling the policy meant no plugin could activate at all. The tier axis is
		// gone; an enabled policy now only enforces what it can actually read from the package.
		const root = await makeTempRoot();
		const supervisor = new FakeSupervisor();
		const manager = new PluginManager({
			root: join(root, "plugins"),
			disabled: false,
			runtimeSupervisor: supervisor,
			trustPolicy: { enabled: true },
		});
		const installed = await manager.install(await makePackage(root, "com.example.unsigned"));
		await manager.enable(installed.pluginId);
		const active = await manager.activate(installed.pluginId);
		expect(active.runtimeState).toBe("active");
	});

	test("fails closed when the trust policy requires a signature", async () => {
		const root = await makeTempRoot();
		const requiredSignature = new PluginManager({
			root: join(root, "required-signature"),
			disabled: false,
			runtimeSupervisor: new FakeSupervisor(),
			trustPolicy: { enabled: true, requireSignature: true },
		});
		await expect(
			requiredSignature.install(await makePackage(root, "com.example.signature-required")),
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

	test("loads persisted state before the first contribution refresh", async () => {
		const storeRoot = await makeTempRoot();
		const stateStore = new PluginStateStore({ root: storeRoot });
		const order: string[] = [];
		const realInitialize = stateStore.initialize.bind(stateStore);
		stateStore.initialize = async () => {
			order.push("state-initialize");
			return realInitialize();
		};

		const manager = new PluginManager({
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
				const manager = new PluginManager({
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

		// handleRuntimeStateChange is fire-and-forget from the onStateChange
		// wrapper, so yield until the revoke+rebind settles.
		await sleep(50);

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
		await sleep(50);

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
				command: ["fake-runtime", context.package.hash],
				cwd: context.packagePath,
			}),
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
		});

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
	});

	test("approve writes the canonical grant to the DB authority, surviving a manager rebuild", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.approve-canonical";
		const manager = new PluginManager({
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
		const rebuilt = new PluginManager({
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
		const manager = new PluginManager({
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
		const manager = new PluginManager({
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
		await expect(
			manager.denyPermissionRequest(pluginId, pending.requestId, { permanent: true }),
		).rejects.toThrow();
		expect(await manager.listPermanentDenials(pluginId)).toHaveLength(0);
	});

	test("restores the stable UUID from the authority and retires legacy hash authorities on initialize", async () => {
		const root = await makeTempRoot();
		const pluginId = "com.example.legacy-restore";
		const manager = new PluginManager({
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

		const manager2 = new PluginManager({
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
