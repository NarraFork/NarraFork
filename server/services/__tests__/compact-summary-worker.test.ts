import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { narratorMessageRefs, narratorMessages, narrators, users } from "../../db/schema";
import {
	COMPACT_SUMMARY_BUDGET_EXCEEDED,
	readCompactSummary,
} from "../../lib/db-worker/compact-summary-query";
import * as pool from "../../lib/db-worker/pool";
import { AppError, NotFoundError } from "../../lib/errors";
import { settings } from "../../lib/settings";
import { finishLiveCompactProgress, startLiveCompactProgress } from "../compact-live-state";
import { syncEnvelopeNow } from "../narrator-block-sync";
import { narratorService } from "../narrator-service";

const savedWorkerSetting = process.env.NARRAFORK_DB_WORKER;
const savedBlockRead = settings.narratorBlocks.read;
let narratorId: string;
let foreignId: string;
let statusId: string;
const now = "2026-01-01T00:00:00.000Z";

function seed(
	seq: number,
	values: Pick<typeof narratorMessages.$inferInsert, "role" | "contentJson"> &
		Partial<typeof narratorMessages.$inferInsert>,
	isCompact = 0,
): string {
	const id = randomUUID();
	db.insert(narratorMessages)
		.values({ ...values, id, narratorId, createdAt: now })
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: randomUUID(), narratorId, messageId: id, seq, isCompact })
		.run();
	return id;
}

function read(id = statusId, owner = narratorId, signal = new AbortController().signal) {
	return narratorService.readCompactSummaryDetail(owner, id, signal);
}

beforeEach(async () => {
	await pool.resetDbWorkerPoolForTest();
	delete process.env.NARRAFORK_DB_WORKER;
	settings.narratorBlocks.read = false;
	expect(sqlite.filename).not.toBe(":memory:");
	narratorId = randomUUID();
	foreignId = randomUUID();
	db.insert(narrators)
		.values([narratorId, foreignId].map((id) => ({ id, createdAt: now, updatedAt: now })))
		.run();
	seed(0, { role: "user", contentJson: [], contextPercent: 91 });
	seed(1, { role: "system", contentJson: [{ type: "compact", status: "compacted" }] }, 1);
	seed(2, { role: "assistant", contentJson: [], contextPercent: 42 });
	seed(3, { role: "system", contentJson: [], contextPercent: 85 });
	statusId = seed(4, {
		role: "system",
		contentJson: [
			{
				type: "compact",
				status: "failed",
				summary: "旧摘要",
				attempts: [
					{ attempt: 1, model: "fallback", status: "failed", startedAt: now, error: "failed" },
				],
			},
		],
		contextPercent: 17,
		tokensIn: 10,
	});
});

afterEach(async () => {
	finishLiveCompactProgress(statusId, "failed");
	await pool.resetDbWorkerPoolForTest();
	settings.narratorBlocks.read = savedBlockRead;
	if (savedWorkerSetting === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = savedWorkerSetting;
	db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId)).run();
	db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId)).run();
	db.delete(narrators).where(eq(narrators.id, foreignId)).run();
	db.delete(narrators).where(eq(narrators.id, narratorId)).run();
});

test("reads the committed marker, occupancy and retry eligibility together", async () => {
	const inline = await narratorService.getCompactSummary(narratorId, statusId);
	expect(await read()).toEqual(inline);
	expect(inline).toMatchObject({
		status: "failed",
		summary: "旧摘要",
		canRetry: true,
		contextPercentBefore: 42,
		contextPercentAfter: 17,
		error: "failed",
	});
	const foreign = await read(statusId, foreignId).catch((err: unknown) => err);
	expect(foreign).toBeInstanceOf(NotFoundError);
	const nonCompact = await read(seed(5, { role: "system", contentJson: [] })).catch(
		(err: unknown) => err,
	);
	expect(nonCompact).toBeInstanceOf(NotFoundError);
	expect((nonCompact as NotFoundError).message).toContain("CompactSummary");
	const later = seed(
		6,
		{ role: "system", contentJson: [{ type: "compact", status: "compacted" }] },
		1,
	);
	expect((await read()).canRetry).toBe(false);
	expect((await read(later)).contextPercentBefore).toBe(42);
});

test("reads current block bodies and adds only current local live progress", async () => {
	settings.narratorBlocks.read = true;
	const marker = seed(5, {
		role: "system",
		bodyFormat: 2,
		contentJson: [{ type: "compact", status: "compacting", contextPercentBefore: 22 }],
	});
	syncEnvelopeNow(marker);
	db.update(narratorMessages)
		.set({ bodyRowsOnly: 1, contentJson: [] })
		.where(eq(narratorMessages.id, marker))
		.run();
	settings.narratorBlocks.read = false;
	const readState = await read(marker);
	expect(readState).toMatchObject({ status: "compacting", contextPercentBefore: 22 });
	expect(readState.output).toBeUndefined();
	startLiveCompactProgress(marker, { model: "live-model", startedAt: now });
	try {
		expect(await read(marker)).toMatchObject({
			model: "live-model",
			startedAt: now,
			outputChars: 0,
			output: "",
		});
	} finally {
		finishLiveCompactProgress(marker, "failed");
	}
});

