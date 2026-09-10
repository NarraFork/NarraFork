/**
 * Integration tests for the private-target proxy gate wired inside
 * `resolveProviderHostHints` in plugin-platform-services.ts.
 *
 * The closure is not directly exported, so we test it through two lenses:
 *
 * 1. **Unit-level composition** — call `decideProviderProxy` + `applyPrivateProxyGate`
 *    with the same inputs `resolveProviderHostHints` uses, controlled via real
 *    `PluginStateStore` / `PluginPermissionStore` instances backed by a temp directory.
 *    This avoids touching global `settings.proxy` and produces deterministic results.
 *
 * 2. **Fire-and-forget side-effect** — verify that `addPendingRequest` is called on
 *    `permissionStore` when a private proxy is suppressed, using real store instances.
 *    A small busy-wait drains the microtask queue so the void promise resolves.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionGrant } from "@server/lib/plugins/permissions";
import type { ProxyOverride } from "@server/lib/settings/types";
import { PluginPermissionStore } from "@server/services/plugin-permission-store";
import {
	applyPrivateProxyGate,
	decideProviderProxy,
	PRIVATE_PROXY_CAPABILITY,
} from "@server/services/plugin-provider-proxy-policy";
import { createPluginStateRecord, PluginStateStore } from "@server/services/plugin-state-store";

const PLUGIN_ID = "com.example.proxy-gate-test";
const INSTALLATION_ID = "test-install-gate-01";

// resolveOverride stub — mirrors what plugin-platform-services uses.
const resolveOverride = (override: ProxyOverride): string | undefined => {
	switch (override.mode) {
		case "direct":
			return undefined;
		case "custom":
			return override.url || undefined;
		default:
			return undefined;
	}
};

// ---------------------------------------------------------------------------
// Temp-dir fixture
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeStores() {
	const root = await mkdtemp(join(tmpdir(), "narrafork-proxy-gate-"));
	roots.push(root);
	const stateStore = new PluginStateStore(root);
	const permissionStore = new PluginPermissionStore({ root, stateStore });
	return { stateStore, permissionStore };
}

/** Drain the microtask queue so fire-and-forget void promises settle. */
async function flushMicrotasks(iterations = 10) {
	for (let i = 0; i < iterations; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * Minimal replica of `resolveProviderHostHints` that uses the same pure
 * functions and the same `getCachedState` lookup as the real closure, but
 * accepts its dependencies explicitly so the test controls them without
 * touching global `settings.proxy`.
 *
 * This is NOT a duplicate of production code — it uses the same pure-function
 * API (`decideProviderProxy`, `applyPrivateProxyGate`) and tests that API is
 * wired correctly.
 */
function runHintsLogic(input: {
	proxyUrl: string;
	stateStore: PluginStateStore;
	permissionStore: PluginPermissionStore;
	pluginId: string;
}) {
	const { proxyUrl, stateStore, permissionStore, pluginId } = input;

	// Step 1: decideProviderProxy (simulating a custom override)
	const decision = decideProviderProxy({
		override: { mode: "custom", url: proxyUrl },
		resolveOverride,
	});
	if (!decision) return { hints: undefined, suppressed: false };

	// Step 2: private-target gate (same logic as platform closure)
	const resolvedUrl = decision.outbound?.proxyUrl;
	if (resolvedUrl) {
		const cachedState = stateStore.getCachedState(pluginId);
		const authorityId =
			cachedState?.installationId ??
			cachedState?.authorityInstallationId ??
			cachedState?.current?.hash;
		const grantedCapabilities =
			authorityId &&
			permissionStore.hasCachedUnrestrictedGlobalGrant(
				pluginId,
				authorityId,
				PRIVATE_PROXY_CAPABILITY,
			)
				? [PRIVATE_PROXY_CAPABILITY]
				: [];
		const gate = applyPrivateProxyGate({ proxyUrl: resolvedUrl, grantedCapabilities });

		if (gate === "suppress") {
			// Fire-and-forget exactly as the platform does
			const installationId =
				cachedState?.installationId ??
				cachedState?.authorityInstallationId ??
				cachedState?.current?.hash;
			if (installationId) {
				void permissionStore
					.addPendingRequest(pluginId, installationId, {
						capability: PRIVATE_PROXY_CAPABILITY,
						scope: { type: "global" },
						source: "runtime",
					})
					.catch(() => undefined);
			}
			return { hints: { outbound: {} }, suppressed: true };
		}
	}

	return { hints: decision, suppressed: false };
}

// ---------------------------------------------------------------------------
// Tests: gate outcome — no FS writes needed for pure decisions
// ---------------------------------------------------------------------------

describe("private proxy gate — full grant authorization", () => {
	const restricted: Partial<PermissionGrant>[] = [
		{ expiresAt: "2000-01-01T00:00:00.000Z" },
		{ scope: { type: "project", id: "project-a" } },
		{ constraints: { providerInstanceIds: ["provider-a"] } },
		{ constraints: { resourceIds: ["10.0.0.1"] } },
		{ constraints: { maxBytes: 100 } },
		{ constraints: { maxRatePerSecond: 1 } },
		{ constraints: { methods: [] } },
	];
	test.each(
		restricted,
	)("denies restricted grant %j despite capability summary", async (restriction) => {
		const { stateStore, permissionStore } = await makeStores();
		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
		});
		await permissionStore.replace(PLUGIN_ID, INSTALLATION_ID, [
			{
				capability: PRIVATE_PROXY_CAPABILITY,
				scope: { type: "global" },
				...restriction,
			},
		]);
		expect(stateStore.getCachedState(PLUGIN_ID)?.grants.capabilities).toContain(
			PRIVATE_PROXY_CAPABILITY,
		);
		expect(
			runHintsLogic({
				proxyUrl: "http://10.0.0.1:3128",
				stateStore,
				permissionStore,
				pluginId: PLUGIN_ID,
			}).suppressed,
		).toBe(true);
		await flushMicrotasks();
	});

	test("checks expiry on every read, installation identity, revocation and cold cache", async () => {
		const { stateStore } = await makeStores();
		let now = new Date("2026-01-01T00:00:00Z");
		const store = new PluginPermissionStore({ root: stateStore.root, now: () => now });
		const allowed = () =>
			store.hasCachedUnrestrictedGlobalGrant(PLUGIN_ID, INSTALLATION_ID, PRIVATE_PROXY_CAPABILITY);
		expect(allowed()).toBe(false);
		await store.replace(PLUGIN_ID, INSTALLATION_ID, [
			{
				capability: PRIVATE_PROXY_CAPABILITY,
				scope: { type: "global" },
				expiresAt: "2026-01-01T00:00:01Z",
			},
		]);
		expect(allowed()).toBe(true);
		expect(
			store.hasCachedUnrestrictedGlobalGrant(PLUGIN_ID, "other-install", PRIVATE_PROXY_CAPABILITY),
		).toBe(false);
		now = new Date("2026-01-01T00:00:01Z");
		expect(allowed()).toBe(false);
		await store.replace(PLUGIN_ID, INSTALLATION_ID, [
			{ capability: PRIVATE_PROXY_CAPABILITY, scope: { type: "global" }, constraints: {} },
		]);
		expect(allowed()).toBe(true);
		await store.replace(PLUGIN_ID, INSTALLATION_ID, []);
		expect(allowed()).toBe(false);
	});

	test("summary alone never authorizes a private proxy", async () => {
		const { stateStore, permissionStore } = await makeStores();
		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
			grants: { count: 1, capabilities: [PRIVATE_PROXY_CAPABILITY], revision: 1 },
		});
		expect(
			runHintsLogic({
				proxyUrl: "http://127.0.0.1:3128",
				stateStore,
				permissionStore,
				pluginId: PLUGIN_ID,
			}).suppressed,
		).toBe(true);
		await flushMicrotasks();
	});
});

