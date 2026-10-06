/**
 * DB-level guards for the recovery-card "already offered" watermark.
 *
 * Two invariants the pure-function tests cannot cover:
 *
 * 1. **`updatedAt` is never advanced.** Offering recovery is bookkeeping, not a new
 *    subagent run. Keep the original timestamp for the SQL prefilter and old clients;
 *    failure selection itself now uses durable run timing, never metadata writes.
 *
 * 2. **The read-modify-write is serialized through `narratorTraitsLock`.** `traits` is a
 *    whole-column JSON array, so an unlocked watermark write racing a concurrent trait
 *    write (a user editing this subagent's disabled-tools) silently drops one of them.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { backgroundTasks, narratorMessages, narrators } from "../../db/schema";
import { narratorTraitsLock } from "../../lib/async-mutex";
import { parseTraits } from "../../lib/narrator-utils";

const { db, sqlite } = getTestDb();
// Snapshot the real db module before mocking: Bun's mock.module is process-wide and
// mock.restore() does not undo it, so this FTS-less test db would otherwise leak into
// later real-db suites.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const {
	buildRecoveryOfferedTrait,
	markRecoveryCardResolved,
	markRecoveryOffered,
	parseRecoveryOfferedAtMs,
	persistSubagentRecoveryCard,
	resumeRecoverySubagents,
} = await import("../narrator-subagent-recovery");
const { backgroundTaskService } = await import("../background-task-service");
const { clearAliasRegistry, SUBAGENT_ALIAS_TRAIT_PREFIX } = await import("../subagent-alias");
const subagentResume = await import("../subagent-resume");

const FAILED_AT_MS = Date.parse("2026-04-01T02:00:00.000Z");
const FAILED_AT = new Date(FAILED_AT_MS).toISOString();

const PARENT_ID = "parent-1";

async function seedParent(): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({
			id: PARENT_ID,
			variant: "primary",
			turnStartedAt: new Date(FAILED_AT_MS - 120_000).toISOString(),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({ target: narrators.id });
}

async function seedFailedSubagent(id: string, traits: string[] = []): Promise<void> {
	await seedParent();
	await db.insert(narrators).values({
		id,
		variant: "subagent:general",
		parentNarratorId: PARENT_ID,
		status: "idle",
		substatus: JSON.stringify(["error", `turn_pause_started_ms:${FAILED_AT_MS}`]),
		traits,
		createdAt: new Date(FAILED_AT_MS - 60_000).toISOString(),
		updatedAt: FAILED_AT,
	});
}

async function readRow(id: string) {
	return db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { traits: true, updatedAt: true },
	});
}

beforeEach(() => cleanDb(sqlite));

afterEach(() => {
	mock.restore();
	clearAliasRegistry(PARENT_ID);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("markRecoveryOffered", () => {
	test("stamps the watermark without advancing updatedAt", async () => {
		await seedFailedSubagent("sub-1");

		await markRecoveryOffered([{ id: "sub-1", failedAtMs: FAILED_AT_MS }]);

		const row = await readRow("sub-1");
		expect(parseRecoveryOfferedAtMs(row?.traits)).toBe(FAILED_AT_MS);
		// The load-bearing assertion: the recorded failure time must still be the failure,
		// not the offer. If this drifts, the watermark suppresses nothing.
		expect(row?.updatedAt).toBe(FAILED_AT);
	});

	test("keeps unrelated traits and replaces an older watermark", async () => {
		await seedFailedSubagent("sub-2", [
			"background",
			"custom-disabled-tools:abc",
			buildRecoveryOfferedTrait(FAILED_AT_MS - 60_000),
		]);

		await markRecoveryOffered([{ id: "sub-2", failedAtMs: FAILED_AT_MS }]);

		const row = await readRow("sub-2");
		const traits = parseTraits(row?.traits);
		expect(traits).toContain("background");
		expect(traits).toContain("custom-disabled-tools:abc");
		expect(parseRecoveryOfferedAtMs(traits)).toBe(FAILED_AT_MS);
		expect(row?.updatedAt).toBe(FAILED_AT);
	});

	test("skips entries with no usable failure time and unknown rows", async () => {
		await seedFailedSubagent("sub-3");

		await markRecoveryOffered([
			{ id: "sub-3", failedAtMs: null },
			{ id: "does-not-exist", failedAtMs: FAILED_AT_MS },
		]);

		const row = await readRow("sub-3");
		expect(parseRecoveryOfferedAtMs(row?.traits)).toBeNull();
		expect(row?.updatedAt).toBe(FAILED_AT);
	});

	test("writes nothing when the row is already watermarked at this failure", async () => {
		await seedFailedSubagent("sub-4", [buildRecoveryOfferedTrait(FAILED_AT_MS)]);

		await markRecoveryOffered([{ id: "sub-4", failedAtMs: FAILED_AT_MS }]);

		const row = await readRow("sub-4");
		expect(parseTraits(row?.traits)).toEqual([buildRecoveryOfferedTrait(FAILED_AT_MS)]);
		expect(row?.updatedAt).toBe(FAILED_AT);
	});

	// Control case: proves the scenario below is genuinely lock-sensitive rather than
	// passing by accident of timing. This models what the watermark write used to do —
	// read traits, then write them back with no lock — against the same interleaving, and
	// shows the concurrent trait write is lost wholesale.
	test("an UNLOCKED read-modify-write does lose the concurrent write (why the lock matters)", async () => {
		await seedFailedSubagent("sub-race", ["background"]);

		const unlockedWatermark = (async () => {
			const stale = await readRow("sub-race");
			// The lock-less path reads here and writes after the other side has committed.
			await new Promise((resolve) => setTimeout(resolve, 20));
			await db
				.update(narrators)
				.set({ traits: [...parseTraits(stale?.traits), buildRecoveryOfferedTrait(FAILED_AT_MS)] })
				.where(eq(narrators.id, "sub-race"));
		})();

		const concurrentTraitWrite = (async () => {
			const current = await readRow("sub-race");
			await db
				.update(narrators)
				.set({ traits: [...parseTraits(current?.traits), "custom-disabled-tools:xyz"] })
				.where(eq(narrators.id, "sub-race"));
		})();

		await Promise.all([unlockedWatermark, concurrentTraitWrite]);

		const traits = parseTraits((await readRow("sub-race"))?.traits);
		expect(parseRecoveryOfferedAtMs(traits)).toBe(FAILED_AT_MS);
		// The user's edit is gone — exactly the silent data loss the lock prevents.
		expect(traits).not.toContain("custom-disabled-tools:xyz");
	});

	// Without the lock this loses one of the two writes: both sides read the same traits
	// array and the later write overwrites the earlier one wholesale.
	test("does not clobber a concurrent trait write held under narratorTraitsLock", async () => {
		await seedFailedSubagent("sub-5", ["background"]);

		// Hold the lock the way routes/narrators' updateNarratorTraits does, and only
		// release it after markRecoveryOffered has started, so the watermark write must
		// queue behind this read-modify-write rather than racing it.
		let releaseHolder!: () => void;
		const holderCanFinish = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holder = narratorTraitsLock.acquire("sub-5", async () => {
			const current = await readRow("sub-5");
			await holderCanFinish;
			await db
				.update(narrators)
				.set({ traits: [...parseTraits(current?.traits), "custom-disabled-tools:xyz"] })
				.where(eq(narrators.id, "sub-5"));
		});

		const watermarking = markRecoveryOffered([{ id: "sub-5", failedAtMs: FAILED_AT_MS }]);
		// Give the watermark path a chance to reach the lock before the holder releases.
		await new Promise((resolve) => setTimeout(resolve, 10));
		releaseHolder();
		await Promise.all([holder, watermarking]);

		const traits = parseTraits((await readRow("sub-5"))?.traits);
		expect(traits).toContain("background");
		expect(traits).toContain("custom-disabled-tools:xyz");
		expect(parseRecoveryOfferedAtMs(traits)).toBe(FAILED_AT_MS);
	});
});

async function seedRecoverableSubagent(id: string, alias: string): Promise<void> {
	await seedFailedSubagent(id, [`${SUBAGENT_ALIAS_TRAIT_PREFIX}${alias}`]);
	await db.insert(narratorMessages).values({
		id: `${id}-origin`,
		narratorId: id,
		role: "user",
		parentToolUseId: `tool-${id}`,
		contentJson: [{ type: "text", text: "Original subagent task" }],
		createdAt: FAILED_AT,
	});
}

function mockSuccessfulResume() {
	// Keep alias registration and all DB transitions real, but never start an agent loop.
	return spyOn(subagentResume, "resumeSubagent").mockImplementation(async ({ subagentId }) => ({
		started: true,
		resumedSuspendedRunner: false,
		originToolUseId: `tool-${subagentId}`,
	}));
}

async function readBackgroundTask(id: string) {
	return db.query.backgroundTasks.findFirst({ where: eq(backgroundTasks.id, id) });
}

async function expectFailedBackgroundTask(id: string, error: string) {
	const task = await readBackgroundTask(id);
	expect(task?.status).toBe("failed");
	expect(task?.output).toContain(error);
	expect(task?.completedAt).toBeTruthy();
	const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
	expect(narrator?.backgroundStatus).not.toBe("running");
}

const resumeInput = {
	narratorId: PARENT_ID,
	subagentIds: ["sub-fails", "sub-works"],
	locale: "en" as const,
};

describe("resumeRecoverySubagents DB recovery", () => {
	test("continues after initialization throws and fails its already-created task row", async () => {
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await seedRecoverableSubagent("sub-works", "retry-works");
		const resume = mockSuccessfulResume();
		const createAgentTask = backgroundTaskService.createAgentTask.bind(backgroundTaskService);
		spyOn(backgroundTaskService, "createAgentTask").mockImplementation(async (input) => {
			const task = await createAgentTask(input);
			if (input.id === "sub-fails") throw new Error("initialization failed after task creation");
			return task;
		});

		const result = await resumeRecoverySubagents(resumeInput);

		expect(result).toEqual({
			resumed: ["retry-works"],
			skipped: [{ id: "sub-fails", reason: "initialization failed after task creation" }],
		});
		expect(resume.mock.calls.map(([input]) => input.subagentId)).toEqual(["sub-works"]);
		expect((await readBackgroundTask("sub-works"))?.alias).toBe("retry-works");
		await expectFailedBackgroundTask("sub-fails", "initialization failed after task creation");
	});

	for (const existingStatus of [undefined, "failed", "running"] as const) {
		test(`continues after resume throws and fails the ${existingStatus ?? "new"} task row`, async () => {
			await seedRecoverableSubagent("sub-fails", "retry-fails");
			await seedRecoverableSubagent("sub-works", "retry-works");
			if (existingStatus) {
				await db.insert(backgroundTasks).values({
					id: "sub-fails",
					parentNarratorId: PARENT_ID,
					type: "agent",
					status: existingStatus,
					subagentNarratorId: "sub-fails",
					alias: "retry-fails",
					output: existingStatus === "failed" ? "Previous failure" : null,
					startedAt: FAILED_AT,
					completedAt: existingStatus === "failed" ? FAILED_AT : null,
					createdAt: FAILED_AT,
					updatedAt: FAILED_AT,
				});
			}
			const resume = mockSuccessfulResume();
			resume.mockImplementationOnce(async () => {
				throw new Error("resume initialization failed");
			});

			const result = await resumeRecoverySubagents(resumeInput);

			expect(result).toEqual({
				resumed: ["retry-works"],
				skipped: [{ id: "sub-fails", reason: "resume initialization failed" }],
			});
			expect(resume.mock.calls.map(([input]) => input.subagentId)).toEqual(resumeInput.subagentIds);
			expect(resume).toHaveBeenLastCalledWith(
				expect.objectContaining({
					subagentId: "sub-works",
					preserveBackground: true,
					skipConclusionDelivery: true,
				}),
			);
			expect((await readBackgroundTask("sub-works"))?.status).toBe("running");
			await expectFailedBackgroundTask("sub-fails", "resume initialization failed");
		});
	}

	test("a resume that does not start also leaves no running task and does not block siblings", async () => {
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await seedRecoverableSubagent("sub-works", "retry-works");
		const resume = mockSuccessfulResume();
		resume.mockResolvedValueOnce({
			started: false,
			resumedSuspendedRunner: false,
			originToolUseId: "tool-sub-fails",
		});

		const result = await resumeRecoverySubagents(resumeInput);

		expect(result).toEqual({
			resumed: ["retry-works"],
			skipped: [{ id: "sub-fails", reason: "resume_not_started" }],
		});
		expect(resume).toHaveBeenCalledTimes(2);
		expect((await readBackgroundTask("sub-fails"))?.status).toBe("failed");
		const failed = await db.query.narrators.findFirst({ where: eq(narrators.id, "sub-fails") });
		expect(failed?.backgroundStatus).not.toBe("running");
	});

	test("does not restart or fail a task owned by an already-active resume", async () => {
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await seedRecoverableSubagent("sub-works", "retry-works");
		await db.insert(backgroundTasks).values({
			id: "sub-fails",
			parentNarratorId: PARENT_ID,
			type: "agent",
			status: "running",
			subagentNarratorId: "sub-fails",
			alias: "retry-fails",
			startedAt: FAILED_AT,
			createdAt: FAILED_AT,
			updatedAt: FAILED_AT,
		});
		const before = await readBackgroundTask("sub-fails");
		const resume = mockSuccessfulResume();
		spyOn(subagentResume, "hasActiveSubagentResumeRun").mockImplementation(
			(id) => id === "sub-fails",
		);

		const result = await resumeRecoverySubagents(resumeInput);

		expect(result).toEqual({
			resumed: ["retry-works"],
			skipped: [{ id: "sub-fails", reason: "already_resuming" }],
		});
		expect(resume.mock.calls.map(([input]) => input.subagentId)).toEqual(["sub-works"]);
		expect(await readBackgroundTask("sub-fails")).toEqual(before);
	});

	test("does not compensate a concurrent resume that acquired ownership during preparation", async () => {
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await seedRecoverableSubagent("sub-works", "retry-works");
		let active = false;
		spyOn(subagentResume, "hasActiveSubagentResumeRun").mockImplementation(
			(id) => id === "sub-fails" && active,
		);
		const resume = mockSuccessfulResume();
		resume.mockImplementationOnce(async () => {
			active = true;
			throw new Error("Subagent already has an active resumed run");
		});

		const result = await resumeRecoverySubagents(resumeInput);

		expect(result.resumed).toEqual(["retry-works"]);
		expect((await readBackgroundTask("sub-fails"))?.status).toBe("running");
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "sub-fails") });
		expect(narrator?.backgroundStatus).toBe("running");
	});

	for (const substatus of ["[]", JSON.stringify(["interrupted"])]) {
		test(`skips idle children without an error tag (${substatus}) without mutating them`, async () => {
			await seedRecoverableSubagent("sub-fails", "retry-fails");
			await seedRecoverableSubagent("sub-works", "retry-works");
			await db.update(narrators).set({ substatus }).where(eq(narrators.id, "sub-fails"));
			const before = await db.query.narrators.findFirst({ where: eq(narrators.id, "sub-fails") });
			const resume = mockSuccessfulResume();

			const result = await resumeRecoverySubagents(resumeInput);

			expect(result).toEqual({
				resumed: ["retry-works"],
				skipped: [{ id: "sub-fails", reason: "no_longer_failed" }],
			});
			expect(resume.mock.calls.map(([input]) => input.subagentId)).toEqual(["sub-works"]);
			expect(await readBackgroundTask("sub-fails")).toBeUndefined();
			expect(await db.query.narrators.findFirst({ where: eq(narrators.id, "sub-fails") })).toEqual(
				before,
			);
		});
	}
});

describe("recovery admission uses the parent's latest turn", () => {
	test("an old card cannot restart a failure preceding the new parent turn", async () => {
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await seedRecoverableSubagent("sub-works", "retry-works");
		await db.update(narrators).set({ turnStartedAt: FAILED_AT }).where(eq(narrators.id, PARENT_ID));
		await db
			.update(narrators)
			.set({
				substatus: JSON.stringify(["error", `turn_pause_started_ms:${FAILED_AT_MS - 1}`]),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, "sub-fails"));
		const resume = mockSuccessfulResume();

		expect(await resumeRecoverySubagents(resumeInput)).toEqual({
			resumed: ["retry-works"],
			skipped: [{ id: "sub-fails", reason: "failure_outside_latest_turn" }],
		});
		expect(resume.mock.calls.map(([input]) => input.subagentId)).toEqual(["sub-works"]);
		expect(await readBackgroundTask("sub-fails")).toBeUndefined();
	});

	for (const turnStartedAt of [null, "not-a-date"]) {
		test(`unknown parent turn (${turnStartedAt}) refuses both offering and execution`, async () => {
			await seedRecoverableSubagent("sub-fails", "retry-fails");
			await db.update(narrators).set({ turnStartedAt }).where(eq(narrators.id, PARENT_ID));
			const resume = mockSuccessfulResume();
			expect(await persistSubagentRecoveryCard(PARENT_ID)).toBe(false);
			expect(await resumeRecoverySubagents({ ...resumeInput, subagentIds: ["sub-fails"] })).toEqual(
				{
					resumed: [],
					skipped: [{ id: "sub-fails", reason: "failure_outside_latest_turn" }],
				},
			);
			expect(resume).not.toHaveBeenCalled();
			expect(await readBackgroundTask("sub-fails")).toBeUndefined();
		});
	}

	test("recent metadata and run start without failure evidence cannot authorize recovery", async () => {
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await db
			.update(narrators)
			.set({
				substatus: JSON.stringify(["error"]),
				createdAt: FAILED_AT,
				turnStartedAt: FAILED_AT,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, "sub-fails"));
		const resume = mockSuccessfulResume();
		expect(await persistSubagentRecoveryCard(PARENT_ID)).toBe(false);
		const result = await resumeRecoverySubagents({ ...resumeInput, subagentIds: ["sub-fails"] });
		expect(result.resumed).toEqual([]);
		expect(resume).not.toHaveBeenCalled();
	});

	test("a long parent turn still offers a failure older than 24 hours, irrespective of spawn time", async () => {
		const nowMs = Date.now();
		const turnMs = nowMs - 48 * 60 * 60 * 1000;
		const failureMs = nowMs - 30 * 60 * 60 * 1000;
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await db
			.update(narrators)
			.set({ turnStartedAt: new Date(turnMs).toISOString() })
			.where(eq(narrators.id, PARENT_ID));
		await db
			.update(narrators)
			.set({
				substatus: JSON.stringify(["error", `turn_pause_started_ms:${failureMs}`]),
				createdAt: new Date(turnMs - 60_000).toISOString(),
				updatedAt: new Date(failureMs).toISOString(),
			})
			.where(eq(narrators.id, "sub-fails"));
		expect(await persistSubagentRecoveryCard(PARENT_ID)).toBe(true);
		mockSuccessfulResume();
		// The offer watermark suppresses duplicate cards, not an authorized click.
		const result = await resumeRecoverySubagents({ ...resumeInput, subagentIds: ["sub-fails"] });
		expect(result.resumed).toEqual(["retry-fails"]);
	});
});

const CARD_ID = "recovery-card";
const CARD_ENTRIES = ["sub-fails", "sub-works", "sub-no-longer-failed"].map((id) => ({
	id,
	title: `Task ${id}`,
	subagentType: "general",
	errorMessage: "Original failure",
	createdAt: FAILED_AT,
	wasForeground: true,
}));
const CARD_TEXT_BLOCK = { type: "text", text: "Recovery context must be preserved" };

async function seedRecoveryCard() {
	await seedParent();
	await db.insert(narratorMessages).values({
		id: CARD_ID,
		narratorId: PARENT_ID,
		role: "disp",
		contentJson: [
			CARD_TEXT_BLOCK,
			{ type: "subagent_recovery", status: "pending", subagents: CARD_ENTRIES },
		],
		createdAt: FAILED_AT,
	});
}

async function readRecoveryCard() {
	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, CARD_ID),
	});
	expect(Array.isArray(message?.contentJson)).toBe(true);
	const blocks = message?.contentJson as Array<Record<string, unknown>>;
	expect(blocks[0]).toEqual(CARD_TEXT_BLOCK);
	return blocks[1];
}

describe("markRecoveryCardResolved DB retry state", () => {
	test("retains only failed retry entries after partial success and resolves on the next success", async () => {
		await seedRecoveryCard();
		const partial = {
			narratorId: PARENT_ID,
			messageId: CARD_ID,
			mode: "notify" as const,
			resumedAliases: ["retry-works"],
			retrySubagentIds: ["sub-fails"],
		};
		await markRecoveryCardResolved(partial);

		const pending = await readRecoveryCard();
		expect(pending.status).toBe("pending");
		expect(pending.subagents).toEqual([CARD_ENTRIES[0]]);

		await markRecoveryCardResolved({
			...partial,
			resumedAliases: ["retry-fails"],
			retrySubagentIds: [],
		});
		expect(await readRecoveryCard()).toMatchObject({
			status: "resolved",
			mode: "notify",
			resumedCount: 2,
		});
		const parent = await db.query.narrators.findFirst({ where: eq(narrators.id, PARENT_ID) });
		expect(parent?.messageVersion).toBe(2);
	});

	test("all failed retries stay pending instead of reporting zero successful recoveries", async () => {
		await seedRecoveryCard();
		const input = {
			narratorId: PARENT_ID,
			messageId: CARD_ID,
			mode: "await" as const,
			resumedAliases: [],
			retrySubagentIds: CARD_ENTRIES.map((entry) => entry.id),
		};

		await markRecoveryCardResolved(input);

		const card = await readRecoveryCard();
		expect(card.status).toBe("pending");
		expect(card.subagents).toEqual(CARD_ENTRIES);
	});

	for (const retrySubagentIds of [undefined, []]) {
		test(`resolves when retry ids are ${retrySubagentIds ? "empty" : "omitted"}`, async () => {
			await seedRecoveryCard();
			const input = {
				narratorId: PARENT_ID,
				messageId: CARD_ID,
				mode: "await" as const,
				resumedAliases: ["retry-works"],
				...(retrySubagentIds ? { retrySubagentIds } : {}),
			};

			await markRecoveryCardResolved(input);

			expect(await readRecoveryCard()).toMatchObject({
				status: "resolved",
				mode: "await",
				resumedCount: 1,
			});
		});
	}
});
