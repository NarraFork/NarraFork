import { formatOriginLabel, type MessageOriginOptions } from "@shared/message-origin";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { narratorBufferedMessages as mailbox, narrators, narratorToolCalls } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import type { Locale } from "../../lib/prompt-i18n";
import type { AgentMessageDelivery } from "../agent-message-delivery";
import { getNarratorMessageRefsPort } from "../narrator-refs/store";
import { createMailboxStore, mailboxDedupeKey } from "./mailbox";
import type { MailboxClaim, MailboxInput, MailboxKind } from "./mailbox-types";
import { getExecutionOwner, tryClaimExecution } from "./ownership";
import {
	flushRuntimePublications,
	isRuntimePublicationUnavailableError,
	setRuntimePublicationWake,
} from "./publication";
import {
	getRuntimeQueuePort,
	type RuntimeMailboxRow,
	requireRuntimeQueuePort,
} from "./runtime-queue-port";

// Resolve the current DB binding per operation (hot reload and isolated test repositories).
export const inboxProcessTokenPrefix = hotSafe(
	"narrafork.runtime-inbox-process-prefix",
	() => `process:${generateId()}:`,
);
export const inboxProcessId = inboxProcessTokenPrefix.slice("process:".length, -1);
export const runtimeInbox = new Proxy({} as ReturnType<typeof createMailboxStore>, {
	get: (_target, key) => Reflect.get(createMailboxStore(db), key),
});
export interface InboxAgentMetadata {
	delivery: Omit<AgentMessageDelivery, "text">;
	projection: { prefix: string; suffix: string };
	channel: "buffer" | "parent" | "team";
	isBroadcast?: boolean;
	fromMessageId?: string | null;
	/** Initiating user for the producing pass; null/undefined means unattributed. */
	userId?: string | null;
}

export function inboxMetadata<T>(row: Pick<RuntimeMailboxRow, "metadataJson">): T {
	return JSON.parse(row.metadataJson ?? "{}") as T;
}
export function assertInboxClaimOwner(claim: MailboxClaim): void {
	if (getExecutionOwner(claim.narratorId)?.epoch !== claim.epoch)
		throw new Error("Stale mailbox execution owner");
}
export function inboxClaim(row: RuntimeMailboxRow): MailboxClaim {
	if (row.state !== "claimed" || !row.claimToken || !row.claimEpoch)
		throw new Error("Mailbox row has no live claim");
	return { id: row.id, narratorId: row.narratorId, token: row.claimToken, epoch: row.claimEpoch };
}
export function inboxConsumption(
	row: RuntimeMailboxRow,
): import("../agent-message-delivery").MailboxDeliveryConsumption {
	if (!row.deliveryId) throw new Error("Mailbox delivery identity missing");
	return {
		deliveryId: row.deliveryId,
		recipientNarratorId: row.narratorId,
		recipientMessageId: row.recipientMessageId ?? undefined,
		recipientRefId: row.recipientRefId ?? undefined,
		revision: row.contentRevision,
	};
}
export function inboxDelivery(row: RuntimeMailboxRow): AgentMessageDelivery {
	if (!row.deliveryId || !row.recipientMessageId)
		throw new Error("Mailbox delivery identity missing");
	const metadata = inboxMetadata<InboxAgentMetadata>(row);
	return {
		...metadata.delivery,
		recipientMessageId: row.currentMessageId ?? row.recipientMessageId,
		text: row.text,
		deliveryId: row.deliveryId,
		recipientRefId: row.recipientRefId ?? undefined,
		revision: row.contentRevision,
		...(row.state === "claimed" ? { mailboxClaim: inboxClaim(row) } : {}),
	};
}
export function inboxAgentText(row: RuntimeMailboxRow): string {
	const { projection } = inboxMetadata<InboxAgentMetadata>(row);
	return `${projection.prefix}${row.text}${projection.suffix}`;
}

/**
 * The enqueue verdict over the backend-neutral row. Capacity verdicts
 * ("full"/"publication_pending") are thrown as "Target message queue is full" before
 * returning, matching the long-standing producer contract — callers only see rows.
 */
export type InboxEnqueueResult = {
	status: "accepted" | "duplicate";
	delivery: RuntimeMailboxRow;
};

/**
 * Ordinary Send/TeamStatus acceptance requires the real persisted execution receipt.
 *
 * Backend dispatch: SQLite keeps the original synchronous check-then-enqueue segment
 * (dedupe → receipt → projection → enqueue) exactly as before; PostgreSQL runs the
 * dedupe + execution receipt validation + insert inside ONE named admission operation
 * (`mailbox.admitAgentMessage`), so there is no "check SQLite, then enqueue" split
 * window on the PG path.
 */
export async function enqueueInboxAgent(
	delivery: AgentMessageDelivery,
	modelText: string,
	options: {
		channel?: InboxAgentMetadata["channel"];
		createdBy?: string | null;
		userId?: string | null;
		isBroadcast?: boolean;
		fromMessageId?: string | null;
	} = {},
): Promise<InboxEnqueueResult> {
	const binding = delivery.senderToolCallBinding;
	if (!binding) throw new Error("Agent message requires exact tool execution receipt");
	const port = getRuntimeQueuePort();
	if (port) return enqueueInboxAgentPg(port, delivery, modelText, options);
	return enqueueInboxAgentSqlite(delivery, modelText, options);
}

