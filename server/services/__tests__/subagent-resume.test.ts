/**
 * Continuing a delegated session after its first run: every entry (user follow-up, Send
 * wake, retry, denied-tool retry, edit, recovery) is the ordinary session entry, and its
 * run delivers to the destination the session registered — exactly once, through the
 * one run finalizer. There is no separate "resume" engine, manual-override runner, or
 * suspended-runner hand-off: a user hold is a run hold (`controlRun`), and input wakes
 * that same run. The model pass and explicit restore-result faults are scripted;
 * database, run service, publication and the session entries are real.
 *
 * Replaces the deleted resumeSubagent / subagent-manual-override contract tests. Each
 * behavioural guarantee those tests carried is kept below against the unified entries.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { modelInputText, rowsAsHistory } from "../../../tests/fixtures/model-input";
import { cleanDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	runtimePublicationOutbox,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";

// The snapshot worker shares the preload-isolated file-backed database.
const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");
const executor = await import("../narrator-executor");
const runModule = await import("../agent-runtime/run");
const { controlRun, startNarratorRun } = runModule;
const { getExecutionOwner, getRunControl, getRunHold, setRunHold } = await import(
	"../agent-runtime/ownership"
);
const { enqueueInboxAgent, wakeInboxIfEligible } = await import("../agent-runtime/inbox");
const { createAgentMessageDelivery } = await import("../agent-message-delivery");
const session = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const { narratorService } = await import("../narrator-service");
const scopedRevert = await import("../narrator-scoped-revert");
const { emptyRevertResult, SnapshotRevertError } = await import("../snapshot-revert");

const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Resume test must never call a model");
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "test" ? provider : null),
	listReadiness: () => [],
});

const PARENT = "resume-parent";
const CHILD = "resume-child";
const ORIGIN = "origin-agent-call";
const ORIGIN_ROW = "origin-agent-row";
const NOW = "2026-09-30T00:00:00.000Z";
let cwd: string;
let seq = 0;

/** What each scripted model pass received as its current input. */
const passes: string[] = [];
/** Scripted pass outcomes, consumed in order; default: one reply "done". */
let script: Array<() => Promise<{ finalText: string; hasError?: boolean }>> = [];

beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	seq = 0;
	passes.length = 0;
	script = [];
	settings.agent.autoContinuationMode = "off";
	cwd = mkdtempSync(join(tmpdir(), "nf-resume-"));
});
afterEach(async () => {
	await closePrefixSnapshotStore();
	for (const id of [PARENT, CHILD]) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
		setRunHold(id, undefined);
	}
	mock.restore();
	cleanDb(sqlite);
	rmSync(cwd, { recursive: true, force: true });
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	unregisterProvider();
});

const shapes = [
	{
		name: "delegated session",
		row: { type: "subagent", variant: "subagent:general", parentNarratorId: PARENT },
	},
	{ name: "session without a parent", row: { type: "primary", variant: "primary" } },
] as const;

/** A session whose last run delivered to the parent's Agent call, now idle. */
function seed(shape: (typeof shapes)[number] = shapes[0]) {
	db.insert(narrators)
		.values([
			{ id: PARENT, variant: "primary", cwd, createdAt: NOW, updatedAt: NOW },
			{
				id: CHILD,
				...shape.row,
				cwd,
				status: "idle",
				model: "test:model",
				autoContinuationOverride: "off",
				runtimeRegistrationJson: {
					version: 1,
					run: {
						logicalRunId: "first-run",
						deliverTo: {
							narratorId: PARENT,
							toolUseId: ORIGIN,
							toolCallId: ORIGIN_ROW,
							attempt: 1,
						},
						principal: { userId: null },
					},
				},
				logicalRunId: "first-run",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	db.insert(narratorMessages)
		.values({
			id: "origin-message",
			narratorId: PARENT,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: ORIGIN, name: "Agent", input: {} }],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "origin-ref", narratorId: PARENT, messageId: "origin-message", seq: 1 })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: ORIGIN_ROW,
			narratorId: PARENT,
			messageId: "origin-message",
			toolUseId: ORIGIN,
			toolName: "Agent",
			inputJson: {},
			outputJson: "FIRST RESULT",
			status: "success",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			createdAt: NOW,
		})
		.run();
	message("task", "user", "the task", ORIGIN);
	message("first-reply", "assistant", "first answer", ORIGIN);
}

