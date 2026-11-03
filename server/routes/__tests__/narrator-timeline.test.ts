import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { AppError, ForbiddenError } from "../../lib/errors";

const realAccess = { ...(await import("../../lib/narrator-access")) };
const realService = { ...(await import("../../services/narrator-timeline")) };

const access = mock(async (_c: unknown, id: string, need: string) => {
	if (id === "denied") throw new ForbiddenError("no");
	return { id, need };
});
const turns = mock(async (narratorId: string, query: unknown) => ({
	narratorId,
	query,
	turns: [],
	hasMore: false,
}));
const timeline = mock(async (narratorId: string, turnId?: string) =>
	turnId === "missing" ? null : { narratorId, turnId: turnId ?? null },
);

mock.module("../../lib/narrator-access", () => ({ ...realAccess, requireNarratorAccess: access }));
mock.module("../../services/narrator-timeline", () => ({
	...realService,
	listTimelineTurns: turns,
	getTurnTimeline: timeline,
}));

const { narratorTimelineRoutes } = await import("../narrator-timeline");

afterAll(() => {
	mock.module("../../lib/narrator-access", () => realAccess);
	mock.module("../../services/narrator-timeline", () => realService);
});

function app() {
	const root = new Hono();
	root.route("/api/narrators", narratorTimelineRoutes);
	root.onError((error, c) => {
		if (error instanceof AppError) return c.json({ code: error.code }, error.statusCode as 403);
		return c.json({ code: "VALIDATION" }, 400);
	});
	return root;
}

beforeEach(() => {
	access.mockClear();
	turns.mockClear();
	timeline.mockClear();
});

describe("narrator timeline routes", () => {
	test("timeline requires read access and defaults to the latest turn", async () => {
		const response = await app().request("/api/narrators/n1/timeline");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ narratorId: "n1", turnId: null });
		expect(access.mock.calls[0]?.slice(1)).toEqual(["n1", "read"]);
	});

	test("passes a derived turn id and 404s an unknown turn", async () => {
		const ok = await app().request("/api/narrators/n1/timeline?turnId=msg:abc_1");
		expect(await ok.json()).toEqual({ narratorId: "n1", turnId: "msg:abc_1" });
		const missing = await app().request("/api/narrators/n1/timeline?turnId=missing");
		expect(missing.status).toBe(404);
	});

	test("rejects malformed turn ids before reaching the service", async () => {
		const response = await app().request("/api/narrators/n1/timeline?turnId=a%20b");
		expect(response.status).toBe(400);
		expect(timeline).not.toHaveBeenCalled();
	});

	test("turn list parses its cursor and limit", async () => {
		const response = await app().request(
			"/api/narrators/n1/timeline/turns?limit=5&before=2026-11-01T00:00:00.000Z",
		);
		expect(response.status).toBe(200);
		expect(turns.mock.calls[0]).toEqual(["n1", { limit: 5, before: "2026-11-01T00:00:00.000Z" }]);
		const tooMany = await app().request("/api/narrators/n1/timeline/turns?limit=500");
		expect(tooMany.status).toBe(400);
	});

	test("denied narrators never reach the service", async () => {
		const response = await app().request("/api/narrators/denied/timeline/turns");
		expect(response.status).toBe(403);
		expect(turns).not.toHaveBeenCalled();
	});
});
