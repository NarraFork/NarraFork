import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { businessTransport } from "../business-transport";
import {
	authorizedFetch,
	clearToken,
	clearTokenOnSessionFailure,
	confirmAuthUser,
	endSession,
	getAuthSnapshot,
	getErrorMessage,
	getToken,
	postFormDataWithProgress,
	readFetchError,
	readFetchErrorMessage,
	request,
	setToken,
	subscribeAuth,
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

describe("getToken without usable browser storage", () => {
	test("a missing localStorage is an absent session, not a rendering exception", () => {
		Reflect.deleteProperty(g, "localStorage");
		expect(getToken()).toBeNull();
	});
	test("a blocked storage getter does not throw while rendering a preference consumer", () => {
		Object.defineProperty(g, "localStorage", {
			configurable: true,
			get() {
				throw new DOMException("Storage blocked", "SecurityError");
			},
		});
		expect(getToken()).toBeNull();
	});
	test("a failing getItem cannot produce an authenticated token", () => {
		Object.defineProperty(g, "localStorage", {
			configurable: true,
			value: {
				getItem() {
					throw new Error("Storage unavailable");
				},
			},
		});
		expect(getToken()).toBeNull();
	});
});

test("auth snapshots are stable, credential-free and never reuse a generation", () => {
	installMapLocalStorage();
	const initial = getAuthSnapshot();
	const snapshots: ReturnType<typeof getAuthSnapshot>[] = [];
	const unsubscribe = subscribeAuth(() => snapshots.push(getAuthSnapshot()));
	try {
		const a = setToken(opaqueToken("first-a"));
		const unconfirmed = getAuthSnapshot();
		expect(unconfirmed).toEqual({ generation: a, hasToken: true, userId: null });
		expect(a).toBeGreaterThan(initial.generation);
		expect(getAuthSnapshot()).toBe(unconfirmed);

		confirmAuthUser(a, "account-a");
		const confirmed = getAuthSnapshot();
		expect(confirmed).toEqual({ generation: a, hasToken: true, userId: "account-a" });
		expect(setToken(opaqueToken("first-a"))).toBe(a);
		confirmAuthUser(a, "account-a");
		expect(getAuthSnapshot()).toBe(confirmed);
		expect(snapshots).toEqual([unconfirmed, confirmed]);

		const sameAccount = setToken(opaqueToken("renewed-a"));
		expect(sameAccount).toBeGreaterThan(a);
		expect(getAuthSnapshot().userId).toBeNull();
		confirmAuthUser(a, "account-a");
		expect(getAuthSnapshot().userId).toBeNull();
		confirmAuthUser(sameAccount, "account-a");

		const b = setToken(opaqueToken("account-b"));
		confirmAuthUser(b, "account-b");
		const backToA = setToken(opaqueToken("first-a"));
		expect(backToA).toBeGreaterThan(b);
		confirmAuthUser(a, "account-a");
		confirmAuthUser(b, "account-b");
		expect(getAuthSnapshot()).toEqual({ generation: backToA, hasToken: true, userId: null });
		confirmAuthUser(backToA, "account-a");
		clearToken();
		const signedOut = getAuthSnapshot();
		confirmAuthUser(signedOut.generation, "account-a");
		expect(signedOut.generation).toBeGreaterThan(backToA);
		expect(getAuthSnapshot()).toEqual({
			generation: signedOut.generation,
			hasToken: false,
			userId: null,
		});
	} finally {
		unsubscribe();
	}
});

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
		expect(await readFetchErrorMessage(response, undefined, getAuthSnapshot().generation)).toBe(
			"Authentication required",
		);
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
		expect(await readFetchErrorMessage(response, undefined, getAuthSnapshot().generation)).toBe(
			"Invalid verification code",
		);
		expect(getToken()).toBe("live-session");
	});

	test("keeps the token when an OAuth-only endpoint rejects a session token", async () => {
		installMapLocalStorage();
		setToken("live-session");
		const response = json401({ code: "OAUTH_REQUIRED", error: "OAuth access token required" });
		await readFetchError(response, undefined, getAuthSnapshot().generation);
		expect(getToken()).toBe("live-session");
	});

	test("still clears the token when the session itself expired", async () => {
		installMapLocalStorage();
		setToken("expired-session");
		const response = json401({ code: "TOKEN_EXPIRED", error: "Token expired" });
		await readFetchError(response, undefined, getAuthSnapshot().generation);
		expect(getToken()).toBeNull();
	});

	test("clears the token for a codeless 401 (proxy or legacy route)", async () => {
		installMapLocalStorage();
		setToken("live-session");
		const response = new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
		await readFetchError(response, undefined, getAuthSnapshot().generation);
		expect(getToken()).toBeNull();
	});

	test("clearTokenOnSessionFailure distinguishes session loss from other 401s", async () => {
		installMapLocalStorage();
		setToken("live-session");
		const { generation } = getAuthSnapshot();
		await clearTokenOnSessionFailure(json401({ code: "PASSKEY_AUTH_FAILED" }), generation);
		expect(getToken()).toBe("live-session");

		await clearTokenOnSessionFailure(json401({ code: "TOKEN_EXPIRED" }), generation);
		expect(getToken()).toBeNull();
	});

	test("clearTokenOnSessionFailure ignores non-401 responses", async () => {
		installMapLocalStorage();
		setToken("live-session");
		await clearTokenOnSessionFailure(
			new Response("nope", { status: 403 }),
			getAuthSnapshot().generation,
		);
		expect(getToken()).toBe("live-session");
	});

	test("an untracked 401 can be read but cannot clear a session", async () => {
		installMapLocalStorage();
		setToken("new-session");
		await clearTokenOnSessionFailure(json401({ code: "TOKEN_EXPIRED" }));
		const error = await readFetchError(json401({ code: "TOKEN_EXPIRED" }));
		expect(error.data.code).toBe("TOKEN_EXPIRED");
		expect(getAuthSnapshot().hasToken).toBe(true);
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
		respond: (input: string | URL, init?: RequestInit) => Response | Promise<Response>,
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

	test("late JSON and binary 401s cannot clear the returning account", async () => {
		installMapLocalStorage();
		const tokenA = opaqueToken("returning-a");
		setToken(tokenA);
		const releases: Array<() => void> = [];
		stubFetch(
			() =>
				new Promise((resolve) => {
					releases.push(() => resolve(json401({ code: "TOKEN_EXPIRED" })));
				}),
		);
		const json = request("/anything");
		const binary = authorizedFetch("/api/anything");
		setToken(opaqueToken("other-b"));
		const generation = setToken(tokenA);
		confirmAuthUser(generation, "account-a");
		for (const release of releases) release();
		await expect(json).rejects.toMatchObject({ status: 401 });
		await clearTokenOnSessionFailure(await binary);
		expect(getAuthSnapshot()).toEqual({ generation, hasToken: true, userId: "account-a" });
	});

	test("a binary 401 only clears the current stored credential and remains caller-handled", async () => {
		installMapLocalStorage();
		const generation = setToken(opaqueToken("active"));
		confirmAuthUser(generation, "account-a");
		stubFetch(() => json401({ code: "TOKEN_EXPIRED" }));
		const unrelated = await authorizedFetch("/api/anything", {
			headers: { Authorization: "Bearer another-credential" },
		});
		await readFetchError(unrelated);
		const response = await authorizedFetch("/api/anything");
		await clearTokenOnSessionFailure(response.clone());
		expect(getAuthSnapshot().generation).toBe(generation);
		expect(getAuthSnapshot().hasToken).toBe(true);
		await clearTokenOnSessionFailure(response);
		expect(getAuthSnapshot().hasToken).toBe(false);
		expect(getAuthSnapshot().userId).toBeNull();
	});

	test("a credential change during 401 body parsing prevents clearing the new session", async () => {
		installMapLocalStorage();
		setToken(opaqueToken("original"));
		let writeBody!: () => void;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				writeBody = () => {
					controller.enqueue(new TextEncoder().encode('{"code":"TOKEN_EXPIRED"}'));
					controller.close();
				};
			},
		});
		stubFetch(
			() => new Response(body, { status: 401, headers: { "Content-Type": "application/json" } }),
		);
		const handling = readFetchError(await authorizedFetch("/api/anything"));
		const generation = setToken(opaqueToken("replacement"));
		writeBody();
		expect((await handling).data.code).toBe("TOKEN_EXPIRED");
		expect(getAuthSnapshot()).toEqual({ generation, hasToken: true, userId: null });
	});

	test("sends no Authorization header when there is no session", async () => {
		installMapLocalStorage();
		const calls = stubFetch(() => new Response(null, { status: 200 }));
		await authorizedFetch("/api/anything");
		expect(new Headers(calls[0].init?.headers).get("Authorization")).toBeNull();
	});
});