function message(
	id: string,
	role: "user" | "assistant",
	text: string,
	parentToolUseId: string | null,
	blocks: unknown[] = [{ type: "text", text }],
) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: CHILD,
			role,
			contentText: text,
			contentJson: blocks,
			parentToolUseId,
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId: CHILD, messageId: id, seq: seq++ })
		.run();
	// Raw fixture rows bypass the seq allocator; keep its counter ahead of them.
	db.update(narrators).set({ nextSeq: seq }).where(eq(narrators.id, CHILD)).run();
}

/**
 * Script the model boundary only: the real orchestrator runs (holds, boundaries,
 * placement); each pass records what it gives the model and returns a reply.
 */
function scriptPasses() {
	return spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
		passes.push(modelInputText(options));
		const step = script.shift();
		const outcome = step ? await step() : { finalText: "done" };
		if (!outcome.hasError)
			message(`reply-${passes.length}`, "assistant", outcome.finalText, ORIGIN);
		return { finalText: outcome.finalText, hasError: !!outcome.hasError, shouldUpdateTitle: false };
	});
}

const toolOutput = () =>
	db.select().from(narratorToolCalls).where(eq(narratorToolCalls.id, ORIGIN_ROW)).get()?.outputJson;

/** The parent's Send: a receipted tool call of the parent session. */
function sendCall() {
	db.insert(narratorMessages)
		.values({
			id: "send-msg",
			narratorId: PARENT,
			role: "assistant",
			contentJson: [],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "send-call",
			narratorId: PARENT,
			messageId: "send-msg",
			toolUseId: "send-use",
			toolName: "Send",
			status: "running",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			createdAt: NOW,
		})
		.run();
}

const task = () => db.select().from(backgroundTasks).where(eq(backgroundTasks.id, CHILD)).get();

async function settle(condition: () => boolean) {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(condition()).toBe(true);
}

