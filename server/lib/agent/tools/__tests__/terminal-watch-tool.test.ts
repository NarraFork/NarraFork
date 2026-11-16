import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../../../tests/setup";
import { db, sqlite } from "../../../../db";
import { backgroundTasks, narrators, terminals } from "../../../../db/schema";
import type { TerminalReadObserver } from "../../../../services/terminal-service";
import { BufferManager } from "../../../../terminal/buffer-manager";
import type { ToolContext, ToolResult } from "../../types";

const NARRATOR = "terminal-tool-narrator";
const TERMINAL = "terminal-tool-term";

let buffer: BufferManager;
/** What the fake shell prints after echoing a written chunk. */
let respond: (input: string) => string = () => "";
let afterObservation: (() => Promise<void>) | undefined;
const fixtureTerminalIds = new Set<string>();
const fixtureBuffers = new Set<BufferManager>();
const pendingTools = new Set<Promise<ToolResult>>();
const observationReleases = new Set<() => void>();

const realTerminalService = { ...(await import("@server/services/terminal-service")) };
const { notifyTerminalOutput, activeWatchIds, endWatchesForBuffer } = await import(
	"@server/services/terminal-watch-service"
);
function emit(data: string) {
	buffer.append(data);
	notifyTerminalOutput(TERMINAL);
}
mock.module("@server/services/terminal-service", () => ({
	...realTerminalService,
	terminalService: {
		isAttached: () => true,
		reattach: async () => true,
		getActiveBuffer: () => buffer,
		getScrollback: async (_id: string, observe?: TerminalReadObserver) => {
			const source = buffer;
			const data = await source.getContents(
				observe ? (point, sequence) => observe(source, point, sequence) : undefined,
			);
			if (observe) await afterObservation?.();
			return { data, cols: source.cols, rows: source.rows };
		},
		write: (_id: string, input: string) => {
			emit(input.replace(/\n/g, "\r\n"));
			const reply = respond(input);
			if (reply) emit(reply);
		},
	},
}));
const { terminalTool, extractPlainText, resetCursorForTerminal, MAX_TERMINAL_READ_CURSORS } =
	await import("../terminal");
const { backgroundTaskService } = await import("@server/services/background-task-service");
const { runtimePublication } = await import("@server/services/agent-runtime/publication");
runtimePublication.stop();
runtimePublication.setWake(() => {});
backgroundTaskService.setBroadcastFnForTests(() => {});

afterAll(() => {
	mock.module("@server/services/terminal-service", () => realTerminalService);
	mock.restore();
});

beforeEach(() => {
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id: NARRATOR, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
		.run();
	db.insert(terminals)
		.values({ id: TERMINAL, narratorId: NARRATOR, name: "T", status: "running", createdAt: now })
		.run();
	fixtureTerminalIds.add(TERMINAL);
	buffer = new BufferManager(TERMINAL, 80, 24);
	fixtureBuffers.add(buffer);
	buffer.append("user@host:~$ ");
	respond = () => "";
	afterObservation = undefined;
	resetCursorForTerminal(TERMINAL);
});
afterEach(async () => {
	afterObservation = undefined;
	for (const release of observationReleases) release();
	await Promise.allSettled(pendingTools);
	for (const terminalId of fixtureTerminalIds) {
		resetCursorForTerminal(terminalId);
		for (const id of activeWatchIds(terminalId)) await backgroundTaskService.cancel(id);
	}
	for (const source of fixtureBuffers) await source.dispose(true);
	fixtureTerminalIds.clear();
	fixtureBuffers.clear();
	cleanDb(sqlite);
});

function run(args: Record<string, unknown>, signal = new AbortController().signal) {
	const pending = terminalTool.execute({ terminal_id: TERMINAL, ...args }, {
		narratorId: NARRATOR,
		signal,
	} as unknown as ToolContext);
	pendingTools.add(pending);
	void pending.then(
		() => pendingTools.delete(pending),
		() => pendingTools.delete(pending),
	);
	return pending;
}