function enqueueInboxAgentSqlite(
	delivery: AgentMessageDelivery,
	modelText: string,
	options: {
		channel?: InboxAgentMetadata["channel"];
		createdBy?: string | null;
		userId?: string | null;
		isBroadcast?: boolean;
		fromMessageId?: string | null;
	},
): InboxEnqueueResult {
	const binding = delivery.senderToolCallBinding;
	if (!binding) throw new Error("Agent message requires exact tool execution receipt");
	const dedupeKey = mailboxDedupeKey({
		kind: "agent_message",
		narratorId: delivery.recipientNarratorId,
		text: "",
		projectedByteSize: 0,
		sourceNarratorId: delivery.sender.id,
		sourceToolCallId: binding.toolCallId,
		sourceAttempt: binding.attempt,
		sourceKey: "send",
	});
	const existing = db
		.select()
		.from(mailbox)
		.where(
			and(eq(mailbox.narratorId, delivery.recipientNarratorId), eq(mailbox.dedupeKey, dedupeKey)),
		)
		.get();
	if (existing) {
		delivery.recipientMessageId =
			existing.currentMessageId ?? existing.recipientMessageId ?? delivery.recipientMessageId;
		delivery.deliveryId = existing.deliveryId ?? undefined;
		delivery.recipientRefId = existing.recipientRefId ?? undefined;
		delivery.revision = existing.contentRevision;
		return { status: "duplicate" as const, delivery: existing };
	}
	const source = db
		.select({
			id: narratorToolCalls.id,
			narratorId: narratorToolCalls.narratorId,
			attempt: narratorToolCalls.executionAttempt,
			toolUseId: narratorToolCalls.toolUseId,
			identityVersion: narratorToolCalls.executionIdentityVersion,
			originToolCallId: narratorToolCalls.executionOriginToolCallId,
		})
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, binding.toolCallId))
		.get();
	if (
		!source ||
		source.narratorId !== delivery.sender.id ||
		source.attempt !== binding.attempt ||
		source.toolUseId !== delivery.fromToolUseId ||
		source.identityVersion !== 1 ||
		source.originToolCallId !== null
	)
		throw new Error("Agent message execution receipt is stale or missing");
	const index = modelText.indexOf(delivery.text);
	if (index < 0) throw new Error("Agent model projection must contain its reader-facing body");
	const { text, ...coordinates } = delivery;
	const result = runtimeInbox.enqueue({
		kind: "agent_message",
		narratorId: delivery.recipientNarratorId,
		text,
		projectedByteSize: Math.max(Buffer.byteLength(modelText), Buffer.byteLength(text)) + 4096,
		sourceNarratorId: delivery.sender.id,
		sourceToolCallId: binding.toolCallId,
		sourceAttempt: binding.attempt,
		sourceKey: "send",
		recipientMessageId: delivery.recipientMessageId,
		createdBy: options.createdBy,
		metadata: {
			delivery: coordinates,
			projection: {
				prefix: modelText.slice(0, index),
				suffix: modelText.slice(index + text.length),
			},
			channel: options.channel ?? "buffer",
			isBroadcast: options.isBroadcast,
			fromMessageId: options.fromMessageId,
			userId: options.userId ?? options.createdBy ?? null,
		},
	});
	if (!("delivery" in result)) throw new Error("Target message queue is full");
	// Retries navigate to the original delivery, including its negative tombstone.
	delivery.recipientMessageId =
		result.delivery.currentMessageId ??
		result.delivery.recipientMessageId ??
		delivery.recipientMessageId;
	delivery.deliveryId = result.delivery.deliveryId ?? undefined;
	delivery.recipientRefId = result.delivery.recipientRefId ?? undefined;
	delivery.revision = result.delivery.contentRevision;
	return result;
}

async function enqueueInboxAgentPg(
	port: NonNullable<ReturnType<typeof getRuntimeQueuePort>>,
	delivery: AgentMessageDelivery,
	modelText: string,
	options: {
		channel?: InboxAgentMetadata["channel"];
		createdBy?: string | null;
		userId?: string | null;
		isBroadcast?: boolean;
		fromMessageId?: string | null;
	},
): Promise<InboxEnqueueResult> {
	const binding = delivery.senderToolCallBinding;
	if (!binding) throw new Error("Agent message requires exact tool execution receipt");
	// The projection split is a pure local validation; the admission section re-checks
	// dedupe and the execution receipt inside one PG transaction.
	const index = modelText.indexOf(delivery.text);
	if (index < 0) throw new Error("Agent model projection must contain its reader-facing body");
	const { text, ...coordinates } = delivery;
	const input: MailboxInput = {
		kind: "agent_message",
		narratorId: delivery.recipientNarratorId,
		text,
		projectedByteSize: Math.max(Buffer.byteLength(modelText), Buffer.byteLength(text)) + 4096,
		sourceNarratorId: delivery.sender.id,
		sourceToolCallId: binding.toolCallId,
		sourceAttempt: binding.attempt,
		sourceKey: "send",
		recipientMessageId: delivery.recipientMessageId,
		createdBy: options.createdBy,
		metadata: {
			delivery: coordinates,
			projection: {
				prefix: modelText.slice(0, index),
				suffix: modelText.slice(index + text.length),
			},
			channel: options.channel ?? "buffer",
			isBroadcast: options.isBroadcast,
			fromMessageId: options.fromMessageId,
			userId: options.userId ?? options.createdBy ?? null,
		},
	};
	const result = await port.mailbox.admitAgentMessage(input, {
		toolCallId: binding.toolCallId,
		attempt: binding.attempt,
		narratorId: delivery.sender.id,
		toolUseId: delivery.fromToolUseId,
	});
	if (!("delivery" in result)) throw new Error("Target message queue is full");
	// Retries navigate to the original delivery, including its negative tombstone.
	delivery.recipientMessageId =
		result.delivery.currentMessageId ??
		result.delivery.recipientMessageId ??
		delivery.recipientMessageId;
	delivery.deliveryId = result.delivery.deliveryId ?? undefined;
	delivery.recipientRefId = result.delivery.recipientRefId ?? undefined;
	delivery.revision = result.delivery.contentRevision;
	return result;
}

