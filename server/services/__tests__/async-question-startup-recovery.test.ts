import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { ActiveNarrator } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { recoverPendingQuestionAnswerDeliveries } = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const time = "2026-10-05T00:00:00.000Z";
const activeIds = new Set<string>();
let nextSeq = 0;

function seedRecipient(id: string, reason: "normal" | "user_interrupt" | "error" = "normal") {
	db.insert(narrators)
		.values({
			id,
			status: "idle",
			lastStopReason: reason,
			createdAt: time,
			updatedAt: time,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: `ask-${id}`,
			narratorId: id,
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	// A live turn can coexist with the persisted idle snapshot at the safe drain
	// boundary. Keeping that turn active prevents real model dispatch in this test.
	activeNarrators.set(id, { narratorId: id, alive: true, _loopRunning: true } as ActiveNarrator);
	activeIds.add(id);
}

function seedReply(narratorId: string, id: string) {
	const messageId = `answer-${id}`;
	const text = `Complete user receipt ${id}: original context and selected option.`;
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "user",
			origin: "user",
			contentText: text,
			contentJson: [{ type: "text", text }],
			createdAt: time,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId, messageId, seq: ++nextSeq })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `call-${id}`,
			narratorId,
			messageId: `ask-${narratorId}`,
			toolUseId: `tool-${id}`,
			toolName: "AskUserQuestion",
			status: "success",
			inputJson: { async: true },
			createdAt: time,
		})
		.run();
	db.insert(narratorQuestions)
		.values({
			id,
			narratorId,
			toolCallId: `call-${id}`,
			toolUseId: `tool-${id}`,
			questionsJson: [{ id: "choice", header: "Choose", options: [{ header: "A" }] }],
			context: "Investigating while waiting for the sampling choice.",
			executionPrincipalJson: { version: 1, userId: null },
			status: "answered",
			answersJson: { choice: "A" },
			answerMessageId: messageId,
			createdAt: time,
		})
		.run();
}

beforeEach(() => {
	cleanDb(sqlite);
	nextSeq = 0;
});
afterEach(() => {
	for (const id of activeIds) activeNarrators.delete(id);
	activeIds.clear();
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
	sqlite.close();
});

describe("pending question startup recovery", () => {
	test("continues beyond the first 128 recipients and the first 32 answers per recipient", async () => {
		for (let index = 0; index < 130; index++) {
			db.insert(narrators)
				.values({
					id: `a-old-${String(index).padStart(3, "0")}`,
					status: "idle",
					createdAt: time,
					updatedAt: time,
				})
				.run();
		}
		seedRecipient("zz-late-recipient");
		for (let index = 0; index < 35; index++) seedReply("zz-late-recipient", `late-${index}`);
		expect(await recoverPendingQuestionAnswerDeliveries()).toBe(35);
		const rows = db.select().from(narratorBufferedMessages).all();
		expect(rows).toHaveLength(35);
		expect(rows.map((row) => row.recipientMessageId)).toContain("answer-late-34");
		expect(rows.every((row) => row.narratorId === "zz-late-recipient")).toBe(true);
		await recoverPendingQuestionAnswerDeliveries();
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(35);
	});

	test("preserves user-stopped and failed sessions while recovering normal idle sessions", async () => {
		seedRecipient("normal");
		seedRecipient("stopped", "user_interrupt");
		seedRecipient("failed", "error");
		for (const id of ["normal", "stopped", "failed"]) seedReply(id, `${id}-reply`);
		expect(await recoverPendingQuestionAnswerDeliveries()).toBe(1);
		expect(
			db
				.select()
				.from(narratorBufferedMessages)
				.all()
				.map((row) => row.narratorId),
		).toEqual(["normal"]);
	});

	test("background traversal accepts cancellation", async () => {
		seedRecipient("normal");
		seedReply("normal", "reply");
		const controller = new AbortController();
		controller.abort(new Error("recovery cancelled"));
		await expect(
			recoverPendingQuestionAnswerDeliveries("en", { signal: controller.signal }),
		).rejects.toThrow("recovery cancelled");
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(0);
	});
});
