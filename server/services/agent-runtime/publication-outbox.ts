import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
	backgroundTasks,
	narratorBufferedMessages as mailbox,
	narratorMessageRefs,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
	runtimePublicationOutbox as outbox,
} from "../../db/schema";
import { hotSafe } from "../../lib/hot-safe";
import { generateId } from "../../lib/id";
import { insertCanonicalMessageTx } from "../narrator-history-projection";
import { MAILBOX_LIMITS as L } from "./limits";
import {
	allocateArrivalSequence,
	boundedError,
	boundedJson,
	initializeLegacyMailbox,
	mailboxHasCapacity,
} from "./mailbox";
import { setDeliveryProjectionStateTx } from "./mailbox-transitions";
import type { NoticeKind, RuntimeDb, RuntimeStoreDb, RuntimeTx } from "./mailbox-types";

export type PublicationEvent = "started" | "completed" | "failed" | "timed_out" | "cancelled";
export const LEGACY_UNKNOWN_BASH_FAILURE_SUMMARY =
	"Execution outcome unknown after restart; the command was not rerun.";
export interface PublicationRun {
	producerKind: NoticeKind;
	taskId: string;
	logicalRunId: string;
	recipientId: string;
}
export type LegacyPublicationSource = Omit<PublicationRun, "logicalRunId">;
export interface LegacyRuntimeAdmission extends LegacyPublicationSource {
	/** Obtained from the real runtime registry, not supplied by a tool/request argument. */
	startedAtMs: number;
}
export type LegacyPublicationProof =
	| { kind: "runtime" }
	| { kind: "checkpoint"; checkpointId: string; updateEpoch: string }
	| { kind: "persisted_task" };
export interface LegacyCompletionAdmission extends LegacyPublicationSource {
	/** Original hotSafe entry object, captured at protocol activation; never a request argument. */
	token: object;
	eventKind: Exclude<PublicationEvent, "started">;
}
export type LegacyCompletionRegistration =
	| { status: "registered"; run: PublicationRun; eventKind: Exclude<PublicationEvent, "started"> }
	| { status: "unmigratable"; reason: string };
export interface PublicationOutboxOptions {
	readLegacyCompletionAdmission?: (
		source: LegacyPublicationSource,
	) => LegacyCompletionAdmission | undefined;
	/** Narrow read-only repository. Undefined means runtime evidence cannot be established. */
	readLegacyRuntimeAdmission?: (
		source: LegacyPublicationSource,
	) => LegacyRuntimeAdmission | undefined;
}
interface LegacyBoundary {
	capturedAtMs: number;
	backgroundRowId: number;
	narratorRowId: number;
	checkpointRowId: number;
	completionTokens: WeakMap<object, Readonly<LegacyCompletionAdmission>>;
}
// Reconstructing the store (including --hot) must not move the legacy/new-task boundary.
const legacyBoundaries = hotSafe<WeakMap<object, LegacyBoundary>>(
	"narrafork.runtimePublication.legacyBoundaries",
	() => new WeakMap(),
);
function legacyBoundary(db: RuntimeDb): LegacyBoundary {
	const prior = legacyBoundaries.get(db.$client);
	if (prior) return prior;
	// One read snapshot, three rowid B-tree lookups; no payload reads or task-history scan.
	const capturedAtMs = Date.now();
	const maxima = db.get<[number | null, number | null, number | null]>(sql`SELECT
		(SELECT max(rowid) FROM background_tasks),
		(SELECT max(rowid) FROM narrators),
		(SELECT max(rowid) FROM narrator_tool_continuations)`);
	const boundary = {
		capturedAtMs,
		backgroundRowId: maxima?.[0] ?? 0,
		narratorRowId: maxima?.[1] ?? 0,
		checkpointRowId: maxima?.[2] ?? 0,
		completionTokens: new WeakMap<object, Readonly<LegacyCompletionAdmission>>(),
	};
	legacyBoundaries.set(db.$client, boundary);
	return boundary;
}
export interface PublicationIntent extends PublicationRun {
	eventKind: PublicationEvent;
	/** Pointer into the producer's durable result storage, not the result JSON. */
	resultRef: string;
	summary: string;
}
export function publicationDedupeKey(
	run: PublicationRun,
	eventKind: PublicationEvent | "terminal",
) {
	return JSON.stringify([
		"publication",
		run.producerKind,
		run.taskId,
		run.logicalRunId,
		eventKind,
		run.recipientId,
	]);
}
function runWhere(run: PublicationRun) {
	return and(
		eq(outbox.producerKind, run.producerKind),
		eq(outbox.taskId, run.taskId),
		eq(outbox.logicalRunId, run.logicalRunId),
		eq(outbox.recipientId, run.recipientId),
	);
}
function assertRun(run: PublicationRun) {
	if (run.producerKind !== "agent" && run.producerKind !== "bash")
		throw new Error("Invalid publication producer identity");
	for (const pointer of [run.taskId, run.logicalRunId, run.recipientId])
		if (typeof pointer !== "string" || !pointer || Buffer.byteLength(pointer) > 256)
			throw new Error("Invalid publication pointer");
}
/** Cheap indexed probe used to avoid entering a write transaction on every history page. */
export function hasPendingPublicationProjection(database: RuntimeDb, recipientId: string): boolean {
	return Boolean(
		database
			.select({ id: outbox.id })
			.from(outbox)
			.where(and(eq(outbox.recipientId, recipientId), eq(outbox.state, "pending")))
			.limit(1)
			.get(),
	);
}

