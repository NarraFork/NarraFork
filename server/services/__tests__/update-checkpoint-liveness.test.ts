/**
 * A planned update must not resurrect narrators that were already finished.
 *
 * The bug this pins: `checkpointPlannedUpdateContinuations` scanned every tool row in
 * `initializing`/`pending`/`running` and wrote a continuation for each one. Those statuses are
 * NOT proof of live work — a provider error leaves in-flight rows untouched on purpose (see the
 * header of narrator-subagent-recovery), and a crash between "row written" and "result written"
 * leaves them too. The replacement process then delivered those continuations to their owner via
 * `continueNarrator`, so an auto-restarting update reopened a narrator the user had finished and
 * made its stale plan act on current code.
 *
 * The narrator's own `status` cannot be the guard: a turn killed mid-flight stays `working`
 * forever, so a long-dead narrator reads as busy. Liveness therefore comes from this process's
 * in-memory registries, which is exactly what the recovery manifest is built from.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const updateCoordinator = await import("../update-coordinator");
const { checkpointPlannedUpdateContinuations, isLiveNarratorForCheckpoint } = await import(
	"../update-recovery-service"
);
const { toolContinuationService } = await import("../tool-continuation-service");

const LIVE_NARRATOR = "narrator-live";
const ABANDONED_NARRATOR = "narrator-abandoned";

/**
 * Seed a tool row in a status the checkpoint actually covers.
 *
 * `pending` (awaiting permission) and `initializing` are the resurrection vectors: an ordinary
 * `running` tool is drained before the restart, but these two are deliberately persisted as
 * continuations so they can be resumed. A dead narrator's leftover pending row is therefore
 * indistinguishable from a real one without a liveness check.
 */
async function seedNarratorWithPendingTool(input: {
	narratorId: string;
	toolCallId: string;
	toolStatus?: "pending" | "initializing";
	/** Both narrators are seeded `working`: that is precisely what a killed turn leaves behind. */
	status?: "working" | "idle";
}): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: input.narratorId,
		variant: "primary",
		status: input.status ?? "working",
		createdAt: now,
		updatedAt: now,
	});
	const messageId = `${input.narratorId}-message`;
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: input.narratorId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: `${input.toolCallId}-use`, name: "Bash", input: {} }],
		createdAt: now,
	});
	await db.insert(narratorToolCalls).values({
		id: input.toolCallId,
		narratorId: input.narratorId,
		messageId,
		toolUseId: `${input.toolCallId}-use`,
		toolName: "Bash",
		status: input.toolStatus ?? "pending",
		inputJson: { command: "sleep 1" },
		createdAt: now,
	});
}

