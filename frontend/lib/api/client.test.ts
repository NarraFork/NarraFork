import { afterEach, describe, expect, test } from "bun:test";
import {
	authorizedFetch,
	clearTokenOnSessionFailure,
	endSession,
	getErrorMessage,
	getToken,
	readFetchError,
	readFetchErrorMessage,
	setToken,
} from "./client";

const g = globalThis as typeof globalThis & { localStorage?: Storage };
const originalLocalStorage = g.localStorage;

afterEach(() => {
	if (originalLocalStorage === undefined) {
		Reflect.deleteProperty(g, "localStorage");
	} else {
		Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
	}
});

function installMapLocalStorage(): Map<string, string> {
	const store = new Map<string, string>();
	Object.defineProperty(g, "localStorage", {
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
		},
		configurable: true,
	});
	return store;
}

describe("getErrorMessage", () => {
	test("prefers fallback reason over generic error code", () => {
		expect(
			getErrorMessage(
				{
					error: "FEATURE_DISABLED",
					reason: "Opening the system file manager is not supported on this platform.",
					code: "FS_REVEAL_UNSUPPORTED",
				},
				"Request failed",
			),
		).toBe("Opening the system file manager is not supported on this platform.");
	});

	test("uses message when reason is absent", () => {
		expect(
			getErrorMessage(
				{
					error: { code: -32603, message: "internal" },
					message: "MCP tools are unavailable in this backend.",
				},
				"Request failed",
			),
		).toBe("MCP tools are unavailable in this backend.");
	});

	test("uses nested JSON-RPC error message when no top-level message exists", () => {
		expect(
			getErrorMessage(
				{ error: { code: -32603, message: "JSON-RPC bridge failed" } },
				"Request failed",
			),
		).toBe("JSON-RPC bridge failed");
	});

	test("falls back through error, code, then provided fallback", () => {
		expect(getErrorMessage({ error: "boom" }, "Request failed")).toBe("boom");
		expect(getErrorMessage({ code: "FEATURE_DISABLED" }, "Request failed")).toBe(
			"FEATURE_DISABLED",
		);
		expect(getErrorMessage({}, "Request failed")).toBe("Request failed");
	});

	test("reads structured fetch error responses", async () => {
		const response = new Response(
			JSON.stringify({
				code: "FS_PREVIEW_TOO_LARGE",
				reason: "File too large to preview",
			}),
			{
				status: 413,
				statusText: "Payload Too Large",
				headers: { "content-type": "application/json" },
			},
		);
		const error = await readFetchError(response);
		expect(error.message).toBe("File too large to preview");
		expect(error.data.code).toBe("FS_PREVIEW_TOO_LARGE");
		expect(error.data.reason).toBe("File too large to preview");
	});

	test("reads structured fetch error messages", async () => {
		const response = new Response(
			JSON.stringify({
				code: "FS_PREVIEW_TOO_LARGE",
				reason: "File too large to preview",
			}),
			{
				status: 413,
				statusText: "Payload Too Large",
				headers: { "content-type": "application/json" },
			},
		);
		expect(await readFetchErrorMessage(response)).toBe("File too large to preview");
	});

	test("clears stale token when structured fetch error returns 401", async () => {
		installMapLocalStorage();
		setToken("stale-token");
		expect(getToken()).toBe("stale-token");
		const response = new Response(
			JSON.stringify({
				code: "UNAUTHORIZED",
				reason: "Authentication required",
			}),
			{
				status: 401,
				statusText: "Unauthorized",
				headers: { "content-type": "application/json" },
			},
		);
		expect(await readFetchErrorMessage(response)).toBe("Authentication required");
		expect(getToken()).toBeNull();
	});
});

function json401(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status: 401,
		statusText: "Unauthorized",
		headers: { "content-type": "application/json" },
	});
}

