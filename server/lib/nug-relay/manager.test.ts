import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { setNugCachedModels } from "../nug-model-cache";
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "../provider-keys";
import { type NUGProviderConfig, saveSettings, settings } from "../settings";

const realClient = { ...(await import("./relay-client")) };
let sequence = 0;
let automaticReady = true;
const saved = structuredClone(settings);
const clients: StubRelayClient[] = [];
class StubRelayClient {
	status = "connecting";
	currentChannelId: string | null = null;
	constructor(readonly options: import("./relay-client").NugRelayClientOptions) {
		clients.push(this);
	}
	start() {
		if (automaticReady) this.ready();
	}
	ready() {
		this.status = "online";
		this.currentChannelId = `channel-${++sequence}`;
	}
	stop() {
		this.status = "stopped";
		this.currentChannelId = null;
	}
}
mock.module("./relay-client", () => ({ ...realClient, NugRelayClient: StubRelayClient }));
const {
	ensureNugRelayClient,
	getNugRelayChannelIdForCredential,
	getNugRelayChannelId,
	stopAllNugRelayClients,
	startNugRelayOwner,
} = await import("./manager");
const { autoSourceFacts } = await import("../agent/auto-route-signals");
const { resolveProviderAndModel } = await import("../agent/provider");
afterEach(() => {
	stopAllNugRelayClients();
	getProviderKeyStore().removeProvider(nugKeyOwner("relay-owner-test"));
	getProviderKeyStore().removeProvider(nugKeyOwner("relay-slow-models"));
	setNugCachedModels("relay-owner-test", []);
	setNugCachedModels("relay-slow-models", []);
	saveSettings(structuredClone(saved));
	clients.length = 0;
	automaticReady = true;
});
afterAll(() => {
	mock.module("./relay-client", () => realClient);
	mock.restore();
});
const connection = (fields: Partial<NUGProviderConfig> = {}): NUGProviderConfig => ({
	id: "relay-owner-test",
	name: "relay test",
	prefix: "relay-test",
	apiKey: "secret-a",
	baseUrl: "https://nug.example",
	defaultModel: "codex:model",
	egressMode: "local-direct",
	...fields,
});

function ownerFixture() {
	automaticReady = false;
	saveSettings({
		...settings,
		nugProviders: [connection({ apiKey: "", defaultModel: "upstream:gpt-5.5" })],
	});
	setNugCachedModels("relay-owner-test", [
		{ id: "upstream:gpt-5.5", channel: "upstream", channelType: "codex", model: "gpt-5.5" },
	]);
	const store = getProviderKeyStore();
	const first = store.add(nugKeyOwner("relay-owner-test"), { apiKey: "secret-a" });
	const backup = store.add(nugKeyOwner("relay-owner-test"), { apiKey: "secret-b" });
	return { store, first, backup };
}
function hotAutoAvailable(available: boolean) {
	const read = spyOn(fs, "readFileSync").mockImplementation(() => {
		throw new Error("Auto must not read files");
	});
	const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Auto must not use the network"),
	);
	try {
		expect(autoSourceFacts("relay-test", Date.now(), "relay-test:upstream:gpt-5.5").available).toBe(
			available,
		);
		expect(read).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		read.mockRestore();
		fetch.mockRestore();
	}
}

