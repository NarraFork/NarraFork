import { type FileReferenceSnapshot, isFileReferenceSnapshot } from "@shared/file-reference";
import { formatOriginLabel } from "@shared/message-origin";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
	narratorBufferedMessages as mailbox,
	narratorMessageRefs,
	narrators,
	narratorToolCalls,
	runtimePublicationOutbox as outbox,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { type ImageRef, imageRefToContentBlock } from "../../lib/uploads";
import {
	type CanonicalMessageDraft,
	deleteCanonicalProjectionTx,
	insertCanonicalMessageTx,
	readCanonicalMessageTreeTx,
	updateCanonicalMessageTx,
} from "../narrator-history-projection";
import { MAILBOX_LIMITS as L } from "./limits";
import { mirrorDeliveryStateTx } from "./mailbox-transitions";
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
export function boundedJson(value: unknown, limit: number): string {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > limit) throw new Error(`Metadata exceeds ${limit} bytes`);
	return json;
}
export function boundedError(error: string): string {
	return Buffer.from(error.slice(0, L.errorBytes)).subarray(0, L.errorBytes).toString("utf8");
}
function pointer(value: string): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value) > 512)
		throw new Error("Invalid identity pointer");
	return value;
}
export function mailboxDedupeKey(input: MailboxInput): string {
	pointer(input.narratorId);
	if (input.deliveryId !== undefined) pointer(input.deliveryId);
	if (input.kind === "agent_message") {
		if (input.recipientMessageId !== undefined) pointer(input.recipientMessageId);
		if (!Number.isSafeInteger(input.sourceAttempt) || input.sourceAttempt < 1)
			throw new Error("Exact execution attempt required");
		return JSON.stringify([
			"send",
			pointer(input.sourceNarratorId),
			pointer(input.sourceToolCallId),
			input.sourceAttempt,
			pointer(input.sourceKey),
			pointer(input.narratorId),
		]);
	}
	if (input.kind === "task_notice") {
		if (input.noticeKind !== "agent" && input.noticeKind !== "bash")
			throw new Error("Invalid notice producer identity");
		return pointer(input.sourceKey);
	}
	if (input.kind !== "user_input") throw new Error("Invalid mailbox input kind");
	return JSON.stringify(["user", pointer(input.requestKey ?? generateId())]);
}
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
function defaultHistory(input: MailboxInput, deliveryId: string, messageId: string) {
	if (input.history) {
		return {
			...input.history,
			narratorId: input.narratorId,
			messageId,
			deliveryId,
			deliveryKind: input.kind,
			deliveryState: "queued" as const,
		};
	}
	const role: "user" | "sys" = input.kind === "task_notice" ? "sys" : "user";
	return {
		narratorId: input.narratorId,
		messageId,
		role,
		contentJson: [{ type: "text", text: input.text }],
		contentText: input.text,
		commandText: input.kind === "user_input" ? (input.commandText ?? null) : null,
		createdBy: input.createdBy ?? null,
		origin: role === "user" ? ("user" as const) : ("system" as const),
		deliveryId,
		deliveryKind: input.kind,
		deliveryState: "queued" as const,
	};
}

// The old buffer writer caps every managed body at 2 MiB before accepting it. Keep the
// compatibility reader bounded by the same ceiling; a damaged row must not turn a startup
// projection into an unbounded synchronous file read.
const LEGACY_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;
const LEGACY_HISTORY_MAX_BYTES = LEGACY_PAYLOAD_MAX_BYTES + L.metadataBytes;
const LEGACY_PAYLOAD_UNAVAILABLE_TEXT =
	"[Queued message body unavailable after restart: durable payload exceeded the recovery limit; edit and resend it.]";

type LegacyProjectionRow = Pick<
	MailboxRow,
	| "kind"
	| "text"
	| "metadataJson"
	| "createdBy"
	| "imagesJson"
	| "creatorJson"
	| "textFilePathsJson"
	| "fileReferencesJson"
	| "commandText"
	| "payloadRefJson"
	| "narratorId"
	| "sourceNarratorId"
	| "sourceToolCallId"
	| "sourceAttempt"
	| "deliveryId"
	| "contentRevision"
	| "bufferedAt"
