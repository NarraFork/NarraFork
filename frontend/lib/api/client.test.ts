import { afterEach, describe, expect, test } from "bun:test";
import { SESSION_RENEWAL_HEADER } from "@shared/session-auth";
import {
	absorbRenewedToken,
	authorizedFetch,
	clearTokenOnSessionFailure,
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

	test("keeps the token when an OAuth-only endpoint rejects a session JWT", async () => {
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

/**
 * Build a session-JWT-shaped string with the given `exp`. Only the payload
 * matters here: the client compares expiries, it never verifies signatures.
 */
function tokenWithExp(exp: number, label = "t"): string {
	const encode = (value: object) =>
		btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: label, exp })}.sig-${label}`;
}

const NOW = Math.floor(Date.now() / 1000);

describe("absorbRenewedToken", () => {
	function withRenewalHeader(token: string, status = 200): Response {
		return new Response(null, {
			status,
			headers: { [SESSION_RENEWAL_HEADER]: token },
		});
	}

	test("swaps in the renewed token from the response header", () => {
		installMapLocalStorage();
		const older = tokenWithExp(NOW + 3600, "old");
		const newer = tokenWithExp(NOW + 7 * 24 * 3600, "new");
		setToken(older);
		absorbRenewedToken(withRenewalHeader(newer));
		expect(getToken()).toBe(newer);
	});

	test("does nothing when the response carries no renewal header", () => {
		installMapLocalStorage();
		setToken("old-token");
		absorbRenewedToken(new Response(null, { status: 200 }));
		expect(getToken()).toBe("old-token");
	});

	test("does not resurrect a session that was already cleared", () => {
		installMapLocalStorage();
		// Logged out in another tab while a request was still in flight.
		absorbRenewedToken(withRenewalHeader(tokenWithExp(NOW + 3600)));
		expect(getToken()).toBeNull();
	});

	test("refuses a renewal that is not strictly newer than the stored token", () => {
		installMapLocalStorage();
		const newer = tokenWithExp(NOW + 7 * 24 * 3600, "new");
		setToken(newer);
		// Parallel requests inside the renewal window each get their own token and
		// the responses can land in any order, so the last writer must not win.
		absorbRenewedToken(withRenewalHeader(tokenWithExp(NOW + 3 * 24 * 3600, "older")));
		expect(getToken()).toBe(newer);
		// Same expiry is not an improvement either.
		absorbRenewedToken(withRenewalHeader(tokenWithExp(NOW + 7 * 24 * 3600, "equal")));
		expect(getToken()).toBe(newer);
	});

	test("does not overwrite a session belonging to a different account", () => {
		installMapLocalStorage();
		const accountA = tokenWithExp(NOW + 3600, "a");
		const accountB = tokenWithExp(NOW + 3600, "b");
		setToken(accountA);
		// Request went out as account A; the user switched to B before it returned.
		setToken(accountB);
		absorbRenewedToken(withRenewalHeader(tokenWithExp(NOW + 7 * 24 * 3600, "a-renewed")), accountA);
		expect(getToken()).toBe(accountB);
	});

	test("absorbs when the stored token still matches the one the request used", () => {
		installMapLocalStorage();
		const sent = tokenWithExp(NOW + 3600, "sent");
		const renewed = tokenWithExp(NOW + 7 * 24 * 3600, "renewed");
		setToken(sent);
		absorbRenewedToken(withRenewalHeader(renewed), sent);
		expect(getToken()).toBe(renewed);
	});

	test("ignores a renewal header on a failed response", () => {
		installMapLocalStorage();
		const current = tokenWithExp(NOW + 3600, "current");
		setToken(current);
		// A 401 that also carried a renewal header would otherwise be stored first
		// and cleared immediately after by readFetchError.
		absorbRenewedToken(withRenewalHeader(tokenWithExp(NOW + 7 * 24 * 3600, "renewed"), 401));
		expect(getToken()).toBe(current);
		absorbRenewedToken(withRenewalHeader(tokenWithExp(NOW + 7 * 24 * 3600, "renewed"), 500));
		expect(getToken()).toBe(current);
	});

	test("ignores a malformed renewal header", () => {
		installMapLocalStorage();
		const current = tokenWithExp(NOW + 3600, "current");
		setToken(current);
		for (const bogus of ["", "not-a-jwt", "a.b", "a.b.c", "a.!!!.c"]) {
			absorbRenewedToken(withRenewalHeader(bogus));
			expect(getToken()).toBe(current);
		}
	});

	test("accepts a renewal when the stored token has no readable exp", () => {
		installMapLocalStorage();
		// Opaque or legacy stored values cannot be ordered, so a well-formed
		// renewal is preferred over keeping something unreadable.
		setToken("legacy-opaque-token");
		const renewed = tokenWithExp(NOW + 7 * 24 * 3600, "renewed");
		absorbRenewedToken(withRenewalHeader(renewed));
		expect(getToken()).toBe(renewed);
	});
});

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

	test("attaches the stored token and absorbs the renewal", async () => {
		installMapLocalStorage();
		const sent = tokenWithExp(NOW + 3600, "sent");
		const renewed = tokenWithExp(NOW + 7 * 24 * 3600, "renewed");
		setToken(sent);
		const calls = stubFetch(
			() => new Response(null, { status: 200, headers: { [SESSION_RENEWAL_HEADER]: renewed } }),
		);

		await authorizedFetch("/api/anything");

		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${sent}`);
		expect(getToken()).toBe(renewed);
	});

	test("does not absorb a renewal that arrived on a 401", async () => {
		installMapLocalStorage();
		const sent = tokenWithExp(NOW + 3600, "sent");
		setToken(sent);
		stubFetch(
			() =>
				new Response(JSON.stringify({ code: "UNAUTHORIZED" }), {
					status: 401,
					headers: {
						"content-type": "application/json",
						[SESSION_RENEWAL_HEADER]: tokenWithExp(NOW + 7 * 24 * 3600, "renewed"),
					},
				}),
		);

		const response = await authorizedFetch("/api/anything");
		expect(getToken()).toBe(sent);
		// readFetchError is what decides the session verdict; it must not find a
		// token that this response itself invalidated.
		await readFetchError(response);
		expect(getToken()).toBeNull();
	});

	test("keeps a caller-provided Authorization header and other init fields", async () => {
		installMapLocalStorage();
		setToken(tokenWithExp(NOW + 3600, "stored"));
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
