import type { Database } from "bun:sqlite";
import { boundedBodyText, hasRowsOnlyBodies } from "../../lib/narrator-bodies";
import { MAILBOX_LIMITS as L } from "./limits";
import { publicationDedupeKey } from "./publication-key";
import type { PublicationRun } from "./publication-outbox";
import {
	AGENT_RESULT_JSON_MAX_BYTES,
	AGENT_RESULT_OUTPUT_CHARS,
	type AgentTerminalResult,
	type AgentTerminalResultReadOptions,
	agentSourceResultRef,
	decodeAgentTerminalSnapshot,
	decodeRunAssistantProjection,
	parseRunSourceBoundary,
} from "./publication-result";

export function readPublicationTerminalSnapshot(
	sqlite: Database,
	run: PublicationRun,
	options: AgentTerminalResultReadOptions,
	fromBlocks: boolean,
	signal: AbortSignal,
): AgentTerminalResult | null {
	return sqlite.transaction(() =>
		readPublicationTerminalResult(
			sqlite,
			run,
			options,
			fromBlocks || hasRowsOnlyBodies(sqlite),
			signal,
		),
	)();
}

/** Read the bounded result for this exact run, never the actor's latest result. */
export function readPublicationTerminalResult(
	sqlite: Database,
	run: PublicationRun,
	options: AgentTerminalResultReadOptions,
	fromBlocks: boolean,
	signal?: AbortSignal,
): AgentTerminalResult | null {
	signal?.throwIfAborted();
	if (run.producerKind !== "agent") return null;

	function one<T, P extends import("bun:sqlite").SQLQueryBindings[]>(
		sql: string,
		...params: P
	): T | null {
		const statement = sqlite.query<T, import("bun:sqlite").SQLQueryBindings[]>(sql);
		try {
			return statement.get(...params);
		} finally {
			statement.finalize();
		}
	}
	function many<T, P extends import("bun:sqlite").SQLQueryBindings[]>(
		sql: string,
		...params: P
	): T[] {
		const statement = sqlite.query<T, import("bun:sqlite").SQLQueryBindings[]>(sql);
		try {
			return statement.all(...params);
		} finally {
			statement.finalize();
		}
	}

	function projection(messageId: string, role: string) {
		const row = one<
			{
				plain: string | null;
				original: string | null;
				hasOriginal: number;
			},
			[number, number, string, string, string]
		>(
			`SELECT CASE WHEN original_content_json IS NULL THEN substr(content_text,1,?) ELSE NULL END AS plain,
			 original_content_json IS NOT NULL AS hasOriginal,
			 CASE WHEN octet_length(original_content_json) <= ? THEN original_content_json ELSE NULL END AS original
			 FROM narrator_messages WHERE id = ? AND narrator_id = ? AND role = ? LIMIT 1`,
			AGENT_RESULT_OUTPUT_CHARS + 1,
			AGENT_RESULT_JSON_MAX_BYTES,
			messageId,
			run.taskId,
			role,
		);
		if (!row) return null;
		return {
			plain: row.plain,
			json: row.hasOriginal
				? row.original
				: (boundedBodyText(sqlite, messageId, fromBlocks, {
						maxBytes: AGENT_RESULT_JSON_MAX_BYTES,
					}) ?? null),
		};
	}
	function assistantSource(messageId: string): AgentTerminalResult | null {
		signal?.throwIfAborted();
		const source = projection(messageId, "assistant");
		const result = source ? decodeRunAssistantProjection(source.plain, source.json) : null;
		const sourceResultRef = agentSourceResultRef(`message:${messageId}`);
		return result ? { ...result, ...(sourceResultRef ? { sourceResultRef } : {}) } : null;
	}
	const intent = one<
		{
			eventKind: string;
			state: string;
			resultRef: string | null;
		},
		[string, string, string]
	>(
		`SELECT event_kind AS eventKind, state, result_ref AS resultRef FROM runtime_publication_outbox
		 WHERE producer_kind = 'agent' AND task_id = ? AND logical_run_id = ?
		 AND recipient_id = ? AND event_kind <> 'started' LIMIT 1`,
		run.taskId,
		run.logicalRunId,
		run.recipientId,
	);
	const terminalIntent = !!intent && intent.state !== "reserved" && intent.eventKind !== "terminal";
	const keys = (["completed", "failed", "timed_out", "cancelled"] as const).map((event) =>
		publicationDedupeKey(run, event),
	);
	const delivery = one<{ id: string }, string[]>(
		`SELECT id FROM narrator_buffered_messages WHERE narrator_id = ? AND kind = 'task_notice'
		 AND notice_kind = 'agent' AND dedupe_key IN (${keys.map(() => "?").join(",")}) LIMIT 1`,
		run.recipientId,
		...keys,
	);
	const consumed = one<{ sourceResultRef: string | null }, [string, string, string]>(
		`SELECT source_result_ref AS sourceResultRef FROM runtime_awaited_terminal_consumptions
		 WHERE producer_kind = 'agent' AND task_id = ? AND logical_run_id = ? AND recipient_id = ? LIMIT 1`,
		run.taskId,
		run.logicalRunId,
		run.recipientId,
	);
	if (terminalIntent || delivery || consumed) {
		const receipt = projection(`publication-result:${run.logicalRunId}`, "disp");
		const result = decodeAgentTerminalSnapshot(
			receipt?.json ?? null,
			run.logicalRunId,
			options.includeEventKind,
		);
		if (result)
			return options.includeEventKind && terminalIntent
				? {
						...result,
						eventKind: intent.eventKind as NonNullable<AgentTerminalResult["eventKind"]>,
					}
				: result;
		const source = agentSourceResultRef(consumed?.sourceResultRef);
		return source ? assistantSource(source.slice(8)) : null;
	}
	if (
		options.settledRunId !== run.logicalRunId ||
		intent?.state !== "reserved" ||
		intent.eventKind !== "terminal" ||
		!intent.resultRef?.startsWith("source_after:")
	)
		return null;
	const boundary = parseRunSourceBoundary(intent.resultRef);
	if (boundary === null) return null;
	function settledActor() {
		const actor = one<
			{
				logicalRunId: string | null;
				status: string;
				parentNarratorId: string | null;
			},
			[string]
		>(
			`SELECT logical_run_id AS logicalRunId, status, parent_narrator_id AS parentNarratorId
			FROM narrators WHERE id = ? LIMIT 1`,
			run.taskId,
		);
		return (
			actor?.logicalRunId === run.logicalRunId &&
			actor.status === "idle" &&
			actor.parentNarratorId === run.recipientId
		);
	}
	if (!settledActor()) return null;
	const candidates = many<
		{ id: string; role: string; narratorId: string },
		[string, number, number]
	>(
		`SELECT m.id, m.role, m.narrator_id AS narratorId FROM narrator_message_refs r
		 INNER JOIN narrator_messages m ON m.id = r.message_id
		 WHERE r.narrator_id = ? AND r.seq > ? ORDER BY r.seq DESC LIMIT ?`,
		run.taskId,
		boundary,
		L.pageSize,
	);
	const assistant = candidates.find(
		(row) => row.role === "assistant" && row.narratorId === run.taskId,
	);
	if (!assistant) return null;
	const result = assistantSource(assistant.id);
	signal?.throwIfAborted();
	return settledActor() ? result : null;
}

export function readPublicationTerminalResultTask(
	sqlite: Database,
	input: { run: PublicationRun; options?: AgentTerminalResultReadOptions; fromBlocks: boolean },
	signal: AbortSignal,
): AgentTerminalResult | null {
	return readPublicationTerminalSnapshot(
		sqlite,
		input.run,
		input.options ?? {},
		input.fromBlocks,
		signal,
	);
}
