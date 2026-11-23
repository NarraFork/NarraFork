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
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { backgroundTasks, narratorMessages, narrators } from "../../db/schema";
import * as workerRead from "../../db/worker-read";
import { narratorTraitsLock } from "../../lib/async-mutex";
import { AppError } from "../../lib/errors";
import { parseTraits } from "../../lib/narrator-utils";
import { delegationRegistration } from "../../lib/validators/runtime-registration";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";
import { captureWorkerRejection } from "./narrator-worker-fixture";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
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
const session = await import("../narrator-session");
const ownership = await import("../agent-runtime/ownership");
const inbox = await import("../agent-runtime/inbox");
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { RESTART_NARRATOR_COLUMNS } = await import("../recovery-observation");
const recovery = await import("../narrator-subagent-recovery");

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

async function seedFailedSubagent(
	id: string,
	traits: string[] = [],
	deliverToolUseId?: string,
): Promise<void> {
	await seedParent();
	const registration = delegationRegistration(PARENT_ID, "general");
	await db.insert(narrators).values({
		id,
		variant: "subagent:general",
		parentNarratorId: PARENT_ID,
		policySourceNarratorId: PARENT_ID,
		runtimeRegistrationJson: deliverToolUseId
			? {
					...registration,
					run: {
						logicalRunId: `run-${id}`,
						deliverTo: { narratorId: PARENT_ID, toolUseId: deliverToolUseId },
					},
				}
			: registration,
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

const releaseOwners: Array<{ release(): unknown }> = [];

afterEach(() => {
	for (const owner of releaseOwners.splice(0)) owner.release();
	mock.restore();
	clearAliasRegistry(PARENT_ID);
});

afterAll(async () => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	await closeRuntimeTestDb(sqlite);
});

describe("recovery Continue placement", () => {
	for (const change of ["parent", "child", "missing-parent", "none"] as const) {
		test(`message and mailbox materialization are atomic with the ${change} observation`, async () => {
			await seedFailedSubagent("continue-child");
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, "continue-child"),
				columns: RESTART_NARRATOR_COLUMNS,
			});
			if (!narrator) throw new Error("Missing child");
			const parent = await db.query.narrators.findFirst({
				where: eq(narrators.id, PARENT_ID),
				columns: { id: true, turnStartedAt: true },
			});
			if (!parent) throw new Error("Missing parent");
			const owner = ownership.tryClaimExecution("continue-child", "tool-replay");
			if (!owner) throw new Error("Missing owner");
			releaseOwners.push(owner);
			createMailboxStore(db).enqueue({
				narratorId: "continue-child",
				kind: "user_input",
				text: "Continue",
				projectedByteSize: 8,
			});
			const row = await inbox.claimInboxHead("continue-child", () => true);
			if (!row) throw new Error("Missing claim");
			if (change === "parent")
				db.update(narrators)
					.set({ turnStartedAt: FAILED_AT })
					.where(eq(narrators.id, PARENT_ID))
					.run();
			if (change === "child")
				db.update(narrators)
					.set({ logicalRunId: "winner" })
					.where(eq(narrators.id, narrator.id))
					.run();
			if (change === "missing-parent") parent.id = "missing-parent";
			const input = {
				claim: inbox.inboxClaim(row),
				narratorId: narrator.id,
				text: "Continue",
				contentBlocks: [{ type: "text", text: "Continue" }],
				recoveryGuard: { narrator, parentTurn: parent },
			};
			const result =
				change === "none"
					? await inbox.persistClaimedUserInput(input)
					: await captureWorkerRejection(inbox.persistClaimedUserInput(input));
			if (change === "none") expect(result).toMatchObject({ contentText: "Continue" });
			else expect(result).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
			expect(
				sqlite.query("SELECT id FROM narrator_messages WHERE narrator_id = ?").all(narrator.id),
			).toHaveLength(change === "none" ? 1 : 0);
			expect(
				sqlite.query("SELECT id FROM narrator_message_refs WHERE narrator_id = ?").all(narrator.id),
			).toHaveLength(change === "none" ? 1 : 0);
			expect(
				sqlite.query("SELECT state FROM narrator_buffered_messages WHERE id = ?").get(row.id),
			).toMatchObject({ state: change === "none" ? "materialized" : "claimed" });
		});
	}
});