export async function listInboxRows(
	narratorId: string,
	kinds?: MailboxKind[],
	includeFailed = false,
): Promise<RuntimeMailboxRow[]> {
	const port = getRuntimeQueuePort();
	if (port) return port.mailbox.listPending(narratorId, { kinds, includeFailed, limit: 100 });
	return db
		.select()
		.from(mailbox)
		.where(
			and(
				eq(mailbox.narratorId, narratorId),
				inArray(mailbox.state, includeFailed ? ["queued", "failed"] : ["queued"]),
				kinds ? inArray(mailbox.kind, kinds) : undefined,
			),
		)
		.orderBy(
			desc(mailbox.priority),
			sql`CASE WHEN ${mailbox.kind} = 'user_input' THEN ${mailbox.seq} ELSE ${mailbox.arrivalSeq} END`,
			asc(mailbox.arrivalSeq),
		)
		.limit(100)
		.all();
}
export async function peekInbox(narratorId: string): Promise<RuntimeMailboxRow | undefined> {
	const port = getRuntimeQueuePort();
	if (port) return port.mailbox.peekQueued(narratorId);
	runtimeInbox.initializeLegacy(narratorId);
	return db
		.select()
		.from(mailbox)
		.where(and(eq(mailbox.narratorId, narratorId), eq(mailbox.state, "queued")))
		.orderBy(
			desc(mailbox.priority),
			sql`CASE WHEN ${mailbox.kind} = 'user_input' THEN ${mailbox.seq} ELSE ${mailbox.arrivalSeq} END`,
			asc(mailbox.arrivalSeq),
		)
		.limit(1)
		.get();
}
export async function hasInboxKind(narratorId: string, kinds: MailboxKind[]): Promise<boolean> {
	const port = getRuntimeQueuePort();
	if (port) return port.mailbox.hasQueuedKind(narratorId, kinds);
	return !!db
		.select({ id: mailbox.id })
		.from(mailbox)
		.where(
			and(
				eq(mailbox.narratorId, narratorId),
				eq(mailbox.state, "queued"),
				inArray(mailbox.kind, kinds),
			),
		)
		.limit(1)
		.get();
}
/**
 * The eligible-head projection the claim predicate sees, widened to the dialect-neutral
 * row. The SQLite `EligibleMailboxHead` narrows `kind` to an enum union; both adapters'
 * heads are assignable here, so one predicate serves both engines.
 */
export type InboxEligibleHead = Pick<
	RuntimeMailboxRow,
	| "id"
	| "narratorId"
	| "kind"
	| "metadataJson"
	| "projectedByteSize"
	| "arrivalSeq"
	| "seq"
	| "priority"
	| "createdBy"
	| "deliveryId"
>;
/**
 * Synchronous queue-presence re-check for loop-boundary callbacks (the agent loop's
 * `shouldStop` cannot await). SQLite-only by construction: the subagent loop is not
 * wired on PostgreSQL yet, and a sync callback could never perform the network read —
 * callers on the PG backend must answer from their in-memory flags instead.
 */
export function hasQueuedInboxRowSync(narratorId: string): boolean {
	if (getRuntimeQueuePort())
		throw new Error(
			"Synchronous inbox probes are SQLite-only; the PostgreSQL queue is honestly async",
		);
	runtimeInbox.initializeLegacy(narratorId);
	return !!db
		.select({ id: mailbox.id })
		.from(mailbox)
		.where(and(eq(mailbox.narratorId, narratorId), eq(mailbox.state, "queued")))
		.limit(1)
		.get();
}
/**
 * The predicate is checked against the global head, never used to skip a principal barrier.
 *
 * Honestly async on both engines: SQLite runs its synchronous claim transaction first and
 * the Promise wraps the COMMITTED row (a Promise never enters the `bun:sqlite`
 * transaction); PostgreSQL runs the `FOR UPDATE SKIP LOCKED` claim section.
 */
