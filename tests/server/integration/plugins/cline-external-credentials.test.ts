import { describe, expect, test } from "bun:test";
import {
	type ClineCredentials,
	refreshAccessToken,
} from "../../../../examples/plugins/cline-external/src/auth";
import {
	credentialsFromConfig,
	InvalidCredentialsError,
	parseCredentials,
	parseEnabledModels,
	serializeCredentials,
} from "../../../../examples/plugins/cline-external/src/credentials";

/**
 * Credential parsing, refresh semantics, and the enabled-model list.
 *
 * `refreshAccessToken` is driven against a stubbed `fetch` rather than upstream: the retry and
 * rotation rules are the part that can lose an account, and they must be verifiable without a
 * live token or a quota.
 */

function credentials(overrides: Partial<ClineCredentials> = {}): ClineCredentials {
	return {
		accessToken: "at-old",
		refreshToken: "rt-old",
		expiresAt: 0,
		email: "user@example.com",
		displayName: "User",
		startedAt: 1_700_000_000_000,
		...overrides,
	};
}

/**
 * Replace global `fetch` for one call.
 *
 * `pfetch` calls the global directly when no proxy is set, so this is the seam. Restored in a
 * `finally` so a failing assertion cannot leak a stub into later tests.
 */
async function withFetch<T>(
	handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
	run: () => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
		Promise.resolve(handler(String(input), init))) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

function refreshResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("cline-external credentials: parsing", () => {
	test("a stored credential round trips", () => {
		const original = credentials({ userId: "u-1", expiresAt: 1_800_000_000 });
		expect(parseCredentials(serializeCredentials(original))).toEqual(original);
	});

	test("unknown fields are dropped rather than carried forward", () => {
		// The stored blob is written by this plugin, so an extra field means a format change or a
		// tampered vault. Re-serializing it would keep propagating something nothing reads.
		const parsed = parseCredentials(JSON.stringify({ ...credentials(), somethingElse: "ignored" }));
		expect(serializeCredentials(parsed)).not.toContain("somethingElse");
	});

	test("a malformed blob throws instead of reporting 'not signed in'", () => {
		// Degrading silently would send the user to sign in again over a read problem, and the
		// second sign-in would overwrite whatever was there.
		for (const blob of ["not json", "[]", '"a string"', "{}", '{"accessToken":"a"}']) {
			expect(() => parseCredentials(blob), blob).toThrow(InvalidCredentialsError);
		}
	});

	test("a missing expiry is stored as expired rather than as valid", () => {
		// A refresh that turns out to be unnecessary costs one request; assuming validity sends a
		// dead token upstream on every turn.
		const parsed = parseCredentials(
			JSON.stringify({ accessToken: "a", refreshToken: "r", startedAt: 1 }),
		);
		expect(parsed.expiresAt).toBe(0);
	});

	test("a blank token is treated as absent, not as an empty credential", () => {
		expect(() =>
			parseCredentials(JSON.stringify({ accessToken: "   ", refreshToken: "r" })),
		).toThrow(InvalidCredentialsError);
	});
});

describe("cline-external credentials: config injection", () => {
	test("a credential injected into config is read from there", () => {
		// The provider path gets it in `config` and must not spend an RPC round-trip re-reading
		// the vault.
		const config = { credentials: serializeCredentials(credentials()) };
		expect(credentialsFromConfig(config)?.accessToken).toBe("at-old");
	});

	test("an absent or empty field means 'not signed in'", () => {
		// The host omits an unset secret rather than sending an empty string, so absence is
		// reported by the caller rather than guessed at.
		expect(credentialsFromConfig({})).toBeUndefined();
		expect(credentialsFromConfig({ credentials: "" })).toBeUndefined();
		expect(credentialsFromConfig(undefined)).toBeUndefined();
	});

	test("a malformed injected credential still throws", () => {
		// Same reasoning as the vault path: an unreadable credential is reported, not ignored.
		expect(() => credentialsFromConfig({ credentials: "{" })).toThrow(InvalidCredentialsError);
	});
});

