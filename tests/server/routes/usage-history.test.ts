import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	createUsageHistoryRoutes,
	type UsageHistoryRouteService,
} from "@server/routes/usage-history";
import { Hono } from "hono";

const listUsageHistoryCursor = mock(async () => ({
	records: [],
	hasMore: false,
	nextCursor: null as string | null,
	limit: 2,
}));
const listUsageHistory = mock(async () => ({ records: [], total: 0 }));

const unexpectedServiceCall = async (): Promise<never> => {
	throw new Error("Unexpected usage history service call");
};

const service: UsageHistoryRouteService = {
	listUsageHistoryCursor,
	listUsageHistory,
	listProviders: unexpectedServiceCall,
	getUsageStats: unexpectedServiceCall,
	getUsageTimeSeries: unexpectedServiceCall,
	getUsageRecord: unexpectedServiceCall,
	getUsageBreakdown: unexpectedServiceCall,
	getUsageTimeSeriesStacked: unexpectedServiceCall,
};

const usageHistoryRoutes = createUsageHistoryRoutes({
	requireAuth: async (_c, next) => {
		await next();
	},
	requireAdmin: async (_c, next) => {
		await next();
	},
	service,
});
const app = new Hono();
app.onError((error, c) => {
	const typed = error as Error & { code?: string; statusCode?: number };
	const status = typed.statusCode === 400 ? 400 : 500;
	return c.json({ code: typed.code ?? "INTERNAL_ERROR", message: typed.message }, status);
});
app.route("/", usageHistoryRoutes);

beforeEach(() => {
	listUsageHistoryCursor.mockClear();
	listUsageHistory.mockClear();
});

function encodeRawCursor(createdAt: string): string {
	return Buffer.from(JSON.stringify({ v: 1, createdAt, id: "request-1" })).toString("base64url");
}

describe("usage history pagination route", () => {
	test("rejects malformed cursor before calling the service", async () => {
		const response = await app.request("/?pagination=cursor&cursor=bad&limit=2");
		expect(response.status).toBe(400);
		expect(listUsageHistoryCursor).not.toHaveBeenCalled();
	});

	test("rejects non-canonical cursor dates before calling the service", async () => {
		for (const createdAt of [
			"0",
			"July 17, 2026",
			"2026-7-17T00:00:00.000Z",
			"2026-07-17T00:00:00.000+00:00",
		]) {
			const cursor = encodeURIComponent(encodeRawCursor(createdAt));
			const response = await app.request(`/?pagination=cursor&cursor=${cursor}&limit=2`);
			expect(response.status).toBe(400);
		}
		expect(listUsageHistoryCursor).not.toHaveBeenCalled();
	});

	test("rejects mixed cursor and page parameters", async () => {
		const response = await app.request("/?pagination=cursor&page=2&limit=2");
		expect(response.status).toBe(400);
	});

	test("routes valid cursor requests without counting", async () => {
		listUsageHistoryCursor.mockResolvedValueOnce({
			records: [],
			hasMore: true,
			nextCursor: "next-cursor",
			limit: 2,
		});
		const response = await app.request("/?pagination=cursor&limit=2");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			records: [],
			hasMore: true,
			nextCursor: "next-cursor",
			limit: 2,
		});
		expect(listUsageHistoryCursor).toHaveBeenCalledWith({}, 2, undefined);
	});

	test("keeps the legacy page response shape", async () => {
		listUsageHistory.mockResolvedValueOnce({ records: [], total: 3 });
		const response = await app.request("/?page=1&pageSize=2");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			records: [],
			total: 3,
			page: 1,
			pageSize: 2,
			totalPages: 2,
		});
	});
});
