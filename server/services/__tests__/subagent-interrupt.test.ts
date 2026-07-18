import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const { narrators } = await import("../../db/schema");
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const {
	consumeForegroundSubagentHardInterrupt,
	getForegroundAbortControllers,
	interruptForegroundSubagent,
	interruptForegroundSubagentsForParent,
} = await import("../subagent-detach");
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
	clearSubagentBufferedMessages,
	getSubagentBufferedMessages,
	pushSubagentBufferedMessage,
	requestSubagentBufferedMessageSoftStop,
	shouldStopSubagentForBufferedMessage,
} = await import("../subagent-executor");

const SUBAGENT_ID = "subagent-interrupt-test";

afterEach(() => {
	getForegroundAbortControllers().clear();
	clearManualOverrideRuntimes();
	consumeForegroundSubagentHardInterrupt(SUBAGENT_ID);
	clearSubagentBufferedMessages(SUBAGENT_ID);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("foreground subagent interrupt semantics", () => {
	test("ordinary buffered messages preserve FIFO arrival order", () => {
		pushSubagentBufferedMessage(SUBAGENT_ID, "first");
		pushSubagentBufferedMessage(SUBAGENT_ID, "second");
		pushSubagentBufferedMessage(SUBAGENT_ID, "third");

		expect(getSubagentBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	test("priority messages move ahead without reversing each other", () => {
		pushSubagentBufferedMessage(SUBAGENT_ID, "ordinary-1");
		pushSubagentBufferedMessage(SUBAGENT_ID, "priority-1", { position: "front" });
		pushSubagentBufferedMessage(SUBAGENT_ID, "priority-2", { position: "front" });
		pushSubagentBufferedMessage(SUBAGENT_ID, "ordinary-2");

		expect(getSubagentBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
			"priority-1",
			"priority-2",
			"ordinary-1",
			"ordinary-2",
		]);
	});

	test("shared user-message helper preserves FIFO and requests soft-stop", () => {
		bufferSubagentUserMessage(SUBAGENT_ID, "first");
		bufferSubagentUserMessage(SUBAGENT_ID, "second");

		expect(getSubagentBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
			"first",
			"second",
		]);
		expect(shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(true);
	});

	test("taken-over user messages can queue without requesting soft-stop", () => {
		bufferSubagentUserMessage(SUBAGENT_ID, "manual", { requestSoftStop: false });

		expect(getSubagentBufferedMessages(SUBAGENT_ID).map((message) => message.text)).toEqual([
			"manual",
		]);
		expect(shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(false);
	});

	test("buffer soft-stop remains active while queued messages remain", () => {
		pushSubagentBufferedMessage(SUBAGENT_ID, "first");
		pushSubagentBufferedMessage(SUBAGENT_ID, "second");
		requestSubagentBufferedMessageSoftStop(SUBAGENT_ID);

		expect(shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(true);
		expect(shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(true);
	});

	test("clearing the subagent buffer also clears its soft-stop request", () => {
		pushSubagentBufferedMessage(SUBAGENT_ID, "queued");
		requestSubagentBufferedMessageSoftStop(SUBAGENT_ID);

		clearSubagentBufferedMessages(SUBAGENT_ID);

		expect(shouldStopSubagentForBufferedMessage(SUBAGENT_ID)).toBe(false);
	});

	test("soft interrupt aborts the foreground controller without marking a hard interrupt", () => {
		const ctrl = new AbortController();
		getForegroundAbortControllers().set(SUBAGENT_ID, ctrl);

		expect(interruptForegroundSubagent(SUBAGENT_ID)).toBe(true);

		expect(ctrl.signal.aborted).toBe(true);
		expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(false);
	});

	test("hard interrupt marker is consumed exactly once", () => {
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
			await interruptForegroundSubagentsForParent(parentId);

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
