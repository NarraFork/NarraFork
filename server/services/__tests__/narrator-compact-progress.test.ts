/**
 * narrator-compact-progress.test.ts — The compaction progress reporter's WS
 * payload: two-phase counts, correct delta→phase routing, and the throttle
 * behaviour around a phase switch.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };

let broadcasts: Array<Record<string, unknown>> = [];

mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: (_narratorId: string, message: Record<string, unknown>) => {
		broadcasts.push(message);
	},
}));

const {
	cancelCompact,
	createCompactProgressReporter,
	isCompactInProgress,
	retryFailedCompact,
	runCustomCompact,
	runSegmentCompact,
} = await import("../narrator-compact");
const { narratorService } = await import("../narrator-service");
const { narratorContext } = await import("../narrator-context");
const { settings, getSummaryModelContextWindowDetail } = await import("../../lib/settings");

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

function makeReporter(isSegment = false) {
	return createCompactProgressReporter({
		narratorId: "n-compact-progress",
		messageId: "compact-1",
		mode: "blocking",
		...(isSegment ? { isSegment: true } : {}),
	});
}

beforeEach(() => {
	broadcasts = [];
});

afterAll(() => {
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.module("../../db", () => realDbModule);
	sqlite.close();
	mock.restore();
});

describe("compact progress reporter", () => {
	test("broadcasts thinking progress before any summary text exists", async () => {
		// The regression this covers: the old de-duplication key was `outputChars`
		// alone, which stays 0 for the whole thinking window, so nothing was ever sent.
		const reporter = makeReporter();
		reporter.onReasoningDelta("r".repeat(64));
		await settle();
		reporter.finish();

		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0]).toMatchObject({
			type: "compact_progress",
			messageId: "compact-1",
			phase: "thinking",
			thinkingChars: 64,
			outputChars: 0,
			mode: "blocking",
		});
		expect(broadcasts[0]).not.toHaveProperty("output");
		expect(broadcasts[0]).not.toHaveProperty("thinking");
	});

	test("routes text deltas to the output phase and keeps the thinking total", async () => {
		const reporter = makeReporter();
		reporter.onReasoningDelta("r".repeat(30));
		await settle();
		reporter.onTextDelta("summary text");
		reporter.finish();

		const last = broadcasts.at(-1);
		expect(last).toMatchObject({ phase: "output", thinkingChars: 30, outputChars: 12 });
	});

	test("never reverts to thinking once output started", async () => {
		const reporter = makeReporter();
		reporter.onTextDelta("abc");
		await settle();
		reporter.onReasoningDelta("a late reasoning delta");
		await settle();
		reporter.finish();

		expect(broadcasts.every((b) => b.phase === "output")).toBe(true);
		expect(broadcasts.at(-1)).toMatchObject({ outputChars: 3, thinkingChars: 22 });
	});

	test("marks a segment compaction so the right marker is patched", async () => {
		const reporter = makeReporter(true);
		reporter.onTextDelta("x");
		reporter.finish();

		expect(broadcasts.at(-1)).toMatchObject({ isSegment: true });
	});

	test("stops broadcasting after finish()", async () => {
		const reporter = makeReporter();
		reporter.onTextDelta("abc");
		reporter.finish();
		const afterFinish = broadcasts.length;

		reporter.onTextDelta("more");
		reporter.onReasoningDelta("more");
		reporter.finish();
		await settle();

		expect(broadcasts).toHaveLength(afterFinish);
	});

	test("ignores empty deltas", async () => {
		const reporter = makeReporter();
		reporter.onTextDelta("");
		reporter.onReasoningDelta("");
		reporter.finish();
		await settle();

		expect(broadcasts).toHaveLength(0);
	});

	test("reportRetry broadcasts immediately with the current counts", async () => {
		// A retry must not wait out the throttle window: the backoff sleep alone
		// can be 15s, and "0 chars" for that whole span is the exact stall the
		// retry broadcast exists to explain.
		const reporter = makeReporter();
		reporter.reportRetry(1, "provider overloaded");

		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0]).toMatchObject({
			type: "compact_progress",
			messageId: "compact-1",
			phase: "thinking",
			thinkingChars: 0,
			outputChars: 0,
			mode: "blocking",
			retryCount: 1,
			retryError: "provider overloaded",
		});
	});

	test("reportRetry carries the counts streamed so far", async () => {
		const reporter = makeReporter(true);
		reporter.onTextDelta("partial summary");
		reporter.finish();
		broadcasts = [];

		reporter.reportRetry(2, "rate limit exceeded");

		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0]).toMatchObject({
			outputChars: 15,
			isSegment: true,
			retryCount: 2,
			retryError: "rate limit exceeded",
		});
	});
});

describe("compact metadata lookup failure cleanup", () => {
	const narratorId = "n-metadata";
	const validModel = "anthropic:claude-haiku-4-5";
	const originalSummaryModel = settings.agent.summaryModel;
	const originalCatalog = settings.agent.modelCatalog;

	beforeEach(() => {
		cleanDb(sqlite);
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({
				id: narratorId,
				type: "primary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(narratorMessages)
			.values({
				id: "m-metadata",
				narratorId,
				role: "user",
				contentText: "Keep this history",
				contentJson: [{ type: "text", text: "Keep this history" }],
				createdAt: now,
			})
			.run();
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('r-metadata', ?, 'm-metadata', 0)",
			[narratorId],
		);
		// Exercise the real catalog query's empty upstream ID validation, not a
		// fake provider failure or a replacement metadata resolver.
		settings.agent.modelCatalog = {
			schemaVersion: 1,
			migrationVersion: 1,
			local: { revision: 1, models: [] },
			autoApply: false,
			pinnedVersion: null,
		};
		settings.agent.summaryModel = "anthropic:";
	});

	afterEach(() => {
		settings.agent.summaryModel = originalSummaryModel;
		settings.agent.modelCatalog = originalCatalog;
		mock.restore();
	});

	async function assertSettledFailure(isSegment: boolean) {
		const markers = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, narratorId),
		});
		const marker = markers.find((message) => message.id !== "m-metadata");
		expect(marker).toBeDefined();
		const blocks = Array.isArray(marker?.contentJson) ? marker.contentJson : [];
		const detail = isSegment
			? (blocks[0] as { status: string; error?: string })
			: await narratorService.getCompactSummary(narratorId, marker?.id ?? "");
		expect(detail).toMatchObject({ status: "failed" });
		expect(detail?.error).toContain("upstreamModelId");
		const row = await narratorService.getById(narratorId);
		expect(String(row.substatus)).not.toContain("compacting");
		const failed = broadcasts.find((event) => event.type === "compact_failed");
		expect(failed).toMatchObject({ messageId: marker?.id, error: detail?.error });
		// There is no genuine provenance when lookup failed: do not invent fallback.
		expect(failed?.contextWindowSource).toBeUndefined();
		expect(isCompactInProgress(narratorId)).toBe(false);
		expect(cancelCompact(narratorId)).toBe(false);
		if (!isSegment) expect(row.errorMessage).toContain("Compact failed");
		return marker?.id ?? "";
	}

	test("history and failed-marker retry both settle a genuine catalog lookup throw", async () => {
		expect(() => getSummaryModelContextWindowDetail("anthropic:")).toThrow("upstreamModelId");
		const generate = spyOn(narratorContext, "generateCompactSummary").mockResolvedValue({
			summary: "Retained history summary",
		});
		await expect(runCustomCompact(narratorId, "en")).rejects.toThrow("upstreamModelId");
		const markerId = await assertSettledFailure(false);
		expect(generate).not.toHaveBeenCalled();

		broadcasts = [];
		const invalidRetry = await retryFailedCompact(narratorId, "en", markerId, "anthropic:");
		await expect(invalidRetry.promise).rejects.toThrow("upstreamModelId");
		await assertSettledFailure(false);
		expect(generate).not.toHaveBeenCalled();

		broadcasts = [];
		const retry = await retryFailedCompact(narratorId, "en", markerId, validModel, "compact-user");
		await expect(retry.promise).resolves.toBe(true);
		expect(generate.mock.calls[0]?.[4]).toBe(validModel);
		expect(generate.mock.calls[0]?.[9]).toBe("compact-user");
		expect(await narratorService.getCompactSummary(narratorId, retry.messageId)).toMatchObject({
			status: "compacted",
		});
		expect(broadcasts.some((event) => event.type === "compact_done")).toBe(true);
		expect(isCompactInProgress(narratorId)).toBe(false);
	});

	test("segment metadata failure clears its marker and permits the next segment run", async () => {
		const generate = spyOn(narratorContext, "generateCompactSummary").mockResolvedValue({
			summary: "Retained segment summary",
		});
		await expect(runSegmentCompact(narratorId, "en", ["m-metadata"])).rejects.toThrow(
			"upstreamModelId",
		);
		const markerId = await assertSettledFailure(true);
		expect(generate).not.toHaveBeenCalled();
		// Restore the segment's original visibility through its normal undo API.
		await narratorService.deleteSegmentCompact(narratorId, markerId);
		settings.agent.summaryModel = validModel;
		broadcasts = [];
		await runSegmentCompact(narratorId, "en", ["m-metadata"], "compact-user");
		expect(generate.mock.calls[0]?.[9]).toBe("compact-user");
		expect(broadcasts.some((event) => event.type === "compact_done")).toBe(true);
		expect(isCompactInProgress(narratorId)).toBe(false);
	});
});
