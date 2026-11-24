/**
 * Two-way reconciliation between a narrator's DB status and its in-memory runtime.
 *
 * The regression pinned here: a subagent's permission gate mirrored `working` /
 * `waiting` onto its PARENT (the gate's WS broadcast target). Because a narrator's
 * status row is owned by its own turn, that write resurrected parents whose loop had
 * already ended with an error. The zombie status then outlived every runtime owner,
 * and every admission check keyed on DB status rejected the user forever:
 * `/continue` and `/subagent-recovery` both answered "already running" while the
 * recovery card sat right there, unusable. `reconcileRunningStatus` could not help —
 * it only ever corrected the opposite direction (idle → working).
 *
 * So two properties are asserted:
 * 1. a status with no runtime owner is repaired back to idle, PRESERVING the
 *    substatus, since `error` is exactly what the recovery UI keys on;
 * 2. a narrator that is genuinely busy is never touched — including loop-less
 *    owners (recovery stages) that hold a status via a runtime claim.
 */

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { narrators } from "../../db/schema";
import { isTurnTimingSubstatus } from "../narrator-turn-timing";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const {
	failUnownedStartupRecovery,
	reconcileRunningStatus,
	registerPlannedUpdateRecoveryController,
} = await import("../narrator-session");
const {
	activeNarrators,
	claimNarratorRuntime,
	listNarratorAdmissionOwners,
	pendingPermissions,
	pendingDangerReflections,
	withNarratorStartAdmission,
	withNarratorWorkAdmission,
} = await import("../narrator-session-state");
const websocket = await import("../../websocket/narrator-ws");
const { tryClaimExecution } = await import("../agent-runtime/ownership");

const NARRATOR_ID = "reconcile-narrator";
const OTHER_ID = "reconcile-other-narrator";

function now(): string {
	return "2026-08-05T00:00:00.000Z";
}

async function seedNarrator(
	status: "idle" | "working" | "waiting",
	substatus: string[] = [],
): Promise<void> {
	await db.insert(narrators).values({
		id: NARRATOR_ID,
		status,
		// `substatus` is a plain text column holding a JSON array, not a json-mode column.
		substatus: JSON.stringify(substatus),
		createdAt: now(),
		updatedAt: now(),
	});
}

/**
 * Read the narrator's status plus its SEMANTIC substatus tags.
 *
 * Turn-timing bookkeeping tags (`turn_paused_ms:` / `turn_pause_started_ms:`) are
 * maintained by the status writer on every transition and carry wall-clock values,
 * so they are filtered out here to keep the assertions about meaning rather than timing.
 */
async function readNarrator(): Promise<{ status: string; substatus: string[] } | undefined> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, NARRATOR_ID),
		columns: { status: true, substatus: true },
	});
	if (!row) return undefined;
	const tags = JSON.parse(row.substatus) as string[];
	return { status: row.status, substatus: tags.filter((tag) => !isTurnTimingSubstatus(tag)) };
}

/** Register a live agent loop the way runAgentLoop does. */
function registerLiveLoop(narratorId: string): void {
	activeNarrators.set(narratorId, {
		alive: true,
		_loopRunning: true,
	} as unknown as NonNullable<ReturnType<typeof activeNarrators.get>>);
}

afterEach(() => {
	activeNarrators.clear();
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	sqlite.run("DELETE FROM narrators");
});