>;

type LegacyDelivery = {
	recipientNarratorId?: unknown;
	recipientMessageId?: unknown;
	sender?: unknown;
	fromToolUseId?: unknown;
	senderToolCallBinding?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseJsonValue(value: string | null): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function parseJsonArray<T>(value: string | null): T[] {
	const parsed = parseJsonValue(value);
	return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function legacyPayloadText(row: LegacyProjectionRow): { text: string; degraded: boolean } {
	const payload = record(parseJsonValue(row.payloadRefJson));
	if (!payload || typeof payload.path !== "string") return { text: row.text, degraded: false };
	const declaredBytes = payload.byteSize;
	if (
		(typeof declaredBytes === "number" &&
			(!Number.isSafeInteger(declaredBytes) || declaredBytes > LEGACY_PAYLOAD_MAX_BYTES)) ||
		(payload.storage !== undefined && payload.storage !== "buffered_file")
	)
		return {
			text: row.text || LEGACY_PAYLOAD_UNAVAILABLE_TEXT,
			degraded: !row.text,
		};
	// Legacy payload files are deliberately not read from the synchronous mailbox repair
	// transaction. Preserve the inline fallback and make an unavailable body explicit rather
	// than blocking the request thread on a potentially multi-megabyte file.
	return { text: row.text || LEGACY_PAYLOAD_UNAVAILABLE_TEXT, degraded: !row.text };
}

function legacyFileReferenceJson(row: LegacyProjectionRow): string | null {
	return row.fileReferencesJson;
}

function legacyCommandText(row: LegacyProjectionRow): string | null {
	return row.commandText;
}

function legacyImageBlocks(value: string | null): unknown[] {
	return parseJsonArray<Partial<ImageRef>>(value).flatMap((image) => {
		if (
			!image ||
			typeof image.imageId !== "string" ||
			typeof image.filename !== "string" ||
			typeof image.mediaType !== "string"
		)
			return [];
		return [imageRefToContentBlock(image as ImageRef)];
	});
}

function legacyFileReferenceBlocks(value: string | null): FileReferenceSnapshot[] {
	return parseJsonArray<unknown>(value).filter(isFileReferenceSnapshot);
}

function legacyTextFileBlocks(value: string | null): unknown[] {
	return parseJsonArray<unknown>(value).flatMap((file) => {
		const item = record(file);
		if (
			!item ||
			typeof item.filename !== "string" ||
			!Number.isSafeInteger(item.size) ||
			(item.size as number) < 0
		)
			return [];
		return [{ type: "text_file", filename: item.filename, size: item.size }];
	});
}

function boundedLegacyContent(
	contentJson: unknown[],
	text: string,
): {
	contentJson: unknown[];
	contentText: string;
} {
	let bytes: number;
	try {
		bytes = Buffer.byteLength(JSON.stringify(contentJson));
	} catch {
		bytes = LEGACY_HISTORY_MAX_BYTES + 1;
	}
	if (bytes <= LEGACY_HISTORY_MAX_BYTES) return { contentJson, contentText: text };
	return {
		contentJson: [{ type: "text", text: LEGACY_PAYLOAD_UNAVAILABLE_TEXT }],
		contentText: LEGACY_PAYLOAD_UNAVAILABLE_TEXT,
	};
}

function legacyAgentParentToolUseId(tx: RuntimeTx, row: LegacyProjectionRow): string | null {
	const recipient = tx
		.select({ variant: narrators.variant, originToolCallId: narrators.originToolCallId })
		.from(narrators)
		.where(eq(narrators.id, row.narratorId))
		.get();
	if (!recipient?.variant?.startsWith("subagent:") || !recipient.originToolCallId) return null;
	return (
		tx
			.select({ toolUseId: narratorToolCalls.toolUseId })
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, recipient.originToolCallId))
			.get()?.toolUseId ?? null
	);
}

function legacyAgentHistory(
	tx: RuntimeTx,
	row: LegacyProjectionRow,
	metadata: Record<string, unknown>,
): Pick<
	CanonicalMessageDraft,
	| "role"
	| "contentJson"
	| "contentText"
	| "parentToolUseId"
	| "commandText"
	| "createdBy"
	| "origin"
	| "originLabel"
