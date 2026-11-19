import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../../db/schema";
import { getNarratorWorkerTestDb } from "../../../../services/__tests__/narrator-worker-fixture";
import type { ToolContext } from "../../types";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDb = { ...(await import("../../../../db")) };
mock.module("../../../../db", () => ({ ...realDb, db, sqlite }));
const { recallTool } = await import("../recall");
const time = "2026-10-01T00:00:00.000Z";
const context: ToolContext = {
	narratorId: "recall-owner",
	cwd: process.cwd(),
	locale: "en",
	signal: new AbortController().signal,
	requestPermission: async () => ({ behavior: "allow" }),
};
beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators)
		.values({
			id: "recall-owner",
			title: "Reader",
			model: "test:model",
			createdAt: time,
			updatedAt: time,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: "message",
			narratorId: "recall-owner",
			role: "assistant",
			contentText: "persisted excerpt",
			contentJson: [],
			createdAt: time,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "ref", narratorId: "recall-owner", messageId: "message", seq: 1 })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "call",
			narratorId: "recall-owner",
			messageId: "message",
			toolUseId: "use",
			toolName: "Read",
			inputJson: { file_path: "source.ts" },
			outputJson: { output: "body" },
			status: "success",
			createdAt: time,
		})
		.run();
});
afterEach(() => mock.restore());
afterAll(async () => {
	mock.module("../../../../db", () => realDb);
	await fixture.close();
});

describe("Recall bounded Worker consumption", () => {
	test("conversation and detail use Worker snapshots while preserving the existing tool view", async () => {
		const prepare = spyOn(sqlite, "prepare");
		const conversation = await recallTool.execute({ action: "read_conversation" }, context);
		expect(conversation.isError).not.toBe(true);
		expect(conversation.output).toContain("persisted excerpt");
		expect(conversation.output).toContain("source.ts");
		const detail = await recallTool.execute(
			{ action: "read_tool_call", tool_call_id: "use" },
			context,
		);
		expect(detail.isError).not.toBe(true);
		expect(detail.output).toContain("body");
		expect(prepare).not.toHaveBeenCalled();
	});

	test("conversation scope denial is decided before any broader snapshot read", async () => {
		const prepare = spyOn(sqlite, "prepare");
		const result = await recallTool.execute(
			{ action: "read_conversation", narrator_id: "another" },
			context,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("scoped to the current narrator");
		expect(prepare).not.toHaveBeenCalled();
	});
});
