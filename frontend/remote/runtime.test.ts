import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { RemoteBackendIdentity } from "@shared/remote-access/application";
import type { RemoteBusinessTransport } from "@shared/remote-access/business-transport";
import { apiUrl, assetUrl, getAssetBase, getRouterBasepath } from "./base-path";
import { businessTransport } from "./business-transport";
import {
	authenticateRemoteSession,
	clearRemoteRuntime,
	initializeRemoteRuntime,
	isRemoteSessionAuthenticated,
	onRemoteCleanup,
	remoteRuntime,
} from "./runtime";
import { establishRemoteSession } from "./session";

const identity: RemoteBackendIdentity = {
	nfVersion: "0.1.0",
	repository: "owner/narrafork",
	sourceCommit: "a".repeat(40),
	bootstrapAbi: 1,
	apiEpoch: 1,
	wireVersion: 2,
	capabilities: ["projects", "narrators", "approvals", "small-attachments", "sse", "binary-socket"],
};
const assetBase = `https://instance.test/remote/frontends/${"b".repeat(64)}/`;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalFetch = globalThis.fetch;
let nativeRequests = 0;
function client(): RemoteBusinessTransport {
	return {
		backendIdentity: structuredClone(identity),
		authenticate: mock(async () => {}),
		request: mock(async () => Response.json({ ok: true })),
		upload: mock(async (_path, _body, options) => {
			options?.onProgress?.(1);
			return Response.json({ ok: true });
		}),
		openSocket: mock(() => {
			throw new Error("test socket not installed");
		}),
		close: mock(() => {}),
	};
}
function initialize(transport = client()) {
	initializeRemoteRuntime({
		root: {} as HTMLElement,
		backendIdentity: identity,
		transport,
		assetBase,
	});
	return transport;
}
beforeEach(() => {
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: new URL("https://instance.test/narrators/abc"),
	});
	nativeRequests = 0;
	globalThis.fetch = Object.assign(
		mock(() => {
			nativeRequests++;
			throw new Error("Native business request forbidden");
		}),
		{ preconnect: () => {} },
	);
});
afterEach(() => {
	clearRemoteRuntime();
	globalThis.fetch = originalFetch;
	if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
	else Reflect.deleteProperty(globalThis, "location");
});

test("uninitialized, forbidden and absolute requests cannot reach native HTTP", () => {
	expect(() => businessTransport.request("/api/projects")).toThrow();
	initialize();
	for (const path of [
		"https://instance.test/api/projects",
		"/api/terminal",
		"/api/plugins",
		"/api/projects/../settings",
		"//evil.test/api/projects",
	])
		expect(() => businessTransport.request(path)).toThrow();
	expect(nativeRequests).toBe(0);
});
test("business queries are unavailable before admin authentication, login stays paired", async () => {
	const transport = initialize();
	expect(() => businessTransport.request("/api/projects")).toThrow("REMOTE_REQUEST_UNSUPPORTED");
	await businessTransport.request("/api/auth/login", { method: "POST", body: "{}" });
	expect(transport.request).toHaveBeenCalledTimes(1);
	await authenticateRemoteSession("nfs_token");
	expect(isRemoteSessionAuthenticated()).toBe(true);
	const signal = new AbortController().signal;
	await businessTransport.request("/api/projects", { signal });
	expect(transport.request).toHaveBeenLastCalledWith("/api/projects", { signal });
	expect(nativeRequests).toBe(0);
});
test("upload retains progress/abort and logical socket extracts only the bearer token", async () => {
	const transport = initialize();
	await authenticateRemoteSession("nfs_token");
	const progress = mock(() => {});
	await businessTransport.upload("/api/narrator-attachments/abc", new Blob(["file"]), {
		onProgress: progress,
	});
	expect(progress).toHaveBeenCalledWith(1);
	expect(() => businessTransport.openSocket("/ws/narrator", "token=nfs_token")).toThrow(
		"test socket",
	);
	expect(transport.openSocket).toHaveBeenCalledWith("/ws/narrator", "nfs_token");
	expect(() => businessTransport.openSocket("/ws/narrator", "share=x&token=y")).toThrow(
		"REMOTE_SOCKET_CREDENTIAL_INVALID",
	);
	expect(() => businessTransport.openSocket("/ws/terminal", "token=x")).toThrow(
		"REMOTE_SOCKET_UNSUPPORTED",
	);
});
test("static, business and router bases remain independent", () => {
	initialize();
	expect(apiUrl("/api/narrators/abc")).toBe("/api/narrators/abc");
	expect(getRouterBasepath()).toBe("");
	expect(getAssetBase()).toBe(assetBase);
	expect(assetUrl("shiki/langs/typescript.mjs")).toBe(`${assetBase}shiki/langs/typescript.mjs`);
	expect(() => assetUrl("../api/settings")).toThrow();
});
test("identity drift and cross-origin asset directories fail closed", () => {
	const transport = client();
	expect(() =>
		initializeRemoteRuntime({
			root: {} as HTMLElement,
			transport,
			backendIdentity: identity,
			assetBase: "https://evil.test/",
		}),
	).toThrow("REMOTE_ASSET_BASE_INVALID");
	initialize(transport);
	Object.assign(transport, { backendIdentity: { ...identity, nfVersion: "0.2.0" } });
	expect(() => remoteRuntime()).toThrow("REMOTE_BACKEND_IDENTITY_CHANGED");
	expect(transport.close).toHaveBeenCalledTimes(1);
});
test("session token is saved strictly after RTC admin authentication", async () => {
	let complete!: () => void;
	const transport = client();
	transport.authenticate = mock(
		() =>
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
	);
	initialize(transport);
	const persist = mock(() => {});
	const session = { token: "nfs_token", user: { role: "admin" }, language: "en" as const };
	const applying = establishRemoteSession(session, persist);
	expect(persist).not.toHaveBeenCalled();
	complete();
	await applying;
	expect(persist).toHaveBeenCalledWith("nfs_token");
});
test("non-admin and failed authentication never persist a token", async () => {
	const transport = initialize();
	const persist = mock(() => {});
	await expect(
		establishRemoteSession({ token: "secret", user: { role: "user" }, language: "en" }, persist),
	).rejects.toThrow("REMOTE_ADMIN_REQUIRED");
	expect(transport.authenticate).not.toHaveBeenCalled();
	transport.authenticate = mock(async () => {
		throw new Error("MFA/session rejected");
	});
	await expect(
		establishRemoteSession({ token: "secret", user: { role: "admin" }, language: "en" }, persist),
	).rejects.toThrow();
	expect(persist).not.toHaveBeenCalled();
});
test("cleanup releases later resources even if one disposer throws", () => {
	const transport = initialize();
	onRemoteCleanup(() => {
		throw new Error("first cleanup failed");
	});
	const dispose = mock(() => {});
	onRemoteCleanup(dispose);
	clearRemoteRuntime();
	expect(dispose).toHaveBeenCalledTimes(1);
	expect(transport.close).toHaveBeenCalledTimes(1);
	expect(isRemoteSessionAuthenticated()).toBe(false);
});
