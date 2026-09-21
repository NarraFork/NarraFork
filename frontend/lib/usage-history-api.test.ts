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
			{
				userId: "user-1",
				provider: "openai",
				kind: "narrator",
				startDate: "2026-07-01T00:00:00.000Z",
			},
			{ cursor: "cursor-1", limit: 50, signal: controller.signal },
		);

		const params = new URL(requestedUrl, "http://localhost").searchParams;
		expect(params.get("pagination")).toBe("cursor");
		expect(params.get("cursor")).toBe("cursor-1");
		expect(params.get("limit")).toBe("50");
		expect(params.get("provider")).toBe("openai");
		expect(params.get("userId")).toBe("user-1");
		expect(params.get("kind")).toBe("narrator");
		expect(params.get("startDate")).toBe("2026-07-01T00:00:00.000Z");
		expect(requestedSignal).toBe(controller.signal);
	});

	test("passes unattributed user filters to lists, stats, and every chart", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => "token-1" },
			configurable: true,
		});
		const urls: URL[] = [];
		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL) => {
				urls.push(new URL(String(input), "http://localhost"));
				return Response.json({});
			},
			configurable: true,
		});
		const filters = { userId: "__unattributed__", provider: "openai" };
		await usageHistoryApi.list(filters);
		await usageHistoryApi.listCursor(filters);
		await usageHistoryApi.getStats(filters);
		await usageHistoryApi.getTimeSeries(filters);
		await usageHistoryApi.getBreakdown(filters, { dimension: "user", metric: "requests" });
		await usageHistoryApi.getTimeSeriesStacked(filters, { dimension: "user", metric: "cost" });
		expect(urls).toHaveLength(6);
		for (const url of urls) {
			expect(url.searchParams.get("userId")).toBe("__unattributed__");
			expect(url.searchParams.get("provider")).toBe("openai");
		}
		expect(urls[4].searchParams.get("dimension")).toBe("user");
		expect(urls[5].searchParams.get("dimension")).toBe("user");
	});

	test("fetches bounded durable totals with a user cursor and cancellation, without history filters", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => "token-1" },
			configurable: true,
		});
		const requests: { url: URL; signal: AbortSignal | null | undefined }[] = [];
		const response = { records: [], hasMore: false, nextCursor: null, limit: 50 };
		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({ url: new URL(String(input), "http://localhost"), signal: init?.signal });
				return Response.json(response);
			},
			configurable: true,
		});
		expect(await usageHistoryApi.getUserTotals()).toEqual(response);
		const controller = new AbortController();
		await usageHistoryApi.getUserTotals({
			cursor: "deleted-user+id",
			limit: 25,
			signal: controller.signal,
		});
		expect(requests[0].url.pathname).toBe("/api/usage-history/user-totals");
		expect([...requests[0].url.searchParams]).toEqual([["limit", "50"]]);
		expect([...requests[1].url.searchParams]).toEqual([
			["limit", "25"],
			["cursor", "deleted-user+id"],
		]);
		expect(requests[1].signal).toBe(controller.signal);
	});
});
