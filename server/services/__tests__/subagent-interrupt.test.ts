import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { getTestDb } from "../../../tests/setup";

// Bun module mocks cannot replace a DB already captured by the mailbox singleton.
// Isolate this fixture from preceding suites that loaded the runtime against another DB.
if (process.env.NARRAFORK_SUBAGENT_INTERRUPT_FIXTURE !== "1") {
	test("isolated subagent interrupt suite", () => {
		const env: NodeJS.ProcessEnv = { ...process.env, NARRAFORK_SUBAGENT_INTERRUPT_FIXTURE: "1" };
		delete env.NARRAFORK_HOME;
		const result = spawnSync(process.execPath, ["test", import.meta.path], {
			env,
			encoding: "utf8",
			timeout: 60_000,
			maxBuffer: 512 * 1024,
		});
		if (result.error || result.status !== 0)
			throw new Error(`${result.error ?? "Fixture failed"}\n${result.stdout}\n${result.stderr}`);
		expect(result.status).toBe(0);
	}, 65_000);
} else {
	const { db, sqlite } = getTestDb();
	const { narrators } = await import("../../db/schema");
	// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
	const realDbModule = { ...(await import("../../db")) };
	mock.module("../../db", () => ({ db, sqlite }));

	const {
		attachSubagent,
		consumeForegroundSubagentHardInterrupt,
		detachSubagent,
		getBackgroundAbortControllers,
		getDetachableMap,
		getForegroundAbortControllers,
		interruptForegroundSubagent,
		interruptForegroundSubagentsForParent,
		ProxyAbortController,
	} = await import("../subagent-detach");
	type DetachEntry = import("../subagent-detach").DetachEntry;
	const {
		claimManualOverride,
		cleanupManualOverrideRuntime,
		clearManualOverrideRuntimes,
		getManualOverrideRuntime,
		listStaleManualOverrideRuntimes,
		resumeManualOverride,
		settleManualOverrideClaim,
		waitForManualOverride,
	} = await import("../subagent-manual-override");
	const {
		bufferSubagentUserMessage,
		canDeliverBufferedMessageInPass,
		clearSubagentBufferedMessages,
		getSubagentBufferedMessages,
		MAX_SUBAGENT_INTERRUPTION_RETRIES,
		planSubagentInterruption,
		pushSubagentBufferedMessage,
		removeSubagentBufferedMessage,
		reorderSubagentBufferedMessages,
		requestSubagentBufferedMessageSoftStop,
		shouldStopSubagentForBufferedMessage,
		updateSubagentBufferedMessage,
	} = await import("../subagent-executor");

	const SUBAGENT_ID = "subagent-interrupt-test";
	db.insert(narrators)
		.values({
			id: SUBAGENT_ID,
			type: "subagent",
			variant: "subagent:general",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.run();

	afterEach(() => {
		getForegroundAbortControllers().clear();
		getDetachableMap().clear();
		clearManualOverrideRuntimes();
		consumeForegroundSubagentHardInterrupt(SUBAGENT_ID);
		clearSubagentBufferedMessages(SUBAGENT_ID);
	});

	afterAll(() => {
		mock.module("../../db", () => realDbModule);
		mock.restore();
	});

	test("detach receipts retain the final alias, running state and one Await call", async () => {
		const { backgroundTaskService } = await import("../background-task-service");
		const { clearAliasRegistry } = await import("../subagent-alias");
		const parentId = "receipt-parent";
		const childId = "receipt-child";
		const now = new Date().toISOString();
		await db.insert(narrators).values([
			{ id: parentId, variant: "primary", createdAt: now, updatedAt: now },
			{
				id: childId,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: parentId,
				title: "receipt-worker",
				status: "working",
				createdAt: now,
				updatedAt: now,
			},
		]);
		const parentAbort = new AbortController();
		const proxy = new ProxyAbortController();
		proxy.listenTo(parentAbort.signal);
		const publishHandoff = mock(() => true);
		getDetachableMap().set(childId, {
			runId: "receipt-run",
			markDetached: () => {},
			publishHandoff,
			proxy,
			parentSignal: parentAbort.signal,
			fgAbort: new AbortController(),
			toolUseId: "receipt-tool",
			parentNarratorId: parentId,
			subagentId: childId,
		});
		try {
			expect(await detachSubagent(childId)).toBe(true);
			expect(publishHandoff).toHaveBeenCalledWith(
				"<background_task_id>receipt-worker</background_task_id>\n\n" +
					'Subagent detached to background. Await({ type: "agent", id: "receipt-worker" })',
			);
			parentAbort.abort();
			expect(proxy.signal.aborted).toBe(false);
			const interruptedAttach = new AbortController();
			interruptedAttach.abort();
			expect(await attachSubagent(childId, parentId, "attach-tool", interruptedAttach.signal)).toBe(
				"<background_task_id>receipt-worker</background_task_id>\n\n" +
					'Attach interrupted; subagent still running in background. Await({ type: "agent", id: "receipt-worker" })',
			);
			expect(
				sqlite
					.query("SELECT is_background, background_status FROM narrators WHERE id = ?")
					.get(childId),
			).toEqual({ is_background: 1, background_status: "running" });
			expect(getBackgroundAbortControllers().get(childId)?.signal.aborted).toBe(false);
		} finally {
			proxy.dispose();
			getBackgroundAbortControllers().delete(childId);
			backgroundTaskService.unregisterAbortController(childId);
			clearAliasRegistry(parentId);
			sqlite.query("DELETE FROM background_tasks WHERE parent_narrator_id = ?").run(parentId);
			sqlite.query("DELETE FROM narrators WHERE id = ?").run(childId);
			sqlite.query("DELETE FROM narrators WHERE id = ?").run(parentId);
		}
	});

	describe("foreground subagent interrupt semantics", () => {
		test("plans a resumable-error continuation prompt instead of terminating", async () => {
			expect(
				planSubagentInterruption(
					{
						interrupted: true,
						interruptedReason: "resumable_error",
						shouldReplayInterruptedToolResultTurn: false,
					},
					0,
				),
			).toEqual({
				action: "prompt",
				retries: 1,
				reason: "resumable_error",
				promptKey: "resumeAfterTransientError",
			});
		});

		test("replays an interrupted tool-result turn without synthetic user text", async () => {
			expect(
				planSubagentInterruption(
					{
						interrupted: true,
						interruptedReason: "completion_limit",
						shouldReplayInterruptedToolResultTurn: true,
					},
					1,
				),
			).toEqual({ action: "replay", retries: 2, reason: "completion_limit" });
		});

		test("bounds repeated interrupted continuations and resets after success", async () => {
			expect(
				planSubagentInterruption(
					{ interrupted: true, interruptedReason: "resumable_error" },
					MAX_SUBAGENT_INTERRUPTION_RETRIES,
				),
			).toEqual({
				action: "stop",
				retries: MAX_SUBAGENT_INTERRUPTION_RETRIES + 1,
				reason: "resumable_error",
			});
			expect(planSubagentInterruption({ interrupted: false }, 2)).toEqual({
				action: "none",
				retries: 0,
			});
		});

		test("ordinary buffered messages preserve FIFO arrival order", async () => {
			await pushSubagentBufferedMessage(SUBAGENT_ID, "first");
			await pushSubagentBufferedMessage(SUBAGENT_ID, "second");
			await pushSubagentBufferedMessage(SUBAGENT_ID, "third");

			expect(getSubagentBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"first",
				"second",
				"third",
			]);
		});

		test("priority messages move ahead without reversing each other", async () => {
			await pushSubagentBufferedMessage(SUBAGENT_ID, "ordinary-1");
			await pushSubagentBufferedMessage(SUBAGENT_ID, "priority-1", { position: "front" });
			await pushSubagentBufferedMessage(SUBAGENT_ID, "priority-2", { position: "front" });
			await pushSubagentBufferedMessage(SUBAGENT_ID, "ordinary-2");

			expect(getSubagentBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"priority-1",
				"priority-2",
				"ordinary-1",
				"ordinary-2",
			]);
		});

		test("shared user-message helper preserves FIFO and requests soft-stop", async () => {
			await bufferSubagentUserMessage(SUBAGENT_ID, "first");
			await bufferSubagentUserMessage(SUBAGENT_ID, "second");

			expect(getSubagentBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"first",
				"second",
			]);
			expect(await shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(true);
		});

		test("taken-over user messages can queue without requesting soft-stop", async () => {
			await bufferSubagentUserMessage(SUBAGENT_ID, "manual", { requestSoftStop: false });

			expect(getSubagentBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"manual",
			]);
			expect(await shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(false);
		});

		test("buffer soft-stop remains active while queued messages remain", async () => {
			await pushSubagentBufferedMessage(SUBAGENT_ID, "first");
			await pushSubagentBufferedMessage(SUBAGENT_ID, "second");
			requestSubagentBufferedMessageSoftStop(SUBAGENT_ID);

			expect(await shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(true);
			expect(await shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(true);
		});

		test("clearing the subagent buffer also clears its soft-stop request", async () => {
			await pushSubagentBufferedMessage(SUBAGENT_ID, "queued");
			requestSubagentBufferedMessageSoftStop(SUBAGENT_ID);

			clearSubagentBufferedMessages(SUBAGENT_ID);

			expect(await shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(false);
		});
	});

	/**
	 * Which queued messages the running pass may carry at its next after-tools
	 * boundary. Anything rejected here waits for the whole loop pass to end, which
	 * for a long-running subagent is arbitrarily far away — so a wrong "false" turns
	 * agent-to-agent Send back into a delayed mailbox with no error to notice.
	 */
	describe("canDeliverBufferedMessageInPass", () => {
		test("a plain message is carried by the current pass", async () => {
			expect(canDeliverBufferedMessageInPass({}, "user-1")).toBe(true);
		});

		// The regression this predicate was written for: Send stamps the sender's
		// userId as createdBy, and the old condition rejected any createdBy at all, so
		// every parent→child Send waited for the subagent's pass to finish.
		test("a message from the user the pass already runs as is carried in-pass", async () => {
			expect(canDeliverBufferedMessageInPass({ createdBy: "user-1" }, "user-1")).toBe(true);
		});

		test("a message from a different user waits for a pass built for that identity", async () => {
			expect(canDeliverBufferedMessageInPass({ createdBy: "user-2" }, "user-1")).toBe(false);
		});

		// "No particular user" cannot conflict with the pass identity.
		test("an unattributed message is carried even when the pass has a user", async () => {
			expect(canDeliverBufferedMessageInPass({ createdBy: null }, "user-1")).toBe(true);
			expect(canDeliverBufferedMessageInPass({}, null)).toBe(true);
		});

		test("an attributed message waits when the pass itself has no user", async () => {
			expect(canDeliverBufferedMessageInPass({ createdBy: "user-1" }, null)).toBe(false);
		});

		// In-pass delivery contributes text only, so anything whose payload is not
		// text must go through the history-rebuilding path or be silently dropped.
		test("attachments and pre-prompt commands still wait for the restart path", async () => {
			expect(
				canDeliverBufferedMessageInPass({ images: [{ imageId: "img-1" }] as never }, "user-1"),
			).toBe(false);
			expect(
				canDeliverBufferedMessageInPass({ textFiles: [new File(["x"], "a.txt")] }, "user-1"),
			).toBe(false);
			expect(canDeliverBufferedMessageInPass({ prePromptBashCommand: "ls" }, "user-1")).toBe(false);
		});
	});

	/**
	 * Single-message queue mutations, as reached by DELETE/PATCH /:id/buffer/:mid and
	 * the remove_buffer/update_buffer WS frames.
	 *
	 * Regression: those routes only knew about the primary-narrator queue, which
	 * lives in a different map. A queued message on a taken-over subagent could not
	 * be removed at all — the route 404'd and the frontend rolled its optimistic
	 * removal back, so the card looked stuck.
	 */
	describe("subagent buffer single-message mutations", () => {
		test("removing the last queued message also drops the soft-stop request", async () => {
			const queued = await pushSubagentBufferedMessage(SUBAGENT_ID, "only");
			requestSubagentBufferedMessageSoftStop(SUBAGENT_ID);

			expect(await removeSubagentBufferedMessage(SUBAGENT_ID, queued.id)).toBe(true);

			expect(getSubagentBufferedMessages(SUBAGENT_ID)).toEqual([]);
			// A stale soft stop would end the next turn with nothing left to resume.
			expect(await shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(false);
		});

		test("removing one of several messages keeps the rest and the soft stop", async () => {
			const first = await pushSubagentBufferedMessage(SUBAGENT_ID, "first");
			await pushSubagentBufferedMessage(SUBAGENT_ID, "second");
			requestSubagentBufferedMessageSoftStop(SUBAGENT_ID);

			expect(await removeSubagentBufferedMessage(SUBAGENT_ID, first.id)).toBe(true);

			expect(getSubagentBufferedMessages(SUBAGENT_ID).map((m) => m.text)).toEqual(["second"]);
			expect(await shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(true);
		});

		test("unknown ids report a miss so the caller can fall back to the primary queue", async () => {
			await pushSubagentBufferedMessage(SUBAGENT_ID, "queued");

			expect(await removeSubagentBufferedMessage(SUBAGENT_ID, "no-such-id")).toBe(false);
			expect(await updateSubagentBufferedMessage(SUBAGENT_ID, "no-such-id", "edited")).toBe(false);
			expect(await removeSubagentBufferedMessage("no-such-subagent", "no-such-id")).toBe(false);
		});

		test("editing a queued message replaces its text", async () => {
			const queued = await pushSubagentBufferedMessage(SUBAGENT_ID, "before");

			expect(await updateSubagentBufferedMessage(SUBAGENT_ID, queued.id, "after")).toBe(true);

			expect(getSubagentBufferedMessages(SUBAGENT_ID).map((m) => m.text)).toEqual(["after"]);
		});

		test("reorder applies an exact permutation and rejects a mismatched id list", async () => {
			const first = await pushSubagentBufferedMessage(SUBAGENT_ID, "first");
			const second = await pushSubagentBufferedMessage(SUBAGENT_ID, "second");

			expect(await reorderSubagentBufferedMessages(SUBAGENT_ID, [second.id, first.id])).toBe(true);
			expect(getSubagentBufferedMessages(SUBAGENT_ID).map((m) => m.text)).toEqual([
				"second",
				"first",
			]);

			// A partial or foreign id list must leave the queue untouched.
			expect(await reorderSubagentBufferedMessages(SUBAGENT_ID, [first.id])).toBe(false);
			expect(await reorderSubagentBufferedMessages(SUBAGENT_ID, [second.id, "foreign"])).toBe(
				false,
			);
			expect(getSubagentBufferedMessages(SUBAGENT_ID).map((m) => m.text)).toEqual([
				"second",
				"first",
			]);
		});
	});

	describe("foreground subagent interrupt controls", () => {
		test("soft interrupt aborts the foreground controller without marking a hard interrupt", async () => {
			const ctrl = new AbortController();
			getForegroundAbortControllers().set(SUBAGENT_ID, ctrl);

			expect(interruptForegroundSubagent(SUBAGENT_ID)).toBe(true);

			expect(ctrl.signal.aborted).toBe(true);
			expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(false);
		});

		test("hard interrupt marker is consumed exactly once", async () => {
			const ctrl = new AbortController();
			getForegroundAbortControllers().set(SUBAGENT_ID, ctrl);

			expect(interruptForegroundSubagent(SUBAGENT_ID, { hard: true })).toBe(true);

			expect(ctrl.signal.aborted).toBe(true);
			expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(true);
			expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(false);
		});

		test("parent cleanup does not interrupt a primary narrator fork", async () => {
			const parentId = "fork-parent-interrupt-test";
			const primaryChildId = "fork-primary-child-interrupt-test";
			const subagentChildId = "subagent-child-interrupt-test";
			const now = new Date().toISOString();

			await db.insert(narrators).values([
				{
					id: parentId,
					variant: "primary",
					status: "working",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: primaryChildId,
					variant: "primary",
					type: "primary",
					parentNarratorId: parentId,
					status: "working",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: subagentChildId,
					variant: "subagent:general",
					type: "subagent",
					parentNarratorId: parentId,
					status: "working",
					createdAt: now,
					updatedAt: now,
				},
			]);

			try {
				// The subagent is named explicitly (the recovery path's contract); the primary
				// fork shares the same parent but is not a subagent and must survive.
				await interruptForegroundSubagentsForParent(parentId, [primaryChildId, subagentChildId]);

				const rows = sqlite
					.prepare("SELECT id, status FROM narrators WHERE id IN (?, ?)")
					.all(primaryChildId, subagentChildId) as Array<{ id: string; status: string }>;
				const statusById = new Map(rows.map((row) => [row.id, row.status]));

				expect(statusById.get(primaryChildId)).toBe("working");
				expect(statusById.get(subagentChildId)).toBe("idle");
			} finally {
				sqlite
					.prepare("DELETE FROM narrators WHERE id IN (?, ?)")
					.run(primaryChildId, subagentChildId);
				sqlite.prepare("DELETE FROM narrators WHERE id = ?").run(parentId);
			}
		});

		/**
		 * Regression: stopping a parent used to interrupt every foreground subagent that
		 * shared its `parentNarratorId`, which swept up children the user was driving
		 * themselves from a side panel. Membership is now per Agent tool call: an entry
		 * qualifies because ITS OWN parent signal aborted, which is exactly the set of
		 * calls the parent's interrupt cancelled — one or many.
		 */
		describe("scope of the parent interrupt fan-out", () => {
			const parentId = "fanout-parent";

			function seedEntry(subagentId: string, parentSignal: AbortSignal): DetachEntry {
				const entry: DetachEntry = {
					runId: `run-${subagentId}`,
					markDetached: () => {},
					publishHandoff: () => true,
					proxy: new ProxyAbortController(),
					parentSignal,
					fgAbort: new AbortController(),
					toolUseId: `tool-${subagentId}`,
					parentNarratorId: parentId,
					subagentId,
				};
				getDetachableMap().set(subagentId, entry);
				return entry;
			}

			async function seedNarratorRows(ids: string[]) {
				const now = new Date().toISOString();
				await db.insert(narrators).values([
					{ id: parentId, variant: "primary", status: "working", createdAt: now, updatedAt: now },
					...ids.map((id) => ({
						id,
						variant: "subagent:general" as const,
						type: "subagent" as const,
						parentNarratorId: parentId,
						status: "working" as const,
						createdAt: now,
						updatedAt: now,
					})),
				]);
			}

			function cleanupNarratorRows(ids: string[]) {
				for (const id of [...ids, parentId]) {
					sqlite.prepare("DELETE FROM narrators WHERE id = ?").run(id);
				}
			}

			test("interrupts every subagent of the cancelled turn, and only those", async () => {
				// One turn started two subagents: both share the parent loop's signal, so a
				// single parent abort marks both. The third is a panel-driven continuation whose
				// run signal is independent by construction — it is nobody's pending tool call.
				const turnAbort = new AbortController();
				const first = seedEntry("fanout-turn-a", turnAbort.signal);
				const second = seedEntry("fanout-turn-b", turnAbort.signal);
				const independent = seedEntry("fanout-independent", new AbortController().signal);
				const ids = [first.subagentId, second.subagentId, independent.subagentId];
				await seedNarratorRows(ids);

				try {
					turnAbort.abort("Parent narrator interrupted");
					expect(await interruptForegroundSubagentsForParent(parentId)).toBe(2);

					expect(first.fgAbort.signal.aborted).toBe(true);
					expect(second.fgAbort.signal.aborted).toBe(true);
					expect(independent.fgAbort.signal.aborted).toBe(false);

					const rows = sqlite
						.prepare("SELECT id, status FROM narrators WHERE id IN (?, ?, ?)")
						.all(...ids) as Array<{ id: string; status: string }>;
					const statusById = new Map(rows.map((row) => [row.id, row.status]));
					expect(statusById.get(first.subagentId)).toBe("idle");
					expect(statusById.get(second.subagentId)).toBe("idle");
					// The whole point: the panel session keeps running.
					expect(statusById.get(independent.subagentId)).toBe("working");
				} finally {
					cleanupNarratorRows(ids);
				}
			});

			test("an explicitly named subagent is interrupted even with a live parent signal", async () => {
				// The recovery path re-drives a foreground Agent on its own signal, so the
				// aborted-signal test cannot see it; its owner names it instead.
				const named = seedEntry("fanout-named", new AbortController().signal);
				const other = seedEntry("fanout-not-named", new AbortController().signal);
				const ids = [named.subagentId, other.subagentId];
				await seedNarratorRows(ids);

				try {
					expect(await interruptForegroundSubagentsForParent(parentId, [named.subagentId])).toBe(1);

					expect(named.fgAbort.signal.aborted).toBe(true);
					expect(other.fgAbort.signal.aborted).toBe(false);
				} finally {
					cleanupNarratorRows(ids);
				}
			});

			test("a live turn with no cancelled tool call interrupts nothing", async () => {
				const running = seedEntry("fanout-still-running", new AbortController().signal);
				const ids = [running.subagentId];
				await seedNarratorRows(ids);

				try {
					expect(await interruptForegroundSubagentsForParent(parentId)).toBe(0);
					expect(running.fgAbort.signal.aborted).toBe(false);
				} finally {
					cleanupNarratorRows(ids);
				}
			});

			test("a named id belonging to another parent is refused", async () => {
				// Ownership is re-checked against the DB so a mistaken id cannot let one
				// parent reach into another's child.
				const foreignParentId = "fanout-foreign-parent";
				const foreignChildId = "fanout-foreign-child";
				const now = new Date().toISOString();
				await db.insert(narrators).values([
					{
						id: foreignParentId,
						variant: "primary",
						status: "working",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: foreignChildId,
						variant: "subagent:general",
						type: "subagent",
						parentNarratorId: foreignParentId,
						status: "working",
						createdAt: now,
						updatedAt: now,
					},
				]);

				try {
					expect(await interruptForegroundSubagentsForParent(parentId, [foreignChildId])).toBe(0);
					const row = sqlite
						.prepare("SELECT status FROM narrators WHERE id = ?")
						.get(foreignChildId) as { status: string };
					expect(row.status).toBe("working");
				} finally {
					sqlite
						.prepare("DELETE FROM narrators WHERE id IN (?, ?)")
						.run(foreignChildId, foreignParentId);
				}
			});
		});

		test("manual override can resume the original foreground runner", async () => {
			const parentCtrl = new AbortController();
			const waiting = waitForManualOverride(
				SUBAGENT_ID,
				parentCtrl.signal,
				"parent-narrator",
				"tool-use-id",
			);

			expect(
				resumeManualOverride(SUBAGENT_ID, {
					prompt: "continue the investigation",
					history: [{ role: "user" }],
					trailingToolResults: [],
					userId: "user-1",
				}),
			).toBe(true);
			await expect(waiting).resolves.toEqual({
				action: "resume",
				prompt: "continue the investigation",
				history: [{ role: "user" }],
				trailingToolResults: [],
				userId: "user-1",
			});
			expect(getManualOverrideRuntime(SUBAGENT_ID)).toBeUndefined();
		});

		test("hard interrupt resolves manual override as interrupted", async () => {
			const parentCtrl = new AbortController();
			const waiting = waitForManualOverride(
				SUBAGENT_ID,
				parentCtrl.signal,
				"parent-narrator",
				"tool-use-id",
			);

			expect(interruptForegroundSubagent(SUBAGENT_ID, { hard: true })).toBe(true);

			await expect(waiting).resolves.toEqual({
				action: "finish",
				finalText: "Subagent interrupted by user",
				hasError: false,
				interrupted: true,
			});
			expect(getManualOverrideRuntime(SUBAGENT_ID)).toBeUndefined();
			expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(false);
		});

		test("parent abort during a resume claim records terminal and defeats the resume", async () => {
			const parentCtrl = new AbortController();
			const waiting = waitForManualOverride(
				SUBAGENT_ID,
				parentCtrl.signal,
				"parent-narrator",
				"tool-use-id",
			);
			const claim = claimManualOverride(SUBAGENT_ID, "resume");
			expect(claim).not.toBeNull();
			if (!claim) throw new Error("expected resume claim");

			parentCtrl.abort();
			expect(getManualOverrideRuntime(SUBAGENT_ID)?.pendingTerminal).toMatchObject({
				action: "finish",
				finalText: "Parent narrator interrupted",
			});
			expect(
				settleManualOverrideClaim(claim, {
					action: "resume",
					prompt: "too late",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			await expect(waiting).resolves.toMatchObject({
				action: "finish",
				finalText: "Parent narrator interrupted",
			});
		});

		test("timeout during a claim is deferred and then settled as terminal", async () => {
			const waiting = waitForManualOverride(
				SUBAGENT_ID,
				new AbortController().signal,
				"parent-narrator",
				"tool-use-id",
				{ timeoutMs: 5 },
			);
			const claim = claimManualOverride(SUBAGENT_ID, "detach");
			expect(claim).not.toBeNull();
			if (!claim) throw new Error("expected detach claim");
			await Bun.sleep(10);
			expect(getManualOverrideRuntime(SUBAGENT_ID)?.pendingTerminal).toMatchObject({
				action: "finish",
				hasError: true,
			});
			settleManualOverrideClaim(claim, {
				action: "finish",
				finalText: "detach finished",
				hasError: false,
			});
			await expect(waiting).resolves.toMatchObject({
				action: "finish",
				finalText: "Manual override timed out after 2 hours",
				hasError: true,
			});
		});

		test("an old timeout callback cannot delete a replacement runtime", async () => {
			const first = waitForManualOverride(
				SUBAGENT_ID,
				new AbortController().signal,
				"parent-narrator",
				"tool-use-id",
				{ timeoutMs: 5 },
			);
			expect(
				resumeManualOverride(SUBAGENT_ID, {
					prompt: "finish before old timer",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			await first;

			const replacement = waitForManualOverride(
				SUBAGENT_ID,
				new AbortController().signal,
				"parent-narrator",
				"tool-use-id-2",
			);
			const replacementId = getManualOverrideRuntime(SUBAGENT_ID)?.entryId;
			await Bun.sleep(10);
			expect(getManualOverrideRuntime(SUBAGENT_ID)?.entryId).toBe(replacementId);
			expect(
				resumeManualOverride(SUBAGENT_ID, {
					prompt: "replacement survives",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			await replacement;
		});

		test("cleanup guarded by an old entry id cannot delete a replacement runtime", async () => {
			const first = waitForManualOverride(
				SUBAGENT_ID,
				new AbortController().signal,
				"parent-narrator",
				"tool-use-id",
			);
			const oldEntryId = getManualOverrideRuntime(SUBAGENT_ID)?.entryId as string;
			expect(
				resumeManualOverride(SUBAGENT_ID, {
					prompt: "first",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			await first;

			const replacement = waitForManualOverride(
				SUBAGENT_ID,
				new AbortController().signal,
				"parent-narrator",
				"tool-use-id-2",
			);
			const replacementRuntime = getManualOverrideRuntime(SUBAGENT_ID);
			if (!replacementRuntime) throw new Error("expected replacement runtime");
			const replacementId = replacementRuntime.entryId;
			expect(replacementId).not.toBe(oldEntryId);
			expect(
				listStaleManualOverrideRuntimes(0, replacementRuntime?.createdAt ?? Date.now()),
			).toContainEqual({ subagentId: SUBAGENT_ID, entryId: replacementId, phase: "waiting" });
			expect(cleanupManualOverrideRuntime(SUBAGENT_ID, oldEntryId)).toBe(false);
			expect(getManualOverrideRuntime(SUBAGENT_ID)?.entryId).toBe(replacementId);
			expect(
				resumeManualOverride(SUBAGENT_ID, {
					prompt: "replacement",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			await replacement;
		});
	});
}