describe("planned-update checkpoint liveness", () => {
	beforeEach(() => {
		cleanDb(sqlite);
		updateCoordinator.resetUpdateCoordinationForTests();
	});

	afterEach(() => {
		updateCoordinator.resetUpdateCoordinationForTests();
	});

	test("only checkpoints in-flight tools whose narrator is still running", async () => {
		await seedNarratorWithPendingTool({
			narratorId: LIVE_NARRATOR,
			toolCallId: "tool-live",
		});
		// Same durable shape, no live loop: an earlier turn died and left this row behind.
		await seedNarratorWithPendingTool({
			narratorId: ABANDONED_NARRATOR,
			toolCallId: "tool-abandoned",
		});

		const unregisterLoop = updateCoordinator.registerNarratorLoop(LIVE_NARRATOR, "en");
		updateCoordinator.scheduleUpdate("9.9.9");
		try {
			const snapshot = await checkpointPlannedUpdateContinuations();

			expect(snapshot.narrators.map((target) => target.narratorId)).toEqual([LIVE_NARRATOR]);
			const covered = await toolContinuationService.listByEpoch(snapshot.updateEpoch);
			expect(covered.map((row) => row.toolCallId)).toEqual(["tool-live"]);
			// The decisive assertion: no continuation exists to drive the finished narrator.
			expect(covered.some((row) => row.narratorId === ABANDONED_NARRATOR)).toBe(false);
		} finally {
			unregisterLoop();
		}
	});

	test("a narrator holding only an execution lease still counts as live", async () => {
		// A subagent/tool execution registers a lease rather than a narrator loop. Requiring a
		// loop would drop genuinely live work and lose its tool result across the update.
		await seedNarratorWithPendingTool({ narratorId: LIVE_NARRATOR, toolCallId: "tool-live" });
		const lease = updateCoordinator.tryAcquireFinalUpdateExecution("ordinary", LIVE_NARRATOR);
		expect(lease).not.toBeNull();
		updateCoordinator.scheduleUpdate("9.9.9");
		try {
			const snapshot = await checkpointPlannedUpdateContinuations();
			expect(isLiveNarratorForCheckpoint(snapshot, LIVE_NARRATOR)).toBe(true);
			const covered = await toolContinuationService.listByEpoch(snapshot.updateEpoch);
			expect(covered.map((row) => row.toolCallId)).toEqual(["tool-live"]);
		} finally {
			lease?.release();
		}
	});

	test("a pending permission survives the restart with its state and input intact", async () => {
		// The counterpart to releasing the update start grant during a permission wait (see
		// tool-executor's runPermissionWaitOutsideAdmission): letting the restart proceed is only
		// acceptable because the request itself is durable. Nothing may be interrupted, and the
		// input the user is looking at must still be there afterwards.
		await seedNarratorWithPendingTool({
			narratorId: LIVE_NARRATOR,
			toolCallId: "tool-awaiting-user",
			toolStatus: "pending",
		});
		const unregisterLoop = updateCoordinator.registerNarratorLoop(LIVE_NARRATOR, "en");
		updateCoordinator.scheduleUpdate("9.9.9");
		try {
			const snapshot = await checkpointPlannedUpdateContinuations();

			const covered = await toolContinuationService.listByEpoch(snapshot.updateEpoch);
			expect(covered).toHaveLength(1);
			// Recoverable as a permission request, not as an already-approved execution.
			expect(covered[0]).toMatchObject({
				toolCallId: "tool-awaiting-user",
				kind: "pending_permission",
				state: "waiting",
			});
			expect(covered[0].payloadJson).toMatchObject({ permissionMode: "normal" });

			// The request was not interrupted or auto-decided to let the update through, and the
			// user's input is untouched.
			const row = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, "tool-awaiting-user"),
			});
			expect(row?.status).toBe("pending");
			expect(row?.permissionDecidedBy).toBeFalsy();
			expect(row?.inputJson).toEqual({ command: "sleep 1" });
		} finally {
			unregisterLoop();
		}
	});

	test("a narrator whose only live work is a permission wait is still covered", async () => {
		// The gap this closes. `releaseAdmissionForUserDecisionWait` drops the update start
		// grant while a request waits on a human, so during that window the narrator holds
		// NO start grant. If it also held no loop and no lease, the checkpoint would judge
		// it abandoned and skip its row — and `listActiveToolCallIds` uses the same
		// predicate, so the fence would agree the work was covered. The pending request
		// would then be neither re-offered nor failed after the restart: a permission form
		// that never responds again, with nothing in the logs.
		//
		// It is covered today because a subagent/tool execution keeps its lease across the
		// whole run and a primary loop stays registered, so one of the two registries always
		// sees it. That is the invariant being pinned, not an accident to rely on: releasing
		// the grant is only safe while SOMETHING still reports the narrator live.
		await seedNarratorWithPendingTool({
			narratorId: LIVE_NARRATOR,
			toolCallId: "tool-permission-only",
			toolStatus: "pending",
		});
		const lease = updateCoordinator.tryAcquireFinalUpdateExecution("resumable", LIVE_NARRATOR);
		expect(lease).not.toBeNull();
		updateCoordinator.scheduleUpdate("9.9.9");
		try {
			// No narrator loop registered: the permission wait is the only thing keeping this
			// narrator alive, exactly as during a foreground subagent's request.
			const snapshot = await checkpointPlannedUpdateContinuations();
			expect(isLiveNarratorForCheckpoint(snapshot, LIVE_NARRATOR)).toBe(true);
			const covered = await toolContinuationService.listByEpoch(snapshot.updateEpoch);
			expect(covered.map((row) => row.toolCallId)).toEqual(["tool-permission-only"]);
			expect(covered[0].kind).toBe("pending_permission");
		} finally {
			lease?.release();
		}
	});

	test("dropping the last liveness signal loses the pending request — hence the invariant", async () => {
		// The negative half of the case above, stated so the consequence is on record rather
		// than inferred: with the grant released AND no loop or lease, the row is skipped.
		// If a future change releases some other liveness signal during a permission wait,
		// this is the symptom to look for.
		await seedNarratorWithPendingTool({
			narratorId: ABANDONED_NARRATOR,
			toolCallId: "tool-orphaned-permission",
			toolStatus: "pending",
		});
		updateCoordinator.scheduleUpdate("9.9.9");
		const snapshot = await checkpointPlannedUpdateContinuations();
		expect(isLiveNarratorForCheckpoint(snapshot, ABANDONED_NARRATOR)).toBe(false);
		expect(await toolContinuationService.listByEpoch(snapshot.updateEpoch)).toEqual([]);
	});

	test("liveness is decided by the registry, not by a stale working status", async () => {
		// Built from the real registries rather than a hand-written snapshot literal: the
		// thing worth pinning is that unregistering actually removes a narrator from the
		// manifest, which a literal cannot show.
		const unregisterLoop = updateCoordinator.registerNarratorLoop(LIVE_NARRATOR, "en");
		updateCoordinator.scheduleUpdate("9.9.9");
		try {
			const withLoop = updateCoordinator.capturePlannedUpdateRecoverySnapshot();
			expect(isLiveNarratorForCheckpoint(withLoop, LIVE_NARRATOR)).toBe(true);
			// A narrator seeded `working` in the database but absent from the registries is
			// still not live — a turn killed mid-flight stays `working` forever.
			expect(isLiveNarratorForCheckpoint(withLoop, ABANDONED_NARRATOR)).toBe(false);

			unregisterLoop();
			const afterUnregister = updateCoordinator.capturePlannedUpdateRecoverySnapshot();
			expect(isLiveNarratorForCheckpoint(afterUnregister, LIVE_NARRATOR)).toBe(false);
		} finally {
			unregisterLoop();
		}
	});
});
