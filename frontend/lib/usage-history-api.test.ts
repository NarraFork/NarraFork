import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "./api/client";
import { usageHistoryApi } from "./usage-history-api";

describe("usageHistoryApi", () => {
	const g = globalThis as typeof globalThis & {
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const originalFetch = g.fetch;
	const originalLocalStorage = g.localStorage;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalLocalStorage === undefined) {
			Reflect.deleteProperty(g, "localStorage");
		} else {
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
		}
	});

	test("surfaces structured usage history errors", async () => {
		const store = new Map<string, string>([["narrafork_token", "token-1"]]);
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
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					JSON.stringify({
						code: "USAGE_HISTORY_RECORD_NOT_FOUND",
						reason: "Usage history record not found",
					}),
					{
						status: 404,
						statusText: "Not Found",
						headers: { "content-type": "application/json" },
					},
				),
			configurable: true,
		});

		try {
			await usageHistoryApi.getRecord("missing-record");
			throw new Error("expected usage history request to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(404);
			expect((err as Error).message).toBe("Usage history record not found");
			expect((err as ApiError).data?.code).toBe("USAGE_HISTORY_RECORD_NOT_FOUND");
		}
	});
});
