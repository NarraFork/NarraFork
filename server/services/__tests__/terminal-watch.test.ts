import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { backgroundTasks, narratorBufferedMessages, narrators } from "../../db/schema";
import { BufferManager } from "../../terminal/buffer-manager";
import { wakeInboxIfEligible } from "../agent-runtime/inbox";
import { flushRuntimePublications, runtimePublication } from "../agent-runtime/publication";
import { backgroundTaskService } from "../background-task-service";
import { projectPendingInjection } from "../parent-injection-queue";
import {
	activeWatchIds,
	CHECK_INTERVAL_MS,
	contextAround,
	echoEnd,
	endWatchesForBuffer,
	notifyTerminalOutput,
	resumeTerminalWatchesForTests,
	startTerminalWatch,
	suspendTerminalWatchesForShutdown,
	type WatchStart,
} from "../terminal-watch-service";

const PARENT = "terminal-watch-parent";
const TERMINAL = "terminal-watch-term";
const wakes: string[] = [];
const buffers: BufferManager[] = [];

runtimePublication.stop();
backgroundTaskService.setBroadcastFnForTests(() => {});
afterAll(() => {
	runtimePublication.setWake(async (recipientId) => {
		await wakeInboxIfEligible(recipientId);
	});
});

beforeEach(() => {
	resumeTerminalWatchesForTests();
	wakes.length = 0;
	runtimePublication.setWake((recipientId) => {
		wakes.push(recipientId);
	});
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id: PARENT, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
		.run();
});
afterEach(async () => {
	for (const buffer of buffers.splice(0)) {
		for (const id of activeWatchIds(TERMINAL)) await backgroundTaskService.cancel(id);
		await buffer.dispose(true);
	}
	cleanDb(sqlite);
});

function newBuffer(cols = 80) {
	const buffer = new BufferManager(TERMINAL, cols, 24);
	buffers.push(buffer);
	return buffer;
}

/** Feed PTY output the way terminal-service's onData does. */
function output(buffer: BufferManager, data: string) {
	buffer.append(data);
	notifyTerminalOutput(TERMINAL);
}

async function start(
	buffer: BufferManager,
	pattern: string,
	startAt: WatchStart,
	timeoutMs = 60_000,
) {
	const marker = await buffer.markCursorRow();
	if (!marker) throw new Error("no marker");
	const result = await startTerminalWatch({
		narratorId: PARENT,
		terminalId: TERMINAL,
		terminalName: "T",
		pattern,
		timeoutMs,
		buffer,
		marker,
		start: startAt,
	});
	if (result.status !== "started") throw new Error(result.message);
	return result.taskId;
}

async function row(taskId: string) {
	return db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
}

async function waitForStatus(taskId: string, timeoutMs = 3_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const task = await row(taskId);
		if (task && task.status !== "running") return task;
		if (Date.now() > deadline) return task;
		await Bun.sleep(20);
	}
}

async function notices() {
	await flushRuntimePublications(PARENT);
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, PARENT))
		.all()
		.map((r) => projectPendingInjection(r));
}

describe("helpers", () => {
	test("echoEnd skips the echoed command line, control keys excluded", () => {
		const text = "$ ping x; echo __DONE__\nPING\n__DONE__";
		const end = echoEnd(text, "ping x; echo __DONE__\n");
		expect(end).toBe("$ ping x; echo __DONE__".length);
		expect(text.indexOf("__DONE__", end)).toBe(text.lastIndexOf("__DONE__"));
		expect(echoEnd("abc", "\x03")).toBe(0);
		expect(echoEnd("abc", "secret\n")).toBeUndefined();
	});

	test("contextAround keeps whole lines around the match", () => {
		const text = ["a", "b", "x MATCH y", "c"].join("\n");
		expect(contextAround(text, text.indexOf("MATCH"), 5)).toBe(text);
	});
});

