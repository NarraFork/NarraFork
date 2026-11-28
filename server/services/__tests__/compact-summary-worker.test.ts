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
import type { DbReadTaskParams } from "../../lib/db-worker/protocol";
import { AppError, NotFoundError } from "../../lib/errors";
import { settings } from "../../lib/settings";
import {
	appendLiveCompactDelta,
	finishLiveCompactProgress,
	liveCompactProgress,
	startLiveCompactProgress,
} from "../compact-live-state";
import { syncEnvelopeNow } from "../narrator-block-sync";
import { readEnvelope } from "../narrator-body-writes";
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

function readSegment(id: string, owner = narratorId, signal = new AbortController().signal) {
	return narratorService.readSegmentCompactSummaryDetail(owner, id, signal);
}

const detailScopes = ["compact", "segment-compact"] as const;
function markerFor(scope: (typeof detailScopes)[number]) {
	return scope === "compact"
		? statusId
		: seed(5, {
				role: "user",
				contentJson: [{ type: "segment_compact", status: "compacted", summary: "旧摘要" }],
			});
}

function keepOnlyBlockRows(id: string) {
	syncEnvelopeNow(id);
	db.update(narratorMessages)
		.set({ bodyRowsOnly: 1, contentJson: [] })
		.where(eq(narratorMessages.id, id))
		.run();
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
	db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, foreignId)).run();
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
		contentJson: [
			{
				type: "compact",
				status: "compacting",
				contextPercentBefore: 22,
				attempts: [{ attempt: 2, model: "stored-model", status: "running", startedAt: now }],
			},
		],
	});
	keepOnlyBlockRows(marker);
	settings.narratorBlocks.read = false;
	const readState = await read(marker);
	expect(readState).toMatchObject({ status: "compacting", contextPercentBefore: 22 });
	expect(readState.output).toBeUndefined();
	try {
		startLiveCompactProgress(marker, {
			narratorId,
			attempt: 1,
			model: "old-model",
			startedAt: now,
		});
		expect((await read(marker)).output).toBeUndefined();
		startLiveCompactProgress(marker, {
			narratorId: foreignId,
			attempt: 2,
			model: "foreign-model",
			startedAt: now,
		});
		expect((await read(marker)).output).toBeUndefined();
		startLiveCompactProgress(marker, {
			narratorId,
			attempt: 2,
			model: "live-model",
			startedAt: now,
			canChangeModel: true,
			pendingModel: "queued-model",
		});
		expect(await read(marker)).toMatchObject({
			model: "live-model",
			attempt: 2,
			canChangeModel: true,
			pendingModel: "queued-model",
			streamVersion: liveCompactProgress.get(marker)?.streamVersion,
			startedAt: now,
			outputChars: 0,
			output: "",
		});
	} finally {
		finishLiveCompactProgress(marker, "failed");
	}
});

test("segment detail combines committed block bodies with scoped live output", async () => {
	settings.narratorBlocks.read = true;
	const marker = seed(5, {
		role: "user",
		bodyFormat: 2,
		contentJson: [{ type: "segment_compact", status: "compacting", messageCount: 2 }],
	});
	keepOnlyBlockRows(marker);
	settings.narratorBlocks.read = false;
	db.insert(narratorMessageRefs)
		.values({ id: randomUUID(), narratorId: foreignId, messageId: marker, seq: 1 })
		.run();
	startLiveCompactProgress(marker, {
		narratorId,
		attempt: 1,
		model: "running-model",
		pendingModel: "next-model",
		canChangeModel: true,
		startedAt: now,
	});
	appendLiveCompactDelta(marker, "output", "live summary", { outputChars: 12, thinkingChars: 0 });
	try {
		expect(await readSegment(marker)).toMatchObject({
			status: "compacting",
			summary: "",
			mode: "blocking",
			model: "running-model",
			attempt: 1,
			pendingModel: "next-model",
			canChangeModel: true,
			streamVersion: liveCompactProgress.get(marker)?.streamVersion,
			output: "live summary",
		});
		expect(await readSegment(marker, foreignId).catch((error: unknown) => error)).toBeInstanceOf(
			NotFoundError,
		);
		expect(await read(marker).catch((error: unknown) => error)).toBeInstanceOf(NotFoundError);
	} finally {
		finishLiveCompactProgress(marker, "failed");
	}
}, 15_000);

test("segment history reads legacy summaries and rejects ordinary message bodies", async () => {
	const marker = seed(5, {
		role: "user",
		contentJson: [
			{ type: "segment_compact", status: "compacted", summary: "stored summary", model: "model" },
		],
	});
	expect(await readSegment(marker)).toMatchObject({
		status: "compacted",
		summary: "stored summary",
		model: "model",
		canRetry: false,
	});
	const ordinary = seed(6, {
		role: "user",
		contentJson: [{ type: "text", text: "not a summary" }],
	});
	expect(await readSegment(ordinary).catch((error: unknown) => error)).toBeInstanceOf(
		NotFoundError,
	);
}, 15_000);

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