afterAll(async () => {
	await fixture.close();
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("reconcileRunningStatus — reverse (zombie status → idle)", () => {
	test("repairs a working status that has no runtime owner", async () => {
		await seedNarrator("working");

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(true);
		expect((await readNarrator())?.status).toBe("idle");
	});

	test("repairs a waiting status that has no runtime owner", async () => {
		await seedNarrator("waiting");

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(true);
		expect((await readNarrator())?.status).toBe("idle");
	});

	test("preserves the error substatus so the recovery card survives", async () => {
		// The exact shape of the reported bug: the loop died with an error, then a
		// subagent's gate mirrored `working` over it and erased the error tag.
		await seedNarrator("working", ["error"]);

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(true);

		const row = await readNarrator();
		expect(row?.status).toBe("idle");
		expect(row?.substatus).toEqual(["error"]);
	});

	test("leaves an already-idle narrator alone", async () => {
		await seedNarrator("idle", ["unread"]);

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(false);

		const row = await readNarrator();
		expect(row?.status).toBe("idle");
		expect(row?.substatus).toEqual(["unread"]);
	});
});

describe("reconcileRunningStatus — busy narrators are never downgraded", () => {
	test("keeps the status of a live agent loop", async () => {
		await seedNarrator("working");
		registerLiveLoop(NARRATOR_ID);

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(false);
		expect((await readNarrator())?.status).toBe("working");
	});

	test("keeps the status while this narrator owns a pending permission", async () => {
		await seedNarrator("waiting");
		pendingPermissions.set("pending-permission", {
			narratorId: NARRATOR_ID,
		} as unknown as NonNullable<ReturnType<typeof pendingPermissions.get>>);

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(false);
		expect((await readNarrator())?.status).toBe("waiting");
	});

	test("keeps the status while this narrator owns a danger reflection", async () => {
		await seedNarrator("waiting", ["reflecting"]);
		pendingDangerReflections.set("pending-reflection", {
			narratorId: NARRATOR_ID,
		} as unknown as NonNullable<ReturnType<typeof pendingDangerReflections.get>>);

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(false);
		expect((await readNarrator())?.status).toBe("waiting");
	});

	test("keeps the status of a loop-less recovery stage holding a runtime claim", async () => {
		await seedNarrator("working");
		const release = claimNarratorRuntime(NARRATOR_ID, "recovery-stage");

		try {
			expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(false);
			expect((await readNarrator())?.status).toBe("working");
		} finally {
			release();
		}

		// Once the stage releases its claim the row is a zombie again and is repaired.
		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(true);
		expect((await readNarrator())?.status).toBe("idle");
	});

	test("a registered recovery controller protects the narrator until unregistered", async () => {
		await seedNarrator("working");
		const registration = registerPlannedUpdateRecoveryController(
			NARRATOR_ID,
			new AbortController(),
		);

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(false);
		expect((await readNarrator())?.status).toBe("working");

		registration.unregister();

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(true);
		expect((await readNarrator())?.status).toBe("idle");
	});

	test("a pending gate owned by ANOTHER narrator does not protect this one", async () => {
		// This is the crux of the bug: a subagent's pause is not the parent's work.
		// Only pending entries whose `narratorId` is this narrator count as busy.
		await seedNarrator("working");
		pendingDangerReflections.set("subagent-reflection", {
			narratorId: OTHER_ID,
			broadcastTargetId: NARRATOR_ID,
		} as unknown as NonNullable<ReturnType<typeof pendingDangerReflections.get>>);

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(true);
		expect((await readNarrator())?.status).toBe("idle");
	});
});

describe("reconcileRunningStatus — forward (stale idle → working)", () => {
	test("promotes an idle status back to working when a loop is really running", async () => {
		await seedNarrator("idle", ["unread"]);
		registerLiveLoop(NARRATOR_ID);

		expect(await reconcileRunningStatus(NARRATOR_ID)).toBe(true);
		expect((await readNarrator())?.status).toBe("working");
	});
});

describe("failed startup recovery — finite unowned target cleanup", () => {
	for (const status of ["working", "waiting"] as const) {
		test(`persists and broadcasts an explicit recovery failure for unowned ${status}`, async () => {
			await seedNarrator(status);
			const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation(() => {});
			try {
				expect(
					await failUnownedStartupRecovery([NARRATOR_ID], new Error("bounded read failed")),
				).toBe(1);
				expect(await readNarrator()).toEqual({
					status: "idle",
					substatus: ["error", "interrupted"],
				});
				const row = await db.query.narrators.findFirst({
					where: eq(narrators.id, NARRATOR_ID),
					columns: { errorMessage: true },
				});
				expect(row?.errorMessage).toBe("Startup recovery failed: bounded read failed");
				expect(broadcast).toHaveBeenCalledWith(
					NARRATOR_ID,
					expect.objectContaining({ type: "status_change", status: "idle" }),
				);
				expect(broadcast).toHaveBeenCalledWith(NARRATOR_ID, {
					type: "narrator_error",
					narratorId: NARRATOR_ID,
					error: row?.errorMessage,
				});
			} finally {
				broadcast.mockRestore();
			}
		});
	}

	test("only changes discovered IDs and deduplicates the same target", async () => {
		await seedNarrator("working");
		await db.insert(narrators).values({
			id: OTHER_ID,
			status: "working",
			createdAt: now(),
			updatedAt: now(),
		});
		expect(
			await failUnownedStartupRecovery([NARRATOR_ID, NARRATOR_ID, "missing"], "mount failed"),
		).toBe(1);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, OTHER_ID) }))?.status,
		).toBe("working");
		expect(await failUnownedStartupRecovery([], "early discovery failure")).toBe(0);
	});

	for (const owner of ["loop", "loop-admission", "permission", "reflection", "claim"] as const) {
		test(`does not affect a live ${owner} owner`, async () => {
			await seedNarrator("waiting", ["reflecting"]);
			let release = () => {};
			if (owner === "loop") registerLiveLoop(NARRATOR_ID);
			if (owner === "loop-admission") {
				const execution = tryClaimExecution(NARRATOR_ID, "run");
				expect(execution).not.toBeNull();
				release = () => {
					execution?.release();
				};
			}
			if (owner === "permission") {
				pendingPermissions.set("startup-permission", {
					narratorId: NARRATOR_ID,
				} as NonNullable<ReturnType<typeof pendingPermissions.get>>);
			}
			if (owner === "reflection") {
				pendingDangerReflections.set("startup-reflection", {
					narratorId: NARRATOR_ID,
				} as NonNullable<ReturnType<typeof pendingDangerReflections.get>>);
			}
			if (owner === "claim") release = claimNarratorRuntime(NARRATOR_ID, "parallel-recovery");
			try {
				expect(await failUnownedStartupRecovery([NARRATOR_ID], "other queue failed")).toBe(0);
				expect(await readNarrator()).toEqual({ status: "waiting", substatus: ["reflecting"] });
			} finally {
				release();
			}
		});
	}

	test("does not wait behind a live start admission or interfere with its start", async () => {
		await seedNarrator("working");
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const start = withNarratorStartAdmission(NARRATOR_ID, async () => {
			entered.resolve();
			await resume.promise;
			registerLiveLoop(NARRATOR_ID);
		});
		await entered.promise;
		try {
			expect(await failUnownedStartupRecovery([NARRATOR_ID], "other queue failed")).toBe(0);
			expect((await readNarrator())?.status).toBe("working");
		} finally {
			resume.resolve();
			await start;
		}
	});

	test("a background child's terminal admission cannot protect its unowned parent", async () => {
		await seedNarrator("working");
		await db.insert(narrators).values({
			id: OTHER_ID,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: NARRATOR_ID,
			status: "working",
			createdAt: now(),
			updatedAt: now(),
		});
		const entered = Promise.withResolvers<void>();
		const terminal = Promise.withResolvers<void>();
		const child = withNarratorWorkAdmission(OTHER_ID, async () => {
			entered.resolve();
			await terminal.promise;
		});
		await entered.promise;
		try {
			expect(listNarratorAdmissionOwners(NARRATOR_ID)).toContain(OTHER_ID);
			expect(listNarratorAdmissionOwners(NARRATOR_ID)).not.toContain(NARRATOR_ID);
			expect(await failUnownedStartupRecovery([NARRATOR_ID, OTHER_ID], "parent mount failed")).toBe(
				1,
			);
			expect(await readNarrator()).toEqual({ status: "idle", substatus: ["error", "interrupted"] });
			expect(
				(await db.query.narrators.findFirst({ where: eq(narrators.id, OTHER_ID) }))?.status,
			).toBe("working");
		} finally {
			terminal.resolve();
			await child;
		}
	});

	test("released queue claims allow a later failure to settle the zombie", async () => {
		await seedNarrator("working");
		const release = claimNarratorRuntime(NARRATOR_ID, "failed-queue");
		try {
			expect(await failUnownedStartupRecovery([NARRATOR_ID], "mount failed")).toBe(0);
		} finally {
			release();
		}
		expect(await failUnownedStartupRecovery([NARRATOR_ID], "mount failed")).toBe(1);
	});

	test("never overwrites the original error of an already idle narrator", async () => {
		await seedNarrator("idle", ["error"]);
		await db
			.update(narrators)
			.set({ errorMessage: "original provider error" })
			.where(eq(narrators.id, NARRATOR_ID));
		const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation(() => {});
		try {
			expect(await failUnownedStartupRecovery([NARRATOR_ID], "other queue failed")).toBe(0);
			expect(await readNarrator()).toEqual({ status: "idle", substatus: ["error"] });
			expect(
				(await db.query.narrators.findFirst({ where: eq(narrators.id, NARRATOR_ID) }))
					?.errorMessage,
			).toBe("original provider error");
			expect(broadcast).not.toHaveBeenCalled();
		} finally {
			broadcast.mockRestore();
		}
	});
});

