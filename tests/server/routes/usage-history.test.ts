import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildAppErrorResponse } from "@server/lib/app-error-response";
import {
	createUsageHistoryRoutes,
	type UsageHistoryRouteService,
} from "@server/routes/usage-history";
import type { AuthSessionStore } from "@server/services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "@server/services/auth/store";
import type { TokenRecalculationJob, TokenRecalculationRange } from "@shared/token-recalculation";
import { Hono } from "hono";

/**
 * The "real admin middleware" cases below use the default `requireAdmin`, which authorizes
 * against the LIVE role read through the session store, never the token's `role` claim. The
 * injected `requireAuth` only sets `c.get("user")`, so this seam makes the store report each
 * acting user's role (admin → allowed, user → 403). Without it the lookup would hit the real
 * (empty) database and 401 USER_GONE instead of 403.
 */
const ADMIN_ACTOR_IDS = new Set(["administrator"]);
const SEEN_ACTOR_IDS = [...ADMIN_ACTOR_IDS, "ordinary"];

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
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: ADMIN_ACTOR_IDS.has(id) ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	listUsageHistoryCursor.mockClear();
	listUsageHistory.mockClear();
});

afterEach(() => {
	setAuthStores(undefined);
});

function encodeRawCursor(createdAt: string): string {
	return Buffer.from(JSON.stringify({ v: 1, createdAt, id: "request-1" })).toString("base64url");
}

