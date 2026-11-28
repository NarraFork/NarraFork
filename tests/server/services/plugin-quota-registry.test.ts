import { describe, expect, test } from "bun:test";
import { parseManifest } from "@server/lib/plugins/manifest";
import { jsonRpcEnvelopeSchema } from "@server/lib/plugins/protocol";
import type { PluginHostRuntimeBinding } from "@server/services/plugin-host-services";
import type { PluginQuotaRuntime } from "@server/services/plugin-quota-client";
import {
	PluginQuotaRegistry,
	type PluginQuotaRegistryOptions,
} from "@server/services/plugin-quota-registry";
import type { PluginStateRecord } from "@server/services/plugin-state-store";
import type {
	CustomApiQuotaTarget,
	QuotaQueryParams,
	QuotaQueryResult,
} from "@shared/provider-quota";

const pluginId = "com.example.quota-registry";
const hash = "a".repeat(64);
const manifest = parseManifest({
	schemaVersion: 1,
	pluginId,
	version: "1.0.0",
	displayName: "Quota",
	engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
	server: { entry: "server.js", protocol: "narrafork.rpc/1" },
	activationEvents: ["onQuota:quota"],
	contributes: {
		quotaSources: [
			{
				id: "quota",
				title: "Quota",
				match: { hosts: ["example.test"] },
				requests: [{ path: "/v1/quota", auth: "bearer" }],
			},
		],
	},
	permissions: { host: ["quota.provide", "provider.connection.request"] },
});
const target: CustomApiQuotaTarget = {
	kind: "custom-api",
	id: "custom-api/provider-1",
	providerId: "provider-1",
	generation: "target-v1",
	baseUrl: "https://example.test/v1",
};
const supported: QuotaQueryResult = {
	status: "supported",
	data: { amounts: [{ id: "balance", unit: "USD", remaining: 3 }], windows: [] },
	error: null,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function fixture() {
	const state: PluginStateRecord = {
		pluginId,
		current: { version: "1.0.0", hash },
		installationId: "installation-1",
		authorityInstallationId: "installation-1",
		desiredState: "enabled",
		compatibility: "compatible",
		runtimeState: "active",
		grants: {
			count: 2,
			capabilities: ["quota.provide", "provider.connection.request"],
			revision: 4,
		},
		providerConfigs: {},
		providerPrefixes: {},
		providerProxies: {},
		crashCount: 0,
		restartCount: 0,
		consecutiveFailures: 0,
		runtimeGeneration: 2,
		lastError: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const binding = {
		plugin: {
			pluginId,
			packageVersion: "1.0.0",
			installationId: "installation-1",
			runtimeId: "runtime-1",
			runtimeGeneration: 2,
		},
		grantRevision: 4,
	} as PluginHostRuntimeBinding;
	const diagnostics = {
		runtimeId: "runtime-1",
		generation: 2,
		features: ["host_api.requests", "host_api.provider_connection", "rpc.cancel"],
	};
	const calls: Array<{
		method: string;
		params: QuotaQueryParams;
		signal?: AbortSignal;
		timeoutMs?: number;
		maxResponseBytes?: number;
	}> = [];
	let response = () => Promise.resolve(supported);
	const runtime: PluginQuotaRuntime = {
		state: "active",
		getDiagnostics: () => diagnostics,
		async request<T>(
			method: string,
			params: unknown,
			options?: { signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number },
		) {
			calls.push({ method, params: params as QuotaQueryParams, ...options });
			return (await response()) as T;
		},
	};
	let liveRuntime: PluginQuotaRuntime | undefined = runtime;
	const grants = new Set(["quota.provide", "provider.connection.request"]);
	const issued: Array<
		Parameters<PluginQuotaRegistryOptions["providerConnectionService"]["issue"]>[0]
	> = [];
	let released = 0;
	let revoked = 0;
	let authorizer = async (_capability: string) => true;
	const authorizeCalls: string[] = [];
	const options: PluginQuotaRegistryOptions = {
		stateStore: { getCachedState: () => state },
		permissionStore: {
			hasCachedUnrestrictedGlobalGrant: (_plugin, _installation, capability) =>
				grants.has(capability),
			getSet: async () => ({
				pluginId,
				installationId: state.installationId ?? "",
				revision: state.grants.revision,
				grants: [],
				updatedAt: state.updatedAt,
			}),
		},
		hostServices: { getRuntimeBinding: () => binding },
		capabilityBroker: {
			authorize: async (request) => {
				if (!("capability" in request) || typeof request.capability !== "string")
					throw new Error("quota authorization must name a capability");
				authorizeCalls.push(request.capability);
				return { allowed: await authorizer(request.capability) } as never;
			},
		},
		providerConnectionService: {
			issue: (input) => {
				issued.push(input);
				return {
					reference: "quota-ref",
					release: () => {
						released++;
					},
				};
			},
			revokePlugin: () => {
				revoked++;
			},
		},
		resolveRuntime: () => liveRuntime,
	};
	const registry = new PluginQuotaRegistry(options);
	registry.replaceManifest(manifest, `1.0.0:${hash}`);
	registry.setReady();
	return {
		registry,
		options,
		state,
		binding,
		diagnostics,
		runtime,
		grants,
		calls,
		issued,
		authorizeCalls,
		setRuntime: (value: PluginQuotaRuntime | undefined) => {
			liveRuntime = value;
		},
		setResponse: (value: () => Promise<QuotaQueryResult>) => {
			response = value;
		},
		setAuthorizer: (value: (capability: string) => Promise<boolean>) => {
			authorizer = value;
		},
		get released() {
			return released;
		},
		get revoked() {
			return revoked;
		},
	};
}
function query(
	f: ReturnType<typeof fixture>,
	deadlineAt = Date.now() + 1000,
	signal = new AbortController().signal,
) {
	const source = f.registry.listSources()[0];
	if (!source) throw new Error("source must be discoverable");
	return f.registry.query(source, target, { mode: "probe", deadlineAt, signal });
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
	await expect(promise).rejects.toMatchObject({ name: "ProviderQuotaError", code, message: code });
}

describe("PluginQuotaRegistry", () => {
	test("discovery is pending until catalog readiness and only exposes live grants", async () => {
		const f = fixture();
		f.registry.setReady(false);
		expect(f.registry.isReady()).toBe(false);
		expect(f.registry.listSources()).toEqual([]);
		let changed = 0;
		const unsubscribe = f.registry.onChanged(() => {
			changed++;
		});
		f.registry.setReady();
		await Promise.resolve();
		expect(changed).toBe(1);
		for (const capability of ["quota.provide", "provider.connection.request"]) {
			f.grants.delete(capability);
			expect(f.registry.listSources()).toEqual([]);
			f.grants.add(capability);
		}
		f.state.desiredState = "disabled";
		expect(f.registry.listSources()).toEqual([]);
		unsubscribe();
	});

	test("revision survives restart but changes for installation, package, grants or declaration", () => {
		const f = fixture();
		const source = f.registry.listSources()[0];
		const restarted = new PluginQuotaRegistry(f.options);
		restarted.replaceManifest(manifest, `1.0.0:${hash}`);
		restarted.setReady();
		expect(restarted.listSources()[0]?.revision).toBe(source?.revision);
		f.state.installationId = "installation-2";
		expect(restarted.listSources()[0]?.revision).not.toBe(source?.revision);
		f.state.installationId = "installation-1";
		f.state.grants.revision++;
		expect(restarted.listSources()[0]?.revision).not.toBe(source?.revision);
		f.state.grants.revision--;
		const changed = structuredClone(manifest);
		changed.contributes.quotaSources[0].requests[0].path = "/v1/other-quota";
		restarted.replaceManifest(changed, `1.0.0:${hash}`);
		expect(restarted.listSources()[0]?.revision).not.toBe(source?.revision);
	});

	test("issues a host principal/reference and sends only independent unary quota.query", async () => {
		const f = fixture();
		expect(await query(f)).toEqual(supported);
		expect(f.calls.map((call) => call.method)).toEqual(["quota.query"]);
		expect(f.calls[0]?.params).toMatchObject({
			contributionId: "quota",
			target,
			reference: "quota-ref",
			mode: "probe",
		});
		expect(f.issued[0]?.principal).toEqual(f.binding.plugin);
		expect(f.authorizeCalls).toEqual([
			"quota.provide",
			"provider.connection.request",
			"quota.provide",
			"provider.connection.request",
		]);
		expect(f.calls[0]?.maxResponseBytes).toBe(16 * 1024 + 1024);
		expect(f.released).toBe(1);
	});

	test("quota bindings use the projected authority revision independently of file CAS", async () => {
		const f = fixture();
		let authorityRevision = f.binding.grantRevision;
		f.options.permissionStore.getSet = async () => ({
			pluginId,
			installationId: f.binding.plugin.installationId,
			revision: 50,
			authorityRevision,
			grants: [],
			updatedAt: f.state.updatedAt,
		});
		f.setResponse(async () => {
			const guard = f.issued[0]?.isCurrent;
			expect(await guard?.()).toBe(true);
			authorityRevision++;
			expect(await guard?.()).toBe(false);
			return supported;
		});
		await expect(query(f)).rejects.toMatchObject({ name: "ProviderQuotaError" });
		expect(f.calls).toHaveLength(1);
		expect(f.released).toBe(1);
	});

	test("source and parent deadlines bound activation, even when it ignores cancellation", async () => {
		const f = fixture();
		const started = deferred<void>();
		const activation = deferred<unknown>();
		f.registry.setActivationHandler(async (_plugin, { signal }) => {
			started.resolve();
			signal.addEventListener("abort", () => undefined);
			return activation.promise;
		});
		const pending = query(f, Date.now() + 30);
		await started.promise;
		await rejectsCode(pending, "timeout");
		expect(f.calls).toHaveLength(0);
		expect(f.issued).toHaveLength(0);
		activation.resolve(undefined);
	});

	test("a first runtime generation does not cancel its own lazy activation", async () => {
		const f = fixture();
		const started = deferred<void>();
		const activation = deferred<unknown>();
		f.registry.setActivationHandler(async () => {
			started.resolve();
			return activation.promise;
		});
		const pending = query(f);
		await started.promise;
		f.registry.invalidatePlugin(pluginId, { runtimeOnly: true });
		activation.resolve(undefined);
		expect(await pending).toEqual(supported);
	});

	for (const revoke of ["disable", "uninstall", "grant", "runtime", "upgrade"] as const) {
		test(`${revoke} cancels in-flight query/reference and ignores a late successful response`, async () => {
			const f = fixture();
			const response = deferred<QuotaQueryResult>();
			const entered = deferred<void>();
			f.setResponse(() => {
				entered.resolve();
				return response.promise;
			});
			const pending = query(f);
			await entered.promise;
			if (revoke === "disable") f.registry.disablePlugin(pluginId);
			else if (revoke === "uninstall") f.registry.removePlugin(pluginId);
			else f.registry.invalidatePlugin(pluginId, { runtimeOnly: revoke === "runtime" });
			await rejectsCode(pending, "unavailable");
			expect(f.issued[0]?.signal.aborted).toBe(true);
			expect(f.released).toBe(1);
			expect(f.revoked).toBeGreaterThan(0);
			response.resolve(supported);
			await Promise.resolve();
			expect(f.released).toBe(1);
		});
	}

	for (const mutate of ["runtime", "binding", "installation", "grant"] as const) {
		test(`rechecks ${mutate} identity after asynchronous authorization`, async () => {
			const f = fixture();
			let calls = 0;
			f.setAuthorizer(async () => {
				if (++calls === 2) {
					if (mutate === "runtime") f.diagnostics.generation++;
					if (mutate === "binding") f.binding.grantRevision++;
					if (mutate === "installation") f.state.installationId = "installation-2";
					if (mutate === "grant") f.grants.delete("quota.provide");
				}
				return true;
			});
			await rejectsCode(query(f), "permission_denied");
			expect(f.issued).toHaveLength(0);
			expect(f.calls).toHaveLength(0);
		});
	}

	test("captured lease guard closes runtime/authority/package changes before an outbound request", async () => {
		const f = fixture();
		expect(await query(f)).toEqual(supported);
		const guard = f.issued[0]?.isCurrent;
		if (!guard) throw new Error("lease guard missing");
		expect(await guard()).toBe(true);
		f.setRuntime(undefined);
		expect(await guard()).toBe(false);
		f.setRuntime(f.runtime);
		f.state.current = { version: "1.0.0", hash: "b".repeat(64) };
		expect(await guard()).toBe(false);
	});

	test("expired input, old source revisions and non-custom targets fail closed", async () => {
		const f = fixture();
		const source = f.registry.listSources()[0];
		if (!source) throw new Error("source missing");
		await rejectsCode(query(f, Date.now() - 1), "timeout");
		await rejectsCode(
			f.registry.query({ ...source, revision: "old-revision" }, target, {
				mode: "probe",
				deadlineAt: Date.now() + 1000,
				signal: new AbortController().signal,
			}),
			"unavailable",
		);
		await rejectsCode(
			f.registry.query(source, { ...target, kind: "codex" } as never, {
				mode: "probe",
				deadlineAt: Date.now() + 1000,
				signal: new AbortController().signal,
			}),
			"invalid_configuration",
		);
		expect(f.issued).toHaveLength(0);
	});

	test("canonical grant denial exposes only a fixed public error", async () => {
		const f = fixture();
		f.setAuthorizer(async (capability) => capability !== "provider.connection.request");
		await rejectsCode(query(f), "permission_denied");
		expect(f.issued).toHaveLength(0);
	});

	test("an authority check that cannot complete fails closed without claiming a denial", async () => {
		// A transient store failure (e.g. "database is locked" while writing the audit row) must not
		// be reported to users as a missing permission, and must still never issue a reference.
		const f = fixture();
		f.setAuthorizer(async () => {
			throw new Error("apiKey=secret raw upstream body: database is locked");
		});
		const failure = await query(f).catch((error: unknown) => error);
		await rejectsCode(Promise.reject(failure), "request_failed");
		expect(String((failure as Error).message)).not.toContain("secret");
		expect(f.issued).toHaveLength(0);
		expect(f.calls).toHaveLength(0);
	});
});

test("pooled key identity stays in the host lease and the actual RPC envelope contains no undefined fields", async () => {
	const f = fixture();
	const keyedTarget = { ...target, id: `${target.id}/keys/key-one`, keyId: "key-one" };
	const source = f.registry.listSources()[0];
	if (!source) throw new Error("Expected quota source");
	expect(
		await f.registry.query(source, keyedTarget, {
			mode: "probe",
			signal: AbortSignal.timeout(1000),
			deadlineAt: Date.now() + 1000,
		}),
	).toEqual(supported);
	expect(f.issued[0]?.target).toEqual(keyedTarget);
	const params = f.calls[0]?.params;
	expect(params?.target).toEqual(target);
	expect(Object.hasOwn(params?.target ?? {}, "keyId")).toBe(false);
	expect(
		jsonRpcEnvelopeSchema.safeParse({
			jsonrpc: "2.0",
			id: "pooled-key-query",
			method: "quota.query",
			params,
		}).success,
	).toBe(true);
});

test("settings-backed quota sources require both explicit settings grants", () => {
	const f = fixture();
	const enhanced = parseManifest({
		...manifest,
		engine: { ...manifest.engine, features: ["host_api.requests", "host_api.provider_settings"] },
		contributes: {
			...manifest.contributes,
			providerSettings: [
				{
					id: "account",
					schemaVersion: 1,
					title: "Account",
					targetKinds: ["custom-api"],
					configSchema: { type: "object", additionalProperties: false, properties: {} },
				},
			],
			quotaSources: manifest.contributes.quotaSources.map((source) => ({
				...source,
				settingsContribution: "account",
			})),
		},
		permissions: {
			host: [
				...manifest.permissions.host,
				"provider.settings.read_self",
				"provider.settings.connection.use",
			],
		},
	});
	f.registry.replaceManifest(enhanced, `1.0.0:${hash}`);
	expect(f.registry.listSources()).toEqual([]);
	f.grants.add("provider.settings.read_self");
	expect(f.registry.listSources()).toEqual([]);
	f.grants.add("provider.settings.connection.use");
	expect(f.registry.listSources()).toHaveLength(1);
	for (const capability of ["provider.settings.read_self", "provider.settings.connection.use"]) {
		f.grants.delete(capability);
		expect(f.registry.listSources()).toEqual([]);
		f.grants.add(capability);
	}
});
