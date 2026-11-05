import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../../../tests/setup";
import { db, sqlite } from "../../../../db";
import { backgroundTasks, narrators, terminals } from "../../../../db/schema";
import { BufferManager } from "../../../../terminal/buffer-manager";
import type { ToolContext } from "../../types";

const NARRATOR = "terminal-tool-narrator";
const TERMINAL = "terminal-tool-term";

let buffer: BufferManager;
/** What the fake shell prints after echoing a written chunk. */
let respond: (input: string) => string = () => "";

const realTerminalService = { ...(await import("@server/services/terminal-service")) };
const { notifyTerminalOutput, activeWatchIds } = await import(
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
		getScrollback: async () => ({ data: await buffer.getContents(), cols: 80, rows: 24 }),
		write: (_id: string, input: string) => {
			emit(input.replace(/\n/g, "\r\n"));
			const reply = respond(input);
			if (reply) emit(reply);
		},
	},
}));
const { terminalTool, extractPlainText } = await import("../terminal");
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
	buffer = new BufferManager(TERMINAL, 80, 24);
	buffer.append("user@host:~$ ");
	respond = () => "";
});
afterEach(async () => {
	for (const id of activeWatchIds(TERMINAL)) await backgroundTaskService.cancel(id);
	await buffer.dispose(true);
	cleanDb(sqlite);
});

function run(args: Record<string, unknown>) {
	return terminalTool.execute({ terminal_id: TERMINAL, ...args }, {
		narratorId: NARRATOR,
		signal: new AbortController().signal,
	} as unknown as ToolContext);
}

async function watchRows() {
	return db
		.select()
		.from(backgroundTasks)
		.where(eq(backgroundTasks.parentNarratorId, NARRATOR))
		.all();
}

describe("Terminal tool watches", () => {
	test("extractPlainText normalises CRLF rows", () => {
		expect(extractPlainText("a\r\nb\r\n$ ")).toBe("a\nb\n$ ");
	});

	test("the schema no longer offers wait_for", () => {
		const shape = (terminalTool.parameters as unknown as { shape: Record<string, unknown> }).shape;
		expect(shape.wait_for).toBeUndefined();
		expect(shape.notify_on).toBeDefined();
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

	test("watch requires a pattern", async () => {
		const result = await run({ action: "watch" });
		expect(result.isError).toBe(true);
	});
});
