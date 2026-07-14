import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const {
	consumeForegroundSubagentHardInterrupt,
	getForegroundAbortControllers,
	interruptForegroundSubagent,
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

const SUBAGENT_ID = "subagent-interrupt-test";

afterEach(() => {
	getForegroundAbortControllers().clear();
	clearManualOverrideRuntimes();
	consumeForegroundSubagentHardInterrupt(SUBAGENT_ID);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("foreground subagent interrupt semantics", () => {
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
