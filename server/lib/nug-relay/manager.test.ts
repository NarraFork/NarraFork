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
	setNugCachedModels("relay-owner-test", []);
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

test("only the exact live credential and endpoint may use a connection relay", () => {
	const config = connection();
	ensureNugRelayClient(config);
	const channel = getNugRelayChannelId(config.id);
	expect(channel).toBeTruthy();
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
	ensureNugRelayClient(old);
	const oldChannel = getNugRelayChannelIdForCredential(old);
	const updated = connection({ apiKey: "secret-b" });
	ensureNugRelayClient(updated);
	expect(getNugRelayChannelIdForCredential(old)).toBeNull();
	expect(getNugRelayChannelIdForCredential(updated)).not.toBe(oldChannel);
	const moved = { ...updated, baseUrl: "https://new.example" };
	ensureNugRelayClient(moved);
	expect(getNugRelayChannelIdForCredential(updated)).toBeNull();
	expect(getNugRelayChannelIdForCredential(moved)).toBeTruthy();
	expect(clients).toHaveLength(3);
});

test("egress mode or proxy changes restart the relay, while direct mode removes it", () => {
	const old = connection();
	ensureNugRelayClient(old);
	const proxied = connection({
		egressMode: "local-proxy",
		egressProxyUrl: "http://127.0.0.1:8123",
	});
	ensureNugRelayClient(proxied);
	expect(getNugRelayChannelIdForCredential(old)).toBeNull();
	expect(getNugRelayChannelIdForCredential(proxied)).toBeTruthy();
	expect(clients).toHaveLength(2);
	ensureNugRelayClient({ ...proxied, egressMode: "nug" });
	expect(getNugRelayChannelIdForCredential(proxied)).toBeNull();
});
