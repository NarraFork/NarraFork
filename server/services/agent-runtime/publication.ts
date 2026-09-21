import { and, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "../../db";
import { resolveDatabaseBackendConfig } from "../../db/postgres-runtime";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	runtimePublicationOutbox,
} from "../../db/schema";
import { ValidationError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import {
	claimNextRefSeq,
	NARRATOR_REF_SEQ_EMPTY_TOP,
	raiseSeqFloorForClaim,
	readTopRefSeq,
} from "../narrator-refs/seq-store";
import { MAILBOX_LIMITS as L } from "./limits";
import type { NoticeKind, RuntimeDb, RuntimeTx } from "./mailbox-types";
import {
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
	type PgTakeoverInput,
	type PgTerminalTransitionInput,
	type PgUpdateNarratorBackgroundInput,
	requirePublicationTx,
} from "./postgres-runtime-publication";
import {
	createPublicationOutbox,
	type LegacyCompletionAdmission,
	type LegacyPublicationSource,
	type LegacyRuntimeAdmission,
	type PublicationEvent,
	type PublicationIntent,
	type PublicationRun,
	publicationDedupeKey,
} from "./publication-outbox";
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

	function startAgentRun(input: {
		narratorId: string;
		parentNarratorId: string;
		resumeRunId?: string;
		started?: boolean;
	}): PublicationRun {
		return runAtomicWrite(database, "publication.startAgentRun", (tx) => {
			const logicalRunId = store.persistLogicalRun(
				input.narratorId,
				{ resumeRunId: input.resumeRunId },
				tx,
			);
			const run: PublicationRun = {
				producerKind: "agent",
				taskId: input.narratorId,
				logicalRunId,
				recipientId: input.parentNarratorId,
			};
			reserve(run, tx, input.started);
			if (!input.resumeRunId) {
				// A stable ref boundary, not millisecond timestamps: two runs may start in
				// the same ms. An empty narrator's watermark is NARRATOR_REF_SEQ_EMPTY_TOP
				// (= base 0 minus one), NOT 0 — the first ref of an empty narrator claims
				// seq 0, and `source_after:0` would exclude it from the run's result.
				tx.update(runtimePublicationOutbox)
					.set({
						resultRef: `source_after:${readTopRefSeq(tx, input.narratorId) ?? NARRATOR_REF_SEQ_EMPTY_TOP}`,
					})
					.where(
						and(
							eq(runtimePublicationOutbox.dedupeKey, publicationDedupeKey(run, "terminal")),
							eq(runtimePublicationOutbox.state, "reserved"),
						),
					)
					.run();
			}
			tx.update(backgroundTasks)
				.set({ logicalRunId })
				.where(eq(backgroundTasks.id, input.narratorId))
				.run();
			return run;
		});
	}

	function getAgentRun(narratorId: string, recipientId: string, tx?: RuntimeTx): PublicationRun {
		const row = (tx ?? database)
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
	function persistResult(run: PublicationRun, text: string, tx: RuntimeTx): string {
		// Bash has one durable task per actual attempt; its output is already normalized
		// to the existing 512 KiB budget. Never copy raw stdout into a message row.
		if (run.producerKind === "bash") return `background_task:${run.taskId}:${run.logicalRunId}`;
		const source = tx
			.select({ resultRef: runtimePublicationOutbox.resultRef })
			.from(runtimePublicationOutbox)
			.where(eq(runtimePublicationOutbox.dedupeKey, publicationDedupeKey(run, "terminal")))
			.get();
		const boundary = source?.resultRef?.startsWith("source_after:")
			? Number(source.resultRef.slice(13))
			: undefined;
		const assistant =
			boundary !== undefined && Number.isSafeInteger(boundary)
				? tx
						.select({ id: narratorMessages.id, role: narratorMessages.role })
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
						.find((row) => row.role === "assistant")
				: undefined;
		// Capture only the already-supported idle display projection. The complete result
		// remains in its existing source; later semantic edits must not change this receipt.
		const originalBytes = Buffer.byteLength(text);
		const preview = text.slice(0, 12_001);
		const storedText = new TextDecoder().decode(
			Buffer.from(preview).subarray(0, PUBLICATION_FALLBACK_BYTES),
			{ stream: true },
		);
		const truncated = originalBytes > Buffer.byteLength(storedText);
		const messageId = `publication-result:${run.logicalRunId}`;
		const narratorId = run.producerKind === "agent" ? run.taskId : run.recipientId;
		const inserted = tx
			.insert(narratorMessages)
			.values({
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
			})
			.onConflictDoNothing()
			.returning({ id: narratorMessages.id })
			.get();
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

	/** Source result mutation and intent are committed by the caller's SAME synchronous transaction. */
	function commit(intent: PublicationIntent, tx: RuntimeTx) {
		return store.commitIntent({ ...intent, summary: publicationSummary(intent.summary) }, tx);
	}

	function notifyTransfer(recipientId: string, deliveryId?: string) {
		if (!wake || !deliveryId) return;
		const row = database
			.select({ metadataJson: narratorBufferedMessages.metadataJson })
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.deliveryId, deliveryId))
			.get();
		const event = row?.metadataJson
			? (JSON.parse(row.metadataJson) as { eventKind?: string }).eventKind
			: undefined;
		// Restart/cancel notices are observable on the next pass, not permission to spend a turn.
		if (event === "started" || event === "cancelled") return;
		try {
			void Promise.resolve(wake(recipientId)).catch((error) =>
				logger.warn("Publication wake deferred", { recipientId, error: String(error) }),
			);
		} catch (error) {
			logger.warn("Publication wake deferred", { recipientId, error: String(error) });
		}
	}

	/** All fast and retry paths grant the next vacancy to the earliest durable intent. */
	function flushRecipient(recipientId: string): number {
		let transferred = 0;
		for (const kind of ["agent", "bash"] as const) {
			for (let i = 0; i < L.pageSize / 2; i++) {
				const result = store.transferNext(recipientId, kind);
				if (result.status !== "transferred") break;
				transferred++;
				notifyTransfer(recipientId, result.deliveryId);
			}
		}
		return transferred;
	}

	/** One bounded page per turn. Full mailboxes release the worker immediately. */
	function flushPage(): boolean {
		const page = store.listPending({ afterId: cursor, limit: L.pageSize });
		const rows = page.slice(0, L.pageSize);
		// At most one transfer per listed row: a page never expands to pageSize² work.
		const full = new Set<string>();
		for (const row of rows) {
			const key = `${row.recipientId}:${row.producerKind}`;
			if (full.has(key)) continue;
			const result = store.transferNext(row.recipientId, row.producerKind);
			if (result.status === "transferred") notifyTransfer(row.recipientId, result.deliveryId);
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
				try {
					if (flushPage() && retry++ < L.claimMaxAttempts) schedule(false);
				} catch (error) {
					logger.warn("Runtime publication delivery deferred", { retry, error: String(error) });
					if (retry++ < L.claimMaxAttempts) schedule(false);
				}
			},
			retry ? Math.min(50 * 2 ** retry, 1000) : 0,
		);
		timer.unref();
	}

	return {
		store,
		reserve,
		startAgentRun,
		getAgentRun,
		persistResult,
		commit,
		flushRecipient,
		flushPage,
		schedule,
		hasPendingSource(run: PublicationRun) {
			const keys = (
				["started", "completed", "failed", "timed_out", "cancelled", "terminal"] as const
			).map((event) => publicationDedupeKey(run, event));
			if (
				database
					.select({ id: runtimePublicationOutbox.id })
					.from(runtimePublicationOutbox)
					.where(inArray(runtimePublicationOutbox.dedupeKey, keys))
					.limit(1)
					.get()
			)
				return true;
			return !!database
				.select({ id: narratorBufferedMessages.id })
				.from(narratorBufferedMessages)
				.where(
					and(
						eq(narratorBufferedMessages.narratorId, run.recipientId),
						inArray(narratorBufferedMessages.dedupeKey, keys),
						ne(narratorBufferedMessages.state, "cancelled"),
						or(
							ne(narratorBufferedMessages.state, "materialized"),
							isNull(narratorBufferedMessages.adoptedAt),
						),
					),
				)
				.limit(1)
				.get();
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
					const inserted = tx
						.insert(narratorMessages)
						.values({
							id: messageId,
							narratorId: recipientId,
							role: "disp",
							origin: "system",
							contentText: text,
							contentJson: [{ type: "text", text }],
							createdAt: new Date().toISOString(),
						})
						.onConflictDoNothing()
						.returning({ id: narratorMessages.id })
						.get();
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
						summary: `[System] Background ${source.producerKind} "${entry.task.title ?? entry.task.alias ?? source.taskId}" (ID: ${entry.task.alias ?? source.taskId}) ${registration.eventKind}. Use Await to inspect the stored result.`,
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
		startAgentRun: () => unavailable("startAgentRun"),
		getAgentRun: () => unavailable("getAgentRun"),
		persistResult: () => unavailable("persistResult"),
		commit: () => unavailable("commit"),
		flushRecipient: () => unavailable("flushRecipient"),
		flushPage: () => unavailable("flushPage"),
		schedule: () => unavailable("schedule"),
		hasPendingSource: () => unavailable("hasPendingSource"),
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
};

/** The terminal-commit composite input (result snapshot + intent in one section). */
export interface PublicationTerminalCommit {
	readonly run: PublicationRun;
	readonly eventKind: Exclude<PublicationEvent, "started">;
	/** The producer's result text; the agent kind snapshots it into a message/ref. */
	readonly text: string;
	readonly summary: string;
}

export interface AsyncRuntimePublicationService {
	readonly backend: "sqlite" | "postgres";
	startAgentRun(input: {
		narratorId: string;
		parentNarratorId: string;
		resumeRunId?: string;
		started?: boolean;
		/** PG-only: insert background_tasks row + reserve publication slots in one section. */
		taskRow?: Omit<typeof backgroundTasks.$inferInsert, "logicalRunId">;
	}): Promise<PublicationRun>;
	getAgentRun(narratorId: string, recipientId: string): Promise<PublicationRun>;
	newBashRun(taskId: string, recipientId: string): PublicationRun;
	startBashRun(input: {
		taskId: string;
		recipientId: string;
		started?: boolean;
		/** PG-only: insert background_tasks row + reserve publication slots in one section. */
		taskRow?: Omit<typeof backgroundTasks.$inferInsert, "logicalRunId">;
	}): Promise<PublicationRun>;
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
	/** Named bounded read: full background task detail by id (LIMIT 1). */
	readBackgroundTask(taskId: string): Promise<BackgroundTaskRecord | null>;
	/**
	 * Named bounded read: full detail of a background task row by id.
	 * Returns the complete BackgroundTaskRecord (including output) or null.
	 * On PG this is a LIMIT-1 async query; on SQLite it wraps the sync `.get()`.
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
 * The SQLite branch: wrap the legacy synchronous service. Each method body runs
 * the synchronous section to completion at CALL time and the Promise wraps the
 * already-committed result — no Promise ever enters a `bun:sqlite` transaction,
 * and the observable timing for legacy fire-and-forget callers is unchanged.
 */
function createSqliteAsyncPublicationService(
	legacy: RuntimePublicationService,
): AsyncRuntimePublicationService {
	const commitTerminal = (input: PublicationTerminalCommit): Promise<PublicationCommitResult> =>
		Promise.resolve(
			runAtomicWrite(db, "publication.commitTerminal", (tx) =>
				legacy.commit(
					{
						...input.run,
						eventKind: input.eventKind,
						resultRef: legacy.persistResult(input.run, input.text, tx),
						summary: input.summary,
					},
					tx,
				),
			),
		);
	return {
		backend: "sqlite",
		startAgentRun: async (input) => legacy.startAgentRun(input),
		getAgentRun: async (narratorId, recipientId) => legacy.getAgentRun(narratorId, recipientId),
		newBashRun: (taskId, recipientId) => legacy.newBashRun(taskId, recipientId),
		startBashRun: async (input) => {
			const run = legacy.newBashRun(input.taskId, input.recipientId);
			runAtomicWrite(db, "publication.startBashRun", (tx) =>
				legacy.reserve(run, tx, input.started),
			);
			return run;
		},
		releaseUnusedRunSlots: async (run) => Promise.resolve(legacy.store.releaseUnusedRunSlots(run)),
		restartAgentTask: async (input) => {
			const now = input.now;
			const existing = db
				.select({ logicalRunId: backgroundTasks.logicalRunId })
				.from(backgroundTasks)
				.where(eq(backgroundTasks.id, input.taskId))
				.get();
			if (!existing) return undefined;
			const run = legacy.getAgentRun(input.taskId, input.taskId);
			return Promise.resolve(
				runAtomicWrite(db, "publication.restartAgentTask", (tx) => {
					const updated = tx
						.update(backgroundTasks)
						.set({
							status: "running",
							logicalRunId: run.logicalRunId,
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
							summary: `[System] Background agent (ID: ${input.narratorId}) ${input.backgroundStatus}. Use Await({ type: "agent", id: "${input.narratorId}" }) to read its stored result.`,
						},
						tx,
					);
				}
			});
		},
		commitTerminalTransition: async (input) => {
			const task = runAtomicWrite(db, "publication.commitTerminalTransition", (tx) => {
				// The SQLite branch pre-reads the task for its logicalRunId, which the
				// publication run needs. The CAS guard (WHERE status = "running") prevents
				// double-transition.
				const before = tx
					.select({
						id: backgroundTasks.id,
						type: backgroundTasks.type,
						parentNarratorId: backgroundTasks.parentNarratorId,
						logicalRunId: backgroundTasks.logicalRunId,
					})
					.from(backgroundTasks)
					.where(eq(backgroundTasks.id, input.taskId))
					.get();
				if (before && before.type !== "transfer" && !before.logicalRunId) {
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
					})
					.get();
				if (!updated || updated.type === "transfer" || input.deferPublication)
					return updated ?? undefined;
				const run = taskPublicationRun({
					...updated,
					logicalRunId: before?.logicalRunId ?? null,
				});
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
		readBackgroundTask: async (taskId) => {
			const row = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
			return row ?? null;
		},
		readTaskDetail: async (taskId) => {
			const row = db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
			return (row as BackgroundTaskRecord) ?? null;
		},
		cancelTask: async (input) => {
			const task = runAtomicWrite(db, "publication.cancelTask", (tx) => {
				const existing = tx
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
					.get();
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
				if (updated.type !== "transfer" && existing.logicalRunId) {
					const run = taskPublicationRun({ ...updated, logicalRunId: existing.logicalRunId });
					legacy.commit(
						{
							...run,
							eventKind: "cancelled",
							resultRef: legacy.persistResult(run, input.capturedOutput ?? "(cancelled)", tx),
							summary: `[System] Background ${existing.type} cancelled. Use Await({ type: "${existing.type}", id: "${existing.alias ?? existing.id}" }) to read the stored result.`,
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
				tx.update(narrators)
					.set({
						backgroundStatus: "cancelled",
						backgroundCompletedAt: input.now,
						updatedAt: input.now,
					})
					.where(eq(narrators.id, input.narratorId))
					.run();
			});
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
			return commitTerminal(input);
		},
		commitBashTerminal: async (input) => {
			if (input.run.producerKind !== "bash")
				throw new Error("Bash terminal commit requires a bash run");
			return commitTerminal(input);
		},
		migrateLegacyTaskNotice: async (recipientId, entry) =>
			legacy.migrateLegacyTaskNotice(recipientId, entry),
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
			void Promise.resolve(handler(recipientId)).catch((error) =>
				logger.warn("Publication wake deferred", { recipientId, error: String(error) }),
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
		flushing = (async () => {
			try {
				if ((await flushPage()) && retry++ < L.claimMaxAttempts) again = true;
			} catch (error) {
				logger.warn("Runtime publication delivery deferred", { retry, error: String(error) });
				if (retry++ < L.claimMaxAttempts) again = true;
			}
		})();
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
		startAgentRun: (input) => engine.startAgentRun(input),
		getAgentRun: (narratorId, recipientId) => engine.getAgentRun(narratorId, recipientId),
		newBashRun: (taskId, recipientId) => ({
			producerKind: "bash",
			taskId,
			recipientId,
			logicalRunId: generateId(),
		}),
		startBashRun: (input) => engine.startBashRun(input),
		releaseUnusedRunSlots: (run) => queue.outbox.releaseUnusedRunSlots(run),
		restartAgentTask: (input) => engine.restartAgentTask(input),
		updateNarratorBackground: (input) => engine.updateNarratorBackground(input),
		commitTerminalTransition: (input) => engine.commitTerminalTransition(input),
		cleanupTasks: (input) => engine.cleanupTasks(input),
		readBackgroundTask: async (taskId) =>
			(await engine.readBackgroundTask(taskId)) as BackgroundTaskRecord | null,
		readTaskDetail: async (taskId) =>
			(await engine.readTaskDetail(taskId)) as BackgroundTaskRecord | null,
		cancelTask: (input) => engine.cancelTask(input),
		cancelAgentNarrator: (input) => engine.cancelAgentNarrator(input),
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
					? `[System] Background ${source.producerKind} "${entry.task.title ?? entry.task.alias ?? source.taskId}" (ID: ${entry.task.alias ?? source.taskId}) ${admission.eventKind}. Use Await to inspect the stored result.`
					: "",
			});
			// The publisher schedules bounded retries after the durable intent commits.
			schedule();
			return status;
		},
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
		producerKind: task.type as NoticeKind,
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
export type { PublicationEvent, PublicationRun } from "./publication-outbox";
