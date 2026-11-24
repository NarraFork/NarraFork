import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { db, sqlite } from "../../../server/db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../server/db/schema";
import { recallTool } from "../../../server/lib/agent/tools/recall";
import * as pool from "../../../server/lib/db-worker/pool";
import { generateId } from "../../../server/lib/id";

const createdAt = "2026-07-01T00:00:00.000Z";

function narrator(title: string) {
	const id = generateId();
	db.insert(narrators).values({ id, title, createdAt, updatedAt: createdAt }).run();
	return id;
}

function message(narratorId: string, contentText: string, seq: number, refFor = narratorId) {
	const id = generateId();
	db.insert(narratorMessages)
		.values({ id, narratorId, role: "assistant", contentJson: [], contentText, createdAt })
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: refFor, messageId: id, seq })
		.run();
	return id;
}

function call(narratorId: string, messageId: string, path: string) {
	const toolUseId = generateId();
	db.insert(narratorToolCalls)
		.values({
			id: generateId(),
			narratorId,
			messageId,
			toolUseId,
			toolName: "Read",
			status: "success",
			inputJson: { path },
			createdAt,
		})
		.run();
	return toolUseId;
}

function read(
	narratorId: string,
	args: Record<string, unknown> = {},
	signal = new AbortController().signal,
) {
	return recallTool.execute({ action: "read_conversation", ...args }, {
		narratorId,
		signal,
	} as never);
}

function trackMainQueries() {
	return [spyOn(sqlite, "prepare"), spyOn(sqlite, "query")];
}

afterEach(() => mock.restore());

test("reads the inclusive anchor window and summarizes only the current narrator's tools off-thread", async () => {
	const self = narrator("Self");
	const other = narrator("Other");
	const exactText = `hello\0${"写😄".repeat(200)}`;
	const shared = message(other, exactText, 1, self);
	const current = message(self, "current", 2);
	const last = message(self, "last", 3);
	call(other, shared, "/private/nonvisible.txt");
	const visible = call(self, current, "/example/visible.txt");
	const trace = trackMainQueries();

	const result = await read(self, { message_id: current, limit: 2 });
	expect(result.metadata).toMatchObject({
		narratorId: self,
		messages: [
			{ id: shared, seq: 1, text: exactText.slice(0, 500) },
			{ id: current, seq: 2, toolCalls: [{ toolUseId: visible, summary: "visible.txt" }] },
			{ id: last, seq: 3 },
		],
	});
	expect(result.output).not.toContain("nonvisible.txt");
	expect((await read(self, { limit: 1 })).metadata).toMatchObject({
		messages: [{ id: last }],
	});
	for (const prepare of trace) expect(prepare).not.toHaveBeenCalled();
});

test("keeps cross-narrator scope and exact message-reference checks", async () => {
	const self = narrator("Self");
	const other = narrator("Other");
	const privateMessage = message(other, "other content", 1);
	const trace = spyOn(pool, "runReadTask");
	expect(await read(self, { narrator_id: other })).toMatchObject({ isError: true });
	expect(trace).not.toHaveBeenCalled();
	expect(await read(self, { message_id: privateMessage })).toMatchObject({ isError: true });
	expect((await read(self, { narrator_id: other, all_narrators: true })).output).toContain(
		"other content",
	);
});

test("rejects an over-budget result rather than returning a truncated tool summary", async () => {
	const self = narrator("Self");
	call(self, message(self, "text", 1), "x".repeat(2 * 1024 * 1024));
	await expect(read(self)).rejects.toThrow("Recall conversation exceeds its read budget");
});

test("propagates Worker failures and cancellation without reading on the main thread", async () => {
	const self = narrator("Self");
	const trace = trackMainQueries();
	const worker = spyOn(pool, "runReadTask");
	const controller = new AbortController();
	for (const error of [
		new pool.WorkersUnavailableError("creation_failed"),
		new pool.DbReadTaskExecutionError("execution failed"),
		new pool.DbReadTaskTimeoutError("timed out"),
	]) {
		worker.mockRejectedValueOnce(error);
		await expect(read(self, {}, controller.signal)).rejects.toBe(error);
		expect(worker.mock.lastCall?.[2]?.signal).toBe(controller.signal);
	}
	const reason = new Error("turn cancelled");
	controller.abort(reason);
	await expect(read(self, {}, controller.signal)).rejects.toBe(reason);
	expect(worker).toHaveBeenCalledTimes(3);
	for (const prepare of trace) expect(prepare).not.toHaveBeenCalled();
});

test("a disabled Worker does not fall back to inline Recall browsing", async () => {
	const self = narrator("Self");
	const trace = trackMainQueries();
	const previous = process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER = "off";
	try {
		await expect(read(self)).rejects.toMatchObject({ reason: "disabled_by_env" });
		for (const prepare of trace) expect(prepare).not.toHaveBeenCalled();
	} finally {
		if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
		else process.env.NARRAFORK_DB_WORKER = previous;
	}
});
