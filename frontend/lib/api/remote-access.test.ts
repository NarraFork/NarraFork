import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { RemoteAccessInvitation, RemoteAccessStatus } from "@shared/remote-access/management";
import { setToken } from "./client";
import { remoteAccessApi } from "./remote-access";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalFetch = globalThis.fetch;
const calls: { input: string; init: RequestInit }[] = [];
const storage = new Map<string, string>();
let response: unknown;
let responseStatus = 200;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const status: RemoteAccessStatus = {
	enabled: false,
	state: "disabled",
	installed: false,
	componentVersion: "0.2.0-alpha.1",
	instanceId: null,
	peers: 0,
	lastError: null,
	config: {
		enabled: false,
		signalUrl: "wss://signal.example.invalid/signal/instance",
		stunUrls: ["stun:stun.example.invalid:3478"],
		iceIPAllowlist: [],
		iceInterfaceAllowlist: [],
		iceNetworkTypes: ["udp4", "udp6"],
		allowLocalhost: false,
		leaseSeconds: 300,
	},
};

beforeEach(() => {
	calls.length = 0;
	storage.clear();
	response = status;
	responseStatus = 200;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
	});
	setToken("nfs_administrator_test");
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (...[input, init]: Parameters<typeof fetch>) => {
				calls.push({ input: String(input), init: init ?? {} });
				return Response.json(response, { status: responseStatus });
			},
			{ preconnect: originalFetch.preconnect },
		),
	);
});

afterEach(() => {
	fetchSpy.mockRestore();
	if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("ordinary administrator remote access client", () => {
	test("status only performs an authenticated GET; no implicit install or activation", async () => {
		expect(await remoteAccessApi.status()).toEqual(status);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("/api/remote-access/status");
		expect(calls[0]?.init.method ?? "GET").toBe("GET");
		expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
			"Bearer nfs_administrator_test",
		);
		expect(calls[0]?.init.body).toBeUndefined();
	});

	test("installation is explicit and does not enable remote access", async () => {
		await remoteAccessApi.install();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("/api/remote-access/component/install");
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.body).toBe("{}");
	});

	test("configuration uses the existing settings API and preserves advanced fields", async () => {
		const config = { ...status.config, enabled: true, iceInterfaceAllowlist: ["eth0"] };
		await remoteAccessApi.configure(config);
		expect(calls[0]?.input).toBe("/api/settings");
		expect(calls[0]?.init.method).toBe("PATCH");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ remoteAccess: config });
	});

	test("one-time invitation is returned, never written to storage or placed in the URL", async () => {
		const invitation: RemoteAccessInvitation = {
			instanceId: "a".repeat(52),
			publicKey: `04${"ab".repeat(64)}`,
			pairId: "invite1",
			pairingSecret: "private_pairing_secret",
			discoveryCapability: "private_discovery_capability",
			expiresAt: 1_800_000_000,
			signalUrl: "wss://signal.example.invalid/signal/browser",
		};
		response = { invitation };
		expect(await remoteAccessApi.createInvitation()).toEqual({ invitation });
		expect(calls[0]?.input).toBe("/api/remote-access/invitations");
		expect(calls[0]?.init.body).toBe("{}");
		expect(JSON.stringify([...storage])).not.toContain(invitation.pairingSecret);
		expect(JSON.stringify([...storage])).not.toContain(invitation.discoveryCapability);
	});

	test("grant revocation and invitation cancellation are separate DELETE operations", async () => {
		response = { ok: true };
		await remoteAccessApi.revokeGrant("grant_1");
		await remoteAccessApi.cancelInvitation("invite_1");
		expect(calls.map((call) => [call.init.method, call.input])).toEqual([
			["DELETE", "/api/remote-access/grants/grant_1"],
			["DELETE", "/api/remote-access/invitations/invite_1"],
		]);
	});

	test("passes cancellation through the sole authorised request entry", async () => {
		const controller = new AbortController();
		await remoteAccessApi.status(controller.signal);
		expect(calls[0]?.init.signal).toBe(controller.signal);
	});

	test("does not hide administrator authorization failures", async () => {
		responseStatus = 403;
		response = { error: "Administrator access required", code: "FORBIDDEN" };
		await expect(remoteAccessApi.createInvitation()).rejects.toThrow(
			"Administrator access required",
		);
		expect(calls).toHaveLength(1);
	});
});
