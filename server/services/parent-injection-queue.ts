import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, narratorMessageRefs, narratorMessages, narrators } from "../db/schema";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import {
	enqueueInboxAgent,
	hasInboxKind,
	type InboxAgentMetadata,
	inboxDelivery,
	inboxMetadata,
	listInboxRows,
} from "./agent-runtime/inbox";
import type { MailboxClaim } from "./agent-runtime/mailbox-types";
import {
	migrateLegacyTaskNotice,
	setLegacyCompletionAdmissionReader,
} from "./agent-runtime/publication";
import type { LegacyCompletionAdmission } from "./agent-runtime/publication-outbox";
import type { CompletedNotification } from "./background-task-service";
import type { CompletedBgSubagentNotification } from "./bg-completion-queue";
import { claimNextRefSeq } from "./narrator-refs/seq-store";
import type { ParentInboundMessage } from "./parent-inbound-queue";

export type PendingInjection = (
	| { kind: "bg_agent"; task: CompletedBgSubagentNotification }
	| { kind: "bg_bash"; task: CompletedNotification }
	| { kind: "subagent_message"; message: ParentInboundMessage }
) & { mailboxClaim?: MailboxClaim; recipientMessageId?: string };
export type PendingInjectionKind = PendingInjection["kind"];

const legacyQueue = hotSafe(
	"narrafork:parent-injection-queue",
	() => new Map<string, PendingInjection[]>(),
);
// Snapshot original object identities exactly once at protocol activation. No new producer writes here.
const legacyCompletions = hotSafe("narrafork:parent-injection-legacy-completions", () => {
	const entries = new Map<
		string,
		Array<{ entry: PendingInjection; admission: LegacyCompletionAdmission }>
	>();
	for (const [recipientId, pending] of legacyQueue) {
		const snapshots: Array<{ entry: PendingInjection; admission: LegacyCompletionAdmission }> = [];
		for (const entry of pending) {
			if (entry.kind === "subagent_message") continue;
			const eventKind = entry.task.status === "timeout" ? "timed_out" : entry.task.status;
			if (
				eventKind !== "completed" &&
				eventKind !== "failed" &&
				eventKind !== "timed_out" &&
				eventKind !== "cancelled"
			)
				continue;
			snapshots.push({
				entry,
				admission: Object.freeze({
					producerKind: entry.kind === "bg_agent" ? "agent" : "bash",
					taskId: entry.task.id,
					recipientId,
					token: entry,
					eventKind,
				}),
			});
		}
		if (snapshots.length) entries.set(recipientId, snapshots);
	}
	return entries;
});
setLegacyCompletionAdmissionReader((source) => {
	const captured = legacyCompletions
		.get(source.recipientId)
		?.find(
			({ entry, admission }) =>
				admission.producerKind === source.producerKind &&
				admission.taskId === source.taskId &&
				legacyQueue.get(source.recipientId)?.includes(entry),
		);
	if (!captured || captured.entry.kind === "subagent_message") return undefined;
	const currentEvent =
		captured.entry.task.status === "timeout" ? "timed_out" : captured.entry.task.status;
	if (
		captured.entry.task.id !== captured.admission.taskId ||
		currentEvent !== captured.admission.eventKind
	)
		return undefined;
	return captured.admission;
});

function persistUnboundLegacyAgentMessage(
	narratorId: string,
	entry: Extract<PendingInjection, { kind: "subagent_message" }>,
): void {
	db.transaction((tx) => {
		const messageId = generateId();
		const text = `旧代理消息无法绑定工具执行 / Legacy agent message has no exact execution receipt. It was not resent.\nSender: ${entry.message.fromId}\n${entry.message.text.slice(0, 8000)}`;
		tx.insert(narratorMessages)
			.values({
				id: messageId,
				narratorId,
				role: "disp",
				origin: "system",
				contentText: text,
				contentJson: [{ type: "text", text }],
				createdAt: new Date().toISOString(),
			})
			.run();
		// Single seq authority (narrator-refs/seq-store.ts); base 0 for an empty
		// narrator — previously this site alone started at 1.
		tx.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId, messageId, seq: claimNextRefSeq(tx, narratorId) })
			.run();
	});
}

/** Compatibility transfer is one-shot: remove only after its durable acceptance succeeds. */
export async function migrateLegacyParentInjections(narratorId: string): Promise<void> {
	const entries = legacyQueue.get(narratorId);
	if (!entries?.length) return;
	for (const entry of entries.slice(0, 100)) {
		if (entry.kind === "subagent_message") {
			if (!entry.message.delivery?.senderToolCallBinding)
				persistUnboundLegacyAgentMessage(narratorId, entry);
			else await pushPendingInjection(narratorId, entry);
		} else await migrateLegacyTaskNotice(narratorId, entry);
		entries.shift();
		const snapshots = legacyCompletions.get(narratorId);
		if (snapshots) {
			const index = snapshots.findIndex((snapshot) => snapshot.entry === entry);
			if (index >= 0) snapshots.splice(index, 1);
			if (!snapshots.length) legacyCompletions.delete(narratorId);
		}
	}
	if (entries.length) return;
	legacyQueue.delete(narratorId);
}