const taskReflection = await import("../../lib/agent/tools/task-reflection");
const planReflection = await import("../../lib/agent/tools/exit-plan-reflection");
const { narratorPersistence } = await import("../narrator-persistence");

const reflectionCases = [
	{
		kind: "task",
		create: (narratorId: string) =>
			taskReflection.createTaskReflectionDecision("status-task-reflection", {
				narratorId,
				broadcastTargetId: NARRATOR_ID,
				toolUseId: "status-task-tool-use",
				toolName: "Write",
				inputJson: { file_path: "spec://tasks.json" },
				mutations: [],
			}),
		start: () => taskReflection.markTaskReflectionStarted("status-task-reflection"),
		confirm: () => taskReflection.confirmTaskReflection("status-task-reflection", "Verified"),
		cancel: () => taskReflection.reviseTaskReflection("status-task-reflection", "More work"),
		takeOver: () => taskReflection.takeOverTaskReflection("status-task-reflection"),
		cleanup: () => taskReflection.cleanupTaskReflection("status-task-reflection"),
	},
	{
		kind: "plan",
		create: (narratorId: string) =>
			planReflection.createExitPlanReflectionDecision("status-plan-reflection", {
				narratorId,
				broadcastTargetId: NARRATOR_ID,
				toolUseId: "status-plan-tool-use",
				toolName: "ExitPlanMode",
				inputJson: { plan: "Test plan" },
			}),
		start: () => planReflection.markExitPlanReflectionStarted("status-plan-reflection"),
		confirm: () => planReflection.confirmExitPlanReflection("status-plan-reflection"),
		cancel: () => planReflection.cancelExitPlanReflection("status-plan-reflection", "More work"),
		takeOver: () => planReflection.takeOverExitPlanReflection("status-plan-reflection"),
		cleanup: () => planReflection.cleanupExitPlanReflection("status-plan-reflection"),
	},
];