for (const shape of shapes) {
	describe(`follow-up of a ${shape.name}`, () => {
		test("a follow-up run no caller waits for delivers once, through a task row", async () => {
			seed(shape);
			scriptPasses();
			script = [async () => ({ finalText: "second answer" })];
			await session.acceptUserMessage(CHILD, "follow up", { locale: "en", userId: null });
			await settle(() => passes.length === 1 && !getExecutionOwner(CHILD));
			await settle(() => task()?.status === "completed");
			expect(task()).toMatchObject({ parentNarratorId: PARENT, toolUseId: ORIGIN });
			expect(String(task()?.output).match(/second answer/g)).toHaveLength(1);
			// The call's result was delivered by the first run and is never rewritten.
			expect(toolOutput()).toBe("FIRST RESULT");
			expect(passes[0]).toContain("follow up");
			// The follow-up is a turn of this session, placed under the same destination.
			const turn = db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.contentText, "follow up"))
				.get();
			expect(turn?.parentToolUseId).toBe(ORIGIN);
			// Exactly one terminal publication for the new run.
			// Nothing is left owed for the new run: its terminal was published, once.
			const owed = db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.filter((row) => row.taskId === CHILD && row.state === "reserved");
			expect(owed).toHaveLength(0);
		});

		test("a Send wake of the ended session runs as a background task Stop can reach", async () => {
			seed(shape);
			const gate = Promise.withResolvers<void>();
			scriptPasses();
			script = [
				async () => {
					await gate.promise;
					return { finalText: "sent answer" };
				},
			];
			sendCall();
			const delivery = createAgentMessageDelivery(
				CHILD,
				{ id: PARENT, title: "Parent", label: "parent", type: "primary", isParent: true },
				"send-use",
				"one more thing",
				{ toolCallId: "send-call", attempt: 1 },
			);
			await enqueueInboxAgent(delivery, delivery.text, { createdBy: null, userId: null });
			expect(await wakeInboxIfEligible(CHILD)).toBe(true);
			await settle(() => passes.length === 1);
			expect(task()?.status).toBe("running");
			expect(task()?.logicalRunId).toBe(getRunControl(CHILD)?.logicalRunId);
			expect(db.select().from(narrators).where(eq(narrators.id, CHILD)).get()).toMatchObject({
				isBackground: true,
				backgroundStatus: "running",
			});
			gate.resolve();
			await settle(() => task()?.status === "completed");
			expect(toolOutput()).toBe("FIRST RESULT");
		});

		test("a second start while a run is executing is refused, not run twice", async () => {
			seed(shape);
			const gate = Promise.withResolvers<void>();
			scriptPasses();
			script = [
				async () => {
					await gate.promise;
					return { finalText: "only answer" };
				},
			];
			const first = await startNarratorRun({ narratorId: CHILD, locale: "en", text: "go" });
			const second = await startNarratorRun({ narratorId: CHILD, locale: "en", text: "again" });
			expect(first.started).toBe(true);
			expect(second.started).toBe(false);
			gate.resolve();
			await first.terminal;
			expect(passes).toHaveLength(1);
			expect(passes[0]).toContain("go");
			expect(passes[0]).not.toContain("again");
		});
	});

	describe(`retry and edit of a ${shape.name}`, () => {
		test("retry reruns the last own user turn without deleting file history", async () => {
			seed(shape);
			const path = join(cwd, "kept.txt");
			writeFileSync(path, "kept file bytes\n");
			// The last turn failed: only its user input remains at the tail.
			db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, "first-reply")).run();
			scriptPasses();
			const truncation = spyOn(narratorService, "deleteMessagesAfter");
			expect((await session.retryLastMessage(CHILD)).ok).toBe(true);
			await settle(() => passes.length === 1 && !getExecutionOwner(CHILD));
			expect(passes[0]).toContain("the task");
			// Plain retry is not consent to roll back files.
			expect(truncation.mock.calls.at(-1)?.[2]).toMatchObject({ skipRevert: true });
			expect(readFileSync(path, "utf8")).toBe("kept file bytes\n");
		});

		test("a confirmed edit returns its history advisory and uses the registered runtime destination", async () => {
			seed(shape);
			db.insert(users)
				.values({
					id: "edit-actor",
					username: "edit-actor",
					passwordHash: "test",
					role: "admin",
					createdAt: NOW,
				})
				.run();
			scriptPasses();
			const revertPlan = {
				planId: "confirmed-edit-plan",
				planHash: "a".repeat(64),
				action: "edit_and_regenerate" as const,
			};
			// Fault injection at the restore boundary only: file/plan execution is covered
			// by narrator-scoped-revert.test; this suite keeps the unified run service real.
			const revertResult = {
				...emptyRevertResult(),
				planId: revertPlan.planId,
				historyCommitted: true,
				historyStatus: "unavailable" as const,
			};
			const restore = spyOn(scopedRevert, "revertNarratorScopedForEdit").mockResolvedValue(
				revertResult,
			);
			const start = spyOn(runModule, "startNarratorRun");
			const result = await session.editAndRegenerate(
				CHILD,
				"task",
				"confirmed edited task",
				"en",
				false,
				{
					userId: "edit-actor",
					revertPlan,
				},
			);
			expect(result).toEqual({ ok: true, revertResult });
			expect(restore).toHaveBeenCalledWith(CHILD, "task", 0, {
				principal: { userId: "edit-actor", isAdmin: true },
				revertPlan,
			});
			await settle(() => passes.length === 1 && !getExecutionOwner(CHILD));
			await settle(() => task()?.status === "completed");
			expect(start).toHaveBeenCalledTimes(1);
			expect(start.mock.calls[0][0]).toMatchObject({ narratorId: CHILD, principal: "edit-actor" });
			expect(passes[0]).toContain("confirmed edited task");
			expect(task()).toMatchObject({ parentNarratorId: PARENT, toolUseId: ORIGIN });
			expect(toolOutput()).toBe("FIRST RESULT");
		});

		test("a partial edit restore does not start a unified run or replace the user's input", async () => {
			seed(shape);
			db.insert(users)
				.values({
					id: "edit-actor",
					username: "edit-actor",
					passwordHash: "test",
					role: "admin",
					createdAt: NOW,
				})
				.run();
			scriptPasses();
			const start = spyOn(runModule, "startNarratorRun");
			const revertResult = {
				...emptyRevertResult(),
				status: "partial" as const,
				historyCommitted: false,
			};
			spyOn(scopedRevert, "revertNarratorScopedForEdit").mockResolvedValue(revertResult);
			await expect(
				session.editAndRegenerate(CHILD, "task", "must not save", "en", false, {
					userId: "edit-actor",
					revertPlan: {
						planId: "confirmed-edit-plan",
						planHash: "a".repeat(64),
						action: "edit_and_regenerate",
					},
				}),
			).rejects.toBeInstanceOf(SnapshotRevertError);
			expect(start).not.toHaveBeenCalled();
			expect(passes).toHaveLength(0);
			expect(
				db.select().from(narratorMessages).where(eq(narratorMessages.id, "task")).get()
					?.contentText,
			).toBe("the task");
			expect(toolOutput()).toBe("FIRST RESULT");
		});

		test("an edit regenerates through the same session path and keeps the user's revert choice", async () => {
			seed(shape);
			scriptPasses();
			const truncation = spyOn(narratorService, "deleteMessagesAfter");
			const result = await session.editAndRegenerate(CHILD, "task", "edited task", "en", false, {
				revertFiles: false,
			});
			expect(result.ok).toBe(true);
			await settle(() => passes.length === 1 && !getExecutionOwner(CHILD));
			expect(passes[0]).toContain("edited task");
			for (const call of truncation.mock.calls) expect(call[2]).toMatchObject({ skipRevert: true });
		});
	});
}

