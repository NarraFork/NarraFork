import { readDbAll, readDomainTask, readQueryFirst } from "@server/db/worker-read";
import { and, desc, eq, gt, inArray, isNull, like, ne, notExists, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { resolveDatabaseBackendConfig } from "../../db/postgres-runtime";
import {
	backgroundTasks,
	deviceTransferTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
	runtimeAwaitedTerminalConsumptions,
	runtimePublicationOutbox,
} from "../../db/schema";
import { readQuery } from "../../db/worker-read";
import { runReadTask, WorkersUnavailableError } from "../../lib/db-worker/pool";
import { ValidationError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { hotSafe } from "../../lib/hot-safe";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { parseSubstatus, parseTraits } from "../../lib/narrator-utils";
import { settings } from "../../lib/settings";
import {
	type RunBindingInput,
	type RuntimeRunBinding,
	readRuntimeRegistrationColumn,
	registerRun,
} from "../../lib/validators/runtime-registration";
import { backgroundOccupancyStore } from "../background-occupancy-store";
import { TERMINAL_WATCH_COMMAND_PREFIX, WATCH_COMMAND_PREFIX } from "../terminal-watch-constants";

export interface StartRunInput {
	narratorId: string;
	/** Relationship facts of this run; `deliverTo` names the result's recipient. */
	binding: RunBindingInput;
	resumeRunId?: string;
	expectedSource?: import("./read-conflict").RuntimeSourceObservation;
	recoveryObservation?: import("../recovery-observation").RestartNarrator;
	parentRecoveryTurn?: import("../recovery-observation").ParentRecoveryTurn;
	subagentRecovery?: import("../recovery-observation").ResumeSubagent;
	expectedTask?: { id: string; row: import("../recovery-observation").AgentTaskObservation | null };
	started?: boolean;
	/** Task projection of a delivered run; adopts the actor's pre-registered run. */
	taskRow?: Omit<typeof backgroundTasks.$inferInsert, "logicalRunId">;
	/**
	 * Adopt the actor's pre-registered run (an unconsumed terminal reservation for this
	 * destination) without inserting a task row; a settled run starts a new one. Implied
	 * by `taskRow`.
	 */
	adoptRegisteredRun?: boolean;
}
/** A registered run; `publication` exists exactly when the run delivers a result. */
export interface StartedRun {
	binding: RuntimeRunBinding;
	publication?: PublicationRun;
	recoveryObservation?: import("../recovery-observation").RestartNarrator;
}

import { blockReadsEnabled } from "../narrator-block-scans";
import { newEnvelopeColumns } from "../narrator-block-sync";
import { insertEnvelopeIfAbsent } from "../narrator-body-writes";
import {
	claimNextRefSeq,
	NARRATOR_REF_SEQ_EMPTY_TOP,
	raiseSeqFloorForClaim,
	readTopRefSeq,
} from "../narrator-refs/seq-store";
import {
	AGENT_TASK_OBSERVATION_COLUMNS,
	assertRecoveryFields,
	assertRecoveryRunAdmission,
	RESTART_NARRATOR_COLUMNS,
	RESUME_SUBAGENT_COLUMNS,
} from "../recovery-observation";
import { trackCommunicationWork } from "./async-work";
import { MAILBOX_LIMITS as L } from "./limits";
import type { NoticeKind, RuntimeDb, RuntimeTx } from "./mailbox-types";
import {
	type ArchivedOrphanBackgroundClaim,
	createPostgresRuntimePublication,
	type PgCancelAgentNarratorInput,
	type PgCancelTaskInput,
	type PgCancelTaskResult,
	type PgCleanupInput,
	type PgCleanupTaskResult,
	type PgFinalizeTakeoverInput,
	type PgPublicationRegistrations,
	type PgRestartAgentTaskInput,
	type PgStaleTaskRow,
	type PgStartTransferTaskInput,
	type PgTakeoverInput,
	type PgTerminalTransitionInput,
	type PgUpdateNarratorBackgroundInput,
	requirePublicationTx,
} from "./postgres-runtime-publication";
import {
	assertPublicationTaskIdentity,
	createPublicationOutbox,
	type LegacyCompletionAdmission,
	type LegacyPublicationSource,
	type LegacyRuntimeAdmission,
	type PublicationEvent,
	type PublicationIntent,
	type PublicationRun,
	PublicationStateError,
	publicationDedupeKey,
	publicationEventFromDedupeKey,
	type RunPublicationStatus,
} from "./publication-outbox";
import {
	type AgentTerminalResult,
	type AgentTerminalResultReadOptions,
	type AwaitedTerminalConsumeOptions,
	agentSourceResultRef,
	parseRunSourceBoundary,
} from "./publication-result";
import { assertRuntimeSourceUnchanged, RuntimeReadConflictError } from "./read-conflict";
import type { RuntimeReadOptions } from "./read-options";
import {
	type RuntimeQueuePort,
	requireRuntimeQueuePort,
	resolveRuntimeQueueBackend,
} from "./runtime-queue-port";
import { runAtomicWrite } from "./runtime-write";

/**
 * The full row type of the background_tasks table, used by `readTaskDetail`.
 * Defined locally to avoid a circular import with background-task-service.
 */
type BackgroundTaskRecord = typeof backgroundTasks.$inferSelect;

export type LegacyTaskNotice =
	| { kind: "bg_agent"; task: import("../bg-completion-queue").CompletedBgSubagentNotification }
	| { kind: "bg_bash"; task: import("../background-task-service").CompletedNotification };
export const PUBLICATION_FALLBACK_BYTES = 64 * 1024;

export function publicationEvent(status: string): PublicationEvent {
	if (status === "timeout" || status === "timed out" || status === "timed_out") return "timed_out";
	if (status === "cancelled") return "cancelled";
	if (status === "started" || status === "running") return "started";
	return status === "completed" ? "completed" : "failed";
}

/**
 * Only wiring/capability absence is safe to treat as a no-op at the mailbox barrier.
 * Database failures, retry exhaustion and malformed intents must propagate so the caller
 * cannot consume ahead of an unknown publication state.
 */
export function isRuntimePublicationUnavailableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		/^PostgreSQL runtime publication "[^"]+" is not wired on this synchronous surface:/.test(
			message,
		) ||
		message.startsWith("PostgreSQL runtime queue is not bound:") ||
		message === "PostgreSQL write backend is explicitly selected but unavailable"
	);
}

/** Only the readable summary is bounded here; producer result storage is never truncated here. */
export function publicationSummary(text: string): string {
	// Budget the encoded representation too: control characters can expand sixfold.
	const points = Array.from(text.slice(0, 1200)).slice(0, 600);
	let summary = points.join("");
	while (Buffer.byteLength(JSON.stringify(summary)) > 2048) {
		points.length = Math.floor(points.length / 2);
		summary = points.join("");
	}
	return summary;
}

function sameDeliveryTarget(
	current: RunBindingInput["deliverTo"],
	expected: RunBindingInput["deliverTo"],
): boolean {
	return (
		current?.narratorId === expected?.narratorId &&
		current?.toolUseId === expected?.toolUseId &&
		current?.toolCallId === expected?.toolCallId &&
		current?.attempt === expected?.attempt
	);
}