/** Completion producers use publication-outbox; this facade accepts ordinary agent messages only. */
export async function pushPendingInjection(narratorId: string, entry: PendingInjection) {
	if (entry.kind !== "subagent_message")
		throw new Error("Completion notices require durable publication outbox");
	if (!entry.message.delivery) throw new Error("Agent message requires exact delivery receipt");
	if (entry.message.delivery.recipientNarratorId !== narratorId)
		throw new Error("Mailbox recipient mismatch");
	await enqueueInboxAgent(entry.message.delivery, entry.message.text, {
		channel: "parent",
		fromMessageId: entry.message.fromMessageId,
	});
}

/** Read-only compatibility projection. Real consumers claim/commit through agent-runtime/inbox. */
export async function drainPendingInjections(narratorId: string): Promise<PendingInjection[]> {
	await migrateLegacyParentInjections(narratorId);
	return (await listInboxRows(narratorId, ["agent_message", "task_notice"])).map(
		projectPendingInjection,
	);
}
export function projectPendingInjection(
	row: import("./agent-runtime/runtime-queue-port").RuntimeMailboxRow,
): PendingInjection {
	if (row.kind === "task_notice") {
		const metadata = inboxMetadata<{
			producerKind: "agent" | "bash";
			taskId: string;
			logicalRunId: string;
			eventKind: string;
			resultRef?: string;
		}>(row);
		if (!metadata.taskId || !metadata.eventKind) throw new Error("Invalid task notice metadata");
		const task = db
			.select({ title: backgroundTasks.title, alias: backgroundTasks.alias })
			.from(backgroundTasks)
			.where(eq(backgroundTasks.id, metadata.taskId))
			.get();
		const status = metadata.eventKind === "timed_out" ? "timeout" : metadata.eventKind;
		if (metadata.producerKind === "bash")
			return {
				kind: "bg_bash",
				task: {
					id: metadata.taskId,
					type: "bash",
					title: task?.title ?? null,
					alias: task?.alias ?? null,
					status,
					outputPreview: row.text,
				},
			};
		const narrator = db
			.select({ title: narrators.title })
			.from(narrators)
			.where(eq(narrators.id, metadata.taskId))
			.get();
		const originalSnapshot = metadata.resultRef?.startsWith("message-original:") ?? false;
		const resultMessageId = originalSnapshot
			? metadata.resultRef?.slice("message-original:".length)
			: metadata.resultRef?.startsWith("message:")
				? metadata.resultRef.slice(8)
				: undefined;
		// Preserve the idle consumer's bounded long result without reading an unbounded source field.
		const result = resultMessageId
			? db
					.select({
						text: originalSnapshot
							? sql<
									string | null
								>`CASE WHEN ${narratorMessages.originalContentJson} IS NULL THEN substr(${narratorMessages.contentText}, 1, 12001) WHEN length(CAST(${narratorMessages.originalContentJson} AS BLOB)) <= 98304 THEN substr(json_extract(${narratorMessages.originalContentJson}, '$[0].text'), 1, 12001) ELSE NULL END`
							: sql<string>`substr(${narratorMessages.contentText}, 1, 12001)`,
					})
					.from(narratorMessages)
					.where(eq(narratorMessages.id, resultMessageId))
					.get()?.text
			: undefined;
		return {
			kind: "bg_agent",
			task: {
				id: metadata.taskId,
				alias: task?.alias ?? null,
				title: task?.title ?? narrator?.title ?? metadata.taskId,
				status,
				resultPreview: row.text,
				result: result?.slice(0, 12000),
				resultTruncated: !!result && result.length > 12000,
				resultMessageId,
			},
		};
	}
	const delivery = inboxDelivery(row);
	const metadata = inboxMetadata<InboxAgentMetadata>(row);
	return {
		kind: "subagent_message",
		message: {
			delivery,
			fromId: delivery.sender.id,
			fromTitle: delivery.sender.title ?? null,
			fromLabel: delivery.sender.label,
			fromType: delivery.sender.type ?? "general",
			fromToolUseId: delivery.fromToolUseId,
			fromMessageId: metadata.fromMessageId,
			text: row.text,
			timestamp: row.bufferedAt,
		},
	};
}
export async function hasPendingInjections(narratorId: string): Promise<boolean> {
	await migrateLegacyParentInjections(narratorId);
	return hasInboxKind(narratorId, ["agent_message", "task_notice"]);
}
export function runItems<K extends PendingInjectionKind>(
	entries: readonly PendingInjection[],
	kind: K,
): Extract<PendingInjection, { kind: K }>[] {
	return entries.filter(
		(entry): entry is Extract<PendingInjection, { kind: K }> => entry.kind === kind,
	);
}
