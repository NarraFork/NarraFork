import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { StorageHistoryReadParams } from "../../lib/db-worker/storage-history-query";
import { AppError } from "../../lib/errors";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { createStorageHistoryService } from "../../services/storage-history-service";
import { createStorageHistoryRoutes } from "../storage-history";

let home: string;
let service: ReturnType<typeof createStorageHistoryService>;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "nf-history-route-"));
	setAuthStores({
		session: {
			...authSessionStore,
			findSessionState: async (id) => ({
				id,
				role: id === "admin" ? "admin" : "user",
				tokenVersion: 0,
			}),
		},
		mfa: authMfaStore,
	});
	service = createStorageHistoryService({
		journalPath: join(home, "jobs.json"),
		policies: () => ({
			toolCallPayloads: { retentionDays: null, autoCleanup: false },
			messageHistory: { retentionDays: null, autoCleanup: false },
		}),
		read: async <T>(p: StorageHistoryReadParams): Promise<T> =>
			(p.mode === "buckets" ? [{ day: "2020-01-01", count: 2, approxBytes: 256 }] : []) as T,
		clear: async () => ({ cleared: true, retained: false }),
		maintenance: async (work) => work(),
	});
});
afterEach(async () => {
	service.stop();
	await service.settled();
	setAuthStores(undefined);
	await rm(home, { recursive: true, force: true });
});
function app(role: "admin" | "user" = "admin") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: role, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) =>
		Response.json(
			{ error: error.message },
			{ status: error instanceof AppError ? error.statusCode : 500 },
		),
	);
	app.route(
		"/history",
		createStorageHistoryRoutes(() => service),
	);
	return app;
}
function post(path: string, body: unknown, role: "admin" | "user" = "admin") {
	return app(role).request(`/history/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
const selection = { target: "toolCallPayloads", cutoffAt: "2021-01-01T00:00:00.000Z" };

describe("administrator history cleanup API", () => {
	test("preview and background start use the same absolute cutoff", async () => {
		const preview = await post("preview", selection);
		expect(preview.status).toBe(200);
		expect((await preview.json()).preview).toEqual({
			...selection,
			count: 2,
			approxBytes: 256,
		});
		const started = await post("cleanup", selection);
		expect(started.status).toBe(202);
		const { job } = await started.json();
		expect(job).toMatchObject(selection);
		await service.settled();
		const state = await app().request("/history/jobs");
		expect((await state.json()).jobs.toolCallPayloads).toMatchObject({
			id: job.id,
			status: "completed",
		});
	});
	test("both independent targets accept their own dates and cancellation", async () => {
		const first = await post("cleanup", selection);
		expect(first.status).toBe(202);
		expect(
			(await post("cleanup", { target: "messageHistory", cutoffAt: "2022-01-01T00:00:00Z" }))
				.status,
		).toBe(202);
		expect((await post("cancel", { target: "toolCallPayloads" })).status).toBe(200);
		await service.settled();
		const { jobs } = await (await app().request("/history/jobs")).json();
		expect(jobs.messageHistory.cutoffAt).toBe("2022-01-01T00:00:00.000Z");
		expect(jobs.toolCallPayloads.cutoffAt).toBe(selection.cutoffAt);
	});
	test("rejects malformed ranges, future dates, extra keys and excessive request bytes", async () => {
		for (const value of [
			{ ...selection, target: "other" },
			{ ...selection, cutoffAt: "2021-01-01" },
			{ ...selection, cutoffAt: "2999-01-01T00:00:00Z" },
			{ ...selection, sql: "DELETE" },
		])
			expect((await post("cleanup", value)).status).toBe(400);
		expect((await post("preview", { ...selection, padding: "x".repeat(10_000) })).status).toBe(413);
	});
	test("all routes enforce administrator access", async () => {
		expect((await app("user").request("/history/jobs")).status).toBe(403);
		for (const path of ["preview", "cleanup"])
			expect((await post(path, selection, "user")).status).toBe(403);
		expect((await post("cancel", { target: "messageHistory" }, "user")).status).toBe(403);
	});
});

describe("legacy tool-preview forwarding", () => {
	for (const olderThanDays of [undefined, 30]) {
		test(`uses worker-backed history statistics for retention ${olderThanDays ?? "default"}`, async () => {
			const { storageRoutes } = await import("../storage");
			const { getStorageHistoryService } = await import("../../services/storage-history-runtime");
			const { databaseCleanupService, DEFAULT_TOOL_CALL_PAYLOAD_DAYS } = await import(
				"../../services/database-cleanup-service"
			);
			const legacy = spyOn(databaseCleanupService, "previewCleanup").mockImplementation(() => {
				throw new Error("Legacy main-thread aggregation must not run");
			});
			const preview = spyOn(getStorageHistoryService(), "preview").mockImplementation(
				async (target, cutoffAt) => ({
					target,
					cutoffAt,
					count: 7,
					approxBytes: 321,
				}),
			);
			try {
				const instance = app();
				instance.route("/storage", storageRoutes);
				const before = Date.now();
				const response = await instance.request("/storage/database/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ target: "toolCallPayloads", olderThanDays }),
				});
				const after = Date.now();
				expect(response.status).toBe(200);
				expect((await response.json()).preview).toMatchObject({
					target: "toolCallPayloads",
					count: 7,
					approxBytes: 321,
				});
				expect(preview).toHaveBeenCalledTimes(1);
				const call = preview.mock.calls[0];
				const age = (olderThanDays ?? DEFAULT_TOOL_CALL_PAYLOAD_DAYS) * 86_400_000;
				expect(Date.parse(call[1])).toBeGreaterThanOrEqual(before - age);
				expect(Date.parse(call[1])).toBeLessThanOrEqual(after - age);
				expect(call[2]).toBeInstanceOf(AbortSignal);
				expect(legacy).not.toHaveBeenCalled();
			} finally {
				preview.mockRestore();
				legacy.mockRestore();
			}
		});
	}

	test("worker failure stays an error without local aggregation or an empty success", async () => {
		const { storageRoutes } = await import("../storage");
		const { getStorageHistoryService } = await import("../../services/storage-history-runtime");
		const { databaseCleanupService } = await import("../../services/database-cleanup-service");
		const legacy = spyOn(databaseCleanupService, "previewCleanup").mockImplementation(() => {
			throw new Error("Legacy main-thread aggregation must not run");
		});
		const preview = spyOn(getStorageHistoryService(), "preview").mockRejectedValue(
			new AppError("History read workers unavailable", 503, "HISTORY_WORKERS_UNAVAILABLE"),
		);
		try {
			const instance = app();
			instance.route("/storage", storageRoutes);
			const response = await instance.request("/storage/database/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target: "toolCallPayloads", olderThanDays: 30 }),
			});
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "History read workers unavailable" });
			expect(preview).toHaveBeenCalledTimes(1);
			expect(legacy).not.toHaveBeenCalled();
		} finally {
			preview.mockRestore();
			legacy.mockRestore();
		}
	});
});

test("the legacy tool-cleanup HTTP endpoint forwards to a bounded background history job", async () => {
	const { storageRoutes } = await import("../storage");
	const { getStorageHistoryService } = await import("../../services/storage-history-runtime");
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: "admin", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.route("/storage", storageRoutes);
	const runtime = getStorageHistoryService();
	try {
		const response = await instance.request("/storage/database/cleanup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ target: "toolCallPayloads", olderThanDays: 180 }),
		});
		expect(response.status).toBe(202);
		const { job } = await response.json();
		expect(job).toMatchObject({ target: "toolCallPayloads", source: "manual" });
		expect(job.cutoffAt).toMatch(/Z$/);
		await runtime.settled();
	} finally {
		runtime.stop();
		await runtime.settled();
	}
}, 30_000);