> {
	const rawDelivery = record(metadata.delivery) as LegacyDelivery | null;
	const projection = record(metadata.projection);
	const bodyText = row.text;
	const prefix = typeof projection?.prefix === "string" ? projection.prefix : "";
	const suffix = typeof projection?.suffix === "string" ? projection.suffix : "";
	const modelText = `${prefix}${bodyText}${suffix}`;
	const rawSender = record(rawDelivery?.sender);
	const senderId =
		typeof rawSender?.id === "string" ? rawSender.id : (row.sourceNarratorId ?? "legacy-agent");
	const senderLabel = typeof rawSender?.label === "string" ? rawSender.label : senderId;
	const senderTitle = typeof rawSender?.title === "string" ? rawSender.title : null;
	const senderType = typeof rawSender?.type === "string" ? rawSender.type : null;
	const fromToolUseId =
		typeof rawDelivery?.fromToolUseId === "string"
			? rawDelivery.fromToolUseId
			: (row.sourceToolCallId ?? undefined);
	const rawBinding = record(rawDelivery?.senderToolCallBinding);
	const binding =
		typeof rawBinding?.toolCallId === "string" && Number.isSafeInteger(rawBinding.attempt)
			? { toolCallId: rawBinding.toolCallId, attempt: rawBinding.attempt }
			: row.sourceToolCallId && Number.isSafeInteger(row.sourceAttempt)
				? { toolCallId: row.sourceToolCallId, attempt: row.sourceAttempt }
				: undefined;
	const item: Record<string, unknown> = {
		fromId: senderId,
		fromTitle: senderTitle,
		fromLabel: senderLabel,
		fromType: senderType,
		...(fromToolUseId ? { fromToolUseId } : {}),
		...(row.deliveryId
			? {
					deliveryId: row.deliveryId,
					recipientNarratorId: row.narratorId,
					revision: row.contentRevision,
				}
			: {}),
		...(binding ? { fromToolCallBinding: binding } : {}),
		text: bodyText,
	};
	const body = { kind: "messages", items: [item] };
	const bounded = boundedLegacyContent(
		[
			{ type: "text", text: modelText },
			{ type: "system_injection", source: "subagent_message", modelText, body },
		],
		modelText,
	);
	const isSubagentRecipient =
		tx
			.select({ variant: narrators.variant })
			.from(narrators)
			.where(eq(narrators.id, row.narratorId))
			.get()
			?.variant?.startsWith("subagent:") === true;
	return {
		role: isSubagentRecipient ? "user" : "sys",
		contentJson: bounded.contentJson,
		contentText: bounded.contentText,
		parentToolUseId: legacyAgentParentToolUseId(tx, row),
		commandText: null,
		createdBy: row.createdBy ?? null,
		origin: "assistant",
		originLabel: formatOriginLabel("agentMessage", senderTitle?.trim() || senderLabel),
	};
}

function legacyHistory(
	tx: RuntimeTx,
	row: LegacyProjectionRow,
): Pick<
	CanonicalMessageDraft,
	| "role"
	| "contentJson"
	| "contentText"
	| "parentToolUseId"
	| "commandText"
	| "createdBy"
	| "origin"
	| "originLabel"
