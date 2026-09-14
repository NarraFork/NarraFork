import { and, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "../../db";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	runtimePublicationOutbox,
} from "../../db/schema";
import { ValidationError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { hotSafe } from "../../lib/hot-safe";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import type { NarratorServerMessage } from "../../websocket/narrator-ws-types";
import { notifyAwaitWake } from "./await-wake";
import { MAILBOX_LIMITS as L } from "./limits";
import type { NoticeKind, RuntimeDb, RuntimeTx } from "./mailbox-types";
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

type LegacyTaskNotice =
	| { kind: "bg_agent"; task: import("../bg-completion-queue").CompletedBgSubagentNotification }
	| { kind: "bg_bash"; task: import("../background-task-service").CompletedNotification };
export const PUBLICATION_FALLBACK_BYTES = 64 * 1024;

export function publicationEvent(status: string): PublicationEvent {
	if (status === "timeout" || status === "timed out" || status === "timed_out") return "timed_out";
	if (status === "cancelled") return "cancelled";
	if (status === "started" || status === "running") return "started";
	return status === "completed" ? "completed" : "failed";
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
	const pendingProjectionBroadcasts = new Map<string, { narratorId: string; deliveryId: string }>();

	function broadcastProjection(narratorId: string, deliveryId: string): void {
		const row = database
			.select({
				narratorId: narratorMessageRefs.narratorId,
				id: narratorMessages.id,
				role: narratorMessages.role,
				contentJson: narratorMessages.contentJson,
				contentText: narratorMessages.contentText,
				parentToolUseId: narratorMessages.parentToolUseId,
				createdAt: narratorMessages.createdAt,
				seq: narratorMessageRefs.seq,
				deliveryId: narratorMessageRefs.deliveryId,
				deliveryKind: narratorMessageRefs.deliveryKind,
				deliveryState: narratorMessageRefs.deliveryState,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.deliveryId, deliveryId),
				),
			)
			.get();
		if (!row) return;
		const message: NarratorServerMessage = {
			type: "message",
			narratorId: row.narratorId,
			message: { ...row, children: [], toolCalls: [] },
		};
		eventBus.emit({ type: "narrator:ws_broadcast", narratorId: row.narratorId, message });
	}

	function flushProjectionBroadcasts(): void {
		for (const { narratorId, deliveryId } of pendingProjectionBroadcasts.values())
			broadcastProjection(narratorId, deliveryId);
		pendingProjectionBroadcasts.clear();
	}

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
		return database.transaction((tx) => {
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
				const last = tx
					.select({ seq: narratorMessageRefs.seq })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, input.narratorId))
					.orderBy(desc(narratorMessageRefs.seq))
					.limit(1)
					.get();
				// A stable ref boundary, not millisecond timestamps: two runs may start in the same ms.
				tx.update(runtimePublicationOutbox)
					.set({ resultRef: `source_after:${last?.seq ?? 0}` })
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
			const last = tx
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, narratorId))
				.orderBy(desc(narratorMessageRefs.seq))
				.limit(1)
				.get();
			tx.insert(narratorMessageRefs)
				.values({ id: generateId(), narratorId, messageId, seq: (last?.seq ?? 0) + 1 })
				.run();
		}
		return `message-original:${messageId}`;
	}

	/** Source result mutation and intent are committed by the caller's SAME synchronous transaction. */
	function commit(intent: PublicationIntent, tx: RuntimeTx) {
		const result = store.commitIntent(
			{ ...intent, summary: publicationSummary(intent.summary) },
			tx,
		);
		if (result.status === "committed" && result.deliveryId)
			pendingProjectionBroadcasts.set(`${intent.recipientId}:${result.deliveryId}`, {
				narratorId: intent.recipientId,
				deliveryId: result.deliveryId,
			});
		return result;
	}

	function notifyTransfer(recipientId: string, deliveryId?: string) {
		if (!deliveryId) return;
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
		notifyAwaitWake(recipientId, "task_notice");
		if (!wake) return;
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
		flushProjectionBroadcasts();
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
		flushProjectionBroadcasts();
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
		flushProjectionBroadcasts();
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
			const status = database.transaction((tx) => {
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
						const last = tx
							.select({ seq: narratorMessageRefs.seq })
							.from(narratorMessageRefs)
							.where(eq(narratorMessageRefs.narratorId, recipientId))
							.orderBy(desc(narratorMessageRefs.seq))
							.limit(1)
							.get();
						tx.insert(narratorMessageRefs)
							.values({
								id: generateId(),
								narratorId: recipientId,
								messageId,
								seq: (last?.seq ?? 0) + 1,
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
export const runtimePublication = createRuntimePublicationService(db);
workerLifecycle.stop = () => runtimePublication.stop();
export function flushRuntimePublications(recipientId?: string) {
	if (recipientId) runtimePublication.flushRecipient(recipientId);
	runtimePublication.schedule();
}
export function setLegacyCompletionAdmissionReader(
	reader: (source: LegacyPublicationSource) => LegacyCompletionAdmission | undefined,
) {
	runtimePublication.setLegacyCompletionAdmissionReader(reader);
}
export function migrateLegacyTaskNotice(recipientId: string, entry: LegacyTaskNotice) {
	return runtimePublication.migrateLegacyTaskNotice(recipientId, entry);
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
