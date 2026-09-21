import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	REQUEST_DUMP_SPILL_DIR,
	REQUEST_DUMP_SPILL_POINTER_SCHEMA,
} from "@server/lib/api-request-dump-store";
import { getNarraforkPath } from "@server/lib/narrafork-home";
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

const getRawDumpSource = mock(unexpectedServiceCall);

const service: UsageHistoryRouteService = {
	listUsageHistoryCursor,
	listUsageHistory,
	listProviders: unexpectedServiceCall,
	getUsageStats: unexpectedServiceCall,
	getUsageTimeSeries: unexpectedServiceCall,
	getUsageRecord: unexpectedServiceCall,
	getRawDumpSource,
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

	test("real admin middleware blocks ordinary users from all usage and dump routes", async () => {
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
			"/request-id/raw-dump",
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
		expect((await guarded.request("/request-id/raw-dump")).status).toBe(401);
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

/**
 * The download route's whole purpose is that a user who opens a dump gets ALL of it. Each
 * test here pins one way that promise could quietly break: serving the row when a file
 * exists, 404ing when the file was pruned, or following a path outside the dump directories.
 */
describe("usage history raw dump download", () => {
	const baseRecord = {
		id: "req-1",
		narratorId: "n-1",
		narratorTitle: "Diagnose the rejection",
		chapterId: "ch-1",
		chapterTitle: "request dumps",
		projectId: "proj-1",
		kind: "narrator",
		provider: "nug2",
		credentialId: null,
		credentialName: "work@example.invalid",
		model: "nug2:anthropic:claude-opus-5",
		errorMessage: "Improperly formed request.",
		createdAt: "2026-08-19T10:47:10.832Z",
	};

	beforeEach(() => {
		getRawDumpSource.mockReset();
	});

	test("404s when the record has no dump at all", async () => {
		getRawDumpSource.mockResolvedValueOnce({ ...baseRecord, rawDumpJson: null } as never);
		const response = await app.request("/req-1/raw-dump");
		expect(response.status).toBe(404);
	});

	/**
	 * Both download paths must hand back ONE shape. This test previously asserted that the
	 * response equalled the row string byte for byte, which froze the opposite into a
	 * contract: the response shape depended on whether the dump happened to exceed a row
	 * budget, and the inline path silently dropped the request identity that the old
	 * client-side export attached (narrator/chapter/project/credential names). A dump gets
	 * forwarded to whoever is helping diagnose it, so that identity has to travel with it.
	 */
	test("wraps the row's dump in the same envelope a spill file carries", async () => {
		const inline = JSON.stringify({ request: { body: { hello: "world" } } });
		getRawDumpSource.mockResolvedValueOnce({ ...baseRecord, rawDumpJson: inline } as never);

		const response = await app.request("/req-1/raw-dump");
		expect(response.status).toBe(200);
		const body = JSON.parse(await response.text()) as Record<string, unknown>;

		expect(body.schema).toBe("narrafork.api-request-dump.v1");
		expect(body.requestId).toBe("req-1");
		expect(body.createdAt).toBe(baseRecord.createdAt);
		expect(body.dump).toEqual({ request: { body: { hello: "world" } } });
		// The metadata the previous client-side export provided and the bare-row response lost.
		expect(body.narratorTitle).toBe("Diagnose the rejection");
		expect(body.chapterId).toBe("ch-1");
		expect(body.chapterTitle).toBe("request dumps");
		expect(body.projectId).toBe("proj-1");
		expect(body.credentialName).toBe("work@example.invalid");
		expect(body.provider).toBe("nug2");
		expect(body.errorMessage).toBe("Improperly formed request.");

		expect(response.headers.get("content-disposition")).toContain("attachment");
		// Never application/json: attacker-influenced text on a same-origin URL.
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	test("serves the complete file, not the truncated row, when the dump spilled", async () => {
		const spillPath = getNarraforkPath(REQUEST_DUMP_SPILL_DIR, "download-test.json");
		const complete = JSON.stringify({
			schema: "narrafork.api-request-dump.v1",
			dump: { request: { body: { pad: "F".repeat(50_000) } } },
		});
		await mkdir(dirname(spillPath), { recursive: true });
		await writeFile(spillPath, complete, "utf8");

		// The row holds only a head plus the pointer — exactly the shape that used to be
		// downloaded and mistaken for the whole dump.
		getRawDumpSource.mockResolvedValueOnce({
			...baseRecord,
			rawDumpJson: JSON.stringify({
				request: { bodyTextTruncated: true, bodyText: "FFF" },
				spill: {
					schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
					filePath: spillPath,
					bytes: complete.length,
					inlineTruncated: true,
					note: "full dump on disk",
				},
			}),
		} as never);

		const response = await app.request("/req-1/raw-dump");
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toBe(complete);
		expect(text).not.toContain("bodyTextTruncated");

		await rm(spillPath, { force: true });
	});

	test("falls back to the inline head when the spilled file was pruned", async () => {
		// Pruning outlives the row, so a missing file must still yield what survived rather
		// than a 404 that hides the head the row still has.
		const inline = JSON.stringify({
			request: { bodyTextTruncated: true, bodyText: "head only" },
			spill: {
				schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
				filePath: getNarraforkPath(REQUEST_DUMP_SPILL_DIR, "already-pruned.json"),
				bytes: 999,
				inlineTruncated: true,
				note: "full dump on disk",
			},
		});
		getRawDumpSource.mockResolvedValueOnce({ ...baseRecord, rawDumpJson: inline } as never);

		const response = await app.request("/req-1/raw-dump");
		expect(response.status).toBe(200);
		const body = JSON.parse(await response.text()) as {
			dump?: {
				request?: { bodyText?: string };
				spill?: { fileName?: string; filePath?: string; note?: string };
			};
		};
		// What survived is still delivered, including the pointer's explanation of what is not.
		expect(body.dump?.request?.bodyText).toBe("head only");
		expect(body.dump?.spill?.note).toBe("full dump on disk");
		// But not the server's path: a downloaded dump gets forwarded to whoever is helping
		// diagnose it, and the path names the host's OS account. The file name is kept because
		// it is what correlates the download with the server log line.
		expect(body.dump?.spill?.filePath).toBeUndefined();
		expect(body.dump?.spill?.fileName).toBe("already-pruned.json");
	});

	test("an unparseable row keeps its text verbatim inside the envelope", async () => {
		// Re-encoding would destroy the malformed text someone is trying to read, so it is
		// preserved exactly — but still enveloped, because a bare response for precisely the
		// rows that need explaining is the shape inconsistency this route just removed.
		const broken = '{ "request": truncated mid-write';
		getRawDumpSource.mockResolvedValueOnce({ ...baseRecord, rawDumpJson: broken } as never);

		const response = await app.request("/req-1/raw-dump");
		expect(response.status).toBe(200);
		const body = JSON.parse(await response.text()) as {
			schema?: string;
			requestId?: string;
			dumpText?: string;
			dumpParseError?: string;
		};
		expect(body.schema).toBe("narrafork.api-request-dump.v1");
		expect(body.requestId).toBe("req-1");
		expect(body.dumpText).toBe(broken);
		expect(body.dumpParseError).toBeTruthy();
	});

	test("ignores a pointer aiming outside the dump directories", async () => {
		// Defense in depth: the path comes from our own row, but a tampered or corrupted one
		// must not turn this route into an arbitrary-file reader.
		const inline = JSON.stringify({
			request: { bodyText: "head" },
			spill: {
				schema: REQUEST_DUMP_SPILL_POINTER_SCHEMA,
				filePath: getNarraforkPath("settings.json"),
				bytes: 10,
				inlineTruncated: true,
				note: "tampered",
			},
		});
		getRawDumpSource.mockResolvedValueOnce({ ...baseRecord, rawDumpJson: inline } as never);

		const response = await app.request("/req-1/raw-dump");
		expect(response.status).toBe(200);
		const body = JSON.parse(await response.text()) as {
			dump?: {
				request?: { bodyText?: string };
				spill?: { filePath?: string; fileName?: string };
			};
		};
		// The row is served (not the file it pointed at), and the tampered path is not echoed
		// back either — this branch would have leaked it if redaction were tied to the
		// pruned-file case alone.
		expect(body.dump?.request?.bodyText).toBe("head");
		expect(body.dump?.spill?.filePath).toBeUndefined();
		expect(body.dump?.spill?.fileName).toBe("settings.json");
	});
});
