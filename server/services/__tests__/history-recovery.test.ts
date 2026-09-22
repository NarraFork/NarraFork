import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqlite } from "../../db";
import { generateId } from "../../lib/id";
import { narratorService } from "../narrator-service";

const NARRATOR_ID = "history-recovery-n";
const createdIds: string[] = [];

beforeEach(() => {
	const now = new Date().toISOString();
	sqlite
		.query(
			`INSERT INTO narrators (id, type, variant, created_at, updated_at) VALUES (?, 'primary', 'primary', ?, ?)`,
		)
		.run(NARRATOR_ID, now, now);
	createdIds.push(NARRATOR_ID);
});

afterEach(() => {
	for (const id of createdIds.splice(0)) {
		sqlite.query(`DELETE FROM narrator_tool_calls WHERE narrator_id = ?`).run(id);
		sqlite.query(`DELETE FROM narrator_message_refs WHERE narrator_id = ?`).run(id);
		sqlite.query(`DELETE FROM narrator_messages WHERE narrator_id = ?`).run(id);
		sqlite.query(`DELETE FROM narrators WHERE id = ?`).run(id);
	}
});

function insertMessage(opts: {
	seq: number;
	role: string;
	contentJson: string;
	contentText?: string;
	toolCount?: number;
}) {
	const messageId = generateId();
	const now = new Date().toISOString();
	sqlite
		.query(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(messageId, NARRATOR_ID, opts.role, opts.contentJson, opts.contentText ?? null, now);
	sqlite
		.query(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)`,
		)
		.run(generateId(), NARRATOR_ID, messageId, opts.seq);
	for (let i = 0; i < (opts.toolCount ?? 0); i++) {
		sqlite
			.query(
				`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, is_file_history_checkpoint, created_at)
				 VALUES (?, ?, ?, ?, 'Bash', 'success', 0, ?)`,
			)
			.run(generateId(), NARRATOR_ID, messageId, `tu-${opts.seq}-${i}`, now);
	}
	return messageId;
}

describe("history-recovery scan", () => {
	test("lists oversized messages without reading content bodies", async () => {
		const normal = insertMessage({
			seq: 1,
			role: "user",
			contentJson: JSON.stringify([{ type: "text", text: "hello" }]),
			contentText: "hello",
			toolCount: 1,
		});
		const oversized = insertMessage({
			seq: 2,
			role: "assistant",
			contentJson: JSON.stringify([{ type: "text", text: "x".repeat(64) }]),
			contentText: "x".repeat(64),
			toolCount: 40,
		});
		const result = await narratorService.getHistoryRecovery(NARRATOR_ID);
		expect(result.candidates.map((c) => c.messageId)).toEqual([oversized]);
		expect(result.candidates[0]?.toolCount).toBe(40);
		expect(result.candidates[0]?.latest).toBe(true);
		expect(result.candidates.some((c) => c.messageId === normal)).toBe(false);
		expect(result.thresholds.toolCount).toBe(32);
	});

	test("flags a single huge content_json even with few tool calls", async () => {
		const huge = insertMessage({
			seq: 3,
			role: "assistant",
			contentJson: "[]",
			contentText: "x",
			toolCount: 0,
		});
		sqlite
			.query(`UPDATE narrator_messages SET content_json = ? WHERE id = ?`)
			.run(JSON.stringify([{ type: "text", text: "y".repeat(1_500_000) }]), huge);
		const result = await narratorService.getHistoryRecovery(NARRATOR_ID);
		expect(result.candidates.map((c) => c.messageId)).toEqual([huge]);
		expect(result.candidates[0]?.byteSize).toBeGreaterThan(1024 * 1024);
	});

	test("marks only the highest-seq candidate as latest", async () => {
		const first = insertMessage({ seq: 1, role: "assistant", contentJson: "[]", toolCount: 35 });
		const second = insertMessage({ seq: 2, role: "assistant", contentJson: "[]", toolCount: 50 });
		const result = await narratorService.getHistoryRecovery(NARRATOR_ID);
		expect(result.candidates.map((c) => c.messageId)).toEqual([second, first]);
		expect(result.candidates[0]?.latest).toBe(true);
		expect(result.candidates[1]?.latest).toBe(false);
	});

	test("deleting the oversized message restores timeline access", async () => {
		insertMessage({
			seq: 1,
			role: "user",
			contentJson: JSON.stringify([{ type: "text", text: "hi" }]),
		});
		// 501 tool_call rows is what trips assertAggregateBudget (500 metadata limit):
		// collectToolUseIds walks msg.toolCalls (the relation), not content_json alone.
		const oversized = insertMessage({
			seq: 2,
			role: "assistant",
			contentJson: JSON.stringify([{ type: "text", text: "boom" }]),
			toolCount: 501,
		});
		await expect(
			narratorService.getPretextDocumentPage(NARRATOR_ID, { limit: 10 }),
		).rejects.toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
		await narratorService.deleteMessage(NARRATOR_ID, oversized, { skipRevert: true });
		const page = await narratorService.getPretextDocumentPage(NARRATOR_ID, { limit: 10 });
		expect(page.messages.length).toBeGreaterThan(0);
		const after = await narratorService.getHistoryRecovery(NARRATOR_ID);
		expect(after.candidates).toEqual([]);
	});
});
