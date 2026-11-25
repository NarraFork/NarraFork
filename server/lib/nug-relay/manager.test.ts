import { afterAll, afterEach, expect, mock, test } from "bun:test";
import type { NUGProviderConfig } from "../settings";

const realClient = { ...(await import("./relay-client")) };
let sequence = 0;
const clients: StubRelayClient[] = [];
class StubRelayClient {
	status = "connecting";
	currentChannelId: string | null = null;
	constructor() {
		clients.push(this);
	}
	start() {
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
} = await import("./manager");
afterEach(() => {
	stopAllNugRelayClients();
	clients.length = 0;
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
