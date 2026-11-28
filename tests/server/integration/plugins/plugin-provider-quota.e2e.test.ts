import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db, sqlite } from "@server/db";
import { users } from "@server/db/schema";
import type { outboundFetch } from "@server/lib/net/outbound-fetch";
import { parseManifest } from "@server/lib/plugins/manifest";
import { type CustomApiProviderConfig, settings } from "@server/lib/settings";
import { createPluginRoutes } from "@server/routes/plugins";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginManager, type PluginManagerStatus } from "@server/services/plugin-manager";
import { PluginPackageStore } from "@server/services/plugin-package-store";
import {
	PluginPermissionStore,
	permissionGrantPayload,
} from "@server/services/plugin-permission-store";
import { createPluginPlatformServices } from "@server/services/plugin-platform-services";
import { PluginProviderConnectionService } from "@server/services/plugin-provider-connection-service";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { type PluginRuntime, RuntimeSupervisor } from "@server/services/plugin-runtime";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";
import { PluginStateStore } from "@server/services/plugin-state-store";
import { PluginUpgradeCoordinator } from "@server/services/plugin-upgrade-coordinator";
import { ProviderQuotaService } from "@server/services/provider-quota-service";
import {
	forgetQuotaSettingsProjection,
	projectQuotaSettings,
} from "@server/services/provider-quota-settings-projection";
import { CustomApiQuotaTargetDirectory } from "@server/services/provider-quota-targets";
import { ProviderSettingsBindings } from "@server/services/provider-settings-bindings";
import {
	type ProviderQuotaSnapshot,
	QUOTA_QUERY_METHOD,
	quotaQueryParamsSchema,
} from "@shared/provider-quota";
import archiver from "archiver";
import {
	type BuildProviderQuotaResult,
	buildProviderQuotaPlugin,
} from "../../../../plugins/provider-quota/build";
import quotaManifest from "../../../../plugins/provider-quota/manifest.json";

const UPGRADE_VERSION = "1.0.5";
const PLUGIN_ID = "io.narrafork.provider-quota";
const CALL_BUDGET_MS = 30_000;
const FIXTURE_GRANTOR = "provider-quota-e2e";
let buildRoot: string | undefined;
let artifact: BuildProviderQuotaResult | undefined;
let upgradeArchive: string | undefined;

function required<T>(value: T | null | undefined, label: string): T {
	if (value === undefined || value === null) throw new Error(`Missing ${label}`);
	return value;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(
	promise: Promise<T>,
	label: string,
	timeoutMs = CALL_BUDGET_MS,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function waitUntil(
	predicate: () => boolean,
	label: string,
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		// Poll only the independently running real plugin/runtime; there is no upstream polling.
		await Bun.sleep(10);
	}
}

function lateRelayResponse() {
	const canceled = deferred<void>();
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						JSON.stringify({
							isValid: true,
							mode: "unrestricted",
							unit: "USD",
							balance: 999,
						}),
					),
				);
			},
			cancel() {
				canceled.resolve(undefined);
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
	return { response, canceled: canceled.promise };
}

function providersForTest(): CustomApiProviderConfig[] {
	return [
		["relay", "https://provider-quota-e2e.invalid/v1"],
		["deepseek", "https://api.deepseek.com/v1"],
		["kimi", "https://api.kimi.com"],
		["opencode", "https://opencode.ai/inference/go/openai/v1"],
	].map(([id, baseUrl]) => ({
		id: required(id, "provider ID"),
		prefix: `quota-e2e-${id}`,
		name: `Quota E2E ${id}`,
		baseUrl: required(baseUrl, "provider endpoint"),
		apiKey: `quota-e2e-secret-${id}`,
		protocol: "completions-compatible" as const,
		defaultModel: "quota-fixture-model",
		proxy: { mode: "direct" as const },
	}));
}

function responseFor(providerId: string, relayBalance = 12.5): Response {
	const resetTime = new Date(Date.now() + 3_600_000).toISOString();
	switch (providerId) {
		case "relay":
			return Response.json({
				isValid: true,
				mode: "unrestricted",
				unit: "USD",
				balance: relayBalance,
			});
		case "deepseek":
			return Response.json({
				is_available: false,
				balance_infos: [
					{
						currency: "USD",
						total_balance: "12.3400",
						granted_balance: "0.0000",
						topped_up_balance: "12.3400",
					},
				],
			});
		case "kimi":
			return Response.json({
				usage: { used: "25", limit: "100", remaining: "75", resetTime },
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
						detail: {
							used: "10",
							limit: "100",
							remaining: "90",
							resetTime,
						},
					},
				],
			});
		case "opencode":
			return Response.json({
				usage: {
					rolling: { status: "ok", percent: 37, resetsAt: resetTime },
					weekly: { status: "rate-limited", percent: 100, resetsAt: resetTime },
					monthly: { status: "ok", used: 2, limit: 10, resetsAt: resetTime },
					balance: { amount: 9.75 },
				},
			});
		default:
			throw new Error(`Unexpected fixture provider: ${providerId}`);
	}
}

interface HttpCall {
	providerId: string;
	url: string;
	headers: Headers;
	signal: AbortSignal | undefined;
	policy: Parameters<typeof outboundFetch>[2];
}