/** No timers or task re-execution. The publisher schedules bounded retries after this returns. */
export function repairPendingPublicationProjections(
	database: RuntimeDb,
	recipientId: string,
): number {
	return database.transaction((tx) => {
		const rows = tx
			.select({
				deliveryId: outbox.deliveryId,
				taskId: outbox.taskId,
				eventKind: outbox.eventKind,
				summary: outbox.summary,
				createdAt: outbox.createdAt,
			})
			.from(outbox)
			.where(and(eq(outbox.recipientId, recipientId), eq(outbox.state, "pending")))
			.orderBy(asc(outbox.arrivalSeq), asc(outbox.id))
			.limit(L.pageSize)
			.all();
		for (const row of rows) {
			if (
				tx
					.select({ id: narratorMessageRefs.id })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.deliveryId, row.deliveryId))
					.get()
			)
				continue;
			insertCanonicalMessageTx(tx, {
				narratorId: recipientId,
				messageId: generateId(),
				role: "sys",
				contentJson: [{ type: "text", text: row.summary ?? "(queued task notice)" }],
				contentText: row.summary ?? "(queued task notice)",
				createdAt: row.createdAt,
				deliveryId: row.deliveryId,
				deliveryKind: "task_notice",
				deliveryState: "queued",
			});
		}
		return rows.length;
	});
}

