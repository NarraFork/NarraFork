import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { backgroundTasks, narratorBufferedMessages, narrators } from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
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
	createWatchFrameMatcher,
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
import { MAX_PUBLISH_RETRY_DELAY_MS } from "../watch-observation";

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
	// Frozen results have released their buffer but may still own publication retries.
	suspendTerminalWatchesForShutdown();
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

async function startWithCursor(buffer: BufferManager, pattern: string, startAt?: WatchStart) {
	const cursor = await buffer.markReadCursor();
	if (!cursor) throw new Error("no cursor");
	const result = await startTerminalWatch({
		narratorId: PARENT,
		terminalId: TERMINAL,
		terminalName: "T",
		pattern,
		timeoutMs: 60_000,
		buffer,
		cursor,
		marker: cursor.marker,
		disposeMarkers: cursor.dispose,
		start: startAt ?? { kind: "offset", offset: cursor.offset, textBefore: cursor.textBefore },
	});
	if (result.status !== "started") throw new Error(result.message);
	return result.taskId;
}

async function startLifecycle(buffer?: BufferManager, timeoutMs = 60_000) {
	const result = await startTerminalWatch({
		narratorId: PARENT,
		terminalId: TERMINAL,
		terminalName: "T",
		timeoutMs,
		buffer,
		principal: { userId: null },
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

async function notices(narratorId = PARENT) {
	await flushRuntimePublications(narratorId);
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
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

describe("layout frame matching", () => {
	test("reflow baselines exclude history and preserve partial matches", () => {
		const match = createWatchFrameMatcher("READY", {
			kind: "offset",
			offset: 5,
			textBefore: "READY",
		});
		expect(
			match({ kind: "snapshot", text: "READY", markerLost: false, observedPrefixEnd: 5 }),
		).toBe(-1);
		expect(match({ kind: "baseline", text: "prefix READY RE" })).toBe(-1);
		expect(
			match({
				kind: "snapshot",
				text: "prefix READY READY",
				markerLost: false,
				observedPrefixEnd: 18,
			}),
		).toBe(13);
	});

	test("a command echo cannot match a literal crossing its trailing newline", () => {
		const match = createWatchFrameMatcher("READY\n", { kind: "echo", input: "echo READY\n" });
		expect(match({ kind: "snapshot", text: "$ echo READY", markerLost: false })).toBe(-1);
		expect(match({ kind: "baseline", text: "$ echo READY" })).toBe(-1);
		expect(match({ kind: "snapshot", text: "$ echo READY\nworking", markerLost: false })).toBe(-1);
		expect(match({ kind: "snapshot", text: "$ echo READY\nREADY\n", markerLost: false })).toBe(13);
	});

	test("a parsed echo stays excluded when a multiline pattern completes after resize", () => {
		const match = createWatchFrameMatcher("READY\nworkingDONE", {
			kind: "echo",
			input: "echo READY\n",
		});
		expect(match({ kind: "snapshot", text: "$ echo READY\nworking", markerLost: false })).toBe(-1);
		expect(match({ kind: "baseline", text: "older history\n$ echo READY\nworking" })).toBe(-1);
		expect(
			match({
				kind: "snapshot",
				text: "older history\n$ echo READY\nworkingDONE",
				markerLost: false,
			}),
		).toBe(-1);
		expect(
			match({
				kind: "snapshot",
				text: "older history\n$ echo READY\nworkingDONE\nREADY\nworkingDONE",
				markerLost: false,
			}),
		).toBe(39);
	});

	test("a resize before any echo does not discard the first no-echo output line", () => {
		const match = createWatchFrameMatcher("READY", { kind: "echo", input: "deploy\n" });
		expect(match({ kind: "snapshot", text: "$ ", markerLost: false })).toBe(-1);
		expect(match({ kind: "baseline", text: "$ " })).toBe(-1);
		expect(match({ kind: "snapshot", text: "$ READY\nnext", markerLost: false })).toBe(2);
	});

	test("an unresolved clipped command is excluded until its line ends", () => {
		const match = createWatchFrameMatcher("READY", { kind: "echo", input: "long command READY\n" });
		expect(match({ kind: "snapshot", text: "$ long comm", markerLost: false })).toBe(-1);
		expect(match({ kind: "baseline", text: "$ long" })).toBe(-1);
		expect(match({ kind: "snapshot", text: "$ long READY\n", markerLost: false })).toBe(-1);
		expect(match({ kind: "snapshot", text: "$ long READY\nREADY", markerLost: false })).toBe(13);
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

describe("repeated terminal watches", () => {
	test("one watcher's repeated lifecycle watches share one observation and one notice", async () => {
		const first = await startLifecycle(undefined, 60_000);
		const repeat = await startTerminalWatch({
			narratorId: PARENT,
			terminalId: TERMINAL,
			terminalName: "T",
			timeoutMs: 120_000,
		});
		expect(repeat).toMatchObject({ status: "started", taskId: first, reused: true });
		expect(activeWatchIds(TERMINAL)).toEqual([first]);
		eventBus.emit({ type: "terminal:exited", terminalId: TERMINAL, narratorId: PARENT });
		expect((await waitForStatus(first))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
	});

	test("a repeated lifecycle watch extends the shared deadline and times out once", async () => {
		const first = await startLifecycle(undefined, 1_000);
		expect(await startLifecycle(undefined, 1_500)).toBe(first);
		await Bun.sleep(1_200);
		expect((await row(first))?.status).toBe("running");
		const done = await waitForStatus(first);
		expect(done?.output).toContain("observation reached its deadline");
		expect(await notices()).toHaveLength(1);
	});

	test("text watches with different patterns stay separate but share one ending notice", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const ready = await start(buffer, "READY", { kind: "offset", offset: 0 });
		const done = await start(buffer, "DONE", { kind: "offset", offset: 0 });
		const lifecycle = await startLifecycle(buffer);
		expect(new Set([ready, done, lifecycle]).size).toBe(3);
		await endWatchesForBuffer(TERMINAL, buffer, "the terminal was detached from the server");
		// Duplicates settle silently but keep their own outcome: an unmatched pattern is not a match.
		for (const id of [ready, done, lifecycle])
			expect((await waitForStatus(id))?.status).toBe("failed");
		expect(await notices()).toHaveLength(1);
	});

	test("different watchers of one terminal keep independent watches and notices", async () => {
		const other = "terminal-watch-other";
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: other, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
			.run();
		const mine = await startLifecycle();
		const theirs = await startTerminalWatch({
			narratorId: other,
			terminalId: TERMINAL,
			terminalName: "T",
			timeoutMs: 60_000,
		});
		if (theirs.status !== "started") throw new Error(theirs.message);
		expect(theirs.reused).toBeFalsy();
		expect(theirs.taskId).not.toBe(mine);
		eventBus.emit({ type: "terminal:exited", terminalId: TERMINAL, narratorId: PARENT });
		expect((await waitForStatus(mine))?.status).toBe("completed");
		expect((await waitForStatus(theirs.taskId))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
		expect(await notices(other)).toHaveLength(1);
	});
});

describe("terminal watch", () => {
	test("a lifecycle deadline needs no buffer, markers, or output snapshot", async () => {
		const id = await startLifecycle(undefined, 40);
		const done = await waitForStatus(id);
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("observation reached its deadline");
		expect(done?.output).not.toContain("output:");
		expect(await notices()).toHaveLength(1);
	});

	test("lifecycle watches complete once on exit signals even with no normal buffer", async () => {
		const id = await startLifecycle();
		eventBus.emit({ type: "terminal:exited", terminalId: TERMINAL, narratorId: PARENT });
		eventBus.emit({ type: "terminal:exited", terminalId: TERMINAL, narratorId: PARENT });
		const done = await waitForStatus(id);
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("the terminal exited or was closed");
		expect(done?.output).toContain("not an individual command's success");
		expect(await notices()).toHaveLength(1);
		expect(activeWatchIds(TERMINAL)).toEqual([]);
	});

	test("detaching ends a lifecycle watch as failed, not command completion", async () => {
		const buffer = newBuffer();
		const read = spyOn(buffer, "readFromMarker");
		const id = await startLifecycle(buffer);
		await endWatchesForBuffer(TERMINAL, buffer, "the terminal was detached from the server");
		const done = await waitForStatus(id);
		expect(done?.status).toBe("failed");
		expect(done?.output).toContain("may still be running");
		expect(read).not.toHaveBeenCalled();
		eventBus.emit({ type: "terminal:exited", terminalId: TERMINAL, narratorId: PARENT });
		expect(await notices()).toHaveLength(1);
		expect((await row(id))?.output).toBe(done?.output);
	});

	test("a stalled pattern read cannot hide exit from a lifecycle watch on the same buffer", async () => {
		const buffer = newBuffer();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		spyOn(buffer, "readFromMarker").mockImplementation(async () => {
			entered.resolve();
			await gate.promise;
			return { text: "", markerLost: false };
		});
		try {
			const textId = await start(buffer, "NEVER", { kind: "offset", offset: 0 });
			await entered.promise;
			const lifecycleId = await startLifecycle(buffer, 100);
			const ended = endWatchesForBuffer(TERMINAL, buffer, "the terminal exited");
			const done = await waitForStatus(lifecycleId);
			expect(done?.status).toBe("completed");
			expect(done?.output).toContain("the terminal exited");
			expect(done?.output).not.toContain("deadline");
			expect(await backgroundTaskService.cancel(textId)).toBe(true);
			gate.resolve();
			await ended;
			eventBus.emit({ type: "terminal:exited", terminalId: TERMINAL, narratorId: PARENT });
			const delivered = await notices();
			expect(
				delivered.filter((notice) => notice?.kind === "bg_bash" && notice.task.id === lifecycleId),
			).toHaveLength(1);
		} finally {
			gate.resolve();
		}
	});

	test("Stop cancels lifecycle observation without affecting its terminal or accepting later exit", async () => {
		const buffer = newBuffer();
		const id = await startLifecycle(buffer);
		expect(await backgroundTaskService.cancel(id)).toBe(true);
		output(buffer, "the terminal is still usable\r\n");
		expect(await buffer.getContents()).toContain("still usable");
		eventBus.emit({ type: "terminal:exited", terminalId: TERMINAL, narratorId: PARENT });
		expect((await row(id))?.status).toBe("cancelled");
		expect(activeWatchIds(TERMINAL)).toEqual([]);
		await notices();
		expect(wakes).toEqual([]);
	});

	test("shutdown suspends lifecycle observation for restart interruption instead of reporting exit", async () => {
		const buffer = newBuffer();
		const id = await startLifecycle(buffer);
		suspendTerminalWatchesForShutdown();
		await endWatchesForBuffer(TERMINAL, buffer, "the terminal exited or was closed");
		eventBus.emit({ type: "terminal:exited", terminalId: TERMINAL, narratorId: PARENT });
		expect((await row(id))?.status).toBe("running");
		expect(await notices()).toEqual([]);
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		// Terminal watches are settled after narrator recovery, off the startup path.
		const done = await waitForStatus(id);
		expect(done?.status).toBe("failed");
		expect(done?.output).toMatch(/restart|interrupted/i);
	});

	test("multiline partial output survives a resize on the next empty cursor row", async () => {
		const buffer = newBuffer();
		const id = await startWithCursor(buffer, "RE\nADY");
		output(buffer, "RE\r\n");
		await buffer.resize(120, 24);
		output(buffer, "ADY");
		expect((await waitForStatus(id))?.status).toBe("completed");
	});

	test("an echo terminator arriving after resize cannot satisfy notify_on", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await startWithCursor(buffer, "READY\n", { kind: "echo", input: "echo READY\n" });
		output(buffer, "echo READY");
		await buffer.resize(120, 24);
		output(buffer, "\r\nworking\r\n");
		await Bun.sleep(CHECK_INTERVAL_MS * 2);
		expect((await row(id))?.status).toBe("running");
		output(buffer, "READY\r\nnext");
		expect((await waitForStatus(id))?.status).toBe("completed");
	});

	test("resize preserves an already parsed echo exclusion across multiline result suffixes", async () => {
		const buffer = newBuffer();
		output(buffer, "older history\r\n$ ");
		const id = await startWithCursor(buffer, "READY\nworkingDONE", {
			kind: "echo",
			input: "echo READY\n",
		});
		output(buffer, "echo READY\r\nworking");
		await buffer.resize(120, 24);
		output(buffer, "DONE");
		await Bun.sleep(CHECK_INTERVAL_MS * 2);
		expect((await row(id))?.status).toBe("running");
		output(buffer, "\r\nREADY\r\nworkingDONE");
		expect((await waitForStatus(id))?.status).toBe("completed");
	});

	test("resize before no-echo output preserves its first result line", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await startWithCursor(buffer, "READY", { kind: "echo", input: "deploy\n" });
		await buffer.resize(120, 24);
		output(buffer, "READY\r\nnext");
		expect((await waitForStatus(id))?.status).toBe("completed");
	});
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
		expect(done?.status).toBe("completed");
		expect(done?.output).toMatch(/timed out|deadline/i);
		expect(done?.output).toMatch(/still (?:be )?running/);
		expect(done?.output).toContain("working...");
		expect((await notices()).length).toBe(1);
	});

	test("a stalled terminal read cannot delay its deadline or publish a late match", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const cursor = await buffer.markReadCursor();
		if (!cursor) throw new Error("no cursor");
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const releasedRead = Promise.withResolvers<void>();
		const read = buffer.readCursor.bind(buffer);
		spyOn(buffer, "readCursor").mockImplementationOnce(async (point) => {
			const captured = await read(point);
			entered.resolve();
			await gate.promise;
			releasedRead.resolve();
			return captured;
		});
		try {
			const result = await startTerminalWatch({
				narratorId: PARENT,
				terminalId: TERMINAL,
				terminalName: "T",
				pattern: "READY",
				timeoutMs: 150,
				buffer,
				cursor,
				marker: cursor.marker,
				disposeMarkers: cursor.dispose,
				start: { kind: "offset", offset: cursor.offset, textBefore: cursor.textBefore },
			});
			if (result.status !== "started") throw new Error(result.message);
			output(buffer, "READY while the read response is blocked\r\n");
			await entered.promise;
			const done = await waitForStatus(result.taskId);
			expect(done?.status).toBe("completed");
			expect(done?.output).toMatch(/timed out|deadline/i);
			expect(done?.output).toMatch(/still (?:be )?running/);
			expect(activeWatchIds(TERMINAL)).toEqual([]);
			expect(await notices()).toHaveLength(1);
			gate.resolve();
			await releasedRead.promise;
			await Bun.sleep(20);
			expect((await row(result.taskId))?.output).toBe(done?.output);
			expect(await notices()).toHaveLength(1);
		} finally {
			gate.resolve();
		}
	});

	test.each([
		"completed",
		"timeout",
	] as const)("retries a rolled-back %s publication without losing or duplicating the notice", async (status) => {
		const method = "markCompleted";
		const publish = backgroundTaskService.markCompleted.bind(backgroundTaskService);
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
		expect(done?.status).toBe("completed");
		if (status === "timeout") {
			expect(done?.output).toMatch(/timed out|deadline/i);
			expect(done?.output).toMatch(/still (?:be )?running/);
		} else expect(done?.output).toContain('"READY" appeared');
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
		expect(activeWatchIds(TERMINAL)).toEqual([]);
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
		expect(activeWatchIds(TERMINAL)).toEqual([]);
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

	test("publication failures release terminal resources immediately but remain stoppable beyond the old retry budget", async () => {
		const published = spyOn(backgroundTaskService, "markCompleted").mockRejectedValue(
			new Error("persistent publication failure"),
		);
		const schedule = globalThis.setTimeout;
		const delays: number[] = [];
		spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [handler, delay, ...rest] = args;
			const retry =
				PUBLISH_RETRY_DELAYS_MS.some((value) => value === delay) ||
				delay === MAX_PUBLISH_RETRY_DELAY_MS;
			if (retry && delay !== undefined) delays.push(delay);
			return schedule(handler, retry ? 5 : delay, ...rest);
		}) as typeof setTimeout);
		const buffer = newBuffer();
		output(buffer, "$ ");
		const cursor = await buffer.markReadCursor();
		if (!cursor) throw new Error("no cursor");
		const dispose = spyOn(cursor, "dispose");
		const result = await startTerminalWatch({
			narratorId: PARENT,
			terminalId: TERMINAL,
			terminalName: "T",
			pattern: "READY",
			timeoutMs: 60_000,
			buffer,
			cursor,
			marker: cursor.marker,
			disposeMarkers: cursor.dispose,
			start: { kind: "offset", offset: cursor.offset, textBefore: cursor.textBefore },
		});
		if (result.status !== "started") throw new Error(result.message);
		output(buffer, "READY\r\n");
		const deadline = Date.now() + 1_000;
		while (published.mock.calls.length < 6 && Date.now() < deadline) await Bun.sleep(5);
		expect(published.mock.calls.length).toBeGreaterThanOrEqual(6);
		expect(delays.slice(0, 3)).toEqual([...PUBLISH_RETRY_DELAYS_MS]);
		expect(delays.slice(3).every((delay) => delay === MAX_PUBLISH_RETRY_DELAY_MS)).toBe(true);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(cursor.marker.isDisposed).toBe(true);
		expect(cursor.observedEndMarker?.isDisposed ?? true).toBe(true);
		expect(buffer.cloneReadCursor(cursor)).toBeUndefined();
		expect(activeWatchIds(TERMINAL)).toEqual([]);
		expect((await row(result.taskId))?.status).toBe("running");
		expect(await notices()).toEqual([]);
		expect(await backgroundTaskService.cancel(result.taskId)).toBe(true);
		const stoppedAt = published.mock.calls.length;
		await Bun.sleep(40);
		expect(published).toHaveBeenCalledTimes(stoppedAt);
		expect((await row(result.taskId))?.status).toBe("cancelled");
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test("publication recovers beyond the old retry budget and delivers its frozen result exactly once", async () => {
		const publish = backgroundTaskService.markCompleted.bind(backgroundTaskService);
		const firstAttempt = Promise.withResolvers<void>();
		let attempts = 0;
		const published = spyOn(backgroundTaskService, "markCompleted").mockImplementation(
			async (...args) => {
				if (++attempts <= 5) {
					firstAttempt.resolve();
					throw new Error("temporary publication failure");
				}
				return publish(...args);
			},
		);
		const schedule = globalThis.setTimeout;
		spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [handler, delay, ...rest] = args;
			const retry =
				PUBLISH_RETRY_DELAYS_MS.some((value) => value === delay) ||
				delay === MAX_PUBLISH_RETRY_DELAY_MS;
			return schedule(handler, retry ? 5 : delay, ...rest);
		}) as typeof setTimeout);
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await startWithCursor(buffer, "READY");
		output(buffer, "READY original result\r\n");
		await firstAttempt.promise;
		expect(activeWatchIds(TERMINAL)).toEqual([]);
		const read = spyOn(buffer, "readCursor");
		output(buffer, "unrelated later output\r\n");
		await endWatchesForBuffer(TERMINAL, buffer, "the terminal exited");
		expect(read).not.toHaveBeenCalled();
		const done = await waitForStatus(id);
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("READY original result");
		expect(done?.output).not.toContain("unrelated later output");
		expect(published).toHaveBeenCalledTimes(6);
		expect(await notices()).toHaveLength(1);
		expect(wakes).toEqual([PARENT]);
		await Bun.sleep(40);
		expect(await notices()).toHaveLength(1);
		expect(published).toHaveBeenCalledTimes(6);
	});

	test("ending the buffer fails the watch after a last match attempt", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const missed = await start(buffer, "NEVER", { kind: "offset", offset: 0 });
		const lastMinute = await start(buffer, "BYE", { kind: "offset", offset: 0 });
		// Output that lands right before exit, with no check run yet.
		buffer.append("BYE\r\n");
		await endWatchesForBuffer(TERMINAL, buffer, "the terminal exited");
		expect((await waitForStatus(lastMinute))?.status).toBe("completed");
		const failed = await waitForStatus(missed);
		expect(failed?.status).toBe("failed");
		expect(failed?.output).toContain("the terminal exited");
	});

	test("ending a buffer preserves an in-flight frozen match until publication commits", async () => {
		const buffer = newBuffer();
		output(buffer, "$ ");
		const id = await start(buffer, "BYE", { kind: "offset", offset: 0 });
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const publish = backgroundTaskService.markCompleted.bind(backgroundTaskService);
		const completed = spyOn(backgroundTaskService, "markCompleted").mockImplementation(
			async (...args) => {
				entered.resolve();
				await gate.promise;
				return publish(...args);
			},
		);
		try {
			output(buffer, "BYE\r\n");
			await entered.promise;
			await endWatchesForBuffer(TERMINAL, buffer, "the terminal exited");
			expect((await row(id))?.status).toBe("running");
			expect(completed).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve();
		}
		const done = await waitForStatus(id);
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain('"BYE" appeared');
		expect(completed).toHaveBeenCalledTimes(1);
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
		expect(recovered?.output).toMatch(/interrupted.*server restart/i);
		// A text watch cannot prove it saw output produced while no server ran.
		expect(recovered?.output).toContain("The watch did not stop the target");
	});
});

describe("terminal lifecycle watches are re-attached after a restart", () => {
	async function seedTerminal(status: "running" | "exited" = "running") {
		const { terminals } = await import("../../db/schema");
		db.insert(terminals)
			.values({
				id: TERMINAL,
				narratorId: PARENT,
				name: "T",
				status,
				createdAt: new Date().toISOString(),
			})
			.run();
	}

	/** Shut down, then recover as a fresh process: the dtach session is attached again. */
	async function restartWith(buffer: BufferManager | undefined, attached: boolean) {
		suspendTerminalWatchesForShutdown();
		await backgroundTaskService.killAll();
		resumeTerminalWatchesForTests();
		const { terminalService } = await import("../terminal-service");
		spyOn(terminalService, "isAttached").mockReturnValue(attached);
		spyOn(terminalService, "getActiveBuffer").mockReturnValue(buffer);
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		// Terminal re-attachment runs after narrator recovery, off the startup path.
		const deadline = Date.now() + 3_000;
		while (Date.now() < deadline) {
			const pending = db
				.select()
				.from(backgroundTasks)
				.all()
				.filter((task) => task.status === "running" && !activeWatchIds(TERMINAL).includes(task.id));
			if (pending.length === 0) return;
			await Bun.sleep(10);
		}
	}

	test("a live terminal keeps its watch and reports the later exit", async () => {
		await seedTerminal();
		const buffer = newBuffer();
		const id = await startLifecycle(buffer);
		await restartWith(buffer, true);
		expect((await row(id))?.status).toBe("running");
		expect(activeWatchIds(TERMINAL)).toEqual([id]);
		await endWatchesForBuffer(TERMINAL, buffer, "the terminal exited or was closed");
		const ended = await waitForStatus(id);
		expect(ended?.status).toBe("completed");
		expect(ended?.output).toContain("the terminal exited or was closed");
	});

	test("a terminal that exited while the server was down reports that exit, not an interruption", async () => {
		await seedTerminal();
		const id = await startLifecycle(newBuffer());
		const { terminals } = await import("../../db/schema");
		db.update(terminals).set({ status: "exited" }).where(eq(terminals.id, TERMINAL)).run();
		await restartWith(undefined, false);
		const ended = await waitForStatus(id);
		expect(ended?.status).toBe("completed");
		expect(ended?.output).toContain("the terminal exited or was closed");
		expect(ended?.output).not.toMatch(/interrupted.*server restart/i);
	});

	test("a terminal that no longer belongs to the watcher ends as interrupted", async () => {
		await seedTerminal();
		const id = await startLifecycle(newBuffer());
		const { terminals } = await import("../../db/schema");
		db.update(terminals).set({ narratorId: null }).where(eq(terminals.id, TERMINAL)).run();
		await restartWith(undefined, false);
		const ended = await row(id);
		expect(ended?.status).toBe("failed");
		expect(ended?.output).toMatch(/interrupted.*server restart/i);
	});
});