for (const edit of ["remove", "rotate", "disable"] as const) {
	test(`committed KeyStore ${edit} reconciles the relay before Auto can select the new credential`, async () => {
		const { store, first, backup } = ownerFixture();
		startNugRelayOwner();
		await Promise.resolve();
		expect(clients).toHaveLength(1);
		clients[0]?.ready();
		hotAutoAvailable(true);
		if (edit === "remove") store.remove(first.id);
		else if (edit === "disable") store.update(first.id, { disabled: true });
		else {
			store.update(first.id, { apiKey: "rotated-a" });
			// A settings save updates the key projection before publishing its new endpoint.
			saveSettings({
				...settings,
				nugProviders: settings.nugProviders?.map((config) => ({
					...config,
					baseUrl: "https://new-nug.example",
				})),
			});
		}
		if (edit === "disable") expect(settings.nugProviders?.[0]?.apiKey).toBe("secret-a");
		hotAutoAvailable(false);
		expect(clients).toHaveLength(1);
		await Promise.resolve();
		expect(clients).toHaveLength(2);
		expect(clients[0]?.status).toBe("stopped");
		const next = clients[1];
		if (!next) throw new Error("missing reconciled relay");
		expect(next.options).toMatchObject({
			apiKey: edit === "rotate" ? "rotated-a" : backup.apiKey,
			baseUrl: edit === "rotate" ? "https://new-nug.example" : "https://nug.example",
		});
		hotAutoAvailable(false);
		next.ready();
		hotAutoAvailable(true);
		// Only after owner → socket-ready → pure Auto succeeds may a lazy adapter be built.
		// It must reuse B, not restore the still-projected disabled A.
		if (edit === "disable") expect(settings.nugProviders?.[0]?.apiKey).not.toBe(backup.apiKey);
		resolveProviderAndModel("relay-test:upstream:gpt-5.5");
		expect(clients).toHaveLength(2);
		const selected = edit === "rotate" ? store.get(first.id) : store.get(backup.id);
		const config = settings.nugProviders?.[0];
		if (!selected || !config) throw new Error("missing live relay credential");
		expect(getNugRelayChannelIdForCredential(withProviderKey(config, selected))).toBe(
			next.currentChannelId,
		);
		if (edit === "disable") {
			store.update(backup.id, { disabled: true });
			await Promise.resolve();
			expect(getNugRelayChannelId(config.id)).toBeNull();
			expect(next.status).toBe("stopped");
			hotAutoAvailable(false);
		}
		if (edit === "rotate") {
			// A settings-only commit must also notify the owner, without a key mutation.
			saveSettings({
				...settings,
				nugProviders: settings.nugProviders?.map((provider) => ({
					...provider,
					baseUrl: "https://settings-only.example",
				})),
			});
			await Promise.resolve();
			expect(clients).toHaveLength(3);
			expect(clients[2]?.options).toMatchObject({
				apiKey: "rotated-a",
				baseUrl: "https://settings-only.example",
			});
			hotAutoAvailable(false);
			clients[2]?.ready();
			hotAutoAvailable(true);
		}
	});
}

test.each([
	"settings-first",
	"keys-first",
] as const)("late bulk refresh %s cannot send live B to a captured old gateway or stop the new relay", async (commitOrder) => {
	const { Hono } = await import("hono");
	const { nugRoutes } = await import("../../routes/nug");
	const { setOutboundFetchOverrideForTest } = await import("../net/outbound-fetch");
	const { store, first, backup } = ownerFixture();
	store.update(backup.id, { disabled: true });
	const captured = settings.nugProviders?.[0];
	if (!captured) throw new Error("missing captured bulk connection");
	saveSettings({
		...settings,
		nugProviders: [
			{
				...connection({
					id: "relay-slow-models",
					prefix: "relay-slow",
					apiKey: "slow-models-key",
					baseUrl: "https://slow-models.example",
					egressMode: "nug",
				}),
			},
			captured,
		],
	});
	startNugRelayOwner();
	await Promise.resolve();
	clients[0]?.ready();
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const http: Array<{ url: string; auth: string | null }> = [];
	setOutboundFetchOverrideForTest(async (input, init) => {
		const url = String(input);
		http.push({ url, auth: new Headers(init?.headers).get("Authorization") });
		if (url.startsWith("https://slow-models.example")) {
			started.resolve();
			await finish.promise;
		}
		return Response.json({ models: [] });
	});
	const app = new Hono();
	app.route("/", nugRoutes);
	const pending = app.request("/models/refresh", { method: "POST" });
	const settled = Promise.allSettled([pending]);
	try {
		await started.promise;
		// The actual bulk route retains its old array while awaiting the first gateway.
		// In keys-first order, projection even mutates that captured entry's secret to B.
		const publishGateway = () =>
			saveSettings({
				...settings,
				nugProviders: settings.nugProviders?.map((config) =>
					config.id === captured.id
						? { ...config, baseUrl: "https://new-gateway.example" }
						: config,
				),
			});
		const promoteBackup = () => {
			store.remove(first.id);
			store.update(backup.id, { disabled: false });
		};
		if (commitOrder === "settings-first") {
			publishGateway();
			promoteBackup();
		} else {
			promoteBackup();
			publishGateway();
		}
		await Promise.resolve();
		const live = clients.at(-1);
		if (!live) throw new Error("missing live new-gateway relay");
		expect(live.options).toMatchObject({
			apiKey: backup.apiKey,
			baseUrl: "https://new-gateway.example",
		});
		live.ready();
		hotAutoAvailable(true);
		finish.resolve();
		const response = await pending;
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(
			body.results.find((result: { providerId: string }) => result.providerId === captured.id)
				?.error,
		).toContain("connection changed");
		expect(http).toEqual([
			{ url: "https://slow-models.example/v1/models", auth: "Bearer slow-models-key" },
		]);
		// Even the compatibility ensure entrypoint must ignore a stale direct-egress snapshot.
		ensureNugRelayClient({ ...captured, egressMode: "nug" });
		expect(
			clients
				.filter((client) => client.options.apiKey === backup.apiKey)
				.map((client) => client.options.baseUrl),
		).toEqual(["https://new-gateway.example"]);
		expect(live.status).toBe("online");
		expect(getNugRelayChannelId(captured.id)).toBe(live.currentChannelId);
		hotAutoAvailable(true);
	} finally {
		finish.resolve();
		await settled;
		setOutboundFetchOverrideForTest(null);
	}
});

