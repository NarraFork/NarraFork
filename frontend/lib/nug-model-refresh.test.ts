import { beforeEach, describe, expect, test } from "bun:test";
import { ApiError, api } from "./api";
import {
	requestNugModelRefreshOnPickerOpen,
	resetNugModelRefreshGuardForTests,
} from "./nug-model-refresh";

type RefreshResponse = Awaited<ReturnType<typeof api.nugRefreshStaleModels>>;

const realRefresh = api.nugRefreshStaleModels;

/** Install a stub for the single API call this module makes, tracking call count. */
function stubRefresh(impl: () => Promise<RefreshResponse>) {
	const calls = { count: 0 };
	api.nugRefreshStaleModels = (() => {
		calls.count++;
		return impl();
	}) as typeof api.nugRefreshStaleModels;
	return calls;
}

function response(overrides: Partial<RefreshResponse> = {}): RefreshResponse {
	return {
		results: [{ providerId: "prov-1", attempted: true, retryAfterMs: 60_000, modelCount: 3 }],
		refreshed: true,
		cooldownMs: 60_000,
		...overrides,
	};
}

beforeEach(() => {
	api.nugRefreshStaleModels = realRefresh;
	resetNugModelRefreshGuardForTests();
});

describe("requestNugModelRefreshOnPickerOpen", () => {
	test("issues the request and reports whether a refresh happened", async () => {
		const calls = stubRefresh(async () => response());
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(true);
		expect(calls.count).toBe(1);
	});

	test("reports false when the server refreshed nothing (server cooldown)", async () => {
		const calls = stubRefresh(async () =>
			response({
				results: [
					{ providerId: "prov-1", attempted: false, skipped: "cooldown", retryAfterMs: 42_000 },
				],
				refreshed: false,
			}),
		);
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(false);
		expect(calls.count).toBe(1);
	});

	test("does not issue a second request inside the cooldown window", async () => {
		const calls = stubRefresh(async () => response());
		await requestNugModelRefreshOnPickerOpen();
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(false);
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(false);
		expect(calls.count).toBe(1);
	});

	test("reopens as soon as the soonest provider leaves the server cooldown", async () => {
		const calls = stubRefresh(async () =>
			response({
				results: [
					// One gateway is far from refreshable, another is already free. The
					// guard must follow the free one instead of the slowest.
					{ providerId: "slow", attempted: false, skipped: "cooldown", retryAfterMs: 59_000 },
					{ providerId: "ready", attempted: true, retryAfterMs: 0, modelCount: 2 },
				],
				refreshed: true,
			}),
		);
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(true);
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(true);
		expect(calls.count).toBe(2);
	});

	test("backs off a full window when no provider is refreshable", async () => {
		const calls = stubRefresh(async () =>
			response({
				results: [
					{ providerId: "prov-1", attempted: false, skipped: "not-configured", retryAfterMs: 0 },
				],
				refreshed: false,
			}),
		);
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(false);
		// A `not-configured` zero must not be read as "refreshable right now".
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(false);
		expect(calls.count).toBe(1);
	});

	test("concurrent picker opens share a single request", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls = stubRefresh(async () => {
			await gate;
			return response();
		});
		const first = requestNugModelRefreshOnPickerOpen();
		const second = requestNugModelRefreshOnPickerOpen();
		release?.();
		expect(await Promise.all([first, second])).toEqual([true, true]);
		expect(calls.count).toBe(1);
	});

	test("swallows request failures and still backs off", async () => {
		const calls = stubRefresh(async () => {
			throw new Error("network down");
		});
		// Must not reject: an implicit refresh failing is not a user-facing error.
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(false);
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(false);
		expect(calls.count).toBe(1);
	});

	test("stops asking for the session when the backend lacks the route", async () => {
		const calls = stubRefresh(async () => {
			throw new ApiError("Not Found", 404);
		});
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(false);
		expect(calls.count).toBe(1);

		// Even after the local cooldown would have expired, an unsupported backend
		// is never probed again.
		resetNugModelRefreshGuardForTests();
		const afterReset = stubRefresh(async () => response());
		// The reset helper clears `unsupported` too, so this documents that the flag
		// is what suppressed the retry rather than the cooldown.
		expect(await requestNugModelRefreshOnPickerOpen()).toBe(true);
		expect(afterReset.count).toBe(1);
	});
});