/** All control-plane services and stdio RPC are real; only the final upstream HTTP is fake. */
async function harness() {
	// Windows TEMP may use an 8.3 alias; Catalog compares canonical package paths.
	const root = await realpath(await mkdtemp(join(tmpdir(), "q-")));
	const storeRoot = join(root, "installed");
	const savedProviders = structuredClone(settings.customApiProviders);
	const allProviders = providersForTest();
	let providers: CustomApiProviderConfig[] = [];
	let transportRevision = 0;
	let relayBalance = 12.5;
	const calls: HttpCall[] = [];
	const pendingStalls: Array<ReturnType<typeof deferred<Response>>> = [];
	let nextStall:
		| {
				providerId: string;
				response: ReturnType<typeof deferred<Response>>;
				entered: ReturnType<typeof deferred<HttpCall>>;
		  }
		| undefined;
	const directory = new CustomApiQuotaTargetDirectory({
		providers: () => providers.map(projectQuotaSettings),
		globalProxy: () => ({ mode: "direct" }),
		userAgent: () => "ProviderQuotaE2E/1.0",
	});
	const fetcher: typeof outboundFetch = async (input, init, policy) => {
		if (calls.length >= 128) throw new Error("Fixture HTTP request budget exceeded");
		const url = new URL(String(input));
		// Official hostnames select the real adapters, but this function never dispatches network I/O.
		const provider = allProviders.find(
			(candidate) => new URL(candidate.baseUrl).hostname === url.hostname,
		);
		if (!provider || url.protocol !== "https:" || init?.method !== "GET") {
			throw new Error(`Unexpected quota transport destination: ${url.origin}${url.pathname}`);
		}
		const call: HttpCall = {
			providerId: provider.id,
			url: url.toString(),
			headers: new Headers(init.headers),
			signal: init.signal ?? undefined,
			policy,
		};
		calls.push(call);
		if (nextStall?.providerId === provider.id) {
			const held = nextStall;
			nextStall = undefined;
			held.entered.resolve(call);
			// Deliberately ignore cancellation so the host must consume a genuinely late response.
			return held.response.promise;
		}
		if (url.pathname === "/team/api/user/self")
			return Response.json({ success: true, data: { quota: 21 * 500000, used_quota: 2 * 500000 } });
		return responseFor(provider.id, relayBalance);
	};
	const connection = new PluginProviderConnectionService({ directory, fetch: fetcher });
	const quota = new ProviderQuotaService({ directory, onChanged: () => {} });
	const stateStore = new PluginStateStore(storeRoot);
	const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
	const supervisor = new RuntimeSupervisor();
	const platform = createPluginPlatformServices({
		runtimeSupervisor: supervisor,
		stateStore,
		permissionStore,
		capabilityBroker: new CapabilityBroker({ kernelEnforcement: true }),
		providerRegistry: new PluginProviderRegistry(),
		quotaService: quota,
		providerConnectionService: connection,
		providerSettingsBindings: new ProviderSettingsBindings({ fetch: fetcher }),
		storageRoot: join(root, "storage"),
		secretVault: new PluginSecretVault({ root: join(root, "secrets") }),
	});
	const manager = new PluginManager({
		root: storeRoot,
		disabled: false,
		stateStore,
		permissionStore,
		hostServices: platform.hostServices,
		runtimeSupervisor: supervisor,
		contributionRegistry: platform.contributionRegistry,
		contributionCoordinator: platform.contributionCoordinator,
		quotaRegistry: platform.quotaRegistry,
		lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
		restorePluginLifecycle: platform.restorePlugin,
		purgePluginSecrets: (pluginId) => platform.secretVault.deletePlugin(pluginId),
		// Intentionally no runtimeOptionsFactory, fake runtime, authority override or RPC stub.
	});
	const approveSettings = async () => {
		const before = await manager.getPermissions(PLUGIN_ID);
		await manager.replacePermissions(PLUGIN_ID, {
			expectedRevision: before.revision,
			grantedBy: FIXTURE_GRANTOR,
			grants: [
				...before.grants.map(permissionGrantPayload),
				...(["provider.settings.read_self", "provider.settings.connection.use"] as const)
					.filter((capability) => !before.grants.some((grant) => grant.capability === capability))
					.map((capability) => ({
						capability,
						scope: { type: "global" as const },
						grantedBy: FIXTURE_GRANTOR,
					})),
			],
		});
	};
	const restores: Array<() => void> = [];
	const hostRequestSpy = spyOn(connection, "request");
	restores.push(() => hostRequestSpy.mockRestore());
	return {
		root,
		storeRoot,
		manager,
		supervisor,
		platform,
		quota,
		connection,
		calls,
		allProviders,
		approveSettings,
		hostParams: () => hostRequestSpy.mock.calls.map(([params]) => params),
		trace(runtime: PluginRuntime) {
			// Bun spies call through unchanged: this observes the actual stdio request parameters.
			const requestSpy = spyOn(runtime, "request");
			restores.push(() => requestSpy.mockRestore());
			return {
				methods: () => requestSpy.mock.calls.map(([method]) => method),
				queryParams: () =>
					requestSpy.mock.calls
						.filter(([method]) => method === QUOTA_QUERY_METHOD)
						.map(([, params]) => params),
			};
		},
		setProviders(ids = allProviders.map(({ id }) => id)) {
			providers = allProviders.filter(({ id }) => ids.includes(id));
			settings.customApiProviders = providers;
			quota.sync();
		},
		freshTransportGeneration() {
			// Use a real transport-identity change, not fake clocks or private scheduler mutation.
			// This also keeps Registry, ConnectionService and the child process on the same clock.
			transportRevision++;
			providers = providers.map((provider) => ({
				...provider,
				extraHeaders: { "x-quota-e2e-revision": String(transportRevision) },
			}));
			quota.sync();
		},
		setRelayBalance(value: number) {
			relayBalance = value;
		},
		holdNext(providerId = "relay") {
			if (nextStall) throw new Error("A fixture HTTP stall is already armed");
			const response = deferred<Response>();
			const entered = deferred<HttpCall>();
			pendingStalls.push(response);
			nextStall = { providerId, response, entered };
			return {
				entered: () => bounded(entered.promise, "real plugin HTTP dispatch", 10_000),
				resolve: (value: Response) => response.resolve(value),
			};
		},
		async installAndActivate() {
			let installed: PluginManagerStatus | undefined;
			let phase = "install";
			try {
				installed = await bounded(
					manager.install(required(artifact, "built archive").archivePath),
					"archive installation",
				);
				phase = "contributions";
				expect(installed.pluginId).toBe(PLUGIN_ID);
				expect(installed.contributions.filter(({ kind }) => kind === "provider")).toEqual([]);
				expect(installed.contributions.filter(({ kind }) => kind === "quotaSource")).toHaveLength(
					4,
				);
				await approveSettings();
				phase = "enable";
				const enabled = await bounded(manager.enable(PLUGIN_ID), "plugin enable");
				expect(enabled.compatibility).toBe("compatible");
				phase = "activate";
				await bounded(manager.activate(PLUGIN_ID), "default plugin activation");
				const runtime = required(supervisor.get(PLUGIN_ID), "real plugin runtime");
				expect(runtime.pid).toBeGreaterThan(0);
				expect(runtime.getDiagnostics().features).toContain("host_api.provider_connection");
				return runtime;
			} catch (error) {
				const status = await bounded(
					manager.getStatus(PLUGIN_ID),
					"activation failure diagnostics",
					5_000,
				).catch(() => undefined);
				const state = stateStore.getCachedState(PLUGIN_ID);
				const runtime = supervisor.get(PLUGIN_ID)?.getDiagnostics();
				const safeText = (text: string) =>
					allProviders
						.reduce((value, { apiKey }) => value.replaceAll(apiKey, "[REDACTED]"), text)
						.slice(0, 512);
				const diagnostic = {
					phase,
					storeRoot,
					error: safeText(error instanceof Error ? error.message : String(error)),
					installed: installed && {
						compatibility: installed.compatibility,
						packageStatus: installed.packageStatus,
						contributions: installed.contributions.map(({ kind, id }) => ({ kind, id })),
					},
					status: status && {
						compatibility: status.compatibility,
						packageStatus: status.packageStatus,
						desiredState: status.desiredState,
						runtimeState: status.runtimeState,
						current: status.current,
						manifest: status.manifest && {
							pluginId: status.manifest.pluginId,
							version: status.manifest.version,
							engine: status.manifest.engine,
							server: status.manifest.server,
						},
						diagnostics: status.diagnostics
							.slice(0, 8)
							.map(({ code, message }) => ({ code, message: safeText(message) })),
					},
					state: state && {
						compatibility: state.compatibility,
						desiredState: state.desiredState,
						runtimeState: state.runtimeState,
						current: state.current,
						lastError: state.lastError && {
							code: state.lastError.code,
							phase: state.lastError.phase,
							message: safeText(state.lastError.message),
						},
					},
					runtime: runtime && {
						pluginVersion: runtime.pluginVersion,
						state: runtime.state,
						generation: runtime.generation,
						pid: runtime.pid,
						features: runtime.features,
						lastError: runtime.lastError && {
							code: runtime.lastError.code,
							phase: runtime.lastError.phase,
							message: safeText(runtime.lastError.message),
						},
					},
				};
				throw new Error(`Archived quota plugin lifecycle failed: ${JSON.stringify(diagnostic)}`, {
					cause: error,
				});
			}
		},
		async idle() {
			await waitUntil(() => {
				const diagnostics = quota.getDiagnostics();
				return (
					diagnostics.active === 0 && diagnostics.queued === 0 && connection.activeReferences === 0
				);
			}, "quota/RPC/connection capacity release");
		},
		async close() {
			// These are only the services/runtime supervisor created by this harness, never host singletons.
			quota.stop();
			for (const held of pendingStalls) held.resolve(responseFor("relay", 999));
			try {
				try {
					await bounded(manager.uninstall(PLUGIN_ID), "owned plugin authority cleanup");
				} finally {
					try {
						await bounded(manager.shutdown(), "owned manager shutdown");
					} finally {
						await bounded(supervisor.shutdown(), "owned runtime supervisor shutdown");
					}
				}
			} finally {
				for (const restore of restores) restore();
				quota.dispose();
				connection.dispose();
				platform.providerSettingsService.close();
				settings.customApiProviders = savedProviders;
				for (const provider of allProviders) forgetQuotaSettingsProjection(provider.id);
				for (const table of [
					"plugin_provider_settings",
					"plugin_resource_entries",
					"plugin_resource_budgets",
				])
					sqlite.run(`DELETE FROM ${table} WHERE plugin_id=?`, [PLUGIN_ID]);
				await rm(root, { recursive: true, force: true });
			}
		},
	};
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function queryAll(f: Harness): Promise<ProviderQuotaSnapshot[]> {
	await f.platform.providerSettingsService.prepareQuotaMigrations();
	const snapshots: ProviderQuotaSnapshot[] = [];
	for (const { id } of f.allProviders)
		snapshots.push(
			required(await bounded(f.quota.refresh(id), `${id} quota query`), `${id} snapshot`),
		);
	await f.idle();
	return snapshots;
}

function assertCredentialFree(
	f: Harness,
	queryParams: unknown[],
	snapshots: ProviderQuotaSnapshot[],
) {
	expect(queryParams.length).toBeGreaterThanOrEqual(snapshots.length);
	for (const params of queryParams)
		expect(quotaQueryParamsSchema.safeParse(params).success).toBe(true);
	const wire = JSON.stringify({ queryParams, hostParams: f.hostParams(), snapshots });
	for (const { apiKey } of f.allProviders) expect(wire).not.toContain(apiKey);
	expect(wire).not.toMatch(/apiKey|Authorization|extraHeaders|tlsRejectUnauthorized/);
	for (const call of f.calls) {
		expect(call.headers.get("authorization")).toBe(`Bearer quota-e2e-secret-${call.providerId}`);
		expect(call.policy).toMatchObject({ retryPolicy: "never" });
		if (call.providerId === "opencode")
			expect(call.headers.get("x-api-key")).toBe("quota-e2e-secret-opencode");
	}
}

async function makeUpgradeArchive(
	original: BuildProviderQuotaResult,
	root: string,
): Promise<string> {
	const packageRoot = join(root, "upgrade-package");
	await cp(original.packageRoot, packageRoot, { recursive: true });
	const manifestPath = join(packageRoot, "manifest.json");
	const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
	const oldVersion = manifest.version;
	manifest.version = UPGRADE_VERSION;
	const entryPath = join(packageRoot, required(manifest.server, "quota server manifest").entry);
	const bundle = await readFile(entryPath, "utf8");
	expect(bundle).toContain(oldVersion);
	// Both the package manifest and the actual hello/initialize bundle identify the new version.
	await writeFile(entryPath, bundle.replaceAll(oldVersion, manifest.version));
	await writeFile(manifestPath, JSON.stringify(manifest));
	await writeFile(join(packageRoot, "sources", "manifest.json"), JSON.stringify(manifest));
	// This is a derived test package, not a release; refresh its existing file hashes instead of
	// shipping a misleading old SBOM next to the changed executable.
	const sbomPath = join(packageRoot, "sbom.spdx.json");
	const sbom = JSON.parse(await readFile(sbomPath, "utf8")) as {
		documentNamespace: string;
		packages: Array<{
			name: string;
			versionInfo: string;
			packageVerificationCode?: { packageVerificationCodeValue: string };
		}>;
		files: Array<{
			fileName: string;
			checksums: Array<{ algorithm: string; checksumValue: string }>;
		}>;
	};
	const sha1s: string[] = [];
	for (const file of sbom.files) {
		const bytes = await readFile(join(packageRoot, file.fileName.replace(/^\.\//, "")));
		file.checksums = [
			{ algorithm: "SHA256", checksumValue: createHash("sha256").update(bytes).digest("hex") },
		];
		sha1s.push(createHash("sha1").update(bytes).digest("hex"));
	}
	const verification = createHash("sha1").update(sha1s.sort().join("")).digest("hex");
	const ownPackage = required(
		sbom.packages.find(({ name }) => name === PLUGIN_ID),
		"quota SBOM package",
	);
	ownPackage.versionInfo = manifest.version;
	ownPackage.packageVerificationCode = {
		...ownPackage.packageVerificationCode,
		packageVerificationCodeValue: verification,
	};
	sbom.documentNamespace = `https://narrafork.local/sbom/${PLUGIN_ID}/${manifest.version}/${verification}`;
	await writeFile(sbomPath, JSON.stringify(sbom));
	const archivePath = join(root, "provider-quota-upgrade.nfplugin");
	const archive = archiver("zip", { zlib: { level: 9 } });
	let bytes = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.byteLength;
			callback(
				bytes > 16 * 1024 * 1024 ? new Error("Upgrade archive exceeds byte budget") : null,
				chunk,
			);
		},
	});
	const sink = createWriteStream(archivePath);
	const completed = pipeline(archive, limiter, sink);
	const timer = setTimeout(() => {
		archive.abort();
		sink.destroy(new Error("Upgrade archive timeout"));
	}, CALL_BUDGET_MS);
	try {
		archive.directory(packageRoot, false);
		await Promise.all([archive.finalize(), completed]);
	} finally {
		clearTimeout(timer);
	}
	return archivePath;
}

beforeAll(async () => {
	buildRoot = await realpath(await mkdtemp(join(tmpdir(), "narrafork-quota-archive-e2e-")));
	artifact = await buildProviderQuotaPlugin({ outDir: join(buildRoot, "original") });
	expect((await stat(artifact.archivePath)).size).toBeGreaterThan(0);
	expect((await stat(artifact.archivePath)).size).toBeLessThanOrEqual(16 * 1024 * 1024);
	upgradeArchive = await makeUpgradeArchive(artifact, buildRoot);
}, 60_000);

afterAll(async () => {
	if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

test("bundled quota waits for explicit settings grants before querying and stays removed", async () => {
	const f = await harness();
	try {
		expect(await db.select({ id: users.id }).from(users).limit(1).get()).toBeUndefined();
		const bytes = await readFile(required(artifact, "built quota archive").archivePath);
		let loads = 0;
		const descriptor = {
			pluginId: PLUGIN_ID,
			version: quotaManifest.version,
			load: async () => {
				loads++;
				return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
			},
		};
		const status = await bounded(
			f.manager.bootstrapBundledPlugin(descriptor),
			"bundled quota bootstrap",
		);
		expect(status).toMatchObject({
			desiredState: "enabled",
			runtimeState: "active",
			compatibility: "compatible",
		});
		const permissions = await f.manager.getPermissions(PLUGIN_ID);
		expect(permissions.grants.map((grant) => grant.capability).sort()).toEqual([
			"provider.connection.request",
			"quota.provide",
		]);
		expect(
			permissions.grants.every(
				(grant) => grant.grantedBy === "system" && grant.scope.type === "global",
			),
		).toBe(true);
		await f.approveSettings();
		const runtime = required(f.supervisor.get(PLUGIN_ID), "bundled runtime");
		const trace = f.trace(runtime);
		f.setProviders();
		f.quota.start();
		const snapshots = await queryAll(f);
		if (snapshots.some((snapshot) => snapshot.status !== "supported"))
			throw Error(
				`Quota post-approval diagnostic ${JSON.stringify(snapshots.map(({ providerId, status, error }) => ({ providerId, status, error })))}`,
			);
		expect(snapshots.map((snapshot) => snapshot.status)).toEqual([
			"supported",
			"supported",
			"supported",
			"supported",
		]);
		assertCredentialFree(f, trace.queryParams(), snapshots);
		await bounded(f.manager.uninstall(PLUGIN_ID), "bundled quota uninstall");
		expect(await f.manager.bootstrapBundledPlugin(descriptor)).toBeNull();
		expect(await f.manager.list()).toEqual([]);
		expect(loads).toBe(1);
		expect((await f.manager.stateStore.getBundledBootstrap(PLUGIN_ID))?.status).toBe("removed");
		for (const { id } of f.allProviders) expect(f.quota.peek(id)?.status).toBe("unavailable");
	} finally {
		await f.close();
	}
}, 60_000);
test.each([
	"1.0.3",
	"1.0.4",
])("real %s site-account query uses migrated SQL secrets without exposing them over stdio", async (version) => {
	const f = await harness();
	try {
		const relay = required(
			f.allProviders.find((p) => p.id === "relay"),
			"relay fixture",
		);
		relay.quotaSiteUrl = "https://provider-quota-e2e.invalid/team";
		relay.quotaUserId = "fixture-user";
		relay.quotaAccessToken = "fixture-site-secret";
		f.setProviders(["relay"]);
		if (version === "1.0.4") await f.installAndActivate();
		else {
			await f.manager.install(
				join(import.meta.dir, "../../../fixtures/provider-quota-1.0.3.nfplugin"),
			);
			await f.manager.enable(PLUGIN_ID);
			await f.manager.activate(PLUGIN_ID);
		}
		await f.platform.providerSettingsService.prepareQuotaMigrations();
		const runtime = required(f.supervisor.get(PLUGIN_ID), "quota runtime"),
			trace = f.trace(runtime);
		f.quota.start();
		const snapshot = await f.quota.refresh("relay");
		expect(snapshot?.status).toBe("supported");
		expect(snapshot?.data?.amounts[0]?.remaining).toBe(21);
		const calls = f.calls.filter((call) => new URL(call.url).pathname === "/team/api/user/self");
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe("Bearer fixture-site-secret");
			expect(call.headers.get("new-api-user")).toBe("fixture-user");
			expect(call.headers.get("authorization")).not.toContain(relay.apiKey);
		}
		const payload = JSON.stringify(trace.queryParams());
		expect(payload).not.toContain("fixture-site-secret");
		expect(payload).not.toContain("fixture-user");
		expect(payload).not.toContain(relay.apiKey);
		if (version === "1.0.3")
			for (const params of trace.queryParams()) expect(params).not.toHaveProperty("settings");
		else
			expect(
				trace
					.queryParams()
					.some((params) => typeof params === "object" && params !== null && "settings" in params),
			).toBe(true);
	} finally {
		await f.close();
	}
}, 60000);

describe("real archived Provider Quota plugin lifecycle", () => {
	test("installs, runs credential-free RPC for all four sources, disables, re-enables and uninstalls", async () => {
		const f = await harness();
		try {
			const runtime = await f.installAndActivate();
			const trace = f.trace(runtime);
			expect(f.platform.providerRegistry.list()).toEqual([]);
			expect(f.calls).toHaveLength(0);
			expect(f.quota.generations()).toEqual({});
			expect(
				f.platform.quotaRegistry
					.listSources()
					.map(({ id }) => id)
					.sort(),
			).toEqual(["relay", "deepseek", "kimi", "opencode"].map((id) => `${PLUGIN_ID}/${id}`).sort());
			f.setProviders();
			f.quota.start();
			const snapshots = await queryAll(f);
			const byId = Object.fromEntries(snapshots.map((snapshot) => [snapshot.providerId, snapshot]));
			for (const { id } of f.allProviders)
				expect(byId[id]).toMatchObject({ status: "supported", sourceId: `${PLUGIN_ID}/${id}` });
			expect(byId.relay?.data).toMatchObject({
				format: "sub2api",
				amounts: [{ unit: "USD", remaining: 12.5 }],
			});
			expect(byId.deepseek?.data).toMatchObject({
				available: false,
				amounts: [
					{ id: "balance:USD", remaining: 12.34, remainingText: "12.3400" },
					{ id: "granted:USD", remaining: 0, remainingText: "0.0000" },
					{ id: "topped-up:USD", remaining: 12.34, remainingText: "12.3400" },
				],
			});
			expect(byId.kimi?.data?.windows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "fiveHour", remaining: 90 }),
					expect.objectContaining({ id: "weekly", remaining: 75 }),
				]),
			);
			expect(byId.opencode?.data).toMatchObject({
				windows: [
					{ id: "rolling", usedPercent: 37 },
					{ id: "weekly", usedPercent: 100 },
					{ id: "monthly", used: 2, limit: 10 },
				],
			});
			assertCredentialFree(f, trace.queryParams(), snapshots);
			expect(trace.methods()).not.toContain("provider.describe");
			const sourceRevisions = f.platform.quotaRegistry
				.listSources()
				.map(({ revision }) => revision);
			await bounded(f.manager.disable(PLUGIN_ID), "disable archived plugin");
			const count = f.calls.length;
			for (const { id } of f.allProviders)
				expect(await f.quota.refresh(id)).toMatchObject({ status: "unavailable", data: null });
			expect(f.calls).toHaveLength(count);
			expect(f.connection.activeReferences).toBe(0);
			expect(f.platform.quotaRegistry.listSources()).toEqual([]);
			await bounded(f.manager.enable(PLUGIN_ID), "re-enable archived plugin");
			await bounded(f.manager.activate(PLUGIN_ID), "reactivate archived plugin");
			f.freshTransportGeneration();
			const recovered = await queryAll(f);
			expect(recovered.every(({ status }) => status === "supported")).toBe(true);
			expect(f.calls.length).toBeGreaterThan(count);
			expect(runtime.getDiagnostics().generation).toBeGreaterThan(1);
			expect(f.platform.quotaRegistry.listSources().map(({ revision }) => revision)).toEqual(
				sourceRevisions,
			);
			await bounded(f.manager.uninstall(PLUGIN_ID), "uninstall archived plugin");
			const afterUninstall = f.calls.length;
			for (const { id } of f.allProviders)
				expect(await f.quota.refresh(id)).toMatchObject({ status: "unavailable", data: null });
			expect(f.calls).toHaveLength(afterUninstall);
			expect(f.connection.activeReferences).toBe(0);
			expect(f.platform.quotaRegistry.listSources()).toEqual([]);
			expect(f.platform.providerRegistry.list()).toEqual([]);
			expect(await f.manager.getStatus(PLUGIN_ID)).toBeUndefined();
		} finally {
			await f.close();
		}
	}, 90_000);

	test("revoke cancels a real stalled host request; enable cannot replace an absent grant", async () => {
		const f = await harness();
		try {
			await f.installAndActivate();
			f.setProviders(["relay"]);
			f.quota.start();
			await bounded(f.quota.refresh("relay"), "initial relay query");
			await f.idle();
			const permissions = await f.manager.getPermissions(PLUGIN_ID);
			const connectionGrant = required(
				permissions.grants.find(({ capability }) => capability === "provider.connection.request"),
				"connection grant",
			);
			const held = f.holdNext();
			f.freshTransportGeneration();
			const pending = f.quota.refresh("relay");
			const http = await held.entered();
			expect(f.connection.activeReferences).toBe(1);
			const revoked = await bounded(
				f.manager.revokePermissions(PLUGIN_ID, {
					grantIds: [connectionGrant.grantId],
					expectedRevision: permissions.revision,
					grantedBy: FIXTURE_GRANTOR,
				}),
				"revoke connection authority",
			);
			expect(
				revoked.permissions.grants.some(
					({ capability }) => capability === "provider.connection.request",
				),
			).toBe(false);
			expect(await bounded(pending, "canceled quota query")).toBeNull();
			expect(http.signal?.aborted).toBe(true);
			await f.idle();
			const revokedSnapshot = f.quota.peek("relay");
			expect(revokedSnapshot).toMatchObject({ status: "unavailable", data: null });
			const late = lateRelayResponse();
			held.resolve(late.response);
			await bounded(late.canceled, "late canceled transport body discard", 3_000);
			await f.idle();
			expect(f.quota.peek("relay")).toEqual(revokedSnapshot);
			await bounded(f.manager.disable(PLUGIN_ID), "disable without connection grant");
			await bounded(f.manager.enable(PLUGIN_ID), "enable without connection grant");
			await bounded(f.manager.activate(PLUGIN_ID), "activate without connection grant");
			const deniedCount = f.calls.length;
			f.freshTransportGeneration();
			expect(await f.quota.refresh("relay")).toMatchObject({ status: "unavailable", data: null });
			expect(f.calls).toHaveLength(deniedCount);
			expect(f.connection.activeReferences).toBe(0);
			const missing = await f.manager.getPermissions(PLUGIN_ID);
			expect(
				missing.grants.some(({ capability }) => capability === "provider.connection.request"),
			).toBe(false);
			const newGrantId = `quota-explicit-${crypto.randomUUID()}`;
			const restored = await bounded(
				f.manager.replacePermissions(PLUGIN_ID, {
					expectedRevision: missing.revision,
					grantedBy: FIXTURE_GRANTOR,
					grants: [
						...missing.grants.map(permissionGrantPayload),
						{
							grantId: newGrantId,
							capability: "provider.connection.request",
							scope: { type: "global" },
							grantedBy: FIXTURE_GRANTOR,
						},
					],
				}),
				"explicit new connection grant",
			);
			expect(
				restored.permissions.grants.find(
					({ capability }) => capability === "provider.connection.request",
				)?.grantId,
			).toBe(newGrantId);
			// Refresh initialize capabilities through the real lifecycle, not a fake RPC capability update.
			await bounded(f.manager.disable(PLUGIN_ID), "restart after explicit grant");
			await bounded(f.manager.enable(PLUGIN_ID), "enable explicit grant");
			await bounded(f.manager.activate(PLUGIN_ID), "activate explicit grant");
			f.freshTransportGeneration();
			expect(await bounded(f.quota.refresh("relay"), "re-authorized quota query")).toMatchObject({
				status: "supported",
				data: { amounts: [{ remaining: 12.5 }] },
			});
			await f.idle();
			expect(f.calls.length).toBeGreaterThan(deniedCount);
		} finally {
			await f.close();
		}
	}, 90_000);

	test("actual coordinator upgrade and rollback replace runtime/source identity and discard old-package replies", async () => {
		const f = await harness();
		try {
			const oldRuntime = await f.installAndActivate();
			f.setProviders(["relay"]);
			f.quota.start();
			await bounded(f.quota.refresh("relay"), "v1 relay query");
			await f.idle();
			const oldRevision = required(
				f.platform.quotaRegistry
					.listSources()
					.find(({ contributionId }) => contributionId === "relay"),
				"v1 relay source",
			).revision;
			const oldIdentity = oldRuntime.getDiagnostics();
			const store = new PluginPackageStore(f.storeRoot);
			const originalPointer = required(
				(await store.readCurrent()).plugins[PLUGIN_ID],
				"v1 current pointer",
			);
			const coordinator = new PluginUpgradeCoordinator({
				store,
				runtime: {
					stop: (pluginId) => f.manager.disable(pluginId).then(() => {}),
					start: async (pluginId, pointer) => {
						// Stage/switch uses the real PackageStore; reconcile authority/contributions and
						// start the actual bundle through Manager rather than writing state manually.
						await f.manager.install(store.packagePath(pluginId, pointer.version, pointer.hash));
						await f.manager.enable(pluginId);
						await f.manager.activate(pluginId);
						// Coordinator's optional pre-start health hook cannot interrogate the new
						// process yet. Check the real process here, after its default handshake.
						const runtime = required(f.supervisor.get(pluginId), "upgrade runtime");
						expect(
							(await runtime.request<{ healthy: boolean }>("health", {}, { timeoutMs: 5_000 }))
								.healthy,
						).toBe(true);
					},
				},
			});
			const held = f.holdNext();
			f.freshTransportGeneration();
			const oldQuery = f.quota.refresh("relay");
			const oldHttp = await held.entered();
			f.setRelayBalance(77);
			const upgraded = await bounded(
				coordinator.upgrade(PLUGIN_ID, required(upgradeArchive, "upgrade archive")),
				"coordinator archive upgrade",
			);
			expect(upgraded.status).toBe("succeeded");
			expect(await bounded(oldQuery, "old-package cancellation")).toBeNull();
			expect(oldHttp.signal?.aborted).toBe(true);
			const newRuntime = required(f.supervisor.get(PLUGIN_ID), "upgraded runtime");
			// Runtime objects may keep their runtimeId across restarts; authority is bound to
			// the complete runtimeId/generation tuple. Capture it before another lifecycle step.
			const newIdentity = newRuntime.getDiagnostics();
			expect(newRuntime.pid).toBeGreaterThan(0);
			expect(newIdentity.pluginVersion).toBe(UPGRADE_VERSION);
			expect({ runtimeId: newIdentity.runtimeId, generation: newIdentity.generation }).not.toEqual({
				runtimeId: oldIdentity.runtimeId,
				generation: oldIdentity.generation,
			});
			const newRevision = required(
				f.platform.quotaRegistry
					.listSources()
					.find(({ contributionId }) => contributionId === "relay"),
				"upgraded source",
			).revision;
			expect(newRevision).not.toBe(oldRevision);
			f.freshTransportGeneration();
			expect(await bounded(f.quota.refresh("relay"), "upgraded relay query")).toMatchObject({
				status: "supported",
				data: { amounts: [{ remaining: 77 }] },
			});
			await f.idle();
			const late = lateRelayResponse();
			held.resolve(late.response);
			await bounded(late.canceled, "late canceled transport body discard", 3_000);
			await f.idle();
			expect(f.quota.peek("relay")?.data?.amounts[0]?.remaining).toBe(77);
			const rolledBack = await bounded(coordinator.rollback(PLUGIN_ID), "coordinator rollback");
			expect(rolledBack.status).toBe("succeeded");
			expect((await store.readCurrent()).plugins[PLUGIN_ID]).toEqual(originalPointer);
			const rolledRuntime = required(f.supervisor.get(PLUGIN_ID), "rolled-back runtime");
			const rolledIdentity = rolledRuntime.getDiagnostics();
			expect(rolledIdentity.pluginVersion).toBe(quotaManifest.version);
			expect(rolledRuntime.pid).toBeGreaterThan(0);
			expect({
				runtimeId: rolledIdentity.runtimeId,
				generation: rolledIdentity.generation,
			}).not.toEqual({
				runtimeId: newIdentity.runtimeId,
				generation: newIdentity.generation,
			});
			expect(
				required(
					f.platform.quotaRegistry
						.listSources()
						.find(({ contributionId }) => contributionId === "relay"),
					"rolled-back source",
				).revision,
			).not.toBe(newRevision);
			f.freshTransportGeneration();
			expect(await bounded(f.quota.refresh("relay"), "rolled-back real quota query")).toMatchObject(
				{ status: "supported", data: { amounts: [{ remaining: 77 }] } },
			);
			await f.idle();
			expect(f.connection.activeReferences).toBe(0);
		} finally {
			await f.close();
		}
	}, 90_000);
});