test("startup promotes an enabled backup and stop cancels queued work and both subscriptions", async () => {
	const { store, first, backup } = ownerFixture();
	store.update(first.id, { disabled: true });
	startNugRelayOwner();
	startNugRelayOwner();
	await Promise.resolve();
	expect(clients).toHaveLength(1);
	expect(clients[0]?.options.apiKey).toBe(backup.apiKey);
	clients[0]?.ready();
	hotAutoAvailable(true);
	store.update(backup.id, { apiKey: "queued-after-ready" });
	stopAllNugRelayClients();
	await Promise.resolve();
	expect(clients).toHaveLength(1);
	expect(clients[0]?.status).toBe("stopped");
	store.update(backup.id, { apiKey: "changed-after-stop" });
	saveSettings({
		...settings,
		nugProviders: settings.nugProviders?.map((config) => ({
			...config,
			baseUrl: "https://after-stop.example",
		})),
	});
	await Promise.resolve();
	expect(clients).toHaveLength(1);
	expect(getNugRelayChannelId("relay-owner-test")).toBeNull();
	hotAutoAvailable(false);
});

function publishRelay(config: NUGProviderConfig) {
	saveSettings({ ...settings, nugProviders: [structuredClone(config)] });
	ensureNugRelayClient(config);
}

test("only the exact live credential and endpoint may use a connection relay", () => {
	const config = connection();
	publishRelay(config);
	const channel = getNugRelayChannelId(config.id);
	expect(channel).toBeTruthy();
	ensureNugRelayClient({ ...config, id: "not-committed", baseUrl: "https://discarded.example" });
	expect(clients).toHaveLength(1);
	expect(getNugRelayChannelIdForCredential(config)).toBe(channel);
	expect(getNugRelayChannelIdForCredential({ ...config, apiKey: "secret-b" })).toBeNull();
	expect(
		getNugRelayChannelIdForCredential({ ...config, baseUrl: "https://other.example" }),
	).toBeNull();
	const current = clients.at(-1);
	if (!current) throw new Error("Missing relay test client");
	current.status = "connecting";
	expect(getNugRelayChannelIdForCredential(config)).toBeNull();
});

test("relogin, reorder, and endpoint changes invalidate an old adapter at send time", () => {
	const old = connection();
	publishRelay(old);
	const oldChannel = getNugRelayChannelIdForCredential(old);
	const updated = connection({ apiKey: "secret-b" });
	publishRelay(updated);
	expect(getNugRelayChannelIdForCredential(old)).toBeNull();
	expect(getNugRelayChannelIdForCredential(updated)).not.toBe(oldChannel);
	const moved = { ...updated, baseUrl: "https://new.example" };
	publishRelay(moved);
	expect(getNugRelayChannelIdForCredential(updated)).toBeNull();
	expect(getNugRelayChannelIdForCredential(moved)).toBeTruthy();
	expect(clients).toHaveLength(3);
});

test("egress mode or proxy changes restart the relay, while direct mode removes it", () => {
	const old = connection();
	publishRelay(old);
	const proxied = connection({
		egressMode: "local-proxy",
		egressProxyUrl: "http://127.0.0.1:8123",
	});
	publishRelay(proxied);
	expect(getNugRelayChannelIdForCredential(old)).toBeNull();
	expect(getNugRelayChannelIdForCredential(proxied)).toBeTruthy();
	expect(clients).toHaveLength(2);
	publishRelay({ ...proxied, egressMode: "nug" });
	expect(getNugRelayChannelIdForCredential(proxied)).toBeNull();
});
