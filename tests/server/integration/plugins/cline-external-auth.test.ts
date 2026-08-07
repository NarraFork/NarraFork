import { describe, expect, test } from "bun:test";
import {
	AuthInputError,
	accountBaseFrom,
	buildClineAccountHeaders,
	buildOpenRouterHeaders,
	type ClineCredentials,
	DEFAULT_CHAT_BASE_URL,
	isAddressInUse,
	isTokenExpired,
	parseCallbackUrl,
	withWorkosPrefix,
} from "../../../../examples/plugins/cline-external/src/auth";
import { parseCredentials } from "../../../../examples/plugins/cline-external/src/credentials";

/**
 * OAuth plumbing: callback parsing, expiry, and the two-base-URL distinction.
 *
 * Network-touching functions (`refreshAccessToken`, `startBrowserAuth`) are exercised through
 * their pure parts here. The refresh retry/rotation semantics are covered in
 * `cline-external-credentials.test.ts`, where a stubbed transport can drive them without
 * binding a port or reaching upstream.
 */

/** Build a callback URL the way Cline does: base64 JSON in the `code` parameter. */
function callbackUrl(payload: Record<string, unknown>, trailer = ""): string {
	const encoded = Buffer.from(JSON.stringify(payload) + trailer, "utf-8").toString("base64");
	return `http://localhost:19876/auth/callback?code=${encodeURIComponent(encoded)}`;
}

describe("cline-external auth: callback URL parsing", () => {
	test("a well-formed callback yields credentials", () => {
		const expiresAt = new Date("2030-01-01T00:00:00Z");
		const credentials = parseCallbackUrl(
			callbackUrl({
				accessToken: "at-1",
				refreshToken: "rt-1",
				email: "user@example.com",
				name: "Test User",
				expiresAt: expiresAt.toISOString(),
			}),
		);
		expect(credentials.accessToken).toBe("at-1");
		expect(credentials.refreshToken).toBe("rt-1");
		expect(credentials.email).toBe("user@example.com");
		expect(credentials.displayName).toBe("Test User");
		expect(credentials.expiresAt).toBe(expiresAt.getTime() / 1000);
	});

	test("a trailing signature after the JSON is tolerated", () => {
		// Upstream appends signature bytes after the payload, so the JSON has to be located by
		// its last closing brace rather than assumed to fill the buffer. This is the single most
		// fragile part of the format and the reason the decoding is copied verbatim.
		const credentials = parseCallbackUrl(
			callbackUrl({ accessToken: "at", refreshToken: "rt" }, "\u0000\u0001signature-bytes"),
		);
		expect(credentials.accessToken).toBe("at");
	});

	test("a display name is assembled from first and last when no name is given", () => {
		const credentials = parseCallbackUrl(
			callbackUrl({ accessToken: "a", refreshToken: "r", firstName: "Ada", lastName: "Lovelace" }),
		);
		expect(credentials.displayName).toBe("Ada Lovelace");
	});

	test("a missing expiry falls back to one hour rather than to zero", () => {
		// Zero would read as "expired in 1970" and force a refresh on the very first call, which
		// with a fresh token is a wasted round-trip and a needless rotation.
		const before = Date.now() / 1000;
		const credentials = parseCallbackUrl(callbackUrl({ accessToken: "a", refreshToken: "r" }));
		expect(credentials.expiresAt).toBeGreaterThan(before + 3000);
	});

	test("an unparseable expiry also falls back rather than producing NaN", () => {
		// `new Date("nonsense").getTime()` is NaN; storing that would make every comparison false
		// and the token would look permanently valid.
		const credentials = parseCallbackUrl(
			callbackUrl({ accessToken: "a", refreshToken: "r", expiresAt: "not-a-date" }),
		);
		expect(Number.isFinite(credentials.expiresAt)).toBe(true);
		expect(credentials.expiresAt).toBeGreaterThan(Date.now() / 1000);
	});

	test("each failure names its own cause", () => {
		// A user pasting the wrong thing needs to know which part was wrong; one generic message
		// would leave them guessing between the URL, the code and the payload.
		const cases: Array<[string, string]> = [
			["not a url", "does not look like a URL"],
			["http://localhost:19876/auth/callback", "No 'code' parameter"],
			[
				`http://localhost:19876/auth/callback?code=${encodeURIComponent(Buffer.from("no braces here").toString("base64"))}`,
				"No JSON payload",
			],
			[
				`http://localhost:19876/auth/callback?code=${encodeURIComponent(Buffer.from("{oops}").toString("base64"))}`,
				"not valid JSON",
			],
		];
		for (const [input, fragment] of cases) {
			expect(() => parseCallbackUrl(input), input).toThrow(fragment);
		}
	});

	test("a payload missing either token is rejected", () => {
		expect(() => parseCallbackUrl(callbackUrl({ refreshToken: "r" }))).toThrow("accessToken");
		expect(() => parseCallbackUrl(callbackUrl({ accessToken: "a" }))).toThrow("refreshToken");
	});

	test("failures are AuthInputError so the command layer can map them to INVALID_PARAMS", () => {
		// The RPC layer distinguishes a caller mistake from an internal fault by this class.
		try {
			parseCallbackUrl("garbage");
			throw new Error("expected a throw");
		} catch (error) {
			expect(error).toBeInstanceOf(AuthInputError);
		}
	});
});

