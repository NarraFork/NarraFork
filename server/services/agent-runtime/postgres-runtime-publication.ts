/**
 * agent-runtime/postgres-runtime-publication.ts — the PostgreSQL publication
 * COMPOSITE operations (phase-4 production wiring).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The genuinely-async sibling of `publication.ts`'s SQLite composite transactions.
 * The SQLite publication service composes its atomic writes inside one synchronous
 * `runAtomicWrite` per operation; on PostgreSQL each of those same operations is a
 * NAMED composite here, executed as ONE `withPgRetry` whole-section transaction:
 *
 *   - `startAgentRun`      — logical run + slot reservation + `source_after` result
 *                            boundary + `background_tasks.logical_run_id` link.
 *   - `startBashRun`       — new Bash run identity + slot reservation.
 *   - `persistResult`      — the per-run result snapshot message + ref (agent kind).
 *   - `commit`             — a single publication intent.
 *   - `commitAgentTerminal` / `commitBashTerminal`
 *                          — result snapshot + terminal intent, atomically.
 *   - `migrateLegacyTaskNotice`
 *                          — legacy completion registration + result snapshot +
 *                            terminal intent (or the unmigratable diagnostic).
 *   - `hasPendingSource`   — the two bounded pending-probes, as reads.
 *
 * THE PRIMITIVES COME FROM THE QUEUE ADAPTER
 * ------------------------------------------
 * The transaction-local section functions (`persistLogicalRun`, `reserveRunSlots`,
 * `commitIntent`, the three legacy registrations) live in
 * `postgres-runtime-queue.ts` — the verified, frozen authority for outbox/legacy
 * semantics. This module consumes them through the store's `publicationTx`
 * namespace (same functions, caller-owned transaction) and never re-implements
 * their guards. A store that predates the namespace fails the feature check with
 * a precise error — there is no re-implementation fallback.
 *
 * REPLAY AND IDEMPOTENCY
 * ----------------------
 *   - `withPgRetry` wraps BEGIN..COMMIT of every composite; 40001/40P01/55P03
 *     replay the WHOLE composite, never a statement.
 *   - The deterministic result-snapshot message id (`publication-result:<run>`)
 *     makes caller-driven retries safe: a composite that already committed is
 *     detected by the in-section pre-check (after the narrator row lock, so a
 *     concurrent winner's commit is visible), the message work is skipped, and
 *     `commitIntent`'s own duplicate verdict supplies the result.
 *   - `LegacySourceChangedError` (the legacy-registration optimistic-guard loss)
 *     is recognized BY NAME and replays the whole composite, bounded — the same
 *     retry shape the queue's `runLegacySection` gives the standalone operations.
 *   - Side effects (wake, scheduling) belong to the CALLER after resolve; the
 *     composites themselves perform none.
 */
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	like,
	ne,
	notExists,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { withPgRetry } from "../../db/pg-retry";