export function createPublicationOutbox(db: RuntimeDb, options: PublicationOutboxOptions = {}) {
	const boundary = legacyBoundary(db);
	const readLegacyRuntimeAdmission = options.readLegacyRuntimeAdmission;
	function beforeBoundary(value: string | number | null | undefined): boolean {
		const millis = typeof value === "number" ? value : value ? Date.parse(value) : Number.NaN;
		return Number.isFinite(millis) && millis >= 0 && millis <= boundary.capturedAtMs;
	}
	function readLegacySource(
		source: LegacyPublicationSource,
		tx: RuntimeTx,
		idleRecovery: LegacyPublicationProof["kind"] | false = false,
	) {
		assertRun({ ...source, logicalRunId: "legacy-validation" });
		const task = tx
			.select({
				id: backgroundTasks.id,
				rowId: sql<number>`${backgroundTasks}.rowid`,
				type: backgroundTasks.type,
				status: backgroundTasks.status,
				recipientId: backgroundTasks.parentNarratorId,
				subagentId: backgroundTasks.subagentNarratorId,
				logicalRunId: backgroundTasks.logicalRunId,
				toolCallId: backgroundTasks.toolCallId,
				executionAttempt: backgroundTasks.executionAttempt,
				startedAt: backgroundTasks.startedAt,
				createdAt: backgroundTasks.createdAt,
			})
			.from(backgroundTasks)
			.where(eq(backgroundTasks.id, source.taskId))
			.get();
		if (
			task &&
			(task.rowId > boundary.backgroundRowId ||
				!beforeBoundary(task.createdAt) ||
				(task.logicalRunId == null && !beforeBoundary(task.startedAt)))
		)
			throw new Error("Source was not running before legacy publication admission closed");
		if (
			task &&
			(task.type !== source.producerKind ||
				task.recipientId !== source.recipientId ||
				task.status !== "running")
		)
			throw new Error("Legacy task kind, recipient or running state does not match");
		if (source.producerKind === "bash" && !task)
			throw new Error("Legacy bash source does not exist");
		const narrator =
			source.producerKind === "agent"
				? tx
						.select({
							id: narrators.id,
							rowId: sql<number>`${narrators}.rowid`,
							type: narrators.type,
							recipientId: narrators.parentNarratorId,
							status: narrators.status,
							logicalRunId: narrators.logicalRunId,
							toolCallId: narrators.originToolCallId,
							createdAt: narrators.createdAt,
							startedAt: narrators.turnStartedAt,
						})
						.from(narrators)
						.where(eq(narrators.id, source.taskId))
						.get()
				: undefined;
		if (source.producerKind === "agent") {
			if (
				!narrator ||
				narrator.type !== "subagent" ||
				narrator.recipientId !== source.recipientId ||
				![
					"working",
					"waiting",
					...(idleRecovery && (idleRecovery !== "persisted_task" || task?.status === "running")
						? ["idle"]
						: []),
				].includes(narrator.status)
			)
				throw new Error("Legacy agent source kind, recipient or running state does not match");
			if (
				narrator.rowId > boundary.narratorRowId ||
				!beforeBoundary(narrator.createdAt) ||
				(narrator.logicalRunId == null && narrator.startedAt && !beforeBoundary(narrator.startedAt))
			)
				throw new Error("Source was not running before legacy publication admission closed");
			if (task?.subagentId && task.subagentId !== narrator.id)
				throw new Error("Legacy task points to another agent");
			if (task && task.logicalRunId !== narrator.logicalRunId)
				throw new Error("Legacy source logical run records disagree");
		}
		const logicalRunId = narrator?.logicalRunId ?? task?.logicalRunId ?? null;
		if (logicalRunId && !logicalRunId.startsWith("legacy:"))
			throw new Error("Source already belongs to a new-protocol run");
		return {
			task,
			narrator,
			logicalRunId,
			toolCallId: task?.toolCallId ?? narrator?.toolCallId ?? null,
			executionAttempt: task?.executionAttempt ?? null,
		};
	}
	function verifyLegacyReceipt(
		source: LegacyPublicationSource,
		record: ReturnType<typeof readLegacySource>,
		tx: RuntimeTx,
	) {
		if (
			!record.toolCallId ||
			(source.producerKind === "bash" && (!record.executionAttempt || record.executionAttempt < 1))
		)
			throw new Error("Legacy source has no verifiable execution receipt");
		const receipt = tx
			.select({
				narratorId: narratorToolCalls.narratorId,
				attempt: narratorToolCalls.executionAttempt,
				identityVersion: narratorToolCalls.executionIdentityVersion,
				originToolCallId: narratorToolCalls.executionOriginToolCallId,
				isHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
				startedAt: narratorToolCalls.executionStartedAt,
			})
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, record.toolCallId))
			.get();
		// Older agent projections did not keep the initiating binding. Their immutable origin PK
		// may supply it, but only from the real original receipt predating that child's creation.
		// A later execution of that same tool row cannot be mistaken for the old child's attempt.
		const originalAgentReceipt =
			source.producerKind === "agent" && record.narrator?.toolCallId === record.toolCallId;
		const expectedAttempt =
			record.executionAttempt ?? (originalAgentReceipt ? receipt?.attempt : undefined);
		const sourceCreatedAt = record.narrator?.createdAt ?? record.task?.createdAt;
		if (
			!receipt ||
			receipt.narratorId !== source.recipientId ||
			!expectedAttempt ||
			expectedAttempt < 1 ||
			receipt.attempt !== expectedAttempt ||
			receipt.identityVersion < 1 ||
			(receipt.originToolCallId != null && receipt.originToolCallId !== record.toolCallId) ||
			receipt.isHistoryCheckpoint ||
			!beforeBoundary(receipt.startedAt) ||
			!sourceCreatedAt ||
			Date.parse(receipt.startedAt as string) > Date.parse(sourceCreatedAt)
		)
			throw new Error("Legacy source execution receipt does not match");
	}
	function verifyLegacyProof(
		source: LegacyPublicationSource,
		record: ReturnType<typeof readLegacySource>,
		proof: LegacyPublicationProof,
		tx: RuntimeTx,
	) {
		if (proof.kind === "runtime") {
			// This lookup is supplied once by the producer's real old-runtime repository, not by callers.
			const accepted = readLegacyRuntimeAdmission?.(source);
			if (
				!accepted ||
				accepted.producerKind !== source.producerKind ||
				accepted.taskId !== source.taskId ||
				accepted.recipientId !== source.recipientId ||
				!beforeBoundary(accepted.startedAtMs)
			)
				throw new Error("Source has no verified pre-existing runtime admission");
			return;
		}
		if (proof.kind === "persisted_task") {
			verifyLegacyReceipt(source, record, tx);
			return;
		}
		if (proof.kind !== "checkpoint" || !proof.checkpointId || !proof.updateEpoch)
			throw new Error("Invalid legacy publication proof");
		const checkpoint = tx
			.select({
				rowId: sql<number>`${narratorToolContinuations}.rowid`,
				narratorId: narratorToolContinuations.narratorId,
				toolCallId: narratorToolContinuations.toolCallId,
				epoch: narratorToolContinuations.updateEpoch,
				state: narratorToolContinuations.state,
				kind: narratorToolContinuations.kind,
				createdAt: narratorToolContinuations.createdAt,
			})
			.from(narratorToolContinuations)
			.where(eq(narratorToolContinuations.id, proof.checkpointId))
			.get();
		if (
			!checkpoint ||
			checkpoint.rowId > boundary.checkpointRowId ||
			!beforeBoundary(checkpoint.createdAt) ||
			checkpoint.narratorId !== source.recipientId ||
			checkpoint.toolCallId !== record.toolCallId ||
			checkpoint.epoch !== proof.updateEpoch ||
			!["paused", "waiting", "resuming"].includes(checkpoint.state) ||
			(source.producerKind === "agent"
				? !["foreground_agent", "background_agent"].includes(checkpoint.kind)
				: checkpoint.kind !== "deferred_tool")
		)
			throw new Error("Legacy update checkpoint does not authorize this source");
	}
	function persistLegacySlots(
		source: LegacyPublicationSource,
		record: ReturnType<typeof readLegacySource>,
		events: readonly ("started" | "terminal" | "failed")[],
		unknownFailure: boolean,
		tx: RuntimeTx,
	): PublicationRun {
		if (record.logicalRunId) return { ...source, logicalRunId: record.logicalRunId };
		const existing = tx
			.select({ id: outbox.id })
			.from(outbox)
			.where(
				and(
					eq(outbox.producerKind, source.producerKind),
					eq(outbox.taskId, source.taskId),
					eq(outbox.recipientId, source.recipientId),
				),
			)
			.limit(1)
			.get();
		if (existing)
			throw new Error("Unregistered legacy source already has publication protocol state");
		const run = {
			...source,
			logicalRunId: `legacy:${unknownFailure ? "unknown:" : ""}${generateId()}`,
		};
		const time = new Date().toISOString();
		if (
			record.task &&
			!tx
				.update(backgroundTasks)
				.set({ logicalRunId: run.logicalRunId })
				.where(
					and(
						eq(backgroundTasks.id, record.task.id),
						isNull(backgroundTasks.logicalRunId),
						eq(backgroundTasks.status, "running"),
						eq(backgroundTasks.type, source.producerKind),
						eq(backgroundTasks.parentNarratorId, source.recipientId),
					),
				)
				.returning({ id: backgroundTasks.id })
				.get()
		)
			throw new Error("Legacy task changed before registration committed");
		if (
			record.narrator &&
			!tx
				.update(narrators)
				.set({ logicalRunId: run.logicalRunId })
				.where(
					and(
						eq(narrators.id, record.narrator.id),
						isNull(narrators.logicalRunId),
						eq(narrators.status, record.narrator.status),
						eq(narrators.parentNarratorId, source.recipientId),
					),
				)
				.returning({ id: narrators.id })
				.get()
		)
			throw new Error("Legacy narrator changed before registration committed");
		// Only grandfathered, independently verified already-running sources reach this insertion.
		// Existing obligations may exceed the new quotas; ordinary admission sees them and stays full.
		for (const eventKind of events)
			tx.insert(outbox)
				.values({
					id: generateId(),
					...run,
					eventKind,
					deliveryId: generateId(),
					dedupeKey: publicationDedupeKey(run, eventKind),
					createdAt: time,
					updatedAt: time,
				})
				.run();
		return run;
	}
	function registerLegacyRunningRunSlots(
		source: LegacyPublicationSource,
		proof: LegacyPublicationProof,
		slotOptions: { started?: boolean } = {},
		tx?: RuntimeTx,
	): PublicationRun {
		if (!tx)
			return db.transaction((inner) =>
				registerLegacyRunningRunSlots(source, proof, slotOptions, inner),
			);
		if (
			!["runtime", "checkpoint", "persisted_task"].includes(proof.kind) ||
			(proof.kind === "checkpoint" && (!proof.checkpointId || !proof.updateEpoch))
		)
			throw new Error("Invalid legacy publication proof");
		const record = readLegacySource(source, tx, proof.kind);
		if (record.logicalRunId?.startsWith("legacy:unknown:"))
			throw new Error("Unknown legacy source can only publish failure");
		// A prior atomic registration is durable evidence. Recovered callers do not need the
		// original process's runtime object again, and must not allocate another set of slots.
		if (record.logicalRunId) return { ...source, logicalRunId: record.logicalRunId };
		verifyLegacyProof(source, record, proof, tx);
		return persistLegacySlots(
			source,
			record,
			slotOptions.started ? ["started", "terminal"] : ["terminal"],
			false,
			tx,
		);
	}
	/** Crash recovery for genuinely unbound old Bash: never creates a success-capable terminal slot. */
	function registerLegacyUnknownBashFailure(
		source: LegacyPublicationSource,
		tx?: RuntimeTx,
	): PublicationRun {
		if (!tx) return db.transaction((inner) => registerLegacyUnknownBashFailure(source, inner));
		if (source.producerKind !== "bash")
			throw new Error("Unknown legacy failure is only available for Bash");
		const record = readLegacySource(source, tx);
		if (record.toolCallId || record.executionAttempt)
			throw new Error("Bound legacy sources require verified admission evidence");
		if (record.logicalRunId && !record.logicalRunId.startsWith("legacy:unknown:"))
			throw new Error("Legacy source already has a verified run");
		return persistLegacySlots(source, record, ["failed"], true, tx);
	}
	/** Terminal migration is driven exclusively by captured old queue entries, never task polling. */
	function registerLegacyCompletedRunSlots(
		source: LegacyPublicationSource,
		tx?: RuntimeTx,
	): LegacyCompletionRegistration {
		if (!tx) return db.transaction((inner) => registerLegacyCompletedRunSlots(source, inner));
		assertRun({ ...source, logicalRunId: "legacy-completion-validation" });
		const rejected = (reason: string): LegacyCompletionRegistration => ({
			status: "unmigratable",
			reason,
		});
		const admission = options.readLegacyCompletionAdmission?.(source);
		if (
			!admission?.token ||
			typeof admission.token !== "object" ||
			admission.producerKind !== source.producerKind ||
			admission.taskId !== source.taskId ||
			admission.recipientId !== source.recipientId ||
			!["completed", "failed", "timed_out", "cancelled"].includes(admission.eventKind)
		)
			return rejected("No captured legacy completion entry authorizes this source");
		const frozen = boundary.completionTokens.get(admission.token);
		if (
			frozen &&
			(frozen.producerKind !== admission.producerKind ||
				frozen.taskId !== admission.taskId ||
				frozen.recipientId !== admission.recipientId ||
				frozen.eventKind !== admission.eventKind)
		)
			return rejected("Captured legacy completion identity or outcome changed");
		if (!frozen) boundary.completionTokens.set(admission.token, Object.freeze({ ...admission }));
		const task = tx
			.select({
				rowId: sql<number>`${backgroundTasks}.rowid`,
				type: backgroundTasks.type,
				recipientId: backgroundTasks.parentNarratorId,
				status: backgroundTasks.status,
				logicalRunId: backgroundTasks.logicalRunId,
				createdAt: backgroundTasks.createdAt,
				startedAt: backgroundTasks.startedAt,
				completedAt: backgroundTasks.completedAt,
				subagentId: backgroundTasks.subagentNarratorId,
			})
			.from(backgroundTasks)
			.where(eq(backgroundTasks.id, source.taskId))
			.get();
		const narrator =
			source.producerKind === "agent"
				? tx
						.select({
							rowId: sql<number>`${narrators}.rowid`,
							type: narrators.type,
							recipientId: narrators.parentNarratorId,
							status: narrators.status,
							backgroundStatus: narrators.backgroundStatus,
							logicalRunId: narrators.logicalRunId,
							createdAt: narrators.createdAt,
							startedAt: narrators.turnStartedAt,
							completedAt: narrators.backgroundCompletedAt,
						})
						.from(narrators)
						.where(eq(narrators.id, source.taskId))
						.get()
				: undefined;
		if (
			!tx
				.select({ id: narrators.id })
				.from(narrators)
				.where(eq(narrators.id, source.recipientId))
				.get()
		)
			return rejected("Legacy completion recipient was deleted");
		const event = (status: string | null) => (status === "timeout" ? "timed_out" : status);
		if (
			task &&
			(task.rowId > boundary.backgroundRowId ||
				!beforeBoundary(task.createdAt) ||
				!beforeBoundary(task.startedAt) ||
				!beforeBoundary(task.completedAt))
		)
			return rejected("Legacy task was not terminal at protocol activation");
		if (
			task &&
			(task.type !== source.producerKind ||
				task.recipientId !== source.recipientId ||
				event(task.status) !== admission.eventKind)
		)
			return rejected("Legacy task outcome or recipient no longer matches its queued notice");
		if (source.producerKind === "bash" && !task)
			return rejected("Legacy Bash completion source was deleted");
		if (source.producerKind === "agent") {
			if (
				!narrator ||
				narrator.type !== "subagent" ||
				narrator.recipientId !== source.recipientId ||
				narrator.status !== "idle"
			)
				return rejected("Legacy agent completion no longer belongs to an idle source");
			if (
				narrator.rowId > boundary.narratorRowId ||
				!beforeBoundary(narrator.createdAt) ||
				(narrator.startedAt && !beforeBoundary(narrator.startedAt)) ||
				!beforeBoundary(narrator.completedAt)
			)
				return rejected("Legacy agent was not terminal at protocol activation");
			if (!task && event(narrator.backgroundStatus) !== admission.eventKind)
				return rejected("Legacy agent outcome no longer matches its queued notice");
			if (
				task &&
				(task.subagentId !== source.taskId || task.logicalRunId !== narrator.logicalRunId)
			)
				return rejected("Legacy agent and task identities disagree");
		}
		const existingRun = narrator?.logicalRunId ?? task?.logicalRunId;
		const prefix = `legacy:completed:${admission.eventKind}:`;
		if (existingRun && !existingRun.startsWith(prefix))
			return rejected("Legacy notification cannot bind the source's current logical run");
		if (existingRun)
			return {
				status: "registered",
				run: { ...source, logicalRunId: existingRun },
				eventKind: admission.eventKind,
			};
		const run = { ...source, logicalRunId: `${prefix}${generateId()}` };
		if (
			task &&
			!tx
				.update(backgroundTasks)
				.set({ logicalRunId: run.logicalRunId })
				.where(
					and(
						eq(backgroundTasks.id, source.taskId),
						isNull(backgroundTasks.logicalRunId),
						eq(backgroundTasks.status, task.status),
						eq(backgroundTasks.parentNarratorId, source.recipientId),
					),
				)
				.returning({ id: backgroundTasks.id })
				.get()
		)
			throw new Error("Legacy terminal source changed during registration");
		if (
			narrator &&
			!tx
				.update(narrators)
				.set({ logicalRunId: run.logicalRunId })
				.where(
					and(
						eq(narrators.id, source.taskId),
						isNull(narrators.logicalRunId),
						eq(narrators.status, "idle"),
						eq(narrators.parentNarratorId, source.recipientId),
					),
				)
				.returning({ id: narrators.id })
				.get()
		)
			throw new Error("Legacy terminal narrator changed during registration");
		const time = new Date().toISOString();
		tx.insert(outbox)
			.values({
				id: generateId(),
				...run,
				eventKind: admission.eventKind,
				deliveryId: generateId(),
				dedupeKey: publicationDedupeKey(run, admission.eventKind),
				createdAt: time,
				updatedAt: time,
			})
			.run();
		return { status: "registered", run, eventKind: admission.eventKind };
	}
	function reserveRunSlots(
		run: PublicationRun,
		options: { started?: boolean } = {},
		tx?: RuntimeTx,
	): { status: "reserved"; logicalRunId: string } | { status: "full" } {
		if (!tx) return db.transaction((inner) => reserveRunSlots(run, options, inner));
		assertRun(run);
		if (run.logicalRunId.startsWith("legacy:unknown:"))
			throw new Error("Unknown legacy source can only use its failure slot");
		if (run.logicalRunId.startsWith("legacy:completed:"))
			throw new Error("Legacy completion can only use its captured event slot");
		const events = options.started ? (["started", "terminal"] as const) : (["terminal"] as const);
		const existing = tx
			.select({ event: outbox.eventKind })
			.from(outbox)
			.where(runWhere(run))
			.limit(3)
			.all();
		const terminalKeys = (["completed", "failed", "timed_out", "cancelled"] as const).map((event) =>
			publicationDedupeKey(run, event),
		);
		const deliveredTerminal = tx
			.select({ id: mailbox.id })
			.from(mailbox)
			.where(and(eq(mailbox.narratorId, run.recipientId), inArray(mailbox.dedupeKey, terminalKeys)))
			.limit(1)
			.get();
		// Recovery must not allocate another terminal slot after its dedupe authority moved to mailbox.
		if (
			deliveredTerminal ||
			existing.some((row) => row.event !== "started" && row.event !== "terminal")
		)
			return { status: "reserved" as const, logicalRunId: run.logicalRunId };
		const needed = events.filter(
			(event) =>
				!existing.some((row) => row.event === event) &&
				!tx
					?.select({ id: mailbox.id })
					.from(mailbox)
					.where(
						and(
							eq(mailbox.narratorId, run.recipientId),
							eq(mailbox.dedupeKey, publicationDedupeKey(run, event)),
						),
					)
					.get(),
		);
		// Covering-index subqueries are hard-bounded; never COUNT the delivery tombstone history.
		const recipientCount =
			tx.get<[number]>(
				sql`SELECT count(*) AS n FROM (SELECT id FROM runtime_publication_outbox WHERE recipient_id = ${run.recipientId} LIMIT ${L.publicationRecipientSlots})`,
			)?.[0] ?? 0;
		const globalCount =
			tx.get<[number]>(
				sql`SELECT count(*) AS n FROM (SELECT id FROM runtime_publication_outbox LIMIT ${L.publicationGlobalSlots})`,
			)?.[0] ?? 0;
		if (
			recipientCount + needed.length > L.publicationRecipientSlots ||
			globalCount + needed.length > L.publicationGlobalSlots
		)
			return { status: "full" as const };
		const time = new Date().toISOString();
		for (const eventKind of needed)
			tx.insert(outbox)
				.values({
					id: generateId(),
					...run,
					eventKind,
					dedupeKey: publicationDedupeKey(run, eventKind),
					deliveryId: generateId(),
					createdAt: time,
					updatedAt: time,
				})
				.run();
		return { status: "reserved" as const, logicalRunId: run.logicalRunId };
	}
	function commitIntent(
		intent: PublicationIntent,
		tx?: RuntimeTx,
	): { status: "duplicate" | "committed"; deliveryId: string | null; arrivalSeq: number | null } {
		if (!tx) return db.transaction((inner) => commitIntent(intent, inner));
		assertRun(intent);
		if (
			intent.logicalRunId.startsWith("legacy:completed:") &&
			!intent.logicalRunId.startsWith(`legacy:completed:${intent.eventKind}:`)
		)
			throw new Error("Legacy completion can only publish its captured outcome");
		if (intent.logicalRunId.startsWith("legacy:unknown:") && intent.eventKind !== "failed")
			throw new Error("Unknown legacy source can only publish failed outcome");
		if (!["started", "completed", "failed", "timed_out", "cancelled"].includes(intent.eventKind))
			throw new Error("Invalid publication event identity");
		const dedupeKey = publicationDedupeKey(intent, intent.eventKind);
		const delivered = tx
			.select({ deliveryId: mailbox.deliveryId, arrivalSeq: mailbox.arrivalSeq })
			.from(mailbox)
			.where(and(eq(mailbox.narratorId, intent.recipientId), eq(mailbox.dedupeKey, dedupeKey)))
			.get();
		if (delivered) return { status: "duplicate" as const, ...delivered };
		const existing = tx
			.select()
			.from(outbox)
			.where(and(runWhere(intent), eq(outbox.eventKind, intent.eventKind)))
			.get();
		if (existing && existing.state !== "reserved")
			return {
				status: "duplicate" as const,
				deliveryId: existing.deliveryId,
				arrivalSeq: existing.arrivalSeq,
			};
		// Existing event receipts win over regenerated summaries or result projections on retries.
		if (intent.logicalRunId.startsWith("legacy:unknown:"))
			intent = { ...intent, summary: LEGACY_UNKNOWN_BASH_FAILURE_SUMMARY };
		boundedJson(intent, L.publicationBytes);
		if (!intent.resultRef || Buffer.byteLength(intent.resultRef) > 512)
			throw new Error("Result reference required");
		const slot =
			existing ??
			tx
				.select()
				.from(outbox)
				.where(
					and(runWhere(intent), eq(outbox.eventKind, "terminal"), eq(outbox.state, "reserved")),
				)
				.get();
		if (!slot || (intent.eventKind === "started" && slot.eventKind !== "started"))
			throw new Error("Publication requires a startup reservation");
		const recipientExists = tx
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.id, intent.recipientId))
			.get();
		// A reserved slot can be marked undeliverable without revoking the running producer's
		// right to commit its terminal result. lastError on a reservation is only set by failRecipient.
		const recipientFailure =
			slot.lastError ?? (recipientExists ? null : "Recipient permanently deleted");
		if (!recipientFailure && !initializeLegacyMailbox(tx, intent.recipientId))
			throw new Error("Legacy mailbox initialization requires another page");
		const arrivalSeq = recipientFailure ? null : allocateArrivalSequence(tx, intent.recipientId);
		if (!recipientFailure) {
			insertCanonicalMessageTx(tx, {
				narratorId: intent.recipientId,
				messageId: generateId(),
				role: "sys",
				contentJson: [
					{
						type: "system_injection",
						source: `bg_${intent.producerKind}`,
						modelText: intent.summary,
						body: {
							kind: "tasksDone",
							flavor: intent.producerKind,
							items: [
								{
									id: intent.taskId,
									title: intent.taskId,
									status: intent.eventKind,
									preview: intent.summary,
								},
							],
						},
					},
				],
				contentText: intent.summary,
				deliveryId: slot.deliveryId,
				deliveryKind: "task_notice",
				deliveryState: "queued",
			});
		}
		tx.update(outbox)
			.set({
				eventKind: intent.eventKind,
				state: recipientFailure ? "failed" : "pending",
				lastError: recipientFailure,
				arrivalSeq,
				resultRef: intent.resultRef,
				summary: intent.summary,
				dedupeKey,
				updatedAt: new Date().toISOString(),
			})
			.where(and(eq(outbox.id, slot.id), eq(outbox.state, "reserved")))
			.run();
		// An early terminal failure may never have emitted started; its unused capacity must not leak.
		// Already-committed started events remain pending and retain their earlier arrival order.
		if (intent.eventKind !== "started")
			tx.delete(outbox)
				.where(and(runWhere(intent), eq(outbox.eventKind, "started"), eq(outbox.state, "reserved")))
				.run();
		return { status: "committed" as const, deliveryId: slot.deliveryId, arrivalSeq };
	}
	function transferNext(
		recipientId: string,
		producerKind: NoticeKind,
		tx?: RuntimeTx,
	): { status: "empty" | "full" | "transferred" | "recipient_failed"; deliveryId?: string } {
		if (!tx) return db.transaction((inner) => transferNext(recipientId, producerKind, inner));
		const row = tx
			.select()
			.from(outbox)
			.where(
				and(
					eq(outbox.recipientId, recipientId),
					eq(outbox.producerKind, producerKind),
					eq(outbox.state, "pending"),
				),
			)
			.orderBy(asc(outbox.arrivalSeq))
			.limit(1)
			.get();
		if (!row) return { status: "empty" };
		const recipient = tx
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.id, recipientId))
			.get();
		if (!recipient) {
			tx.update(outbox)
				.set({
					state: "failed",
					lastError: "Recipient permanently deleted",
					updatedAt: new Date().toISOString(),
				})
				.where(eq(outbox.id, row.id))
				.run();
			return { status: "recipient_failed", deliveryId: row.deliveryId };
		}
		const duplicate = tx
			.select({ id: mailbox.id })
			.from(mailbox)
			.where(and(eq(mailbox.narratorId, recipientId), eq(mailbox.dedupeKey, row.dedupeKey)))
			.get();
		if (!duplicate) {
			if (!mailboxHasCapacity(tx, recipientId, "task_notice", producerKind))
				return { status: "full" };
			if (row.arrivalSeq == null) throw new Error("Pending event has no arrival sequence");
			const metadataJson = boundedJson(
				{
					producerKind,
					taskId: row.taskId,
					logicalRunId: row.logicalRunId,
					eventKind: row.eventKind,
					resultRef: row.resultRef,
				},
				L.publicationBytes,
			);
			const projection = tx
				.select({ messageId: narratorMessageRefs.messageId, refId: narratorMessageRefs.id })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.deliveryId, row.deliveryId))
				.get();
			let canonical = projection;
			if (!canonical) {
				const inserted = insertCanonicalMessageTx(tx, {
					narratorId: recipientId,
					messageId: generateId(),
					role: "sys",
					contentJson: [{ type: "text", text: row.summary ?? "" }],
					contentText: row.summary ?? "",
					deliveryId: row.deliveryId,
					deliveryKind: "task_notice",
					deliveryState: "queued",
				});
				canonical = { messageId: inserted.message.id, refId: inserted.ref.id };
			}
			tx.insert(mailbox)
				.values({
					id: generateId(),
					narratorId: recipientId,
					kind: "task_notice",
					noticeKind: producerKind,
					text: row.summary ?? "",
					metadataJson,
					sourceKey: row.dedupeKey,
					dedupeKey: row.dedupeKey,
					deliveryId: row.deliveryId,
					recipientMessageId: canonical.messageId,
					recipientRefId: canonical.refId,
					currentMessageId: canonical.messageId,
					arrivalSeq: row.arrivalSeq,
					seq: row.arrivalSeq,
					byteSize: Buffer.byteLength(row.summary ?? ""),
					projectedByteSize: Buffer.byteLength(row.summary ?? "") + Buffer.byteLength(metadataJson),
					bufferedAt: row.createdAt,
					updatedAt: new Date().toISOString(),
				})
				.run();
		}
		// Dedupe authority moves to mailbox, including cancelled/deleted negative receipts.
		tx.delete(outbox).where(eq(outbox.id, row.id)).run();
		return { status: "transferred", deliveryId: row.deliveryId };
	}
	/** Invoke in the same start-admission transaction as reserveRunSlots. */
	function persistLogicalRun(
		narratorId: string,
		options: { resumeRunId?: string } = {},
		tx?: RuntimeTx,
	): string {
		if (!tx) return db.transaction((inner) => persistLogicalRun(narratorId, options, inner));
		const row = tx
			.select({ logicalRunId: narrators.logicalRunId })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get();
		if (!row) throw new Error("Runtime narrator does not exist");
		if (options.resumeRunId) {
			if (row.logicalRunId !== options.resumeRunId) throw new Error("Stale logical run recovery");
			return options.resumeRunId;
		}
		const logicalRunId = generateId();
		tx.update(narrators).set({ logicalRunId }).where(eq(narrators.id, narratorId)).run();
		return logicalRunId;
	}
	/** Caller has finalized a run that will emit no further events (e.g. foreground without detach). */
	function releaseUnusedRunSlots(run: PublicationRun, tx?: RuntimeTx): number {
		if (!tx) return db.transaction((inner) => releaseUnusedRunSlots(run, inner));
		assertRun(run);
		return tx
			.delete(outbox)
			.where(and(runWhere(run), eq(outbox.state, "reserved")))
			.returning({ id: outbox.id })
			.all().length;
	}
	return {
		reserveRunSlots,
		commitIntent,
		transferNext,
		persistLogicalRun,
		releaseUnusedRunSlots,
		registerLegacyRunningRunSlots,
		registerLegacyUnknownBashFailure,
		registerLegacyCompletedRunSlots,
		listPending(options: { afterId?: string; limit?: number } = {}, tx: RuntimeStoreDb = db) {
			return tx
				.select({
					id: outbox.id,
					recipientId: outbox.recipientId,
					producerKind: outbox.producerKind,
					logicalRunId: outbox.logicalRunId,
					arrivalSeq: outbox.arrivalSeq,
				})
				.from(outbox)
				.where(
					and(
						eq(outbox.state, "pending"),
						options.afterId ? gt(outbox.id, options.afterId) : undefined,
					),
				)
				.orderBy(asc(outbox.id))
				.limit(Math.min(Math.max(options.limit ?? L.pageSize, 1), L.pageSize) + 1)
				.all();
		},
		/** Fail actual events, but preserve running tasks' reserved capacity until their result commits. */
		failRecipient(recipientId: string, reason: string) {
			return db.transaction((tx) => {
				const rows = tx
					.select({ id: outbox.id, state: outbox.state, deliveryId: outbox.deliveryId })
					.from(outbox)
					.where(
						and(
							eq(outbox.recipientId, recipientId),
							or(
								eq(outbox.state, "pending"),
								and(eq(outbox.state, "reserved"), isNull(outbox.lastError)),
							),
						),
					)
					.limit(L.pageSize)
					.all();
				for (const row of rows) {
					tx.update(outbox)
						.set({
							state: row.state === "reserved" ? "reserved" : "failed",
							lastError: boundedError(reason) || "Recipient permanently unavailable",
							updatedAt: new Date().toISOString(),
						})
						.where(eq(outbox.id, row.id))
						.run();
					if (row.state === "pending")
						setDeliveryProjectionStateTx(tx, recipientId, row.deliveryId, "failed");
				}
				return rows.length;
			});
		},
		/** Reclaim failed notices only after their source is no longer replayable; never evict a live slot. */
		collectFailed(ids: string[], canForget: (id: string, tx: RuntimeTx) => boolean) {
			return db.transaction((tx) => {
				let deleted = 0;
				for (const id of ids.slice(0, L.pageSize))
					if (canForget(id, tx) === true)
						deleted += tx
							.delete(outbox)
							.where(and(eq(outbox.id, id), eq(outbox.state, "failed")))
							.returning({ id: outbox.id })
							.all().length;
				return deleted;
			});
		},
	};
}