describe("cline-external credentials: refresh", () => {
	test("a successful refresh returns the new tokens without writing anything", () => {
		// Purity is the point: the caller decides whether to persist, which is what allows the
		// vault write to be deduplicated one level up.
		return withFetch(
			() =>
				refreshResponse({
					success: true,
					data: {
						accessToken: "at-new",
						refreshToken: "rt-new",
						expiresAt: "2030-01-01T00:00:00Z",
						userInfo: { email: "new@example.com", name: "New Name" },
					},
				}),
			async () => {
				const outcome = await refreshAccessToken(credentials(), "https://api.cline.bot");
				expect(outcome.status).toBe("refreshed");
				if (outcome.status !== "refreshed") return;
				expect(outcome.credentials.accessToken).toBe("at-new");
				expect(outcome.credentials.refreshToken).toBe("rt-new");
				expect(outcome.credentials.email).toBe("new@example.com");
			},
		);
	});

	test("a rotated refresh token is adopted, and an unrotated one is kept", () => {
		// Adoption is mandatory: upstream may retire the old value, and authenticating with a
		// revoked refresh token locks the account out until a manual sign-in.
		return withFetch(
			() =>
				refreshResponse({
					success: true,
					data: { accessToken: "at-new", expiresAt: "2030-01-01T00:00:00Z" },
				}),
			async () => {
				const outcome = await refreshAccessToken(credentials(), "https://api.cline.bot");
				if (outcome.status !== "refreshed") throw new Error("expected a refresh");
				expect(outcome.credentials.refreshToken).toBe("rt-old");
			},
		);
	});

	test("startedAt and userId survive a refresh", () => {
		// The balance endpoint needs `userId`; losing it on every refresh would make the settings
		// view re-fetch the user on every balance check.
		return withFetch(
			() =>
				refreshResponse({
					success: true,
					data: { accessToken: "at-new", expiresAt: "2030-01-01T00:00:00Z" },
				}),
			async () => {
				const original = credentials({ userId: "u-9" });
				const outcome = await refreshAccessToken(original, "https://api.cline.bot");
				if (outcome.status !== "refreshed") throw new Error("expected a refresh");
				expect(outcome.credentials.userId).toBe("u-9");
				expect(outcome.credentials.startedAt).toBe(original.startedAt);
			},
		);
	});

	test("a 401 is 'invalid' and is not retried", () => {
		// A rejected refresh token will never succeed. Retrying it wastes time, and the caller
		// needs to know to clear the credential rather than surface a transient-looking error.
		let attempts = 0;
		return withFetch(
			() => {
				attempts += 1;
				return refreshResponse({ error: "invalid_grant" }, 401);
			},
			async () => {
				const outcome = await refreshAccessToken(credentials(), "https://api.cline.bot");
				expect(outcome.status).toBe("invalid");
				expect(attempts).toBe(1);
			},
		);
	});

	test("a 400 is also invalid rather than transient", () => {
		return withFetch(
			() => refreshResponse({ error: "invalid_request" }, 400),
			async () => {
				expect((await refreshAccessToken(credentials(), "https://api.cline.bot")).status).toBe(
					"invalid",
				);
			},
		);
	});

	test("a 500 is retried and reported as 'failed', leaving the credential alone", () => {
		// The distinction matters: `failed` must not clear a working credential over a blip.
		let attempts = 0;
		return withFetch(
			() => {
				attempts += 1;
				return refreshResponse({ error: "server" }, 500);
			},
			async () => {
				const outcome = await refreshAccessToken(credentials(), "https://api.cline.bot");
				expect(outcome.status).toBe("failed");
				expect(attempts).toBe(3);
			},
		);
	});

	test("a transient failure followed by success returns the refreshed credential", () => {
		let attempts = 0;
		return withFetch(
			() => {
				attempts += 1;
				if (attempts === 1) return refreshResponse({ error: "server" }, 503);
				return refreshResponse({
					success: true,
					data: { accessToken: "at-new", expiresAt: "2030-01-01T00:00:00Z" },
				});
			},
			async () => {
				const outcome = await refreshAccessToken(credentials(), "https://api.cline.bot");
				expect(outcome.status).toBe("refreshed");
				expect(attempts).toBe(2);
			},
		);
	});

	test("a thrown network error is retried, not propagated", () => {
		let attempts = 0;
		return withFetch(
			() => {
				attempts += 1;
				throw new Error("socket hang up");
			},
			async () => {
				const outcome = await refreshAccessToken(credentials(), "https://api.cline.bot");
				expect(outcome.status).toBe("failed");
				expect(attempts).toBe(3);
			},
		);
	});

	test("a 200 with no access token is a failure, not a silent success", () => {
		// Returning the old credential here would have callers believe a refresh happened and
		// keep using an expired token.
		return withFetch(
			() => refreshResponse({ success: true, data: {} }),
			async () => {
				expect((await refreshAccessToken(credentials(), "https://api.cline.bot")).status).toBe(
					"failed",
				);
			},
		);
	});

	test("the refresh request targets the account base and sends the grant type", () => {
		let seenUrl = "";
		let seenBody: unknown;
		return withFetch(
			(url, init) => {
				seenUrl = url;
				seenBody = JSON.parse(String(init?.body));
				return refreshResponse({
					success: true,
					data: { accessToken: "a", expiresAt: "2030-01-01T00:00:00Z" },
				});
			},
			async () => {
				await refreshAccessToken(credentials(), "https://api.cline.bot");
				// Not /api/v1/api/v1/...: the account base already excludes the chat prefix.
				expect(seenUrl).toBe("https://api.cline.bot/api/v1/auth/refresh");
				expect(seenBody).toEqual({ refreshToken: "rt-old", grantType: "refresh_token" });
			},
		);
	});
});

describe("cline-external credentials: enabled models", () => {
	test("a stored JSON array is parsed", () => {
		expect(parseEnabledModels('["a/b","c/d"]')).toEqual(["a/b", "c/d"]);
	});

	test("duplicates and blanks are removed", () => {
		expect(parseEnabledModels('["a","a","  ","b"]')).toEqual(["a", "b"]);
	});

	test("an unset or malformed value degrades to an empty list", () => {
		// Unlike a credential, this is a preference the user can simply set again. Taking the
		// provider down over it would be disproportionate.
		for (const value of [undefined, "", "not json", '{"a":1}', "null", "42"]) {
			expect(parseEnabledModels(value), String(value)).toEqual([]);
		}
	});

	test("non-string entries are skipped rather than coerced", () => {
		// A number coerced to "1" would become a model id that can never resolve.
		expect(parseEnabledModels('["a",1,null,{"x":1},"b"]')).toEqual(["a", "b"]);
	});
});