describe("a revert reserves the session against every entry", () => {
	test("retry and a run start refuse while a revert holds the session", async () => {
		seed();
		scriptPasses();
		const release = await session.acquireNarratorRevertAdmission(CHILD, {
			signal: new AbortController().signal,
			interrupt: false,
		});
		try {
			await expect(session.retryLastMessage(CHILD)).rejects.toMatchObject({
				statusCode: 409,
				code: "NARRATOR_REVERT_IN_PROGRESS",
			});
			// Refused at start or by its admitted work: either way no pass runs.
			const refusal = await startNarratorRun({ narratorId: CHILD, locale: "en", text: "go" })
				.then((handle) => handle.completion)
				.then(
					() => null,
					(error: unknown) => error,
				);
			expect(refusal).toMatchObject({ statusCode: 409, code: "NARRATOR_REVERT_IN_PROGRESS" });
		} finally {
			release();
		}
		expect(passes).toHaveLength(0);
	});

	test("an executing run keeps the session busy for a non-interrupting revert", async () => {
		seed();
		const gate = Promise.withResolvers<void>();
		scriptPasses();
		script = [
			async () => {
				await gate.promise;
				return { finalText: "answer" };
			},
		];
		const handle = await startNarratorRun({ narratorId: CHILD, locale: "en", text: "go" });
		await settle(() => passes.length === 1);
		await expect(
			session.acquireNarratorRevertAdmission(CHILD, {
				signal: new AbortController().signal,
				interrupt: false,
			}),
		).rejects.toMatchObject({ code: "NARRATOR_REVERT_BUSY" });
		gate.resolve();
		await handle.terminal;
	});
});

