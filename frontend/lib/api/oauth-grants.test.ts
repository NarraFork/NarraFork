import { afterEach, describe, expect, test } from "bun:test";
import { oauthGrantsApi, RevokeAllOAuthGrantsError } from "./oauth-grants";

const g = globalThis as typeof globalThis & { localStorage?: Storage; fetch: typeof fetch };
const originalFetch = g.fetch;
const originalLocalStorage = g.localStorage;

type RevokeBatch = { revokedCount: number; hasMore: boolean };
type FetchStep = RevokeBatch | ((init?: RequestInit) => Response | Promise<Response>);

afterEach(() => {
	Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
	if (originalLocalStorage === undefined) Reflect.deleteProperty(g, "localStorage");
	else
		Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
});

function installEnvironment(steps: FetchStep[]): string[] {
	const calls: string[] = [];
	Object.defineProperty(g, "localStorage", {
		value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
		configurable: true,
	});
	Object.defineProperty(g, "fetch", {
		value: async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(`${String(input)}:${String(init?.method)}`);
			const step = steps.shift();
			if (!step) throw new Error("unexpected revoke-all request");
			return typeof step === "function" ? step(init) : Response.json(step);
		},
		configurable: true,
	});
	return calls;
}

async function getRevokeAllError(promise: Promise<unknown>): Promise<RevokeAllOAuthGrantsError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(RevokeAllOAuthGrantsError);
	return caught as RevokeAllOAuthGrantsError;
}

describe("OAuth grants API", () => {
	test("revoke-all drains every bounded server batch", async () => {
		const calls = installEnvironment([
			{ revokedCount: 100, hasMore: true },
			{ revokedCount: 100, hasMore: true },
			{ revokedCount: 7, hasMore: false },
		]);

		expect(await oauthGrantsApi.revokeAllOAuthGrants()).toEqual({
			revokedCount: 207,
			hasMore: false,
		});
		expect(calls).toEqual([
			"/api/oauth/grants/revoke-all:POST",
			"/api/oauth/grants/revoke-all:POST",
			"/api/oauth/grants/revoke-all:POST",
		]);
	});

	test("revoke-all preserves progress when cancelled after the first batch", async () => {
		const controller = new AbortController();
		const calls = installEnvironment([
			(init) => {
				expect(init?.signal).toBe(controller.signal);
				return Response.json({ revokedCount: 100, hasMore: true });
			},
			(init) => {
				expect(init?.signal).toBe(controller.signal);
				controller.abort();
				throw controller.signal.reason;
			},
		]);

		const error = await getRevokeAllError(oauthGrantsApi.revokeAllOAuthGrants(controller.signal));
		expect(error).toMatchObject({ revokedCount: 100, batchCount: 1, hasMore: true });
		expect(error.cause).toBe(controller.signal.reason);
		expect(calls).toHaveLength(2);
	});

	test("revoke-all preserves progress when a later batch has a network failure", async () => {
		const networkError = new TypeError("network unavailable");
		const calls = installEnvironment([
			{ revokedCount: 100, hasMore: true },
			() => {
				throw networkError;
			},
		]);

		const error = await getRevokeAllError(oauthGrantsApi.revokeAllOAuthGrants());
		expect(error).toMatchObject({ revokedCount: 100, batchCount: 1, hasMore: true });
		expect(error.cause).toBe(networkError);
		expect(error.message).toMatch(/network unavailable/i);
		expect(calls).toHaveLength(2);
	});

	test("revoke-all preserves progress when a later batch reports no progress", async () => {
		const calls = installEnvironment([
			{ revokedCount: 100, hasMore: true },
			{ revokedCount: 0, hasMore: true },
		]);

		const error = await getRevokeAllError(oauthGrantsApi.revokeAllOAuthGrants());
		expect(error).toMatchObject({ revokedCount: 100, batchCount: 2, hasMore: true });
		expect(error.message).toMatch(/no progress/i);
		expect(calls).toHaveLength(2);
	});
});