describe("session preservation on non-session 401s", () => {
	test("keeps the token when a second factor fails to verify", async () => {
		installMapLocalStorage();
		setToken("live-session");
		// The user mistyped a TOTP code while turning two-factor auth off. Their
		// session is untouched, so logging them out here would be a regression.
		const response = json401({ code: "MFA_CODE_INVALID", error: "Invalid verification code" });
		expect(await readFetchErrorMessage(response)).toBe("Invalid verification code");
		expect(getToken()).toBe("live-session");
	});

	test("keeps the token when an OAuth-only endpoint rejects a session token", async () => {
		installMapLocalStorage();
		setToken("live-session");
		const response = json401({ code: "OAUTH_REQUIRED", error: "OAuth access token required" });
		await readFetchError(response);
		expect(getToken()).toBe("live-session");
	});

	test("still clears the token when the session itself expired", async () => {
		installMapLocalStorage();
		setToken("expired-session");
		const response = json401({ code: "TOKEN_EXPIRED", error: "Token expired" });
		await readFetchError(response);
		expect(getToken()).toBeNull();
	});

	test("clears the token for a codeless 401 (proxy or legacy route)", async () => {
		installMapLocalStorage();
		setToken("live-session");
		const response = new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
		await readFetchError(response);
		expect(getToken()).toBeNull();
	});

	test("clearTokenOnSessionFailure distinguishes session loss from other 401s", async () => {
		installMapLocalStorage();
		setToken("live-session");
		await clearTokenOnSessionFailure(json401({ code: "PASSKEY_AUTH_FAILED" }));
		expect(getToken()).toBe("live-session");

		await clearTokenOnSessionFailure(json401({ code: "TOKEN_EXPIRED" }));
		expect(getToken()).toBeNull();
	});

	test("clearTokenOnSessionFailure ignores non-401 responses", async () => {
		installMapLocalStorage();
		setToken("live-session");
		await clearTokenOnSessionFailure(new Response("nope", { status: 403 }));
		expect(getToken()).toBe("live-session");
	});
});

/** A session-token-shaped string. */
function opaqueToken(label = "t"): string {
	return `nfs_${label.padEnd(43, "x")}`;
}

describe("authorizedFetch", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function stubFetch(
		respond: (input: string | URL, init?: RequestInit) => Response,
	): Array<{ input: string | URL; init?: RequestInit }> {
		const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			calls.push({ input, init });
			return respond(input, init);
		}) as typeof fetch;
		return calls;
	}

	test("attaches the stored token", async () => {
		installMapLocalStorage();
		const sent = opaqueToken("sent");
		setToken(sent);
		const calls = stubFetch(() => new Response(null, { status: 200 }));

		await authorizedFetch("/api/anything");

		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${sent}`);
		expect(getToken()).toBe(sent);
	});

	test("keeps a caller-provided Authorization header and other init fields", async () => {
		installMapLocalStorage();
		setToken(opaqueToken("stored"));
		const calls = stubFetch(() => new Response(null, { status: 200 }));

		await authorizedFetch("/api/anything", {
			method: "POST",
			headers: { Authorization: "Bearer explicit", "Content-Type": "application/json" },
			body: "{}",
		});

		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer explicit");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(calls[0].init?.method).toBe("POST");
		expect(calls[0].init?.body).toBe("{}");
	});

	test("sends no Authorization header when there is no session", async () => {
		installMapLocalStorage();
		const calls = stubFetch(() => new Response(null, { status: 200 }));
		await authorizedFetch("/api/anything");
		expect(new Headers(calls[0].init?.headers).get("Authorization")).toBeNull();
	});
});

describe("endSession", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("asks the server to revoke the stored session, then forgets it", () => {
		installMapLocalStorage();
		const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		setToken(opaqueToken("current"));

		endSession();

		expect(getToken()).toBeNull();
		expect(String(calls[0].input)).toEndWith("/api/auth/logout");
		expect(calls[0].init?.method).toBe("POST");
		expect(calls[0].init?.keepalive).toBe(true);
		expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(
			`Bearer ${opaqueToken("current")}`,
		);
	});

	test("sends nothing when there is no session", () => {
		installMapLocalStorage();
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(null);
		}) as unknown as typeof fetch;
		endSession();
		expect(called).toBe(false);
	});
});
