import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	runtimeAwaitedTerminalConsumptions,
	runtimePublicationOutbox,
} from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";

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
const { markTakenOver, clearTakenOver } = await import("../subagent-takeover");
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

function appendAssistant(messageId: string, output: string, seq: number) {
	const now = new Date().toISOString();
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId: child,
			role: "assistant",
			contentText: output,
			contentJson: [{ type: "text", text: output }],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${messageId}`, narratorId: child, messageId, seq })
		.run();
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

for (const cause of ["timeout", "parent"] as const) {
	test(`Await tool completed→restart ${cause} removes running entry and clears its timer`, async () => {
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
		const timer = spyOn(globalThis, "setTimeout"),
			clear = spyOn(globalThis, "clearTimeout");
		const controller = new AbortController();
		const toolUseId = `restart-${cause}`;
		const pending = awaitTool.execute(
			{ type: "agent", id: child, timeout: 1000 },
			{ ...ctx(), signal: controller.signal, currentToolUseId: toolUseId },
		);
		await entered.promise;
		expect(listRunningAwaits().some((row) => row.toolUseId === toolUseId)).toBe(true);
		if (cause === "parent") controller.abort();
		const result = await pending;
		expect(result.metadata?.status).toBe(cause === "timeout" ? "timeout" : "aborted");
		expect(listRunningAwaits().some((row) => row.toolUseId === toolUseId)).toBe(false);
		const timerIndex = timer.mock.calls.findIndex((call) => call[1] === 1000);
		expect(timerIndex).toBeGreaterThanOrEqual(0);
		expect(clear).toHaveBeenCalledWith(timer.mock.results[timerIndex].value);
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

test("Await consumes terminal found and preserves the result on failure", async () => {
	const consume = spyOn(getRuntimePublicationService(), "consumeAwaitedTerminal").mockRejectedValue(
		new Error("receipt unavailable"),
	);
	const result = await awaitTool.execute(
		{ type: "bash", id: taskId, wait_for_text: "needle" },
		ctx(),
	);
	expect(consume).toHaveBeenCalledWith(run);
	expect(result.isError).not.toBe(true);
	expect(result.output).toContain("final needle");
});

test("Await does not consume a running text match", async () => {
	await db.update(backgroundTasks).set({ status: "running" }).where(eq(backgroundTasks.id, taskId));
	spyOn(backgroundTaskService, "getOutputBuffer").mockReturnValue("needle");
	const consume = spyOn(
		getRuntimePublicationService(),
		"consumeAwaitedTerminal",
	).mockResolvedValue();
	await awaitTool.execute({ type: "bash", id: taskId, wait_for_text: "needle" }, ctx());
	expect(consume).not.toHaveBeenCalled();
});

test("an already interrupted Await does not consume even a terminal fast result", async () => {
	const consume = spyOn(
		getRuntimePublicationService(),
		"consumeAwaitedTerminal",
	).mockResolvedValue();
	const context = ctx();
	const controller = new AbortController();
	controller.abort();
	context.signal = controller.signal;
	await awaitTool.execute({ type: "bash", id: taskId }, context);
	expect(consume).not.toHaveBeenCalled();
});

test("foreground fast result carries its narrator run, and Await consumes it", async () => {
	commitAgentResult();
	const consume = spyOn(
		getRuntimePublicationService(),
		"consumeAwaitedTerminal",
	).mockResolvedValue();
	const result = await awaitAgentResultDetailed({
		callerNarratorId: parent,
		id: child,
		signal: new AbortController().signal,
	});
	expect(result).toMatchObject({ terminalResultReceived: true, publicationRun: agentRun });
	await awaitTool.execute({ type: "agent", id: child }, ctx());
	expect(consume.mock.calls[0]?.[0]).toEqual(agentRun);
});

test("foreground output read racing a continuation never guesses the later run", async () => {
	spyOn(getRuntimePublicationService(), "readAgentTerminalResult").mockImplementation(async () => {
		await db
			.update(narrators)
			.set({ logicalRunId: "agent-run-2", status: "working" })
			.where(eq(narrators.id, child));
		return { output: "old output", source: "terminal" as const };
	});
	const result = await waitForSubagentResult({ subagentId: child, parentNarratorId: parent });
	expect(result.output).toBe("old output");
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
			parentNarratorId: parent,
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

test("legacy background completion binds the epoch captured before the wait", async () => {
	await db
		.update(narrators)
		.set({
			isBackground: true,
			traits: ["background"],
			backgroundStatus: "running",
			status: "idle",
		})
		.where(eq(narrators.id, child));
	const waiting = awaitAgentResultDetailed({
		callerNarratorId: parent,
		id: child,
		signal: new AbortController().signal,
		timeoutMs: 1000,
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	await db
		.update(narrators)
		.set({ backgroundStatus: "completed", backgroundResult: "legacy final" })
		.where(eq(narrators.id, child));
	commitAgentResult(agentRun, "legacy final");
	eventBus.emit({
		type: "narrator:background_task_completed",
		narratorId: parent,
		parentNarratorId: parent,
		taskNarratorId: child,
		toolUseId: "legacy-tool",
		resultPreview: "legacy final",
	});
	expect(await waiting).toMatchObject({
		terminalResultReceived: true,
		publicationRun: agentRun,
		output: "legacy final",
	});
});

test("foreground subscribe recheck binds the terminal continuation", async () => {
	commitAgentResult();
	const current = await narratorService.getById(child);
	spyOn(narratorService, "getById").mockResolvedValueOnce({ ...current, status: "working" });
	expect(
		await waitForSubagentResult({ subagentId: child, parentNarratorId: parent, timeoutMs: 1000 }),
	).toMatchObject({ terminalResultReceived: true, publicationRun: agentRun });
});

test("interrupt during foreground result read wins without consumption", async () => {
	await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, child));
	const controller = new AbortController();
	const waiting = waitForSubagentResult({
		subagentId: child,
		parentNarratorId: parent,
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
	const result = await waitForSubagentResult({ subagentId: child, parentNarratorId: parent });
	expect(result.status).toBe("taken_over");
	expect(result.publicationRun).toBeUndefined();
});

test("native startup with new runId and old idle cannot consume the prior assistant", async () => {
	appendAssistant("prior-answer", "old run answer", 0);
	const next = runtimePublication.startAgentRun({ narratorId: child, parentNarratorId: parent });
	const consume = spyOn(
		getRuntimePublicationService(),
		"consumeAwaitedTerminal",
	).mockResolvedValue();
	const result = await awaitTool.execute({ type: "agent", id: child }, ctx());
	expect(result.output).not.toContain("old run answer");
	expect(consume).not.toHaveBeenCalled();
	expect((await narratorService.getById(child)).logicalRunId).toBe(next.logicalRunId);
});

test("a pre-run compact fallback cannot become the continuation result", async () => {
	const now = new Date().toISOString();
	db.insert(narratorMessages)
		.values({
			id: "old-compact",
			narratorId: child,
			role: "system",
			contentText: "old compact summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "old compact summary" }],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: "old-compact-ref",
			narratorId: child,
			messageId: "old-compact",
			seq: 0,
			isCompact: 1,
		})
		.run();
	runtimePublication.startAgentRun({ narratorId: child, parentNarratorId: parent });
	const consume = spyOn(
		getRuntimePublicationService(),
		"consumeAwaitedTerminal",
	).mockResolvedValue();
	const result = await awaitTool.execute({ type: "agent", id: child }, ctx());
	expect(result.output).not.toContain("old compact summary");
	expect(consume).not.toHaveBeenCalled();
});

test("early failed continuation without a new assistant never consumes old text", async () => {
	appendAssistant("prior-answer", "old run answer", 0);
	const next = runtimePublication.startAgentRun({ narratorId: child, parentNarratorId: parent });
	await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, child));
	const consume = spyOn(
		getRuntimePublicationService(),
		"consumeAwaitedTerminal",
	).mockResolvedValue();
	const waiting = awaitTool.execute({ type: "agent", id: child }, ctx());
	await new Promise((resolve) => setTimeout(resolve, 10));
	await db
		.update(narrators)
		.set({ status: "idle", substatus: JSON.stringify(["error"]), errorMessage: "early failure" })
		.where(eq(narrators.id, child));
	eventBus.emit({
		type: "narrator:status_changed",
		narratorId: child,
		status: "idle",
		substatus: ["error"],
	});
	const result = await waiting;
	expect(result.output).not.toContain("old run answer");
	expect(consume).not.toHaveBeenCalled();
	await getRuntimePublicationService().commitAgentTerminal({
		run: next,
		eventKind: "failed",
		text: "early failure",
		summary: "failed",
	});
	const terminal = await awaitTool.execute({ type: "agent", id: child }, ctx());
	expect(terminal.output).toContain("early failure");
	expect(consume.mock.calls[0]?.[0]).toEqual(next);
});

test("deferred continuation requires a post-boundary assistant and observed same-run settlement", async () => {
	runtimePublication.stop();
	appendAssistant("prior-answer", "old run answer", 0);
	const next = runtimePublication.startAgentRun({ narratorId: child, parentNarratorId: parent });
	await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, child));
	const waiting = awaitTool.execute({ type: "agent", id: child }, ctx());
	await new Promise((resolve) => setTimeout(resolve, 10));
	appendAssistant("new-answer", "current run answer", 1);
	await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, child));
	eventBus.emit({ type: "narrator:status_changed", narratorId: child, status: "idle" });
	const result = await waiting;
	expect(result.output).toContain("current run answer");
	expect(result.output).not.toContain("old run answer");
	expect(db.select().from(runtimeAwaitedTerminalConsumptions).all()[0]?.logicalRunId).toBe(
		next.logicalRunId,
	);
	await getRuntimePublicationService().commitAgentTerminal({
		run: next,
		eventKind: "completed",
		text: "current run answer",
		summary: "completed",
	});
	await getRuntimePublicationService().flushRecipient(parent);
	expect(
		db
			.select()
			.from(narratorBufferedMessages)
			.all()
			.every((row) => row.state === "cancelled"),
	).toBe(true);
});

test("background agent waiter sourceResultRef is forwarded without a new result lookup", async () => {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({ isBackground: true, backgroundStatus: "running", status: "working" })
		.where(eq(narrators.id, child));
	await db.insert(backgroundTasks).values({
		id: child,
		type: "agent",
		subagentNarratorId: child,
		parentNarratorId: parent,
		status: "running",
		logicalRunId: agentRun.logicalRunId,
		startedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	spyOn(backgroundTaskService, "waitForCompletion").mockResolvedValue({
		status: "completed",
		output: "background final",
		terminalResultReceived: true,
		publicationRun: agentRun,
		sourceResultRef: "message:background-answer",
	});
	const consume = spyOn(
		getRuntimePublicationService(),
		"consumeAwaitedTerminal",
	).mockResolvedValue();
	await awaitTool.execute({ type: "agent", id: child }, ctx());
	expect(consume).toHaveBeenCalledWith(agentRun, { sourceResultRef: "message:background-answer" });
});

test("generic background agent completion forwards its reader-bound sourceResultRef", async () => {
	const next = runtimePublication.startAgentRun({ narratorId: child, parentNarratorId: parent });
	await db
		.update(narrators)
		.set({
			isBackground: true,
			traits: ["background"],
			backgroundStatus: "running",
			status: "working",
		})
		.where(eq(narrators.id, child));
	const consume = spyOn(
		getRuntimePublicationService(),
		"consumeAwaitedTerminal",
	).mockResolvedValue();
	const waiting = awaitTool.execute({ type: "agent", id: child }, ctx());
	await new Promise((resolve) => setTimeout(resolve, 10));
	appendAssistant("generic-background-answer", "generic background final", 0);
	await db
		.update(narrators)
		.set({
			status: "idle",
			backgroundStatus: "completed",
			backgroundResult: "generic background final",
		})
		.where(eq(narrators.id, child));
	eventBus.emit({
		type: "narrator:background_task_completed",
		narratorId: parent,
		parentNarratorId: parent,
		taskNarratorId: child,
		toolUseId: "generic-tool",
		resultPreview: "generic background final",
	});
	const result = await waiting;
	expect(result.output).toContain("generic background final");
	expect(consume).toHaveBeenCalledWith(next, {
		sourceResultRef: "message:generic-background-answer",
	});
});

test("Await forwards the exact deferred source even when another run starts before consume", async () => {
	runtimePublication.stop();
	appendAssistant("prior-answer", "old run answer", 0);
	const next = runtimePublication.startAgentRun({ narratorId: child, parentNarratorId: parent });
	await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, child));
	const publication = getRuntimePublicationService();
	const consume = publication.consumeAwaitedTerminal.bind(publication);
	const observer = spyOn(publication, "consumeAwaitedTerminal").mockImplementation(
		async (source, options) => {
			runtimePublication.startAgentRun({ narratorId: child, parentNarratorId: parent });
			appendAssistant("later-run-answer", "later run answer", 2);
			await consume(source, options);
		},
	);
	const waiting = awaitTool.execute({ type: "agent", id: child }, ctx());
	await new Promise((resolve) => setTimeout(resolve, 10));
	appendAssistant("awaited-answer", "awaited run answer", 1);
	await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, child));
	eventBus.emit({ type: "narrator:status_changed", narratorId: child, status: "idle" });
	const result = await waiting;
	expect(result.output).toContain("awaited run answer");
	expect(result.output).not.toContain("later run answer");
	expect(observer).toHaveBeenCalledWith(next, { sourceResultRef: "message:awaited-answer" });
	expect(db.select().from(runtimeAwaitedTerminalConsumptions).all()[0]?.sourceResultRef).toBe(
		"message:awaited-answer",
	);
	await publication.commitAgentTerminal({
		run: next,
		eventKind: "completed",
		text: "awaited run answer",
		summary: "completed",
	});
	const snapshot = db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.id, `publication-result:${next.logicalRunId}`))
		.get();
	expect(snapshot?.contentJson).toMatchObject([
		{ publicationResult: { sourceResultRef: "message:awaited-answer" } },
	]);
});

for (const producerKind of ["agent", "bash"] as const) {
	for (const deliveryStage of ["pending", "queued"] as const) {
		test(`real Await ${producerKind} result suppresses ${deliveryStage} notification without re-reading output`, async () => {
			runtimePublication.stop();
			const publication = getRuntimePublicationService();
			const source = producerKind === "bash" ? run : agentRun;
			if (producerKind === "agent") {
				const now = new Date().toISOString();
				await db
					.update(narrators)
					.set({ isBackground: true, backgroundStatus: "completed" })
					.where(eq(narrators.id, child));
				await db.insert(backgroundTasks).values({
					id: child,
					type: "agent",
					subagentNarratorId: child,
					parentNarratorId: parent,
					status: "completed",
					logicalRunId: source.logicalRunId,
					output: "final needle",
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				});
			}
			db.transaction((tx) => runtimePublication.reserve(source, tx));
			const terminal = {
				run: source,
				eventKind: "completed" as const,
				text: "final needle",
				summary: "completed",
			};
			if (producerKind === "agent") await publication.commitAgentTerminal(terminal);
			else await publication.commitBashTerminal(terminal);
			if (deliveryStage === "queued") {
				await publication.flushRecipient(parent);
				expect(db.select().from(narratorBufferedMessages).all()[0]?.state).toBe("queued");
			} else {
				expect(db.select().from(runtimePublicationOutbox).all()).toHaveLength(1);
			}
			const result = await awaitTool.execute({ type: producerKind, id: source.taskId }, ctx());
			expect(result.isError).not.toBe(true);
			expect(result.output).toContain("final needle");
			expect(db.select().from(runtimeAwaitedTerminalConsumptions).all()).toHaveLength(1);
			await publication.flushRecipient(parent);
			expect(db.select().from(runtimePublicationOutbox).all()).toHaveLength(0);
			expect(
				db
					.select()
					.from(narratorBufferedMessages)
					.all()
					.every((row) => row.state === "cancelled"),
			).toBe(true);
			expect((await backgroundTaskService.getById(source.taskId))?.output).toBe("final needle");
		});
	}
}