describe("private proxy gate — public proxies pass through", () => {
	const publicProxies = [
		"http://proxy.example.com:3128",
		"https://corporate-proxy.acme.corp:8443",
		"http://8.8.8.8:3128",
		"socks5://1.2.3.4:1080",
		"http://104.21.0.1:3128",
	];

	test.each(publicProxies)("allows public proxy %s", async (proxyUrl) => {
		const { stateStore, permissionStore } = await makeStores();

		// Plugin has no grants — still allowed because it's a public target
		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
			grants: { count: 0, capabilities: [], revision: 1 },
		});
		await stateStore.initialize();

		const result = runHintsLogic({ proxyUrl, stateStore, permissionStore, pluginId: PLUGIN_ID });
		expect(result.suppressed).toBe(false);
		expect(result.hints?.outbound?.proxyUrl).toBe(proxyUrl);
	});
});

describe("private proxy gate — private proxies suppressed without capability", () => {
	const privateProxies = [
		"http://127.0.0.1:3128",
		"http://localhost:3128",
		"http://10.0.0.1:3128",
		"http://192.168.1.1:3128",
		"http://172.16.0.1:3128",
		"http://169.254.0.1:3128",
		"http://[::1]:3128",
		"http://[fe80::1]:3128",
		"http://[fd00::1]:3128",
		"socks5://10.0.0.50:1080",
	];

	test.each(privateProxies)("suppresses private proxy %s (no grants)", async (proxyUrl) => {
		const { stateStore, permissionStore } = await makeStores();

		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
			grants: { count: 0, capabilities: [], revision: 1 },
		});
		await stateStore.initialize();

		const result = runHintsLogic({ proxyUrl, stateStore, permissionStore, pluginId: PLUGIN_ID });
		expect(result.suppressed).toBe(true);
		// Returns empty outbound so plugin clears any previous proxy
		expect(result.hints).toEqual({ outbound: {} });
	});
});

