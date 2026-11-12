import { afterAll, afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { getTestDb } from "../../../tests/setup";

/*
 * Interrupt, queue and control semantics of a run that delivers to a tool call (a
 * delegated session). Every behaviour here is the generic one: the queue is the one
 * mailbox, control is `controlRun`/`cancelRunsBoundTo` on the run's owner record.
 */
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
		MAX_TURN_INTERRUPTION_RETRIES: MAX_SUBAGENT_INTERRUPTION_RETRIES,
		planTurnInterruption: planSubagentInterruption,
	} = await import("../turn-continuation-decisions");
	const {
		clearBufferedMessages,
		enqueueBufferedMessage,
		getBufferedMessages,
		removeBufferedMessage,
		reorderBufferedMessages,
		updateBufferedMessage,
	} = await import("../narrator-buffer");
	const {
		getExecutionOwner,
		getRunControl,
		getRunHold,
		setRunControl,
		setRunHold,
		tryClaimExecution,
	} = await import("../agent-runtime/ownership");
	type RunControl = import("../agent-runtime/ownership").RunControl;
	type ExecutionOwner = import("../agent-runtime/ownership").ExecutionOwner;
	const { awaitRunHold, cancelRunsBoundTo, controlRun } = await import("../agent-runtime/run");
	const { claimInboxHead, peekInbox } = await import("../agent-runtime/inbox");
	const session = await import("../narrator-session");
	const {
		acceptUserMessage,
		applyBufferedQueueModeControl,
		evaluateSoftStopRequest,
		hasPendingBufferedGuidance,
		requestBufferedMessageSoftStop,
	} = session;

	/** A user's input through the ordinary admission every session uses. */
	async function sendInput(
		text: string,
		queueMode?: "turn" | "tool" | "interrupt",
	): Promise<{ id: string }> {
		const result = await acceptUserMessage(SUBAGENT_ID, text, { queueMode, queueOnly: true });
		if (!result.buffered) throw new Error("expected the input to be queued");
		return result;
	}
	/** Queue a row directly at the mailbox (no control signal). */
	const pushRow = (text: string, position: "front" | "back" = "back") =>
		enqueueBufferedMessage(
			SUBAGENT_ID,
			text,
			undefined,
			null,
			null,
			null,
			undefined,
			position,
			undefined,
			undefined,
			"fifo",
		);

	const { activeNarrators } = await import("../narrator-session-state");
	type ActiveNarrator = import("../narrator-session-state").ActiveNarrator;
	const PARENT_ID = "subagent-interrupt-parent";
	const SUBAGENT_ID = "subagent-interrupt-test";
	db.insert(narrators)
		.values([
			{
				id: PARENT_ID,
				variant: "primary",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			{
				id: SUBAGENT_ID,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: PARENT_ID,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		])
		.run();

	/** A live session turn: its own abort, the guidance signal the loop's `shouldStop` reads. */
	function liveTurn(id = SUBAGENT_ID): ActiveNarrator & {
		abortController: AbortController;
		_guidanceAbortController: AbortController;
	} {
		const active = {
			narratorId: id,
			alive: true,
			_loopRunning: true,
			locale: "en",
			abortController: new AbortController(),
			_guidanceAbortController: new AbortController(),
			_urgentGuidanceAbortController: new AbortController(),
		} as unknown as ActiveNarrator & {
			abortController: AbortController;
			_guidanceAbortController: AbortController;
		};
		activeNarrators.set(id, active);
		return active;
	}

	/** A run in flight on the owner record, the way `startNarratorRun` mounts it. */
	function mountRun(
		id: string,
		relations: Partial<Pick<RunControl, "cancelWith" | "deliverTo" | "waiter">> = {},
	): { owner: ExecutionOwner; run: RunControl } {
		const owner = tryClaimExecution(id, "run");
		if (!owner) throw new Error(`expected a free execution slot for ${id}`);
		const run: RunControl = {
			startedAt: Date.now(),
			cancel: new AbortController(),
			timedOut: false,
			terminal: new Promise(() => {}),
			deliverTo: { narratorId: PARENT_ID, toolUseId: `tool-${id}` },
			...relations,
		};
		setRunControl(owner, run);
		return { owner, run };
	}

	/** What the loop's `shouldStop` callback decides at a tool boundary for this session. */
	function boundaryStops(id = SUBAGENT_ID): boolean {
		const active = activeNarrators.get(id);
		if (!active) return false;
		const decision = evaluateSoftStopRequest({
			feedbackSoftStop: active._feedbackSoftStop,
			bufferSoftStop: active._bufferSoftStop,
			hasPendingBufferedWork: hasPendingBufferedGuidance(id),
		});
		active._bufferSoftStop = decision.bufferSoftStop;
		return decision.stop;
	}

	afterEach(async () => {
		for (const id of [SUBAGENT_ID]) {
			getExecutionOwner(id)?.release();
			activeNarrators.delete(id);
			setRunHold(id, undefined);
		}
		await clearBufferedMessages(SUBAGENT_ID);
	});

	afterAll(() => {
		mock.module("../../db", () => realDbModule);
		mock.restore();
	});

	describe("interrupted pass planning", () => {
		test("plans a resumable-error continuation prompt instead of terminating", async () => {
			expect(
				planSubagentInterruption(
					{
						interrupted: true,
						interruptedReason: "resumable_error",
						shouldReplayInterruptedToolResultTurn: false,
						finalText: "partial output",
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
						finalText: "partial output",
					},
					1,
				),
			).toEqual({ action: "replay", retries: 2, reason: "completion_limit" });
		});

		test("bounds repeated interrupted continuations and resets after success", async () => {
			expect(
				planSubagentInterruption(
					{ interrupted: true, interruptedReason: "resumable_error", finalText: "partial output" },
					MAX_SUBAGENT_INTERRUPTION_RETRIES,
				),
			).toEqual({
				action: "stop",
				retries: MAX_SUBAGENT_INTERRUPTION_RETRIES + 1,
				reason: "resumable_error",
			});
			expect(
				planSubagentInterruption({ interrupted: false, finalText: "partial output" }, 2),
			).toEqual({
				action: "none",
				retries: 0,
			});
		});
	});

	describe("queued input order and safe-boundary requests", () => {
		test("ordinary buffered messages preserve FIFO arrival order", async () => {
			await pushRow("first");
			await pushRow("second");
			await pushRow("third");

			expect(getBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"first",
				"second",
				"third",
			]);
		});

		test("priority messages move ahead without reversing each other", async () => {
			await pushRow("ordinary-1");
			await pushRow("priority-1", "front");
			await pushRow("priority-2", "front");
			await pushRow("ordinary-2");

			expect(getBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"priority-1",
				"priority-2",
				"ordinary-1",
				"ordinary-2",
			]);
		});

		test("tool-mode input preserves FIFO and stops the running turn at its next tool boundary", async () => {
			const active = liveTurn();
			await sendInput("first", "tool");
			await sendInput("second", "tool");

			expect(getBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"first",
				"second",
			]);
			// The guidance signal ends a streaming request; the boundary check stops the turn.
			expect(active._guidanceAbortController.signal.aborted).toBe(true);
			expect(boundaryStops()).toBe(true);
			// The turn itself is not cancelled: only the next safe boundary is requested.
			expect(active.abortController.signal.aborted).toBe(false);
		});

		test("explicit turn stays FIFO and waits for natural completion", async () => {
			const active = liveTurn();
			await sendInput("first", "turn");
			await sendInput("second", "turn");
			const messages = getBufferedMessages(SUBAGENT_ID);
			expect(messages.map((message) => message.text)).toEqual(["first", "second"]);
			expect(messages.map((message) => message.queueMode)).toEqual(["turn", "turn"]);
			expect(active._guidanceAbortController.signal.aborted).toBe(false);
			expect(boundaryStops()).toBe(false);
		});

		test("tool guidance only cancels the guidance channel and preserves the run", async () => {
			const active = liveTurn();
			const { run, owner } = mountRun(SUBAGENT_ID);
			await sendInput("feedback", "tool");
			expect(active._bufferSoftStop).toBe(true);
			expect(boundaryStops()).toBe(true);
			expect(active._guidanceAbortController.signal.aborted).toBe(true);
			expect(active.abortController.signal.aborted).toBe(false);
			expect(run.cancel.signal.aborted).toBe(false);
			expect(getExecutionOwner(SUBAGENT_ID)).toBe(owner);
		});

		test("interrupt input cancels the current IO but never ends the turn's run or its caller", async () => {
			const active = liveTurn();
			const { run, owner } = mountRun(SUBAGENT_ID, {
				cancelWith: { narratorId: PARENT_ID, toolCallId: "agent-call", attempt: 1 },
			});
			await sendInput("urgent", "interrupt");
			// Provider request and tool IO are cancelled through the urgent guidance signal…
			expect(active._urgentGuidanceAbortController?.signal.aborted).toBe(true);
			expect(boundaryStops()).toBe(true);
			// …but neither the session's turn controller nor the run is cancelled, and no
			// user interrupt is recorded: the input is adopted inside the same run.
			expect(active.abortController.signal.aborted).toBe(false);
			expect(run.cancel.signal.aborted).toBe(false);
			expect(getExecutionOwner(SUBAGENT_ID)).toBe(owner);
			expect(
				(
					sqlite.query("SELECT last_stop_reason FROM narrators WHERE id = ?").get(SUBAGENT_ID) as {
						last_stop_reason: string | null;
					}
				).last_stop_reason,
			).not.toBe("user_interrupt");
			expect(getRunControl(SUBAGENT_ID)?.cancelWith?.narratorId).toBe(PARENT_ID);
		});

		test("a boundary claim waits for the interrupt; the replacement pass's guidance is never aborted", async () => {
			const active = liveTurn();
			const { owner } = mountRun(SUBAGENT_ID);
			const buffer = await import("../narrator-buffer");
			const { withNarratorMutationAdmission } = await import("../narrator-session-state");
			const original = buffer.enqueueBufferedMessage;
			const reached = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			// Barrier: hold the interrupt's enqueue inside its mutation admission.
			const barrier = spyOn(buffer, "enqueueBufferedMessage").mockImplementation(
				async (...args) => {
					reached.resolve();
					await gate.promise;
					return original(...args);
				},
			);
			const order: string[] = [];
			const oldUrgent = active._urgentGuidanceAbortController as AbortController;
			oldUrgent.signal.addEventListener("abort", () => order.push("guidance-abort"), {
				once: true,
			});
			try {
				const sent = sendInput("urgent replacement", "interrupt");
				await reached.promise;
				// The loop reaches a boundary and claims under the same admission the
				// orchestrator's consumeNextInput uses.
				let replacement: AbortController | undefined;
				const claim = withNarratorMutationAdmission(SUBAGENT_ID, async () => {
					order.push("claim");
					const row = await claimInboxHead(SUBAGENT_ID, (row) => row.kind === "user_input");
					// The next pass mounts fresh guidance channels for the adopted input.
					replacement = new AbortController();
					active._urgentGuidanceAbortController = replacement;
					active._guidanceAbortController = new AbortController();
					return row;
				});
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(order).toEqual([]);
				gate.resolve();
				await sent;
				const row = await claim;
				expect(order).toEqual(["guidance-abort", "claim"]);
				expect(row?.text).toBe("urgent replacement");
				expect(row?.claimEpoch).toBe(owner.epoch);
				await new Promise((resolve) => setTimeout(resolve, 10));
				// The interrupt meant for the old pass never lands on the new input.
				expect(replacement?.signal.aborted).toBe(false);
				expect(active._guidanceAbortController.signal.aborted).toBe(false);
				expect(active.abortController.signal.aborted).toBe(false);
			} finally {
				gate.resolve();
				barrier.mockRestore();
			}
		});

		test("new urgent input precedes older tool guidance and retains tool arrival order", async () => {
			liveTurn();
			await sendInput("turn-1", "turn");
			await sendInput("tool-1", "tool");
			await sendInput("interrupt-1", "interrupt");
			await sendInput("tool-2", "tool");
			expect(getBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"interrupt-1",
				"tool-1",
				"tool-2",
				"turn-1",
			]);
		});

		test("committed guidance is claimed in FIFO by the run's own owner", async () => {
			const { owner } = mountRun(SUBAGENT_ID);
			await sendInput("first", "tool");
			await sendInput("second", "tool");
			const first = await claimInboxHead(SUBAGENT_ID, (row) => row.kind === "user_input");
			expect(first?.text).toBe("first");
			expect(first?.claimEpoch).toBe(owner.epoch);
			expect((await peekInbox(SUBAGENT_ID))?.text).toBe("second");
		});

		test("a queued next step is not claimed by a boundary that only adopts guidance", async () => {
			mountRun(SUBAGENT_ID);
			liveTurn();
			await sendInput("after completion", "turn");
			requestBufferedMessageSoftStop(SUBAGENT_ID);
			// A stop request with only a next step queued is dropped at the boundary.
			expect(boundaryStops()).toBe(false);
			expect(getBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
				"after completion",
			]);
		});

		test("mode downgrade clears only when no queued guidance remains", async () => {
			const active = liveTurn();
			await sendInput("guide", "tool");
			applyBufferedQueueModeControl(SUBAGENT_ID, "turn", true, true);
			expect(active._bufferSoftStop).toBe(true);
			applyBufferedQueueModeControl(SUBAGENT_ID, "turn", false, true);
			expect(active._bufferSoftStop).toBe(false);
		});

		test("failed mode target cannot cancel a pass even with other queued guidance", () => {
			const active = liveTurn();
			applyBufferedQueueModeControl(SUBAGENT_ID, "interrupt", true, false);
			expect(active._guidanceAbortController.signal.aborted).toBe(false);
			expect(active.abortController.signal.aborted).toBe(false);
		});

		test("rejected admission never cancels a running child", async () => {
			const active = liveTurn();
			await expect(sendInput("x".repeat(2 * 1024 * 1024 + 1), "interrupt")).rejects.toThrow(
				"Buffered input exceeds size limit",
			);
			expect(active._guidanceAbortController.signal.aborted).toBe(false);
			expect(active.abortController.signal.aborted).toBe(false);
			expect(getBufferedMessages(SUBAGENT_ID)).toEqual([]);
		});

		test("mode control on an idle session does not cancel anything", () => {
			const active = liveTurn();
			active._loopRunning = false;
			applyBufferedQueueModeControl(SUBAGENT_ID, "interrupt");
			expect(active._guidanceAbortController.signal.aborted).toBe(false);
			expect(active.abortController.signal.aborted).toBe(false);
		});

		test("an omitted mode is a next step queued behind the turn, as for any session", async () => {
			const active = liveTurn();
			await sendInput("manual");

			expect(getBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual(["manual"]);
			expect(active._guidanceAbortController.signal.aborted).toBe(false);
			expect(boundaryStops()).toBe(false);
		});

		test("buffer soft-stop remains effective while queued guidance remains", async () => {
			liveTurn();
			await sendInput("first", "tool");
			await sendInput("second", "tool");
			expect(hasPendingBufferedGuidance(SUBAGENT_ID)).toBe(true);
			expect(boundaryStops()).toBe(true);
			// Re-armed for a later pass while guidance is still queued.
			requestBufferedMessageSoftStop(SUBAGENT_ID);
			expect(boundaryStops()).toBe(true);
		});

		test("clearing the queue also clears its pending guidance", async () => {
			liveTurn();
			await sendInput("queued", "tool");
			await clearBufferedMessages(SUBAGENT_ID);
			expect(hasPendingBufferedGuidance(SUBAGENT_ID)).toBe(false);
			expect(boundaryStops()).toBe(false);
		});
	});

	/**
	 * Single-message queue mutations, as reached by DELETE/PATCH /:id/buffer/:mid and
	 * the remove_buffer/update_buffer WS frames, on the one mailbox every session uses.
	 */
	describe("single-message queue mutations", () => {
		test("removing the last queued message drops its pending boundary", async () => {
			liveTurn();
			const queued = await sendInput("only", "tool");

			expect(await removeBufferedMessage(SUBAGENT_ID, queued.id)).toBe(true);

			expect(getBufferedMessages(SUBAGENT_ID)).toEqual([]);
			// A stale soft stop would end the next turn with nothing left to resume.
			expect(boundaryStops()).toBe(false);
		});

		test("removing one of several messages keeps the rest and the soft stop", async () => {
			liveTurn();
			const first = await sendInput("first", "tool");
			await sendInput("second", "tool");

			expect(await removeBufferedMessage(SUBAGENT_ID, first.id)).toBe(true);

			expect(getBufferedMessages(SUBAGENT_ID).map((m) => m.text)).toEqual(["second"]);
			expect(boundaryStops()).toBe(true);
		});

		test("unknown ids report a miss", async () => {
			await pushRow("queued");

			expect(await removeBufferedMessage(SUBAGENT_ID, "no-such-id")).toBe(false);
			expect(await updateBufferedMessage(SUBAGENT_ID, "no-such-id", "edited")).toBe(false);
			expect(await removeBufferedMessage("no-such-subagent", "no-such-id")).toBe(false);
		});

		test("editing a queued message replaces its text", async () => {
			const queued = await pushRow("before");

			expect(await updateBufferedMessage(SUBAGENT_ID, queued.id, "after")).toBe(true);

			expect(getBufferedMessages(SUBAGENT_ID).map((m) => m.text)).toEqual(["after"]);
		});

		test("reorder applies an exact permutation and rejects a mismatched id list", async () => {
			const first = await pushRow("first");
			const second = await pushRow("second");

			expect(await reorderBufferedMessages(SUBAGENT_ID, [second.id, first.id])).toBe(true);
			expect(getBufferedMessages(SUBAGENT_ID).map((m) => m.text)).toEqual(["second", "first"]);

			// A partial or foreign id list must leave the queue untouched.
			expect(await reorderBufferedMessages(SUBAGENT_ID, [first.id])).toBe(false);
			expect(await reorderBufferedMessages(SUBAGENT_ID, [second.id, "foreign"])).toBe(false);
			expect(getBufferedMessages(SUBAGENT_ID).map((m) => m.text)).toEqual(["second", "first"]);
		});
	});

	describe("run control on the owner record", () => {
		test("Stop of a plain run ends the run; Stop of a held run ends only the turn", async () => {
			const active = liveTurn();
			const { run } = mountRun(SUBAGENT_ID);
			setRunHold(SUBAGENT_ID, { released: false });
			expect(await controlRun(SUBAGENT_ID, { kind: "stop" })).toBe(true);
			expect(active.abortController.signal.aborted).toBe(true);
			expect(run.cancel.signal.aborted).toBe(false);
			expect(getRunHold(SUBAGENT_ID)).toBeDefined();

			setRunHold(SUBAGENT_ID, undefined);
			const next = liveTurn();
			expect(await controlRun(SUBAGENT_ID, { kind: "stop" })).toBe(true);
			expect(next.abortController.signal.aborted).toBe(true);
			expect(run.cancel.signal.aborted).toBe(true);
		});

		test("Stop has nothing to stop while a held run is parked", async () => {
			const { run } = mountRun(SUBAGENT_ID);
			run.wake = () => {};
			setRunHold(SUBAGENT_ID, { released: false });
			expect(await controlRun(SUBAGENT_ID, { kind: "stop" })).toBe(false);
			expect(run.cancel.signal.aborted).toBe(false);
		});

		test("cancel ends the run, wakes a parked hold and reaches the turn in flight", async () => {
			const active = liveTurn();
			const { run } = mountRun(SUBAGENT_ID);
			const woke: string[] = [];
			run.wake = (reason) => woke.push(reason);
			expect(await controlRun(SUBAGENT_ID, { kind: "cancel", reason: "test" })).toBe(true);
			expect(run.cancel.signal.aborted).toBe(true);
			expect(woke).toEqual(["cancel"]);
			expect(active.abortController.signal.aborted).toBe(true);
		});

		test("a held run parks on the same owner and resumes for input, a release or its cancellation", async () => {
			const { owner, run } = mountRun(SUBAGENT_ID);
			const { isExecutionSuspended } = await import("../agent-runtime/ownership");
			const updateStatus = (await import("../narrator-service")).narratorService;
			const realUpdate = updateStatus.updateStatus.bind(updateStatus);
			updateStatus.updateStatus = async () => ({}) as never;
			try {
				setRunHold(SUBAGENT_ID, { released: false });
				for (const reason of ["input", "release", "cancel"] as const) {
					const parked = awaitRunHold(owner, run, async () => false);
					await new Promise((resolve) => setImmediate(resolve));
					expect(isExecutionSuspended(SUBAGENT_ID)).toBe(true);
					expect(getExecutionOwner(SUBAGENT_ID)).toBe(owner);
					run.wake?.(reason);
					expect(await parked).toBe(reason);
					expect(isExecutionSuspended(SUBAGENT_ID)).toBe(false);
					expect(run.wake).toBeUndefined();
				}
			} finally {
				updateStatus.updateStatus = realUpdate;
			}
		});

		test("cancelling a held run keeps its queued input: nothing is dropped or consumed", async () => {
			const { owner, run } = mountRun(SUBAGENT_ID);
			const service = (await import("../narrator-service")).narratorService;
			const realUpdate = service.updateStatus.bind(service);
			service.updateStatus = async () => ({}) as never;
			try {
				setRunHold(SUBAGENT_ID, { released: false });
				const parked = awaitRunHold(owner, run, async () => false);
				await new Promise((resolve) => setImmediate(resolve));
				const queued = await pushRow("queued while held");
				expect(await controlRun(SUBAGENT_ID, { kind: "cancel", reason: "user cancel" })).toBe(true);
				expect(await parked).toBe("cancel");
				expect(run.cancel.signal.aborted).toBe(true);
				// The input stays queued for the session's next run, unclaimed.
				const remaining = getBufferedMessages(SUBAGENT_ID);
				expect(remaining.map((message) => message.id)).toEqual([queued.id]);
				expect(remaining[0]?.text).toBe("queued while held");
				const head = await peekInbox(SUBAGENT_ID);
				expect(head).toMatchObject({ id: queued.id, state: "queued" });
				expect(head?.claimToken ?? null).toBeNull();
			} finally {
				service.updateStatus = realUpdate;
			}
		});

		test("a parked hold has no time limit of its own", async () => {
			const { owner, run } = mountRun(SUBAGENT_ID);
			const service = (await import("../narrator-service")).narratorService;
			const realUpdate = service.updateStatus.bind(service);
			service.updateStatus = async () => ({}) as never;
			try {
				setRunHold(SUBAGENT_ID, { released: false });
				let settled = false;
				const parked = awaitRunHold(owner, run, async () => false).then((reason) => {
					settled = true;
					return reason;
				});
				// Hours of wall time never end a hold: only input, release or cancellation.
				setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(settled).toBe(false);
				expect(getExecutionOwner(SUBAGENT_ID)).toBe(owner);
				run.wake?.("release");
				expect(await parked).toBe("release");
			} finally {
				setSystemTime();
				service.updateStatus = realUpdate;
			}
		});

		test("a run already cancelled does not park", async () => {
			const { owner, run } = mountRun(SUBAGENT_ID);
			const service = (await import("../narrator-service")).narratorService;
			const realUpdate = service.updateStatus.bind(service);
			service.updateStatus = async () => ({}) as never;
			try {
				run.cancel.abort("caller interrupted");
				expect(await awaitRunHold(owner, run, async () => true)).toBe("cancel");
			} finally {
				service.updateStatus = realUpdate;
			}
		});

		test("an already released hold resumes immediately and clears after terminal settlement", async () => {
			const { owner, run } = mountRun(SUBAGENT_ID);
			const service = (await import("../narrator-service")).narratorService;
			const realUpdate = service.updateStatus.bind(service);
			service.updateStatus = async () => ({}) as never;
			const orchestrator = await import("../agent-runtime/orchestrator");
			const pass = spyOn(orchestrator, "runAgentLoopUnlocked").mockResolvedValue({
				started: true,
				finalText: "released answer",
			});
			try {
				const hold = { released: true };
				setRunHold(SUBAGENT_ID, hold);
				expect(await awaitRunHold(owner, run, async () => true)).toBe("release");
				// Returning from the wait is not terminal persistence. Keep the hold
				// until the common finalizer, which still guarantees eventual cleanup.
				expect(getRunHold(SUBAGENT_ID)).toBe(hold);
				owner.release();
				const { startNarratorRun } = await import("../agent-runtime/run");
				const handle = await startNarratorRun({
					narratorId: SUBAGENT_ID,
					locale: "en",
					text: "",
					principal: null,
					binding: { principal: { userId: null } },
					active: { narratorId: SUBAGENT_ID, locale: "en", _currentUserId: null } as ActiveNarrator,
				});
				expect((await handle.completion).finalText).toBe("released answer");
				expect(getRunHold(SUBAGENT_ID)).toBeUndefined();
			} finally {
				pass.mockRestore();
				service.updateStatus = realUpdate;
			}
		});

		test("release of a running held turn is deferred to that run's terminal", async () => {
			mountRun(SUBAGENT_ID);
			setRunHold(SUBAGENT_ID, { released: false });
			expect(await controlRun(SUBAGENT_ID, { kind: "release" })).toBe(true);
			// The hold stays so the run delivers exactly once at its own end.
			expect(getRunHold(SUBAGENT_ID)).toEqual({ released: true });
		});

		test("an old owner's release cannot clear a replacement run", () => {
			const first = mountRun(SUBAGENT_ID);
			expect(first.owner.release()).toBe(true);
			const replacement = mountRun(SUBAGENT_ID);
			expect(first.owner.release()).toBe(false);
			expect(getRunControl(SUBAGENT_ID)).toBe(replacement.run);
			expect(getExecutionOwner(SUBAGENT_ID)).toBe(replacement.owner);
		});
	});

	/**
	 * Regression: stopping a caller used to interrupt every foreground subagent that
	 * shared its `parentNarratorId`, which swept up children the user was driving
	 * themselves from a side panel. Cancellation is now an exact registered relation:
	 * a run is cancelled with its caller only when it registered that caller's attempt.
	 */
	describe("scope of caller cancellation", () => {
		const extra = ["fanout-turn-a", "fanout-turn-b", "fanout-independent", "fanout-fork"];
		afterEach(() => {
			for (const id of extra) getExecutionOwner(id)?.release();
		});

		test("cancels every run registered with the caller, and only those", () => {
			const a = mountRun("fanout-turn-a", {
				cancelWith: { narratorId: PARENT_ID, toolCallId: "call-a", attempt: 1 },
			});
			const b = mountRun("fanout-turn-b", {
				cancelWith: { narratorId: PARENT_ID, toolCallId: "call-b", attempt: 1 },
			});
			// Driven from its own page / detached: it registered no caller cancellation.
			const independent = mountRun("fanout-independent");
			// Same parent link, a primary fork: no relation either.
			const fork = mountRun("fanout-fork", { deliverTo: undefined });

			expect(cancelRunsBoundTo(PARENT_ID, "Caller interrupted")).toBe(2);

			expect(a.run.cancel.signal.aborted).toBe(true);
			expect(b.run.cancel.signal.aborted).toBe(true);
			expect(independent.run.cancel.signal.aborted).toBe(false);
			expect(fork.run.cancel.signal.aborted).toBe(false);
		});

		test("another caller's cancellation reaches none of them", () => {
			const a = mountRun("fanout-turn-a", {
				cancelWith: { narratorId: PARENT_ID, toolCallId: "call-a", attempt: 1 },
			});
			expect(cancelRunsBoundTo("fanout-foreign-parent", "Caller interrupted")).toBe(0);
			expect(a.run.cancel.signal.aborted).toBe(false);
		});

		test("a caller with no running bound attempts cancels nothing", () => {
			mountRun("fanout-independent");
			expect(cancelRunsBoundTo(PARENT_ID, "Caller interrupted")).toBe(0);
		});

		test("cancelling a parked, held bound run wakes it to end", () => {
			const a = mountRun("fanout-turn-a", {
				cancelWith: { narratorId: PARENT_ID, toolCallId: "call-a", attempt: 1 },
			});
			const woke: string[] = [];
			a.run.wake = (reason) => woke.push(reason);
			expect(cancelRunsBoundTo(PARENT_ID, "Caller interrupted")).toBe(1);
			expect(woke).toEqual(["cancel"]);
		});

		test("interrupting the caller session cancels exactly its bound runs", async () => {
			liveTurn(PARENT_ID);
			const a = mountRun("fanout-turn-a", {
				cancelWith: { narratorId: PARENT_ID, toolCallId: "call-a", attempt: 1 },
			});
			const independent = mountRun("fanout-independent");
			try {
				expect(session.interruptNarrator(PARENT_ID)).toBe(true);
				const deadline = Date.now() + 2_000;
				while (!a.run.cancel.signal.aborted && Date.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 2));
				expect(a.run.cancel.signal.aborted).toBe(true);
				expect(independent.run.cancel.signal.aborted).toBe(false);
			} finally {
				activeNarrators.delete(PARENT_ID);
			}
		});
	});
}