export async function claimInboxHead(
	narratorId: string,
	accepts: (row: InboxEligibleHead) => boolean,
): Promise<RuntimeMailboxRow | undefined> {
	const owner = getExecutionOwner(narratorId);
	if (!owner) throw new Error("Mailbox claim requires shared execution owner");
	const claimOwner = { token: `${inboxProcessTokenPrefix}${generateId()}`, epoch: owner.epoch };
	const port = getRuntimeQueuePort();
	if (port) return port.mailbox.claimEligibleHead(narratorId, claimOwner, accepts);
	return runtimeInbox.claimEligibleHead(narratorId, claimOwner, accepts);
}
/**
 * The publication barrier ahead of mailbox work. The facade keeps its synchronous API, but
 * a wired publication service may return the transferred count OR a Promise of it — both
 * shapes are honored here. On the PostgreSQL backend the publication producer is wired in
 * a later phase: its facade fails closed, and because every producer entry point fails
 * closed the same way no pending intent can exist there yet — so on that backend alone the
 * not-wired error is logged and the barrier is a no-op. On SQLite the original propagation
 * semantics are untouched (a real flush failure still aborts the caller).
 */
export async function flushInboxPublicationBarrier(narratorId: string): Promise<void> {
	try {
		const flushed: unknown = flushRuntimePublications(narratorId);
		if (flushed && typeof (flushed as Promise<number>).then === "function") await flushed;
	} catch (error) {
		if (!isRuntimePublicationUnavailableError(error)) throw error;
		logger.warn("Runtime publication barrier unavailable on this backend", {
			narratorId,
			error: String(error),
		});
	}
}
export async function withInboxOwner<T>(narratorId: string, work: () => Promise<T>): Promise<T> {
	const existing = getExecutionOwner(narratorId);
	const owner = existing ?? tryClaimExecution(narratorId, "tool-replay");
	if (!owner) throw new Error("Mailbox recipient is owned by another execution");
	let result!: T;
	let workError: unknown;
	try {
		await flushInboxPublicationBarrier(narratorId);
		try {
			result = await work();
		} catch (error) {
			workError = error;
		}
	} finally {
		if (!existing && owner.isCurrent()) {
			owner.release();
			// Owner-terminated recovery: cancelled/failed/interrupted work must never leave a
			// row `claimed` past its owner's epoch.
			const port = getRuntimeQueuePort();
			if (port)
				await port.mailbox.recoverClaims(narratorId, owner.epoch, { ownerTerminated: true });
			else runtimeInbox.recoverClaims(narratorId, owner.epoch, { ownerTerminated: true });
		}
	}
	let publicationError: unknown;
	try {
		await flushInboxPublicationBarrier(narratorId);
	} catch (error) {
		if (isRuntimePublicationUnavailableError(error)) {
			logger.warn("Publication transfer unavailable after inbox pass", {
				narratorId,
				error: String(error),
			});
		} else publicationError = error;
	}
	if (workError !== undefined) throw workError;
	if (publicationError !== undefined) throw publicationError;
	return result;
}
/**
 * Fail a live claim after a consumer-side error. Cancel/fail/retry never leave the row in
 * `claimed`: the token guard re-reads the row first, so an already materialized/cancelled
 * delivery is left untouched.
 */
export async function releaseInboxClaim(row: RuntimeMailboxRow, error: unknown): Promise<void> {
	if (!row.deliveryId) return;
	const port = getRuntimeQueuePort();
	if (port) {
		const current = await port.mailbox.getByDelivery(row.deliveryId);
		if (current?.state === "claimed" && current.claimToken === row.claimToken)
			await port.mailbox.failClaim(inboxClaim(row), String(error));
		return;
	}
	const current = runtimeInbox.getByDelivery(row.deliveryId);
	if (current?.state === "claimed" && current.claimToken === row.claimToken)
		runtimeInbox.failClaim(inboxClaim(row), String(error));
}

/**
 * The post-error committed check behind {@link deliverInboxInjection}. SQLite reads its own
 * store; PostgreSQL goes through the queue's named read (`getStateById`) — a claimed
 * delivery's state never crosses a dialect boundary.
 */
async function readClaimCommittedState(
	claim: MailboxClaim,
): Promise<{ state: string; currentMessageId: string | null } | undefined> {
	const port = getRuntimeQueuePort();
	if (port) return port.mailbox.getStateById(claim.id, claim.narratorId);
	return db
		.select({ state: mailbox.state, currentMessageId: mailbox.currentMessageId })
		.from(mailbox)
		.where(and(eq(mailbox.id, claim.id), eq(mailbox.narratorId, claim.narratorId)))
		.get();
}

