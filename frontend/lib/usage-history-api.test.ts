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

	test("sends explicit cursor pagination and filters", async () => {
		const store = new Map<string, string>([["narrafork_token", "token-1"]]);
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => store.set(key, value),
				removeItem: (key: string) => store.delete(key),
			},
			configurable: true,
		});

		let requestedUrl = "";
		let requestedSignal: AbortSignal | null | undefined;
		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL, init?: RequestInit) => {
				requestedUrl = String(input);
				requestedSignal = init?.signal;
				return new Response(
					JSON.stringify({ records: [], hasMore: false, nextCursor: null, limit: 50 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
			configurable: true,
		});

		const controller = new AbortController();
		await usageHistoryApi.listCursor(
			{ provider: "openai", kind: "narrator", startDate: "2026-07-01T00:00:00.000Z" },
			{ cursor: "cursor-1", limit: 50, signal: controller.signal },
		);

		const params = new URL(requestedUrl, "http://localhost").searchParams;
		expect(params.get("pagination")).toBe("cursor");
		expect(params.get("cursor")).toBe("cursor-1");
		expect(params.get("limit")).toBe("50");
		expect(params.get("provider")).toBe("openai");
		expect(params.get("kind")).toBe("narrator");
		expect(params.get("startDate")).toBe("2026-07-01T00:00:00.000Z");
		expect(requestedSignal).toBe(controller.signal);
	});
});
