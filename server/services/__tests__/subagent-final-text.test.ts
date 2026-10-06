import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { getSubagentFinalText, getSubagentResultMessageId } = await import("../narrator-session");

const now = "2026-07-22T10:00:00.000Z";

function seedNarrator(id = "sub1") {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, type, variant, created_at, updated_at) VALUES (?, 'subagent', 'subagent:general', ?, ?)",
		)
		.run(id, now, now);
}

async function seedMessage(params: {
	id: string;
	narratorId: string;
	seq: number;
	role: "user" | "assistant" | "system";
	contentText?: string;
	contentJson?: unknown;
	isCompact?: boolean;
}) {
	await db.insert(narratorMessages).values({
		id: params.id,
		narratorId: params.narratorId,
		role: params.role,
		contentJson: params.contentJson ?? [{ type: "text", text: params.contentText ?? "" }],
		contentText: params.contentText ?? null,
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${params.id}`,
		narratorId: params.narratorId,
		messageId: params.id,
		seq: params.seq,
		isCompact: params.isCompact ? 1 : 0,
	});
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("getSubagentFinalText across a tail compact marker", () => {
	test("returns the pre-compact assistant text instead of (no output)", async () => {
		seedNarrator();
		await seedMessage({
			id: "m-answer",
			narratorId: "sub1",
			seq: 1,
			role: "assistant",
			contentText: "the actual subagent conclusion",
		});
		await seedMessage({
			id: "m-compact",
			narratorId: "sub1",
			seq: 2,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "a compact summary" }],
			isCompact: true,
		});

		expect(await getSubagentFinalText("sub1")).toBe("the actual subagent conclusion");
		expect(await getSubagentResultMessageId("sub1")).toBe("m-answer");
	});

	test("falls back to the compact summary when there is no assistant text", async () => {
		seedNarrator();
		await seedMessage({
			id: "m-user",
			narratorId: "sub1",
			seq: 1,
			role: "user",
			contentText: "please investigate",
		});
		await seedMessage({
			id: "m-compact",
			narratorId: "sub1",
			seq: 2,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "summary of the work done" }],
			isCompact: true,
		});

		expect(await getSubagentFinalText("sub1")).toBe("summary of the work done");
		// Result message id binds to the compact marker so the tool result stays navigable.
		expect(await getSubagentResultMessageId("sub1")).toBe("m-compact");
	});

	test("returns (no output) only when nothing usable exists", async () => {
		seedNarrator();
		await seedMessage({
			id: "m-user",
			narratorId: "sub1",
			seq: 1,
			role: "user",
			contentText: "just a prompt",
		});

		expect(await getSubagentFinalText("sub1")).toBe("(no output)");
		expect(await getSubagentResultMessageId("sub1")).toBeUndefined();
	});
});