describe("terminal watch", () => {
	test("command output after the echo completes the watch and wakes the narrator", async () => {
		const buffer = newBuffer();
		output(buffer, "user@host:~$ ");
		const id = await start(buffer, "__DONE2__", {
			kind: "echo",
			input: "ping -c 2 x; echo __DONE2__\n",
		});
		// The echo alone contains the marker: it must not match.
		output(buffer, "ping -c 2 x; echo __DONE2__\r\n");
		await Bun.sleep(CHECK_INTERVAL_MS * 2);
		expect((await row(id))?.status).toBe("running");

		output(buffer, "64 bytes from x\r\n__DONE2__\r\nuser@host:~$ ");
		const done = await waitForStatus(id);
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("64 bytes from x");
		expect(done?.output).toContain("__DONE2__");

		const [notice] = await notices();
		expect(notice?.kind).toBe("bg_bash");
		if (notice?.kind === "bg_bash") expect(notice.task.outputPreview).toContain("__DONE2__");
		expect(wakes).toContain(PARENT);
		expect(activeWatchIds(TERMINAL)).toEqual([]);
	});

	test("output that arrived before the watch started is still matched", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const marker = await buffer.markCursorRow();
		if (!marker) throw new Error("no marker");
		// The command ran and finished before startTerminalWatch was called.
		output(buffer, "make\r\nok\r\nREADY\r\n$ ");
		const result = await startTerminalWatch({
			narratorId: PARENT,
			terminalId: TERMINAL,
			terminalName: "T",
			pattern: "READY",
			timeoutMs: 60_000,
			buffer,
			marker,
			start: { kind: "echo", input: "make\n" },
		});
		if (result.status !== "started") throw new Error("not started");
		expect((await waitForStatus(result.taskId))?.status).toBe("completed");
	});

	test("an offset start ignores text already on screen", async () => {
		const buffer = newBuffer();
		output(buffer, "server: READY (old)");
		await buffer.flush();
		const id = await start(buffer, "READY", { kind: "offset", offset: 19 });
		await Bun.sleep(CHECK_INTERVAL_MS * 2);
		expect((await row(id))?.status).toBe("running");
		output(buffer, "\r\nserver: READY\r\n");
		expect((await waitForStatus(id))?.status).toBe("completed");
	});

	test("matches across soft-wrapped rows and treats \\r\\n in the pattern as a line break", async () => {
		const buffer = newBuffer(20);
		output(buffer, "$ ");
		const wrapped = await start(buffer, "abcdefghijklmnopqrstuvwxyz", {
			kind: "offset",
			offset: 2,
		});
		output(buffer, `abcdefghijklmnopqrstuvwxyz\r\nend\r\n`);
		expect((await waitForStatus(wrapped))?.status).toBe("completed");

		const crlf = await start(buffer, "one\r\ntwo", { kind: "offset", offset: 0 });
		output(buffer, "one\r\ntwo\r\n");
		expect((await waitForStatus(crlf))?.status).toBe("completed");
	});

	test("times out with the last lines and still notifies", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "NEVER", { kind: "offset", offset: 0 }, 300);
		output(buffer, "working...\r\n");
		const done = await waitForStatus(id);
		expect(done?.status).toBe("timeout");
		expect(done?.output).toContain("timed out");
		expect(done?.output).toContain("working...");
		expect((await notices()).length).toBe(1);
	});

	test("ending the buffer fails the watch after a last match attempt", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const missed = await start(buffer, "NEVER", { kind: "offset", offset: 0 });
		const lastMinute = await start(buffer, "BYE", { kind: "offset", offset: 0 });
		// Output that lands right before exit, with no check run yet.
		buffer.append("BYE\r\n");
		await endWatchesForBuffer(TERMINAL, buffer, "the terminal exited");
		expect((await row(lastMinute))?.status).toBe("completed");
		const failed = await row(missed);
		expect(failed?.status).toBe("failed");
		expect(failed?.output).toContain("the terminal exited");
	});

	test("a different buffer for the same terminal does not end the watch", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "NEVER", { kind: "offset", offset: 0 });
		const other = newBuffer();
		await endWatchesForBuffer(TERMINAL, other, "unrelated");
		expect((await row(id))?.status).toBe("running");
	});

	test("Stop cancels the watch without a new turn", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "NEVER", { kind: "offset", offset: 0 });
		expect(await backgroundTaskService.cancel(id)).toBe(true);
		expect((await row(id))?.status).toBe("cancelled");
		expect(activeWatchIds(TERMINAL)).toEqual([]);
		await flushRuntimePublications(PARENT);
		expect(wakes).toEqual([]);
		// Later output must not resurrect it.
		output(buffer, "NEVER\r\n");
		await Bun.sleep(CHECK_INTERVAL_MS * 2);
		expect((await row(id))?.status).toBe("cancelled");
	});

	test("restart recovery reports a leftover watch as ended", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "NEVER", { kind: "offset", offset: 0 });
		// Shutdown keeps the row running and drops only in-memory state.
		suspendTerminalWatchesForShutdown();
		expect(activeWatchIds(TERMINAL)).toEqual([]);
		await backgroundTaskService.killAll();
		expect((await row(id))?.status).toBe("running");
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		const recovered = await row(id);
		expect(recovered?.status).toBe("failed");
		expect(recovered?.output).toContain("Terminal watch ended because the server restarted");
	});
});