test("retains summaries larger than the generic SELECT result budget", async () => {
	const summary = "x".repeat(5 * 1024 * 1024);
	const large = seed(5, {
		role: "system",
		contentJson: [{ type: "compact", status: "compacted", summary }],
	});
	expect((await read(large)).summary === summary).toBe(true);
	expect(() =>
		readCompactSummary(
			sqlite,
			{ narratorId, messageId: large, fromBlocks: false },
			new AbortController().signal,
			1024,
		),
	).toThrow("Compact body exceeds its read budget");
});

test("cancellation, disablement and Worker failures never retry inline", async () => {
	const abort = new AbortController();
	abort.abort(new Error("HTTP disconnected"));
	await expect(read(statusId, narratorId, abort.signal)).rejects.toThrow("HTTP disconnected");
	process.env.NARRAFORK_DB_WORKER = "off";
	await expect(read()).rejects.toBeInstanceOf(pool.WorkersUnavailableError);
	delete process.env.NARRAFORK_DB_WORKER;
	pool.setDbWorkerSpecifiersForTest(["./no-compact-read-worker.ts"]);
	await expect(read()).rejects.toBeInstanceOf(pool.WorkersUnavailableError);
	await pool.resetDbWorkerPoolForTest();

	const dispatch = spyOn(pool, "runReadTask");
	try {
		const signal = new AbortController().signal;
		for (const error of [
			new pool.DbReadTaskTimeoutError("timed out"),
			new pool.DbReadTaskExecutionError("worker exited"),
		]) {
			dispatch.mockRejectedValueOnce(error);
			await expect(read(statusId, narratorId, signal)).rejects.toBe(error);
			expect(dispatch).toHaveBeenLastCalledWith(
				sqlite.filename,
				expect.objectContaining({ kind: "compactSummary" }),
				{ timeoutMs: 10_000, signal },
			);
		}
		dispatch.mockRejectedValueOnce(
			Object.assign(new pool.DbReadTaskExecutionError("Compact body exceeds its read budget"), {
				code: COMPACT_SUMMARY_BUDGET_EXCEEDED,
			}),
		);
		const budget = await read().catch((err: unknown) => err);
		expect(budget).toBeInstanceOf(AppError);
		expect({ ...(budget as AppError) }).toMatchObject({
			statusCode: 413,
			code: COMPACT_SUMMARY_BUDGET_EXCEEDED,
		});
	} finally {
		dispatch.mockRestore();
	}
});

test("a committed detail read never opens an inline reader inside an active transaction", async () => {
	const pending = sqlite.transaction(() => read())();
	await expect(pending).rejects.toBeInstanceOf(pool.WorkersUnavailableError);
});

test("the HTTP route checks access before dispatch and before releasing the snapshot", async () => {
	const { narratorRoutes } = await import("../../routes/narrators");
	const app = new Hono();
	const owner = randomUUID();
	const newOwner = randomUUID();
	db.insert(users)
		.values(
			[owner, newOwner].map((id) => ({
				id,
				username: id,
				passwordHash: "unused",
				role: "user" as const,
				createdAt: now,
			})),
		)
		.run();
	db.update(narrators)
		.set({ ownerUserId: owner, visibility: "private" })
		.where(eq(narrators.id, narratorId))
		.run();
	app.use("*", async (c, next) => {
		c.set("user", { sub: c.req.header("x-test-user") ?? owner, role: "user", iat: 1, exp: 2 });
		await next();
	});
	app.route("/", narratorRoutes);
	app.onError((error) => new Response(error.message, { status: (error as AppError).statusCode }));
	const path = `/${narratorId}/compact/${statusId}`;
	const actual = narratorService.readCompactSummaryDetail;
	const dispatch = spyOn(narratorService, "readCompactSummaryDetail");
	try {
		expect((await app.request(path, { headers: { "x-test-user": newOwner } })).status).toBe(404);
		expect(dispatch).not.toHaveBeenCalled();
		expect((await app.request(path)).status).toBe(200);
		dispatch.mockImplementationOnce(async (...args) => {
			const detail = await actual(...args);
			db.update(narrators).set({ ownerUserId: newOwner }).where(eq(narrators.id, narratorId)).run();
			return detail;
		});
		const revoked = await app.request(path);
		expect(revoked.status).toBe(404);
		expect(await revoked.text()).not.toContain("旧摘要");
	} finally {
		dispatch.mockRestore();
		db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, narratorId)).run();
		for (const id of [owner, newOwner]) db.delete(users).where(eq(users.id, id)).run();
	}
});
