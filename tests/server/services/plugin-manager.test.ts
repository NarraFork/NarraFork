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
		if (!installed.current) throw new Error("Installed plugin has no current package");
		const authorityId = pluginInstallationAuthorityId(installed.pluginId, installed.current.hash);
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
});