/** A lost post-commit WS frame must not discard the already materialized model projection. */
export async function deliverInboxInjection(
	narratorId: string,
	options: import("../narrator-injection").DeliverInjectionOptions,
	claim?: MailboxClaim,
): Promise<import("../narrator-injection").DeliverInjectionResult> {
	if (claim) assertInboxClaimOwner(claim);
	// The refs port — not an env probe — decides the branch. A claimed delivery on
	// PostgreSQL materializes through the queue's own section (message + ref + mailbox
	// flip in ONE transaction); the SQLite placement hook never crosses into it.
	if (claim && getNarratorMessageRefsPort()) {
		try {
			return await deliverClaimedInboxInjectionPg(narratorId, options, claim);
		} catch (error) {
			// Same rule as the SQLite half below: a lost post-commit frame must not discard
			// the already materialized projection.
			const committed = await readClaimCommittedState(claim);
			if (committed?.state !== "materialized" || committed.currentMessageId !== options.messageId)
				throw error;
			logger.warn("Mailbox projection committed; notification delivery failed", {
				narratorId,
				error: String(error),
			});
			return {
				messageId: committed.currentMessageId,
				turnText: options.schedule === "onNextTurn" ? options.content.trim() : null,
				started: false,
				interjected: false,
			};
		}
	}
	const { deliverInjection } = await import("../narrator-injection");
	try {
		return await deliverInjection(narratorId, {
			...options,
			onPersist: claim
				? (tx, messageId, refId) => {
						assertInboxClaimOwner(claim);
						return options.onPersist?.(tx, messageId, refId);
					}
				: options.onPersist,
		});
	} catch (error) {
		const committed = claim ? await readClaimCommittedState(claim) : undefined;
		if (committed?.state !== "materialized" || committed.currentMessageId !== options.messageId)
			throw error;
		logger.warn("Mailbox projection committed; notification delivery failed", {
			narratorId,
			error: String(error),
		});
		return {
			messageId: committed.currentMessageId,
			turnText: options.schedule === "onNextTurn" ? options.content.trim() : null,
			started: false,
			interjected: false,
		};
	}
}

/**
 * Capture the recipient ref identity + seq from INSIDE the queue's materialize section.
 * The seq feeds the post-commit broadcast; a missing ref throws, rolling the whole
 * section back rather than broadcasting a phantom row. The hook is read-only and
 * idempotent, so a whole-section replay (40001/40P01) is safe.
 */
function capturePlacedRef(): {
	hook: (
		tx: import("../narrator-persistence").PgPlacementTx,
		messageId: string,
		refId: string,
	) => Promise<void>;
	captured: { refId?: string; seq?: number };
} {
	const captured: { refId?: string; seq?: number } = {};
	return {
		captured,
		hook: async (tx, _messageId, refId) => {
			const rows = await tx.execute(sql`SELECT seq FROM narrator_message_refs WHERE id = ${refId}`);
			const seq = Number((rows[0] as { seq?: unknown } | undefined)?.seq);
			if (!Number.isSafeInteger(seq))
				throw new Error("Materialized recipient ref has no committed seq");
			captured.refId = refId;
			captured.seq = seq;
		},
	};
}

/**
 * The PostgreSQL half of {@link deliverInboxInjection}: ONE queue `materialize` section
 * persists the message + ref and flips the mailbox row atomically (the phase-3 seam,
 * `createPgPlacedMessageMaterializer`), then the same post-commit side effects the
 * SQLite path gets from `deliverInjection` run here (dual broadcast, interject/wake
 * scheduling). Side effects only ever run after the section has committed.
 *
 * `options.role` defaults to "sys" without re-reading an existing reserved row: on this
 * path the row can only pre-exist when a previous attempt already committed, and that
 * state is served by the committed-check fallback, which never re-persists.
 */
