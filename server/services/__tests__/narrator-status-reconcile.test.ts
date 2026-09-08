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

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import { isTurnTimingSubstatus } from "../narrator-turn-timing";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { reconcileRunningStatus, registerPlannedUpdateRecoveryController } = await import(
	"../narrator-session"
);
const { activeNarrators, claimNarratorRuntime, pendingPermissions, pendingDangerReflections } =
	await import("../narrator-session-state");

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

afterAll(() => {
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
