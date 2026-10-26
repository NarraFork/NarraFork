/**
 * ForkNarrator runs as soon as its input is complete — possibly while the response that
 * calls it is still streaming. That response's row is shared by full forks and appended
 * in place, so a child that inherited it would see a step that keeps changing under it.
 * The tool therefore forks at the step before the calling response.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narratorToolCalls } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { narratorService } = await import("../narrator-service");

const now = "2026-10-23T10:00:00.000Z";

function seedNarrator(id: string) {
	sqlite
		.prepare(
			`INSERT INTO narrators (id, traits, created_at, updated_at) VALUES (?, '["standalone"]', ?, ?)`,
		)
		.run(id, now, now);
}

async function seedMessage(
	id: string,
	narratorId: string,
	seq: number,
	role: "user" | "assistant",
) {
	await db.insert(narratorMessages).values({
		id,
		narratorId,
		role,
		contentJson: [{ type: "text", text: id }],
		contentText: id,
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${narratorId}-${id}`,
		narratorId,
		messageId: id,
		seq,
		isCompact: 0,
	});
}

/**
 * seq 0 user input, seq 1 an earlier step, seq 2 its tool results, seq 3 the response
 * that is calling ForkNarrator (still open).
 */
async function seedParent(parentId = "parent") {
	seedNarrator(parentId);
	await seedMessage(`${parentId}-input`, parentId, 0, "user");
	await seedMessage(`${parentId}-step-1`, parentId, 1, "assistant");
	await seedMessage(`${parentId}-results-1`, parentId, 2, "user");
	await seedMessage(`${parentId}-calling-step`, parentId, 3, "assistant");
	await db.insert(narratorToolCalls).values({
		id: `${parentId}-fork-call`,
		narratorId: parentId,
		messageId: `${parentId}-calling-step`,
		toolUseId: "tu-fork",
		toolName: "ForkNarrator",
		createdAt: now,
	});
	return { callingToolCallId: `${parentId}-fork-call` };
}

async function inheritedMessageIds(narratorId: string) {
	const refs = await db
		.select({ messageId: narratorMessageRefs.messageId })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(narratorMessageRefs.seq);
	return refs.map((ref) => ref.messageId);
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("ForkNarrator fork point", () => {
	test("the child inherits history up to, not including, the calling response", async () => {
		const { callingToolCallId } = await seedParent();

		const child = await narratorService.forkStandaloneFromTool("parent", "fork", {
			inheritMode: "full",
			callingToolCallId,
		});

		expect(await inheritedMessageIds(child.id)).toEqual([
			"parent-input",
			"parent-step-1",
			"parent-results-1",
		]);
	});

	test("the fork point does not depend on how far the calling response has streamed", async () => {
		const { callingToolCallId } = await seedParent();
		// A later write to the parent after the call (e.g. the calling response's results).
		await seedMessage("parent-after", "parent", 4, "user");

		const child = await narratorService.forkStandaloneFromTool("parent", "fork", {
			inheritMode: "full",
			callingToolCallId,
		});

		expect(await inheritedMessageIds(child.id)).toEqual([
			"parent-input",
			"parent-step-1",
			"parent-results-1",
		]);
	});

	test("an unknown calling row falls back to the latest message", async () => {
		await seedParent();

		expect(
			await narratorService.getMessageIdBeforeToolCallStep("parent", "missing-call"),
		).toBeUndefined();
		const child = await narratorService.forkStandaloneFromTool("parent", "fork", {
			inheritMode: "full",
			callingToolCallId: "missing-call",
		});

		expect((await inheritedMessageIds(child.id)).at(-1)).toBe("parent-calling-step");
	});
});
