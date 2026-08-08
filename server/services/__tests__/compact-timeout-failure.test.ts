/**
 * compact-timeout-failure.test.ts — a watchdog timeout must land as a FAILED
 * compact, not as a user cancellation.
 *
 * Both arrive as an `AbortError`, and the cancel path is deliberately silent: it
 * deletes the `[Compacting]` marker, broadcasts `compact_done`, and leaves the
 * narrator idle without an error. Reusing that path for a timeout would tell the
 * user their compact simply vanished, and a BLOCKING run would carry on believing
 * the context had shrunk — straight into the next overflow.
 *
 * So a timeout keeps the marker as `failed` with the timeout reason, broadcasts
 * `compact_failed`, and (blocking only) marks the narrator errored. A real user
 * cancel must keep its silent rollback.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { chapters, narratorMessages, narrators, projects } from "../../db/schema";

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

const { narratorService } = await import("../narrator-service");
const { narratorContext } = await import("../narrator-context");
const {
	__setCompactWatchdogTimingsForTests,
	cancelCompact,
	compactLocks,
	CompactTimeoutError,
	runCustomCompact,
} = await import("../narrator-compact");

const realGenerateCompactSummary = narratorContext.generateCompactSummary.bind(narratorContext);
const NARRATOR_ID = "n-timeout";

/** A summary request that never resolves on its own but honors its AbortSignal. */
function stubSummaryHangingUntilAborted(onStart: () => void): void {
	narratorContext.generateCompactSummary = (
		_narratorId,
		_locale,
		_messages,
		_pruneBoundaryMessageId,
		signal,
	) => {
		onStart();
		return new Promise((_resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException("Compact summary aborted", "AbortError"));
				return;
			}
			signal?.addEventListener(
				"abort",
				() => reject(new DOMException("Compact summary aborted", "AbortError")),
				{ once: true },
			);
		});
	};
}

function seed(): void {
	const now = new Date().toISOString();
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			title: "Chapter",
			branch: "chapter/ch1",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values({
			id: NARRATOR_ID,
			chapterId: "ch1",
			type: "primary",
			inheritMode: "fresh",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: "m-before",
			narratorId: NARRATOR_ID,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
			contentText: "before",
			createdAt: now,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: "m-target",
			narratorId: NARRATOR_ID,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
			contentText: "target",
			createdAt: now,
		})
		.run();
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('r1', ?, 'm-before', 0), ('r2', ?, 'm-target', 1)",
		[NARRATOR_ID, NARRATOR_ID],
	);
}

async function readMarker() {
	return db.query.narratorMessages.findFirst({
		where: and(eq(narratorMessages.narratorId, NARRATOR_ID), eq(narratorMessages.role, "system")),
	});
}

beforeEach(() => {
	cleanDb(sqlite);
	compactLocks.clear();
	broadcasts = [];
	__setCompactWatchdogTimingsForTests(null);
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
});

afterAll(() => {
	__setCompactWatchdogTimingsForTests(null);
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
});

describe("watchdog timeout is a compact failure", () => {
	test("keeps the marker as failed with the timeout reason and reports compact_failed", async () => {
		seed();
		// Short stall window so the hung request trips the watchdog, not the ceiling.
		__setCompactWatchdogTimingsForTests({ stallMs: 120, maxTotalMs: 60_000 });
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		stubSummaryHangingUntilAborted(started);

		const promise = runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "blocking" });
		await requestStarted;

		await expect(promise).rejects.toBeInstanceOf(CompactTimeoutError);
		await expect(promise).rejects.toThrow(/no progress/);

		// The marker survives as a failed compact carrying the timeout reason — the
		// cancel path would have deleted it outright.
		const marker = await readMarker();
		expect(marker).toBeDefined();
		const detail = await narratorService.getCompactSummary(NARRATOR_ID, marker?.id ?? "");
		expect(detail).toMatchObject({ status: "failed" });
		expect(String(detail?.error)).toContain("no progress");
		expect(String(detail?.error)).not.toBe("Compact cancelled");

		expect(broadcasts.some((e) => e.type === "compact_failed")).toBe(true);

		// Blocking failure must surface on the narrator, so the turn cannot continue
		// as though the context had shrunk.
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, NARRATOR_ID) });
		expect(String(row?.errorMessage)).toContain("Compact failed");

		// The lock is released only after the aborted run settled.
		expect(compactLocks.has(NARRATOR_ID)).toBe(false);
	});

	test("a user cancel keeps its silent rollback", async () => {
		seed();
		// Ceiling and stall both far away: only the explicit cancel can end this run.
		__setCompactWatchdogTimingsForTests({ stallMs: 60_000, maxTotalMs: 60_000 });
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		stubSummaryHangingUntilAborted(started);

		const promise = runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "blocking" });
		await requestStarted;
		expect(cancelCompact(NARRATOR_ID)).toBe(true);

		await expect(promise).rejects.toMatchObject({ name: "AbortError" });

		// Marker removed, completion (not failure) broadcast, no error recorded.
		expect(await readMarker()).toBeUndefined();
		expect(broadcasts.some((e) => e.type === "compact_failed")).toBe(false);
		expect(broadcasts.some((e) => e.type === "compact_done")).toBe(true);
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, NARRATOR_ID) });
		expect(row?.errorMessage ?? null).toBeNull();
		expect(compactLocks.has(NARRATOR_ID)).toBe(false);
	});
});