async function deliverClaimedInboxInjectionPg(
	narratorId: string,
	options: import("../narrator-injection").DeliverInjectionOptions,
	claim: MailboxClaim,
): Promise<import("../narrator-injection").DeliverInjectionResult> {
	// The SQLite path's `withNarratorWorkAdmission` wrapper resolves the admission root
	// through a persisted narrator read — a surface PostgreSQL has not migrated yet. The
	// revert gate itself is in-memory (and cannot be armed on PG this phase: every revert
	// write path fails closed), so the equivalent protection here is the in-memory check
	// plus the claim/section concurrency the queue already enforces. When the narrator
	// read track lands on PG, this branch should re-enter the full admission wrapper.
	const { isNarratorRevertAdmissionBlocked } = await import("../narrator-session-state");
	if (isNarratorRevertAdmissionBlocked(narratorId))
		throw new AppError(
			"Narrator history is reserved for a file revert",
			409,
			"NARRATOR_REVERT_IN_PROGRESS",
		);
	return (async () => {
		const content = options.content.trim();
		if (!content) return { messageId: null, turnText: null, started: false, interjected: false };
		if (options.onPersist)
			throw new Error(
				"PostgreSQL claimed injection cannot carry the SQLite onPersist hook; " +
					"the queue materialize section owns the transaction",
			);
		const reservedMessageId = options.messageId;
		if (!reservedMessageId)
			throw new Error("PostgreSQL claimed injection requires the reserved recipient identity");
		const queue = requireRuntimeQueuePort();
		const { buildSystemInjectionBlock } = await import("../narrator-injection");
		const { createPgPlacedMessageMaterializer } = await import("../narrator-persistence");
		const role = options.role ?? "sys";
		const schedule = options.schedule ?? "none";
		// Both persist entry points agree on this shape for a native injection block: the
		// block carries its own modelText, so no sibling text block is prepended and
		// contentText is the trimmed model-facing projection.
		const blocks = [
			buildSystemInjectionBlock(options.source, options.body, content),
			...(options.extraBlocks ?? []),
		];
		const message: import("../narrator-refs/port").RefMessageInput = {
			id: reservedMessageId,
			narratorId,
			parentToolUseId: options.subagent?.parentToolUseId ?? null,
			role,
			contentJson: blocks,
			contentText: content,
			commandText: null,
			createdBy: options.createdBy ?? null,
			origin: role === "user" ? "user" : "system",
			originLabel: options.originSource
				? formatOriginLabel(options.originSource, options.originDetail)
				: null,
			createdAt: new Date().toISOString(),
		};
		const placed = capturePlacedRef();
		await queue.mailbox.materialize(
			claim,
			createPgPlacedMessageMaterializer(message, { onPersist: placed.hook }),
		);
		if (placed.captured.refId === undefined || placed.captured.seq === undefined)
			throw new Error("Mailbox materialize committed without a recipient ref");
		const { dualBroadcastToNarrator } = await import("../../websocket/narrator-dual-broadcast");
		dualBroadcastToNarrator(
			{
				narratorId,
				broadcastTargetId: options.subagent?.parentNarratorId ?? narratorId,
				parentToolUseId: options.subagent?.parentToolUseId,
			},
			{
				type: "message",
				narratorId,
				message: {
					id: reservedMessageId,
					narratorId,
					role,
					contentJson: blocks,
					contentText: content,
					createdAt: message.createdAt,
					seq: placed.captured.seq,
					parentToolUseId: options.subagent?.parentToolUseId ?? null,
					children: [],
				},
			},
		);
		const result = {
			messageId: reservedMessageId,
			turnText: schedule === "onNextTurn" ? content : null,
			started: false,
			interjected: false,
		};
		// The session module is only reachable for schedules that dispatch through it;
		// importing it for a plain persisted row would drag the whole session graph in.
		if (schedule === "interject" || schedule === "wakeIfIdle") {
			const session = await import("../narrator-session");
			if (schedule === "interject") {
				try {
					result.interjected = session.requestBufferedMessageSoftStop(narratorId);
				} catch (error) {
					logger.warn("Injection delivered but requesting a soft stop failed", {
						narratorId,
						error: String(error),
					});
				}
			} else {
				try {
					result.started = (
						await (options.executionPrincipal
							? session.startInjectionContinuationIfPossible(
									narratorId,
									options.locale ?? "en",
									undefined,
									options.executionPrincipal,
								)
							: session.startInjectionContinuationIfPossible(narratorId, options.locale ?? "en"))
					).started;
				} catch (error) {
					logger.warn("Injection delivered but waking the narrator failed", {
						narratorId,
						error: String(error),
					});
				}
			}
		}
		return result;
	})();
}