test("real multipart routes install and activate the archived quota plugin without weakening gates", async () => {
	const f = await harness();
	try {
		const bytes = await readFile(required(artifact, "built quota archive").archivePath);
		// Only resolved-session middleware is injected. Package store, manager, grants,
		// framing, process runtime and RPC remain real; native smoke covers real session auth.
		const routesFor = (role: "admin" | "user") =>
			createPluginRoutes(f.manager, {
				enabled: true,
				authMiddleware: async (c, next) => {
					const now = Math.floor(Date.now() / 1_000);
					c.set("user", {
						sub: "quota-route-fixture",
						sid: "resolved-fixture-session",
						role,
						iat: now,
						exp: now + 300,
					});
					await next();
				},
			});
		const form = (content = bytes) => {
			const data = new FormData();
			data.append(
				"archive",
				new File([content], "provider-quota.nfplugin", { type: "application/zip" }),
			);
			return data;
		};
		const denied = await bounded(
			Promise.resolve(routesFor("user").request("/install", { method: "POST", body: form() })),
			"nonadmin quota upload",
		);
		expect(denied.status).toBe(403);
		expect(await f.manager.list()).toEqual([]);
		expect((await f.manager.packageStore.readCurrent()).plugins).toEqual({});
		const routes = routesFor("admin");
		const malformed = await bounded(
			Promise.resolve(
				routes.request("/install", { method: "POST", body: form(Buffer.from("not a zip")) }),
			),
			"malformed quota upload",
		);
		expect(malformed.status).toBe(400);
		expect((await f.manager.packageStore.readCurrent()).plugins).toEqual({});
		for (let index = 0; index < 2; index++) {
			const response = await bounded(
				Promise.resolve(routes.request("/install", { method: "POST", body: form() })),
				"multipart quota upload",
			);
			expect(response.status).toBe(201);
			expect(await response.json()).toMatchObject({
				pluginId: PLUGIN_ID,
				desiredState: "disabled",
				compatibility: "compatible",
			});
		}
		expect(f.platform.quotaRegistry.listSources()).toEqual([]);
		await f.approveSettings();
		await bounded(f.manager.enable(PLUGIN_ID), "uploaded quota enable");
		await bounded(f.manager.activate(PLUGIN_ID), "uploaded quota activate");
		const runtime = required(f.supervisor.get(PLUGIN_ID), "uploaded quota runtime");
		expect(runtime.pid).toBeGreaterThan(0);
		f.setProviders();
		f.quota.start();
		const snapshots = await queryAll(f);
		expect(snapshots.every((snapshot) => snapshot.status === "supported")).toBe(true);
	} finally {
		await f.close();
	}
}, 60_000);