describe("cline-external auth: token expiry", () => {
	function credentials(expiresAtSeconds: number): ClineCredentials {
		return {
			accessToken: "a",
			refreshToken: "r",
			expiresAt: expiresAtSeconds,
			email: "",
			displayName: "",
			startedAt: 0,
		};
	}

	test("a token expiring inside the buffer counts as expired", () => {
		// Refreshing slightly early avoids sending a token that expires mid-request.
		const now = 1_000_000_000_000;
		const inFourMinutes = now / 1000 + 4 * 60;
		expect(isTokenExpired(credentials(inFourMinutes), now)).toBe(true);
	});

	test("a token comfortably in the future is not expired", () => {
		const now = 1_000_000_000_000;
		expect(isTokenExpired(credentials(now / 1000 + 3600), now)).toBe(false);
	});

	test("a zero expiry is expired", () => {
		// This is what `parseCredentials` stores when the field is missing, so it must refresh
		// rather than be treated as valid forever.
		expect(isTokenExpired(credentials(0), 1_000_000_000_000)).toBe(true);
	});
});

describe("cline-external auth: base URLs", () => {
	test("the account base is derived by stripping one /api/v1", () => {
		// The two bases are not interchangeable: chat lives under /api/v1 while the account
		// endpoints add their own. Passing one where the other belongs produces
		// /api/v1/api/v1/... and a 404 that reads like an auth failure.
		expect(accountBaseFrom("https://api.cline.bot/api/v1")).toBe("https://api.cline.bot");
		expect(accountBaseFrom(DEFAULT_CHAT_BASE_URL)).toBe("https://api.cline.bot");
	});

	test("a trailing slash does not defeat the derivation", () => {
		expect(accountBaseFrom("https://api.cline.bot/api/v1/")).toBe("https://api.cline.bot");
	});

	test("an absent base falls back to the default", () => {
		expect(accountBaseFrom(undefined)).toBe("https://api.cline.bot");
		expect(accountBaseFrom("   ")).toBe("https://api.cline.bot");
	});

	test("a custom base without the suffix is left alone", () => {
		// We cannot know the shape of a user's gateway, so rewriting it would be guessing.
		expect(accountBaseFrom("https://gateway.internal")).toBe("https://gateway.internal");
	});
});

describe("cline-external auth: headers", () => {
	test("the bearer prefix is added once and only once", () => {
		expect(withWorkosPrefix("abc")).toBe("workos:abc");
		expect(withWorkosPrefix("workos:abc")).toBe("workos:abc");
	});

	test("account headers carry the prefixed bearer token", () => {
		const headers = buildClineAccountHeaders("abc");
		expect(headers.Authorization).toBe("Bearer workos:abc");
	});

	test("account headers omit Authorization when there is no token", () => {
		// The authorize and refresh endpoints are called unauthenticated; sending an empty bearer
		// would be rejected.
		expect("Authorization" in buildClineAccountHeaders()).toBe(false);
	});

	test("gateway headers identify the client the way the extension does", () => {
		const headers = buildOpenRouterHeaders();
		expect(headers["HTTP-Referer"]).toBe("https://cline.bot");
		expect(headers["X-Title"]).toBe("Cline");
		expect(headers["User-Agent"]).toStartWith("Cline/");
		expect(headers["X-CLIENT-TYPE"]).toBe("extension");
	});
});

describe("cline-external auth: bind failure classification", () => {
	test("EADDRINUSE is recognised from a code or a message", () => {
		// This is what separates "the built-in provider is signing in" (retry) from "this
		// environment cannot bind at all" (use the paste path). Bun surfaces it either way
		// depending on the platform.
		expect(isAddressInUse(Object.assign(new Error("x"), { code: "EADDRINUSE" }))).toBe(true);
		expect(isAddressInUse(new Error("listen EADDRINUSE: address already in use"))).toBe(true);
		expect(isAddressInUse(new Error("address already in use"))).toBe(true);
	});

	test("any other failure is not treated as a busy port", () => {
		expect(isAddressInUse(new Error("EACCES: permission denied"))).toBe(false);
		expect(isAddressInUse(undefined)).toBe(false);
		expect(isAddressInUse("EADDRINUSE")).toBe(false);
	});
});

describe("cline-external auth: stored credential round trip", () => {
	test("a parsed callback survives storage and re-reading unchanged", () => {
		const original = parseCallbackUrl(
			callbackUrl({
				accessToken: "at",
				refreshToken: "rt",
				email: "a@b.c",
				name: "N",
				expiresAt: "2030-01-01T00:00:00Z",
			}),
		);
		const restored = parseCredentials(JSON.stringify(original));
		expect(restored).toEqual(original);
	});
});
