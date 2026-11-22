import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { db, sqlite } from "../../../server/db";
import { narratorMessages, narrators, narratorToolCalls } from "../../../server/db/schema";
import { recallTool } from "../../../server/lib/agent/tools/recall";
import * as pool from "../../../server/lib/db-worker/pool";
import { generateId } from "../../../server/lib/id";

const createdAt = "2026-07-01T00:00:00.000Z";

function narrator(title: string) {
	const id = generateId();
	db.insert(narrators).values({ id, title, createdAt, updatedAt: createdAt }).run();
	return id;
}

function toolCall(narratorId: string, outputJson: Record<string, string>) {
	const id = generateId();
	const toolUseId = generateId();
	const messageId = generateId();
	db.insert(narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id,
			narratorId,
			messageId,
			toolUseId,
			toolName: "Read",
			status: "success",
			durationMs: 123,
			inputJson: { path: "/some/path/example.txt" },
			outputJson,
			createdAt,
		})
		.run();
	return { id, toolUseId };
}

function read(
	narratorId: string,
	toolUseId: string,
	allNarrators = false,
	signal = new AbortController().signal,
) {
	return recallTool.execute(
		{
			action: "read_tool_call",
			tool_call_id: toolUseId,
			all_narrators: allNarrators,
		},
		{ narratorId, signal } as never,
	);
}

function trackMainQueries() {
	return [spyOn(sqlite, "prepare"), spyOn(sqlite, "query")];
}

afterEach(() => mock.restore());

test("uses a Worker for scoped Recall details and preserves bounded text plus full metadata", async () => {
	const owner = narrator("Owner");
	const other = narrator("Other");
	const output = { _text: "🌿 abc\n".repeat(1100) };
	const { toolUseId } = toolCall(owner, output);
	const mainReads = trackMainQueries();
	const result = await read(owner, toolUseId);
	expect(result.title).toBe("Read: example.txt");
	expect(result.output).toContain("Status: success (123ms)");
	expect(result.output).toContain(
		`${output._text.slice(0, 4000)}\n... (truncated, ${output._text.length} chars total)`,
	);
	expect(result.metadata).toEqual({
		action: "read_tool_call",
		toolUseId,
		toolName: "Read",
		status: "success",
		durationMs: 123,
		narratorId: owner,
		narratorTitle: "Owner",
		input: { path: "/some/path/example.txt" },
		output,
	});
	expect(await read(other, toolUseId)).toMatchObject({ isError: true });
	expect((await read(other, toolUseId, true)).metadata).toEqual(result.metadata);
	for (const statement of mainReads) expect(statement).not.toHaveBeenCalled();
});

test("returns raw invalid JSON in the preview without changing metadata", async () => {
	const owner = narrator("Owner");
	const { id, toolUseId } = toolCall(owner, {});
	sqlite.query("UPDATE narrator_tool_calls SET output_json = ? WHERE id = ?").run("raw output", id);
	const result = await read(owner, toolUseId);
	expect(result.output).toContain("--- Output ---\nraw output");
	expect(result.metadata?.output).toBeNull();
});

test("oversized payloads are rejected after scope filtering instead of returned partially", async () => {
	const owner = narrator("Owner");
	const other = narrator("Other");
	const { id, toolUseId } = toolCall(owner, {});
	sqlite
		.query("UPDATE narrator_tool_calls SET output_json = CAST(zeroblob(?) AS TEXT) WHERE id = ?")
		.run(40 * 1024 * 1024, id);
	expect(await read(other, toolUseId)).toMatchObject({ isError: true });
	const failure = await read(owner, toolUseId).then(
		() => null,
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(pool.DbReadTaskExecutionError);
	expect((failure as Error).message).toContain("Recall tool call source exceeds its byte budget");
});

test("propagates Worker creation, execution, timeout and cancellation without fallback", async () => {
	const mainReads = trackMainQueries();
	const worker = spyOn(pool, "runReadTask");
	const controller = new AbortController();
	for (const error of [
		new pool.WorkersUnavailableError("creation_failed"),
		new pool.DbReadTaskExecutionError("execution failed"),
		new pool.DbReadTaskTimeoutError("timed out"),
	]) {
		worker.mockRejectedValueOnce(error);
		await expect(read("self", "tool", false, controller.signal)).rejects.toBe(error);
		expect(worker.mock.lastCall?.[2]?.signal).toBe(controller.signal);
	}
	const reason = new Error("turn cancelled");
	worker.mockImplementationOnce(async <T>() => {
		controller.abort(reason);
		return null as T;
	});
	await expect(read("self", "tool", false, controller.signal)).rejects.toBe(reason);
	for (const statement of mainReads) expect(statement).not.toHaveBeenCalled();
});

test("a disabled Worker does not fall back to inline detail", async () => {
	const mainReads = trackMainQueries();
	const previous = process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER = "off";
	try {
		await expect(read("self", "tool")).rejects.toMatchObject({ reason: "disabled_by_env" });
		for (const statement of mainReads) expect(statement).not.toHaveBeenCalled();
	} finally {
		if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
		else process.env.NARRAFORK_DB_WORKER = previous;
	}
});