afterEach(() => {
	for (const reflection of reflectionCases) reflection.cleanup();
});

for (const reflection of reflectionCases) {
	describe(`${reflection.kind} reflection — parent attention isolation`, () => {
		test("does not leave a false user wait when the parent continues streaming", async () => {
			await seedNarrator("working");
			registerLiveLoop(NARRATOR_ID);
			await db.insert(narrators).values({
				id: OTHER_ID,
				parentNarratorId: NARRATOR_ID,
				createdAt: now(),
				updatedAt: now(),
			});
			reflection.create(OTHER_ID);
			expect(await reflection.start()).toBe(true);

			// Parent stream callbacks rewrite their local transient tags. Previously
			// this erased the child's mirrored `reflecting`, leaving `waiting` and
			// producing RecentTabs' user-attention glyph with no actionable request.
			await narratorPersistence.updateSubstatus(NARRATOR_ID, []);
			expect(pendingPermissions.size).toBe(0);
			expect(await readNarrator()).toEqual({ status: "working", substatus: [] });

			const owner = await db.query.narrators.findFirst({
				where: eq(narrators.id, OTHER_ID),
				columns: { status: true, substatus: true },
			});
			expect(owner?.status).toBe("waiting");
			expect(JSON.parse(owner?.substatus ?? "[]")).toContain("reflecting");
		});

		for (const outcome of ["confirm", "cancel"] as const) {
			test(`${outcome} cannot clear the parent's own pending decision`, async () => {
				await seedNarrator("waiting", ["reflecting"]);
				registerLiveLoop(NARRATOR_ID);
				reflection.create(OTHER_ID);

				expect(await reflection[outcome]()).toBe(true);
				expect(await readNarrator()).toEqual({ status: "waiting", substatus: ["reflecting"] });
			});
		}

		test("does not resurrect an idle parent's status or erase its error", async () => {
			await seedNarrator("idle", ["error"]);
			reflection.create(OTHER_ID);

			expect(await reflection.start()).toBe(true);
			expect(await readNarrator()).toEqual({ status: "idle", substatus: ["error"] });
		});

		test("still alerts a busy parent after explicit manual takeover", async () => {
			await seedNarrator("working");
			registerLiveLoop(NARRATOR_ID);
			reflection.create(OTHER_ID);

			expect(await reflection.takeOver()).toBe(true);
			expect(await readNarrator()).toEqual({ status: "waiting", substatus: [] });
		});

		test("preserves top-level reflection and manual user-wait states", async () => {
			await seedNarrator("working");
			reflection.create(NARRATOR_ID);

			expect(await reflection.start()).toBe(true);
			expect(await readNarrator()).toEqual({ status: "waiting", substatus: ["reflecting"] });
			expect(await reflection.takeOver()).toBe(true);
			expect(await readNarrator()).toEqual({ status: "waiting", substatus: [] });
		});
	});
}
