import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { backgroundTasks, narrators } from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { delegationRegistration } from "../../lib/validators/runtime-registration";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));
const { eventBus } = await import("../../lib/event-bus");
const { backgroundTaskService } = await import("../background-task-service");
const { narratorService } = await import("../narrator-service");
const { awaitAgentResultDetailed, waitForSubagentResult } = await import("../agent-communication");
const { getRuntimePublicationService, runtimePublication } = await import(
	"../agent-runtime/publication"
);
const { awaitTool, listRunningAwaits } = await import("../../lib/agent/tools/await");
const { setRunHold } = await import("../agent-runtime/ownership");
const markTakenOver = (id: string) => setRunHold(id, { released: false });
const clearTakenOver = (id: string) => setRunHold(id, undefined);
const parent = "await-receipt-parent";
const child = "await-receipt-child";
const taskId = "await-receipt-bash";
const run = {
	producerKind: "bash" as const,
	taskId,
	recipientId: parent,
	logicalRunId: "bash-run-1",
};
const agentRun = {
	producerKind: "agent" as const,
	taskId: child,
	recipientId: parent,
	logicalRunId: "agent-run-1",
};

beforeEach(async () => {
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{ id: parent, variant: "primary", type: "primary", createdAt: now, updatedAt: now },
		{
			id: child,
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: parent,
			policySourceNarratorId: parent,
			runtimeRegistrationJson: delegationRegistration(parent, "general"),
			title: "Receipt child",
			status: "idle",
			logicalRunId: agentRun.logicalRunId,
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(backgroundTasks).values({
		id: taskId,
		type: "bash",
		parentNarratorId: parent,
		status: "completed",
		output: "final needle",
		logicalRunId: run.logicalRunId,
		startedAt: now,
		createdAt: now,
		updatedAt: now,
	});
});
afterEach(() => {
	mock.restore();
	clearTakenOver(child);
	cleanDb(sqlite);
});
afterAll(() => {
	mock.module("../../db", () => realDbModule);
});
const ctx = () => ({ narratorId: parent, signal: new AbortController().signal }) as ToolContext;

function commitAgentResult(source = agentRun, output = "current final") {
	db.transaction((tx) => {
		runtimePublication.reserve(source, tx);
		runtimePublication.commit(
			{
				...source,
				eventKind: "completed",
				resultRef: runtimePublication.persistResult(source, output, tx),
				summary: "completed",
			},
			tx,
		);
	});
}

for (const type of ["agent", "bash", "question", "transfer"] as const) {
	test(`retired Await(${type}) never waits, creates a timer or consumes a completion`, async () => {
		const wait = spyOn(backgroundTaskService, "waitForCompletion");
		const text = spyOn(backgroundTaskService, "waitForText");
		const publication = await getRuntimePublicationService();
		const consume = spyOn(publication, "consumeAwaitedTerminal");
		const timer = spyOn(globalThis, "setTimeout");
		const result = await awaitTool.execute({ type, id: taskId, timeout: 600000 }, ctx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Await is retired");
		expect(wait).not.toHaveBeenCalled();
		expect(text).not.toHaveBeenCalled();
		expect(consume).not.toHaveBeenCalled();
		expect(timer).not.toHaveBeenCalled();
		expect(listRunningAwaits()).toEqual([]);
	});
}

for (const method of ["completion", "text"] as const) {
	test(`bash ${method} fast path returns a same-row terminal receipt`, async () => {
		const result =
			method === "text"
				? await backgroundTaskService.waitForText(taskId, "needle", 100)
				: await backgroundTaskService.waitForCompletion(taskId, 100);
		expect(result).toMatchObject({
			terminalResultReceived: true,
			publicationRun: run,
			output: "final needle",
		});
	});
	test(`bash ${method} event keeps old result/run even after a continuation`, async () => {
		await db
			.update(backgroundTasks)
			.set({ status: "running", output: null })
			.where(eq(backgroundTasks.id, taskId));
		const waiting =
			method === "text"
				? backgroundTaskService.waitForText(taskId, "needle", 1000)
				: backgroundTaskService.waitForCompletion(taskId, 1000);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await db
			.update(backgroundTasks)
			.set({ logicalRunId: "bash-run-2" })
			.where(eq(backgroundTasks.id, taskId));
		eventBus.emit({
			type: "background_task:completed",
			taskId,
			parentNarratorId: parent,
			taskType: "bash",
			output: "old needle",
			publicationRun: run,
		});
		expect(await waiting).toMatchObject({
			publicationRun: run,
			terminalResultReceived: true,
			output: "old needle",
		});
	});
	test(`bash ${method} subscribe recheck binds its terminal row`, async () => {
		const row = await backgroundTaskService.getById(taskId);
		if (!row) throw new Error("Missing seeded task");
		spyOn(backgroundTaskService, "getById")
			.mockResolvedValueOnce({ ...row, status: "running" })
			.mockResolvedValueOnce(row);
		const result =
			method === "text"
				? await backgroundTaskService.waitForText(taskId, "needle", 1000)
				: await backgroundTaskService.waitForCompletion(taskId, 1000);
		expect(result).toMatchObject({ publicationRun: run, terminalResultReceived: true });
	});
}

for (const cause of ["timeout", "parent"] as const) {
	test(`agent completed→restart fast path obeys ${cause} signal without leaking waiter`, async () => {
		const now = new Date().toISOString();
		await db.update(narrators).set({ isBackground: true }).where(eq(narrators.id, child));
		await db.insert(backgroundTasks).values({
			id: child,
			type: "agent",
			subagentNarratorId: child,
			parentNarratorId: parent,
			status: "completed",
			output: "OLD RESULT",
			logicalRunId: agentRun.logicalRunId,
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		const entered = Promise.withResolvers<void>();
		const realWait = backgroundTaskService.waitForCompletion.bind(backgroundTaskService);
		spyOn(backgroundTaskService, "waitForCompletion").mockImplementation(async (...args) => {
			await db
				.update(backgroundTasks)
				.set({ status: "running", logicalRunId: "restarted-run", output: null })
				.where(eq(backgroundTasks.id, child));
			entered.resolve();
			return realWait(...args);
		});
		const parentAbort = new AbortController(),
			deadline = new AbortController();
		const subscribe = spyOn(eventBus, "on");
		const unsubscribe = spyOn(eventBus, "off");
		const started = Date.now();
		const pending = awaitAgentResultDetailed({
			callerNarratorId: parent,
			id: child,
			timeoutMs: 1500,
			signal: parentAbort.signal,
			timeoutSignal: deadline.signal,
		});
		await entered.promise;
		(cause === "timeout" ? deadline : parentAbort).abort();
		const result = await pending;
		expect(result.status).toBe(cause === "timeout" ? "timeout" : "aborted");
		expect(Date.now() - started).toBeLessThan(500);
		expect(result.publicationRun).toBeUndefined();
		expect(result.terminalResultReceived).toBeUndefined();
		for (const [type, listener] of subscribe.mock.calls)
			expect(unsubscribe).toHaveBeenCalledWith(type, listener);
	});
}

test("running text match and aborted/deadline waits have no terminal receipt", async () => {
	await db.update(backgroundTasks).set({ status: "running" }).where(eq(backgroundTasks.id, taskId));
	spyOn(backgroundTaskService, "getOutputBuffer").mockReturnValue("needle");
	expect(
		(await backgroundTaskService.waitForText(taskId, "needle", 10)).terminalResultReceived,
	).toBeUndefined();
	expect((await backgroundTaskService.waitForCompletion(taskId, 1)).publicationRun).toBeUndefined();
	const controller = new AbortController();
	controller.abort();
	expect(
		(await backgroundTaskService.waitForCompletion(taskId, 10, controller.signal))
			.terminalResultReceived,
	).toBeUndefined();
});

test("foreground output read racing a continuation never guesses the later run", async () => {
	spyOn(getRuntimePublicationService(), "readAgentTerminalResult").mockImplementation(async () => {
		await db
			.update(narrators)
			.set({ logicalRunId: "agent-run-2", status: "working" })
			.where(eq(narrators.id, child));
		return { output: "old output", source: "terminal" as const };
	});
	const result = await waitForSubagentResult({ subagentId: child, recipientId: parent });
	expect(result.status).toBe("superseded");
	expect(result.output).not.toContain("old output");
	expect(result.publicationRun).toBeUndefined();
});

for (const event of ["completion", "status"] as const) {
	test(`foreground ${event} wakeup carries the completed continuation run`, async () => {
		await db
			.update(narrators)
			.set({ status: "working", logicalRunId: "agent-run-2" })
			.where(eq(narrators.id, child));
		const waiting = waitForSubagentResult({
			subagentId: child,
			recipientId: parent,
			timeoutMs: 1000,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		commitAgentResult({ ...agentRun, logicalRunId: "agent-run-2" });
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, child));
		if (event === "completion")
			eventBus.emit({
				type: "narrator:subagent_completed",
				narratorId: child,
				parentNarratorId: parent,
				toolUseId: "tool",
			});
		else eventBus.emit({ type: "narrator:status_changed", narratorId: child, status: "idle" });
		expect(await waiting).toMatchObject({
			terminalResultReceived: true,
			publicationRun: { ...agentRun, logicalRunId: "agent-run-2" },
		});
	});
}

for (const outcome of ["failed", "timeout", "cancelled"] as const) {
	test(`bash ${outcome} producer event binds the committed run`, async () => {
		db.transaction((tx) => runtimePublication.reserve(run, tx));
		await db
			.update(backgroundTasks)
			.set({ status: "running", output: null })
			.where(eq(backgroundTasks.id, taskId));
		const waiting = backgroundTaskService.waitForCompletion(taskId, 1000);
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (outcome === "failed") await backgroundTaskService.markFailed(taskId, "failure");
		else if (outcome === "timeout")
			await backgroundTaskService.markTimedOut(taskId, "execution limit");
		else await backgroundTaskService.markCancelled(taskId);
		expect(await waiting).toMatchObject({
			status: outcome === "timeout" ? "timed_out" : outcome,
			terminalResultReceived: true,
			publicationRun: run,
		});
	});
}

test("background agent fast result uses its terminal task row, not current run lookup", async () => {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			isBackground: true,
			backgroundStatus: "completed",
			backgroundResult: "narrator projection",
		})
		.where(eq(narrators.id, child));
	await db.insert(backgroundTasks).values({
		id: child,
		type: "agent",
		subagentNarratorId: child,
		parentNarratorId: parent,
		status: "completed",
		logicalRunId: agentRun.logicalRunId,
		output: "task final",
		startedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	const result = await awaitAgentResultDetailed({
		callerNarratorId: parent,
		id: child,
		signal: new AbortController().signal,
	});
	expect(result).toMatchObject({
		output: "task final",
		publicationRun: agentRun,
		terminalResultReceived: true,
	});
});

test("foreground subscribe recheck binds the terminal continuation", async () => {
	commitAgentResult();
	const current = await narratorService.getById(child);
	spyOn(narratorService, "getById").mockResolvedValueOnce({ ...current, status: "working" });
	expect(
		await waitForSubagentResult({ subagentId: child, recipientId: parent, timeoutMs: 1000 }),
	).toMatchObject({ terminalResultReceived: true, publicationRun: agentRun });
});

test("interrupt during foreground result read wins without consumption", async () => {
	await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, child));
	const controller = new AbortController();
	const waiting = waitForSubagentResult({
		subagentId: child,
		recipientId: parent,
		signal: controller.signal,
		timeoutMs: 1000,
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	spyOn(getRuntimePublicationService(), "readAgentTerminalResult").mockImplementation(async () => {
		controller.abort();
		return { output: "finished text", source: "terminal" as const };
	});
	await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, child));
	eventBus.emit({ type: "narrator:status_changed", narratorId: child, status: "idle" });
	const result = await waiting;
	expect(result.status).toBe("aborted");
	expect(result.publicationRun).toBeUndefined();
});

test("taken-over foreground result is not final", async () => {
	markTakenOver(child);
	const result = await waitForSubagentResult({ subagentId: child, recipientId: parent });
	expect(result.status).toBe("taken_over");
	expect(result.publicationRun).toBeUndefined();
});
