import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
	createRenderedPatternMatcher,
	echoEnd,
	endWatchesForBuffer,
	MAX_WATCH_PATTERN_CHARS,
	notifyTerminalOutput,
	PUBLISH_RETRY_DELAYS_MS,
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
	mock.restore();
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

describe("rendered pattern freshness", () => {
	test("same-count movement in the observed prefix is not a new occurrence", () => {
		const match = createRenderedPatternMatcher("READY", "READY");
		expect(match(" READY", { newRegionStart: 6 })).toBe(-1);
		expect(match("                     READY", { newRegionStart: 26 })).toBe(-1);
	});

	test("erasing old text cannot cancel a new appended occurrence", () => {
		const match = createRenderedPatternMatcher("READY", "READY");
		expect(match("\nREADY", { newRegionStart: 0 })).toBe(1);
	});

	test("observing disappearance permits a later appearance in the old row", () => {
		const match = createRenderedPatternMatcher("READY", "READY");
		expect(match("working", { newRegionStart: 7 })).toBe(-1);
		expect(match("READY", { newRegionStart: 5 })).toBe(0);
	});

	test("overlapping literals and matches crossing the new-region boundary are retained", () => {
		expect(createRenderedPatternMatcher("AA", "AAA")("AAAA", { newRegionStart: 4 })).toBe(2);
		expect(createRenderedPatternMatcher("AA", "AAA")(" AAA", { newRegionStart: 4 })).toBe(-1);
		expect(
			createRenderedPatternMatcher("READY", "READY RE")("READY READY", { newRegionStart: 8 }),
		).toBe(6);
		expect(createRenderedPatternMatcher("READY", "READY")("READY", { resetHistory: true })).toBe(0);
		expect(createRenderedPatternMatcher("READY", "")("READY", { prefixUnknown: true })).toBe(-1);
	});

	test("literal matching agrees with a naive overlapping oracle over small strings", () => {
		const words = [""];
		for (let length = 1; length <= 4; length++) {
			for (let bits = 0; bits < 2 ** length; bits++)
				words.push(Array.from({ length }, (_, i) => (bits & (1 << i) ? "A" : "B")).join(""));
		}
		const positions = (text: string, pattern: string) => {
			const found: number[] = [];
			for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1))
				found.push(at);
			return found;
		};
		for (const pattern of ["A", "B", "AA", "AB", "BA", "BB", "AAA"]) {
			for (const before of words.slice(0, 7))
				for (const text of words) {
					for (const boundary of [0, Math.floor(text.length / 2), text.length]) {
						const excluded = positions(before, pattern).length;
						const found = positions(text, pattern);
						let oldMatches = 0;
						const expected =
							found.find((at) => at + pattern.length > boundary || ++oldMatches > excluded) ?? -1;
						expect(
							createRenderedPatternMatcher(pattern, before)(text, { newRegionStart: boundary }),
						).toBe(expected);
					}
				}
		}
	});

	test("long overlapping prefixes remain bounded and literal", () => {
		const pattern = `${"A".repeat(MAX_WATCH_PATTERN_CHARS - 1)}B`;
		const text = `${"A".repeat(100_000)}B`;
		expect(createRenderedPatternMatcher(pattern, "")(text)).toBe(text.indexOf(pattern));
		expect(createRenderedPatternMatcher("[a].*", "")("xx[a].*xx")).toBe(2);
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

	test.each([
		"completed",
		"timeout",
	] as const)("retries a rolled-back %s publication without losing or duplicating the notice", async (status) => {
		const method = status === "completed" ? "markCompleted" : "markTimedOut";
		const publish = backgroundTaskService[method].bind(backgroundTaskService);
		let attempts = 0;
		const published = spyOn(backgroundTaskService, method).mockImplementation(async (...args) => {
			attempts++;
			if (attempts !== 1) return publish(...args);
			sqlite.exec(
				"CREATE TRIGGER watch_publication_fault BEFORE UPDATE ON runtime_publication_outbox WHEN NEW.state = 'pending' BEGIN SELECT RAISE(ABORT, 'watch publication fault'); END;",
			);
			try {
				return await publish(...args);
			} finally {
				sqlite.exec("DROP TRIGGER watch_publication_fault");
			}
		});
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "READY", { kind: "offset", offset: 2 }, 300);
		output(buffer, status === "completed" ? "READY\r\n" : "still working\r\n");
		const done = await waitForStatus(id);
		expect(done?.status).toBe(status);
		expect(published).toHaveBeenCalledTimes(2);
		const delivered = await notices();
		expect(delivered).toHaveLength(1);
		expect((await notices()).map((notice) => notice?.kind)).toEqual(["bg_bash"]);
		expect(wakes).toEqual([PARENT]);
		expect(activeWatchIds(TERMINAL)).toEqual([]);
	});

	test("Stop during a publication retry cancels it without a late completion", async () => {
		const published = spyOn(backgroundTaskService, "markCompleted").mockRejectedValue(
			new Error("temporary publication failure"),
		);
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "READY", { kind: "offset", offset: 2 });
		output(buffer, "READY\r\n");
		const deadline = Date.now() + 1_000;
		while (published.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(10);
		expect(published).toHaveBeenCalledTimes(1);
		expect(activeWatchIds(TERMINAL)).toContain(id);
		expect(await backgroundTaskService.cancel(id)).toBe(true);
		await Bun.sleep(CHECK_INTERVAL_MS * 2);
		expect(published).toHaveBeenCalledTimes(1);
		expect((await row(id))?.status).toBe("cancelled");
		expect(activeWatchIds(TERMINAL)).toEqual([]);
		const [notice] = await notices();
		expect(notice?.kind).toBe("bg_bash");
		if (notice?.kind === "bg_bash") expect(notice.task.status).toBe("cancelled");
		expect(wakes).toEqual([]);
	});

	test("shutdown clears a pending publication retry for restart recovery", async () => {
		const published = spyOn(backgroundTaskService, "markCompleted").mockRejectedValue(
			new Error("temporary publication failure"),
		);
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "READY", { kind: "offset", offset: 2 });
		output(buffer, "READY\r\n");
		const deadline = Date.now() + 1_000;
		while (published.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(10);
		expect(published).toHaveBeenCalledTimes(1);
		expect(activeWatchIds(TERMINAL)).toContain(id);
		suspendTerminalWatchesForShutdown();
		await Bun.sleep(CHECK_INTERVAL_MS * 2);
		expect(published).toHaveBeenCalledTimes(1);
		expect((await row(id))?.status).toBe("running");
		expect(activeWatchIds(TERMINAL)).toEqual([]);
		expect(await notices()).toEqual([]);
	});

	test("terminal exit during a publication retry preserves the frozen completion", async () => {
		const publish = backgroundTaskService.markCompleted.bind(backgroundTaskService);
		let attempts = 0;
		const published = spyOn(backgroundTaskService, "markCompleted").mockImplementation(
			async (...args) => {
				if (++attempts === 1) throw new Error("temporary publication failure");
				return publish(...args);
			},
		);
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "READY", { kind: "offset", offset: 2 });
		output(buffer, "READY\r\n");
		const deadline = Date.now() + 1_000;
		while (published.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(10);
		expect(published).toHaveBeenCalledTimes(1);
		output(buffer, "unrelated later output\r\n");
		await endWatchesForBuffer(TERMINAL, buffer, "the terminal exited");
		const done = await waitForStatus(id);
		expect(done?.status).toBe("completed");
		expect(done?.output).not.toContain("unrelated later output");
		expect(published).toHaveBeenCalledTimes(2);
		expect(await notices()).toHaveLength(1);
	});

	test("permanent publication failures have a bounded retry budget and release resources", async () => {
		const published = spyOn(backgroundTaskService, "markCompleted").mockRejectedValue(
			new Error("permanent publication failure"),
		);
		const schedule = globalThis.setTimeout;
		const delays: number[] = [];
		spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [handler, delay, ...rest] = args;
			const retry = PUBLISH_RETRY_DELAYS_MS.some((value) => value === delay);
			if (retry && delay !== undefined) delays.push(delay);
			return schedule(handler, retry ? 5 : delay, ...rest);
		}) as typeof setTimeout);
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "READY", { kind: "offset", offset: 2 });
		output(buffer, "READY\r\n");
		const deadline = Date.now() + 1_000;
		while (activeWatchIds(TERMINAL).includes(id) && Date.now() < deadline) await Bun.sleep(10);
		expect(delays).toEqual([...PUBLISH_RETRY_DELAYS_MS]);
		expect(published).toHaveBeenCalledTimes(1 + PUBLISH_RETRY_DELAYS_MS.length);
		expect(activeWatchIds(TERMINAL)).toEqual([]);
		expect((await row(id))?.status).toBe("running");
		expect(await notices()).toEqual([]);
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

	test.each([
		["literal", "x".repeat(MAX_WATCH_PATTERN_CHARS + 1)],
		["CRLF", `READY${"\r\n".repeat(MAX_WATCH_PATTERN_CHARS / 2)}`],
	])("oversized %s service patterns reject before normalization and release both markers", async (_label, pattern) => {
		const buffer = newBuffer();
		output(buffer, "first row\r\nlast observed row\x1b[1A");
		const point = await buffer.markReadCursor();
		if (!point) throw new Error("missing point");
		expect(point.observedEndMarker).not.toBe(point.marker);
		const result = await startTerminalWatch({
			narratorId: PARENT,
			terminalId: TERMINAL,
			terminalName: "T",
			pattern,
			timeoutMs: 1000,
			buffer,
			marker: point.marker,
			observedEndMarker: point.observedEndMarker,
			disposeMarkers: point.dispose,
			start: { kind: "offset", offset: point.offset, textBefore: point.textBefore },
		});
		expect(result).toMatchObject({ status: "error", message: expect.stringContaining("exceeds") });
		expect(point.marker.isDisposed).toBe(true);
		expect(point.observedEndMarker?.isDisposed).toBe(true);
		expect(buffer.cloneReadCursor(point)).toBeUndefined();
		expect(db.select().from(backgroundTasks).all()).toEqual([]);
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
