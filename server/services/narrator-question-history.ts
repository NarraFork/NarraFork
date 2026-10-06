import type { SQLQueryBindings } from "bun:sqlite";
import { sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { AppError } from "../lib/errors";

export const QUESTION_HISTORY_LIMIT = 2048;
export const QUESTION_HISTORY_BYTES = 4 * 1024 * 1024;
export const QUESTION_HISTORY_WITHDRAW_REASON = "Question creation was removed from history.";
export type QuestionHistoryStatement = { text: string; values: SQLQueryBindings[] };
export type QuestionHistoryRow = {
	id: string;
	narrator_id: string;
	tool_call_id: string;
	answer_message_id: string | null;
	status: string;
};
export type QuestionHistoryEvent = {
	question_id: string;
	message_id: string;
	kind: string;
	created_at: string;
	resolution_json: string | null;
	/** SQLite insertion order disambiguates events persisted in the same millisecond. */
	cursor?: number;
};
export type QuestionHistoryInboxRow = {
	id: string;
	narrator_id: string;
	recipient_message_id: string;
};
export function buildQuestionHistoryInboxProgram(
	rows: QuestionHistoryInboxRow[],
): QuestionHistoryStatement[] {
	return rows.map((row) => ({
		text: "UPDATE narrator_buffered_messages SET state='cancelled',receipt_disposition='recipient_deleted',claim_token=NULL,claim_epoch=NULL,claimed_at=NULL WHERE id=? AND narrator_id=? AND recipient_message_id=?",
		values: [row.id, row.narrator_id, row.recipient_message_id],
	}));
}
export type QuestionHistoryResult = {
	affectedQuestionIds: string[];
	withdrawnQuestionIds: string[];
};

/** Pure, fixed row program. Never executes SQL or expands its supplied read/write set. */
export function buildQuestionHistoryProgram(
	question: QuestionHistoryRow,
	events: QuestionHistoryEvent[],
	deletedMessageIds: ReadonlySet<string>,
	requestRemoved: boolean,
	questionDeleted = false,
): { statements: QuestionHistoryStatement[]; withdrawn: boolean } {
	const statements: QuestionHistoryStatement[] = [];
	const removed = events.filter(
		(event) => questionDeleted || deletedMessageIds.has(event.message_id),
	);
	for (const event of removed) {
		statements.push({
			text: "DELETE FROM narrator_question_events WHERE question_id=? AND message_id=?",
			values: [question.id, event.message_id],
		});
	}
	if (questionDeleted) return { statements, withdrawn: true };
	if (requestRemoved) {
		statements.push({
			text: "UPDATE narrator_questions SET status='withdrawn',answer_message_id=NULL,resolution_json=NULL,answers_json=NULL,annotations_json=NULL,decided_by=NULL,decided_at=NULL,withdraw_reason=? WHERE id=? AND narrator_id=?",
			values: [QUESTION_HISTORY_WITHDRAW_REASON, question.id, question.narrator_id],
		});
		return { statements, withdrawn: true };
	}
	if (question.answer_message_id && deletedMessageIds.has(question.answer_message_id)) {
		const latest = events
			.filter((event) => !deletedMessageIds.has(event.message_id))
			.sort(
				(a, b) =>
					(b.cursor ?? 0) - (a.cursor ?? 0) ||
					b.created_at.localeCompare(a.created_at) ||
					b.message_id.localeCompare(a.message_id),
			)[0];
		statements.push(
			latest
				? {
						text: "UPDATE narrator_questions SET status=?,answer_message_id=?,resolution_json=?,withdraw_reason=NULL WHERE id=? AND narrator_id=?",
						values: [
							latest.kind === "dismissal" ? "dismissed" : "answered",
							latest.message_id,
							latest.resolution_json,
							question.id,
							question.narrator_id,
						],
					}
				: {
						text: "UPDATE narrator_questions SET status='open',answer_message_id=NULL,resolution_json=NULL,answers_json=NULL,annotations_json=NULL,decided_by=NULL,decided_at=NULL,withdraw_reason=NULL WHERE id=? AND narrator_id=?",
						values: [question.id, question.narrator_id],
					},
		);
	}
	return { statements, withdrawn: false };
}

export const QUESTION_HISTORY_COLUMNS =
	"q.id,q.narrator_id,q.tool_call_id,q.answer_message_id,q.status";
export function questionHistorySql(statement: QuestionHistoryStatement) {
	const chunks = statement.text.split("?");
	return sql.join(
		chunks.flatMap((chunk, index) =>
			index < statement.values.length
				? [sql.raw(chunk), sql`${statement.values[index]}`]
				: [sql.raw(chunk)],
		),
		sql.raw(""),
	);
}

/** Call before deleting refs/tools; only the original execution owner's questions mutate. */
export function reconcileQuestionHistoryInTransaction(
	tx: Pick<BunSQLiteDatabase, "all" | "run">,
	narratorId: string,
	input: {
		deletedMessageIds: string[];
		deletedToolBlocks?: { messageId: string; toolUseId: string }[];
	},
): QuestionHistoryResult {
	if (
		input.deletedMessageIds.length + (input.deletedToolBlocks?.length ?? 0) >
		QUESTION_HISTORY_LIMIT
	)
		throw new AppError("Question history mutation exceeds its bounded target set", 409);
	const deleted = new Set(input.deletedMessageIds);
	const questions = new Map<string, QuestionHistoryRow>();
	const requests = new Set<string>();
	const read = <T>(text: string, values: SQLQueryBindings[]) =>
		tx.all<T>(questionHistorySql({ text, values }));
	const add = (rows: QuestionHistoryRow[], request: boolean) => {
		for (const row of rows) {
			questions.set(row.id, row);
			if (request) requests.add(row.id);
		}
		if (questions.size > QUESTION_HISTORY_LIMIT)
			throw new AppError("Too many question history rows", 409);
	};
	for (const messageId of deleted) {
		add(
			read(
				`SELECT ${QUESTION_HISTORY_COLUMNS} FROM narrator_tool_calls t INDEXED BY idx_toolcalls_message CROSS JOIN narrator_questions q INDEXED BY idx_narrator_questions_tool_call ON q.tool_call_id=t.id WHERE q.narrator_id=? AND t.message_id=? LIMIT ?`,
				[narratorId, messageId, QUESTION_HISTORY_LIMIT + 1],
			),
			true,
		);
		add(
			read(
				`SELECT ${QUESTION_HISTORY_COLUMNS} FROM narrator_question_events e CROSS JOIN narrator_questions q ON q.id=e.question_id WHERE q.narrator_id=? AND e.message_id=? LIMIT 1`,
				[narratorId, messageId],
			),
			false,
		);
		add(
			read(
				`SELECT ${QUESTION_HISTORY_COLUMNS} FROM narrator_questions q INDEXED BY idx_narrator_questions_answer_message WHERE q.narrator_id=? AND q.answer_message_id=? LIMIT ?`,
				[narratorId, messageId, QUESTION_HISTORY_LIMIT + 1],
			),
			false,
		);
	}
	for (const block of input.deletedToolBlocks ?? []) {
		add(
			read(
				`SELECT ${QUESTION_HISTORY_COLUMNS} FROM narrator_tool_calls t INDEXED BY idx_toolcalls_message CROSS JOIN narrator_questions q INDEXED BY idx_narrator_questions_tool_call ON q.tool_call_id=t.id WHERE q.narrator_id=? AND t.message_id=? AND t.tool_use_id=? LIMIT ?`,
				[narratorId, block.messageId, block.toolUseId, QUESTION_HISTORY_LIMIT + 1],
			),
			true,
		);
	}
	const result: QuestionHistoryResult = { affectedQuestionIds: [], withdrawnQuestionIds: [] };
	let eventCount = 0;
	let bytes = 0;
	const inboxRows = new Map<string, QuestionHistoryInboxRow>();
	for (const question of questions.values()) {
		const sizes = read<{ bytes: number }>(
			"SELECT coalesce(octet_length(resolution_json),0) AS bytes FROM narrator_question_events WHERE question_id=? LIMIT ?",
			[question.id, QUESTION_HISTORY_LIMIT + 1],
		);
		eventCount += sizes.length;
		bytes += sizes.reduce((sum, row) => sum + row.bytes, 0);
		if (eventCount > QUESTION_HISTORY_LIMIT || bytes > QUESTION_HISTORY_BYTES)
			throw new AppError("Question history event budget exceeded", 409);
		const events = read<QuestionHistoryEvent>(
			"SELECT question_id,message_id,kind,created_at,resolution_json,rowid AS cursor FROM narrator_question_events WHERE question_id=? LIMIT ?",
			[question.id, QUESTION_HISTORY_LIMIT + 1],
		);
		for (const eventId of new Set([
			...events
				.filter((event) => requests.has(question.id) || deleted.has(event.message_id))
				.map((event) => event.message_id),
			...(question.answer_message_id &&
			(requests.has(question.id) || deleted.has(question.answer_message_id))
				? [question.answer_message_id]
				: []),
		])) {
			for (const row of read<QuestionHistoryInboxRow>(
				"SELECT id,narrator_id,recipient_message_id FROM narrator_buffered_messages INDEXED BY idx_nbm_reserved WHERE narrator_id=? AND recipient_message_id=? AND kind='task_notice' AND source_key=? LIMIT ?",
				[narratorId, eventId, `question-answer:${eventId}`, QUESTION_HISTORY_LIMIT + 1],
			))
				inboxRows.set(row.id, row);
			if (inboxRows.size > QUESTION_HISTORY_LIMIT)
				throw new AppError("Question inbox history budget exceeded", 409);
		}
		const plan = buildQuestionHistoryProgram(question, events, deleted, requests.has(question.id));
		for (const statement of plan.statements) tx.run(questionHistorySql(statement));
		if (plan.statements.length) result.affectedQuestionIds.push(question.id);
		if (plan.withdrawn) result.withdrawnQuestionIds.push(question.id);
	}
	for (const statement of buildQuestionHistoryInboxProgram([...inboxRows.values()]))
		tx.run(questionHistorySql(statement));
	return result;
}