test.each(
	detailScopes,
)("%s cancellation, disablement and Worker failures never retry inline", async (scope) => {
	const id = markerFor(scope);
	const load = scope === "compact" ? read : readSegment;
	settings.narratorBlocks.read = true;
	const controller = new AbortController();
	const { signal } = controller;
	const request = () => load(id, narratorId, signal);
	const task = {
		kind: "compactSummary",
		narratorId,
		messageId: id,
		fromBlocks: true,
		segment: scope === "compact" ? undefined : true,
	} satisfies DbReadTaskParams;
	const dispatch = spyOn(pool, "runReadTask");
	const query = spyOn(sqlite, "query");
	const prepare = spyOn(sqlite, "prepare");
	const assertDispatchedOnce = () => {
		expect(dispatch.mock.calls).toEqual([[sqlite.filename, task, { timeoutMs: 10_000, signal }]]);
		expect(dispatch.mock.calls[0][2]?.signal).toBe(signal);
		dispatch.mockClear();
	};
	try {
		const reason = new Error("HTTP disconnected");
		await expect(load(id, narratorId, AbortSignal.abort(reason))).rejects.toBe(reason);
		expect(dispatch).not.toHaveBeenCalled();

		process.env.NARRAFORK_DB_WORKER = "off";
		await expect(request()).rejects.toMatchObject({ reason: "disabled_by_env" });
		assertDispatchedOnce();
		delete process.env.NARRAFORK_DB_WORKER;
		pool.setDbWorkerSpecifiersForTest(["./no-compact-read-worker.ts"]);
		await expect(request()).rejects.toMatchObject({ reason: "worker_spawn_failed" });
		assertDispatchedOnce();
		await pool.shutdownDbWorkerPool({ pause: true });
		await expect(request()).rejects.toMatchObject({ reason: "pool_shutdown" });
		assertDispatchedOnce();
		await pool.resetDbWorkerPoolForTest();

		for (const error of [
			new pool.DbReadTaskTimeoutError("timed out"),
			new pool.DbReadTaskExecutionError("worker exited"),
		]) {
			dispatch.mockRejectedValueOnce(error);
			await expect(request()).rejects.toBe(error);
			assertDispatchedOnce();
		}
		dispatch.mockRejectedValueOnce(
			Object.assign(new pool.DbReadTaskExecutionError("Compact body exceeds its read budget"), {
				code: COMPACT_SUMMARY_BUDGET_EXCEEDED,
			}),
		);
		const budget = await request().catch((err: unknown) => err);
		expect(budget).toBeInstanceOf(AppError);
		expect(budget).toMatchObject({ statusCode: 413, code: COMPACT_SUMMARY_BUDGET_EXCEEDED });
		assertDispatchedOnce();

		const late = Promise.withResolvers<unknown>();
		dispatch.mockReturnValueOnce(late.promise);
		const pending = request();
		assertDispatchedOnce();
		controller.abort(reason);
		late.resolve({ notFound: "Message" });
		await expect(pending).rejects.toBe(reason);
		expect(dispatch).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		query.mockRestore();
		dispatch.mockRestore();
	}
});

test.each(
	detailScopes,
)("a committed %s detail read is unavailable inside an active transaction", async (scope) => {
	const id = markerFor(scope);
	const load = scope === "compact" ? read : readSegment;
	const pending = sqlite.transaction(() => load(id))();
	await expect(pending).rejects.toBeInstanceOf(pool.WorkersUnavailableError);
});

test.each(
	detailScopes,
)("the %s HTTP route checks access before dispatch and before releasing the snapshot", async (scope) => {
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
	const markerId = markerFor(scope);
	const path = `/${narratorId}/${scope}/${markerId}`;
	const method =
		scope === "compact" ? "readCompactSummaryDetail" : "readSegmentCompactSummaryDetail";
	const actual = narratorService[method];
	const dispatch = spyOn(narratorService, method);
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
}, 30_000);

test.each([
	false,
	true,
])("editing a finalized segment preserves its generating model (block reads: %s)", async (fromBlocks) => {
	settings.narratorBlocks.read = fromBlocks;
	for (const [i, model] of ["provider:primary", "provider:replacement"].entries()) {
		const id = seed(5 + i, {
			role: "user",
			bodyFormat: fromBlocks ? 2 : 1,
			contentJson: [{ type: "segment_compact", status: "compacting", messageCount: 0 }],
		});
		await narratorService.finalizeSegmentCompact(id, narratorId, "generated", undefined, { model });
		if (fromBlocks) keepOnlyBlockRows(id);
		const before = await readSegment(id);
		expect(before).toMatchObject({ status: "compacted", summary: "generated", model });
		await narratorService.updateSegmentCompactSummary(narratorId, id, "edited");
		expect(await readSegment(id)).toEqual({ ...before, summary: "edited" });
	}
});

test.each([
	false,
	true,
])("editing a legacy segment preserves other fields and blocks without adding a model (block reads: %s)", async (fromBlocks) => {
	settings.narratorBlocks.read = fromBlocks;
	const marker = {
		type: "segment_compact",
		status: "compacted",
		summary: "old",
		contextPercentBefore: 73,
		trigger: "manual",
	};
	const neighbor = { type: "text", text: "unchanged" };
	const id = seed(5, {
		role: "user",
		bodyFormat: fromBlocks ? 2 : 1,
		contentJson: [marker, neighbor],
	});
	if (fromBlocks) keepOnlyBlockRows(id);
	await expect(
		narratorService.updateSegmentCompactSummary(foreignId, id, "foreign edit"),
	).rejects.toBeInstanceOf(NotFoundError);
	const before = await readSegment(id);
	expect(before).toMatchObject({ summary: "old", trigger: "manual", contextPercentBefore: 73 });
	expect(before.model).toBeUndefined();
	await narratorService.updateSegmentCompactSummary(narratorId, id, "edited");
	expect(await readSegment(id)).toEqual({ ...before, summary: "edited" });
	const row = readEnvelope(db, id);
	expect(row?.contentJson).toEqual([{ ...marker, summary: "edited" }, neighbor]);
	expect(row?.contentText).toBe("[Segment Compact]\nedited");
	expect(row?.contextCharsJson).toEqual({
		segments: [
			{ category: "summary", chars: "edited".length },
			{ category: "user", chars: neighbor.text.length },
		],
	});
});