/** Pause only the next DTO response, after the real buffer captured its observation. */
function pauseNextObservation(failure?: Error) {
	const observed = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	const release = () => {
		observationReleases.delete(release);
		resumed.resolve();
	};
	observationReleases.add(release);
	afterObservation = async () => {
		afterObservation = undefined;
		observed.resolve();
		await resumed.promise;
		if (failure) throw failure;
	};
	return {
		release,
		async waitForCapture() {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					observed.promise,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("Observation was not captured")), 1_500);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

async function watchRows() {
	return db
		.select()
		.from(backgroundTasks)
		.where(eq(backgroundTasks.parentNarratorId, NARRATOR))
		.all();
}

async function waitForWatchStatus() {
	const deadline = Date.now() + 3_000;
	let task = (await watchRows())[0];
	while (task?.status === "running" && Date.now() < deadline) {
		await Bun.sleep(20);
		task = (await watchRows())[0];
	}
	return task;
}

/** A completed real timeout proves that history was never matched, without timing a running row. */
async function expectWatchToIgnoreHistory(pattern: string) {
	const result = await run({ action: "watch", pattern, timeout: 1 });
	expect(result.isError).toBeFalsy();
	expect((await waitForWatchStatus())?.status).toBe("timeout");
}

describe("Terminal tool watches", () => {
	test("extractPlainText normalises CRLF rows", () => {
		expect(extractPlainText("a\r\nb\r\n$ ")).toBe("a\nb\n$ ");
	});

	test("the schema exposes start_at and no longer offers wait_for", () => {
		const shape = (terminalTool.parameters as unknown as { shape: Record<string, unknown> }).shape;
		expect(shape.wait_for).toBeUndefined();
		expect(shape.notify_on).toBeDefined();
		expect(shape.start_at).toBeDefined();
		for (const start_at of ["last_observation", "now"]) {
			expect(
				terminalTool.parameters.safeParse({ action: "watch", pattern: "READY", start_at }).success,
			).toBe(true);
		}
		expect(
			terminalTool.parameters.safeParse({ action: "watch", start_at: "response_return" }).success,
		).toBe(false);
	});

	test("write + notify_on reports a marker that already appeared and starts no watch", async () => {
		respond = () => "64 bytes\r\n__DONE2__\r\nuser@host:~$ ";
		const result = await run({
			action: "write",
			input: "ping x; echo __DONE2__\n",
			notify_on: "__DONE2__",
		});
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("already appeared; no watch was started");
		expect(await watchRows()).toEqual([]);
	});

	test("write + notify_on starts a watch that completes when the command finishes", async () => {
		const result = await run({
			action: "write",
			input: "sleep 9; echo __DONE2__\n",
			notify_on: "__DONE2__\n",
			timeout: 60,
		});
		expect(result.output).toContain("Watching terminal");
		const [task] = await watchRows();
		expect(task?.status).toBe("running");
		emit("__DONE2__\r\nuser@host:~$ ");
		const deadline = Date.now() + 3_000;
		let status = task?.status;
		while (status === "running" && Date.now() < deadline) {
			await Bun.sleep(20);
			status = (await watchRows())[0]?.status;
		}
		expect(status).toBe("completed");
	});

	test("watch only matches output from now on", async () => {
		emit("old READY line\r\nuser@host:~$ ");
		const result = await run({ action: "watch", pattern: "READY" });
		expect(result.isError).toBeFalsy();
		await Bun.sleep(600);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("\r\nnew READY\r\n");
		const deadline = Date.now() + 3_000;
		let status: string | undefined = "running";
		while (status === "running" && Date.now() < deadline) {
			await Bun.sleep(20);
			status = (await watchRows())[0]?.status;
		}
		expect(status).toBe("completed");
	});

	test("watch matches a completion marker that overwrites the current progress row", async () => {
		emit("working with a long progress message");
		const result = await run({ action: "watch", pattern: "[release-and-quick] total" });
		expect(result.isError).toBeFalsy();
		emit("\r\x1b[2K[release-and-quick] total 625.114s\r\nuser@host:~$ ");
		const done = await waitForWatchStatus();
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("[release-and-quick] total 625.114s");
	});

	test("rewriting a prefix does not match an unchanged historical marker", async () => {
		emit("working READY");
		await run({ action: "watch", pattern: "READY" });
		emit("\rUser@host:~$ Working");
		await Bun.sleep(600);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("\r\nnew READY\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("watch matches a rewritten marker split across output chunks", async () => {
		emit("waiting for a long running deployment");
		await run({ action: "watch", pattern: "[release-and-quick] total" });
		emit("\r\x1b[2K[release-and-");
		await Bun.sleep(600);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("quick] total 625.114s\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("watch catches completion appended after the previous read but before registration", async () => {
		emit("working...\r\n");
		await run({ action: "read" });
		emit("[release-and-quick] total 625.114s\r\nuser@host:~$ ");
		await run({ action: "watch", pattern: "[release-and-quick] total" });
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("watch catches completion appended after a write response", async () => {
		respond = () => "working...\r\n";
		await run({ action: "write", input: "deploy\n" });
		emit("READY\r\nuser@host:~$ ");
		await run({ action: "watch", pattern: "READY" });
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("start_at now deliberately ignores unread output before registration", async () => {
		await run({ action: "read" });
		emit("READY from the registration gap\r\nuser@host:~$ ");
		await run({ action: "watch", pattern: "READY", start_at: "now" });
		await Bun.sleep(300);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("\r\nREADY next occurrence\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("a returned read snapshot excludes earlier historical completions", async () => {
		emit("READY old command\r\nuser@host:~$ ");
		await run({ action: "read", last_n_lines: 1 });
		emit("new command still working\r\n");
		await run({ action: "watch", pattern: "READY" });
		await Bun.sleep(300);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("READY new command\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("independent watches retain their own clones of an earlier observation", async () => {
		await run({ action: "read" });
		emit("FIRST\r\nSECOND\r\nuser@host:~$ ");
		await run({ action: "watch", pattern: "FIRST" });
		expect((await waitForWatchStatus())?.status).toBe("completed");
		await run({ action: "watch", pattern: "SECOND" });
		const deadline = Date.now() + 3_000;
		while ((await watchRows()).some((task) => task.status === "running") && Date.now() < deadline)
			await Bun.sleep(20);
		expect((await watchRows()).map((task) => task.status)).toEqual(["completed", "completed"]);
	});

	test("unread output is not a command boundary when a human starts another command", async () => {
		await run({ action: "read" });
		emit("A: READY\r\nB: still running\r\n");
		await run({ action: "watch", pattern: "READY" });
		const result = await waitForWatchStatus();
		expect(result?.status).toBe("completed");
		expect(result?.output).toContain("A: READY");
		expect(result?.output).toContain('"READY" appeared');
	});

	test("watch catches output appended after snapshot capture but before the read returns", async () => {
		const gate = pauseNextObservation();
		const pending = run({ action: "read" });
		try {
			await gate.waitForCapture();
			emit("READY in the response gap\r\n");
			gate.release();
			const result = await pending;
			expect(result.isError).toBeFalsy();
			expect(result.output).not.toContain("READY");
			const watch = await run({ action: "watch", pattern: "READY" });
			expect(watch.isError).toBeFalsy();
			const done = await waitForWatchStatus();
			expect(done?.status).toBe("completed");
			expect(done?.output).toContain("READY in the response gap");
		} finally {
			gate.release();
			await pending.catch(() => {});
		}
	});

	test("an older read response cannot roll back a newer committed observation", async () => {
		const gate = pauseNextObservation();
		const older = run({ action: "read" });
		try {
			await gate.waitForCapture();
			emit("READY already consumed by the newer read\r\n");
			const newer = await run({ action: "read" });
			expect(newer.isError).toBeFalsy();
			expect(newer.output).toContain("READY");
			gate.release();
			const result = await older;
			expect(result.isError).toBeFalsy();
			expect(result.output).not.toContain("READY");
			await expectWatchToIgnoreHistory("READY");
			expect((await run({ action: "read" })).output).toBe("(no new output since last read)");
		} finally {
			gate.release();
			await older.catch(() => {});
		}
	});

	test("reset during an in-flight read prevents its old candidate from reviving the cache", async () => {
		await run({ action: "read" });
		const gate = pauseNextObservation();
		const pending = run({ action: "read" });
		try {
			await gate.waitForCapture();
			resetCursorForTerminal(TERMINAL);
			emit("READY before post-reset watch registration\r\n");
			gate.release();
			expect((await pending).isError).toBeFalsy();
			await expectWatchToIgnoreHistory("READY");
			// Reset also discarded the incremental frontier; the late response must not restore it.
			expect((await run({ action: "read" })).output).toContain("user@host:~$");
		} finally {
			gate.release();
			await pending.catch(() => {});
		}
	});

	test("cache eviction during an in-flight read prevents its old candidate from reviving the cache", async () => {
		await run({ action: "read" });
		const gate = pauseNextObservation();
		const pending = run({ action: "read" });
		try {
			await gate.waitForCapture();
			const now = new Date().toISOString();
			const additional = Array.from({ length: MAX_TERMINAL_READ_CURSORS + 1 }, (_, index) => ({
				id: `terminal-tool-eviction-${index}`,
				narratorId: NARRATOR,
				name: `Eviction ${index}`,
				status: "running" as const,
				createdAt: now,
			}));
			db.insert(terminals).values(additional).run();
			for (const terminal of additional) {
				fixtureTerminalIds.add(terminal.id);
				// Distinct cache keys, but real observations on the same fixture buffer.
				expect((await run({ action: "read", terminal_id: terminal.id })).isError).toBeFalsy();
			}
			emit("READY before post-eviction watch registration\r\n");
			gate.release();
			expect((await pending).isError).toBeFalsy();
			await expectWatchToIgnoreHistory("READY");
			expect((await run({ action: "read" })).output).toContain("user@host:~$");
		} finally {
			gate.release();
			await pending.catch(() => {});
		}
	}, 10_000);

	for (const outcome of ["failed", "aborted"] as const) {
		test(`${outcome} reads discard their candidate and retain the last successful observation`, async () => {
			expect((await run({ action: "read" })).isError).toBeFalsy();
			emit("READY after the last successful observation\r\n");
			const failure = new Error("fixture read response failed after observation");
			const gate = pauseNextObservation(outcome === "failed" ? failure : undefined);
			const controller = new AbortController();
			const pending = run({ action: "read" }, controller.signal);
			const settled = pending.then(
				(result) => ({ result, error: undefined }),
				(error: unknown) => ({ result: undefined, error }),
			);
			try {
				await gate.waitForCapture();
				if (outcome === "aborted") controller.abort();
				gate.release();
				const result = await settled;
				if (outcome === "failed") expect(result.error).toBe(failure);
				else {
					expect(result.error).toBeUndefined();
					expect(result.result?.isError).toBe(true);
					expect(result.result?.output).toContain("aborted");
				}
				const watch = await run({ action: "watch", pattern: "READY" });
				expect(watch.isError).toBeFalsy();
				expect((await waitForWatchStatus())?.status).toBe("completed");
				// A failed observation must not consume incremental output either.
				expect((await run({ action: "read" })).output).toContain("READY");
			} finally {
				gate.release();
				await settled;
			}
		});
	}

	test("an old-buffer response cannot replace a new-buffer observation and swallow its gap", async () => {
		await run({ action: "read" });
		emit("old buffer is still busy\r\n");
		const gate = pauseNextObservation();
		const pending = run({ action: "read" });
		try {
			await gate.waitForCapture();
			buffer = new BufferManager(`${TERMINAL}-replacement`, 80, 24);
			fixtureBuffers.add(buffer);
			buffer.append("replacement> ");
			// Switching sources also invalidates the old incremental length, even if equal.
			expect((await run({ action: "read" })).output).toContain("replacement>");
			emit("READY on the replacement buffer\r\n");
			gate.release();
			const old = await pending;
			expect(old.isError).toBeFalsy();
			expect(old.output).not.toContain("replacement>");
			const watch = await run({ action: "watch", pattern: "READY" });
			expect(watch.isError).toBeFalsy();
			const done = await waitForWatchStatus();
			expect(done?.status).toBe("completed");
			expect(done?.output).toContain("READY on the replacement buffer");
		} finally {
			gate.release();
			await pending.catch(() => {});
		}
	});

	test("horizontal reflow preserves the last observation without replaying an old marker", async () => {
		emit(`${"x".repeat(70)} READY old`);
		await run({ action: "read" });
		await buffer.resize(160, 24);
		const result = await run({ action: "watch", pattern: "READY" });
		expect(result.output).toContain(
			"Matching scope: since the last successful read/write snapshot",
		);
		await Bun.sleep(300);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("\r\nREADY after reflow\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("resize round trips cannot revive an already observed completion", async () => {
		emit(`${"x".repeat(70)} READY old`);
		await run({ action: "read" });
		emit("\r\nuser@host:~$ ");
		await buffer.resize(160, 24);
		await buffer.resize(80, 24);
		const result = await run({ action: "watch", pattern: "READY" });
		expect(result.output).toContain(
			"Matching scope: since the last successful read/write snapshot",
		);
		await Bun.sleep(300);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("\r\nREADY after resize round trip\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test.each([
		["current paragraph", `${"x".repeat(70)} READY old`],
		["observed tail paragraph", `first\r\n${"x".repeat(70)} READY old\x1b[1A`],
	])("an active watch survives narrowing its %s without matching history", async (_label, oldText) => {
		emit(oldText);
		await run({ action: "read" });
		await run({ action: "watch", pattern: "READY" });
		await buffer.resize(40, 24);
		notifyTerminalOutput(TERMINAL);
		await Bun.sleep(600);
		expect((await watchRows())[0]?.status).toBe("running");
		expect(activeWatchIds(TERMINAL)).toHaveLength(1);
		emit("\r\nREADY after narrowing\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("an active watch survives a horizontal layout ABA without matching history", async () => {
		emit(`first\r\n${"x".repeat(70)} READY old\x1b[1A`);
		await run({ action: "read" });
		await run({ action: "watch", pattern: "READY" });
		await buffer.resize(40, 24);
		await buffer.resize(80, 24);
		notifyTerminalOutput(TERMINAL);
		await Bun.sleep(600);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("\r\nREADY after layout ABA\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("a resize during asynchronous watch registration preserves the historical frontier", async () => {
		emit(`first\r\n${"x".repeat(70)} READY old\x1b[1A`);
		await run({ action: "read" });
		const create = backgroundTaskService.createBashTask.bind(backgroundTaskService);
		const registration = spyOn(backgroundTaskService, "createBashTask").mockImplementationOnce(
			async (input) => {
				await buffer.resize(40, 24);
				return create(input);
			},
		);
		try {
			expect((await run({ action: "watch", pattern: "READY" })).isError).toBeFalsy();
			await Bun.sleep(600);
			expect((await watchRows())[0]?.status).toBe("running");
			emit("\r\nREADY after registration\r\n");
			expect((await waitForWatchStatus())?.status).toBe("completed");
		} finally {
			registration.mockRestore();
		}
	});

	test.each([
		160, 40,
	])("last_observation retains unread READY across resize to %s columns", async (cols) => {
		emit("\r\x1b[2Kworking");
		await run({ action: "read" });
		emit(`\r\x1b[2K${"x".repeat(60)} READY unread`);
		await buffer.resize(cols, 24);
		if (cols === 40) expect(await buffer.getContents()).not.toContain("READY");
		const result = await run({ action: "watch", pattern: "READY" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("since the last successful read/write snapshot");
		const done = await waitForWatchStatus();
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("READY unread");
	});

	test("output and resize during asynchronous watch registration still complete the watch", async () => {
		await run({ action: "read" });
		const create = backgroundTaskService.createBashTask.bind(backgroundTaskService);
		const registration = spyOn(backgroundTaskService, "createBashTask").mockImplementationOnce(
			async (input) => {
				emit(`\r\x1b[2K${"x".repeat(60)} READY during registration`);
				await buffer.resize(40, 24);
				return create(input);
			},
		);
		try {
			expect((await run({ action: "watch", pattern: "READY" })).isError).toBeFalsy();
			expect((await waitForWatchStatus())?.status).toBe("completed");
		} finally {
			registration.mockRestore();
		}
	});

	test("an active watch matches unchecked output saved before narrowing clips it", async () => {
		await run({ action: "watch", pattern: "READY" });
		// Do not notify: resize must retain output before any scheduled watch check sees it.
		buffer.append(`\r\x1b[2K${"x".repeat(60)} READY unchecked`);
		await buffer.resize(40, 24);
		expect(await buffer.getContents()).not.toContain("READY");
		notifyTerminalOutput(TERMINAL);
		const done = await waitForWatchStatus();
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("READY unchecked");
	});

	test("a partial new literal survives a resize between RE and ADY", async () => {
		emit("\r\x1b[2K");
		await run({ action: "watch", pattern: "READY" });
		emit("RE");
		await Bun.sleep(600);
		expect((await watchRows())[0]?.status).toBe("running");
		await buffer.resize(40, 24);
		emit("ADY\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("start_at now ignores READY in historical layout frames", async () => {
		await run({ action: "read" });
		emit(`\r\x1b[2K${"x".repeat(60)} READY before resize`);
		await buffer.resize(40, 24);
		await buffer.resize(80, 24);
		const result = await run({ action: "watch", pattern: "READY", start_at: "now" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Matching scope: new output from now");
		await Bun.sleep(600);
		expect((await watchRows())[0]?.status).toBe("running");
		emit("\r\nREADY genuinely new\r\n");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("notify_on excludes a READY command echo across resize before registration", async () => {
		const gate = pauseNextObservation();
		const pending = run({ action: "write", input: "echo READY later\n", notify_on: "READY" });
		try {
			await gate.waitForCapture();
			await buffer.resize(12, 24);
			gate.release();
			const result = await pending;
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("Watching terminal");
			await Bun.sleep(600);
			expect((await watchRows())[0]?.status).toBe("running");
			emit("\r\nREADY\r\n");
			expect((await waitForWatchStatus())?.status).toBe("completed");
		} finally {
			gate.release();
			await pending.catch(() => {});
		}
	});

	test("cancelling a resized watch disposes its observation and releases its markers", async () => {
		await run({ action: "read" });
		const clone = buffer.cloneReadCursor.bind(buffer);
		const dispose = mock(() => {});
		let cursor: ReturnType<BufferManager["cloneReadCursor"]>;
		const cloned = spyOn(buffer, "cloneReadCursor").mockImplementationOnce((source) => {
			cursor = clone(source);
			if (cursor) {
				const release = cursor.dispose.bind(cursor);
				cursor.dispose = () => {
					dispose();
					release();
				};
			}
			return cursor;
		});
		try {
			await run({ action: "watch", pattern: "NEVER" });
			await buffer.resize(40, 24);
			const [task] = await watchRows();
			expect(task?.status).toBe("running");
			expect(cursor).toBeDefined();
			if (!task) throw new Error("Watch was not registered");
			await backgroundTaskService.cancel(task.id);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(cursor?.marker.isDisposed).toBe(true);
			expect(cursor?.observedEndMarker?.isDisposed ?? true).toBe(true);
			expect(activeWatchIds(TERMINAL)).toEqual([]);
			await buffer.resize(80, 24);
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			cloned.mockRestore();
		}
	});

	test("an active watch keeps matching after a row-only resize", async () => {
		emit("old READY");
		await run({ action: "read" });
		await run({ action: "watch", pattern: "READY" });
		await buffer.resize(80, 30);
		emit("\r\nREADY after row-only resize\r\n");
		await endWatchesForBuffer(TERMINAL, buffer, "row-only resize regression ended");
		const done = await waitForWatchStatus();
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("READY after row-only resize");
	});

	test("an incremental truncated response still consumes the complete snapshot", async () => {
		emit(`READY hidden by the output budget\r\n${`${"x".repeat(180)}\r\n`.repeat(500)}`);
		const result = await run({ action: "read" });
		expect(result.output).not.toContain("READY hidden");
		await expectWatchToIgnoreHistory("READY");
	});

	test("notify_on cannot claim an immediate match after its echo buffer changes", async () => {
		respond = () => "READY\r\nuser@host:~$ ";
		const source = buffer;
		const read = source.readCursor.bind(source);
		const changed = spyOn(source, "readCursor").mockImplementation(async (cursor) => {
			const result = await read(cursor);
			buffer = new BufferManager(`${TERMINAL}-new-echo`, 80, 24);
			fixtureBuffers.add(buffer);
			buffer.append("different connection> ");
			return result;
		});
		try {
			const result = await run({ action: "write", input: "deploy\n", notify_on: "READY" });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("Input was sent");
			expect(result.output).toContain("do not resend input automatically");
			expect(changed).toHaveBeenCalledTimes(1);
			expect(await watchRows()).toEqual([]);
		} finally {
			changed.mockRestore();
		}
	});

	test.each([
		["one inserted blank", "\r\x1b[@"],
		["blanks beyond the old offset", "\r\x1b[30@"],
		["deleted leading cells", "\r\x1b[3P"],
	])("moving observed READY by %s cannot complete a watch", async (_label, movement) => {
		emit("old READY");
		await run({ action: "read" });
		await run({ action: "watch", pattern: "READY" });
		emit(movement);
		await buffer.flush();
		// A final, awaited check removes timer races from this negative assertion.
		await endWatchesForBuffer(TERMINAL, buffer, "negative review regression ended");
		const done = await waitForWatchStatus();
		expect(done?.status).toBe("failed");
		expect(done?.output?.startsWith('"READY" appeared')).toBe(false);
	});

	test("erasing an observed READY and appending a new READY in one batch still completes", async () => {
		emit("old READY");
		await run({ action: "read" });
		await run({ action: "watch", pattern: "READY" });
		emit("\r\x1b[2K\r\nREADY from a new row\r\n");
		await endWatchesForBuffer(TERMINAL, buffer, "positive review regression ended");
		const done = await waitForWatchStatus();
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("READY from a new row");
	});

	test("old rows inserted below the cursor stay behind the observed end marker", async () => {
		emit("first old row\r\nold READY\x1b[1A");
		await run({ action: "read" });
		await run({ action: "watch", pattern: "READY" });
		emit("\x1b[2;1H\x1b[L");
		await buffer.flush();
		await endWatchesForBuffer(TERMINAL, buffer, "row insertion review regression ended");
		expect((await waitForWatchStatus())?.status).toBe("failed");
	});

	test("an observed trailing newline does not become new when an old tail row is erased", async () => {
		emit("old READY\r\nold tail\x1b[1A");
		await run({ action: "read" });
		await run({ action: "watch", pattern: "READY\n" });
		emit("\x1b[2;1H\x1b[2K\r\nunrelated new row");
		await endWatchesForBuffer(TERMINAL, buffer, "old newline regression ended");
		expect((await waitForWatchStatus())?.status).toBe("failed");
	});

	test("a new literal crossing the observed row into a soft wrap completes", async () => {
		emit("old READY");
		await run({ action: "read" });
		await run({ action: "watch", pattern: "READY" });
		emit(`${" ".repeat(56)}READY`);
		await endWatchesForBuffer(TERMINAL, buffer, "soft wrap review regression ended");
		expect((await waitForWatchStatus())?.status).toBe("completed");
	});

	test("oversized notify_on rejects before input is sent or a watch is created", async () => {
		let writes = 0;
		respond = () => {
			writes++;
			return "";
		};
		const result = await run({
			action: "write",
			input: "must-not-run\n",
			notify_on: "x".repeat(16_385),
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Nothing was sent");
		expect(writes).toBe(0);
		expect(await watchRows()).toEqual([]);
	});

	test("watch requires a pattern", async () => {
		const result = await run({ action: "watch" });
		expect(result.isError).toBe(true);
	});
});