describe("markRecoveryOffered", () => {
	test("card admission ignores a metadata timestamp renewal after its Worker snapshot", async () => {
		await seedFailedSubagent("card-renewal", ["background"]);
		const original = workerRead.readQuery;
		let changed = false;
		spyOn(workerRead, "readQuery").mockImplementation((async (query, options) => {
			const rows = await original(query as Parameters<typeof workerRead.readQuery>[0], options);
			if (!changed && query.toSQL().sql.includes('"background_completed_at"')) {
				changed = true;
				db.update(narrators)
					.set({ updatedAt: "2099-01-01T00:00:00.000Z" })
					.where(eq(narrators.id, "card-renewal"))
					.run();
			}
			return rows;
		}) as typeof workerRead.readQuery);
		expect(await persistSubagentRecoveryCard(PARENT_ID)).toBe(true);
		expect(changed).toBe(true);
		expect((await readRow("card-renewal"))?.updatedAt).toBe("2099-01-01T00:00:00.000Z");
	});

	test("a parent turn changed after its Worker snapshot conflicts before inserting a card", async () => {
		await seedFailedSubagent("card-turn-race", ["background"]);
		const original = workerRead.readQueryFirst;
		let changed = false;
		spyOn(workerRead, "readQueryFirst").mockImplementation((async (query, options) => {
			const row = await original(query, options);
			if (!changed) {
				changed = true;
				db.update(narrators)
					.set({ turnStartedAt: new Date(FAILED_AT_MS - 30_000).toISOString() })
					.where(eq(narrators.id, PARENT_ID))
					.run();
			}
			return row;
		}) as typeof workerRead.readQueryFirst);
		const failure = await captureWorkerRejection(persistSubagentRecoveryCard(PARENT_ID));
		expect(changed).toBe(true);
		expect(failure).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
		expect(db.select().from(narratorMessages).all()).toHaveLength(0);
		expect(parseRecoveryOfferedAtMs((await readRow("card-turn-race"))?.traits)).toBeNull();
	});

	test("card first-row reads forward only read budgets and propagate Worker failure", async () => {
		const failure = new Error("card read failed");
		const first = spyOn(workerRead, "readQueryFirst").mockRejectedValue(failure);
		const signal = new AbortController().signal;
		const deadlineAt = Date.now() + 10_000;
		const options = { signal, deadlineAt, timeoutMs: 2_000, ownerNarratorId: PARENT_ID };
		expect(await captureWorkerRejection(persistSubagentRecoveryCard(PARENT_ID, options))).toBe(
			failure,
		);
		expect(first.mock.calls[0]?.[1]).toEqual({
			signal,
			deadlineAt,
			timeoutMs: 2_000,
			executionPolicy: "worker-required",
			maxRows: 1,
		});
	});

	test("empty offers do not dispatch reads and failed Worker reads remain failures", async () => {
		const failure = new Error("watermark Worker unavailable");
		const read = spyOn(workerRead, "readQuery").mockRejectedValue(failure);
		await markRecoveryOffered([]);
		expect(read).not.toHaveBeenCalled();
		const signal = new AbortController().signal;
		const deadlineAt = Date.now() + 10_000;
		const options = { signal, deadlineAt, timeoutMs: 2_000, ownerNarratorId: PARENT_ID };
		expect(
			await captureWorkerRejection(
				markRecoveryOffered([{ id: "missing", failedAtMs: FAILED_AT_MS }], options),
			),
		).toBe(failure);
		expect(read.mock.calls[0]?.[1]).toEqual({
			signal,
			deadlineAt,
			timeoutMs: 2_000,
			executionPolicy: "worker-required",
			maxRows: 100,
		});
	});

	test("a newer offer and unrelated traits committed after the Worker read are preserved", async () => {
		await seedFailedSubagent("sub-offer-race", ["background"]);
		const original = workerRead.readQuery;
		const read = spyOn(workerRead, "readQuery").mockImplementation(((query, options) => {
			return original(query as Parameters<typeof workerRead.readQuery>[0], options).then((rows) => {
				db.update(narrators)
					.set({
						traits: [
							"background",
							"concurrent-trait",
							buildRecoveryOfferedTrait(FAILED_AT_MS + 1_000),
						],
					})
					.where(eq(narrators.id, "sub-offer-race"))
					.run();
				return rows;
			});
		}) as typeof workerRead.readQuery);
		try {
			await markRecoveryOffered([{ id: "sub-offer-race", failedAtMs: FAILED_AT_MS }]);
			expect(read).toHaveBeenCalledTimes(1);
			const row = await readRow("sub-offer-race");
			expect(parseTraits(row?.traits)).toContain("concurrent-trait");
			expect(parseRecoveryOfferedAtMs(row?.traits)).toBe(FAILED_AT_MS + 1_000);
		} finally {
			read.mockRestore();
		}
	});

	test("large offers use bounded batched Worker reads", async () => {
		const read = spyOn(workerRead, "readQuery");
		const entries = Array.from({ length: 205 }, (_, index) => ({
			id: `missing-${index}`,
			failedAtMs: FAILED_AT_MS,
		}));
		await markRecoveryOffered(entries);
		expect(read).toHaveBeenCalledTimes(3);
		for (const [, options] of read.mock.calls) {
			expect(options).toMatchObject({ executionPolicy: "worker-required", maxRows: 100 });
		}
	});

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
	await seedFailedSubagent(id, [`${SUBAGENT_ALIAS_TRAIT_PREFIX}${alias}`], `tool-${id}`);
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
	// Recovery continues the session's own task run through the ordinary entry.
	return spyOn(session, "continueNarrator").mockImplementation(async () => ({
		ok: true,
		terminal: Promise.resolve(),
	}));
}

/** The session each recovery continued, in order. */
function continuedIds(resume: ReturnType<typeof mockSuccessfulResume>): string[] {
	return resume.mock.calls.map(([id]) => id);
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
	for (const mode of ["watch", "notify"] as const) {
		test(`a later conflict preserves card and ${mode} handling for already-started children`, async () => {
			await seedRecoveryCard();
			for (const [id, alias] of [
				["sub-fails", "retry-fails"],
				["sub-works", "retry-works"],
				["sub-no-longer-failed", "retry-third"],
			])
				await seedRecoverableSubagent(id, alias);
			const resume = spyOn(session, "continueNarrator").mockImplementation(async () => {
				db.update(narrators)
					.set({ logicalRunId: "winner" })
					.where(eq(narrators.id, "sub-works"))
					.run();
				return { ok: true, terminal: Promise.resolve() };
			});
			const watch = spyOn(recovery, "startRecoveryWatchBatch").mockResolvedValue({
				messageId: "watch",
				toolUseIds: [],
			});
			const send = spyOn(session, "sendMessage").mockResolvedValue(
				{} as Awaited<ReturnType<typeof session.sendMessage>>,
			);
			const { narratorRoutes } = await import("../../routes/narrators");
			const app = new Hono();
			app.use("*", async (c, next) => {
				c.set("user", { sub: "human", role: "admin", iat: 0, exp: 2_147_483_647 });
				await next();
			});
			app.onError(
				(error) =>
					new Response(
						JSON.stringify({ code: error instanceof AppError ? error.code : "UNKNOWN" }),
						{ status: error instanceof AppError ? error.statusCode : 500 },
					),
			);
			app.route("/narrators", narratorRoutes);
			const response = await app.request(`/narrators/${PARENT_ID}/subagent-recovery`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					messageId: CARD_ID,
					subagentIds: CARD_ENTRIES.map((entry) => entry.id),
					mode,
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ code: "RUNTIME_READ_CONFLICT" });
			expect(resume).toHaveBeenCalledTimes(1);
			expect((await readBackgroundTask("sub-fails"))?.status).toBe("running");
			expect(await readBackgroundTask("sub-works")).toBeUndefined();
			expect(await readBackgroundTask("sub-no-longer-failed")).toBeUndefined();
			const card = await readRecoveryCard();
			expect(card).toMatchObject({ status: "pending", resumedCount: 1, mode });
			expect(card.subagents).toEqual(CARD_ENTRIES.slice(1));
			if (mode === "watch") {
				expect(watch).toHaveBeenCalledTimes(1);
				expect(watch.mock.calls[0]?.[0].aliases).toEqual(["retry-fails"]);
				expect(send).not.toHaveBeenCalled();
			} else {
				expect(send).toHaveBeenCalledTimes(1);
				expect(send.mock.calls[0]?.[1]).toContain("retry-fails");
				expect(watch).not.toHaveBeenCalled();
			}
		});
	}

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
		expect(continuedIds(resume)).toEqual(["sub-works"]);
		expect((await readBackgroundTask("sub-works"))?.alias).toBe("retry-works");
		await expectFailedBackgroundTask("sub-fails", "initialization failed after task creation");
	});

	for (const existingStatus of [undefined, "failed", "running"] as const) {
		test(`continues after resume throws and fails the ${existingStatus ?? "new"} task row`, async () => {
			await seedRecoverableSubagent("sub-fails", "retry-fails");
			await seedRecoverableSubagent("sub-works", "retry-works");
			if (existingStatus) {
				// Real task creation reserves exact logical-run publication slots; a raw
				// insert without run identity is inadmissible after the legacy cutoff.
				await backgroundTaskService.createAgentTask({
					id: "sub-fails",
					subagentNarratorId: "sub-fails",
					subagentType: "general",
					alias: "retry-fails",
					binding: {
						deliverTo: { narratorId: PARENT_ID, toolUseId: "tool-sub-fails" },
					},
				});
				if (existingStatus === "failed") {
					await backgroundTaskService.markFailed("sub-fails", "Previous failure");
				}
				expect((await readBackgroundTask("sub-fails"))?.logicalRunId).toBeTruthy();
				expect((await readBackgroundTask("sub-fails"))?.status).toBe(existingStatus);
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
			expect(continuedIds(resume)).toEqual(resumeInput.subagentIds);
			// The same task run continues (never a fresh one): its result lands on the task
			// row, and the historical Agent tool result stays untouched.
			const task = await readBackgroundTask("sub-works");
			expect(resume.mock.calls.at(-1)?.[0]).toBe("sub-works");
			expect(resume.mock.calls.at(-1)?.[4]).toEqual({
				cancelSignal: undefined,
				parentRecoveryTurn: {
					id: PARENT_ID,
					turnStartedAt: new Date(FAILED_AT_MS - 120_000).toISOString(),
				},
				recoveryObservation: expect.objectContaining({
					id: "sub-works",
					logicalRunId: task?.logicalRunId,
					status: "idle",
				}),
				resumeRunId: task?.logicalRunId ?? undefined,
				recovered: true,
			});
			expect(task?.logicalRunId).toBeTruthy();
			expect((await readBackgroundTask("sub-works"))?.status).toBe("running");
			await expectFailedBackgroundTask("sub-fails", "resume initialization failed");
		});
	}

	test("a resume that does not start also leaves no running task and does not block siblings", async () => {
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await seedRecoverableSubagent("sub-works", "retry-works");
		const resume = mockSuccessfulResume();
		resume.mockResolvedValueOnce({ ok: false });

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
		// Another execution already owns the session (e.g. a manual continue in flight).
		const owner = ownership.tryClaimExecution("sub-fails", "run");
		if (!owner) throw new Error("Missing test execution owner");
		releaseOwners.push(owner);

		const result = await resumeRecoverySubagents(resumeInput);

		expect(result).toEqual({
			resumed: ["retry-works"],
			skipped: [{ id: "sub-fails", reason: "already_resuming" }],
		});
		expect(continuedIds(resume)).toEqual(["sub-works"]);
		expect(await readBackgroundTask("sub-fails")).toEqual(before);
	});

	test("does not compensate a concurrent resume that acquired ownership during preparation", async () => {
		await seedRecoverableSubagent("sub-fails", "retry-fails");
		await seedRecoverableSubagent("sub-works", "retry-works");
		const resume = mockSuccessfulResume();
		resume.mockImplementationOnce(async () => {
			// A concurrent continuation claimed the session after preparation; this
			// attempt is refused and must not settle the task that run now owns.
			const owner = ownership.tryClaimExecution("sub-fails", "run");
			if (owner) releaseOwners.push(owner);
			return { ok: false };
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
			expect(continuedIds(resume)).toEqual(["sub-works"]);
			expect(await readBackgroundTask("sub-fails")).toBeUndefined();
			expect(await db.query.narrators.findFirst({ where: eq(narrators.id, "sub-fails") })).toEqual(
				before,
			);
		});
	}
});