describe("a held run (user takeover) is continued in place", () => {
	test("input wakes the same held run; release then delivers its result once", async () => {
		seed();
		scriptPasses();
		script = [async () => ({ finalText: "turn one" }), async () => ({ finalText: "turn two" })];
		await controlRun(CHILD, { kind: "hold" });
		const handle = await startNarratorRun({ narratorId: CHILD, locale: "en", text: "go" });
		// The first turn ends at the hold: nothing is delivered yet.
		await settle(() => passes.length === 1);
		await settle(() => getExecutionOwner(CHILD) !== undefined && toolOutput() === "FIRST RESULT");
		// The user's input wakes THAT run; no second run starts.
		await session.acceptUserMessage(CHILD, "keep going", { locale: "en", userId: null });
		await settle(() => passes.length === 2);
		expect(passes[1]).toContain("keep going");
		expect(toolOutput()).toBe("FIRST RESULT");
		await controlRun(CHILD, { kind: "release" });
		const terminal = await handle.terminal;
		expect(terminal.finalText).toContain("turn two");
		await settle(() => String(task()?.output).includes("turn two"));
		expect(String(task()?.output)).not.toContain("turn one");
		expect(getRunHold(CHILD)).toBeUndefined();
	});

	test("a parent Send wakes the parked held run itself: same run, one row, mailbox drained", async () => {
		seed();
		scriptPasses();
		script = [async () => ({ finalText: "turn one" }), async () => ({ finalText: "turn two" })];
		await controlRun(CHILD, { kind: "hold" });
		const handle = await startNarratorRun({
			narratorId: CHILD,
			locale: "en",
			text: "go",
			binding: {
				deliverTo: { narratorId: PARENT, toolUseId: ORIGIN, toolCallId: ORIGIN_ROW, attempt: 1 },
				principal: { userId: null },
			},
		});
		await settle(() => passes.length === 1 && !!getRunControl(CHILD)?.wake);
		const owner = getExecutionOwner(CHILD);
		const run = getRunControl(CHILD);
		const logicalRunId = run?.logicalRunId;
		expect(owner).toBeDefined();
		expect(logicalRunId).toBeTruthy();
		const starts = spyOn(runModule, "startNarratorRun");
		// The parent's Send: a receipted tool call of the parent session.
		const text = "parent says: also check the edge case";
		sendCall();
		const delivery = createAgentMessageDelivery(
			CHILD,
			{ id: PARENT, title: "Parent", label: "parent", type: "primary", isParent: true },
			"send-use",
			text,
			{ toolCallId: "send-call", attempt: 1 },
		);
		await enqueueInboxAgent(delivery, delivery.text, { createdBy: null, userId: null });
		expect(await wakeInboxIfEligible(CHILD)).toBe(true);
		await settle(() => passes.length === 2);
		// The same logical run and the same owner executed the woken pass.
		expect(passes[1]).toContain(text);
		expect(getExecutionOwner(CHILD)).toBe(owner);
		expect(getRunControl(CHILD)).toBe(run);
		expect(getRunControl(CHILD)?.logicalRunId).toBe(logicalRunId);
		expect(starts).not.toHaveBeenCalled();
		// Exactly one row in the child session, nothing left queued.
		const rows = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, CHILD))
			.all()
			.filter((row) => JSON.stringify(row.contentJson).includes(text));
		expect(rows).toHaveLength(1);
		await settle(() => !!getRunControl(CHILD)?.wake);
		const queued = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.narratorId, CHILD))
			.all()
			.filter((row) => row.state === "queued");
		expect(queued).toHaveLength(0);
		await controlRun(CHILD, { kind: "release" });
		expect((await handle.terminal).logicalRunId).toBe(logicalRunId);
	});

	test("a late abort of the parked turn's controller cannot reach the resumed turn", async () => {
		seed();
		const signals: AbortSignal[] = [];
		const secondGate = Promise.withResolvers<void>();
		const spy = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
			passes.push(modelInputText(options));
			if (options.config.signal) signals.push(options.config.signal);
			if (passes.length === 2) await secondGate.promise;
			const finalText = passes.length === 1 ? "turn one" : "turn two";
			message(`reply-${passes.length}`, "assistant", finalText, ORIGIN);
			return { finalText, hasError: false, shouldUpdateTitle: false };
		});
		await controlRun(CHILD, { kind: "hold" });
		const handle = await startNarratorRun({ narratorId: CHILD, locale: "en", text: "go" });
		await settle(() => passes.length === 1 && !!getRunControl(CHILD)?.wake);
		// The controller the parked turn ran under, kept by some late callback.
		const stale = activeNarrators.get(CHILD)?.abortController;
		expect(stale).toBeDefined();
		await session.acceptUserMessage(CHILD, "keep going", { locale: "en", userId: null });
		await settle(() => passes.length === 2);
		stale?.abort("late abort of the old turn");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(signals[1]?.aborted).toBe(false);
		expect(activeNarrators.get(CHILD)?.abortController.signal.aborted).toBe(false);
		expect(getRunControl(CHILD)?.cancel.signal.aborted).toBe(false);
		secondGate.resolve();
		await settle(() => !!getRunControl(CHILD)?.wake);
		await controlRun(CHILD, { kind: "release" });
		const terminal = await handle.terminal;
		expect(terminal.interrupted).toBe(false);
		expect(terminal.finalText).toContain("turn two");
		spy.mockRestore();
	});

	test("Stop during a hold stops only the current turn; the run stays held", async () => {
		seed();
		const gate = Promise.withResolvers<void>();
		scriptPasses();
		script = [
			async () => {
				await gate.promise;
				return { finalText: "stopped turn" };
			},
		];
		await controlRun(CHILD, { kind: "hold" });
		const handle = await startNarratorRun({ narratorId: CHILD, locale: "en", text: "go" });
		await settle(() => passes.length === 1);
		expect(await controlRun(CHILD, { kind: "stop" })).toBe(true);
		gate.resolve();
		await settle(() => getRunHold(CHILD) !== undefined);
		// Still held, still owed to the caller: nothing delivered.
		expect(toolOutput()).toBe("FIRST RESULT");
		await controlRun(CHILD, { kind: "cancel", reason: "test end" });
		await handle.terminal;
	});
});
