import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/schema";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	runtimeAwaitedTerminalConsumptions,
	runtimePublicationOutbox,
} from "../../db/schema";
import { MAILBOX_LIMITS as L } from "./limits";
import type { RuntimeStoreDb } from "./mailbox-types";
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
	publicationDedupeKey,
} from "./publication-result";

export interface PublicationTerminalResultReadParams {
	kind: "publication-terminal-result-v1";
	run: PublicationRun;
	options?: AgentTerminalResultReadOptions;
}

export function runPublicationTerminalResultRead(
	sqlite: Database,
	params: PublicationTerminalResultReadParams,
	signal?: AbortSignal,
): AgentTerminalResult | null {
	signal?.throwIfAborted();
	const database = drizzle(sqlite, { schema });
	return database.transaction((tx) => {
		const result = readAgentTerminalResultSnapshot(tx, params.run, params.options);
		signal?.throwIfAborted();
		return result;
	});
}

function readAssistantSource(
	database: Pick<RuntimeStoreDb, "select">,
	run: PublicationRun,
	messageId: string,
): AgentTerminalResult | null {
	const projection = database
		.select({
			plain: sql<
				string | null
			>`CASE WHEN ${narratorMessages.originalContentJson} IS NULL THEN substr(${narratorMessages.contentText}, 1, ${AGENT_RESULT_OUTPUT_CHARS + 1}) ELSE NULL END`,
			json: sql<
				string | null
			>`CASE WHEN length(CAST(COALESCE(${narratorMessages.originalContentJson}, ${narratorMessages.contentJson}) AS BLOB)) <= ${AGENT_RESULT_JSON_MAX_BYTES} THEN COALESCE(${narratorMessages.originalContentJson}, ${narratorMessages.contentJson}) ELSE NULL END`,
		})
		.from(narratorMessages)
		.where(
			and(
				eq(narratorMessages.id, messageId),
				eq(narratorMessages.narratorId, run.taskId),
				eq(narratorMessages.role, "assistant"),
			),
		)
		.limit(1)
		.get();
	const result = projection
		? decodeRunAssistantProjection(projection.plain, projection.json)
		: null;
	const sourceResultRef = agentSourceResultRef(`message:${messageId}`);
	return result ? { ...result, ...(sourceResultRef ? { sourceResultRef } : {}) } : null;
}

export function readAgentTerminalResultSnapshot(
	database: Pick<RuntimeStoreDb, "select">,
	run: PublicationRun,
	options: AgentTerminalResultReadOptions = {},
): AgentTerminalResult | null {
	if (run.producerKind !== "agent") return null;
	const keys = (["completed", "failed", "timed_out", "cancelled"] as const).map((event) =>
		publicationDedupeKey(run, event),
	);
	const intent = database
		.select({
			eventKind: runtimePublicationOutbox.eventKind,
			state: runtimePublicationOutbox.state,
			resultRef: runtimePublicationOutbox.resultRef,
		})
		.from(runtimePublicationOutbox)
		.where(
			and(
				eq(runtimePublicationOutbox.producerKind, "agent"),
				eq(runtimePublicationOutbox.taskId, run.taskId),
				eq(runtimePublicationOutbox.logicalRunId, run.logicalRunId),
				eq(runtimePublicationOutbox.recipientId, run.recipientId),
				ne(runtimePublicationOutbox.eventKind, "started"),
			),
		)
		.limit(1)
		.get();
	const terminalIntent = !!intent && intent.state !== "reserved" && intent.eventKind !== "terminal";
	const terminalDelivery = database
		.select({ id: narratorBufferedMessages.id })
		.from(narratorBufferedMessages)
		.where(
			and(
				eq(narratorBufferedMessages.narratorId, run.recipientId),
				eq(narratorBufferedMessages.kind, "task_notice"),
				eq(narratorBufferedMessages.noticeKind, "agent"),
				inArray(narratorBufferedMessages.dedupeKey, keys),
			),
		)
		.limit(1)
		.get();
	const consumedReceipt = database
		.select({
			taskId: runtimeAwaitedTerminalConsumptions.taskId,
			sourceResultRef: runtimeAwaitedTerminalConsumptions.sourceResultRef,
		})
		.from(runtimeAwaitedTerminalConsumptions)
		.where(
			and(
				eq(runtimeAwaitedTerminalConsumptions.producerKind, "agent"),
				eq(runtimeAwaitedTerminalConsumptions.taskId, run.taskId),
				eq(runtimeAwaitedTerminalConsumptions.logicalRunId, run.logicalRunId),
				eq(runtimeAwaitedTerminalConsumptions.recipientId, run.recipientId),
			),
		)
		.limit(1)
		.get();
	if (terminalIntent || terminalDelivery || consumedReceipt) {
		// JSON remains text in SQL: CASE prevents an edited/corrupt huge row from reaching JS.
		const receipt = database
			.select({
				json: sql<
					string | null
				>`CASE WHEN length(CAST(COALESCE(${narratorMessages.originalContentJson}, ${narratorMessages.contentJson}) AS BLOB)) <= ${AGENT_RESULT_JSON_MAX_BYTES} THEN COALESCE(${narratorMessages.originalContentJson}, ${narratorMessages.contentJson}) ELSE NULL END`,
			})
			.from(narratorMessages)
			.where(
				and(
					eq(narratorMessages.id, `publication-result:${run.logicalRunId}`),
					eq(narratorMessages.narratorId, run.taskId),
					eq(narratorMessages.role, "disp"),
				),
			)
			.limit(1)
			.get();
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
		const exactSource = agentSourceResultRef(consumedReceipt?.sourceResultRef);
		return exactSource ? readAssistantSource(database, run, exactSource.slice(8)) : null;
	}
	// Only the live waiter's same-run transition observation can authorize deferred output.
	// Ordinary idle lookup, a mismatched observation, or an old actor id must not do so.
	if (
		options.settledRunId !== run.logicalRunId ||
		intent?.state !== "reserved" ||
		intent.eventKind !== "terminal" ||
		!intent.resultRef?.startsWith("source_after:")
	)
		return null;
	const boundary = parseRunSourceBoundary(intent.resultRef);
	if (boundary === null) return null;
	const settledActor = () => {
		const actor = database
			.select({
				logicalRunId: narrators.logicalRunId,
				status: narrators.status,
				parentNarratorId: narrators.parentNarratorId,
			})
			.from(narrators)
			.where(eq(narrators.id, run.taskId))
			.get();
		return (
			actor?.logicalRunId === run.logicalRunId &&
			actor.status === "idle" &&
			actor.parentNarratorId === run.recipientId
		);
	};
	if (!settledActor()) return null;
	const candidates = database
		.select({
			id: narratorMessages.id,
			role: narratorMessages.role,
			narratorId: narratorMessages.narratorId,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(eq(narratorMessageRefs.narratorId, run.taskId), gt(narratorMessageRefs.seq, boundary)),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(L.pageSize)
		.all();
	const assistant = candidates.find(
		(row) => row.role === "assistant" && row.narratorId === run.taskId,
	);
	if (!assistant) return null;
	const result = readAssistantSource(database, run, assistant.id);
	return settledActor() ? result : null;
}
