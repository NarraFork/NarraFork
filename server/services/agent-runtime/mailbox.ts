import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import {
	narratorBufferedMessages as mailbox,
	narratorMessageRefs,
	narrators,
	runtimePublicationOutbox as outbox,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { MAILBOX_LIMITS as L } from "./limits";
// The dialect-neutral kernel lives in mailbox-shared.ts so the PostgreSQL adapter never
// runtime-imports this SQLite module. The re-export below keeps existing call sites stable.
import { boundedError, boundedJson, mailboxDedupeKey, pointer } from "./mailbox-shared";

export { boundedError, boundedJson, mailboxDedupeKey };

import type {
	EligibleMailboxHead,
	EnqueueResult,
	MailboxClaim,
	MailboxInput,
	MailboxRow,
	MaterializedBinding,
	Materializer,
	NoticeKind,
	RecoverableMailboxClaim,
	RuntimeDb,
	RuntimeStoreDb,
	RuntimeTx,
} from "./mailbox-types";
import { runAtomicWrite } from "./runtime-write";

const pendingStates = ["queued", "claimed", "failed"] as const;
const now = () => new Date().toISOString();
const releasedPayload = {
	text: "",
	metadataJson: null,
	payloadRefJson: null,
	imagesJson: null,
	textFilePathsJson: null,
	fileReferencesJson: null,
	creatorJson: null,
	commandText: null,
	bashCommand: null,
	byteSize: 0,
	projectedByteSize: 0,
} as const;
/**
 * Claim the next arrival sequence for a narrator's mailbox.
 *
 * Single-statement counter claim — `UPDATE … SET inbox_sequence = inbox_sequence + 1
 * … RETURNING` — which is also the per-narrator serialization point: on PostgreSQL
 * the narrators row lock makes concurrent claimants queue on this statement, so two
 * connections can never observe the same value (verified against a real PostgreSQL
 * 17 in tests/server/services/agent-runtime/pg-runtime-queue.test.ts). The claimed
 * value doubles as the row lock for the whole enqueue section that follows.
 *
 * PG contract, locked by that suite: gapless unique allocation per narrator under
 * concurrency; a rolled-back claim is re-issued (the bump rolls back with the
 * transaction); a claim against a missing narrator fails loudly (no row returned).
 */
export function allocateArrivalSequence(tx: RuntimeStoreDb, narratorId: string): number {
	const row = tx
		.update(narrators)
		.set({ inboxSequence: sql`${narrators.inboxSequence} + 1` })
		.where(eq(narrators.id, narratorId))
		.returning({ seq: narrators.inboxSequence })
		.get();
	if (!row) throw new Error("Mailbox recipient does not exist");
	return row.seq;
}
export function mailboxHasCapacity(
	tx: RuntimeStoreDb,
	narratorId: string,
	kind: MailboxRow["kind"],
	noticeKind?: NoticeKind,
): boolean {
	const cap =
		kind === "user_input"
			? L.userPending
			: kind === "agent_message"
				? L.agentPending
				: L.noticePending;
	const rows = tx
		.select({ id: mailbox.id })
		.from(mailbox)
		.where(
			and(
				eq(mailbox.narratorId, narratorId),
				eq(mailbox.kind, kind),
				kind === "task_notice" ? eq(mailbox.noticeKind, noticeKind as NoticeKind) : undefined,
				inArray(mailbox.state, pendingStates),
			),
		)
		.limit(cap)
		.all();
	return rows.length < cap;
}
/** No body reads/backfill in migration or list paths. Call repeatedly if an old queue exceeds one page. */
export function initializeLegacyMailbox(tx: RuntimeStoreDb, narratorId: string): boolean {
	const rows = tx
		.select({ id: mailbox.id })
		.from(mailbox)
		.where(and(eq(mailbox.narratorId, narratorId), isNull(mailbox.arrivalSeq)))
		.orderBy(asc(mailbox.seq), asc(mailbox.id))
		.limit(L.pageSize + 1)
		.all();
	for (const row of rows.slice(0, L.pageSize)) {
		const arrivalSeq = allocateArrivalSequence(tx, narratorId);
		tx.update(mailbox)
			.set({
				arrivalSeq,
				deliveryId: generateId(),
				recipientMessageId: generateId(),
				updatedAt: now(),
			})
			.where(and(eq(mailbox.id, row.id), isNull(mailbox.arrivalSeq)))
			.run();
	}
	return rows.length <= L.pageSize;
}
function validate(input: MailboxInput) {
	pointer(input.narratorId);
	const inlineBytes = Buffer.byteLength(input.text);
	const byteSize = input.payloadRef?.byteSize ?? inlineBytes;
	if (
		!Number.isSafeInteger(byteSize) ||
		byteSize < inlineBytes ||
		!Number.isSafeInteger(input.projectedByteSize) ||
		input.projectedByteSize < byteSize
	)
		throw new Error("Invalid payload/projection size");
	if (inlineBytes > L.inlineBytes)
		throw new Error("Large user payload requires a managed file reference");
	if (input.payloadRef) {
		pointer(input.payloadRef.path);
		if (input.kind !== "user_input")
			throw new Error("Only user inputs may use large body references");
	}
	if (
		input.kind === "agent_message" &&
		(byteSize > L.agentBodyBytes || input.projectedByteSize > L.agentProjectedBytes)
	)
		throw new Error("Send exceeds body/projection limit; use a file reference or summary");
	const metadataJson = input.metadata
		? boundedJson(
				input.metadata,
				input.kind === "task_notice" ? L.publicationBytes : L.metadataBytes,
			)
		: null;
	const payloadRefJson = input.payloadRef ? boundedJson(input.payloadRef, L.metadataBytes) : null;
	if (
		input.kind === "task_notice" &&
		inlineBytes + Buffer.byteLength(metadataJson ?? "") > L.publicationBytes
	)
		throw new Error("Task notice must contain only a bounded summary and pointers");
	if (input.kind === "user_input") {
		const refs = [
			input.imagesJson,
			input.creatorJson,
			input.textFilePathsJson,
			input.fileReferencesJson,
			input.commandText,
			input.bashCommand,
		];
		if (
			refs.reduce((n, value) => n + Buffer.byteLength(value ?? ""), 0) +
				Buffer.byteLength(metadataJson ?? "") +
				Buffer.byteLength(payloadRefJson ?? "") >
			L.metadataBytes
		)
			throw new Error("Attachment metadata exceeds mailbox budget; use bounded references");
	}
	return { byteSize, metadataJson, payloadRefJson };
}
export function createMailboxStore(db: RuntimeDb) {
	function getByDelivery(deliveryId: string, tx: RuntimeStoreDb = db) {
		return tx.select().from(mailbox).where(eq(mailbox.deliveryId, deliveryId)).get();
	}
	function enqueue(input: MailboxInput, tx?: RuntimeTx): EnqueueResult {
		if (!tx) return runAtomicWrite(db, "mailbox.enqueue", (inner) => enqueue(input, inner));
		const dedupeKey = mailboxDedupeKey(input);
		const existing = tx
			.select()
			.from(mailbox)
			.where(and(eq(mailbox.narratorId, input.narratorId), eq(mailbox.dedupeKey, dedupeKey)))
			.get();
		if (existing) return { status: "duplicate", delivery: existing };
		// Lost confirmations replay the original receipt even if the sender was subsequently deleted.
		// Only a first acceptance must prove its referenced source exists in this same transaction.
		if (
			input.kind === "agent_message" &&
			!tx
				.select({ id: narrators.id })
				.from(narrators)
				.where(eq(narrators.id, input.sourceNarratorId))
				.get()
		)
			throw new Error("Mailbox source narrator does not exist");
		const sizes = validate(input);
		if (input.kind === "task_notice") {
			const earlier = tx
				.select({ id: outbox.id })
				.from(outbox)
				.where(
					and(
						eq(outbox.recipientId, input.narratorId),
						eq(outbox.producerKind, input.noticeKind),
						eq(outbox.state, "pending"),
					),
				)
				.limit(1)
				.get();
			if (earlier) return { status: "publication_pending" };
		}
		if (
			!mailboxHasCapacity(
				tx,
				input.narratorId,
				input.kind,
				input.kind === "task_notice" ? input.noticeKind : undefined,
			)
		)
			return { status: "full" };
		if (!initializeLegacyMailbox(tx, input.narratorId))
			throw new Error("Legacy mailbox requires another bounded initialization page");
		const arrivalSeq = allocateArrivalSequence(tx, input.narratorId);
		const time = now();
		const delivery = tx
			.insert(mailbox)
			.values({
				id: generateId(),
				narratorId: input.narratorId,
				text: input.text,
				kind: input.kind,
				noticeKind: input.kind === "task_notice" ? input.noticeKind : null,
				dedupeKey,
				deliveryId: generateId(),
				recipientMessageId:
					input.kind === "agent_message"
						? (input.recipientMessageId ?? generateId())
						: generateId(),
				sourceNarratorId: input.kind === "agent_message" ? input.sourceNarratorId : null,
				sourceToolCallId: input.kind === "agent_message" ? input.sourceToolCallId : null,
				sourceAttempt: input.kind === "agent_message" ? input.sourceAttempt : null,
				sourceKey: input.kind !== "user_input" ? input.sourceKey : input.requestKey,
				...sizes,
				projectedByteSize: input.projectedByteSize,
				arrivalSeq,
				seq: input.kind === "user_input" ? (input.seq ?? arrivalSeq) : arrivalSeq,
				priority: input.kind === "user_input" ? (input.priority ?? false) : false,
				createdBy: input.createdBy ?? null,
				...(input.kind === "user_input"
					? {
							imagesJson: input.imagesJson,
							creatorJson: input.creatorJson,
							textFilePathsJson: input.textFilePathsJson,
							fileReferencesJson: input.fileReferencesJson,
							commandText: input.commandText,
							bashCommand: input.bashCommand,
						}
					: {}),
				bufferedAt: time,
				updatedAt: time,
				dedupeExpiresAt:
					input.kind === "user_input"
						? new Date(Date.now() + L.userDedupeTtlMs).toISOString()
						: null,
			})
			.returning()
			.get();
		return { status: "accepted", delivery };
	}
	function claimWhere(claim: MailboxClaim) {
		return and(
			eq(mailbox.id, claim.id),
			eq(mailbox.narratorId, claim.narratorId),
			eq(mailbox.state, "claimed"),
			eq(mailbox.claimToken, claim.token),
			eq(mailbox.claimEpoch, claim.epoch),
		);
	}
	function requireClaim(tx: RuntimeStoreDb, claim: MailboxClaim): MailboxRow {
		const row = tx.select().from(mailbox).where(claimWhere(claim)).get();
		if (!row) throw new Error("Stale mailbox claim");
		return row;
	}
	function materializeInTransaction(
		tx: RuntimeTx,
		claim: MailboxClaim,
		binding: MaterializedBinding,
	) {
		const row = requireClaim(tx, claim);
		if (binding.messageId !== row.recipientMessageId)
			throw new Error("Materializer must use reserved message identity");
		const ref = tx
			.select({ id: narratorMessageRefs.id })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.id, binding.refId),
					eq(narratorMessageRefs.narratorId, row.narratorId),
					eq(narratorMessageRefs.messageId, binding.messageId),
				),
			)
			.get();
		if (!ref) throw new Error("Materializer did not persist the recipient ref in this transaction");
		return tx
			.update(mailbox)
			.set({
				state: "materialized",
				recipientRefId: ref.id,
				currentMessageId: binding.messageId,
				contentRevision: binding.revision ?? row.contentRevision,
				currentRevision: binding.revision ?? row.contentRevision,
				...releasedPayload,
				claimToken: null,
				claimEpoch: null,
				claimedAt: null,
				lastError: null,
				updatedAt: now(),
			})
			.where(claimWhere(claim))
			.returning()
			.get();
	}
	/** Current edited content is acknowledged independently; this never changes the original Send receipt. */
	function ackCurrentRevision(
		deliveryId: string,
		narratorId: string,
		refId: string,
		revision: number,
		at = now(),
	) {
		if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(Date.parse(at)))
			return false;
		return runAtomicWrite(db, "mailbox.ackCurrentRevision", (tx) => {
			const row = getByDelivery(deliveryId, tx);
			if (
				!row ||
				row.narratorId !== narratorId ||
				row.recipientRefId !== refId ||
				row.currentRevision !== revision ||
				row.receiptDisposition === "recipient_deleted" ||
				row.state !== "materialized" ||
				!row.currentMessageId
			)
				return false;
			const ref = tx
				.select({ id: narratorMessageRefs.id, adoptedAt: narratorMessageRefs.injectionConsumedAt })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.id, refId),
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, row.currentMessageId),
					),
				)
				.get();
			if (!ref) return false;
			if (!ref.adoptedAt)
				tx.update(narratorMessageRefs)
					.set({ injectionConsumedAt: new Date(at) })
					.where(
						and(
							eq(narratorMessageRefs.id, refId),
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, row.currentMessageId),
						),
					)
					.run();
			return (
				tx
					.update(mailbox)
					.set({
						currentAdoptedRevision: revision,
						currentAdoptedAt: row.currentAdoptedAt ?? ref.adoptedAt?.toISOString() ?? at,
						updatedAt: now(),
					})
					.where(
						and(
							eq(mailbox.id, row.id),
							eq(mailbox.currentRevision, revision),
							eq(mailbox.currentMessageId, row.currentMessageId),
							eq(mailbox.receiptDisposition, row.receiptDisposition),
						),
					)
					.returning({ id: mailbox.id })
					.all().length === 1
			);
		});
	}
	function eligibleHeads(tx: RuntimeTx, narratorId: string, count: number): EligibleMailboxHead[] {
		const barrier = tx
			.select({ arrivalSeq: outbox.arrivalSeq })
			.from(outbox)
			.where(and(eq(outbox.recipientId, narratorId), eq(outbox.state, "pending")))
			.orderBy(asc(outbox.arrivalSeq))
			.limit(1)
			.get()?.arrivalSeq;
		return tx
			.select({
				id: mailbox.id,
				narratorId: mailbox.narratorId,
				kind: mailbox.kind,
				metadataJson: mailbox.metadataJson,
				projectedByteSize: mailbox.projectedByteSize,
				arrivalSeq: mailbox.arrivalSeq,
				seq: mailbox.seq,
				priority: mailbox.priority,
				createdBy: mailbox.createdBy,
				deliveryId: mailbox.deliveryId,
			})
			.from(mailbox)
			.where(
				and(
					eq(mailbox.narratorId, narratorId),
					eq(mailbox.state, "queued"),
					barrier == null ? undefined : lt(mailbox.arrivalSeq, barrier),
				),
			)
			.orderBy(
				desc(mailbox.priority),
				sql`CASE WHEN ${mailbox.kind} = 'user_input' THEN ${mailbox.seq} ELSE ${mailbox.arrivalSeq} END`,
				asc(mailbox.arrivalSeq),
			)
			.limit(count)
			.all();
	}
	/** Predicate and exact-ID claim use the same transaction and the same publication-aware head. */
	function claimEligibleHead(
		narratorId: string,
		owner: { token: string; epoch: string },
		accepts: (head: EligibleMailboxHead) => boolean = () => true,
	): MailboxRow | undefined {
		pointer(owner.token);
		pointer(owner.epoch);
		return runAtomicWrite(db, "mailbox.claimEligibleHead", (tx) => {
			if (!initializeLegacyMailbox(tx, narratorId)) return undefined;
			const head = eligibleHeads(tx, narratorId, 1)[0];
			if (!head || accepts(head) !== true) return undefined;
			return tx
				.update(mailbox)
				.set({
					state: "claimed",
					claimToken: owner.token,
					claimEpoch: owner.epoch,
					claimedAt: now(),
					claimAttempts: sql`${mailbox.claimAttempts} + 1`,
					updatedAt: now(),
				})
				.where(
					and(
						eq(mailbox.id, head.id),
						eq(mailbox.narratorId, narratorId),
						eq(mailbox.state, "queued"),
					),
				)
				.returning()
				.get();
		});
	}
	/** Only call under the single-instance lock during cold bootstrap, before admitting owners.
	 * Legacy unprefixed tokens need an explicit per-owner termination decision, never TTL takeover.
	 */
	function recoverForeignProcessClaims(
		currentProcessId: string,
		options: {
			afterId?: string;
			limit?: number;
			legacyOwnerTerminated?: (claim: RecoverableMailboxClaim) => boolean;
		} = {},
	) {
		pointer(currentProcessId);
		if (!/^[A-Za-z0-9_-]+$/.test(currentProcessId)) throw new Error("Invalid process identity");
		const prefix = `process:${currentProcessId}:`;
		const limit = Math.min(Math.max(options.limit ?? L.pageSize, 1), L.pageSize);
		return runAtomicWrite(db, "mailbox.recoverForeignProcessClaims", (tx) => {
			const page = tx
				.select({
					id: mailbox.id,
					narratorId: mailbox.narratorId,
					claimToken: mailbox.claimToken,
					claimEpoch: mailbox.claimEpoch,
				})
				.from(mailbox)
				.where(
					and(
						eq(mailbox.state, "claimed"),
						options.afterId ? gt(mailbox.id, options.afterId) : undefined,
					),
				)
				.orderBy(asc(mailbox.id))
				.limit(limit + 1)
				.all();
			let recovered = 0;
			for (const row of page.slice(0, limit)) {
				if (row.claimToken?.startsWith(prefix)) continue;
				const hasProcessIdentity = /^process:[A-Za-z0-9_-]+:.+$/.test(row.claimToken ?? "");
				if (!hasProcessIdentity && options.legacyOwnerTerminated?.(row) !== true) continue;
				recovered += tx
					.update(mailbox)
					.set({
						state: "queued",
						claimToken: null,
						claimEpoch: null,
						claimedAt: null,
						updatedAt: now(),
					})
					.where(
						and(
							eq(mailbox.id, row.id),
							eq(mailbox.state, "claimed"),
							row.claimToken == null
								? isNull(mailbox.claimToken)
								: eq(mailbox.claimToken, row.claimToken),
							row.claimEpoch == null
								? isNull(mailbox.claimEpoch)
								: eq(mailbox.claimEpoch, row.claimEpoch),
						),
					)
					.returning({ id: mailbox.id })
					.all().length;
			}
			return { recovered, nextAfterId: page.length > limit ? page[limit - 1]?.id : undefined };
		});
	}
	return {
		enqueue,
		getByDelivery,
		claimEligibleHead,
		recoverForeignProcessClaims,
		materializeInTransaction,
		ackCurrentRevision,
		ackCurrentAdopted: ackCurrentRevision,
		/** Old Send metadata retains its reserved address even after structural COW. */
		resolveReservedMessage(
			narratorId: string,
			recipientMessageId: string,
			tx: RuntimeStoreDb = db,
		) {
			return tx
				.select({
					deliveryId: mailbox.deliveryId,
					recipientRefId: mailbox.recipientRefId,
					currentMessageId: mailbox.currentMessageId,
					receiptDisposition: mailbox.receiptDisposition,
					contentRevision: mailbox.contentRevision,
					adoptedRevision: mailbox.adoptedRevision,
					adoptedAt: mailbox.adoptedAt,
					currentRevision: mailbox.currentRevision,
					currentAdoptedRevision: mailbox.currentAdoptedRevision,
					currentAdoptedAt: mailbox.currentAdoptedAt,
				})
				.from(mailbox)
				.where(
					and(
						eq(mailbox.narratorId, narratorId),
						eq(mailbox.recipientMessageId, recipientMessageId),
					),
				)
				.limit(1)
				.get();
		},
		initializeLegacy(narratorId: string) {
			return runAtomicWrite(db, "mailbox.initializeLegacy", (tx) =>
				initializeLegacyMailbox(tx, narratorId),
			);
		},
		/** Body/attachment columns are deliberately absent. */
		list(
			narratorId: string,
			options: {
				after?: number;
				limit?: number;
				state?: MailboxRow["state"];
				kind?: MailboxRow["kind"];
			} = {},
		) {
			return db
				.select({
					id: mailbox.id,
					kind: mailbox.kind,
					state: mailbox.state,
					arrivalSeq: mailbox.arrivalSeq,
					seq: mailbox.seq,
					priority: mailbox.priority,
					byteSize: mailbox.byteSize,
					deliveryId: mailbox.deliveryId,
					receiptDisposition: mailbox.receiptDisposition,
					lastError: mailbox.lastError,
				})
				.from(mailbox)
				.where(
					and(
						eq(mailbox.narratorId, narratorId),
						options.after === undefined ? undefined : gt(mailbox.arrivalSeq, options.after),
						options.state ? eq(mailbox.state, options.state) : undefined,
						options.kind ? eq(mailbox.kind, options.kind) : undefined,
					),
				)
				.orderBy(asc(mailbox.arrivalSeq), asc(mailbox.id))
				.limit(Math.min(Math.max(options.limit ?? L.pageSize, 1), L.pageSize) + 1)
				.all();
		},
		claimBatch(
			narratorId: string,
			owner: { token: string; epoch: string },
			budget: { count?: number; bytes?: number } = {},
		) {
			pointer(owner.token);
			pointer(owner.epoch);
			return runAtomicWrite(db, "mailbox.claimBatch", (tx) => {
				if (!initializeLegacyMailbox(tx, narratorId)) return [];
				const rows = eligibleHeads(
					tx,
					narratorId,
					Math.min(Math.max(budget.count ?? L.batchCount, 1), L.batchCount),
				);
				const claimed: MailboxRow[] = [];
				let bytes = 0;
				for (const candidate of rows) {
					// User input carries principal/command/attachment barriers; it always gets its own pass.
					if (
						claimed.length &&
						(candidate.kind === "user_input" ||
							claimed[0]?.kind === "user_input" ||
							bytes + candidate.projectedByteSize >
								Math.min(budget.bytes ?? L.batchBytes, L.batchBytes))
					)
						break;
					const row = tx
						.update(mailbox)
						.set({
							state: "claimed",
							claimToken: owner.token,
							claimEpoch: owner.epoch,
							claimedAt: now(),
							claimAttempts: sql`${mailbox.claimAttempts} + 1`,
							updatedAt: now(),
						})
						.where(and(eq(mailbox.id, candidate.id), eq(mailbox.state, "queued")))
						.returning()
						.get();
					if (row) {
						claimed.push(row);
						bytes += row.projectedByteSize;
					}
					if (bytes >= Math.min(budget.bytes ?? L.batchBytes, L.batchBytes)) break;
				}
				return claimed;
			});
		},
		materialize(claim: MailboxClaim, materializer: Materializer) {
			return runAtomicWrite(db, "mailbox.materialize", (tx) => {
				const row = requireClaim(tx, claim);
				const binding = materializer(tx, row);
				if (binding && typeof (binding as unknown as { then?: unknown }).then === "function")
					throw new Error("Materializer must be synchronous");
				return materializeInTransaction(tx, claim, binding);
			});
		},
		failClaim(claim: MailboxClaim, error: string) {
			return runAtomicWrite(db, "mailbox.failClaim", (tx) => {
				const row = requireClaim(tx, claim);
				return (
					tx
						.update(mailbox)
						.set({
							state: row.claimAttempts >= L.claimMaxAttempts ? "failed" : "queued",
							claimToken: null,
							claimEpoch: null,
							claimedAt: null,
							lastError: boundedError(error),
							updatedAt: now(),
						})
						.where(claimWhere(claim))
						.returning({ id: mailbox.id })
						.all().length === 1
				);
			});
		},
		recoverClaims(narratorId: string, terminatedEpoch: string, proof: { ownerTerminated: true }) {
			if (proof.ownerTerminated !== true)
				throw new Error("Owner termination proof required; elapsed time is insufficient");
			return runAtomicWrite(db, "mailbox.recoverClaims", (tx) => {
				const rows = tx
					.select({ id: mailbox.id })
					.from(mailbox)
					.where(
						and(
							eq(mailbox.narratorId, narratorId),
							eq(mailbox.state, "claimed"),
							eq(mailbox.claimEpoch, terminatedEpoch),
						),
					)
					.limit(L.pageSize)
					.all();
				for (const row of rows)
					tx.update(mailbox)
						.set({
							state: "queued",
							claimToken: null,
							claimEpoch: null,
							claimedAt: null,
							updatedAt: now(),
						})
						.where(and(eq(mailbox.id, row.id), eq(mailbox.claimEpoch, terminatedEpoch)))
						.run();
				return rows.length;
			});
		},
		retryFailed(deliveryId: string) {
			return (
				db
					.update(mailbox)
					.set({ state: "queued", claimAttempts: 0, lastError: null, updatedAt: now() })
					.where(and(eq(mailbox.deliveryId, deliveryId), eq(mailbox.state, "failed")))
					.returning({ id: mailbox.id })
					.all().length === 1
			);
		},
		/** Never unlinks files: uploaded/history files may be shared. Claimed payload cannot be cancelled here. */
		cancel(deliveryId: string, reason: string) {
			return (
				db
					.update(mailbox)
					.set({
						state: "cancelled",
						text: "",
						imagesJson: null,
						textFilePathsJson: null,
						fileReferencesJson: null,
						payloadRefJson: null,
						metadataJson: null,
						creatorJson: null,
						commandText: null,
						bashCommand: null,
						byteSize: 0,
						projectedByteSize: 0,
						lastError: boundedError(reason),
						updatedAt: now(),
					})
					.where(
						and(eq(mailbox.deliveryId, deliveryId), inArray(mailbox.state, ["queued", "failed"])),
					)
					.returning({ id: mailbox.id })
					.all().length === 1
			);
		},
		/** Revert/cancel owner uses its exact claim; arbitrary UI cancellation cannot release another owner's payload. */
		cancelClaim(claim: MailboxClaim, reason: string) {
			return runAtomicWrite(db, "mailbox.cancelClaim", (tx) => {
				requireClaim(tx, claim);
				return (
					tx
						.update(mailbox)
						.set({
							...releasedPayload,
							state: "cancelled",
							claimToken: null,
							claimEpoch: null,
							claimedAt: null,
							lastError: boundedError(reason),
							updatedAt: now(),
						})
						.where(claimWhere(claim))
						.returning({ id: mailbox.id })
						.all().length === 1
				);
			});
		},
		/** Legacy clear is a user-only projection, not DELETE WHERE narrator_id. Each call handles one page. */
		cancelUserPage(narratorId: string, reason: string) {
			return runAtomicWrite(db, "mailbox.cancelUserPage", (tx) => {
				const rows = tx
					.select({ id: mailbox.id })
					.from(mailbox)
					.where(
						and(
							eq(mailbox.narratorId, narratorId),
							eq(mailbox.kind, "user_input"),
							inArray(mailbox.state, ["queued", "failed"]),
						),
					)
					.limit(L.pageSize)
					.all();
				if (!rows.length) return [];
				return tx
					.update(mailbox)
					.set({
						...releasedPayload,
						state: "cancelled",
						lastError: boundedError(reason),
						updatedAt: now(),
					})
					.where(
						and(
							inArray(
								mailbox.id,
								rows.map((row) => row.id),
							),
							eq(mailbox.kind, "user_input"),
							inArray(mailbox.state, ["queued", "failed"]),
						),
					)
					.returning({ id: mailbox.id })
					.all();
			});
		},
		/** Only unclaimed user entries are editable. Delivery dedupe identity is not rewritten. */
		editUser(
			deliveryId: string,
			patch: { text: string; projectedByteSize: number; seq?: number; priority?: boolean },
		) {
			validate({
				kind: "user_input",
				narratorId: "edit",
				text: patch.text,
				projectedByteSize: patch.projectedByteSize,
			});
			return (
				db
					.update(mailbox)
					.set({
						...patch,
						byteSize: Buffer.byteLength(patch.text),
						contentRevision: sql`${mailbox.contentRevision} + 1`,
						updatedAt: now(),
					})
					.where(
						and(
							eq(mailbox.deliveryId, deliveryId),
							eq(mailbox.kind, "user_input"),
							eq(mailbox.state, "queued"),
							isNull(mailbox.payloadRefJson),
						),
					)
					.returning({ id: mailbox.id })
					.all().length === 1
			);
		},
		/** Call inside the history COW/edit/delete transaction, never for a fork's newly-created ref. */
		updateRecipientRef(
			tx: RuntimeTx,
			narratorId: string,
			refId: string,
			change:
				| { kind: "cow"; messageId: string }
				| { kind: "semantic_edit"; messageId: string }
				| { kind: "deleted" },
		) {
			if (change.kind !== "deleted") {
				const actual = tx
					.select({ id: narratorMessageRefs.id })
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.id, refId),
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, change.messageId),
						),
					)
					.get();
				if (!actual) throw new Error("Recipient ref mutation must commit atomically");
				// The old delivery keeps its adopted revision, but the edited content needs a new input-adoption fact.
				if (change.kind === "semantic_edit")
					tx.update(narratorMessageRefs)
						.set({ injectionConsumedAt: null })
						.where(eq(narratorMessageRefs.id, refId))
						.run();
			}
			return tx
				.update(mailbox)
				.set({
					currentMessageId: change.kind === "deleted" ? null : change.messageId,
					...(change.kind === "semantic_edit"
						? {
								receiptDisposition: "superseded" as const,
								currentRevision: sql`max(${mailbox.currentRevision}, ${mailbox.contentRevision}) + 1`,
								currentAdoptedRevision: null,
								currentAdoptedAt: null,
							}
						: change.kind === "deleted"
							? { receiptDisposition: "recipient_deleted" as const }
							: {}),
					updatedAt: now(),
				})
				.where(
					and(
						eq(mailbox.narratorId, narratorId),
						eq(mailbox.recipientRefId, refId),
						eq(mailbox.state, "materialized"),
					),
				)
				.returning({ id: mailbox.id })
				.all().length;
		},
		ackAdopted(
			deliveryId: string,
			narratorId: string,
			refId: string,
			revision: number,
			at = now(),
		) {
			return runAtomicWrite(db, "mailbox.ackAdopted", (tx) => {
				const row = getByDelivery(deliveryId, tx);
				if (
					!row ||
					row.narratorId !== narratorId ||
					row.recipientRefId !== refId ||
					row.contentRevision !== revision ||
					row.receiptDisposition !== "active" ||
					row.state !== "materialized"
				)
					return false;
				const result = tx
					.update(narratorMessageRefs)
					.set({ injectionConsumedAt: new Date(at) })
					.where(
						and(
							eq(narratorMessageRefs.id, refId),
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, row.currentMessageId ?? ""),
							isNull(narratorMessageRefs.injectionConsumedAt),
						),
					)
					.returning({ id: narratorMessageRefs.id })
					.all();
				if (
					!result.length &&
					!tx
						.select({ id: narratorMessageRefs.id })
						.from(narratorMessageRefs)
						.where(
							and(
								eq(narratorMessageRefs.id, refId),
								eq(narratorMessageRefs.narratorId, narratorId),
								eq(narratorMessageRefs.messageId, row.currentMessageId ?? ""),
							),
						)
						.get()
				)
					return false;
				tx.update(mailbox)
					.set({
						adoptedRevision: revision,
						adoptedAt: row.adoptedAt ?? at,
						currentRevision: revision,
						currentAdoptedRevision: revision,
						currentAdoptedAt: row.currentAdoptedAt ?? row.adoptedAt ?? at,
						updatedAt: now(),
					})
					.where(eq(mailbox.id, row.id))
					.run();
				return true;
			});
		},
		/** Caller must prove source/checkpoint/COW liveness under the existing root mutation barrier. */
		collectTombstones(
			ids: string[],
			canForget: (
				row: Pick<
					MailboxRow,
					"id" | "sourceNarratorId" | "sourceToolCallId" | "sourceAttempt" | "sourceKey" | "kind"
				>,
				tx: RuntimeTx,
			) => boolean,
		) {
			return runAtomicWrite(db, "mailbox.collectTombstones", (tx) => {
				let deleted = 0;
				for (const id of ids.slice(0, L.pageSize)) {
					const row = tx
						.select({
							id: mailbox.id,
							sourceNarratorId: mailbox.sourceNarratorId,
							sourceToolCallId: mailbox.sourceToolCallId,
							sourceAttempt: mailbox.sourceAttempt,
							sourceKey: mailbox.sourceKey,
							kind: mailbox.kind,
							dedupeExpiresAt: mailbox.dedupeExpiresAt,
						})
						.from(mailbox)
						.where(and(eq(mailbox.id, id), inArray(mailbox.state, ["materialized", "cancelled"])))
						.get();
					if (
						!row ||
						(row.kind === "user_input" && (!row.dedupeExpiresAt || row.dedupeExpiresAt > now())) ||
						canForget(row, tx) !== true
					)
						continue;
					deleted += tx
						.delete(mailbox)
						.where(eq(mailbox.id, id))
						.returning({ id: mailbox.id })
						.all().length;
				}
				return deleted;
			});
		},
	};
}