import {
	backgroundTasks,
	narratorBufferedMessages as mailbox,
	narratorMessages as messages,
	narrators,
	runtimePublicationOutbox as outbox,
	narratorMessageRefs as refs,
} from "../../db/postgres-schema";
import { ValidationError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import type { RefMessageInput } from "../narrator-refs/port";
import {
	lockPgNarratorRefs,
	type PgPersistedMessageRef,
	persistPgMessageWithRef,
} from "../narrator-refs/postgres-store";
import { MAILBOX_LIMITS as L } from "./limits";
import {
	type LegacyCompletionAdmission,
	type LegacyCompletionRegistration,
	type LegacyPublicationProof,
	type LegacyPublicationSource,
	type LegacyRuntimeAdmission,
	type PublicationEvent,
	type PublicationIntent,
	type PublicationRun,
	publicationDedupeKey,
} from "./publication-outbox";
import type { PgRuntimeTx, RuntimeQueuePort } from "./runtime-queue-port";
import { translateWriteError } from "./runtime-write";

/** Max output bytes stored in background_tasks.output (must match background-task-service). */
const MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * Truncate a string so its UTF-8 byte length does not exceed maxBytes.
 * Uses TextEncoder for accurate measurement; incomplete sequences are dropped.
 */
function truncateToBytes(str: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(str);
	if (encoded.byteLength <= maxBytes) return str;
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	return decoder.decode(encoded.slice(0, maxBytes));
}

/** Local alias for the background_tasks select type (avoids circular import). */
type BackgroundTaskRecord = typeof backgroundTasks.$inferSelect;

/** The commit verdict, shared with the outbox's commitIntent. */
export type PgPublicationCommitResult = {
	status: "duplicate" | "committed";
	deliveryId: string | null;
	arrivalSeq: number | null;
};

/**
 * The producer registrations the facade collects at module scope and this engine
 * reads LIVE at call time (a reader registered after engine construction must not
 * be lost — producers register from module scope before any composite runs).
 */
export interface PgPublicationRegistrations {
	wake?: (recipientId: string) => void | Promise<void>;
	legacyReaders: Map<
		string,
		(source: LegacyPublicationSource) => LegacyRuntimeAdmission | undefined
	>;
	completionReader?: (source: LegacyPublicationSource) => LegacyCompletionAdmission | undefined;
}

/**
 * The transaction-local primitives the queue store exposes for composite
 * composition (`publicationTx` on the store), surfaced by {@link requirePublicationTx}.
 */
export interface PgPublicationTxPrimitives {
	/** The store's own handle — composites open their sections on it. */
	readonly handle: BunSQLDatabase;
	readonly persistLogicalRun: (
		tx: PgRuntimeTx,
		narratorId: string,
		options?: { resumeRunId?: string },
	) => Promise<string>;
	readonly reserveRunSlots: (
		tx: PgRuntimeTx,
		run: PublicationRun,
		options?: { started?: boolean },
	) => Promise<{ status: "reserved"; logicalRunId: string } | { status: "full" }>;
	readonly commitIntent: (
		tx: PgRuntimeTx,
		intent: PublicationIntent,
	) => Promise<PgPublicationCommitResult>;
	readonly registerLegacyRunningRunSlots: (
		tx: PgRuntimeTx,
		source: LegacyPublicationSource,
		proof: LegacyPublicationProof,
		slotOptions?: { started?: boolean },
		readers?: {
			readLegacyRuntimeAdmission?: (
				source: LegacyPublicationSource,
			) => LegacyRuntimeAdmission | undefined;
		},
	) => Promise<PublicationRun>;
	readonly registerLegacyUnknownBashFailure: (
		tx: PgRuntimeTx,
		source: LegacyPublicationSource,
	) => Promise<PublicationRun>;
	readonly registerLegacyCompletedRunSlots: (
		tx: PgRuntimeTx,
		source: LegacyPublicationSource,
		admission: Readonly<LegacyCompletionAdmission> | undefined,
	) => Promise<LegacyCompletionRegistration>;
	/** Post-commit evidence freeze for a completed registration; never inside a section. */
	readonly freezeLegacyCompletionEvidence: (admission: Readonly<LegacyCompletionAdmission>) => void;
}

/** The queue's optimistic-legacy-registration loss, recognized by name (no import). */
function isLegacySourceChangedError(error: unknown): boolean {
	return error instanceof Error && error.name === "LegacySourceChangedError";
}

/**
 * The publicationTx feature check: a bound queue predating the composite wiring
 * fails closed here — precisely, and never by re-implementing the primitives.
 */
export function requirePublicationTx(queue: RuntimeQueuePort): PgPublicationTxPrimitives {
	const primitives = (queue as { publicationTx?: PgPublicationTxPrimitives }).publicationTx;
	if (!primitives)
		throw new Error(
			"PostgreSQL runtime queue does not expose the publicationTx primitives: the bound " +
				"queue build predates the publication composite wiring. There is no " +
				"re-implementation fallback — upgrade the queue adapter.",
		);
	return primitives;
}

/** Mirror of narrator-refs/seq-store.ts `NARRATOR_REF_SEQ_EMPTY_TOP` (-1), kept local so this PG module never imports the SQLite seq store. */
const PG_REF_SEQ_EMPTY_TOP = -1;

/** Read-only watermark, never an allocation authority — the PG mirror of readTopRefSeq. */
async function readTopRefSeqPg(tx: PgRuntimeTx, narratorId: string): Promise<number | null> {
	const rows = await tx
		.select({ seq: refs.seq })
		.from(refs)
		.where(eq(refs.narratorId, narratorId))
		.orderBy(desc(refs.seq))
		.limit(1);
	return rows[0]?.seq ?? null;
}

/** Serialize composite migrations sharing one captured completion token. */
const completionMigrationLocks = new WeakMap<object, Promise<void>>();

export interface PgTerminalCommitInput {
	readonly run: PublicationRun;
	readonly eventKind: Exclude<PublicationEvent, "started">;
	/** The producer's result text; the agent kind snapshots it into a message/ref. */
	readonly text: string;
	readonly summary: string;
}

export interface PgLegacyTaskNoticeInput {
	readonly recipientId: string;
	readonly source: LegacyPublicationSource;
	/** The captured admission from the facade registry; undefined when none exists. */
	readonly admission: Readonly<LegacyCompletionAdmission> | undefined;
	/** The entry-derived result text (result ?? resultPreview ?? outputPreview). */
	readonly resultText: string;
	/** The facade-built `[System] Background …` summary line. */
	readonly summary: string;
}

/**
 * Restart an existing agent background task: the CAS update, logical run link
 * and the task-row projection fields are committed in ONE section.
 */
export interface PgRestartAgentTaskInput {
	readonly taskId: string;
	readonly logicalRunId: string;
	readonly subagentNarratorId: string;
	readonly subagentType: string;
	readonly toolUseId?: string;
	readonly alias?: string;
	readonly title?: string;
	/** The expected current status (CAS guard: WHERE status = expectedStatus). */
	readonly expectedStatus: string;
	readonly now: string;
}

/**
 * Update a narrator's background status + publication terminal commit, atomically.
 * Used by `finalizeBackgroundCompletion` and `finalizeTakenOverBackgroundSubagentUnlocked`.
 */
export interface PgUpdateNarratorBackgroundInput {
	readonly narratorId: string;
	readonly parentNarratorId: string;
	readonly backgroundStatus: "completed" | "failed";
	readonly backgroundResult: string;
	readonly backgroundCompletedAt: string;
	readonly updatedAt: string;
	readonly isBackground?: boolean;
	/** When true, skip publication commit (caller will handle it). */
	readonly deferPublication?: boolean;
}

/**
 * Terminal transition for a background task: the CAS update + publication
 * commit in ONE section, eliminating the two-phase read-update gap.
 */
export interface PgTerminalTransitionInput {
	readonly taskId: string;
	readonly setFields: Record<string, unknown>;
	readonly fullOutput: string;
	readonly summary: string;
	readonly eventKind: Exclude<PublicationEvent, "started">;
	readonly deferPublication?: boolean;
}

/**
 * Cleanup result: the minimal fields needed for caller-side runtime cleanup and
 * broadcast. Full task rows are never returned from the composite to avoid
 * unbounded memory; the caller-side SQLite `cleanupRuntime` needs only the id.
 */
export interface PgCleanupTaskResult {
	readonly id: string;
	readonly parentNarratorId: string;
	readonly type: string;
}

/**
 * Cleanup input: all filter parameters are caller-owned.
 */
export interface PgCleanupInput {
	readonly cutoff: string;
	readonly limit: number;
	readonly excludedStatuses: readonly string[];
	readonly excludedNarratorStatuses: readonly string[];
	readonly subagentPath: string;
}

/**
 * Input for the cancelTask composite: the caller captures in-memory state
 * (output buffer, timestamps) BEFORE entering the composite, so the composite
 * is a pure DB operation with no in-memory reads.
 */
export interface PgCancelTaskInput {
	readonly taskId: string;
	readonly capturedOutput: string | null;
	readonly capturedOutputBytes: number;
	readonly capturedTruncated: boolean;
	readonly now: string;
}

/**
 * Result of the cancelTask composite. Null when the CAS rejects
 * (task is not cancellable or does not exist).
 */
export interface PgCancelTaskResult {
	readonly id: string;
	readonly type: string;
	readonly status: string;
	readonly parentNarratorId: string;
	readonly toolUseId: string | null;
	readonly alias: string | null;
	readonly title: string | null;
	readonly logicalRunId: string | null;
	readonly output: string | null;
}

/**
 * Input for the markTakenOver composite: CAS status → "cancelled" for takeover
 * (no publication events — takeover is not a user-requested cancellation).
 */
export interface PgTakeoverInput {
	readonly taskId: string;
	readonly now: string;
}

/**
 * Cancel the narrator projection paired with an agent background task. The PG
 * composite also moves the narrator to idle/interrupted so the background-task
 * service never falls through to the SQLite-only narrator persistence facade.
 */
export interface PgCancelAgentNarratorInput {
	readonly narratorId: string;
	readonly now: string;
}

/**
 * Input for the finalizeTakeover composite: CAS status from "cancelled" →
 * terminal (completed/failed) with output, plus optional publication intent.
 */
export interface PgFinalizeTakeoverInput {
	readonly taskId: string;
	readonly hasError: boolean;
	readonly output: string;
	readonly now: string;
}

/** A single row returned by readRunningStaleTasks (bounded page). */
export interface PgStaleTaskRow {
	readonly id: string;
	readonly type: string;
	readonly parentNarratorId: string;
	readonly subagentNarratorId: string | null;
	readonly logicalRunId: string | null;
	readonly toolCallId: string | null;
	readonly executionAttempt: number | null;
}

export interface PgRecoverStaleTaskInput {
	readonly taskId: string;
	readonly text: string;
	readonly eventKind: "failed" | "cancelled";
	readonly now: string;
}

export interface PgPauseStaleTransferInput {
	readonly taskId: string;
	readonly now: string;
	readonly notice: string;
}

/**
 * Build the PostgreSQL publication composites over the bound queue store.
 *
 * `db` is the queue store's own handle (the composite's `withPgRetry` sections
 * open on it — a parameter, so the transaction-atomicity gate recognizes the
 * PostgreSQL receiver) and MUST be `requirePublicationTx(queue).handle`; the
 * identity check fails closed on a mismatched pair. `summarize`/`snapshotBytes`
 * are the facade's text bounders, injected so this module never imports the
 * SQLite publication module.
 */
export function createPostgresRuntimePublication(
	db: BunSQLDatabase,
	queue: RuntimeQueuePort,
	registrations: PgPublicationRegistrations,
	options: { summarize: (text: string) => string; snapshotBytes: number },
) {
	const primitives = requirePublicationTx(queue);
	if (primitives.handle !== db)
		throw new Error("Publication composite handle must be the queue store's own handle");
	const summarize = options.summarize;
	const snapshotBytes = options.snapshotBytes;

	/**
	 * The boundary every composite crosses: whole-section retry, THEN conflict
	 * translation (same order as the queue's own runSection). The bounded
	 * LegacySourceChangedError replay mirrors `runLegacySection`: the guard losing
	 * an optimistic race is not a SQLSTATE, so the retry lives here, at the whole
	 * composite, and only composites that register legacy sources enable it.
	 */
	async function runComposite<T>(
		label: string,
		section: (tx: PgRuntimeTx) => Promise<T>,
		compositeOptions: { legacyReplay?: boolean } = {},
	): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await withPgRetry(() => db.transaction((tx) => section(tx)), { label });
			} catch (error) {
				if (compositeOptions.legacyReplay && attempt < 2 && isLegacySourceChangedError(error))
					continue;
				throw translateWriteError(error, label);
			}
		}
	}

	const capacityError = () =>
		new ValidationError(
			"Task publication capacity is full; finish existing tasks before starting more.",
		);

	/**
	 * The per-run result snapshot (SQLite `persistResult`), PG form. Bash keeps its
	 * pointer-only shape (its durable task row holds the output); agent snapshots the
	 * bounded preview into a `disp` message + ref through the refs domain's named
	 * helper, in the caller's transaction.
	 *
	 * Idempotent under caller-driven replay: the snapshot's message id is
	 * deterministic per run, so the post-lock pre-check skips the insert when a
	 * previous composite already committed it, exactly mirroring the SQLite
	 * `onConflictDoNothing` + conditional-ref shape.
	 */
	async function persistResultSection(
		tx: PgRuntimeTx,
		run: PublicationRun,
		text: string,
	): Promise<string> {
		// Bash has one durable task per actual attempt; its output is already normalized
		// to the existing 512 KiB budget. Never copy raw stdout into a message row.
		if (run.producerKind === "bash") return `background_task:${run.taskId}:${run.logicalRunId}`;
		const messageId = `publication-result:${run.logicalRunId}`;
		const narratorId = run.producerKind === "agent" ? run.taskId : run.recipientId;
		// Lock before the existence pre-check: a concurrent same-run composite commits
		// while we hold the lock, and the re-read then sees its committed snapshot.
		await lockPgNarratorRefs(tx, [narratorId]);
		const existing = await tx
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.id, messageId))
			.limit(1);
		if (existing[0]) return `message-original:${messageId}`;
		const source = await tx
			.select({ resultRef: outbox.resultRef })
			.from(outbox)
			.where(eq(outbox.dedupeKey, publicationDedupeKey(run, "terminal")))
			.limit(1);
		const boundary = source[0]?.resultRef?.startsWith("source_after:")
			? Number(source[0].resultRef.slice(13))
			: undefined;
		const assistant =
			boundary !== undefined && Number.isSafeInteger(boundary)
				? (
						await tx
							.select({ id: messages.id, role: messages.role })
							.from(refs)
							.innerJoin(messages, eq(messages.id, refs.messageId))
							.where(and(eq(refs.narratorId, run.taskId), gt(refs.seq, boundary)))
							.orderBy(desc(refs.seq))
							.limit(L.pageSize)
					).find((row) => row.role === "assistant")
				: undefined;
		// Capture only the already-supported idle display projection. The complete result
		// remains in its existing source; later semantic edits must not change this receipt.
		const originalBytes = Buffer.byteLength(text);
		const preview = text.slice(0, 12_001);
		const storedText = new TextDecoder().decode(Buffer.from(preview).subarray(0, snapshotBytes), {
			stream: true,
		});
		const truncated = originalBytes > Buffer.byteLength(storedText);
		const message: RefMessageInput = {
			id: messageId,
			narratorId,
			role: "disp",
			origin: "system",
			contentText: storedText,
			contentJson: [
				{
					type: "text",
					text: storedText,
					publicationResult: {
						logicalRunId: run.logicalRunId,
						truncated,
						originalBytes,
						sourceResultRef: assistant
							? `message:${assistant.id}`
							: `background_task:${run.taskId}:${run.logicalRunId}`,
					},
				},
			],
			createdAt: new Date().toISOString(),
		};
		const persisted: PgPersistedMessageRef = await persistPgMessageWithRef(tx, message);
		if (!persisted.messageId) throw new Error("Result snapshot persisted without a message id");
		return `message-original:${messageId}`;
	}

	return {
		/**
		 * Agent start admission: logical run, slot reservation, the `source_after`
		 * result boundary and the task-row link commit in ONE section.
		 *
		 * When `taskRow` is supplied, the `background_tasks` INSERT (new task
		 * projection) is included in the same section — the same atomicity the
		 * SQLite producer has (reserve + task row in one transaction). The
		 * (tool_call_id, execution_attempt) unique index guards against a second
		 * process for the same actual attempt.
		 */
		async startAgentRun(input: {
			narratorId: string;
			parentNarratorId: string;
			resumeRunId?: string;
			started?: boolean;
			taskRow?: Omit<typeof backgroundTasks.$inferInsert, "logicalRunId">;
		}): Promise<PublicationRun> {
			return runComposite("publication.startAgentRun", async (tx) => {
				const logicalRunId = await primitives.persistLogicalRun(tx, input.narratorId, {
					...(input.resumeRunId === undefined ? {} : { resumeRunId: input.resumeRunId }),
				});
				const run: PublicationRun = {
					producerKind: "agent",
					taskId: input.narratorId,
					logicalRunId,
					recipientId: input.parentNarratorId,
				};
				const reservation = await primitives.reserveRunSlots(tx, run, {
					started: input.started,
				});
				if (reservation.status === "full") throw capacityError();
				if (!input.resumeRunId) {
					// A stable ref boundary, not millisecond timestamps: two runs may start in
					// the same ms. An empty narrator's watermark is the EMPTY_TOP sentinel
					// (= base 0 minus one), NOT 0 — the first ref of an empty narrator claims
					// seq 0, and `source_after:0` would exclude it from the run's result.
					await tx
						.update(outbox)
						.set({
							resultRef: `source_after:${(await readTopRefSeqPg(tx, input.narratorId)) ?? PG_REF_SEQ_EMPTY_TOP}`,
						})
						.where(
							and(
								eq(outbox.dedupeKey, publicationDedupeKey(run, "terminal")),
								eq(outbox.state, "reserved"),
							),
						);
				}
				if (input.taskRow) {
					const inserted = await tx
						.insert(backgroundTasks)
						.values({ ...input.taskRow, logicalRunId })
						.onConflictDoNothing({
							target: [backgroundTasks.toolCallId, backgroundTasks.executionAttempt],
						})
						.returning({ id: backgroundTasks.id });
					if (!inserted[0])
						throw new ValidationError(
							"Background agent task already exists for this execution attempt",
						);
				}
				await tx
					.update(backgroundTasks)
					.set({ logicalRunId })
					.where(eq(backgroundTasks.id, input.narratorId));
				return run;
			});
		},

		/**
		 * Read the registered agent run; an unregistered pre-protocol source takes the
		 * legacy running admission as its OWN section (the same split the SQLite
		 * `getAgentRun` has when called without a transaction).
		 */
		async getAgentRun(narratorId: string, recipientId: string): Promise<PublicationRun> {
			const rows = await db
				.select({ logicalRunId: narrators.logicalRunId })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.limit(1);
			const row = rows[0];
			if (!row) throw new ValidationError("Agent has no registered publication source");
			if (row.logicalRunId)
				return {
					producerKind: "agent",
					taskId: narratorId,
					recipientId,
					logicalRunId: row.logicalRunId,
				};
			return runComposite(
				"publication.getAgentRun.legacyRegister",
				(tx) =>
					primitives.registerLegacyRunningRunSlots(
						tx,
						{ producerKind: "agent", taskId: narratorId, recipientId },
						{ kind: "runtime" },
						{},
						{
							readLegacyRuntimeAdmission: (source) =>
								registrations.legacyReaders.get(source.producerKind)?.(source),
						},
					),
				{ legacyReplay: true },
			);
		},

		/**
		 * Bash start admission: new run identity + slot reservation in ONE section.
		 * When the caller supplies the durable task row, it is inserted in the SAME
		 * section with the composite-assigned `logicalRunId` — the same atomicity the
		 * SQLite producer has (reserve + task row in one transaction). The
		 * (tool_call_id, execution_attempt) unique index is the fail-closed authority
		 * against a second process for the same actual attempt.
		 */
		async startBashRun(input: {
			taskId: string;
			recipientId: string;
			started?: boolean;
			/** The durable task row sans logical_run_id; inserted in the same section. */
			taskRow?: Omit<typeof backgroundTasks.$inferInsert, "logicalRunId">;
		}): Promise<PublicationRun> {
			return runComposite("publication.startBashRun", async (tx) => {
				const run: PublicationRun = {
					producerKind: "bash",
					taskId: input.taskId,
					recipientId: input.recipientId,
					logicalRunId: generateId(),
				};
				const reservation = await primitives.reserveRunSlots(tx, run, {
					started: input.started,
				});
				if (reservation.status === "full") throw capacityError();
				if (input.taskRow) {
					const inserted = await tx
						.insert(backgroundTasks)
						.values({ ...input.taskRow, logicalRunId: run.logicalRunId })
						.onConflictDoNothing({
							target: [backgroundTasks.toolCallId, backgroundTasks.executionAttempt],
						})
						.returning({ id: backgroundTasks.id });
					// Returning an existing task would still let the caller spawn a second
					// process. The unique actual-attempt constraint must instead fail closed.
					if (!inserted[0])
						throw new ValidationError(
							"Background Bash task already exists for this execution attempt",
						);
				}
				return run;
			});
		},

		/** The result snapshot as its own section (the composite terminals embed it). */
		async persistResult(run: PublicationRun, text: string): Promise<string> {
			if (run.producerKind === "bash") return `background_task:${run.taskId}:${run.logicalRunId}`;
			return runComposite("publication.persistResult", (tx) => persistResultSection(tx, run, text));
		},

		/** A single intent commit (started events and caller-supplied resultRefs). */
		async commit(intent: PublicationIntent): Promise<PgPublicationCommitResult> {
			return runComposite("publication.commit", (tx) =>
				primitives.commitIntent(tx, { ...intent, summary: summarize(intent.summary) }),
			);
		},

		/** Agent terminal: result snapshot + terminal intent, atomically. */
		async commitAgentTerminal(input: PgTerminalCommitInput): Promise<PgPublicationCommitResult> {
			if (input.run.producerKind !== "agent")
				throw new Error("Agent terminal commit requires an agent run");
			return runComposite("publication.commitAgentTerminal", async (tx) => {
				const resultRef = await persistResultSection(tx, input.run, input.text);
				return primitives.commitIntent(tx, {
					...input.run,
					eventKind: input.eventKind,
					resultRef,
					summary: summarize(input.summary),
				});
			});
		},

		/** Bash terminal: the pointer resultRef + terminal intent, atomically. */
		async commitBashTerminal(input: PgTerminalCommitInput): Promise<PgPublicationCommitResult> {
			if (input.run.producerKind !== "bash")
				throw new Error("Bash terminal commit requires a bash run");
			return runComposite("publication.commitBashTerminal", async (tx) => {
				const resultRef = await persistResultSection(tx, input.run, input.text);
				return primitives.commitIntent(tx, {
					...input.run,
					eventKind: input.eventKind,
					resultRef,
					summary: summarize(input.summary),
				});
			});
		},

		/**
		 * Legacy completion migration: registration, result snapshot and the terminal
		 * intent commit in ONE section; the unmigratable path writes its diagnostic
		 * message in the same section. The captured-token freeze happens after the
		 * composite commits (evidence freeze is a post-commit effect), and concurrent
		 * migrations sharing one token serialize on the module-level per-token lock.
		 */
		async migrateLegacyTaskNotice(
			input: PgLegacyTaskNoticeInput,
		): Promise<"migrated" | "diagnostic"> {
			const token = input.admission?.token;
			let release = () => {};
			let tail: Promise<void> | undefined;
			if (token) {
				const previous = completionMigrationLocks.get(token) ?? Promise.resolve();
				tail = new Promise<void>((resolve) => {
					release = resolve;
				});
				completionMigrationLocks.set(token, tail);
				await previous;
			}
			try {
				const status = await runComposite(
					"publication.migrateLegacyTaskNotice",
					async (tx) => {
						const registration = await primitives.registerLegacyCompletedRunSlots(
							tx,
							input.source,
							input.admission,
						);
						if (registration.status === "unmigratable") {
							const recipient = await tx
								.select({ id: narrators.id })
								.from(narrators)
								.where(eq(narrators.id, input.recipientId))
								.limit(1);
							if (!recipient[0]) {
								logger.warn("Legacy publication recipient permanently deleted", {
									recipientId: input.recipientId,
									taskId: input.source.taskId,
									reason: registration.reason,
								});
								return "diagnostic" as const;
							}
							const messageId = `legacy-publication-diagnostic:${input.recipientId}:${input.source.producerKind}:${input.source.taskId}`;
							const existing = await tx
								.select({ id: messages.id })
								.from(messages)
								.where(eq(messages.id, messageId))
								.limit(1);
							if (!existing[0]) {
								const text = summarize(
									`Legacy task notification could not be migrated (${input.source.taskId}): ${registration.reason}. No task was rerun.`,
								);
								const message: RefMessageInput = {
									id: messageId,
									narratorId: input.recipientId,
									role: "disp",
									origin: "system",
									contentText: text,
									contentJson: [{ type: "text", text }],
									createdAt: new Date().toISOString(),
								};
								await persistPgMessageWithRef(tx, message);
							}
							return "diagnostic" as const;
						}
						const resultRef = await persistResultSection(tx, registration.run, input.resultText);
						await primitives.commitIntent(tx, {
							...registration.run,
							eventKind: registration.eventKind,
							resultRef,
							summary: summarize(input.summary),
						});
						return "migrated" as const;
					},
					{ legacyReplay: true },
				);
				// Post-commit evidence freeze, mirroring the queue's standalone operation:
				// never inside the replayable section, only after it committed.
				if (input.admission) primitives.freezeLegacyCompletionEvidence(input.admission);
				return status;
			} finally {
				release();
				if (token && completionMigrationLocks.get(token) === tail)
					completionMigrationLocks.delete(token);
			}
		},

		/** The two bounded pending probes (outbox intents, then mailbox deliveries). */
		async hasPendingSource(run: PublicationRun): Promise<boolean> {
			const keys = (
				["started", "completed", "failed", "timed_out", "cancelled", "terminal"] as const
			).map((event) => publicationDedupeKey(run, event));
			const intent = await db
				.select({ id: outbox.id })
				.from(outbox)
				.where(inArray(outbox.dedupeKey, keys))
				.limit(1);
			if (intent[0]) return true;
			const delivered = await db
				.select({ id: mailbox.id })
				.from(mailbox)
				.where(
					and(
						eq(mailbox.narratorId, run.recipientId),
						inArray(mailbox.dedupeKey, keys),
						ne(mailbox.state, "cancelled"),
						or(ne(mailbox.state, "materialized"), isNull(mailbox.adoptedAt)),
					),
				)
				.limit(1);
			return !!delivered[0];
		},

		/**
		 * Restart an existing agent background task: CAS status → "running" +
		 * logical run link + task-row fields in ONE section.
		 *
		 * Returns the updated row (with the CAS guard — `undefined` if the row
		 * no longer exists or its status changed concurrently).
		 */
		async restartAgentTask(input: PgRestartAgentTaskInput): Promise<{ id: string } | undefined> {
			return runComposite("publication.restartAgentTask", async (tx) => {
				const [updated] = await tx
					.update(backgroundTasks)
					.set({
						status: "running",
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
						startedAt: input.now,
						completedAt: null,
						updatedAt: input.now,
					})
					.where(
						and(
							eq(backgroundTasks.id, input.taskId),
							eq(backgroundTasks.status, input.expectedStatus),
						),
					)
					.returning({ id: backgroundTasks.id });
				return updated;
			});
		},

		/**
		 * Update a narrator's background completion fields + the terminal
		 * publication commit in ONE section (when `deferPublication` is false).
		 *
		 * The narrator update is unconditional (the row must exist); the
		 * publication commit uses `commitAgentTerminal` for the result snapshot
		 * + terminal intent atomically.
		 */
		async updateNarratorBackground(input: PgUpdateNarratorBackgroundInput): Promise<void> {
			await runComposite("publication.updateNarratorBackground", async (tx) => {
				const [updated] = await tx
					.update(narrators)
					.set({
						...(input.isBackground !== undefined ? { isBackground: input.isBackground } : {}),
						backgroundStatus: input.backgroundStatus,
						backgroundResult: input.backgroundResult,
						backgroundCompletedAt: input.backgroundCompletedAt,
						updatedAt: input.updatedAt,
					})
					.where(eq(narrators.id, input.narratorId))
					.returning({ logicalRunId: narrators.logicalRunId });
				if (!updated) throw new ValidationError("Background narrator does not exist");
				if (!input.deferPublication) {
					const source: LegacyPublicationSource = {
						producerKind: "agent",
						taskId: input.narratorId,
						recipientId: input.parentNarratorId,
					};
					const run: PublicationRun = updated.logicalRunId
						? { ...source, logicalRunId: updated.logicalRunId }
						: await primitives.registerLegacyRunningRunSlots(
								tx,
								source,
								{ kind: "runtime" },
								{},
								{
									readLegacyRuntimeAdmission: (admittedSource) =>
										registrations.legacyReaders.get(admittedSource.producerKind)?.(admittedSource),
								},
							);
					const eventKind = input.backgroundStatus === "completed" ? "completed" : "failed";
					const resultRef = await persistResultSection(tx, run, input.backgroundResult);
					await primitives.commitIntent(tx, {
						...run,
						eventKind,
						resultRef,
						summary: `[System] Background agent (ID: ${input.narratorId}) ${input.backgroundStatus}. Use Await({ type: "agent", id: "${input.narratorId}" }) to read its stored result.`,
					});
				}
			});
		},

		/**
		 * Terminal transition for a background task: the CAS update, publication
		 * result snapshot and the terminal intent commit in ONE section.
		 *
		 * Returns the updated task row (with type/status/parentNarratorId/title/
		 * alias/output for the caller's side effects) or `undefined` when the CAS
		 * guard rejects (task no longer running).
		 */
		async commitTerminalTransition(input: PgTerminalTransitionInput): Promise<
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
		> {
			return runComposite("publication.commitTerminalTransition", async (tx) => {
				const [task] = await tx
					.update(backgroundTasks)
					.set(input.setFields)
					.where(and(eq(backgroundTasks.id, input.taskId), eq(backgroundTasks.status, "running")))
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
					});
				if (!task || task.type === "transfer" || input.deferPublication) return task;
				if (!task.logicalRunId) {
					logger.warn("Terminal transition skipped: task has no logicalRunId", {
						taskId: input.taskId,
						type: task.type,
					});
					return task;
				}
				const run: PublicationRun = {
					producerKind: task.type as "agent" | "bash",
					taskId: input.taskId,
					logicalRunId: task.logicalRunId,
					recipientId: task.parentNarratorId,
				};
				const resultRef = await persistResultSection(tx, run, input.fullOutput);
				await primitives.commitIntent(tx, {
					...run,
					eventKind: input.eventKind,
					resultRef,
					summary: summarize(input.summary),
				});
				return task;
			});
		},

		/**
		 * Stale-restart recovery: task CAS, legacy run registration when needed,
		 * terminal publication, and the paired narrator projection all commit in one
		 * retryable PostgreSQL section. This is the PG counterpart of the SQLite
		 * `runAtomicWrite` recovery block.
		 */
		async recoverStaleTask(input: PgRecoverStaleTaskInput) {
			return runComposite("publication.recoverStaleTask", async (tx) => {
				const [task] = await tx
					.update(backgroundTasks)
					.set({
						status: input.eventKind === "failed" ? "failed" : "cancelled",
						output: input.text,
						outputBytes: Buffer.byteLength(input.text),
						outputTruncated: false,
						completedAt: input.now,
						updatedAt: input.now,
					})
					.where(and(eq(backgroundTasks.id, input.taskId), eq(backgroundTasks.status, "running")))
					.returning({
						id: backgroundTasks.id,
						type: backgroundTasks.type,
						parentNarratorId: backgroundTasks.parentNarratorId,
						subagentNarratorId: backgroundTasks.subagentNarratorId,
						logicalRunId: backgroundTasks.logicalRunId,
						toolCallId: backgroundTasks.toolCallId,
						executionAttempt: backgroundTasks.executionAttempt,
					});
				if (!task) return undefined;
				if (task.type === "agent") {
					await tx
						.update(narrators)
						.set({
							isBackground: false,
							backgroundStatus: "cancelled",
							backgroundResult: input.text,
							backgroundCompletedAt: input.now,
							updatedAt: input.now,
						})
						.where(eq(narrators.id, task.subagentNarratorId ?? task.id));
				}
				if (task.type === "transfer") return task;
				const source = {
					producerKind: task.type as "agent" | "bash",
					taskId: task.id,
					recipientId: task.parentNarratorId,
				};
				const run = task.logicalRunId
					? ({
							producerKind: source.producerKind,
							taskId: task.id,
							recipientId: task.parentNarratorId,
							logicalRunId: task.logicalRunId,
						} satisfies PublicationRun)
					: task.type === "bash" && !task.toolCallId && !task.executionAttempt
						? await primitives.registerLegacyUnknownBashFailure(tx, source)
						: await primitives.registerLegacyRunningRunSlots(
								tx,
								source,
								{ kind: "persisted_task" },
								{},
							);
				const resultRef = await persistResultSection(tx, run, input.text);
				await primitives.commitIntent(tx, {
					...run,
					eventKind: input.eventKind,
					resultRef,
					summary: summarize(input.text),
				});
				return task;
			});
		},

		/** Pause a stale transfer projection without touching the SQLite handle. */
		async pauseStaleTransfer(input: PgPauseStaleTransferInput) {
			return runComposite("publication.pauseStaleTransfer", async (tx) => {
				const [task] = await tx
					.update(backgroundTasks)
					.set({ status: "paused", output: input.notice, updatedAt: input.now })
					.where(and(eq(backgroundTasks.id, input.taskId), eq(backgroundTasks.status, "running")))
					.returning({
						id: backgroundTasks.id,
						parentNarratorId: backgroundTasks.parentNarratorId,
					});
				return task;
			});
		},

		/**
		 * Named bounded read: read a background task row by id. Returns null
		 * if not found. This is the PG-safe alternative to the SQLite-only
		 * `db.select(backgroundTasks).where(eq(id, taskId)).get()`.
		 */
		async readBackgroundTask(taskId: string): Promise<BackgroundTaskRecord | null> {
			return runComposite("publication.readBackgroundTask", async (tx) => {
				const rows = await tx
					.select()
					.from(backgroundTasks)
					.where(eq(backgroundTasks.id, taskId))
					.limit(1);
				return (rows[0] as unknown as BackgroundTaskRecord) ?? null;
			});
		},

		/**
		 * Cleanup completed/failed/cancelled background tasks: the bounded
		 * candidate select, the publication pending-source filter, and the
		 * DELETE in ONE section.
		 *
		 * Returns only the minimal fields the caller needs for runtime cleanup
		 * and broadcast (id + parentNarratorId + type). The not-exists guard
		 * re-applies the selection criteria in the WHERE to close the race
		 * window between the select and the delete.
		 */
		async cleanupTasks(input: PgCleanupInput): Promise<PgCleanupTaskResult[]> {
			return runComposite("publication.cleanupTasks", async (tx) => {
				const statusCondition = notInArray(backgroundTasks.status, [...input.excludedStatuses]);
				const ageCondition = sql`${backgroundTasks.completedAt} < ${input.cutoff}`;
				const activeNarratorCondition = notExists(
					tx
						.select({ one: sql`1` })
						.from(narrators)
						.where(
							and(
								eq(
									narrators.id,
									sql`coalesce(${backgroundTasks.subagentNarratorId}, ${backgroundTasks.id})`,
								),
								or(
									inArray(narrators.status, [...input.excludedNarratorStatuses]),
									like(narrators.substatus, '%"taken_over"%'),
									like(narrators.substatus, '%"manual_override"%'),
								),
							),
						),
				);

				const candidates = await tx
					.select({
						id: backgroundTasks.id,
						logicalRunId: backgroundTasks.logicalRunId,
						parentNarratorId: backgroundTasks.parentNarratorId,
						type: backgroundTasks.type,
					})
					.from(backgroundTasks)
					.where(and(statusCondition, ageCondition, activeNarratorCondition))
					.limit(input.limit);

				if (candidates.length === 0) return [];

				const deletable: PgCleanupTaskResult[] = [];
				for (const row of candidates) {
					if (!row.logicalRunId || row.type === "transfer") {
						deletable.push(row);
						continue;
					}
					const run: PublicationRun = {
						producerKind: row.type as "agent" | "bash",
						taskId: row.id,
						logicalRunId: row.logicalRunId,
						recipientId: row.parentNarratorId,
					};
					const keys = (
						["started", "completed", "failed", "timed_out", "cancelled", "terminal"] as const
					).map((event) => publicationDedupeKey(run, event));
					const intent = await tx
						.select({ id: outbox.id })
						.from(outbox)
						.where(inArray(outbox.dedupeKey, keys))
						.limit(1);
					if (intent[0]) continue;
					const delivered = await tx
						.select({ id: mailbox.id })
						.from(mailbox)
						.where(
							and(
								eq(mailbox.narratorId, run.recipientId),
								inArray(mailbox.dedupeKey, keys),
								ne(mailbox.state, "cancelled"),
								or(ne(mailbox.state, "materialized"), isNull(mailbox.adoptedAt)),
							),
						)
						.limit(1);
					if (!delivered[0]) deletable.push(row);
				}

				if (deletable.length === 0) return [];
				const deletableIds = deletable.map((r) => r.id);
				await tx
					.delete(backgroundTasks)
					.where(
						and(
							inArray(backgroundTasks.id, deletableIds),
							statusCondition,
							ageCondition,
							activeNarratorCondition,
						),
					);
				return deletable;
			});
		},

		/**
		 * Read the full detail of a background task row by id.
		 *
		 * Returns null when the row does not exist. This is the PG-safe
		 * alternative to `db.select().from(backgroundTasks).where(eq(id,…)).get()`
		 * (the SQLite synchronous single-row read). Bounded: LIMIT 1.
		 */
		async readTaskDetail(taskId: string): Promise<BackgroundTaskRecord | null> {
			return runComposite("publication.readTaskDetail", async (tx) => {
				const rows = await tx
					.select()
					.from(backgroundTasks)
					.where(eq(backgroundTasks.id, taskId))
					.limit(1);
				return (rows[0] as unknown as BackgroundTaskRecord) ?? null;
			});
		},

		/**
		 * Cancel task composite: check cancellability, CAS to terminal status,
		 * and commit the publication terminal intent — all in ONE section.
		 *
		 * Returns null when the CAS rejects (task not cancellable or not found).
		 * The caller owns in-memory side effects (abort controller, event bus).
		 */
		async cancelTask(input: PgCancelTaskInput): Promise<PgCancelTaskResult | null> {
			return runComposite("publication.cancelTask", async (tx) => {
				const [existing] = await tx
					.select({
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
					.limit(1);
				if (!existing || (existing.status !== "running" && existing.status !== "paused")) {
					return null;
				}

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

				const [updated] = await tx
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
					});
				if (!updated) return null;

				// Commit the publication terminal intent in the same section.
				if (existing.type !== "transfer" && existing.logicalRunId) {
					const run: PublicationRun = {
						producerKind: existing.type as "agent" | "bash",
						taskId: input.taskId,
						logicalRunId: existing.logicalRunId,
						recipientId: existing.parentNarratorId,
					};
					const resultRef = await persistResultSection(
						tx,
						run,
						input.capturedOutput ?? "(cancelled)",
					);
					await primitives.commitIntent(tx, {
						...run,
						eventKind: "cancelled",
						resultRef,
						summary: summarize(
							`[System] Background ${existing.type} cancelled. Use Await({ type: "${existing.type}", id: "${existing.alias ?? existing.id}" }) to read the stored result.`,
						),
					});
				}
				return updated;
			});
		},

		/**
		 * Cancel the paired background narrator projection and move it to idle.
		 * This is deliberately separate from cancelTask: task publication and
		 * narrator status have different callers, but both must be PG-native.
		 */
		async cancelAgentNarrator(input: PgCancelAgentNarratorInput): Promise<void> {
			await runComposite("publication.cancelAgentNarrator", async (tx) => {
				await tx
					.update(narrators)
					.set({
						status: "idle",
						substatus: JSON.stringify(["interrupted"]),
						backgroundStatus: "cancelled",
						backgroundCompletedAt: input.now,
						updatedAt: input.now,
						errorMessage: null,
						errorRetryable: null,
					})
					.where(eq(narrators.id, input.narratorId));
			});
		},

		/**
		 * Named bounded read: running tasks for a parent narrator.
		 * Paginated via id cursor; caller handles in-memory abort/event emission.
		 */
		async readRunningStaleTasks(afterId?: string): Promise<PgStaleTaskRow[]> {
			return runComposite("publication.readRunningStaleTasks", (tx) =>
				tx
					.select({
						id: backgroundTasks.id,
						type: backgroundTasks.type,
						parentNarratorId: backgroundTasks.parentNarratorId,
						subagentNarratorId: backgroundTasks.subagentNarratorId,
						logicalRunId: backgroundTasks.logicalRunId,
						toolCallId: backgroundTasks.toolCallId,
						executionAttempt: backgroundTasks.executionAttempt,
					})
					.from(backgroundTasks)
					.where(
						and(
							eq(backgroundTasks.status, "running"),
							afterId ? gt(backgroundTasks.id, afterId) : undefined,
						),
					)
					.orderBy(asc(backgroundTasks.id))
					.limit(101),
			);
		},

		/**
		 * Mark a task as taken over: CAS "running" → "cancelled" (no publication
		 * events — takeover is silent). Returns the parentNarratorId for the caller's
		 * list-delta upsert, or null if the CAS rejects.
		 */
		async markTakenOver(input: PgTakeoverInput): Promise<{ parentNarratorId: string } | null> {
			return runComposite("publication.markTakenOver", async (tx) => {
				const [updated] = await tx
					.update(backgroundTasks)
					.set({ status: "cancelled", completedAt: input.now, updatedAt: input.now })
					.where(and(eq(backgroundTasks.id, input.taskId), eq(backgroundTasks.status, "running")))
					.returning({ parentNarratorId: backgroundTasks.parentNarratorId });
				return updated ?? null;
			});
		},

		/**
		 * Finalize a taken-over task: CAS "cancelled" → terminal (completed/failed)
		 * with output. Returns the parentNarratorId for list-delta upsert, or null
		 * if the CAS rejects (task was not cancelled-by-takeover).
		 */
		async finalizeTakeover(
			input: PgFinalizeTakeoverInput,
		): Promise<{ parentNarratorId: string; id: string } | null> {
			return runComposite("publication.finalizeTakeover", async (tx) => {
				const outputBytes = Buffer.byteLength(input.output, "utf-8");
				const truncated = outputBytes > MAX_OUTPUT_BYTES;
				const storedOutput = truncated
					? truncateToBytes(input.output, MAX_OUTPUT_BYTES)
					: input.output;
				const terminalStatus = input.hasError ? "failed" : "completed";
				const [updated] = await tx
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
					});
				if (!updated) return null;
				const source: LegacyPublicationSource = {
					producerKind: updated.type as "agent" | "bash",
					taskId: updated.id,
					recipientId: updated.parentNarratorId,
				};
				const run: PublicationRun = updated.logicalRunId
					? { ...source, logicalRunId: updated.logicalRunId }
					: await primitives.registerLegacyRunningRunSlots(
							tx,
							source,
							{ kind: "runtime" },
							{},
							{
								readLegacyRuntimeAdmission: (admittedSource) =>
									registrations.legacyReaders.get(admittedSource.producerKind)?.(admittedSource),
							},
						);
				const resultRef = await persistResultSection(tx, run, input.output);
				await primitives.commitIntent(tx, {
					...run,
					eventKind: input.hasError ? "failed" : "completed",
					resultRef,
					summary: summarize(
						`[System] Background agent "${updated.title ?? updated.alias ?? updated.id}" (ID: ${updated.alias ?? updated.id}) ${terminalStatus}. Use Await({ type: "agent", id: "${updated.alias ?? updated.id}" }) to read the stored result.`,
					),
				});
				return { id: updated.id, parentNarratorId: updated.parentNarratorId };
			});
		},
	};
}

export type PostgresRuntimePublication = ReturnType<typeof createPostgresRuntimePublication>;