describe("usage history user filters and authorization", () => {
	test("lifetime user totals are bounded and cursor-paginated", async () => {
		const totals = mock(() => ({ records: [], hasMore: false, nextCursor: null, limit: 2 }));
		const routes = createUsageHistoryRoutes({
			requireAuth: async (_c, next) => {
				await next();
			},
			requireAdmin: async (_c, next) => {
				await next();
			},
			service,
			listUserUsageTotals: totals,
		});
		const response = await routes.request("/user-totals?limit=2&cursor=alice");
		expect(response.status).toBe(200);
		expect(totals).toHaveBeenCalledWith(2, "alice");
		expect(await response.json()).toEqual({
			records: [],
			hasMore: false,
			nextCursor: null,
			limit: 2,
		});
		totals.mockClear();
		const guarded = new Hono();
		guarded.onError((_error, c) => c.json({ error: "invalid query" }, 400));
		guarded.route("/", routes);
		for (const path of [
			"/user-totals?limit=101",
			"/user-totals?limit=0",
			"/user-totals?cursor=",
			`/user-totals?cursor=${"a".repeat(129)}`,
		])
			expect((await guarded.request(path)).status).toBe(400);
		expect(totals).not.toHaveBeenCalled();
	});
	test("passes userId through both list modes", async () => {
		await app.request("/?pagination=cursor&userId=alice-id");
		expect(listUsageHistoryCursor).toHaveBeenCalledWith({ userId: "alice-id" }, 50, undefined);
		await app.request("/?userId=__unattributed__");
		expect(listUsageHistory).toHaveBeenCalledWith(
			{ userId: "__unattributed__" },
			1,
			50,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	test("passes user filtering and user dimension through every aggregate route", async () => {
		const calls: Array<{ filters: unknown; options: unknown }> = [];
		const capture = async (filters: unknown, options: unknown) => {
			calls.push({ filters, options });
			return {} as never;
		};
		const routes = createUsageHistoryRoutes({
			requireAuth: async (_c, next) => {
				await next();
			},
			requireAdmin: async (_c, next) => {
				await next();
			},
			service: {
				...service,
				getUsageStats: capture,
				getUsageTimeSeries: capture,
				getUsageBreakdown: capture,
				getUsageTimeSeriesStacked: capture,
			},
		});
		for (const path of [
			"/stats",
			"/timeseries",
			"/breakdown?dimension=user&metric=requests",
			"/timeseries-stacked?dimension=user&metric=cost",
		]) {
			const response = await routes.request(
				`${path}${path.includes("?") ? "&" : "?"}userId=__unattributed__`,
			);
			expect(response.status).toBe(200);
		}
		expect(calls).toHaveLength(4);
		for (const call of calls) expect(call.filters).toEqual({ userId: "__unattributed__" });
		expect(calls[2].options).toMatchObject({ dimension: "user" });
		expect(calls[3].options).toMatchObject({ dimension: "user" });
	});

	test("real admin middleware blocks ordinary users from all usage routes", async () => {
		const guarded = new Hono();
		guarded.onError((error, c) =>
			c.json(
				{ error: error.message },
				(error as { statusCode?: number }).statusCode === 401 ? 401 : 403,
			),
		);
		guarded.route(
			"/",
			createUsageHistoryRoutes({
				requireAuth: async (c, next) => {
					c.set("user", { sub: "ordinary", role: "user", iat: 0, exp: 4_102_444_800 });
					await next();
				},
				service,
			}),
		);
		for (const path of [
			"/?userId=ordinary",
			"/user-totals",
			"/stats",
			"/timeseries",
			"/breakdown?dimension=user&metric=cost",
			"/timeseries-stacked?dimension=user&metric=cost",
			"/providers",
			"/request-id",
		]) {
			expect((await guarded.request(path)).status).toBe(403);
		}
		expect(listUsageHistoryCursor).not.toHaveBeenCalled();
		expect(listUsageHistory).not.toHaveBeenCalled();
	});

	test("default authentication rejects requests without a session", async () => {
		const guarded = new Hono();
		guarded.onError((_error, c) => c.json({ error: "unauthorized" }, 401));
		guarded.route("/", createUsageHistoryRoutes({ service }));
		expect((await guarded.request("/?userId=alice-id")).status).toBe(401);
		expect((await guarded.request("/request-id")).status).toBe(401);
	});

	test("real admin middleware permits administrator queries", async () => {
		const guarded = createUsageHistoryRoutes({
			requireAuth: async (c, next) => {
				c.set("user", { sub: "administrator", role: "admin", iat: 0, exp: 4_102_444_800 });
				await next();
			},
			service,
		});
		expect((await guarded.request("/?pagination=cursor&userId=alice-id")).status).toBe(200);
	});
});

describe("token recalculation routes", () => {
	function fixture(actor: "administrator" | "ordinary" | null = "administrator") {
		const job: TokenRecalculationJob = {
			id: "recalculation-job",
			status: "running",
			startedAt: "2026-10-26T00:00:00.000Z",
			finishedAt: null,
			scanned: 10,
			processed: 8,
			changed: 6,
			skipped: 2,
			fallback: 1,
			error: null,
		};
		const recalculationService = {
			get: mock((): TokenRecalculationJob | null => job),
			start: mock((range: TokenRecalculationRange) => ({ ...job, ...range })),
			cancel: mock((id: string) => ({ ...job, id })),
		};
		const getUsageRecord = mock(unexpectedServiceCall);
		const guarded = new Hono();
		// Mirror production error serialization instead of masking every thrown error as 400.
		guarded.onError(
			(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Internal error" }, 500),
		);
		guarded.route(
			"/",
			createUsageHistoryRoutes({
				requireAuth: actor
					? async (c, next) => {
							// A claimed admin role must not bypass the live ordinary-user role.
							c.set("user", { sub: actor, role: "admin", iat: 0, exp: 4_102_444_800 });
							await next();
						}
					: undefined,
				service: { ...service, getUsageRecord },
				recalculationService,
			}),
		);
		return { guarded, recalculationService, getUsageRecord, job };
	}

	test.each([
		["ordinary", 403],
		[null, 401],
	] as const)("%s cannot inspect, start, or cancel jobs", async (actor, status) => {
		const { guarded, recalculationService, getUsageRecord } = fixture(actor);
		for (const [path, method] of [
			["/token-recalculation", "GET"],
			["/token-recalculation", "POST"],
			["/token-recalculation/recalculation-job/cancel", "POST"],
		]) {
			const response = await guarded.request(path, {
				method,
				...(method === "POST"
					? { headers: { "Content-Type": "application/json" }, body: "{}" }
					: {}),
			});
			expect(response.status).toBe(status);
		}
		expect(recalculationService.get).not.toHaveBeenCalled();
		expect(recalculationService.start).not.toHaveBeenCalled();
		expect(recalculationService.cancel).not.toHaveBeenCalled();
		expect(getUsageRecord).not.toHaveBeenCalled();
	});

	test("administrator reads status and cancels the exact job without hitting /:id", async () => {
		const { guarded, recalculationService, getUsageRecord, job } = fixture();
		const response = await guarded.request("/token-recalculation");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ job });
		expect(recalculationService.get).toHaveBeenCalledTimes(1);
		recalculationService.get.mockReturnValueOnce(null);
		expect(await (await guarded.request("/token-recalculation")).json()).toEqual({ job: null });
		const cancelled = await guarded.request("/token-recalculation/exact-job-id/cancel", {
			method: "POST",
		});
		expect(cancelled.status).toBe(200);
		expect(await cancelled.json()).toEqual({ job: { ...job, id: "exact-job-id" } });
		expect(recalculationService.cancel).toHaveBeenCalledWith("exact-job-id");
		expect(getUsageRecord).not.toHaveBeenCalled();
	});

	test.each([
		{},
		{ startDate: "2026-10-01" },
		{ endDate: "2026-10-26" },
		{ startDate: "2026-10-01", endDate: "2026-10-26" },
		{ startDate: "2024-02-29", endDate: "2024-02-29" },
	])("administrator starts a valid range with 202: %j", async (range) => {
		const { guarded, recalculationService, getUsageRecord, job } = fixture();
		const response = await guarded.request("/token-recalculation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(range),
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ job: { ...job, ...range } });
		expect(recalculationService.start).toHaveBeenCalledWith(range);
		expect(recalculationService.start).toHaveBeenCalledTimes(1);
		expect(getUsageRecord).not.toHaveBeenCalled();
	});

	test.each([
		{ startDate: "not-a-date" },
		{ endDate: "2026-02-30" },
		{ startDate: "2026-02-29" },
		{ startDate: "2026-10-01T00:00:00Z" },
		{ startDate: "2026-10-27", endDate: "2026-10-26" },
		{ startDate: "2026-10-01", unknown: true },
		{ startDate: 123 },
		null,
		[],
	])("rejects an invalid range before starting work: %j", async (range) => {
		const { guarded, recalculationService } = fixture();
		const response = await guarded.request("/token-recalculation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(range),
		});
		expect(response.status).toBe(400);
		expect(recalculationService.start).not.toHaveBeenCalled();
	});

	test("rejects malformed JSON before starting work", async () => {
		const { guarded, recalculationService } = fixture();
		const response = await guarded.request("/token-recalculation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{",
		});
		expect(response.status).toBe(400);
		expect(recalculationService.start).not.toHaveBeenCalled();
	});

	test.each([
		false,
		true,
	])("enforces the 1024-byte boundary with Content-Length=%s", async (contentLength) => {
		const { guarded, recalculationService } = fixture();
		for (const size of [1024, 1025]) {
			recalculationService.start.mockClear();
			const headers = new Headers({ "Content-Type": "application/json" });
			if (contentLength) headers.set("Content-Length", String(size));
			const response = await guarded.request("/token-recalculation", {
				method: "POST",
				headers,
				// Whitespace is valid JSON padding, so rejection can only be the body limit.
				body: `{${" ".repeat(size - 2)}}`,
			});
			expect(response.status).toBe(size === 1024 ? 202 : 413);
			if (size === 1024) expect(recalculationService.start).toHaveBeenCalledWith({});
			else expect(recalculationService.start).not.toHaveBeenCalled();
		}
	});
});

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
