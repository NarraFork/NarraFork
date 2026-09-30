/**
 * resumed-background-notice.test.ts — a background task the USER resumed by hand
 * still reaches its parent agent.
 *
 * A user-driven resume runs through `startContinuedSubagent` with
 * `preserveBackground: false`, which reconciles the task ROW, and then through
 * `deliverCompletedResume`, which rewrites the historical Agent tool result. That
 * rewrite IS read by the model — history is rebuilt from rows on every request — but
 * only on the parent's NEXT turn, and an idle parent has no next turn: nothing woke
 * it. So the panel showed a fresh result while the agent never acted on it.
 *
 * The fix is a wake, not a second copy of the result. Everything asserted here fails
 * SILENTLY in production, which is why it is pinned:
 *
 *   - not delivering        → an idle parent never acts on the new result
 *   - carrying the result   → the same output appears twice in one request
 *   - delivering too early  → the woken turn is built from the SUPERSEDED tool result
 *   - waking after a stop   → a turn is spent on work the user just interrupted
 */

import { describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { narratorBufferedMessages, narrators, runtimePublicationOutbox } from "../../db/schema";
import * as publicationModule from "../agent-runtime/publication";
import { runtimePublication } from "../agent-runtime/publication";
import * as runtimeQueueModule from "../agent-runtime/runtime-queue-port";
import { runAtomicWrite } from "../agent-runtime/runtime-write";
import { projectPendingInjection } from "../parent-injection-queue";
import {
	announceResumedBackgroundTask,
	commitResumedBackgroundTaskAnnouncement,
	planResumedBackgroundTaskNotice,
} from "../subagent-runner";

describe("planResumedBackgroundTaskNotice", () => {
	it("delivers and wakes for an ordinary manual continuation", () => {
		expect(
			planResumedBackgroundTaskNotice({ timedOut: false, interrupted: false, hasError: false }),
		).toEqual({ status: "completed", deliver: true, wakeParent: true });
	});

	it("delivers a failure and still wakes, because a failure is actionable", () => {
		expect(
			planResumedBackgroundTaskNotice({ timedOut: false, interrupted: false, hasError: true }),
		).toEqual({ status: "failed", deliver: true, wakeParent: true });
	});

	it("reports a timeout as timeout rather than collapsing it into a failure", () => {
		// The two are distinguishable to the model (retry vs investigate), and the
		// hasError flag is also set on a timeout — so order matters here.
		expect(
			planResumedBackgroundTaskNotice({ timedOut: true, interrupted: false, hasError: true }),
		).toEqual({ status: "timeout", deliver: true, wakeParent: true });
	});

	// The user pressing stop is the user deciding this work should not continue.
	// The row is still closed out (otherwise the earlier "restarted" notice dangles
	// and the panel keeps a live-looking row), but no parent turn is spent on it.
	it("closes out a user interrupt without starting a parent turn", () => {
		expect(
			planResumedBackgroundTaskNotice({ timedOut: false, interrupted: true, hasError: false }),
		).toEqual({ status: "cancelled", deliver: true, wakeParent: false });
	});

	// `preserveBackground` runs already went through finalizeBackgroundCompletion,
	// which notifies AND wakes. Announcing again produces no error — just an agent
	// told the same thing twice.
	it("stays silent for a preserveBackground run but still decides the row status", () => {
		expect(
			planResumedBackgroundTaskNotice({
				preserveBackground: true,
				timedOut: false,
				interrupted: false,
				hasError: false,
			}),
		).toEqual({ status: "completed", deliver: false, wakeParent: true });
	});

	/**
	 * `skipConclusionDelivery` is checked independently of `preserveBackground`.
	 *
	 * Today's two call sites pass both together, so keying off either alone would
	 * pass every existing test — but they are independent inputs, and a run that
	 * preserved background while still publishing a conclusion would then be
	 * announced by two producers with nothing to signal the collision.
	 */
	it("stays silent when the run leaves the historical tool result untouched", () => {
		expect(
			planResumedBackgroundTaskNotice({
				skipConclusionDelivery: true,
				timedOut: false,
				interrupted: false,
				hasError: false,
			}),
		).toMatchObject({ status: "completed", deliver: false });
	});

	it("keeps deciding the row status for an interrupted preserveBackground run", () => {
		// `status` must be independent of `deliver`: the caller reconciles the row in
		// both cases, so a plan that only filled it in when announcing would leave a
		// preserveBackground row stuck at its previous terminal value.
		expect(
			planResumedBackgroundTaskNotice({
				preserveBackground: true,
				timedOut: true,
				interrupted: false,
				hasError: true,
			}),
		).toMatchObject({ status: "timeout", deliver: false });
	});
});

describe("resumed announcement backend transaction contracts", () => {
	for (const fails of [false, true]) {
		it(`awaits the PostgreSQL terminal commit${fails ? " and propagates rejection" : ""} without SQLite`, async () => {
			const facade = publicationModule.getRuntimePublicationService();
			const run = {
				producerKind: "agent" as const,
				taskId: "pg-resumed-child",
				logicalRunId: "pg-resumed-run",
				recipientId: "pg-resumed-parent",
			};
			let release!: () => void;
			const barrier = new Promise<void>((resolve) => {
				release = resolve;
			});
			let entered!: () => void;
			const committing = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const backend = spyOn(runtimeQueueModule, "resolveRuntimeQueueBackend").mockReturnValue(
				"postgres",
			);
			const publication = spyOn(publicationModule, "getRuntimePublicationService").mockReturnValue({
				...facade,
				backend: "postgres",
				getAgentRun: async () => run,
				commitAgentTerminal: async (input) => {
					expect(input).toMatchObject({ run, text: "PG result", eventKind: "completed" });
					entered();
					await barrier;
					if (fails) throw new Error("PG commit failed");
					return { status: "committed", deliveryId: null, arrivalSeq: null };
				},
			});
			const sqliteRead = spyOn(db, "select").mockImplementation(() => {
				throw new Error("PostgreSQL announcement must not read SQLite");
			});
			const sqliteTransaction = spyOn(db, "transaction").mockImplementation(() => {
				throw new Error("PostgreSQL announcement must not open a SQLite transaction");
			});
			try {
				const completion = commitResumedBackgroundTaskAnnouncement(
					{
						subagentId: run.taskId,
						parentNarratorId: run.recipientId,
						logicalRunId: run.logicalRunId,
						status: "completed",
						wakeParent: true,
						locale: "en",
					},
					"PG result",
				);
				expect(completion).toBeInstanceOf(Promise);
				let settled = false;
				const observed = Promise.resolve(completion).finally(() => {
					settled = true;
				});
				await committing;
				expect(settled).toBe(false);
				release();
				if (fails) await expect(observed).rejects.toThrow("PG commit failed");
				else await observed;
				expect(settled).toBe(true);
				expect(sqliteRead).not.toHaveBeenCalled();
				expect(sqliteTransaction).not.toHaveBeenCalled();
			} finally {
				release();
				sqliteTransaction.mockRestore();
				sqliteRead.mockRestore();
				publication.mockRestore();
				backend.mockRestore();
			}
		});
	}
});

describe("the announcement is handed to the caller, not fired by the runner", () => {
	/**
	 * ⚠️ ORDER, and it is invisible when wrong.
	 *
	 * `startContinuedSubagent`'s terminal chain settles BEFORE
	 * `deliverCompletedResume` rewrites the Agent tool result. Waking the parent from
	 * inside that chain builds its turn from the result of the run this continuation
	 * just superseded — the exact confusion the notice exists to prevent, with a row
	 * that looks perfectly correct in the transcript.
	 *
	 * So the runner must only RECORD the notice and expose it; the resume path fires
	 * it after persisting the conclusion. This is a source-level guard because the
	 * ordering cannot be observed from the plan's return value.
	 */
	it("the runner records the notice instead of awaiting a wake in its terminal chain", async () => {
		const source = await Bun.file(new URL("../subagent-runner.ts", import.meta.url)).text();
		const chainStart = source.indexOf("const terminalCompletion = run.terminal");
		expect(chainStart).toBeGreaterThan(-1);
		const chainEnd = source.indexOf("takeResumedBackgroundAnnouncement: () =>", chainStart);
		expect(chainEnd).toBeGreaterThan(chainStart);
		const chain = source.slice(chainStart, chainEnd);
		expect(chain).toContain("pendingAnnouncement = {");
		expect(chain).not.toContain("announceResumedBackgroundTask(");
	});

	it("the resume path announces only after the conclusion is delivered", async () => {
		const source = await Bun.file(new URL("../subagent-resume.ts", import.meta.url)).text();
		const conclusion = source.indexOf("await deliverCompletedResume(");
		const announce = source.indexOf("await announceResumedBackgroundTask(");
		expect(conclusion).toBeGreaterThan(-1);
		expect(announce).toBeGreaterThan(conclusion);
	});

	for (const status of ["completed", "cancelled"] as const) {
		it(`projects only the conclusion pointer and ${status === "completed" ? "wakes once" : "does not wake after stop"}`, async () => {
			cleanDb(sqlite);
			// Step the actual worker explicitly; no provider request or timing race.
			runtimePublication.stop();
			let wakes = 0;
			runtimePublication.setWake(() => {
				wakes++;
			});
			const time = new Date().toISOString();
			db.insert(narrators)
				.values([
					{ id: "notice-parent", createdAt: time, updatedAt: time },
					{
						id: "notice-child",
						parentNarratorId: "notice-parent",
						type: "subagent",
						variant: "subagent:general",
						createdAt: time,
						updatedAt: time,
					},
				])
				.run();
			const run = runtimePublication.startAgentRun({
				narratorId: "notice-child",
				parentNarratorId: "notice-parent",
			});
			const notice = {
				subagentId: "notice-child",
				parentNarratorId: "notice-parent",
				logicalRunId: run.logicalRunId,
				status,
				wakeParent: status === "completed",
				locale: "en" as const,
			};
			const result = "PRIVATE FINAL RESULT MUST NOT BE INJECTED AGAIN";
			try {
				const before = db.select().from(runtimePublicationOutbox).all();
				expect(() =>
					runAtomicWrite(db, "test.rollbackResumedAnnouncement", (tx) => {
						expect(commitResumedBackgroundTaskAnnouncement(notice, result, tx)).toBeUndefined();
						throw new Error("rollback resumed announcement");
					}),
				).toThrow("rollback resumed announcement");
				expect(db.select().from(runtimePublicationOutbox).all()).toEqual(before);
				expect(
					runAtomicWrite(db, "test.commitResumedAnnouncement", (tx) =>
						commitResumedBackgroundTaskAnnouncement(notice, result, tx),
					),
				).toBeUndefined();
				await announceResumedBackgroundTask(notice);
				runtimePublication.flushRecipient("notice-parent");
				await announceResumedBackgroundTask(notice);
				runtimePublication.flushRecipient("notice-parent");
				const rows = db
					.select()
					.from(narratorBufferedMessages)
					.where(eq(narratorBufferedMessages.narratorId, "notice-parent"))
					.all();
				expect(rows).toHaveLength(1);
				expect(rows[0].text).not.toContain(result);
				const projected = projectPendingInjection(rows[0]);
				expect(projected.kind).toBe("bg_agent");
				if (projected.kind !== "bg_agent") throw new Error("Expected task notice projection");
				expect(projected.task.result).toBeUndefined();
				expect(projected.task.noticeText).toBe(rows[0].text);
				expect(projected.task.resultMessageId).toBeTruthy();
				expect(projected.task.resultPreview).not.toContain(result);
				expect(wakes).toBe(status === "completed" ? 1 : 0);
			} finally {
				runtimePublication.setWake(undefined);
				cleanDb(sqlite);
			}
		});
	}
});