describe("recovery admission uses the parent's latest turn", () => {
	test("resume batches missing target metadata and tasks and preserves only the read budget", async () => {
		await seedParent();
		const original = workerRead.readQuery;
		const budget = {
			signal: new AbortController().signal,
			deadlineAt: Date.now() + 10_000,
			timeoutMs: 2_000,
		};
		const read = spyOn(workerRead, "readQuery").mockImplementation((async (query, options) => {
			expect(options).toEqual({
				...budget,
				executionPolicy: "worker-required",
				maxRows: options?.maxRows,
			});
			return original(query as Parameters<typeof workerRead.readQuery>[0], options);
		}) as typeof workerRead.readQuery);
		const result = await resumeRecoverySubagents({
			...resumeInput,
			...budget,
			subagentIds: Array.from({ length: 150 }, (_, i) => `missing-${i}`),
		});
		expect(read.mock.calls.map((call) => call[1]?.maxRows)).toEqual([
			1, 1_000, 1_000, 1_000, 1_000,
		]);
		expect(result.resumed).toEqual([]);
		expect(result.skipped).toHaveLength(150);
	});

	for (const change of ["parent", "subagent"] as const) {
		test(`a ${change} changed after the batched Worker reads conflicts before task admission`, async () => {
			await seedRecoverableSubagent("sub-fails", "retry-fails");
			const resume = mockSuccessfulResume();
			const original = backgroundTaskService.createAgentTask.bind(backgroundTaskService);
			spyOn(backgroundTaskService, "createAgentTask").mockImplementation(async (input) => {
				if (change === "parent")
					db.update(narrators)
						.set({ turnStartedAt: FAILED_AT })
						.where(eq(narrators.id, PARENT_ID))
						.run();
				else
					db.update(narrators).set({ substatus: "[]" }).where(eq(narrators.id, "sub-fails")).run();
				return original(input);
			});
			expect(
				await captureWorkerRejection(
					resumeRecoverySubagents({ ...resumeInput, subagentIds: ["sub-fails"] }),
				),
			).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
			expect(resume).not.toHaveBeenCalled();
			expect(await readBackgroundTask("sub-fails")).toBeUndefined();
		});
	}

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
		expect(continuedIds(resume)).toEqual(["sub-works"]);
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
			mode: "watch" as const,
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
				mode: "watch" as const,
				resumedAliases: ["retry-works"],
				...(retrySubagentIds ? { retrySubagentIds } : {}),
			};

			await markRecoveryCardResolved(input);

			expect(await readRecoveryCard()).toMatchObject({
				status: "resolved",
				mode: "watch",
				resumedCount: 1,
			});
		});
	}
});