test("upload responses can only clear the generation that supplied their Authorization", async () => {
	installMapLocalStorage();
	const token = opaqueToken("upload");
	setToken(token);
	let finish!: (response: Response) => void;
	const upload = spyOn(businessTransport, "upload").mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	try {
		const opts = { headers: { Authorization: `Bearer ${token}` } };
		const pending = postFormDataWithProgress("/api/upload", new FormData(), opts);
		setToken(opaqueToken("replacement"));
		const generation = setToken(token);
		finish(json401({ code: "TOKEN_EXPIRED" }));
		await readFetchError(await pending);
		expect(getAuthSnapshot()).toEqual({ generation, hasToken: true, userId: null });

		const current = postFormDataWithProgress("/api/upload", new FormData(), opts);
		finish(json401({ code: "TOKEN_EXPIRED" }));
		await readFetchError(await current);
		expect(getAuthSnapshot().hasToken).toBe(false);
	} finally {
		upload.mockRestore();
	}
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

	for (const outcome of ["success", "failure"] as const) {
		test(`a delayed ${outcome} logout cannot clear a newer session`, async () => {
			installMapLocalStorage();
			let complete!: () => void;
			const response = new Promise<Response>((resolve, reject) => {
				complete = () => {
					if (outcome === "success") resolve(new Response(null, { status: 200 }));
					else reject(new TypeError("Connection closed"));
				};
			});
			globalThis.fetch = (async () => response) as unknown as typeof fetch;
			setToken(opaqueToken("old"));
			const pending = endSession();
			expect(getToken()).toBeNull();
			const replacement = opaqueToken("new");
			setToken(replacement);
			complete();
			await pending;
			expect(getToken()).toBe(replacement);
		});
	}
	test("a completed revocation cannot clear a new generation with the same credential", async () => {
		installMapLocalStorage();
		let complete!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => {
			complete = resolve;
		});
		globalThis.fetch = (() => response) as unknown as typeof fetch;
		const token = opaqueToken("returned");
		const before = setToken(token);
		const pending = endSession();
		const after = setToken(token);
		complete(new Response(null));
		await pending;
		expect(after).toBeGreaterThan(before);
		expect(getAuthSnapshot()).toEqual({ generation: after, hasToken: true, userId: null });
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