/** The committed result of a PostgreSQL user_input materialize, for broadcast/display. */
export interface MaterializedInboxUserMessage {
	id: string;
	narratorId: string;
	parentToolUseId: string | null;
	role: "user";
	// biome-ignore lint/suspicious/noExplicitAny: content blocks are dynamic JSON
	contentJson: any[];
	contentText: string;
	commandText: string | null;
	createdBy: string | null;
	origin: string;
	originLabel: string | null;
	createdAt: string;
	seq: number;
	creator: {
		id: string;
		username: string;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null;
	/** The materialized mailbox receipt row (post-flip). */
	mailbox: RuntimeMailboxRow;
}

/**
 * The PostgreSQL counterpart of `persistUserMessage(..., { mailboxClaim })`: the claimed
 * user_input row, its message + ref and the mailbox flip commit in ONE queue section
 * (`createPgPlacedMessageMaterializer`, the phase-3 seam). Fail-closed on SQLite — the
 * callers keep the synchronous `persistPlacement` path there — and when the queue port
 * is unbound. Creator enrichment is post-commit display data, mirroring
 * `persistUserMessage`: a lookup failure can never turn the committed input into a
 * failed write, and agent-authored reserved deliveries (origin "assistant") stay
 * unattributed.
 */
export async function materializeClaimedInboxUserMessage(input: {
	claim: MailboxClaim;
	/** The claim row's reserved recipient identity; re-read by claim id when omitted. */
	reservedMessageId?: string | null;
	narratorId: string;
	/** contentText — the effective model-facing text. */
	text: string;
	/** contentJson — the reader-facing blocks exactly as persisted. */
	// biome-ignore lint/suspicious/noExplicitAny: content blocks are dynamic JSON
	contentBlocks: any[];
	commandText?: string | null;
	createdBy?: string | null;
	origin?: import("@shared/message-origin").MessageOriginOptions;
	parentToolUseId?: string | null;
}): Promise<MaterializedInboxUserMessage> {
	const refsPort = getNarratorMessageRefsPort();
	if (!refsPort)
		throw new Error(
			"materializeClaimedInboxUserMessage is the PostgreSQL placement path; " +
				"SQLite keeps persistUserMessage's synchronous persistPlacement transaction",
		);
	assertInboxClaimOwner(input.claim);
	const queue = requireRuntimeQueuePort();
	const { createPgPlacedMessageMaterializer } = await import("../narrator-persistence");
	const reservedMessageId =
		input.reservedMessageId ??
		(await queue.mailbox.getStateById(input.claim.id, input.claim.narratorId))?.recipientMessageId;
	if (!reservedMessageId) throw new Error("Mailbox claim has no reserved recipient identity");
	const createdAt = new Date().toISOString();
	const message: import("../narrator-refs/port").RefMessageInput = {
		id: reservedMessageId,
		narratorId: input.narratorId,
		parentToolUseId: input.parentToolUseId ?? null,
		role: "user",
		contentJson: input.contentBlocks,
		contentText: input.text,
		commandText: input.commandText ?? null,
		createdBy: input.createdBy ?? null,
		origin: input.origin?.origin ?? "user",
		originLabel: input.origin?.originLabel ?? null,
		createdAt,
	};
	const placed = capturePlacedRef();
	const row = await queue.mailbox.materialize(
		input.claim,
		createPgPlacedMessageMaterializer(message, { onPersist: placed.hook }),
	);
	if (placed.captured.refId === undefined || placed.captured.seq === undefined)
		throw new Error("Mailbox materialize committed without a recipient ref");
	let creator: MaterializedInboxUserMessage["creator"] = null;
	if (input.createdBy && input.origin?.origin !== "assistant")
		creator = await refsPort.creator(input.createdBy).catch((error) => {
			logger.warn("Committed user message creator lookup failed", {
				narratorId: input.narratorId,
				messageId: reservedMessageId,
				error: String(error),
			});
			return null;
		});
	return {
		id: reservedMessageId,
		narratorId: input.narratorId,
		parentToolUseId: input.parentToolUseId ?? null,
		role: "user",
		contentJson: input.contentBlocks,
		contentText: input.text,
		commandText: input.commandText ?? null,
		createdBy: input.createdBy ?? null,
		origin: input.origin?.origin ?? "user",
		originLabel: input.origin?.originLabel ?? null,
		createdAt,
		seq: placed.captured.seq,
		creator,
		mailbox: row,
	};
}

export interface ClaimedUserInputMessage {
	id: string;
	narratorId: string;
	parentToolUseId: string | null;
	role: "user";
	// biome-ignore lint/suspicious/noExplicitAny: content blocks are dynamic JSON
	contentJson: any[];
	contentText: string;
	commandText: string | null;
	createdBy: string | null;
	origin: string;
	originLabel: string | null;
	createdAt: string;
	seq: number;
	creator: MaterializedInboxUserMessage["creator"];
	mailbox?: RuntimeMailboxRow;
}

/**
 * Persist one already-claimed user_input row through the bound backend.
 * PostgreSQL uses the queue-owned materialize transaction; SQLite keeps the
 * synchronous narrator persistence placement transaction. Callers must not
 * branch into either dialect or pass transaction handles themselves.
 */
export async function persistClaimedUserInput(input: {
	claim: MailboxClaim;
	reservedMessageId?: string | null;
	narratorId: string;
	text: string;
	// biome-ignore lint/suspicious/noExplicitAny: content blocks are dynamic JSON
	contentBlocks: any[];
	commandText?: string | null;
	createdBy?: string | null;
	origin?: MessageOriginOptions;
	parentToolUseId?: string | null;
}): Promise<ClaimedUserInputMessage> {
	const toClaimedUserInputMessage = (message: {
		id: string;
		narratorId: string;
		parentToolUseId: string | null;
		role: string;
		contentJson: unknown;
		contentText: string | null;
		commandText: string | null;
		createdBy: string | null;
		origin: string | null;
		originLabel: string | null;
		createdAt: string;
		seq: number;
		creator: MaterializedInboxUserMessage["creator"];
		mailbox?: RuntimeMailboxRow;
	}): ClaimedUserInputMessage => ({
		id: message.id,
		narratorId: message.narratorId,
		parentToolUseId: message.parentToolUseId,
		role: "user",
		contentJson: Array.isArray(message.contentJson) ? message.contentJson : [],
		contentText: message.contentText ?? input.text,
		commandText: message.commandText,
		createdBy: message.createdBy,
		origin: message.origin ?? input.origin?.origin ?? "user",
		originLabel: message.originLabel,
		createdAt: message.createdAt,
		seq: message.seq,
		creator: message.creator,
		...(message.mailbox ? { mailbox: message.mailbox } : {}),
	});
	if (getRuntimeQueuePort()) {
		const materialized = await materializeClaimedInboxUserMessage(input);
		return toClaimedUserInputMessage(materialized);
	}
	const { narratorService } = await import("../narrator-service");
	const persisted = await narratorService.persistUserMessage(
		input.narratorId,
		input.text,
		input.contentBlocks,
		input.commandText,
		input.createdBy,
		input.origin,
		{
			mailboxClaim: input.claim,
			...(input.parentToolUseId === undefined ? {} : { parentToolUseId: input.parentToolUseId }),
		},
	);
	return toClaimedUserInputMessage(persisted);
}

const startupRecovery = hotSafe("narrafork.runtime-inbox-startup-recovery", () => ({
	done: false,
	running: undefined as Promise<number> | undefined,
}));
/** Called only after the instance lock, before generic/planned recovery can mount execution owners. */
export function recoverInboxClaimsOnColdStartup(): Promise<number> {
	if (startupRecovery.done) return Promise.resolve(0);
	if (startupRecovery.running) return startupRecovery.running;
	const run = (async () => {
		let afterId: string | undefined;
		let recovered = 0;
		do {
			const port = getRuntimeQueuePort();
			const page = port
				? await port.mailbox.recoverForeignProcessClaims(inboxProcessId, {
						afterId,
						limit: 100,
						legacyOwnerTerminated: (claim) => !getExecutionOwner(claim.narratorId),
					})
				: runtimeInbox.recoverForeignProcessClaims(inboxProcessId, {
						afterId,
						limit: 100,
						legacyOwnerTerminated: (claim) => !getExecutionOwner(claim.narratorId),
					});
			recovered += page.recovered;
			afterId = page.nextAfterId;
			if (afterId) await new Promise<void>((resolve) => setImmediate(resolve));
		} while (afterId);
		startupRecovery.done = true;
		if (recovered) logger.info("Recovered foreign-process mailbox claims", { recovered });
		return recovered;
	})().finally(() => {
		if (startupRecovery.running === run) startupRecovery.running = undefined;
	});
	startupRecovery.running = run;
	return run;
}

const pendingWakes = hotSafe(
	"narrafork.runtime-inbox-wakes",
	() => new Map<string, Promise<boolean>>(),
);
/** Coalesced control-plane wake; the only payload authority remains the mailbox table. */
export function wakeInboxIfEligible(narratorId: string, locale: Locale = "en"): Promise<boolean> {
	const pending = pendingWakes.get(narratorId);
	if (pending) return pending;
	const wake = Promise.resolve()
		.then(async () => {
			await flushInboxPublicationBarrier(narratorId);
			if (getExecutionOwner(narratorId)) return false;
			const { isNarratorRuntimeBusy, compactLocks, isNarratorRevertAdmissionBlocked } =
				await import("../narrator-session-state");
			if (
				isNarratorRuntimeBusy(narratorId) ||
				compactLocks.has(narratorId) ||
				isNarratorRevertAdmissionBlocked(narratorId)
			)
				return false;
			// Named backend reads on PostgreSQL; SQLite keeps its own store. The task-notice
			// probe is dialect-specific by construction (json_extract vs jsonb extraction) and
			// lives behind `hasActionableTaskNotice` on the PG side — never a shared fallback.
			const port = getRuntimeQueuePort();
			const row = port
				? await port.mailbox.readRecipientRoute(narratorId)
				: db
						.select({ variant: narrators.variant, status: narrators.status })
						.from(narrators)
						.where(eq(narrators.id, narratorId))
						.get();
			if (!row || row.status === "archived") return false;
			if (!(await hasInboxKind(narratorId, ["user_input", "agent_message"]))) {
				const notice = port
					? await port.mailbox.hasActionableTaskNotice(narratorId)
					: !!db
							.select({ id: mailbox.id })
							.from(mailbox)
							.where(
								and(
									eq(mailbox.narratorId, narratorId),
									eq(mailbox.state, "queued"),
									eq(mailbox.kind, "task_notice"),
									sql`json_extract(${mailbox.metadataJson}, '$.eventKind') NOT IN ('started', 'cancelled')`,
								),
							)
							.limit(1)
							.get();
				if (!notice) return false;
			}
			if (row.variant.startsWith("subagent:")) {
				// A taken-over subagent with no live runner (e.g. a background takeover parked
				// idle) is woken only for its OWN queued work — user input or a Send to it; the
				// takeover survives that turn. A task notice alone must not start a turn the
				// user is holding. (A suspended runner still owns execution and is resumed by
				// the sender directly, never through this wake.)
				const { isTakenOver } = await import("../subagent-takeover");
				if (isTakenOver(narratorId)) {
					const { acceptsBufferedSubagentInput } = await import("../subagent-executor");
					const head = await peekInbox(narratorId);
					if (!head || !acceptsBufferedSubagentInput(head)) return false;
				}
				const { resumeSubagent } = await import("../subagent-resume");
				return (
					await resumeSubagent({
						subagentId: narratorId,
						intent: "follow_up",
						actor: "parent_agent",
						mailboxInput: true,
						locale,
					})
				).started;
			}
			const { startParentInboundContinuationIfPossible, resumeBufferedMessagesIfIdle } =
				await import("../narrator-session");
			const first = await peekInbox(narratorId);
			// A user behind a bounded batch of notices is still explicit work, not
			// an autonomous continuation (which intentionally refuses plan mode).
			// The user consumer drains those preceding notices without skipping them.
			if (first?.kind === "user_input" || (await hasInboxKind(narratorId, ["user_input"])))
				return (await resumeBufferedMessagesIfIdle(narratorId, locale)).resumed;
			return (await startParentInboundContinuationIfPossible(narratorId, "en")).started;
		})
		.catch((error) => {
			logger.warn("Mailbox wake deferred", { narratorId, error: String(error) });
			return false;
		})
		.finally(() => {
			if (pendingWakes.get(narratorId) === wake) pendingWakes.delete(narratorId);
		});
	pendingWakes.set(narratorId, wake);
	return wake;
}
setRuntimePublicationWake(async (narratorId) => {
	await wakeInboxIfEligible(narratorId);
});