> {
	const metadata = record(parseJsonValue(row.metadataJson)) ?? {};
	const candidate = record(metadata.history) ?? metadata;
	const candidateContentJson = Array.isArray(candidate.contentJson)
		? candidate.contentJson
		: undefined;
	const payload = legacyPayloadText(row);
	const commandText = legacyCommandText(row);
	if (row.kind === "agent_message" && !candidateContentJson)
		return legacyAgentHistory(tx, row, metadata);
	const contentJson = candidateContentJson
		? boundedLegacyContent(
				candidateContentJson,
				typeof candidate.contentText === "string" ? candidate.contentText : payload.text,
			)
		: boundedLegacyContent(
				[
					...legacyImageBlocks(row.imagesJson),
					...legacyFileReferenceBlocks(legacyFileReferenceJson(row)),
					...legacyTextFileBlocks(row.textFilePathsJson),
					{ type: "text", text: payload.text },
				],
				payload.text,
			);
	const role =
		candidate.role === "user" || candidate.role === "sys"
			? candidate.role
			: row.kind === "user_input"
				? "user"
				: "sys";
	const parentToolUseId =
		typeof candidate.parentToolUseId === "string"
			? candidate.parentToolUseId
			: row.kind === "agent_message"
				? legacyAgentParentToolUseId(tx, row)
				: null;
	return {
		role,
		contentJson: contentJson.contentJson,
		contentText:
			typeof candidate.contentText === "string" ? candidate.contentText : contentJson.contentText,
		parentToolUseId,
		commandText:
			typeof candidate.commandText === "string" || candidate.commandText === null
				? candidate.commandText
				: commandText,
		createdBy: row.createdBy ?? null,
		origin:
			candidate.origin === "assistant" ||
			candidate.origin === "system" ||
			candidate.origin === "user"
				? candidate.origin
				: row.kind === "agent_message"
					? ("assistant" as const)
					: role === "user"
						? ("user" as const)
						: ("system" as const),
		originLabel:
			typeof candidate.originLabel === "string"
				? candidate.originLabel
				: row.kind === "agent_message"
					? (legacyAgentHistory(tx, row, metadata).originLabel ?? null)
					: null,
	};
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
	function cancelPendingUserProjection(tx: RuntimeTx, row: MailboxRow): void {
		if (row.kind !== "user_input" || row.state === "materialized" || !row.recipientRefId) return;
		deleteCanonicalProjectionTx(tx, row.narratorId, row.recipientRefId);
		tx.update(mailbox)
			.set({
				recipientRefId: null,
				currentMessageId: null,
				receiptDisposition: "recipient_deleted",
				updatedAt: now(),
			})
			.where(eq(mailbox.id, row.id))
			.run();
	}
	function ensureLegacyProjectionTx(
		tx: RuntimeTx,
		row: Pick<
			MailboxRow,
			| "id"
			| "narratorId"
			| "kind"
			| "state"
			| "text"
			| "metadataJson"
			| "imagesJson"
			| "creatorJson"
			| "textFilePathsJson"
			| "fileReferencesJson"
			| "payloadRefJson"
			| "commandText"
			| "createdBy"
			| "sourceNarratorId"
			| "sourceToolCallId"
			| "sourceAttempt"
			| "contentRevision"
			| "bufferedAt"
			| "deliveryId"
			| "recipientMessageId"
			| "recipientRefId"
			| "currentMessageId"
			| "receiptDisposition"
		>,
	): void {
		// A cancelled/deleted recipient is a negative tombstone, never a reason to resurrect history.
		if (
			row.state === "cancelled" ||
			row.receiptDisposition === "recipient_deleted" ||
			(row.recipientRefId && row.currentMessageId)
		)
			return;
		if (!row.deliveryId) return;
		const history = legacyHistory(tx, row);
		const projection = insertCanonicalMessageTx(tx, {
			narratorId: row.narratorId,
			messageId: row.recipientMessageId ?? generateId(),
			...history,
			createdAt: row.bufferedAt,
			deliveryId: row.deliveryId,
			deliveryKind: row.kind,
			deliveryState: row.state,
		});
		tx.update(mailbox)
			.set({
				recipientMessageId: projection.message.id,
				recipientRefId: projection.ref.id,
				currentMessageId: projection.message.id,
			})
			.where(eq(mailbox.id, row.id))
			.run();
	}
	function hasLegacyProjectionWork(narratorId: string): boolean {
		return Boolean(
			db
				.select({ id: mailbox.id })
				.from(mailbox)
				.where(
					and(
						eq(mailbox.narratorId, narratorId),
						or(
							isNull(mailbox.arrivalSeq),
							and(
								ne(mailbox.state, "cancelled"),
								ne(mailbox.receiptDisposition, "recipient_deleted"),
								or(isNull(mailbox.recipientRefId), isNull(mailbox.currentMessageId)),
							),
						),
					),
				)
				.limit(1)
				.get(),
		);
	}
	function repairLegacyProjections(narratorId: string): number {
		return db.transaction((tx) => {
			initializeLegacyMailbox(tx, narratorId);
			const rows = tx
				.select({
					id: mailbox.id,
					narratorId: mailbox.narratorId,
					deliveryId: mailbox.deliveryId,
					recipientMessageId: mailbox.recipientMessageId,
					recipientRefId: mailbox.recipientRefId,
					currentMessageId: mailbox.currentMessageId,
					receiptDisposition: mailbox.receiptDisposition,
					kind: mailbox.kind,
					state: mailbox.state,
					text: sql<string>`substr(${mailbox.text}, 1, ${LEGACY_PAYLOAD_MAX_BYTES})`,
					imagesJson: sql<string | null>`substr(${mailbox.imagesJson}, 1, ${L.metadataBytes})`,
					creatorJson: sql<string | null>`substr(${mailbox.creatorJson}, 1, ${L.metadataBytes})`,
					textFilePathsJson: sql<
						string | null
					>`substr(${mailbox.textFilePathsJson}, 1, ${L.metadataBytes})`,
					fileReferencesJson: sql<
						string | null
					>`substr(${mailbox.fileReferencesJson}, 1, ${LEGACY_HISTORY_MAX_BYTES})`,
					payloadRefJson: sql<
						string | null
					>`substr(${mailbox.payloadRefJson}, 1, ${L.metadataBytes})`,
					commandText: sql<
						string | null
					>`substr(${mailbox.commandText}, 1, ${LEGACY_PAYLOAD_MAX_BYTES})`,
					metadataJson: sql<string>`substr(${mailbox.metadataJson}, 1, ${L.metadataBytes})`,
					createdBy: mailbox.createdBy,
					sourceNarratorId: mailbox.sourceNarratorId,
					sourceToolCallId: mailbox.sourceToolCallId,
					sourceAttempt: mailbox.sourceAttempt,
					contentRevision: mailbox.contentRevision,
					bufferedAt: mailbox.bufferedAt,
				})
				.from(mailbox)
				.where(
					and(
						eq(mailbox.narratorId, narratorId),
						ne(mailbox.state, "cancelled"),
						ne(mailbox.receiptDisposition, "recipient_deleted"),
						or(isNull(mailbox.recipientRefId), isNull(mailbox.currentMessageId)),
					),
				)
				.orderBy(asc(mailbox.arrivalSeq), asc(mailbox.id))
				.limit(L.pageSize)
				.all();
			for (const row of rows) ensureLegacyProjectionTx(tx, row);
			return rows.length;
		});
	}
	function prepareLegacyProjection(narratorId: string): void {
		// Identity initialization and content projection are separate bounded pages so a
		// large old queue can be resumed without a monolithic transaction.
		db.transaction((tx) => initializeLegacyMailbox(tx, narratorId));
		repairLegacyProjections(narratorId);
	}
	function enqueue(input: MailboxInput, tx?: RuntimeTx): EnqueueResult {
		if (!tx) return db.transaction((inner) => enqueue(input, inner));
		const dedupeKey = mailboxDedupeKey(input);
		let existing = tx
			.select()
			.from(mailbox)
			.where(and(eq(mailbox.narratorId, input.narratorId), eq(mailbox.dedupeKey, dedupeKey)))
			.get();
		if (existing && (!existing.deliveryId || !existing.recipientMessageId)) {
			initializeLegacyMailbox(tx, input.narratorId);
			existing = tx
				.select()
				.from(mailbox)
				.where(and(eq(mailbox.narratorId, input.narratorId), eq(mailbox.dedupeKey, dedupeKey)))
				.get();
		}
		if (existing?.deliveryId && (!existing.recipientRefId || !existing.currentMessageId)) {
			ensureLegacyProjectionTx(tx, existing);
			existing = tx
				.select()
				.from(mailbox)
				.where(and(eq(mailbox.narratorId, input.narratorId), eq(mailbox.dedupeKey, dedupeKey)))
				.get();
		}
		if (existing) {
			const message = existing.deliveryId
				? readCanonicalMessageTreeTx(tx, input.narratorId, existing.deliveryId)
				: null;
			return { status: "duplicate", delivery: existing, ...(message ? { message } : {}) };
		}
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
				deliveryId: input.deliveryId ?? generateId(),
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
		if (!delivery.deliveryId || !delivery.recipientMessageId)
			throw new Error("Mailbox delivery identity missing");
		const projection = insertCanonicalMessageTx(
			tx,
			defaultHistory(input, delivery.deliveryId, delivery.recipientMessageId),
		);
		tx.update(mailbox)
			.set({ recipientRefId: projection.ref.id, currentMessageId: projection.message.id })
			.where(eq(mailbox.id, delivery.id))
			.run();
		const updatedDelivery = {
			...delivery,
			recipientRefId: projection.ref.id,
			currentMessageId: projection.message.id,
		};
		const message = readCanonicalMessageTreeTx(tx, input.narratorId, delivery.deliveryId);
		return {
			status: "accepted" as const,
			delivery: updatedDelivery,
			...(message ? { message } : {}),
		};
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
		const expectedMessageId = row.currentMessageId ?? row.recipientMessageId;
		if (binding.messageId !== expectedMessageId)
			throw new Error("Materializer must use the current reserved message identity");
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
		const materialized = tx
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
		mirrorDeliveryStateTx(tx, row.narratorId, row.deliveryId, "materialized");
		return materialized;
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
		return db.transaction((tx) => {
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
	function hasPendingWork(narratorId: string): boolean {
		if (
			db
				.select({ id: mailbox.id })
				.from(mailbox)
				.where(
					and(eq(mailbox.narratorId, narratorId), inArray(mailbox.state, ["queued", "claimed"])),
				)
				.limit(1)
				.get()
		)
			return true;
		return !!db
			.select({ id: outbox.id })
			.from(outbox)
			.where(and(eq(outbox.recipientId, narratorId), eq(outbox.state, "pending")))
			.limit(1)
			.get();
	}
	function peekEligibleHead(narratorId: string): MailboxRow | undefined {
		prepareLegacyProjection(narratorId);
		return db.transaction((tx) => {
			initializeLegacyMailbox(tx, narratorId);
			const head = eligibleHeads(tx, narratorId, 1)[0];
			return head
				? tx
						.select()
						.from(mailbox)
						.where(
							and(
								eq(mailbox.id, head.id),
								eq(mailbox.narratorId, narratorId),
								eq(mailbox.state, "queued"),
							),
						)
						.get()
				: undefined;
		});
	}
	function claimEligibleHead(
		narratorId: string,
		owner: { token: string; epoch: string },
		accepts: (head: EligibleMailboxHead) => boolean = () => true,
	): MailboxRow | undefined {
		pointer(owner.token);
		pointer(owner.epoch);
		prepareLegacyProjection(narratorId);
		return db.transaction((tx) => {
			if (!initializeLegacyMailbox(tx, narratorId)) return undefined;
			const head = eligibleHeads(tx, narratorId, 1)[0];
			if (!head || accepts(head) !== true) return undefined;
			const claimed = tx
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
			if (claimed) mirrorDeliveryStateTx(tx, claimed.narratorId, claimed.deliveryId, "claimed");
			return claimed;
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
		return db.transaction((tx) => {
			const page = tx
				.select({
					id: mailbox.id,
					narratorId: mailbox.narratorId,
					claimToken: mailbox.claimToken,
					claimEpoch: mailbox.claimEpoch,
					deliveryId: mailbox.deliveryId,
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
				const changed = tx
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
				if (changed) {
					mirrorDeliveryStateTx(tx, row.narratorId, row.deliveryId, "queued");
					recovered += changed;
				}
			}
			return { recovered, nextAfterId: page.length > limit ? page[limit - 1]?.id : undefined };
		});
	}
	return {
		enqueue,
		getByDelivery,
		hasPendingWork,
		peekEligibleHead,
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
			return db.transaction((tx) => initializeLegacyMailbox(tx, narratorId));
		},
		hasLegacyProjectionWork,
		repairLegacyProjections,
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
					recipientRefId: mailbox.recipientRefId,
					currentMessageId: mailbox.currentMessageId,
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
			prepareLegacyProjection(narratorId);
			return db.transaction((tx) => {
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
						mirrorDeliveryStateTx(tx, row.narratorId, row.deliveryId, "claimed");
						claimed.push(row);
						bytes += row.projectedByteSize;
					}
					if (bytes >= Math.min(budget.bytes ?? L.batchBytes, L.batchBytes)) break;
				}
				return claimed;
			});
		},
		materialize(claim: MailboxClaim, materializer: Materializer) {
			return db.transaction((tx) => {
				const row = requireClaim(tx, claim);
				const existing = row.recipientRefId
					? tx
							.select({ id: narratorMessageRefs.id, messageId: narratorMessageRefs.messageId })
							.from(narratorMessageRefs)
							.where(
								and(
									eq(narratorMessageRefs.id, row.recipientRefId),
									eq(narratorMessageRefs.narratorId, row.narratorId),
								),
							)
							.get()
					: undefined;
				const binding = existing
					? { messageId: existing.messageId, refId: existing.id, revision: row.contentRevision }
					: materializer(tx, row);
				if (binding && typeof (binding as unknown as { then?: unknown }).then === "function")
					throw new Error("Materializer must be synchronous");
				return materializeInTransaction(tx, claim, binding);
			});
		},
		failClaim(claim: MailboxClaim, error: string) {
			return db.transaction((tx) => {
				const row = requireClaim(tx, claim);
				const state = row.claimAttempts >= L.claimMaxAttempts ? "failed" : "queued";
				const changed =
					tx
						.update(mailbox)
						.set({
							state,
							claimToken: null,
							claimEpoch: null,
							claimedAt: null,
							lastError: boundedError(error),
							updatedAt: now(),
						})
						.where(claimWhere(claim))
						.returning({ id: mailbox.id })
						.all().length === 1;
				if (changed) mirrorDeliveryStateTx(tx, row.narratorId, row.deliveryId, state);
				return changed;
			});
		},
		recoverClaims(narratorId: string, terminatedEpoch: string, proof: { ownerTerminated: true }) {
			if (proof.ownerTerminated !== true)
				throw new Error("Owner termination proof required; elapsed time is insufficient");
			return db.transaction((tx) => {
				const rows = tx
					.select({
						id: mailbox.id,
						narratorId: mailbox.narratorId,
						deliveryId: mailbox.deliveryId,
					})
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
				for (const row of rows) {
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
					mirrorDeliveryStateTx(tx, row.narratorId, row.deliveryId, "queued");
				}
				return rows.length;
			});
		},
		retryFailed(deliveryId: string) {
			return db.transaction((tx) => {
				const row = tx.select().from(mailbox).where(eq(mailbox.deliveryId, deliveryId)).get();
				if (row) ensureLegacyProjectionTx(tx, row);
				const changed =
					tx
						.update(mailbox)
						.set({ state: "queued", claimAttempts: 0, lastError: null, updatedAt: now() })
						.where(and(eq(mailbox.deliveryId, deliveryId), eq(mailbox.state, "failed")))
						.returning({ id: mailbox.id })
						.all().length === 1;
				if (changed && row) mirrorDeliveryStateTx(tx, row.narratorId, deliveryId, "queued");
				return changed;
			});
		},
		/** Never unlinks files: uploaded/history files may be shared. Claimed payload cannot be cancelled here. */
		cancel(deliveryId: string, reason: string) {
			return db.transaction((tx) => {
				const row = tx.select().from(mailbox).where(eq(mailbox.deliveryId, deliveryId)).get();
				if (!row || row.state === "materialized" || !["queued", "failed"].includes(row.state))
					return false;
				const changed =
					tx
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
						.where(and(eq(mailbox.id, row.id), inArray(mailbox.state, ["queued", "failed"])))
						.returning({ id: mailbox.id })
						.all().length === 1;
				if (!changed) return false;
				if (row.kind === "user_input") cancelPendingUserProjection(tx, row);
				else mirrorDeliveryStateTx(tx, row.narratorId, deliveryId, "cancelled");
				return true;
			});
		},
		/** Revert/cancel owner uses its exact claim; arbitrary UI cancellation cannot release another owner's payload. */
		cancelClaim(claim: MailboxClaim, reason: string) {
			return db.transaction((tx) => {
				const row = requireClaim(tx, claim);
				const changed =
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
						.all().length === 1;
				if (changed) {
					if (row.kind === "user_input") cancelPendingUserProjection(tx, row);
					else mirrorDeliveryStateTx(tx, row.narratorId, row.deliveryId, "cancelled");
				}
				return changed;
			});
		},
		/** Legacy clear is a user-only projection, not DELETE WHERE narrator_id. Each call handles one page. */
		cancelUserPage(narratorId: string, reason: string) {
			return db.transaction((tx) => {
				const rows = tx
					.select({
						id: mailbox.id,
						narratorId: mailbox.narratorId,
						deliveryId: mailbox.deliveryId,
						recipientRefId: mailbox.recipientRefId,
						kind: mailbox.kind,
						state: mailbox.state,
					})
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
				const changed = tx
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
				for (const row of rows) {
					if (!changed.some((item) => item.id === row.id)) continue;
					if (row.kind === "user_input") cancelPendingUserProjection(tx, row as MailboxRow);
					else mirrorDeliveryStateTx(tx, row.narratorId, row.deliveryId, "cancelled");
				}
				return changed;
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
			return db.transaction((tx) => {
				const row = tx
					.select()
					.from(mailbox)
					.where(
						and(
							eq(mailbox.deliveryId, deliveryId),
							eq(mailbox.kind, "user_input"),
							eq(mailbox.state, "queued"),
							isNull(mailbox.payloadRefJson),
						),
					)
					.get();
				if (!row) return false;
				const projection = row.recipientRefId
					? updateCanonicalMessageTx(tx, {
							narratorId: row.narratorId,
							deliveryId,
							contentJson: [{ type: "text", text: patch.text }],
							contentText: patch.text,
							commandText: row.commandText,
						})
					: null;
				if (row.recipientRefId && !projection)
					throw new Error("Buffered message history projection is missing");
				const changed = tx
					.update(mailbox)
					.set({
						...patch,
						byteSize: Buffer.byteLength(patch.text),
						contentRevision: row.contentRevision + 1,
						currentRevision: row.currentRevision + 1,
						currentMessageId: projection?.message.id ?? row.currentMessageId,
						updatedAt: now(),
					})
					.where(and(eq(mailbox.id, row.id), eq(mailbox.state, "queued")))
					.returning({ id: mailbox.id })
					.all().length;
				return changed === 1;
			});
		},
		/** Call inside the history COW/edit/delete transaction, never for a fork's newly-created ref. */
		updateRecipientRef(
			tx: RuntimeTx,
			narratorId: string,
			refId: string,
			change:
				| { kind: "cow"; messageId: string }
				| { kind: "semantic_edit"; messageId: string }
				| { kind: "superseded" }
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
							change.kind === "superseded"
								? undefined
								: eq(narratorMessageRefs.messageId, change.messageId),
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
			const delivery = tx
				.select()
				.from(mailbox)
				.where(and(eq(mailbox.narratorId, narratorId), eq(mailbox.recipientRefId, refId)))
				.get();
			if (!delivery) return 0;
			const shouldCancel =
				(delivery.state === "queued" ||
					delivery.state === "claimed" ||
					delivery.state === "failed") &&
				(change.kind === "deleted" || change.kind === "superseded");
			return tx
				.update(mailbox)
				.set({
					...(shouldCancel
						? {
								...releasedPayload,
								state: "cancelled" as const,
								claimToken: null,
								claimEpoch: null,
								claimedAt: null,
							}
						: {}),
					recipientRefId: change.kind === "deleted" || change.kind === "superseded" ? null : refId,
					currentMessageId:
						change.kind === "deleted" || change.kind === "superseded" ? null : change.messageId,
					...(change.kind === "semantic_edit" || change.kind === "superseded"
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
				.where(and(eq(mailbox.id, delivery.id), eq(mailbox.recipientRefId, refId)))
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
			return db.transaction((tx) => {
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
			return db.transaction((tx) => {
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
