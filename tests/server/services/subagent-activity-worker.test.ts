import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { clearedToolOutput } from "@shared/storage-retention";
import { db, sqlite } from "../../../server/db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../server/db/schema";
import * as pool from "../../../server/lib/db-worker/pool";
import { generateId } from "../../../server/lib/id";
import { narratorService } from "../../../server/services/narrator-service";

const now = "2026-08-01T00:00:00.000Z";

function fixture() {
	const narratorId = generateId();
	const childId = generateId();
	const parentMessage = generateId();
	const childMessage = generateId();
	const retainedChildMessage = generateId();
	const hiddenMessage = generateId();
	const parentCall = generateId();
	const parentUse = generateId();
	const childRef = generateId();
	db.transaction((tx) => {
		tx.insert(narrators)
			.values({ id: narratorId, createdAt: now, updatedAt: now, model: "claude-sonnet-4.5" })
			.run();
		tx.insert(narratorMessages)
			.values({
				id: parentMessage,
				narratorId,
				role: "assistant",
				contentJson: [{ type: "tool_use", id: parentUse, name: "Agent", input: {} }],
				createdAt: now,
			})
			.run();
		tx.insert(narratorMessageRefs)
			.values({
				id: generateId(),
				narratorId,
				messageId: parentMessage,
				seq: 1,
			})
			.run();
		tx.insert(narratorToolCalls)
			.values({
				id: parentCall,
				narratorId,
				messageId: parentMessage,
				toolUseId: parentUse,
				toolName: "Agent",
				status: "success",
				executionIdentityVersion: 1,
				createdAt: now,
			})
			.run();
		tx.insert(narrators)
			.values({
				id: childId,
				parentNarratorId: narratorId,
				originToolCallId: parentCall,
				type: "subagent",
				variant: "subagent:explore",
				subagentType: "explore",
				createdAt: now,
				updatedAt: now,
				model: "claude-sonnet-4.5",
			})
			.run();
		for (const id of [childMessage, retainedChildMessage, hiddenMessage]) {
			tx.insert(narratorMessages)
				.values({
					id,
					narratorId: childId,
					role: "assistant",
					parentToolUseId: parentUse,
					contentJson: [{ type: "text", text: "Child activity" }],
					createdAt: now,
				})
				.run();
		}
		tx.insert(narratorMessageRefs)
			.values({
				id: childRef,
				narratorId: childId,
				messageId: childMessage,
				seq: 1,
			})
			.run();
		tx.insert(narratorMessageRefs)
			.values({
				id: generateId(),
				narratorId: childId,
				messageId: retainedChildMessage,
				seq: 2,
			})
			.run();
		const rows = [
			{ toolUseId: "too-old", inputJson: { description: "old" } },
			{
				toolUseId: "label",
				executionAttempt: 2,
				inputJson: { file_path: "src/main.ts", private: "not returned" },
			},
			{ toolUseId: "invalid" },
			{
				toolUseId: "cleared",
				inputJson: { description: "deleted" },
				outputJson: clearedToolOutput(now),
			},
			{ toolUseId: "checkpoint", isFileHistoryCheckpoint: true },
			{ toolUseId: "not-a-member", messageId: hiddenMessage },
		];
		rows.forEach((row, index) => {
			tx.insert(narratorToolCalls)
				.values({
					id: `${childId}-${index}`,
					narratorId: childId,
					messageId: childMessage,
					toolName: "Read",
					status: "success",
					createdAt: now,
					...row,
				})
				.run();
		});
		sqlite
			.query("UPDATE narrator_tool_calls SET input_json = 'malformed' WHERE id = ?")
			.run(`${childId}-2`);
	});
	return { narratorId, childRef };
}

afterEach(() => mock.restore());

test("history snapshots return only the latest referenced public child call summaries", async () => {
	const scope = fixture();
	const spy = spyOn(pool, "runReadTask");
	const result = await narratorService.getPretextDocumentPage(scope.narratorId, { limit: 20 });
	expect(spy.mock.calls.some(([, task]) => task.kind === "subagentActivity")).toBe(true);
	const call = result.messages[0]?.contentJson?.find(
		(block: { type: string }) => block.type === "tool_use",
	);
	expect(call?._subagentActivity?.latestToolCalls).toEqual([
		expect.objectContaining({
			toolUseId: "label",
			executionAttempt: 2,
			inputSummary: { file_path: "src/main.ts" },
		}),
		expect.objectContaining({ toolUseId: "invalid" }),
		expect.objectContaining({ toolUseId: "cleared" }),
	]);
	expect(call?._subagentActivity?.latestToolCalls[1]).not.toHaveProperty("inputSummary");
	expect(call?._subagentActivity?.latestToolCalls[2]).not.toHaveProperty("inputSummary");
});

test("history will not return activity if the child reference is removed during the read", async () => {
	const scope = fixture();
	const original = pool.runReadTask;
	spyOn(pool, "runReadTask").mockImplementation(async (...args) => {
		const result = await original(...args);
		if (args[1].kind === "subagentActivity")
			sqlite.query("DELETE FROM narrator_message_refs WHERE id = ?").run(scope.childRef);
		return result as never;
	});
	await expect(
		narratorService.getPretextDocumentPage(scope.narratorId, { limit: 20 }),
	).rejects.toMatchObject({
		code: "HISTORY_AGGREGATE_UNAVAILABLE",
	});
});

test.each([
	["creation", new pool.WorkersUnavailableError("spawn_failed")],
	["execution", new pool.DbReadTaskExecutionError("activity read failed")],
	["timeout", new pool.DbReadTaskTimeoutError("activity read timed out")],
	["disabled", new pool.WorkersUnavailableError("disabled")],
])("history propagates an activity Worker %s failure without a local read", async (_, failure) => {
	const scope = fixture();
	const original = pool.runReadTask;
	const prepare = spyOn(sqlite, "prepare");
	spyOn(pool, "runReadTask").mockImplementation(async (...args) => {
		if (args[1].kind === "subagentActivity") throw failure;
		return (await original(...args)) as never;
	});
	await expect(
		narratorService.getPretextDocumentPage(scope.narratorId, { limit: 20 }),
	).rejects.toBe(failure);
	expect(prepare.mock.calls.some(([query]) => query.includes("json_object("))).toBe(false);
});

test("history forwards cancellation to the activity Worker", async () => {
	const scope = fixture();
	const controller = new AbortController();
	const original = pool.runReadTask;
	spyOn(pool, "runReadTask").mockImplementation(async (...args) => {
		if (args[1].kind === "subagentActivity") {
			expect(args[2]?.signal).toBe(controller.signal);
			controller.abort();
		}
		return (await original(...args)) as never;
	});
	await expect(
		narratorService.getPretextDocumentPage(scope.narratorId, {
			limit: 20,
			signal: controller.signal,
		}),
	).rejects.toThrow();
	expect(controller.signal.aborted).toBe(true);
});