describe("private proxy gate — private proxies allowed with network.egress.allowlist", () => {
	const privateProxies = [
		"http://127.0.0.1:3128",
		"http://localhost:3128",
		"http://10.0.0.1:3128",
		"http://192.168.1.1:3128",
		"socks5://10.0.0.50:1080",
	];

	test.each(
		privateProxies,
	)("allows private proxy %s when capability is granted", async (proxyUrl) => {
		const { stateStore, permissionStore } = await makeStores();

		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
			grants: {
				count: 1,
				capabilities: [PRIVATE_PROXY_CAPABILITY],
				revision: 2,
			},
		});
		await stateStore.initialize();
		await permissionStore.replace(PLUGIN_ID, INSTALLATION_ID, [
			{ capability: PRIVATE_PROXY_CAPABILITY, scope: { type: "global" } },
		]);

		const result = runHintsLogic({
			proxyUrl,
			stateStore,
			permissionStore,
			pluginId: PLUGIN_ID,
		});
		expect(result.suppressed).toBe(false);
		expect(result.hints?.outbound?.proxyUrl).toBe(proxyUrl);
	});
});

// ---------------------------------------------------------------------------
// Test: fire-and-forget addPendingRequest side-effect
// ---------------------------------------------------------------------------

describe("private proxy gate — pending permission request", () => {
	test("records a pending request when a private proxy is suppressed", async () => {
		const { stateStore, permissionStore } = await makeStores();

		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
			grants: { count: 0, capabilities: [], revision: 1 },
		});
		await stateStore.initialize();

		// Trigger suppression
		runHintsLogic({
			proxyUrl: "http://192.168.1.100:3128",
			stateStore,
			permissionStore,
			pluginId: PLUGIN_ID,
		});

		// Drain microtasks to let the void promise settle
		await flushMicrotasks();

		const pending = await permissionStore.listPendingRequests(PLUGIN_ID, INSTALLATION_ID);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.capability).toBe(PRIVATE_PROXY_CAPABILITY);
		expect(pending[0]?.scope).toEqual({ type: "global" });
		expect(pending[0]?.source).toBe("runtime");
		expect(pending[0]?.status).toBe("pending");
	});

	test("addPendingRequest is idempotent — repeated suppression does not stack rows", async () => {
		const { stateStore, permissionStore } = await makeStores();

		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
			grants: { count: 0, capabilities: [], revision: 1 },
		});
		await stateStore.initialize();

		const opts = {
			proxyUrl: "http://10.0.0.1:3128",
			stateStore,
			permissionStore,
			pluginId: PLUGIN_ID,
		};

		// Simulate three rapid calls (hot request path)
		runHintsLogic(opts);
		runHintsLogic(opts);
		runHintsLogic(opts);

		await flushMicrotasks();

		const pending = await permissionStore.listPendingRequests(PLUGIN_ID, INSTALLATION_ID);
		expect(pending).toHaveLength(1);
	});

	test("no pending request is added for a public proxy", async () => {
		const { stateStore, permissionStore } = await makeStores();

		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
			grants: { count: 0, capabilities: [], revision: 1 },
		});
		await stateStore.initialize();

		runHintsLogic({
			proxyUrl: "http://proxy.example.com:3128",
			stateStore,
			permissionStore,
			pluginId: PLUGIN_ID,
		});

		await flushMicrotasks();

		const pending = await permissionStore.listPendingRequests(PLUGIN_ID, INSTALLATION_ID);
		expect(pending).toHaveLength(0);
	});

	test("no pending request when state is not yet cached (installationId unknown)", async () => {
		// State store has never been loaded — getCachedState returns undefined,
		// so the platform silently skips addPendingRequest.
		const { stateStore, permissionStore } = await makeStores();
		// Deliberately do NOT call stateStore.initialize() or setState

		runHintsLogic({
			proxyUrl: "http://127.0.0.1:3128",
			stateStore,
			permissionStore,
			pluginId: PLUGIN_ID,
		});

		await flushMicrotasks();

		// Cannot list pending without an installationId, but we can check the
		// permissionStore document has no entry for this plugin.
		const snapshot = await permissionStore.snapshot();
		const hasEntry = snapshot.sets.some((s) => s.pluginId === PLUGIN_ID);
		expect(hasEntry).toBe(false);
	});

	test("pending request is not added when capability is already granted", async () => {
		const { stateStore, permissionStore } = await makeStores();

		await stateStore.setState({
			...createPluginStateRecord(PLUGIN_ID),
			installationId: INSTALLATION_ID,
			grants: {
				count: 1,
				capabilities: [PRIVATE_PROXY_CAPABILITY],
				revision: 2,
			},
		});
		await stateStore.initialize();
		await permissionStore.replace(PLUGIN_ID, INSTALLATION_ID, [
			{ capability: PRIVATE_PROXY_CAPABILITY, scope: { type: "global" } },
		]);

		runHintsLogic({
			proxyUrl: "http://10.1.2.3:3128",
			stateStore,
			permissionStore,
			pluginId: PLUGIN_ID,
		});

		await flushMicrotasks();

		const pending = await permissionStore.listPendingRequests(PLUGIN_ID, INSTALLATION_ID);
		expect(pending).toHaveLength(0);
	});
});