export function createRuntimePublicationService(database: RuntimeDb) {
	const legacyReaders: Partial<
		Record<NoticeKind, (source: LegacyPublicationSource) => LegacyRuntimeAdmission | undefined>
	> = {};
	let legacyCompletionReader:
		| ((source: LegacyPublicationSource) => LegacyCompletionAdmission | undefined)
		| undefined;
	const store = createPublicationOutbox(database, {
		readLegacyRuntimeAdmission: (source) => legacyReaders[source.producerKind]?.(source),
		readLegacyCompletionAdmission: (source) => legacyCompletionReader?.(source),
	});
	let wake: ((recipientId: string) => void | Promise<void>) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retry = 0;
	let stopped = false;
	let cursor: string | undefined;

	function reserve(run: PublicationRun, tx: RuntimeTx, started = false) {
		if (store.reserveRunSlots(run, { started }, tx).status === "full") {
			throw new ValidationError(
				"Task publication capacity is full; finish existing tasks before starting more.",
			);
		}
	}

	/**
	 * Register a run: its logical id and relationship facts commit together, so nothing
	 * can observe the run without also seeing who it delivers to, who cancels it and its
	 * deadline. A run with a destination also reserves its publication slots (recipient =
	 * `deliverTo.narratorId`) and the `source_after` result boundary; `taskRow` projects
	 * it as a background task in the same transaction.
	 */
	function startRun(input: StartRunInput): StartedRun {
		if (input.taskRow && !input.binding.deliverTo)
			throw new ValidationError("Background task registration requires a delivery destination");
		return runAtomicWrite(database, "publication.startRun", (tx) => {
			if (input.expectedTask)
				assertRecoveryFields(
					input.expectedTask.row,
					tx
						.select(AGENT_TASK_OBSERVATION_COLUMNS)
						.from(backgroundTasks)
						.where(eq(backgroundTasks.id, input.expectedTask.id))
						.get(),
				);
			if (input.subagentRecovery)
				assertRecoveryFields(
					input.subagentRecovery,
					tx.query.narrators
						.findFirst({
							where: eq(narrators.id, input.narratorId),
							columns: RESUME_SUBAGENT_COLUMNS,
						})
						.sync(),
				);
			if (input.parentRecoveryTurn)
				assertRecoveryFields(
					input.parentRecoveryTurn,
					tx
						.select({ id: narrators.id, turnStartedAt: narrators.turnStartedAt })
						.from(narrators)
						.where(eq(narrators.id, input.parentRecoveryTurn.id))
						.get(),
				);
			if (input.recoveryObservation)
				assertRecoveryRunAdmission(
					input.recoveryObservation,
					tx.query.narrators
						.findFirst({
							where: eq(narrators.id, input.narratorId),
							columns: RESTART_NARRATOR_COLUMNS,
						})
						.sync(),
				);
			if (input.expectedSource) {
				const source = tx
					.select({
						runtimeRegistrationJson: narrators.runtimeRegistrationJson,
						ownerUserId: narrators.ownerUserId,
						policySourceNarratorId: narrators.policySourceNarratorId,
					})
					.from(narrators)
					.where(eq(narrators.id, input.narratorId))
					.get();
				assertRuntimeSourceUnchanged(input.expectedSource, source);
			}
			const recipientId = input.binding.deliverTo?.narratorId;
			let resumeRunId = input.resumeRunId;
			if ((input.taskRow || input.adoptRegisteredRun) && recipientId) {
				const actor = tx
					.select({
						logicalRunId: narrators.logicalRunId,
						runtimeRegistrationJson: narrators.runtimeRegistrationJson,
					})
					.from(narrators)
					.where(eq(narrators.id, input.narratorId))
					.get();
				const registered = readRuntimeRegistrationColumn(actor?.runtimeRegistrationJson)?.run;
				if (
					actor?.logicalRunId &&
					registered?.logicalRunId === actor.logicalRunId &&
					registered.deliverTo &&
					!sameDeliveryTarget(registered.deliverTo, input.binding.deliverTo) &&
					(resumeRunId === actor.logicalRunId ||
						store.readRunPublicationState(
							{
								producerKind: "agent",
								taskId: input.narratorId,
								logicalRunId: actor.logicalRunId,
								recipientId: registered.deliverTo.narratorId,
							},
							tx,
						).state !== "settled")
				)
					throw new ValidationError("Stale task publication destination");
				if (resumeRunId === undefined && actor?.logicalRunId) {
					const existingRun: PublicationRun = {
						producerKind: "agent",
						taskId: input.narratorId,
						logicalRunId: actor.logicalRunId,
						recipientId,
					};
					// Only a pre-registered start is adopted. An old terminal/consumed run is
					// not an admission token for the next task.
					if (
						store.hasReservedTerminalSlot(existingRun, tx) &&
						!store.isAwaitedTerminal(existingRun, tx)
					)
						resumeRunId = actor.logicalRunId;
				}
			}
			const logicalRunId = store.persistLogicalRun(input.narratorId, { resumeRunId }, tx);
			const publication: PublicationRun | undefined = recipientId
				? { producerKind: "agent", taskId: input.narratorId, logicalRunId, recipientId }
				: undefined;
			if (publication) {
				const liveTask = tx
					.select({
						id: backgroundTasks.id,
						type: backgroundTasks.type,
						parentNarratorId: backgroundTasks.parentNarratorId,
						subagentNarratorId: backgroundTasks.subagentNarratorId,
						logicalRunId: backgroundTasks.logicalRunId,
						status: backgroundTasks.status,
					})
					.from(backgroundTasks)
					.where(
						and(eq(backgroundTasks.id, input.narratorId), eq(backgroundTasks.status, "running")),
					)
					.get();
				for (const task of [input.taskRow, liveTask]) {
					if (
						task &&
						(task.id !== publication.taskId ||
							task.type !== publication.producerKind ||
							task.parentNarratorId !== publication.recipientId ||
							(task.subagentNarratorId != null && task.subagentNarratorId !== input.narratorId))
					)
						throw new PublicationStateError("identity_mismatch", "start", publication, {
							producerKind: task.type,
							taskId: task.id,
							recipientId: task.parentNarratorId,
							state: task.status,
						});
				}
				reserve(publication, tx, input.started);
			}
			const topSeq = readTopRefSeq(tx, input.narratorId) ?? NARRATOR_REF_SEQ_EMPTY_TOP;
			const source = tx
				.select({
					runtimeRegistrationJson: narrators.runtimeRegistrationJson,
					traits: narrators.traits,
				})
				.from(narrators)
				.where(eq(narrators.id, input.narratorId))
				.get();
			const priorRun = readRuntimeRegistrationColumn(source?.runtimeRegistrationJson)?.run;
			if (
				publication &&
				resumeRunId &&
				priorRun?.logicalRunId === logicalRunId &&
				!sameDeliveryTarget(priorRun.deliverTo, input.binding.deliverTo)
			)
				throw new PublicationStateError("identity_mismatch", "start", publication, {
					logicalRunId: priorRun.logicalRunId,
					recipientId: priorRun.deliverTo?.narratorId,
				});
			const registration = registerRun(
				source?.runtimeRegistrationJson,
				logicalRunId,
				input.binding,
				topSeq + 1,
			);
			tx.update(narrators)
				.set({
					runtimeRegistrationJson: registration,
					...(input.taskRow
						? {
								isBackground: true,
								backgroundStatus: "running" as const,
								backgroundResult: null,
								backgroundCompletedAt: null,
								traits: [...new Set([...parseTraits(source?.traits), "background"])],
								updatedAt: new Date().toISOString(),
							}
						: {}),
				})
				.where(eq(narrators.id, input.narratorId))
				.run();
			if (publication && !resumeRunId) {
				// A stable ref boundary, not millisecond timestamps: two runs may start in
				// the same ms. An empty narrator's watermark is NARRATOR_REF_SEQ_EMPTY_TOP
				// (= base 0 minus one), NOT 0 — the first ref of an empty narrator claims
				// seq 0, and `source_after:0` would exclude it from the run's result.
				tx.update(runtimePublicationOutbox)
					.set({
						resultRef: `source_after:${topSeq}`,
					})
					.where(
						and(
							eq(runtimePublicationOutbox.dedupeKey, publicationDedupeKey(publication, "terminal")),
							eq(runtimePublicationOutbox.state, "reserved"),
						),
					)
					.run();
			}
			if (publication && input.taskRow) {
				if (input.expectedTask?.row)
					tx.update(backgroundTasks)
						.set({ ...input.taskRow, logicalRunId })
						.where(eq(backgroundTasks.id, input.taskRow.id))
						.run();
				else
					tx.insert(backgroundTasks)
						.values({ ...input.taskRow, logicalRunId })
						.run();
			}
			// Only a live projection follows the run here; an ended task row is reopened
			// (status and run together) by the run service, never relinked half-way.
			tx.update(backgroundTasks)
				.set({ logicalRunId })
				.where(and(eq(backgroundTasks.id, input.narratorId), eq(backgroundTasks.status, "running")))
				.run();
			const recoveryObservation = input.subagentRecovery
				? tx.query.narrators
						.findFirst({
							where: eq(narrators.id, input.narratorId),
							columns: RESTART_NARRATOR_COLUMNS,
						})
						.sync()
				: undefined;
			return {
				binding: registration.run,
				...(publication ? { publication } : {}),
				...(recoveryObservation ? { recoveryObservation } : {}),
			};
		});
	}

	function getAgentRun(narratorId: string, recipientId: string, tx: RuntimeTx): PublicationRun;
	function getAgentRun(narratorId: string, recipientId: string): Promise<PublicationRun>;
	function getAgentRun(
		narratorId: string,
		recipientId: string,
		tx?: RuntimeTx,
	): PublicationRun | Promise<PublicationRun> {
		if (!tx)
			return readQueryFirst(
				database
					.select({ logicalRunId: narrators.logicalRunId })
					.from(narrators)
					.where(eq(narrators.id, narratorId))
					.limit(1),
				{ executionPolicy: "worker-required", maxRows: 1 },
			).then((row) => {
				if (!row) throw new ValidationError("Agent has no registered publication source");
				if (row.logicalRunId)
					return {
						producerKind: "agent" as const,
						taskId: narratorId,
						recipientId,
						logicalRunId: row.logicalRunId,
					};
				// Legacy admission can write. Its authoritative source is re-read atomically.
				return runAtomicWrite(database, "publication.getAgentRun", (inner) => {
					const current = inner
						.select({ logicalRunId: narrators.logicalRunId })
						.from(narrators)
						.where(eq(narrators.id, narratorId))
						.get();
					if (!current || current.logicalRunId !== row.logicalRunId)
						throw new RuntimeReadConflictError();
					return getAgentRun(narratorId, recipientId, inner);
				});
			});
		const row = tx
			.select({ logicalRunId: narrators.logicalRunId })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get();
		if (!row) throw new ValidationError("Agent has no registered publication source");
		if (!row.logicalRunId)
			return store.registerLegacyRunningRunSlots(
				{ producerKind: "agent", taskId: narratorId, recipientId },
				{ kind: "runtime" },
				{},
				tx,
			);
		return {
			producerKind: "agent",
			taskId: narratorId,
			recipientId,
			logicalRunId: row.logicalRunId,
		};
	}

	/** Per-run UI-only source snapshot: never overwrite it when the same task starts again. */
	function persistResult(
		run: PublicationRun,
		text: string,
		tx: RuntimeTx,
		eventKind?: Exclude<PublicationEvent, "started">,
	): string {
		// Bash has one durable task per actual attempt; its output is already normalized
		// to the existing 512 KiB budget. Never copy raw stdout into a message row.
		if (run.producerKind === "bash") return `background_task:${run.taskId}:${run.logicalRunId}`;
		const actor = tx
			.select({
				logicalRunId: narrators.logicalRunId,
				runtimeRegistrationJson: narrators.runtimeRegistrationJson,
			})
			.from(narrators)
			.where(eq(narrators.id, run.taskId))
			.get();
		const registered = readRuntimeRegistrationColumn(actor?.runtimeRegistrationJson)?.run;
		if (
			actor?.logicalRunId === run.logicalRunId &&
			registered?.logicalRunId === run.logicalRunId &&
			registered.deliverTo &&
			registered.deliverTo.narratorId !== run.recipientId
		)
			throw new PublicationStateError("identity_mismatch", "finish", run, {
				logicalRunId: registered.logicalRunId,
				recipientId: registered.deliverTo.narratorId,
			});
		const source = tx
			.select({ resultRef: runtimePublicationOutbox.resultRef })
			.from(runtimePublicationOutbox)
			.where(eq(runtimePublicationOutbox.dedupeKey, publicationDedupeKey(run, "terminal")))
			.get();
		const consumed = tx
			.select({ sourceResultRef: runtimeAwaitedTerminalConsumptions.sourceResultRef })
			.from(runtimeAwaitedTerminalConsumptions)
			.where(
				and(
					eq(runtimeAwaitedTerminalConsumptions.producerKind, run.producerKind),
					eq(runtimeAwaitedTerminalConsumptions.taskId, run.taskId),
					eq(runtimeAwaitedTerminalConsumptions.logicalRunId, run.logicalRunId),
					eq(runtimeAwaitedTerminalConsumptions.recipientId, run.recipientId),
				),
			)
			.limit(1)
			.get();
		const capturedSourceRef = agentSourceResultRef(consumed?.sourceResultRef);
		const boundary = parseRunSourceBoundary(source?.resultRef);
		const assistant =
			!capturedSourceRef && boundary !== null
				? tx
						.select({
							id: narratorMessages.id,
							role: narratorMessages.role,
							narratorId: narratorMessages.narratorId,
						})
						.from(narratorMessageRefs)
						.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
						.where(
							and(
								eq(narratorMessageRefs.narratorId, run.taskId),
								gt(narratorMessageRefs.seq, boundary),
							),
						)
						.orderBy(desc(narratorMessageRefs.seq))
						.limit(L.pageSize)
						.all()
						.find((row) => row.role === "assistant" && row.narratorId === run.taskId)
				: undefined;
		// Capture only the already-supported idle display projection. The complete result
		// remains in its existing source; later semantic edits must not change this receipt.
		const originalBytes = Buffer.byteLength(text);
		const preview = text.slice(0, 12_001);
		const storedText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
			Buffer.from(preview).subarray(0, PUBLICATION_FALLBACK_BYTES),
			{ stream: true },
		);
		const truncated = originalBytes > Buffer.byteLength(storedText);
		const messageId = `publication-result:${run.logicalRunId}`;
		const narratorId = run.producerKind === "agent" ? run.taskId : run.recipientId;
		const inserted = insertEnvelopeIfAbsent(tx, {
			id: messageId,
			narratorId,
			role: "disp",
			...newEnvelopeColumns(narratorId),
			contextCharsJson: { segments: [] },
			origin: "system",
			contentText: storedText,
			contentJson: [
				{
					type: "text",
					text: storedText,
					publicationResult: {
						...(eventKind ? { eventKind } : {}),
						logicalRunId: run.logicalRunId,
						truncated,
						originalBytes,
						sourceResultRef:
							capturedSourceRef ??
							(assistant
								? `message:${assistant.id}`
								: `background_task:${run.taskId}:${run.logicalRunId}`),
					},
				},
			],
			createdAt: new Date().toISOString(),
		});
		if (inserted) {
			// Single seq authority (narrator-refs/seq-store.ts); base 0 for an empty
			// narrator, unified with every other refs writer.
			raiseSeqFloorForClaim(tx, narratorId);
			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId,
					seq: claimNextRefSeq(tx, narratorId),
				})
				.run();
		}
		return `message-original:${messageId}`;
	}

	/** State evidence shares one bounded read snapshot; result readability is not admission. */
	function runPublicationStateQuery(run: PublicationRun, slot: number) {
		if (run.producerKind !== "agent" && run.producerKind !== "bash")
			throw new Error("Invalid publication producer identity");
		for (const pointer of [run.taskId, run.logicalRunId, run.recipientId])
			if (typeof pointer !== "string" || !pointer || Buffer.byteLength(pointer) > 256)
				throw new Error("Invalid publication pointer");
		const where = and(
			eq(runtimePublicationOutbox.producerKind, run.producerKind),
			eq(runtimePublicationOutbox.taskId, run.taskId),
			eq(runtimePublicationOutbox.logicalRunId, run.logicalRunId),
			eq(runtimePublicationOutbox.recipientId, run.recipientId),
		);
		const keys = (["completed", "failed", "timed_out", "cancelled"] as const).map((event) =>
			publicationDedupeKey(run, event),
		);
		return sql`SELECT ${slot} AS slot,
			EXISTS (SELECT 1 FROM ${runtimePublicationOutbox} WHERE ${where}
				AND ${runtimePublicationOutbox.eventKind} = 'terminal'
				AND ${runtimePublicationOutbox.state} = 'reserved') AS reserved,
			(SELECT ${runtimePublicationOutbox.eventKind} FROM ${runtimePublicationOutbox} WHERE ${where}
				AND ${runtimePublicationOutbox.eventKind} NOT IN ('started', 'terminal')
				AND ${runtimePublicationOutbox.state} <> 'reserved' LIMIT 1) AS eventKind,
			(SELECT ${narratorBufferedMessages.dedupeKey} FROM ${narratorBufferedMessages}
				WHERE ${narratorBufferedMessages.narratorId} = ${run.recipientId}
				AND ${inArray(narratorBufferedMessages.dedupeKey, keys)} LIMIT 1) AS deliveredKey,
			EXISTS (SELECT 1 FROM ${runtimeAwaitedTerminalConsumptions} WHERE ${and(
				eq(runtimeAwaitedTerminalConsumptions.producerKind, run.producerKind),
				eq(runtimeAwaitedTerminalConsumptions.taskId, run.taskId),
				eq(runtimeAwaitedTerminalConsumptions.logicalRunId, run.logicalRunId),
				eq(runtimeAwaitedTerminalConsumptions.recipientId, run.recipientId),
			)}) AS consumed`;
	}

	async function readRunPublicationStates(
		runs: PublicationRun[],
		options: RuntimeReadOptions = {},
	): Promise<RunPublicationStatus[]> {
		if (runs.length > 1_000) throw new Error("Too many publication state identities");
		const states: RunPublicationStatus[] = [];
		for (let start = 0; start < runs.length; start += 10) {
			const chunk = runs.slice(start, start + 10);
			const rows = await readDbAll<{
				slot: number;
				reserved: number;
				eventKind: Exclude<PublicationEvent, "started"> | null;
				deliveredKey: string | null;
				consumed: number;
			}>(
				database,
				sql`${sql.join(chunk.map(runPublicationStateQuery), sql` UNION ALL `)} ORDER BY slot`,
				{ ...options, executionPolicy: "worker-required", maxRows: chunk.length },
			);
			if (rows.length !== chunk.length) throw new Error("Publication state snapshot unavailable");
			for (const row of rows) {
				if (row.reserved) states.push({ state: "reserved" });
				else if (row.eventKind) states.push({ state: "settled", eventKind: row.eventKind });
				else if (row.deliveredKey) {
					const eventKind = publicationEventFromDedupeKey(row.deliveredKey);
					states.push({ state: "settled", ...(eventKind ? { eventKind } : {}) });
				} else states.push({ state: row.consumed ? "settled" : "none" });
			}
		}
		return states;
	}

	async function readRunPublicationState(
		run: PublicationRun,
		options: RuntimeReadOptions = {},
	): Promise<RunPublicationStatus> {
		return (await readRunPublicationStates([run], options))[0];
	}

	function readAgentTerminalResult(
		run: PublicationRun,
		options: AgentTerminalResultReadOptions = {},
		readOptions: RuntimeReadOptions = {},
	): Promise<AgentTerminalResult | null> {
		return readDomainTask(
			database.$client,
			"publicationTerminalResult",
			{ run, options, fromBlocks: settings.narratorBlocks.read },
			{ ...readOptions, executionPolicy: "worker-required" },
		);
	}

	/** Source result mutation and intent are committed by the caller's SAME synchronous transaction. */
	function commit(intent: PublicationIntent, tx: RuntimeTx) {
		return store.commitIntent({ ...intent, summary: publicationSummary(intent.summary) }, tx);
	}

	function pendingSourceQuery(run: PublicationRun) {
		const keys = (
			["started", "completed", "failed", "timed_out", "cancelled", "terminal"] as const
		).map((event) => publicationDedupeKey(run, event));
		return sql`SELECT EXISTS (SELECT 1 FROM ${runtimePublicationOutbox} WHERE ${inArray(runtimePublicationOutbox.dedupeKey, keys)}) OR EXISTS (SELECT 1 FROM ${narratorBufferedMessages} WHERE ${and(eq(narratorBufferedMessages.narratorId, run.recipientId), inArray(narratorBufferedMessages.dedupeKey, keys), ne(narratorBufferedMessages.state, "cancelled"), or(ne(narratorBufferedMessages.state, "materialized"), isNull(narratorBufferedMessages.adoptedAt)))}) AS pending`;
	}

	async function notifyTransfer(recipientId: string, deliveryId?: string) {
		if (!wake || !deliveryId) return;
		let event: string | undefined;
		try {
			const row = await readQueryFirst(
				database
					.select({ metadataJson: narratorBufferedMessages.metadataJson })
					.from(narratorBufferedMessages)
					.where(eq(narratorBufferedMessages.deliveryId, deliveryId))
					.limit(1),
				{ executionPolicy: "worker-required", maxRows: 1 },
			);
			event = row?.metadataJson
				? (JSON.parse(row.metadataJson) as { eventKind?: string }).eventKind
				: undefined;
		} catch (error) {
			logger.warn("Publication wake metadata unavailable", { recipientId, error: String(error) });
		}
		// Restart/cancel notices are observable on the next pass, not permission to spend a turn.
		if (event === "started" || event === "cancelled") return;
		try {
			void trackCommunicationWork(
				Promise.resolve(wake(recipientId)).catch((error) =>
					logger.warn("Publication wake deferred", { recipientId, error: String(error) }),
				),
			);
		} catch (error) {
			logger.warn("Publication wake deferred", { recipientId, error: String(error) });
		}
	}

	/** All fast and retry paths grant the next vacancy to the earliest durable intent. */
	async function flushRecipient(recipientId: string): Promise<number> {
		let transferred = 0;
		for (const kind of ["agent", "bash"] as const) {
			for (let i = 0; i < L.pageSize / 2; i++) {
				const result = store.transferNext(recipientId, kind);
				if (result.status !== "transferred") break;
				transferred++;
				await notifyTransfer(recipientId, result.deliveryId);
			}
		}
		return transferred;
	}

	/** One bounded page per turn. Full mailboxes release the worker immediately. */
	async function flushPage(): Promise<boolean> {
		const page = await store.listPending({ afterId: cursor, limit: L.pageSize });
		const rows = page.slice(0, L.pageSize);
		// At most one transfer per listed row: a page never expands to pageSize² work.
		const full = new Set<string>();
		for (const row of rows) {
			const key = `${row.recipientId}:${row.producerKind}`;
			if (full.has(key)) continue;
			const result = store.transferNext(row.recipientId, row.producerKind);
			if (result.status === "transferred") await notifyTransfer(row.recipientId, result.deliveryId);
			else full.add(key);
		}
		cursor = page.length > L.pageSize ? rows.at(-1)?.id : undefined;
		return page.length > 0;
	}

	function schedule(reset = true) {
		if (stopped) return;
		if (reset) retry = 0;
		if (timer) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				void trackCommunicationWork(
					(async () => {
						try {
							if ((await flushPage()) && retry++ < L.claimMaxAttempts) schedule(false);
						} catch (error) {
							logger.warn("Runtime publication delivery deferred", { retry, error: String(error) });
							if (retry++ < L.claimMaxAttempts) schedule(false);
						}
					})(),
				);
			},
			retry ? Math.min(50 * 2 ** retry, 1000) : 0,
		);
		timer.unref();
	}

	return {
		store,
		reserve,
		startRun,
		getAgentRun,
		persistResult,
		readAgentTerminalResult,
		readRunPublicationState,
		readRunPublicationStates,
		commit,
		flushRecipient,
		flushPage,
		schedule,
		consumeAwaitedTerminal: (run: PublicationRun, options?: AwaitedTerminalConsumeOptions) =>
			store.consumeAwaitedTerminal(run, undefined, options),
		async hasPendingSource(
			run: PublicationRun,
			options: RuntimeReadOptions = {},
		): Promise<boolean> {
			const [row] = await readDbAll<{ pending: number }>(database, pendingSourceQuery(run), {
				...options,
				executionPolicy: "worker-required",
				maxRows: 1,
			});
			if (!row) throw new Error("Publication state snapshot unavailable");
			return !!row.pending;
		},
		hasPendingSourceInTransaction(run: PublicationRun, tx: RuntimeTx): boolean {
			return !!tx.all<{ pending: number }>(pendingSourceQuery(run))[0]?.pending;
		},
		newBashRun(taskId: string, recipientId: string): PublicationRun {
			return { producerKind: "bash", taskId, recipientId, logicalRunId: generateId() };
		},
		setLegacyCompletionAdmissionReader(
			reader: (source: LegacyPublicationSource) => LegacyCompletionAdmission | undefined,
		) {
			legacyCompletionReader = reader;
		},
		migrateLegacyTaskNotice(
			recipientId: string,
			entry: LegacyTaskNotice,
		): "migrated" | "diagnostic" {
			const status = runAtomicWrite(database, "publication.migrateLegacyTaskNotice", (tx) => {
				const source: LegacyPublicationSource = {
					producerKind: entry.kind === "bg_agent" ? "agent" : "bash",
					taskId: entry.task.id,
					recipientId,
				};
				const registration = store.registerLegacyCompletedRunSlots(source, tx);
				if (registration.status === "unmigratable") {
					const recipient = tx
						.select({ id: narrators.id })
						.from(narrators)
						.where(eq(narrators.id, recipientId))
						.get();
					if (!recipient) {
						logger.warn("Legacy publication recipient permanently deleted", {
							recipientId,
							taskId: entry.task.id,
							reason: registration.reason,
						});
						return "diagnostic" as const;
					}
					const messageId = `legacy-publication-diagnostic:${recipientId}:${source.producerKind}:${source.taskId}`;
					const text = publicationSummary(
						`Legacy task notification could not be migrated (${source.taskId}): ${registration.reason}. No task was rerun.`,
					);
					const inserted = insertEnvelopeIfAbsent(tx, {
						id: messageId,
						narratorId: recipientId,
						role: "disp",
						...newEnvelopeColumns(recipientId),
						contextCharsJson: { segments: [] },
						origin: "system",
						contentText: text,
						contentJson: [{ type: "text", text }],
						createdAt: new Date().toISOString(),
					});
					if (inserted) {
						// Single seq authority (narrator-refs/seq-store.ts); base 0 for an
						// empty narrator, unified with every other refs writer.
						raiseSeqFloorForClaim(tx, recipientId);
						tx.insert(narratorMessageRefs)
							.values({
								id: generateId(),
								narratorId: recipientId,
								messageId,
								seq: claimNextRefSeq(tx, recipientId),
							})
							.run();
					}
					return "diagnostic" as const;
				}
				const result =
					entry.kind === "bg_agent"
						? (entry.task.result ?? entry.task.resultPreview ?? "")
						: (entry.task.outputPreview ?? "");
				commit(
					{
						...registration.run,
						eventKind: registration.eventKind,
						resultRef: persistResult(registration.run, result, tx),
						summary: `[System] Background ${source.producerKind} "${entry.task.title ?? entry.task.alias ?? source.taskId}" (ID: ${entry.task.alias ?? source.taskId}) ${registration.eventKind}. Use ${source.producerKind === "agent" ? `Watch({ type: "agent", id: "${entry.task.alias ?? source.taskId}" })` : `TeamStatus({ action: "get_task", target_id: "${entry.task.alias ?? source.taskId}" })`} to inspect the stored result.`,
					},
					tx,
				);
				return "migrated" as const;
			});
			schedule();
			return status;
		},
		setLegacyRuntimeAdmissionReader(
			kind: NoticeKind,
			reader: (source: LegacyPublicationSource) => LegacyRuntimeAdmission | undefined,
		) {
			legacyReaders[kind] = reader;
		},
		setWake(handler: typeof wake) {
			wake = handler;
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

const workerLifecycle = hotSafe<{ stop?: () => void }>(
	"narrafork:runtime-publication-worker",
	() => ({}),
);
// --hot replaces code, not the durable queue. Retire the old timer rather than multiplying workers.
workerLifecycle.stop?.();

export type RuntimePublicationService = ReturnType<typeof createRuntimePublicationService>;

/**
 * The PostgreSQL-mode stand-in for `runtimePublication`.
 *
 * WHY THIS EXISTS: constructing the real service touches the database AT CONSTRUCTION
 * (`createPublicationOutbox` captures the legacy rowid boundary), so the module-level
 * `createRuntimePublicationService(db)` cannot run while `db` is the fail-closed
 * SQLite proxy — importing this module would crash PG startup. The facade keeps the
 * exact synchronous API surface (callers stay untouched) with two behaviors:
 *
 *   - EVERY database operation throws a precise error naming the async facade. The
 *     synchronous producer surface is SQLite-only; the PostgreSQL implementation
 *     lives behind {@link getRuntimePublicationService} (the honestly-async facade),
 *     and the caller-migration track re-points producers at it. Until a call site
 *     migrates, an attempted publish on the PG backend fails closed here instead of
 *     dying inside the opaque proxy.
 *   - REGISTRATION methods (`setWake`, the two legacy admission readers) and `stop`
 *     never throw: producers register their readers at module scope (inbox.ts,
 *     subagent-runner.ts, parent-injection-queue.ts, background-task-service.ts), and
 *     those imports must survive PG startup. Registrations are RETAINED in the
 *     shared `PgPublicationRegistrations` store — the same object the async facade's
 *     PostgreSQL worker reads — so the wired PG publication service consumes exactly
 *     what producers registered; `stop` is a lifecycle no-op when no worker exists.
 */
export function createUnwiredPublicationFacade(
	held: PgPublicationRegistrations = { legacyReaders: new Map() },
): RuntimePublicationService {
	const unavailable = (operation: string): never => {
		throw new Error(
			`PostgreSQL runtime publication "${operation}" is not wired on this synchronous ` +
				"surface: the synchronous producer API is SQLite-only. The PostgreSQL " +
				"implementation is the honestly-async facade (getRuntimePublicationService); " +
				"this facade fails closed instead of touching the fail-closed SQLite handle. " +
				"There is no SQLite fallback.",
		);
	};
	return {
		get store(): RuntimePublicationService["store"] {
			return unavailable("store");
		},
		reserve: () => unavailable("reserve"),
		startRun: () => unavailable("startRun"),
		getAgentRun: () => unavailable("getAgentRun"),
		persistResult: () => unavailable("persistResult"),
		readAgentTerminalResult: () => unavailable("readAgentTerminalResult"),
		readRunPublicationState: () => unavailable("readRunPublicationState"),
		readRunPublicationStates: () => unavailable("readRunPublicationStates"),
		commit: () => unavailable("commit"),
		flushRecipient: () => unavailable("flushRecipient"),
		flushPage: () => unavailable("flushPage"),
		schedule: () => unavailable("schedule"),
		hasPendingSource: () => unavailable("hasPendingSource"),
		hasPendingSourceInTransaction: () => unavailable("hasPendingSourceInTransaction"),
		consumeAwaitedTerminal: () => unavailable("consumeAwaitedTerminal"),
		newBashRun: () => unavailable("newBashRun"),
		migrateLegacyTaskNotice: () => unavailable("migrateLegacyTaskNotice"),
		setLegacyRuntimeAdmissionReader: (kind, reader) => {
			held.legacyReaders.set(kind, reader);
		},
		setLegacyCompletionAdmissionReader: (reader) => {
			held.completionReader = reader;
		},
		setWake: (handler) => {
			held.wake = handler;
		},
		stop: () => {},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The async publication facade (the production PostgreSQL surface)
// ─────────────────────────────────────────────────────────────────────────────
//
// The bound-facade contract for the publication producer: ONE interface whose
// every database operation returns a Promise, selected per call from the
// runtime-queue-port binding — SQLite wraps the legacy synchronous service's
// already-committed results (async function bodies run the sync section eagerly,
// so the SQLite timing observable to fire-and-forget callers is unchanged), and
// PostgreSQL drives the named composites in `postgres-runtime-publication.ts`.
// A process configured for PostgreSQL with no queue bound throws from
// `requireRuntimeQueuePort` — a wiring bug is loud, never a SQLite fallback.

export type PublicationCommitResult = {
	status: "duplicate" | "committed";
	deliveryId: string | null;
	arrivalSeq: number | null;
	/** False when onlyIfActive suppressed a terminal/missing parent conclusion write. */
	toolConclusionApplied?: boolean;
};

/** Exact admission evidence, checked again inside the terminal transaction. */
export interface AgentStartFailureGuard {
	deliverTo: NonNullable<RunBindingInput["deliverTo"]>;
	/** Keep takeover and its same-run result; background delivery waits for release. */
	retainHeldResult?: boolean;
	assertOwner(): void;
}

/** Shared SQLite/PG predicate; callers read these rows in their committing transaction. */
export function assertAgentStartFailureIdentity(
	run: PublicationRun,
	guard: AgentStartFailureGuard,
	actor:
		| {
				logicalRunId: string | null;
				parentNarratorId: string | null;
				runtimeRegistrationJson: unknown;
				backgroundStatus: string | null;
				substatus: unknown;
		  }
		| undefined,
	task:
		| {
				type: string;
				status: string;
				parentNarratorId: string;
				subagentNarratorId: string | null;
				logicalRunId: string | null;
				toolUseId: string | null;
				toolCallId: string | null;
				executionAttempt: number | null;
		  }
		| undefined,
	source:
		| {
				id: string;
				narratorId: string;
				toolUseId: string;
				executionAttempt: number;
		  }
		| undefined,
): void {
	guard.assertOwner();
	const destination = guard.deliverTo;
	const registered = readRuntimeRegistrationColumn(actor?.runtimeRegistrationJson)?.run;
	if (
		run.producerKind !== "agent" ||
		run.recipientId !== destination.narratorId ||
		actor?.logicalRunId !== run.logicalRunId ||
		actor.parentNarratorId !== destination.narratorId ||
		actor.backgroundStatus !== "running" ||
		(guard.retainHeldResult && !parseSubstatus(actor.substatus).includes("taken_over")) ||
		parseSubstatus(actor.substatus).includes(`terminal_run:${run.logicalRunId}`) ||
		registered?.logicalRunId !== run.logicalRunId ||
		!sameDeliveryTarget(registered.deliverTo, destination) ||
		registered.deliverTo?.viaTask !== destination.viaTask ||
		task?.type !== "agent" ||
		task.status !== "running" ||
		task.parentNarratorId !== destination.narratorId ||
		task.subagentNarratorId !== run.taskId ||
		task.logicalRunId !== run.logicalRunId ||
		task.toolUseId !== destination.toolUseId ||
		task.toolCallId !== (destination.toolCallId ?? null) ||
		task.executionAttempt !== (destination.attempt ?? null) ||
		(destination.toolCallId !== undefined &&
			(source?.id !== destination.toolCallId ||
				source.narratorId !== destination.narratorId ||
				source.toolUseId !== destination.toolUseId ||
				source.executionAttempt !== destination.attempt))
	)
		throw new ValidationError("Stale agent startup failure");
}

/** The terminal-commit composite input (result snapshot + intent in one section). */
export interface PublicationTerminalCommit {
	readonly run: PublicationRun;
	readonly eventKind: Exclude<PublicationEvent, "started">;
	/** The producer's result text; the agent kind snapshots it into a message/ref. */
	readonly text: string;
	readonly summary: string;
	/** Foreground delivery stores the snapshot then consumes in the same transaction, without notice/wake. */
	readonly delivery?: "background" | "foreground";
	/** A registered task failed before normal execution preparation took over. */
	readonly startupFailure?: AgentStartFailureGuard;
	/** Detached PG fallback: exact tool card and terminal publish in one transaction. */
	readonly toolConclusion?: {
		toolCallId: string;
		messageId: string;
		toolUseId: string;
		attempt?: number;
		output: string;
		status: "success" | "fail";
		resultMessageId?: string;
		/** Recovery explanations may update only an active row, never a terminal result. */
		onlyIfActive?: boolean;
	};
}

export interface AsyncRuntimePublicationService {
	readonly backend: "sqlite" | "postgres";
	startRun(input: StartRunInput): Promise<StartedRun>;
	getAgentRun(narratorId: string, recipientId: string): Promise<PublicationRun>;
	newBashRun(taskId: string, recipientId: string): PublicationRun;
	startBashRun(input: {
		taskId: string;
		recipientId: string;
		started?: boolean;
		/** PG-only: insert background_tasks row + reserve publication slots in one section. */
		taskRow?: Omit<typeof backgroundTasks.$inferInsert, "logicalRunId">;
	}): Promise<PublicationRun>;
	/** Transfer owner-generation check, projection revival and result reservation are atomic. */
	startTransferTask(input: PgStartTransferTaskInput): Promise<BackgroundTaskRecord | undefined>;
	/** Restart an existing agent task: CAS → "running" + logical run link. */
	restartAgentTask(input: PgRestartAgentTaskInput): Promise<{ id: string } | undefined>;
	/** Update narrator background completion fields + optional terminal publication. */
	updateNarratorBackground(input: PgUpdateNarratorBackgroundInput): Promise<void>;
	/** Release only still-reserved publication slots; safe to replay after a lost confirmation. */
	releaseUnusedRunSlots(run: PublicationRun): Promise<number>;
	/** Terminal transition for a background task: CAS + publication in one composite. */
	commitTerminalTransition(input: PgTerminalTransitionInput): Promise<
		| {
				id: string;
				type: string;
				status: string;
				parentNarratorId: string;
				title: string | null;
				alias: string | null;
				output: string | null;
				toolUseId: string | null;
				logicalRunId: string | null;
		  }
		| undefined
	>;
	/** Worker-required SQLite read / native async PG read of one archive compensation identity. */
	readArchivedOrphanBackgroundClaim(
		narratorId: string,
	): Promise<ArchivedOrphanBackgroundClaim | null>;
	/** Caller holds start admission and excludes runtime drivers. No model result or publication is emitted. */
	settleArchivedOrphanBackgroundClaim(
		claim: ArchivedOrphanBackgroundClaim,
		now: string,
	): Promise<boolean>;
	/** Named bounded read: full background task detail by id (LIMIT 1). */
	readBackgroundTask(taskId: string): Promise<BackgroundTaskRecord | null>;
	/**
	 * Named bounded read: full detail of a background task row by id.
	 * Returns the complete BackgroundTaskRecord (including output) or null.
	 * On PG this is a LIMIT-1 async query; SQLite dispatches the bounded read to its Worker.
	 */
	readTaskDetail(taskId: string): Promise<BackgroundTaskRecord | null>;
	/**
	 * Cancel task composite: check cancellability, CAS to terminal status,
	 * and commit publication terminal intent in ONE section. Returns null when
	 * the CAS rejects. Caller owns in-memory side effects (abort, events).
	 */
	cancelTask(input: PgCancelTaskInput): Promise<PgCancelTaskResult | null>;
	/** Cancel the paired agent narrator projection without touching SQLite on PG. */
	cancelAgentNarrator(input: PgCancelAgentNarratorInput): Promise<void>;
	/**
	 * Mark a task as taken over: CAS "running" → "cancelled" (no publication).
	 * Returns { parentNarratorId } for list-delta upsert, or null if CAS rejects.
	 */
	markTakenOver(input: PgTakeoverInput): Promise<{ parentNarratorId: string } | null>;
	/**
	 * Finalize a taken-over task: CAS "cancelled" → terminal with output.
	 * Returns { id, parentNarratorId } for list-delta upsert, or null if CAS rejects.
	 */
	finalizeTakeover(
		input: PgFinalizeTakeoverInput,
	): Promise<{ parentNarratorId: string; id: string } | null>;
	/**
	 * Named bounded read: running stale tasks for recovery. Paginated via id cursor.
	 */
	readRunningStaleTasks(afterId?: string): Promise<PgStaleTaskRow[]>;
	/** PG-native stale recovery: task/narrator terminal state plus publication in one section. */
	recoverStaleTask(input: {
		taskId: string;
		text: string;
		eventKind: "failed" | "cancelled";
		now: string;
	}): Promise<unknown>;
	/** PG-native paused transfer recovery. */
	pauseStaleTransfer(input: { taskId: string; now: string; notice: string }): Promise<unknown>;
	/** Cleanup completed tasks: bounded select + publication filter + delete. */
	cleanupTasks(input: PgCleanupInput): Promise<PgCleanupTaskResult[]>;
	persistResult(run: PublicationRun, text: string): Promise<string>;
	commit(intent: PublicationIntent): Promise<PublicationCommitResult>;
	commitAgentTerminal(input: PublicationTerminalCommit): Promise<PublicationCommitResult>;
	commitBashTerminal(input: PublicationTerminalCommit): Promise<PublicationCommitResult>;
	migrateLegacyTaskNotice(
		recipientId: string,
		entry: LegacyTaskNotice,
	): Promise<"migrated" | "diagnostic">;
	/** Read only this run's bounded result; deferred source reads require a trusted same-run settled observation. */
	readAgentTerminalResult(
		run: PublicationRun,
		options?: AgentTerminalResultReadOptions,
		committedObservation?: RuntimeReadOptions,
	): Promise<AgentTerminalResult | null>;
	/** Whether this run may still publish a terminal: the ONLY authority for resume-vs-deliver decisions. */
	readRunPublicationState(
		run: PublicationRun,
		options?: RuntimeReadOptions,
	): Promise<RunPublicationStatus>;
	readRunPublicationStates(
		runs: PublicationRun[],
		options?: RuntimeReadOptions,
	): Promise<RunPublicationStatus[]>;
	/** Durable, exact-run consumption; revoke only terminal notices not yet in recipient history. */
	consumeAwaitedTerminal(
		run: PublicationRun,
		options?: AwaitedTerminalConsumeOptions,
	): Promise<void>;
	hasPendingSource(run: PublicationRun): Promise<boolean>;
	flushRecipient(recipientId: string): Promise<number>;
	flushPage(): Promise<boolean>;
	schedule(reset?: boolean): void;
	stop(): void;
	setWake(handler: ((recipientId: string) => void | Promise<void>) | undefined): void;
	setLegacyRuntimeAdmissionReader(
		kind: NoticeKind,
		reader: (source: LegacyPublicationSource) => LegacyRuntimeAdmission | undefined,
	): void;
	setLegacyCompletionAdmissionReader(
		reader: (source: LegacyPublicationSource) => LegacyCompletionAdmission | undefined,
	): void;
}

/**
 * The ONE registration store the two PostgreSQL surfaces share: producers register
 * their wake handler and legacy admission readers at module scope through the
 * legacy `runtimePublication` object (the fail-closed unwired facade on PG), and
 * the async facade's PostgreSQL worker reads the same store live at call time.
 * On SQLite the legacy service's own closure holds registrations and this store
 * stays unused.
 */
const pgPublicationRegistrations: PgPublicationRegistrations = { legacyReaders: new Map() };

/**
 * SQLite writes complete their small synchronous transactions before resolving;
 * read-only observations run on the Worker. No Promise enters a bun:sqlite write
 * section, and every final identity/CAS check stays in the committing transaction.
 */
function createSqliteAsyncPublicationService(
	legacy: RuntimePublicationService,
): AsyncRuntimePublicationService {
	const commitTerminal = (input: PublicationTerminalCommit): Promise<PublicationCommitResult> =>
		Promise.resolve(
			runAtomicWrite(db, "publication.commitTerminal", (tx) => {
				if (input.startupFailure) {
					const guard = input.startupFailure;
					const actor = tx
						.select({
							logicalRunId: narrators.logicalRunId,
							parentNarratorId: narrators.parentNarratorId,
							runtimeRegistrationJson: narrators.runtimeRegistrationJson,
							backgroundStatus: narrators.backgroundStatus,
							substatus: narrators.substatus,
							status: narrators.status,
						})
						.from(narrators)
						.where(eq(narrators.id, input.run.taskId))
						.get();
					const task = tx
						.select({
							type: backgroundTasks.type,
							status: backgroundTasks.status,
							parentNarratorId: backgroundTasks.parentNarratorId,
							subagentNarratorId: backgroundTasks.subagentNarratorId,
							logicalRunId: backgroundTasks.logicalRunId,
							toolUseId: backgroundTasks.toolUseId,
							toolCallId: backgroundTasks.toolCallId,
							executionAttempt: backgroundTasks.executionAttempt,
						})
						.from(backgroundTasks)
						.where(eq(backgroundTasks.id, input.run.taskId))
						.get();
					const source = guard.deliverTo.toolCallId
						? tx
								.select({
									id: narratorToolCalls.id,
									narratorId: narratorToolCalls.narratorId,
									toolUseId: narratorToolCalls.toolUseId,
									executionAttempt: narratorToolCalls.executionAttempt,
								})
								.from(narratorToolCalls)
								.where(eq(narratorToolCalls.id, guard.deliverTo.toolCallId))
								.get()
						: undefined;
					assertAgentStartFailureIdentity(input.run, guard, actor, task, source);
					const now = new Date().toISOString();
					const status =
						input.eventKind === "cancelled" ? ("cancelled" as const) : ("failed" as const);
					if (guard.retainHeldResult) {
						tx.update(narrators)
							.set({
								status: actor?.status === "archived" ? "archived" : "idle",
								substatus: JSON.stringify([
									...new Set([
										...parseSubstatus(actor?.substatus),
										status === "cancelled" ? "interrupted" : "error",
										`terminal_run:${input.run.logicalRunId}`,
									]),
								]),
								backgroundStatus: status,
								backgroundResult: input.text,
								backgroundCompletedAt: now,
								updatedAt: now,
							})
							.where(
								and(
									eq(narrators.id, input.run.taskId),
									eq(narrators.logicalRunId, input.run.logicalRunId),
								),
							)
							.run();
						if (input.delivery !== "foreground")
							return { status: "committed" as const, deliveryId: null, arrivalSeq: null };
					}
					tx.update(backgroundTasks)
						.set({
							status,
							output: input.text,
							outputBytes: Buffer.byteLength(input.text),
							completedAt: now,
							updatedAt: now,
						})
						.where(
							and(
								eq(backgroundTasks.id, input.run.taskId),
								eq(backgroundTasks.logicalRunId, input.run.logicalRunId),
								eq(backgroundTasks.status, "running"),
							),
						)
						.run();
					if (!guard.retainHeldResult)
						tx.update(narrators)
							.set({
								status: actor?.status === "archived" ? "archived" : "idle",
								substatus: JSON.stringify([status === "cancelled" ? "interrupted" : "error"]),
								backgroundStatus: status,
								backgroundResult: input.text,
								backgroundCompletedAt: now,
								updatedAt: now,
							})
							.where(
								and(
									eq(narrators.id, input.run.taskId),
									eq(narrators.logicalRunId, input.run.logicalRunId),
								),
							)
							.run();
				}
				if (input.delivery === "foreground") {
					legacy.persistResult(input.run, input.text, tx, input.eventKind);
					legacy.store.consumeAwaitedTerminal(input.run, tx);
					return { status: "committed" as const, deliveryId: null, arrivalSeq: null };
				}
				return legacy.commit(
					{
						...input.run,
						eventKind: input.eventKind,
						resultRef: legacy.persistResult(input.run, input.text, tx, input.eventKind),
						summary: input.summary,
					},
					tx,
				);
			}),
		);
	return {
		backend: "sqlite",
		startRun: async (input) => {
			const started = legacy.startRun(input);
			eventBus.emit({ type: "narrator:execution_principal_changed", narratorId: input.narratorId });
			return started;
		},
		getAgentRun: async (narratorId, recipientId) => legacy.getAgentRun(narratorId, recipientId),
		newBashRun: (taskId, recipientId) => legacy.newBashRun(taskId, recipientId),
		startBashRun: async (input) => {
			const run = legacy.newBashRun(input.taskId, input.recipientId);
			runAtomicWrite(db, "publication.startBashRun", (tx) =>
				legacy.reserve(run, tx, input.started),
			);
			return run;
		},
		startTransferTask: async (input) =>
			runAtomicWrite(db, "publication.startTransferTask", (tx) => {
				const owner = tx
					.select({
						id: deviceTransferTasks.id,
						parentNarratorId: deviceTransferTasks.parentNarratorId,
						status: deviceTransferTasks.status,
						generation: deviceTransferTasks.runGeneration,
					})
					.from(deviceTransferTasks)
					.where(eq(deviceTransferTasks.id, input.taskRow.transferTaskId))
					.get();
				if (!owner || owner.parentNarratorId !== input.taskRow.parentNarratorId) return undefined;
				const existing = tx
					.select()
					.from(backgroundTasks)
					.where(
						and(
							eq(backgroundTasks.transferTaskId, owner.id),
							eq(backgroundTasks.parentNarratorId, owner.parentNarratorId),
						),
					)
					.get();
				if (
					owner.status !== "running" ||
					(input.runGeneration !== undefined && input.runGeneration !== owner.generation)
				)
					return existing;
				const generationRunId = `transfer:${owner.id}:${owner.generation}`;
				const alias = existing?.alias ?? input.taskRow.alias ?? null;
				if (existing?.status === "running" && existing.logicalRunId) {
					if (alias !== existing.alias)
						return tx
							.update(backgroundTasks)
							.set({ alias })
							.where(eq(backgroundTasks.id, existing.id))
							.returning()
							.get();
					return existing;
				}
				if (existing && existing.status !== "paused" && existing.logicalRunId === generationRunId)
					return existing;
				const run: PublicationRun = {
					producerKind: "bash",
					taskId: existing?.id ?? input.taskRow.id,
					recipientId: owner.parentNarratorId,
					logicalRunId:
						existing?.status === "paused" && existing.logicalRunId
							? existing.logicalRunId
							: generationRunId,
				};
				legacy.reserve(run, tx);
				if (existing)
					return tx
						.update(backgroundTasks)
						.set({
							status: "running",
							logicalRunId: run.logicalRunId,
							alias,
							output: null,
							outputBytes: 0,
							outputTruncated: false,
							exitCode: null,
							completedAt: null,
							notified: false,
							updatedAt: input.taskRow.updatedAt,
						})
						.where(eq(backgroundTasks.id, existing.id))
						.returning()
						.get();
				return tx
					.insert(backgroundTasks)
					.values({ ...input.taskRow, logicalRunId: run.logicalRunId })
					.returning()
					.get();
			}),
		releaseUnusedRunSlots: async (run) => Promise.resolve(legacy.store.releaseUnusedRunSlots(run)),
		restartAgentTask: async (input) => {
			const now = input.now;
			const existing = await readQueryFirst(
				db
					.select({ logicalRunId: backgroundTasks.logicalRunId, status: backgroundTasks.status })
					.from(backgroundTasks)
					.where(eq(backgroundTasks.id, input.taskId))
					.limit(1),
				{ executionPolicy: "worker-required", maxRows: 1 },
			);
			if (!existing || existing.status !== input.expectedStatus) return undefined;
			return Promise.resolve(
				runAtomicWrite(db, "publication.restartAgentTask", (tx) => {
					const current = tx
						.select({
							type: backgroundTasks.type,
							parentNarratorId: backgroundTasks.parentNarratorId,
							subagentNarratorId: backgroundTasks.subagentNarratorId,
							logicalRunId: backgroundTasks.logicalRunId,
							status: backgroundTasks.status,
						})
						.from(backgroundTasks)
						.where(eq(backgroundTasks.id, input.taskId))
						.get();
					if (
						!current ||
						current.logicalRunId !== existing.logicalRunId ||
						current.status !== existing.status
					)
						throw new RuntimeReadConflictError();
					if (
						!current ||
						current.type !== "agent" ||
						(current.subagentNarratorId !== null &&
							current.subagentNarratorId !== input.subagentNarratorId)
					)
						return undefined;
					const actor = tx
						.select({
							logicalRunId: narrators.logicalRunId,
							runtimeRegistrationJson: narrators.runtimeRegistrationJson,
						})
						.from(narrators)
						.where(eq(narrators.id, input.subagentNarratorId))
						.get();
					const registered = readRuntimeRegistrationColumn(actor?.runtimeRegistrationJson)?.run;
					if (
						actor?.logicalRunId !== input.logicalRunId ||
						(registered &&
							(registered.logicalRunId !== input.logicalRunId ||
								registered.deliverTo?.narratorId !== current.parentNarratorId ||
								(input.toolUseId !== undefined &&
									registered.deliverTo?.toolUseId !== input.toolUseId)))
					)
						throw new RuntimeReadConflictError();
					const updated = tx
						.update(backgroundTasks)
						.set({
							status: "running",
							// The run the caller registered for this restart (same as PostgreSQL).
							logicalRunId: input.logicalRunId,
							command: null,
							exitCode: null,
							subagentNarratorId: input.subagentNarratorId,
							subagentType: input.subagentType,
							toolUseId: input.toolUseId ?? null,
							alias: input.alias ?? null,
							title: input.title ?? null,
							output: null,
							outputBytes: 0,
							outputTruncated: false,
							notified: false,
							startedAt: now,
							completedAt: null,
							updatedAt: now,
						})
						.where(
							and(
								eq(backgroundTasks.id, input.taskId),
								existing.logicalRunId === null
									? isNull(backgroundTasks.logicalRunId)
									: eq(backgroundTasks.logicalRunId, existing.logicalRunId),
								eq(
									backgroundTasks.status,
									input.expectedStatus as
										| "running"
										| "completed"
										| "failed"
										| "cancelled"
										| "paused"
										| "timeout",
								),
							),
						)
						.returning({ id: backgroundTasks.id })
						.get();
					if (!updated) throw new RuntimeReadConflictError();
					return updated;
				}),
			);
		},
		updateNarratorBackground: async (input) => {
			runAtomicWrite(db, "publication.updateNarratorBackground", (tx) => {
				tx.update(narrators)
					.set({
						...(input.isBackground !== undefined ? { isBackground: input.isBackground } : {}),
						backgroundStatus: input.backgroundStatus,
						backgroundResult: input.backgroundResult,
						backgroundCompletedAt: input.backgroundCompletedAt,
						updatedAt: input.updatedAt,
					})
					.where(eq(narrators.id, input.narratorId))
					.run();
				if (!input.deferPublication) {
					const run = legacy.getAgentRun(input.narratorId, input.parentNarratorId, tx);
					legacy.commit(
						{
							...run,
							eventKind: input.backgroundStatus === "completed" ? "completed" : "failed",
							resultRef: legacy.persistResult(run, input.backgroundResult, tx),
							summary: `[System] Background agent (ID: ${input.narratorId}) ${input.backgroundStatus}. Use Watch({ type: "agent", id: "${input.narratorId}" }) to read its stored result.`,
						},
						tx,
					);
				}
			});
			backgroundOccupancyStore.refreshNarrator(input.narratorId);
		},
		commitTerminalTransition: async (input) => {
			const task = runAtomicWrite(db, "publication.commitTerminalTransition", (tx) => {
				if (input.expectedTransfer) {
					const owner = tx
						.select({ generation: deviceTransferTasks.runGeneration })
						.from(deviceTransferTasks)
						.where(eq(deviceTransferTasks.id, input.expectedTransfer.id))
						.get();
					if (owner?.generation !== input.expectedTransfer.generation) return undefined;
				}
				// The SQLite branch pre-reads the task for its logicalRunId, which the
				// publication run needs. The CAS guard (WHERE status = "running") prevents
				// double-transition.
				const before = tx
					.select({
						id: backgroundTasks.id,
						type: backgroundTasks.type,
						parentNarratorId: backgroundTasks.parentNarratorId,
						logicalRunId: backgroundTasks.logicalRunId,
						status: backgroundTasks.status,
					})
					.from(backgroundTasks)
					.where(eq(backgroundTasks.id, input.taskId))
					.get();
				if (input.expectedRun) assertPublicationTaskIdentity(input.expectedRun, before);
				if (
					before &&
					before.type !== "transfer" &&
					!before.logicalRunId &&
					!input.silentObservation
				) {
					legacy.store.registerLegacyRunningRunSlots(
						{
							producerKind: before.type,
							taskId: input.taskId,
							recipientId: before.parentNarratorId,
						},
						{ kind: "runtime" },
						{},
						tx,
					);
				}
				const updated = tx
					.update(backgroundTasks)
					.set(input.setFields)
					.where(
						and(
							eq(backgroundTasks.id, input.taskId),
							input.expectedTransfer
								? and(
										eq(backgroundTasks.type, "transfer"),
										eq(backgroundTasks.transferTaskId, input.expectedTransfer.id),
										inArray(backgroundTasks.status, ["running", "paused"]),
									)
								: eq(backgroundTasks.status, "running"),
							input.silentObservation
								? and(
										eq(backgroundTasks.type, "bash"),
										or(
											like(backgroundTasks.command, `${WATCH_COMMAND_PREFIX}%`),
											like(backgroundTasks.command, `${TERMINAL_WATCH_COMMAND_PREFIX}%`),
										),
									)
								: undefined,
						),
					)
					.returning({
						id: backgroundTasks.id,
						type: backgroundTasks.type,
						status: backgroundTasks.status,
						parentNarratorId: backgroundTasks.parentNarratorId,
						title: backgroundTasks.title,
						alias: backgroundTasks.alias,
						output: backgroundTasks.output,
						toolUseId: backgroundTasks.toolUseId,
						logicalRunId: backgroundTasks.logicalRunId,
					})
					.get();
				if (!updated) return undefined;
				if (input.silentObservation) {
					if (updated.logicalRunId)
						legacy.store.releaseUnusedRunSlots(taskPublicationRun(updated), tx);
					return updated;
				}
				if (input.deferPublication) return updated;
				if (updated.type === "transfer" && !updated.logicalRunId) {
					const run = legacy.newBashRun(updated.id, updated.parentNarratorId);
					legacy.reserve(run, tx);
					tx.update(backgroundTasks)
						.set({ logicalRunId: run.logicalRunId })
						.where(eq(backgroundTasks.id, updated.id))
						.run();
					updated.logicalRunId = run.logicalRunId;
				}
				const run = taskPublicationRun(updated);
				legacy.commit(
					{
						...run,
						eventKind: input.eventKind,
						resultRef: legacy.persistResult(run, input.fullOutput, tx),
						summary: input.summary,
					},
					tx,
				);
				return updated;
			});
			if (task) legacy.schedule();
			return task ?? undefined;
		},
		cleanupTasks: async () => {
			throw new Error(
				"cleanupTasks is a PostgreSQL-only composite. " +
					"SQLite cleanup is handled directly by background-task-service.cleanupCompleted.",
			);
		},
		readArchivedOrphanBackgroundClaim: async (narratorId) => {
			return (
				(
					await readQuery(
						db
							.select({
								id: narrators.id,
								parentNarratorId: narrators.parentNarratorId,
								type: narrators.type,
								status: narrators.status,
								backgroundStatus: narrators.backgroundStatus,
								backgroundCompletedAt: narrators.backgroundCompletedAt,
								logicalRunId: narrators.logicalRunId,
								registrationText: sql<
									string | null
								>`cast(${narrators.runtimeRegistrationJson} as text)`,
								substatus: narrators.substatus,
								updatedAt: narrators.updatedAt,
							})
							.from(narrators)
							.where(eq(narrators.id, narratorId))
							.limit(1),
						{
							maxRows: 1,
						},
					)
				)[0] ?? null
			);
		},
		settleArchivedOrphanBackgroundClaim: async (claim, now) => {
			if (
				claim.type !== "subagent" ||
				claim.status !== "archived" ||
				claim.backgroundStatus !== "running" ||
				claim.logicalRunId !== null ||
				readRuntimeRegistrationColumn(
					claim.registrationText === null ? null : JSON.parse(claim.registrationText),
				)?.run ||
				parseSubstatus(claim.substatus).some(
					(tag) => tag === "taken_over" || tag.startsWith("terminal_run:"),
				)
			)
				return false;
			return runAtomicWrite(db, "publication.settleArchivedOrphanBackgroundClaim", (tx) => {
				// Terminal continuation rows can still own a result awaiting delivery.
				const unmounted = and(
					ne(narratorToolContinuations.state, "cancelled"),
					sql`coalesce(json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryPhase'), '') <> 'owner_continuation_started'`,
				);
				const settled = tx
					.update(narrators)
					.set({
						backgroundStatus: "cancelled",
						backgroundCompletedAt: claim.backgroundCompletedAt ?? now,
						updatedAt: now,
					})
					.where(
						and(
							eq(narrators.id, claim.id),
							eq(narrators.type, "subagent"),
							eq(narrators.status, "archived"),
							eq(narrators.backgroundStatus, "running"),
							isNull(narrators.logicalRunId),
							eq(narrators.updatedAt, claim.updatedAt),
							claim.parentNarratorId === null
								? isNull(narrators.parentNarratorId)
								: eq(narrators.parentNarratorId, claim.parentNarratorId),
							claim.backgroundCompletedAt === null
								? isNull(narrators.backgroundCompletedAt)
								: eq(narrators.backgroundCompletedAt, claim.backgroundCompletedAt),
							claim.substatus === null
								? isNull(narrators.substatus)
								: eq(narrators.substatus, claim.substatus),
							claim.registrationText === null
								? isNull(narrators.runtimeRegistrationJson)
								: sql`cast(${narrators.runtimeRegistrationJson} as text) = ${claim.registrationText}`,
							notExists(
								tx
									.select({ one: sql`1` })
									.from(backgroundTasks)
									.where(eq(backgroundTasks.id, claim.id))
									.limit(1),
							),
							notExists(
								tx
									.select({ one: sql`1` })
									.from(backgroundTasks)
									.where(
										and(
											eq(backgroundTasks.type, "agent"),
											eq(backgroundTasks.subagentNarratorId, claim.id),
										),
									)
									.limit(1),
							),
							notExists(
								tx
									.select({ one: sql`1` })
									.from(narratorToolContinuations)
									.where(and(eq(narratorToolContinuations.narratorId, claim.id), unmounted))
									.limit(1),
							),
							claim.parentNarratorId === null
								? undefined
								: notExists(
										tx
											.select({ one: sql`1` })
											.from(narratorToolContinuations)
											.where(
												and(
													eq(narratorToolContinuations.narratorId, claim.parentNarratorId),
													inArray(narratorToolContinuations.kind, [
														"foreground_agent",
														"background_agent",
													]),
													unmounted,
													sql`json_extract(${narratorToolContinuations.payloadJson}, '$.subagentId') = ${claim.id}`,
												),
											)
											.limit(1),
									),
						),
					)
					.returning({ id: narrators.id })
					.get();
				return settled !== undefined;
			});
		},
		readBackgroundTask: async (taskId) => {
			const row = await readQueryFirst(
				db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).limit(1),
				{ executionPolicy: "worker-required", maxRows: 1 },
			);
			return row ?? null;
		},
		readTaskDetail: async (taskId) => {
			const row = await readQueryFirst(
				db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).limit(1),
				{ executionPolicy: "worker-required", maxRows: 1 },
			);
			return (row as BackgroundTaskRecord) ?? null;
		},
		cancelTask: async (input) => {
			const task = runAtomicWrite(db, "publication.cancelTask", (tx) => {
				const existing = tx
					.select({
						backgroundKind: backgroundTasks.backgroundKind,
						id: backgroundTasks.id,
						type: backgroundTasks.type,
						status: backgroundTasks.status,
						parentNarratorId: backgroundTasks.parentNarratorId,
						toolUseId: backgroundTasks.toolUseId,
						alias: backgroundTasks.alias,
						title: backgroundTasks.title,
						logicalRunId: backgroundTasks.logicalRunId,
					})
					.from(backgroundTasks)
					.where(eq(backgroundTasks.id, input.taskId))
					.get();
				if (input.expectedRun) assertPublicationTaskIdentity(input.expectedRun, existing);
				if (!existing || (existing.status !== "running" && existing.status !== "paused"))
					return undefined;
				const setFields: Record<string, unknown> = {
					status: "cancelled",
					completedAt: input.now,
					updatedAt: input.now,
				};
				if (input.capturedOutput !== null) {
					setFields.output = input.capturedTruncated
						? input.capturedOutput.slice(0, input.capturedOutputBytes)
						: input.capturedOutput;
					setFields.outputBytes = input.capturedOutputBytes;
					setFields.outputTruncated = input.capturedTruncated;
				}
				const updated = tx
					.update(backgroundTasks)
					.set(setFields)
					.where(
						and(
							eq(backgroundTasks.id, input.taskId),
							or(eq(backgroundTasks.status, "running"), eq(backgroundTasks.status, "paused")),
						),
					)
					.returning({
						id: backgroundTasks.id,
						type: backgroundTasks.type,
						status: backgroundTasks.status,
						parentNarratorId: backgroundTasks.parentNarratorId,
						toolUseId: backgroundTasks.toolUseId,
						alias: backgroundTasks.alias,
						title: backgroundTasks.title,
						logicalRunId: backgroundTasks.logicalRunId,
						output: backgroundTasks.output,
					})
					.get();
				if (!updated) return undefined;
				if (updated.type === "transfer" && !updated.logicalRunId) {
					const run = legacy.newBashRun(updated.id, updated.parentNarratorId);
					legacy.reserve(run, tx);
					tx.update(backgroundTasks)
						.set({ logicalRunId: run.logicalRunId })
						.where(eq(backgroundTasks.id, updated.id))
						.run();
					updated.logicalRunId = run.logicalRunId;
				}
				if (updated.logicalRunId) {
					const run = taskPublicationRun(updated);
					const resultRef = legacy.persistResult(run, input.capturedOutput ?? "(cancelled)", tx);
					if (existing.type === "bash" && existing.backgroundKind === "service") {
						// Explicit service stop settles the durable result, not a new parent turn.
						// Consume atomically: suppress retries AND revoke undelivered mailbox notices.
						legacy.store.consumeAwaitedTerminal(run, tx);
						return updated;
					}
					legacy.commit(
						{
							...run,
							eventKind: "cancelled",
							resultRef,
							summary: `[System] Background ${existing.type} cancelled. Use TeamStatus({ action: "get_task", target_id: "${existing.alias ?? existing.id}" }) to read the stored result.`,
						},
						tx,
					);
				}
				return updated;
			});
			if (task) legacy.schedule();
			return task ?? null;
		},
		cancelAgentNarrator: async (input) => {
			runAtomicWrite(db, "publication.cancelAgentNarrator", (tx) => {
				if (input.expectedLogicalRunId !== undefined)
					assertRecoveryFields(
						{ logicalRunId: input.expectedLogicalRunId },
						tx
							.select({ logicalRunId: narrators.logicalRunId })
							.from(narrators)
							.where(eq(narrators.id, input.narratorId))
							.get(),
					);
				tx.update(narrators)
					.set({
						backgroundStatus: "cancelled",
						backgroundCompletedAt: input.now,
						updatedAt: input.now,
					})
					.where(eq(narrators.id, input.narratorId))
					.run();
			});
			backgroundOccupancyStore.refreshNarrator(input.narratorId);
		},
		markTakenOver: async (input) =>
			Promise.resolve(
				runAtomicWrite(db, "publication.markTakenOver", (tx) =>
					tx
						.update(backgroundTasks)
						.set({ status: "cancelled", completedAt: input.now, updatedAt: input.now })
						.where(and(eq(backgroundTasks.id, input.taskId), eq(backgroundTasks.status, "running")))
						.returning({ parentNarratorId: backgroundTasks.parentNarratorId })
						.get(),
				),
			),
		finalizeTakeover: async (input) => {
			const result = runAtomicWrite(db, "publication.finalizeTakeover", (tx) => {
				const outputBytes = Buffer.byteLength(input.output, "utf-8");
				const truncated = outputBytes > 512 * 1024;
				const storedOutput = truncated ? input.output.slice(0, 512 * 1024) : input.output;
				const terminalStatus = input.hasError ? "failed" : "completed";
				const updated = tx
					.update(backgroundTasks)
					.set({
						status: terminalStatus,
						output: storedOutput,
						outputBytes,
						outputTruncated: truncated,
						completedAt: input.now,
						updatedAt: input.now,
					})
					.where(and(eq(backgroundTasks.id, input.taskId), eq(backgroundTasks.status, "cancelled")))
					.returning({
						id: backgroundTasks.id,
						parentNarratorId: backgroundTasks.parentNarratorId,
						logicalRunId: backgroundTasks.logicalRunId,
						type: backgroundTasks.type,
						title: backgroundTasks.title,
						alias: backgroundTasks.alias,
					})
					.get();
				if (!updated) return null;
				if (updated.type !== "transfer") {
					const run = updated.logicalRunId
						? taskPublicationRun({ ...updated, logicalRunId: updated.logicalRunId })
						: legacy.getAgentRun(updated.id, updated.parentNarratorId, tx);
					legacy.commit(
						{
							...run,
							eventKind: terminalStatus === "completed" ? "completed" : "failed",
							resultRef: legacy.persistResult(run, input.output, tx),
							summary: `[System] Background agent "${updated.title ?? updated.alias ?? updated.id}" (ID: "${updated.alias ?? updated.id}") ${terminalStatus}.`,
						},
						tx,
					);
				}
				return { id: updated.id, parentNarratorId: updated.parentNarratorId };
			});
			if (result) legacy.schedule();
			return result;
		},
		readRunningStaleTasks: async () => {
			throw new Error(
				"readRunningStaleTasks is a PostgreSQL-only bounded read. " +
					"SQLite recovery reads are handled directly by background-task-service.",
			);
		},
		recoverStaleTask: async () => {
			throw new Error("recoverStaleTask is a PostgreSQL-only composite");
		},
		pauseStaleTransfer: async () => {
			throw new Error("pauseStaleTransfer is a PostgreSQL-only composite");
		},
		persistResult: async (run, text) =>
			runAtomicWrite(db, "publication.persistResult", (tx) => legacy.persistResult(run, text, tx)),
		commit: async (intent) =>
			runAtomicWrite(db, "publication.commit", (tx) => legacy.commit(intent, tx)),
		commitAgentTerminal: async (input) => {
			if (input.run.producerKind !== "agent")
				throw new Error("Agent terminal commit requires an agent run");
			if (input.startupFailure) return commitTerminal(input);
			if (input.delivery === "foreground")
				return runAtomicWrite(db, "publication.commitForegroundTerminal", (tx) => {
					const existing = tx
						.select({ id: narratorMessages.id })
						.from(narratorMessages)
						.where(eq(narratorMessages.id, `publication-result:${input.run.logicalRunId}`))
						.get();
					// Preserve the source_after boundary until the immutable snapshot exists.
					legacy.persistResult(input.run, input.text, tx, input.eventKind);
					legacy.store.consumeAwaitedTerminal(input.run, tx);
					return {
						status: existing ? "duplicate" : "committed",
						deliveryId: null,
						arrivalSeq: null,
					};
				});
			return commitTerminal(input);
		},
		commitBashTerminal: async (input) => {
			if (input.run.producerKind !== "bash")
				throw new Error("Bash terminal commit requires a bash run");
			return commitTerminal(input);
		},
		migrateLegacyTaskNotice: async (recipientId, entry) =>
			legacy.migrateLegacyTaskNotice(recipientId, entry),
		readAgentTerminalResult: async (run, options = {}, committedObservation) => {
			if (!committedObservation) return legacy.readAgentTerminalResult(run, options);
			const { signal } = committedObservation;
			signal?.throwIfAborted();
			const sqlite = db.$client;
			if (!sqlite.filename || sqlite.filename === ":memory:" || sqlite.inTransaction) {
				throw new WorkersUnavailableError("requires_committed_file");
			}
			return await runReadTask<AgentTerminalResult | null>(
				sqlite.filename,
				{ kind: "publicationTerminalResult", run, options, fromBlocks: blockReadsEnabled() },
				{
					signal,
					...(committedObservation.deadlineAt !== undefined
						? { deadlineAt: committedObservation.deadlineAt }
						: {}),
					timeoutMs: Math.min(committedObservation.timeoutMs ?? 5_000, 5_000),
				},
			);
		},
		readRunPublicationState: async (run, options) => legacy.readRunPublicationState(run, options),
		readRunPublicationStates: (runs, options) => legacy.readRunPublicationStates(runs, options),
		consumeAwaitedTerminal: async (run, options) => legacy.consumeAwaitedTerminal(run, options),
		hasPendingSource: async (run) => legacy.hasPendingSource(run),
		flushRecipient: async (recipientId) => legacy.flushRecipient(recipientId),
		flushPage: async () => legacy.flushPage(),
		schedule: (reset) => legacy.schedule(reset),
		stop: () => legacy.stop(),
		setWake: (handler) => legacy.setWake(handler),
		setLegacyRuntimeAdmissionReader: (kind, reader) =>
			legacy.setLegacyRuntimeAdmissionReader(kind, reader),
		setLegacyCompletionAdmissionReader: (reader) =>
			legacy.setLegacyCompletionAdmissionReader(reader),
	};
}

/**
 * The PostgreSQL branch: the named composites from `postgres-runtime-publication.ts`
 * plus the async publication worker. The worker keeps the SQLite loop's exact
 * economics — one bounded page per turn, per-kind per-recipient vacancy order,
 * the same backoff schedule and retry budget — with the flush serialized on an
 * in-flight guard (the SQLite loop cannot overlap because it is synchronous; the
 * PG loop needs the guard), and the wake notification stays a post-commit side
 * effect, fired only after the transfer section has committed. The wake handler
 * may be synchronous or asynchronous; delivery metadata is read through the
 * queue's named read (`mailbox.getByDelivery`), never a direct table probe.
 */
function createPgPublicationService(queue: RuntimeQueuePort): AsyncRuntimePublicationService {
	const engine = createPostgresRuntimePublication(
		requirePublicationTx(queue).handle,
		queue,
		pgPublicationRegistrations,
		{
			summarize: publicationSummary,
			snapshotBytes: PUBLICATION_FALLBACK_BYTES,
		},
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retry = 0;
	let stopped = false;
	let cursor: string | undefined;
	let flushing: Promise<void> | undefined;

	async function notifyTransfer(recipientId: string, deliveryId?: string) {
		const handler = pgPublicationRegistrations.wake;
		if (!handler || !deliveryId) return;
		const row = await queue.mailbox.getByDelivery(deliveryId);
		const event = row?.metadataJson
			? (JSON.parse(row.metadataJson) as { eventKind?: string }).eventKind
			: undefined;
		// Restart/cancel notices are observable on the next pass, not permission to spend a turn.
		if (event === "started" || event === "cancelled") return;
		try {
			void trackCommunicationWork(
				Promise.resolve(handler(recipientId)).catch((error) =>
					logger.warn("Publication wake deferred", { recipientId, error: String(error) }),
				),
			);
		} catch (error) {
			logger.warn("Publication wake deferred", { recipientId, error: String(error) });
		}
	}

	/** All fast and retry paths grant the next vacancy to the earliest durable intent. */
	async function flushRecipient(recipientId: string): Promise<number> {
		let transferred = 0;
		for (const kind of ["agent", "bash"] as const) {
			for (let i = 0; i < L.pageSize / 2; i++) {
				const result = await queue.outbox.transferNext(recipientId, kind);
				if (result.status !== "transferred") break;
				transferred++;
				await notifyTransfer(recipientId, result.deliveryId);
			}
		}
		return transferred;
	}

	/** One bounded page per turn. Full mailboxes release the worker immediately. */
	async function flushPage(): Promise<boolean> {
		const page = await queue.outbox.listPending({ afterId: cursor, limit: L.pageSize });
		const rows = page.slice(0, L.pageSize);
		// At most one transfer per listed row: a page never expands to pageSize² work.
		const full = new Set<string>();
		for (const row of rows) {
			const key = `${row.recipientId}:${row.producerKind}`;
			if (full.has(key)) continue;
			const result = await queue.outbox.transferNext(
				row.recipientId,
				row.producerKind as NoticeKind,
			);
			if (result.status === "transferred") await notifyTransfer(row.recipientId, result.deliveryId);
			else full.add(key);
		}
		cursor = page.length > L.pageSize ? rows.at(-1)?.id : undefined;
		return page.length > 0;
	}

	function runFlushTick(): void {
		if (flushing) return;
		let again = false;
		flushing = trackCommunicationWork(
			(async () => {
				try {
					if ((await flushPage()) && retry++ < L.claimMaxAttempts) again = true;
				} catch (error) {
					logger.warn("Runtime publication delivery deferred", { retry, error: String(error) });
					if (retry++ < L.claimMaxAttempts) again = true;
				}
			})(),
		);
		void flushing.finally(() => {
			flushing = undefined;
			if (again && !stopped) schedule(false);
		});
	}

	function schedule(reset = true) {
		if (stopped) return;
		if (reset) retry = 0;
		if (timer) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				runFlushTick();
			},
			retry ? Math.min(50 * 2 ** retry, 1000) : 0,
		);
		timer.unref();
	}

	return {
		backend: "postgres",
		startRun: async (input) => {
			const started = await engine.startRun(input);
			eventBus.emit({ type: "narrator:execution_principal_changed", narratorId: input.narratorId });
			return started;
		},
		getAgentRun: (narratorId, recipientId) => engine.getAgentRun(narratorId, recipientId),
		newBashRun: (taskId, recipientId) => ({
			producerKind: "bash",
			taskId,
			recipientId,
			logicalRunId: generateId(),
		}),
		startBashRun: (input) => engine.startBashRun(input),
		startTransferTask: async (input) =>
			(await engine.startTransferTask(input)) as BackgroundTaskRecord | undefined,
		releaseUnusedRunSlots: (run) => queue.outbox.releaseUnusedRunSlots(run),
		restartAgentTask: (input) => engine.restartAgentTask(input),
		updateNarratorBackground: async (input) => {
			await engine.updateNarratorBackground(input);
			backgroundOccupancyStore.refreshNarrator(input.narratorId);
		},
		commitTerminalTransition: (input) => engine.commitTerminalTransition(input),
		cleanupTasks: (input) => engine.cleanupTasks(input),
		readArchivedOrphanBackgroundClaim: (narratorId) =>
			engine.readArchivedOrphanBackgroundClaim(narratorId),
		settleArchivedOrphanBackgroundClaim: (claim, now) =>
			engine.settleArchivedOrphanBackgroundClaim(claim, now),
		readBackgroundTask: async (taskId) =>
			(await engine.readBackgroundTask(taskId)) as BackgroundTaskRecord | null,
		readTaskDetail: async (taskId) =>
			(await engine.readTaskDetail(taskId)) as BackgroundTaskRecord | null,
		cancelTask: (input) => engine.cancelTask(input),
		cancelAgentNarrator: async (input) => {
			await engine.cancelAgentNarrator(input);
			backgroundOccupancyStore.refreshNarrator(input.narratorId);
		},
		markTakenOver: (input) => engine.markTakenOver(input),
		finalizeTakeover: (input) => engine.finalizeTakeover(input),
		readRunningStaleTasks: (afterId) => engine.readRunningStaleTasks(afterId),
		recoverStaleTask: (input) => engine.recoverStaleTask(input),
		pauseStaleTransfer: (input) => engine.pauseStaleTransfer(input),
		persistResult: (run, text) => engine.persistResult(run, text),
		commit: (intent) => engine.commit(intent),
		commitAgentTerminal: (input) => engine.commitAgentTerminal(input),
		commitBashTerminal: (input) => engine.commitBashTerminal(input),
		migrateLegacyTaskNotice: async (recipientId, entry) => {
			const source: LegacyPublicationSource = {
				producerKind: entry.kind === "bg_agent" ? "agent" : "bash",
				taskId: entry.task.id,
				recipientId,
			};
			const result =
				entry.kind === "bg_agent"
					? (entry.task.result ?? entry.task.resultPreview ?? "")
					: (entry.task.outputPreview ?? "");
			const admission = pgPublicationRegistrations.completionReader?.(source);
			const status = await engine.migrateLegacyTaskNotice({
				recipientId,
				source,
				admission,
				resultText: result,
				summary: admission
					? `[System] Background ${source.producerKind} "${entry.task.title ?? entry.task.alias ?? source.taskId}" (ID: ${entry.task.alias ?? source.taskId}) ${admission.eventKind}. Use ${source.producerKind === "agent" ? `Watch({ type: "agent", id: "${entry.task.alias ?? source.taskId}" })` : `TeamStatus({ action: "get_task", target_id: "${entry.task.alias ?? source.taskId}" })`} to inspect the stored result.`
					: "",
			});
			// The publisher schedules bounded retries after the durable intent commits.
			schedule();
			return status;
		},
		readAgentTerminalResult: (run, options) => engine.readAgentTerminalResult(run, options),
		readRunPublicationState: (run) => engine.readRunPublicationState(run),
		readRunPublicationStates: async (runs) => {
			if (runs.length > 1_000) throw new Error("Too many publication state identities");
			const states: RunPublicationStatus[] = [];
			for (let start = 0; start < runs.length; start += 100)
				states.push(
					...(await Promise.all(
						runs.slice(start, start + 100).map((run) => engine.readRunPublicationState(run)),
					)),
				);
			return states;
		},
		consumeAwaitedTerminal: (run, options) => queue.outbox.consumeAwaitedTerminal(run, options),
		hasPendingSource: (run) => engine.hasPendingSource(run),
		flushRecipient,
		flushPage,
		schedule,
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
		setWake: (handler) => {
			pgPublicationRegistrations.wake = handler;
		},
		setLegacyRuntimeAdmissionReader: (kind, reader) => {
			pgPublicationRegistrations.legacyReaders.set(kind, reader);
		},
		setLegacyCompletionAdmissionReader: (reader) => {
			pgPublicationRegistrations.completionReader = reader;
		},
	};
}

/**
 * Which backend the publication facade serves RIGHT NOW: the bound queue port wins
 * (composition root / test harness); otherwise the master switch that installed the
 * fail-closed SQLite proxies decides, so this branch can never disagree with the
 * proxy decision. An explicit selector env without a binding throws from the
 * selector itself — that misconfiguration is a wiring bug, not a fallback.
 */
function publicationBackend(): "sqlite" | "postgres" {
	if (resolveRuntimeQueueBackend() === "postgres") return "postgres";
	return resolveDatabaseBackendConfig().backend === "postgres" ? "postgres" : "sqlite";
}

let asyncPublicationService:
	| {
			backend: "sqlite" | "postgres";
			queue: RuntimeQueuePort | undefined;
			service: AsyncRuntimePublicationService;
	  }
	| undefined;

/**
 * The bound async publication facade. Selected per call from the runtime-queue-port
 * binding and cached on the (backend, queue) identity; a rebound queue replaces the
 * worker (the old one is stopped). PostgreSQL with no bound queue throws from
 * `requireRuntimeQueuePort` — never a SQLite fallback.
 */
export function getRuntimePublicationService(): AsyncRuntimePublicationService {
	const backend = publicationBackend();
	const queue = backend === "postgres" ? requireRuntimeQueuePort() : undefined;
	if (
		asyncPublicationService &&
		asyncPublicationService.backend === backend &&
		asyncPublicationService.queue === queue
	)
		return asyncPublicationService.service;
	asyncPublicationService?.service.stop();
	const service =
		backend === "postgres"
			? createPgPublicationService(queue as RuntimeQueuePort)
			: createSqliteAsyncPublicationService(runtimePublication);
	asyncPublicationService = { backend, queue, service };
	const priorStop = workerLifecycle.stop;
	workerLifecycle.stop = () => {
		priorStop?.();
		service.stop();
	};
	return service;
}

// The import-time backend decision uses the SAME pure resolver
// (`resolveDatabaseBackendConfig`, imported from db/postgres-runtime — NOT from the
// db index, whose exports are substituted by test mocks) that db/index.ts used to
// install the fail-closed SQLite proxies, with one addition: a queue bound BEFORE
// this module was imported (test harnesses) also selects the PostgreSQL facade.
// On SQLite the service is constructed at module scope exactly as before (the
// legacy rowid boundary keeps its import-time capture semantics); on PostgreSQL
// the fail-closed facade above takes over and no proxy is touched.
export const runtimePublication: RuntimePublicationService = (() => {
	if (resolveDatabaseBackendConfig().backend === "postgres")
		return createUnwiredPublicationFacade(pgPublicationRegistrations);
	try {
		if (resolveRuntimeQueueBackend() === "postgres")
			return createUnwiredPublicationFacade(pgPublicationRegistrations);
	} catch {
		// A selector-env/backend mismatch is a startup error reported by the startup
		// path; module construction must not crash before that report exists.
	}
	return createRuntimePublicationService(db);
})();
workerLifecycle.stop = () => runtimePublication.stop();

/** Stop existing producers without opening or instantiating a database backend. */
export function stopRuntimePublications(): void {
	runtimePublication.stop();
	asyncPublicationService?.service.stop();
}
export async function flushRuntimePublications(recipientId?: string): Promise<void> {
	const service = getRuntimePublicationService();
	if (recipientId) await service.flushRecipient(recipientId);
	service.schedule();
}
export function setLegacyCompletionAdmissionReader(
	reader: (source: LegacyPublicationSource) => LegacyCompletionAdmission | undefined,
) {
	runtimePublication.setLegacyCompletionAdmissionReader(reader);
}
export async function migrateLegacyTaskNotice(
	recipientId: string,
	entry: LegacyTaskNotice,
): Promise<"migrated" | "diagnostic"> {
	return getRuntimePublicationService().migrateLegacyTaskNotice(recipientId, entry);
}
export function setRuntimePublicationWake(handler: (recipientId: string) => void | Promise<void>) {
	runtimePublication.setWake(handler);
}

export function taskPublicationRun(task: {
	id: string;
	type: string;
	parentNarratorId: string;
	logicalRunId: string | null;
}): PublicationRun {
	if (!task.logicalRunId) throw new ValidationError("Task has no registered publication run");
	return {
		producerKind: task.type === "transfer" ? "bash" : (task.type as NoticeKind),
		taskId: task.id,
		recipientId: task.parentNarratorId,
		logicalRunId: task.logicalRunId,
	};
}

// Re-export composite input/output types for callers that import from this module.
export type {
	PgCancelAgentNarratorInput,
	PgCancelTaskInput,
	PgCancelTaskResult,
	PgCleanupInput,
	PgCleanupTaskResult,
	PgFinalizeTakeoverInput,
	PgPauseStaleTransferInput,
	PgRecoverStaleTaskInput,
	PgRestartAgentTaskInput,
	PgStaleTaskRow,
	PgTakeoverInput,
	PgTerminalTransitionInput,
	PgUpdateNarratorBackgroundInput,
} from "./postgres-runtime-publication";

// Re-export domain types for callers that import from this module.
export type { PublicationEvent, PublicationRun, RunPublicationStatus } from "./publication-outbox";
