import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { narratorBufferedMessages as mailbox, narrators, narratorToolCalls } from "../../db/schema";
import { hotSafe } from "../../lib/hot-safe";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import type { Locale } from "../../lib/prompt-i18n";
import type { AgentMessageDelivery } from "../agent-message-delivery";
import { createMailboxStore, mailboxDedupeKey } from "./mailbox";
import type { EligibleMailboxHead, MailboxClaim, MailboxKind, MailboxRow } from "./mailbox-types";
import { getExecutionOwner, tryClaimExecution } from "./ownership";
import { flushRuntimePublications, setRuntimePublicationWake } from "./publication";

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
}

export function inboxMetadata<T>(row: Pick<MailboxRow, "metadataJson">): T {
	return JSON.parse(row.metadataJson ?? "{}") as T;
}
export function assertInboxClaimOwner(claim: MailboxClaim): void {
	if (getExecutionOwner(claim.narratorId)?.epoch !== claim.epoch)
		throw new Error("Stale mailbox execution owner");
}
export function inboxClaim(row: MailboxRow): MailboxClaim {
	if (row.state !== "claimed" || !row.claimToken || !row.claimEpoch)
		throw new Error("Mailbox row has no live claim");
	return { id: row.id, narratorId: row.narratorId, token: row.claimToken, epoch: row.claimEpoch };
}
export function inboxConsumption(
	row: MailboxRow,
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
export function inboxDelivery(row: MailboxRow): AgentMessageDelivery {
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
export function inboxAgentText(row: MailboxRow): string {
	const { projection } = inboxMetadata<InboxAgentMetadata>(row);
	return `${projection.prefix}${row.text}${projection.suffix}`;
}

/** Ordinary Send/TeamStatus acceptance requires the real persisted execution receipt. */
export function enqueueInboxAgent(
	delivery: AgentMessageDelivery,
	modelText: string,
	options: {
		channel?: InboxAgentMetadata["channel"];
		createdBy?: string | null;
		isBroadcast?: boolean;
		fromMessageId?: string | null;
	} = {},
) {
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

export function listInboxRows(
	narratorId: string,
	kinds?: MailboxKind[],
	includeFailed = false,
): MailboxRow[] {
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
export function peekInbox(narratorId: string): MailboxRow | undefined {
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
export function hasInboxKind(narratorId: string, kinds: MailboxKind[]): boolean {
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
/** The predicate is checked against the global head, never used to skip a principal barrier. */
export function claimInboxHead(
	narratorId: string,
	accepts: (row: EligibleMailboxHead) => boolean,
): MailboxRow | undefined {
	const owner = getExecutionOwner(narratorId);
	if (!owner) throw new Error("Mailbox claim requires shared execution owner");
	return runtimeInbox.claimEligibleHead(
		narratorId,
		{ token: `${inboxProcessTokenPrefix}${generateId()}`, epoch: owner.epoch },
		accepts,
	);
}
export async function withInboxOwner<T>(narratorId: string, work: () => Promise<T>): Promise<T> {
	const existing = getExecutionOwner(narratorId);
	const owner = existing ?? tryClaimExecution(narratorId, "tool-replay");
	if (!owner) throw new Error("Mailbox recipient is owned by another execution");
	try {
		flushRuntimePublications(narratorId);
		return await work();
	} finally {
		try {
			flushRuntimePublications(narratorId);
		} catch (error) {
			logger.warn("Publication transfer deferred after inbox pass", {
				narratorId,
				error: String(error),
			});
		}
		if (!existing && owner.isCurrent()) {
			owner.release();
			runtimeInbox.recoverClaims(narratorId, owner.epoch, { ownerTerminated: true });
		}
	}
}
export function releaseInboxClaim(row: MailboxRow, error: unknown): void {
	if (!row.deliveryId) return;
	const current = runtimeInbox.getByDelivery(row.deliveryId);
	if (current?.state === "claimed" && current.claimToken === row.claimToken)
		runtimeInbox.failClaim(inboxClaim(row), String(error));
}

/** A lost post-commit WS frame must not discard the already materialized model projection. */
export async function deliverInboxInjection(
	narratorId: string,
	options: import("../narrator-injection").DeliverInjectionOptions,
	claim?: MailboxClaim,
) {
	const { deliverInjection } = await import("../narrator-injection");
	if (claim) assertInboxClaimOwner(claim);
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
		const committed = claim
			? db
					.select({ state: mailbox.state, messageId: mailbox.currentMessageId })
					.from(mailbox)
					.where(and(eq(mailbox.id, claim.id), eq(mailbox.narratorId, narratorId)))
					.get()
			: undefined;
		if (committed?.state !== "materialized" || committed.messageId !== options.messageId)
			throw error;
		logger.warn("Mailbox projection committed; notification delivery failed", {
			narratorId,
			error: String(error),
		});
		return {
			messageId: committed.messageId,
			turnText: options.schedule === "onNextTurn" ? options.content.trim() : null,
			started: false,
			interjected: false,
		};
	}
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
			const page = runtimeInbox.recoverForeignProcessClaims(inboxProcessId, {
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
			flushRuntimePublications(narratorId);
			if (getExecutionOwner(narratorId)) return false;
			const { isNarratorRuntimeBusy, compactLocks, isNarratorRevertAdmissionBlocked } =
				await import("../narrator-session-state");
			if (
				isNarratorRuntimeBusy(narratorId) ||
				compactLocks.has(narratorId) ||
				isNarratorRevertAdmissionBlocked(narratorId)
			)
				return false;
			const row = db
				.select({ variant: narrators.variant, status: narrators.status })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.get();
			if (!row || row.status === "archived") return false;
			if (!hasInboxKind(narratorId, ["user_input", "agent_message"])) {
				const notice = db
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
				const { isTakenOver } = await import("../subagent-takeover");
				if (isTakenOver(narratorId)) return false;
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
			const first = peekInbox(narratorId);
			if (first?.kind === "user_input")
				return (await resumeBufferedMessagesIfIdle(narratorId)).resumed;
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
