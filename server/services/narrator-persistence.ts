import { isDeepStrictEqual } from "node:util";
import { normalizeApiRequestDiagnostics } from "@shared/agent-protocol/error-diagnostics";
import {
	type CompactMessageMode,
	type CompactMessageTrigger,
	finishCompactAttempt,
	normalizeCompactAttempts,
	parseCompactMessageBlock,
	startCompactAttempt,
	truncateCompactError,
} from "@shared/compact-message";
import type { MessageOriginOptions } from "@shared/message-origin";
import { isNativeModelContextBlock, modelTextFromContentBlocks } from "@shared/native-injection";
import { and, desc, eq, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	fileChangeExecutionSegments,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import { isModelPlanReference } from "../lib/agent/strip-plan-body";
import type { EpochRecord } from "../lib/agent/tool-loading";
import type {
	ApiRequestDiagnostics,
	ReasoningProviderMetadata,
	ToolCallBinding,
	ToolExecutionPlan,
	ToolExecutionTarget,
} from "../lib/agent/types";
import { AsyncMutex, narratorSubstatusLock } from "../lib/async-mutex";
import type {
	AutoContinuationOverride,
	BooleanOverride,
	DangerReflectionOverride,
} from "../lib/boolean-override";
import { validatePersistedComposerDocument } from "../lib/composer-document";
import {
	measureMessageCharacters,
	measureSerializedCharacters,
	measureSummaryCharacters,
	queueContextCharacterRefresh,
} from "../lib/context-characters";
import { withDbRetry } from "../lib/db-resilience";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { legacyFastModeMirror } from "../lib/fast-mode";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { forcesRelaxedPlan, type PermissionMode } from "../lib/permission-modes";
import { policyDependentsWhere, runDeliverToOf } from "../lib/runtime-source";
import { settings } from "../lib/settings";
import { dualBroadcastToNarrator } from "../websocket/narrator-dual-broadcast";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { createMailboxStore } from "./agent-runtime/mailbox";
import type { MailboxClaim } from "./agent-runtime/mailbox-types";
import { getExecutionOwner, preserveHeldSubstatus } from "./agent-runtime/ownership";
import type { PgMaterializer } from "./agent-runtime/postgres-runtime-queue";
import { backgroundOccupancyStore } from "./background-occupancy-store";
import {
	contentByAttempt,
	flushQueuedSince,
	newEnvelopeColumns,
	patchEnvelopeState,
	type SyncMode,
	syncEnvelopeNow,
	syncQueueMark,
} from "./narrator-block-sync";
import { bodyColumns, fillBodies, fillBody } from "./narrator-body-reads";
import {
	insertEnvelope,
	readEnvelope,
	readEnvelopeBody,
	updateEnvelope,
	writeEnvelopeBody,
} from "./narrator-body-writes";
import { enrichToolUseBlocks, truncateToolIO } from "./narrator-messages";
import type { RefMessage, RefMessageInput } from "./narrator-refs/port";
import {
	type PgNarratorRefsTx,
	persistPgMessageWithRef,
	resolvePgMessageNarratorLocks,
} from "./narrator-refs/postgres-store";
import { dbTransactionWithSeqFloor } from "./narrator-refs/seq-floor-tx";
import {
	claimNextRefSeq,
	claimShiftInsertSlot,
	initializeRefSeqFloor,
	raiseSeqFloorForClaim,
} from "./narrator-refs/seq-store";
import { assertSqliteNarratorOperation, getNarratorMessageRefsPort } from "./narrator-refs/store";
import { preserveTurnTimingSubstatus, transitionTurnTimingSubstatus } from "./narrator-turn-timing";

// ── Internal helpers ───────────────────────────────────────────────────────

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Use the durable current-run receipt; provider IDs and creation origins are not execution authority. */
async function findExecutionSegmentParent(
	narratorId: string,
): Promise<{ executionSegmentId: string } | null> {
	const { resolveSubagentExecutionSegment } = await import("./subagent-execution-boundary");
	const segment = await resolveSubagentExecutionSegment(narratorId);
	return segment ? { executionSegmentId: segment.id } : null;
}

/**
 * Create the execution segment of a new tool attempt inside the caller's transaction:
 * the segment its file changes are attributed to commits with the attempt row.
 */
function insertExecutionSegmentTx(
	tx: DbTx,
	input: {
		narratorId: string;
		parentSegmentId: string | null;
		toolCallId: string;
		attempt: number;
		createdAt: string;
	},
): string {
	if (
		input.parentSegmentId &&
		!tx
			.select({ id: fileChangeExecutionSegments.id })
			.from(fileChangeExecutionSegments)
			.where(eq(fileChangeExecutionSegments.id, input.parentSegmentId))
			.get()
	)
		throw new Error("parent segment not found");
	const segmentId = generateId();
	tx.insert(fileChangeExecutionSegments)
		.values({
			id: segmentId,
			narratorId: input.narratorId,
			parentSegmentId: input.parentSegmentId,
			sourceToolCallId: input.toolCallId,
			sourceExecutionAttempt: input.attempt,
			sourceInputId: null,
			createdAt: input.createdAt,
		})
		.run();
	return segmentId;
}

/** A streamed tool_use block, as the assistant step stores it. */
interface StoredToolUseBlock {
	id: string;
	name: string;
	input: Record<string, unknown>;
	streamStartedAt?: number;
	streamCompletedAt?: number;
	thoughtSignature?: string;
	thoughtSignatureSource?: string;
}

/**
 * Create the ledger row of a new tool call, and the execution segment its file changes
 * are attributed to, inside the caller's transaction. The tool_use block, its row and
 * its segment are committed together or not at all: a block without a row is a call
 * the model made that the history can no longer pair with a result.
 */
function insertToolCallRowTx(
	tx: DbTx,
	input: {
		narratorId: string;
		messageId: string;
		parentSegmentId: string | null;
		block: StoredToolUseBlock;
		createdAt: string;
	},
): string {
	const { block } = input;
	const toolCallId = generateId();
	const segmentId = insertExecutionSegmentTx(tx, {
		narratorId: input.narratorId,
		parentSegmentId: input.parentSegmentId,
		toolCallId,
		attempt: 1,
		createdAt: input.createdAt,
	});
	tx.insert(narratorToolCalls)
		.values({
			executionSegmentId: segmentId,
			id: toolCallId,
			narratorId: input.narratorId,
			messageId: input.messageId,
			toolUseId: block.id,
			toolName: block.name,
			inputChars: measureSerializedCharacters(block.input),
			inputJson: withGeminiThoughtSignature(
				block.input,
				block.thoughtSignature,
				block.thoughtSignatureSource,
			),
			status: "initializing",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			streamStartedAt:
				typeof block.streamStartedAt === "number"
					? new Date(block.streamStartedAt).toISOString()
					: null,
			streamCompletedAt:
				typeof block.streamCompletedAt === "number"
					? new Date(block.streamCompletedAt).toISOString()
					: null,
			createdAt: input.createdAt,
		})
		.run();
	return toolCallId;
}

/** Recipient mutation also invalidates source pages, including child cards rendered in a parent. */
export function updateRecipientMessageRef(
	tx: DbTx,
	narratorId: string,
	refId: string,
	change: Parameters<ReturnType<typeof createMailboxStore>["updateRecipientRef"]>[3],
) {
	const sources = tx
		.select({ id: narratorBufferedMessages.sourceNarratorId })
		.from(narratorBufferedMessages)
		.where(
			and(
				eq(narratorBufferedMessages.narratorId, narratorId),
				eq(narratorBufferedMessages.recipientRefId, refId),
			),
		)
		.limit(100)
		.all();
	const changed = createMailboxStore(db).updateRecipientRef(tx, narratorId, refId, change);
	if (!changed) return;
	const ids = new Set(sources.flatMap((source) => (source.id ? [source.id] : [])));
	if (!ids.size) return;
	const parents = tx
		.select({ id: narrators.parentNarratorId })
		.from(narrators)
		.where(and(inArray(narrators.id, [...ids]), eq(narrators.type, "subagent")))
		.limit(100)
		.all();
	for (const parent of parents) if (parent.id) ids.add(parent.id);
	tx.update(narrators)
		.set({
			messageVersion: sql`${narrators.messageVersion} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(inArray(narrators.id, [...ids]))
		.run();
}

/** Preserve negative dedupe before removing recipient refs, in the caller's real transaction. */
export function deleteRecipientMessageRefs(tx: DbTx) {
	return {
		where(predicate: SQL | undefined) {
			return {
				run() {
					let changes = 0;
					for (;;) {
						const refs = tx
							.select({ id: narratorMessageRefs.id, narratorId: narratorMessageRefs.narratorId })
							.from(narratorMessageRefs)
							.where(predicate)
							.limit(100)
							.all();
						if (!refs.length) return { changes };
						for (const ref of refs)
							updateRecipientMessageRef(tx, ref.narratorId, ref.id, {
								kind: "deleted",
							});
						tx.delete(narratorMessageRefs)
							.where(
								inArray(
									narratorMessageRefs.id,
									refs.map((ref) => ref.id),
								),
							)
							.run();
						changes += refs.length;
					}
				},
			};
		},
	};
}
const toolAttemptCreationLock = new AsyncMutex();

/** Compatibility callers may omit the PK only when there is exactly one possible row. */
async function resolveToolCallWriteId(
	toolUseId: string,
	options: { toolCallId?: string; messageId?: string; narratorId?: string } = {},
): Promise<string | undefined> {
	const rows = await db
		.select({ id: narratorToolCalls.id })
		.from(narratorToolCalls)
		.where(
			and(
				eq(narratorToolCalls.toolUseId, toolUseId),
				options.toolCallId ? eq(narratorToolCalls.id, options.toolCallId) : undefined,
				options.messageId ? eq(narratorToolCalls.messageId, options.messageId) : undefined,
				options.narratorId ? eq(narratorToolCalls.narratorId, options.narratorId) : undefined,
			),
		)
		.limit(2);
	if (rows.length > 1)
		throw new ValidationError(
			"An exact tool-call row id is required for repeated toolUseId values",
		);
	return rows[0]?.id;
}

type CompactBoundary = { messageId: string; seq: number };

type ExecutionTargetRow = Pick<
	typeof narratorToolCalls.$inferSelect,
	| "executionDeviceId"
	| "executionCwd"
	| "executionPathFlavor"
	| "resolvedFilePath"
	| "canonicalFilePath"
	| "runtimeGeneration"
	| "executionTargetsJson"
	| "deviceSelectionSource"
>;

function isToolExecutionTarget(value: unknown): value is ToolExecutionTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const target = value as Partial<ToolExecutionTarget>;
	return (
		typeof target.deviceId === "string" &&
		(target.backendKind === "local" || target.backendKind === "remote") &&
		typeof target.cwd === "string" &&
		(target.selectionSource === "explicit" ||
			target.selectionSource === "session_default" ||
			target.selectionSource === "local_default")
	);
}

function normalizeExecutionTarget(target: ToolExecutionTarget): ToolExecutionTarget {
	const lexicalPath = target.lexicalPath ?? target.resolvedFilePath;
	return {
		deviceId: target.deviceId,
		backendKind: target.backendKind,
		cwd: target.cwd,
		...(target.pathFlavor !== undefined && { pathFlavor: target.pathFlavor }),
		...(lexicalPath !== undefined && { lexicalPath, resolvedFilePath: lexicalPath }),
		...(target.canonicalPath !== undefined && { canonicalPath: target.canonicalPath }),
		...(target.runtimeGeneration !== undefined && {
			runtimeGeneration: target.runtimeGeneration,
		}),
		selectionSource: target.selectionSource,
	};
}

function parseStoredExecutionTargets(value: unknown): ToolExecutionTarget[] {
	let candidates: unknown[];
	if (Array.isArray(value)) {
		candidates = value;
	} else if (isToolExecutionTarget(value)) {
		candidates = [value];
	} else if (
		value &&
		typeof value === "object" &&
		Array.isArray((value as ToolExecutionPlan).endpoints)
	) {
		// The PRIMARY endpoint must come first, not endpoints[0].
		//
		// Callers treat index 0 as "the target this row is frozen to" (see
		// reconstructToolExecutionTarget and the target writer's array merge). For a
		// multi-endpoint plan those differ: TransferFile lists its host endpoint first
		// while primaryKey is the remote one, so honoring array order pinned the wrong
		// device and made the very next freeze of the SAME plan look like a device change.
		const plan = value as ToolExecutionPlan;
		const endpoints = plan.endpoints;
		const primaryIndex = endpoints.findIndex((endpoint) => endpoint?.key === plan.primaryKey);
		// Optional chaining throughout: this parses UNTRUSTED stored JSON (older builds,
		// hand-edited rows), which is why the findIndex above already guards with `?.`. A
		// null/undefined element must not crash the freeze comparison — the trailing
		// isToolExecutionTarget filter drops whatever does not survive.
		candidates =
			primaryIndex > 0
				? [
						endpoints[primaryIndex]?.target,
						...endpoints.filter((_, index) => index !== primaryIndex).map((e) => e?.target),
					]
				: endpoints.map((endpoint) => endpoint?.target);
	} else {
		candidates = [];
	}
	return candidates.filter(isToolExecutionTarget).map(normalizeExecutionTarget);
}

/**
 * The stored value as a PLAN, or null when it is the legacy target-array form.
 *
 * `executionTargetsJson` is written in both shapes (see updateToolCallExecutionPlan's
 * freeze comparison), and only the plan shape carries per-endpoint `operation`. Telling
 * them apart is what lets the freeze compare at full precision when the information is
 * there, instead of silently degrading to targets-only for every row.
 */
function parseStoredExecutionPlan(value: unknown): ToolExecutionPlan | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as ToolExecutionPlan;
	if (!Array.isArray(candidate.endpoints)) return null;
	return candidate;
}

/**
 * Order-independent signature of a plan's routing: every endpoint's operation paired
 * with its normalized target.
 *
 * Sorted so a pure reordering of equivalent endpoints is not mistaken for a change,
 * while an added, removed, or escalated endpoint is.
 */
function planRoutingSignature(plan: ToolExecutionPlan): string {
	const entries = (plan.endpoints ?? [])
		.filter((endpoint) => isToolExecutionTarget(endpoint?.target))
		.map((endpoint) =>
			JSON.stringify({
				operation: endpoint.operation ?? null,
				target: normalizeExecutionTarget(endpoint.target),
			}),
		)
		.sort();
	return JSON.stringify(entries);
}

/**
 * Signature of the frozen routing a stored column describes, or null when it pins
 * nothing. Precision follows the stored shape: a plan carries per-endpoint operations
 * and is compared as a plan, while the legacy target-array form never held operations
 * and can only be compared on targets.
 */
function frozenRoutingSignature(
	stored: unknown,
	incoming: ToolExecutionPlan,
): { frozen: string; incoming: string } | null {
	const storedPlan = parseStoredExecutionPlan(stored);
	const frozen = storedPlan
		? planRoutingSignature(storedPlan)
		: JSON.stringify(parseStoredExecutionTargets(stored));
	if (frozen === "[]") return null;
	return {
		frozen,
		incoming: storedPlan
			? planRoutingSignature(incoming)
			: JSON.stringify(parseStoredExecutionTargets(incoming)),
	};
}

function normalizeExecutionPlan(plan: ToolExecutionPlan): ToolExecutionPlan {
	return {
		kind: plan.kind,
		primaryKey: plan.primaryKey,
		endpoints: plan.endpoints.map((endpoint) => ({
			key: endpoint.key,
			operation: endpoint.operation,
			target: normalizeExecutionTarget(endpoint.target),
		})),
	};
}

/** Reconstruct complete target objects while remaining compatible with pre-identity rows. */
export function reconstructToolExecutionTargets(row: ExecutionTargetRow): ToolExecutionTarget[] {
	const stored = parseStoredExecutionTargets(row.executionTargetsJson);
	if (stored.length > 0) return stored;
	// A missing executionCwd is NOT synthesized: an invented baseline would make the
	// pre-granted drift check compare against fiction, so such rows are treated as
	// "no pinned identity" and simply re-freeze. deviceSelectionSource may be absent on
	// rows written before that column existed, so derive it from the device kind exactly
	// like the permission layer does rather than discarding the whole pinned identity.
	if (!row.executionDeviceId || !row.executionCwd) return [];
	const lexicalPath = row.resolvedFilePath ?? undefined;
	return [
		normalizeExecutionTarget({
			deviceId: row.executionDeviceId,
			backendKind: row.executionDeviceId === "local" ? "local" : "remote",
			cwd: row.executionCwd,
			...(row.executionPathFlavor && { pathFlavor: row.executionPathFlavor }),
			...(lexicalPath && { lexicalPath, resolvedFilePath: lexicalPath }),
			...(row.canonicalFilePath && { canonicalPath: row.canonicalFilePath }),
			...(row.runtimeGeneration !== null && { runtimeGeneration: row.runtimeGeneration }),
			selectionSource:
				row.deviceSelectionSource ??
				(row.executionDeviceId === "local" ? "local_default" : "session_default"),
		}),
	];
}

export function reconstructToolExecutionTarget(
	row: ExecutionTargetRow,
): ToolExecutionTarget | undefined {
	return reconstructToolExecutionTargets(row)[0];
}

type MessageCopyResult = {
	messageId: string;
	ref: typeof narratorMessageRefs.$inferSelect;
	copied: boolean;
};

/**
 * The copy-on-write step every path shares (§6.3): give one ref its own copy of a
 * shared envelope, inside the caller's transaction.
 *   - The copy belongs to the ref's narrator and keeps the original's author and
 *     creation time.
 *   - The given ledger rows are cloned onto it as history, each pointing back at the row
 *     it copies.
 *   - Its blocks are built now and point at the blocks they copy.
 *   - The ref, the holder's mailbox receipt (when `receipt` is given) and the holder's
 *     fork boundary move to the copy.
 */
export function cowEnvelopeTx(
	tx: DbTx,
	input: {
		/** The envelope copied, its body as readers read it (`readEnvelope`). */
		original: typeof narratorMessages.$inferSelect;
		ref: { id: string; narratorId: string };
		changes?: Partial<typeof narratorMessages.$inferInsert>;
		toolCalls: ReadonlyArray<typeof narratorToolCalls.$inferSelect>;
		receipt?: "semantic_edit" | "cow";
	},
): string {
	const { original, ref } = input;
	const id = generateId();
	const now = new Date().toISOString();
	const copy = {
		...original,
		...input.changes,
		id,
		narratorId: ref.narratorId,
		authorNarratorId: original.authorNarratorId ?? original.narratorId,
		createdAt: original.createdAt,
	};
	insertEnvelope(tx, copy, {
		copyOf: original.id,
		rows: () => {
			if (input.toolCalls.length)
				tx.insert(narratorToolCalls)
					.values(
						input.toolCalls.map((call) => ({
							...call,
							executionOriginToolCallId: call.executionOriginToolCallId ?? call.id,
							id: generateId(),
							narratorId: ref.narratorId,
							messageId: id,
							createdAt: now,
						})),
					)
					.run();
		},
	});
	tx.update(narratorMessageRefs)
		.set({ messageId: id })
		.where(eq(narratorMessageRefs.id, ref.id))
		.run();
	if (input.receipt)
		updateRecipientMessageRef(tx, ref.narratorId, ref.id, { kind: input.receipt, messageId: id });
	tx.update(narrators)
		.set({ forkMessageId: id })
		.where(and(eq(narrators.id, ref.narratorId), eq(narrators.forkMessageId, original.id)))
		.run();
	return id;
}

/**
 * Copy a message for one narrator while the caller already holds a native
 * synchronous transaction. Message rows are shared through refs when a full
 * fork inherits history, so any lifecycle mutation must first move the current
 * narrator's ref to a private row. `forceCopy` is used by restart recovery when
 * several refs are being migrated from the same source row in one transaction.
 */
function copyMessageForNarratorTx(
	tx: DbTx,
	narratorId: string,
	messageId: string,
	overrides: Partial<typeof narratorMessages.$inferInsert> = {},
	forceCopy = false,
): MessageCopyResult {
	if (Object.hasOwn(overrides, "contentJson") || Object.hasOwn(overrides, "contentText")) {
		const original = readEnvelope(tx, messageId);
		if (!original) throw new NotFoundError("Message", messageId);
		overrides = {
			...overrides,
			contextCharsJson: measureMessageCharacters(
				overrides.role ?? original.role,
				overrides.contentJson !== undefined ? overrides.contentJson : original.contentJson,
				overrides.contentText !== undefined ? overrides.contentText : original.contentText,
			),
		};
	}
	const ref = tx.query.narratorMessageRefs
		.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		})
		.sync();
	if (!ref) throw new NotFoundError("Message", messageId);

	const refs = tx
		.select({ id: narratorMessageRefs.id, narratorId: narratorMessageRefs.narratorId })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.messageId, messageId))
		.all();
	const shouldCopy = forceCopy || refs.length > 1;
	if (!shouldCopy) {
		if (Object.keys(overrides).length) updateEnvelope(tx, messageId, overrides);
		return { messageId, ref, copied: false };
	}

	const original = readEnvelope(tx, messageId);
	if (!original) throw new NotFoundError("Message", messageId);

	const originalToolCalls = tx.query.narratorToolCalls
		.findMany({ where: eq(narratorToolCalls.messageId, messageId) })
		.sync();
	const newMessageId = cowEnvelopeTx(tx, {
		original,
		ref,
		changes: overrides,
		toolCalls: originalToolCalls,
	});

	return {
		messageId: newMessageId,
		ref: { ...ref, messageId: newMessageId },
		copied: true,
	};
}

function getLatestSuccessfulCompactBoundarySync(
	tx: DbTx,
	narratorId: string,
): CompactBoundary | null {
	const rows = tx
		.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(1)
		.all();
	return rows[0] ?? null;
}

/**
 * Embed a Gemini 3 thought signature inside a tool call's persisted inputJson
 * under a reserved key so it survives history rebuilds (reload/compact) without
 * a DB schema change. The Gemini provider strips this key before sending the
 * args back to the model. Non-Gemini tool calls are stored unchanged.
 */
function withGeminiThoughtSignature(
	input: unknown,
	thoughtSignature: unknown,
	thoughtSignatureSource: unknown,
): unknown {
	if (
		typeof thoughtSignature !== "string" ||
		!thoughtSignature ||
		!input ||
		typeof input !== "object" ||
		Array.isArray(input)
	) {
		return input;
	}
	return {
		...(input as Record<string, unknown>),
		__geminiThoughtSignature: thoughtSignature,
		...(typeof thoughtSignatureSource === "string" && thoughtSignatureSource
			? { __geminiThoughtSignatureSource: thoughtSignatureSource }
			: {}),
	};
}

async function bumpNarratorMessageVersions(
	narratorIds: Iterable<string | null | undefined>,
): Promise<void> {
	const ids = [...new Set([...narratorIds].filter((id): id is string => !!id))];
	if (ids.length === 0) return;
	await db
		.update(narrators)
		.set({
			messageVersion: sql`${narrators.messageVersion} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(inArray(narrators.id, ids));
}

export async function bumpParentNarratorMessageVersion(
	parentToolUseId?: string | null,
): Promise<void> {
	if (!parentToolUseId) return;
	const parentToolCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.toolUseId, parentToolUseId),
		columns: { narratorId: true },
	});
	if (!parentToolCall) return;
	await bumpNarratorMessageVersions([parentToolCall.narratorId]);
}

/**
 * Bump one narrator's message version after its messages were mutated outside the
 * ordinary insert/append paths.
 *
 * Every other mutation in this file bumps the version inline; a mutation that skips it
 * stays invisible to incremental sync, so a client that reconnects keeps its stale copy.
 * Exposed for in-place content edits such as discarding the blocks of a replayed
 * provider attempt.
 */
export async function bumpNarratorMessageVersion(narratorId: string): Promise<void> {
	await bumpNarratorMessageVersions([narratorId]);
}

/** Insert a message into narrator_message_refs junction table */
async function insertMessageRef(
	narratorId: string,
	messageId: string,
	seq: number,
	isCompact = 0,
): Promise<void> {
	assertSqliteNarratorOperation("insertMessageRef");
	await withDbRetry(
		async () =>
			dbTransactionWithSeqFloor(narratorId, (tx) => {
				tx.insert(narratorMessageRefs)
					.values({ id: generateId(), narratorId, messageId, seq, isCompact })
					.run();
				initializeRefSeqFloor(tx, narratorId);
			}),
		{ label: "insertMessageRef", maxRetries: 5 },
	);
}

/**
 * Synchronous variant of {@link appendMessageRefTx} for use inside a
 * synchronous `db.transaction((tx) => …)` — the ONLY genuinely atomic
 * transaction form under bun:sqlite (async callbacks commit at the first
 * `await`, leaving later writes outside the transaction). Uses Drizzle's
 * synchronous terminal methods (`.all()` / `.run()` / `.sync()`).
 */
function appendMessageRefSync(
	tx: DbTx,
	narratorId: string,
	messageId: string,
	isCompact = 0,
	/**
	 * Whether this insertion is visible to sync clients.
	 *
	 * `createPartialAssistantMessage` allocates a ref/seq for an EMPTY assistant
	 * shell before any `block_complete` lands. Announcing that shell would bump
	 * `messageVersion` without broadcastable content, deliver an empty row into
	 * the document, and let live-row hand-off retire streaming reasoning/text
	 * while the committed copy is still blank. The shell stays internal until
	 * `appendBlockToMessage` publishes real blocks.
	 */
	bumpMessageVersion = true,
): number {
	// The shared next_seq authority; the synchronous counter claim rolls back with this ref.
	raiseSeqFloorForClaim(tx, narratorId);
	const seq = claimNextRefSeq(tx, narratorId);

	tx.insert(narratorMessageRefs)
		.values({
			id: generateId(),
			narratorId,
			messageId,
			seq,
			isCompact,
		})
		.run();

	// messageCount is an insert-count upper bound, not sync authority — it still
	// advances for an unannounced partial. messageVersion is the sync token and
	// only moves when clients are meant to observe a change.
	//
	// Deletions are handled by the read path instead of by matching decrements: refs
	// are removed from ~30 scattered call sites, so the counter is treated as a fast
	// upper bound that self-corrects when read. See narrator-message-count.ts.
	tx.update(narrators)
		.set({
			...(bumpMessageVersion ? { messageVersion: sql`${narrators.messageVersion} + 1` } : {}),
			messageCount: sql`COALESCE(${narrators.messageCount}, 0) + 1`,
		})
		.where(eq(narrators.id, narratorId))
		.run();

	return seq;
}

/** Atomically get next seq and insert into narrator_message_refs */
async function appendMessageRef(
	narratorId: string,
	messageId: string,
	isCompact = 0,
): Promise<number> {
	assertSqliteNarratorOperation("appendMessageRef");
	return withDbRetry(
		async () =>
			dbTransactionWithSeqFloor(narratorId, (tx) =>
				appendMessageRefSync(tx, narratorId, messageId, isCompact),
			),
		{ label: "appendMessageRef", maxRetries: 5 },
	);
}

// ── Exported appendMessageRef for use by narrator-service.ts ───────────────
export { appendMessageRef, insertMessageRef };

const BACKGROUND_COMPACTING_SUBSTATUS = "background_compacting";

function preserveBackgroundCompactingSubstatus(current: string[], next: string[]): string[] {
	if (
		current.includes(BACKGROUND_COMPACTING_SUBSTATUS) &&
		!next.includes(BACKGROUND_COMPACTING_SUBSTATUS) &&
		!next.includes("compacting")
	) {
		return [...next, BACKGROUND_COMPACTING_SUBSTATUS];
	}
	return next;
}

async function writeSubstatus(
	narratorId: string,
	substatus: string[],
	now = new Date().toISOString(),
) {
	// Retry on transient SQLite locks so a busy DB never leaves a stale substatus
	// tag (e.g. "reflecting"/"reasoning") stuck on the narrator forever.
	await withDbRetry(
		() =>
			db
				.update(narrators)
				.set({ substatus: JSON.stringify(substatus), updatedAt: now })
				.where(eq(narrators.id, narratorId)),
		{ label: "writeSubstatus", maxRetries: 5 },
	);
	backgroundOccupancyStore.refreshNarrator(narratorId);
}

/**
 * Refuse to overwrite a stored ExitPlanMode plan with our own model-facing plan
 * reference ("The plan was approved. Its full content is saved in …").
 *
 * That sentence exists only for model history — the DB keeps the full plan so the
 * UI can render it. If it ever reaches this write path the user loses the plan
 * body entirely, in both the tool card and the message content. All three
 * conditions must hold before we intervene, so legitimate overwrites are
 * untouched:
 *
 *   (a) the row is an ExitPlanMode call,
 *   (b) the incoming plan IS the reference sentence — a `brokenInputOverride`
 *       placeholder or a user-edited plan never matches, and
 *   (c) the stored plan is longer and is NOT itself a reference — so a first
 *       write (no stored plan) or a genuine correction still goes through.
 *
 * The one overwrite this blocks is "the plan the user saw was already the
 * reference", which is exactly the corruption being guarded; `looksLikePathReference`
 * then makes the next resolution re-read the real plan file.
 */
function guardPersistedPlanBody(
	input: Record<string, unknown>,
	existing: { toolName?: string | null; inputJson?: unknown } | undefined,
	toolUseId: string,
): Record<string, unknown> {
	if (existing?.toolName !== "ExitPlanMode") return input;
	const incomingPlan = input.plan;
	if (typeof incomingPlan !== "string" || !isModelPlanReference(incomingPlan)) return input;
	const storedInput = existing.inputJson;
	if (!storedInput || typeof storedInput !== "object" || Array.isArray(storedInput)) return input;
	const storedPlan = (storedInput as Record<string, unknown>).plan;
	if (typeof storedPlan !== "string" || !storedPlan.trim()) return input;
	if (isModelPlanReference(storedPlan) || storedPlan.length <= incomingPlan.length) return input;
	logger.warn("Refused to overwrite a stored plan body with the model-only plan reference", {
		toolUseId,
		storedPlanChars: storedPlan.length,
		incomingPlanChars: incomingPlan.length,
	});
	return { ...input, plan: storedPlan };
}

/**
 * Replace a call's stored input — the ledger row and the step's tool_use block — inside
 * the caller's transaction, so the input a result was produced with and the input the
 * history replays never disagree. Returns the input actually stored.
 */
function overwriteToolInputTx(
	tx: DbTx,
	toolCallId: string,
	toolUseId: string,
	input: Record<string, unknown>,
): Record<string, unknown> {
	const existing = tx
		.select({
			messageId: narratorToolCalls.messageId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
		})
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, toolCallId))
		.get();
	const effective = guardPersistedPlanBody(input, existing, toolUseId);
	// Question responses belong to the execution receipt, never the authored SDK call.
	const messageId =
		existing?.messageId && existing.toolName !== "AskUserQuestion" ? existing.messageId : null;
	// Read before the ledger write, which queues the envelope for a sync.
	const body = messageId ? readEnvelopeBody(tx, messageId) : undefined;
	tx.update(narratorToolCalls)
		.set({ inputJson: effective, inputChars: measureSerializedCharacters(effective) })
		.where(eq(narratorToolCalls.id, toolCallId))
		.run();
	if (!messageId || !Array.isArray(body)) return effective;
	let changed = false;
	const patched = (body as Array<Record<string, unknown>>).map((block) => {
		if (block?.type !== "tool_use" || block.id !== toolUseId) return block;
		if (isDeepStrictEqual(block.input, effective)) return block;
		changed = true;
		return { ...block, input: effective };
	});
	if (changed) writeEnvelopeBody(tx, messageId, patched);
	return effective;
}

const COMPACT_RESTART_ERROR = "Interrupted by server restart";
const COMPACT_RECOVERY_PAGE_SIZE = 100;

/**
 * Recover compact markers left in the transient `[Compacting]` state.
 *
 * Modern markers carry attempt history and are audit records: preserve them,
 * fail every still-running attempt, and leave the marker retryable when its
 * history position is still valid. Legacy compact blocks with no attempt or
 * retry metadata are removed. Text-only placeholders or inconsistent non-pending
 * JSON are deliberately outside startup recovery: finding them would require a
 * historical table scan. Normal writers put the compact block first, which is
 * the same invariant used by the generated column and fork's pending index.
 */
export async function recoverStaleCompactingMessages(
	error = COMPACT_RESTART_ERROR,
): Promise<{ preserved: number; deleted: number }> {
	const startedAt = performance.now();
	// Both modern and legacy compact blocks are represented in this tiny partial
	// index. Never search historical message text (or fall back to doing so): a
	// missing index is a schema error, not permission to scan the message table.
	const upperBound = sqlite
		.query<{ cursor: number }, []>(
			`SELECT rowid AS cursor FROM narrator_messages INDEXED BY idx_messages_compact_pending
			 WHERE compact_pending = 1 ORDER BY rowid DESC LIMIT 1`,
		)
		.get()?.cursor;
	let selectionMs = performance.now() - startedAt;
	let recoveryMs = 0;
	let batches = 0;
	let candidates = 0;
	let skipped = 0;
	let failed = 0;
	let preserved = 0;
	let deleted = 0;
	let cursor: number | undefined;
	const failureText = truncateCompactError(error);

	// The startup admission barrier still owns concurrency. This bound only makes
	// this invocation finite; it is not a snapshot or a durable recovery cursor.
	while (upperBound !== undefined) {
		const selectionStartedAt = performance.now();
		const staleMessages = sqlite
			.query<{ cursor: number; id: string }, number[]>(
				`SELECT rowid AS cursor, id FROM narrator_messages INDEXED BY idx_messages_compact_pending
				 WHERE compact_pending = 1 AND rowid <= ? ${cursor === undefined ? "" : "AND rowid > ?"}
				 ORDER BY rowid LIMIT ?`,
			)
			.all(
				...(cursor === undefined
					? [upperBound, COMPACT_RECOVERY_PAGE_SIZE]
					: [upperBound, cursor, COMPACT_RECOVERY_PAGE_SIZE]),
			);
		selectionMs += performance.now() - selectionStartedAt;
		if (staleMessages.length === 0) break;
		batches++;
		candidates += staleMessages.length;
		// Advance independently of recovery success, so a failed row cannot trap us.
		cursor = staleMessages[staleMessages.length - 1].cursor;

		for (const stale of staleMessages) {
			const recoveryStartedAt = performance.now();
			const affectedNarrators = new Set<string>();
			try {
				const action = await withDbRetry(
					async () =>
						db.transaction((tx) => {
							const current = fillBody(
								tx.query.narratorMessages
									.findFirst({
										where: and(
											eq(narratorMessages.id, stale.id),
											eq(narratorMessages.compactPending, 1),
											eq(narratorMessages.role, "system"),
											eq(narratorMessages.contentText, "[Compacting]"),
										),
										...bodyColumns({ id: true, contentJson: true }),
									})
									.sync(),
							);
							if (!current) return "skipped" as const;

							const refs = tx
								.select()
								.from(narratorMessageRefs)
								.where(eq(narratorMessageRefs.messageId, stale.id))
								.all();
							for (const ref of refs) affectedNarrators.add(ref.narratorId);
							const blocks = Array.isArray(current.contentJson) ? current.contentJson : [];
							const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
							const attempts = normalizeCompactAttempts(compactBlock?.attempts);
							const hasRetryHistory =
								attempts.length > 0 ||
								compactBlock?.trigger === "retry" ||
								compactBlock?.retryBaseCompactMessageId !== undefined;
							const now = new Date().toISOString();

							if (refs.length === 0) {
								tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, stale.id)).run();
								tx.delete(narratorMessages).where(eq(narratorMessages.id, stale.id)).run();
								return "deleted" as const;
							}

							if (!compactBlock || !hasRetryHistory) {
								for (const ref of refs) {
									deleteRecipientMessageRefs(tx).where(eq(narratorMessageRefs.id, ref.id)).run();
									tx.update(narrators)
										.set({
											messageVersion: sql`${narrators.messageVersion} + 1`,
											updatedAt: now,
										})
										.where(eq(narrators.id, ref.narratorId))
										.run();
								}
								tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, stale.id)).run();
								tx.delete(narratorMessages).where(eq(narratorMessages.id, stale.id)).run();
								return "deleted" as const;
							}

							const failedAttempts = attempts.map((attempt) =>
								attempt.status === "running"
									? {
											...attempt,
											status: "failed" as const,
											finishedAt: now,
											error: failureText,
										}
									: attempt,
							);
							const failedBlock = {
								...compactBlock,
								status: "failed" as const,
								error: failureText,
								attempts: failedAttempts,
							};
							const failedOverrides: Partial<typeof narratorMessages.$inferInsert> = {
								contentJson: [failedBlock],
								contextCharsJson: measureMessageCharacters("system", [failedBlock]),
								contentText: `[Compact Failed] ${failureText.slice(0, 200)}...`,
								contextPercent: null,
							};
							const forceCopy = refs.length > 1;
							for (const ref of refs) {
								const copied = copyMessageForNarratorTx(
									tx,
									ref.narratorId,
									stale.id,
									failedOverrides,
									forceCopy,
								);
								tx.update(narratorMessageRefs)
									.set({ isCompact: 0 })
									.where(eq(narratorMessageRefs.id, ref.id))
									.run();
								tx.update(narrators)
									.set({
										messageVersion: sql`${narrators.messageVersion} + 1`,
										updatedAt: now,
									})
									.where(eq(narrators.id, ref.narratorId))
									.run();
								// Keep the local variable useful for reviewers and future callers: the
								// helper has moved this exact ref before the isCompact update.
								void copied;
							}

							// Every shared ref was moved to a private failed marker. Remove the
							// original only after the last source ref is gone.
							const remaining = tx.query.narratorMessageRefs
								.findFirst({ where: eq(narratorMessageRefs.messageId, stale.id) })
								.sync();
							if (!remaining) {
								tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, stale.id)).run();
								tx.delete(narratorMessages).where(eq(narratorMessages.id, stale.id)).run();
							}
							return "preserved" as const;
						}),
					{ label: "recoverStaleCompactingMessage", maxRetries: 5 },
				);
				if (action !== "skipped")
					for (const id of affectedNarrators) queueContextCharacterRefresh(id);
				if (action === "preserved") preserved++;
				else if (action === "deleted") deleted++;
				else skipped++;
			} catch (recoveryError) {
				failed++;
				logger.error("Failed to recover stale compacting message", {
					messageId: stale.id,
					error: String(recoveryError),
				});
			} finally {
				recoveryMs += performance.now() - recoveryStartedAt;
			}
		}
		if (staleMessages.length < COMPACT_RECOVERY_PAGE_SIZE || cursor >= upperBound) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	const durationMs = performance.now() - startedAt;
	const stats = {
		batches,
		candidates,
		preserved,
		deleted,
		skipped,
		failed,
		selectionMs,
		recoveryMs,
		durationMs,
	};
	if (durationMs >= 1_000) logger.warn("Slow stale compacting message recovery on startup", stats);
	else logger.info("Stale compacting message recovery completed on startup", stats);
	return { preserved, deleted };
}

/**
 * Where a message row sits in the narrator's message tree.
 *
 * ## Why this is an option object and not a positional argument
 *
 * `parentToolUseId` is the third thing a persisted row states, alongside "who is
 * speaking" (`role`) and "what is said" (`contentJson`): WHICH tool_use subtree it
 * belongs to. It was previously only expressible through a separate entry point
 * (`persistSubagentUserMessage`), which is why structured injection —
 * `deliverInjection`, whose only two writers are the two methods here — could not
 * reach a subagent's subtree at all, no matter what it wanted to say.
 *
 * An object rather than a seventh positional parameter because both methods already
 * take five optional positionals; a bare `string | null` in that queue is the kind of
 * argument that gets passed in the wrong slot without a type error (`createdBy`,
 * `commandText` and this are all nullable strings).
 *
 * ## The default is load-bearing
 *
 * Omitted means `null` means "top-level row", which is every primary-narrator call
 * site and every pre-existing caller. A row with a `parentToolUseId` is invisible to
 * `buildHistory` (every provider filters `!m.parentToolUseId`) and to a primary
 * narrator's page loader (`isNull(parentToolUseId)`), so setting it by accident does
 * not corrupt anything — it makes the row silently unreadable, which is worse. Only
 * pass it when the recipient is a subagent whose page drops the filter.
 */
export interface MessagePlacementOptions {
	composerDocument?: import("@shared/composer-document").ComposerDocument;
	/** Reserved by the exact agent delivery; never supplied by public input. */
	messageId?: string;
	/** Claimed durable input; user_input does not require an agent delivery envelope. */
	mailboxClaim?: MailboxClaim;
	/**
	 * The `tool_use` id that owns this row — the Agent/Task call that spawned the
	 * recipient subagent. Null/omitted writes a top-level row.
	 */
	parentToolUseId?: string | null;
	/**
	 * Commit related state in the SAME synchronous transaction as the message and ref.
	 * Throwing rolls back all writes; the hook can run again after a SQLite busy retry.
	 * No asynchronous work or external side effects are allowed here.
	 */
	onPersist?: (tx: DbTx, messageId: string, refId: string) => undefined;
}

function placementMessageId(placement?: MessagePlacementOptions): string {
	if (placement?.messageId) return placement.messageId;
	if (!placement?.mailboxClaim) return generateId();
	const row = db
		.select({ messageId: narratorBufferedMessages.recipientMessageId })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.id, placement.mailboxClaim.id))
		.get();
	if (!row?.messageId) throw new Error("Mailbox claim has no reserved recipient identity");
	return row.messageId;
}

function persistPlacement(
	tx: DbTx,
	narratorId: string,
	messageId: string,
	placement?: MessagePlacementOptions,
) {
	if (!placement?.mailboxClaim && !placement?.onPersist) return;
	const ref = tx
		.select({ id: narratorMessageRefs.id })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		)
		.get();
	if (!ref) throw new Error("Message placement did not persist a recipient ref");
	if (placement.mailboxClaim) {
		const owner = getExecutionOwner(narratorId);
		if (!owner?.isCurrent() || owner.epoch !== placement.mailboxClaim.epoch)
			throw new Error("Stale mailbox claim execution owner");
		if (placement.mailboxClaim.narratorId !== narratorId)
			throw new Error("Mailbox recipient mismatch");
		createMailboxStore(db).materializeInTransaction(tx, placement.mailboxClaim, {
			messageId,
			refId: ref.id,
		});
	}
	placement.onPersist?.(tx, messageId, ref.id);
}

// ── PostgreSQL placement seam ──────────────────────────────────────────────
//
// The SQLite path above commits message + ref + mailbox materialization in ONE
// synchronous transaction (`persistPlacement` inside `db.transaction`). The
// PostgreSQL counterpart cannot ride this module's entry points: the mailbox
// row lives behind the PG runtime queue, and the queue — not the caller —
// owns the materialize transaction (`mailbox.materialize`, which validates the
// claim, then runs the materializer, then flips the mailbox row, all inside one
// `withPgRetry`-wrapped section).
//
// THE SEAM: the caller that holds a PG mailbox claim builds its message row
// exactly as it would for `persistUserMessage`/`persistSystemMessage` — with
// `id` set to the claim's reserved `recipientMessageId` — and hands it to
//
//   queue.materialize(claim, createPgPlacedMessageMaterializer(message, hooks))
//
// `createPgPlacedMessageMaterializer` is the ONLY PG placement operation this
// module exposes: inside the queue's transaction it delegates the
// lock/claim-seq/insert/version-bump sequence to the named refs helper
// (`persistPgMessageWithRef`) and then runs the PG `onPersist` hook in the
// same transaction, so message, ref, hook effects and the mailbox flip commit
// or roll back together. Caller migration to this seam is a separate phase;
// until then the public entry points below stay fail-closed (see
// `assertPgPlacement`).

/** Transaction handle the PG `onPersist` hook receives — the queue's live section. */
export type PgPlacementTx = PgNarratorRefsTx;

export interface PgMessagePlacementHooks {
	/** All additional narrator rows touched by onPersist, declared before locks are acquired. */
	narratorIds?: readonly string[];
	/**
	 * PG counterpart of {@link MessagePlacementOptions.onPersist}: commits related
	 * state in the SAME transaction as the message, ref and mailbox materialization.
	 * Unlike the SQLite hook it MAY await (a networked driver inside the transaction
	 * is safe), and a throw rolls the whole materialize section back.
	 */
	onPersist?: (tx: PgPlacementTx, messageId: string, refId: string) => void | Promise<void>;
}

/**
 * Build the queue-compatible materializer for one placed message. The reserved
 * identity is enforced twice — here against the claimed row and again by the
 * queue's materialize section — and the recipient is pinned to the claim's
 * narrator, so a materializer built for one delivery can never write into
 * another narrator's history.
 */
export function createPgPlacedMessageMaterializer(
	message: RefMessageInput,
	hooks?: PgMessagePlacementHooks,
): PgMaterializer {
	message = {
		...message,
		contextCharsJson: measureMessageCharacters(
			message.role,
			message.contentJson,
			message.contentText,
		),
	};
	const materializer: PgMaterializer = async (tx, row) => {
		if (row.narratorId !== message.narratorId) throw new Error("Mailbox recipient mismatch");
		if (!row.recipientMessageId)
			throw new Error("Mailbox claim has no reserved recipient identity");
		if (message.id !== row.recipientMessageId)
			throw new Error("Placed message must use the reserved recipient identity");
		const persisted = await persistPgMessageWithRef(tx, message);
		await hooks?.onPersist?.(tx, persisted.messageId, persisted.refId);
		return { messageId: persisted.messageId, refId: persisted.refId };
	};
	materializer.planNarratorLocks = async (tx, claim) => {
		if (claim.narratorId !== message.narratorId) throw new Error("Mailbox recipient mismatch");
		const { narratorIds } = await resolvePgMessageNarratorLocks(tx, message);
		return [...narratorIds, ...(hooks?.narratorIds ?? [])];
	};
	return materializer;
}

// ── narratorPersistence object ─────────────────────────────────────────────

async function appendPersistedMessage(
	message: RefMessageInput,
	options?: {
		bumpMessageVersion?: boolean;
		enabledTools?: string[];
		/** Rows that belong to the message, written in its transaction (SQLite only). */
		withRows?: (tx: DbTx) => void;
		/** How incomplete output reads when the envelope is stored as blocks. */
		blockMode?: SyncMode;
	},
): Promise<RefMessage> {
	const bumpMessageVersion = options?.bumpMessageVersion !== false;
	const pg = getNarratorMessageRefsPort();
	if (pg) {
		if (options?.withRows) throw new Error("PostgreSQL message rows unavailable");
		const created = await pg.append(message, {
			bumpMessageVersion,
			...(options?.enabledTools ? { enabledTools: options.enabledTools } : {}),
		});
		if (message.role !== "disp") queueContextCharacterRefresh(message.narratorId, message.id);
		return created;
	}
	const created = await withDbRetry(
		async () =>
			db.transaction((tx) => {
				const queueMark = syncQueueMark();
				let seq = 0;
				// The blocks commit with the envelope and the rows that belong to it.
				const created = insertEnvelope(
					tx,
					{
						...newEnvelopeColumns(message.narratorId),
						...message,
						authorNarratorId: message.authorNarratorId ?? message.narratorId,
					},
					{
						mode: options?.blockMode,
						rows: () => {
							seq = appendMessageRefSync(tx, message.narratorId, message.id, 0, bumpMessageVersion);
							options?.withRows?.(tx);
							if (options?.enabledTools)
								tx.update(narrators)
									.set({ enabledTools: options.enabledTools })
									.where(eq(narrators.id, message.narratorId))
									.run();
						},
					},
				);
				flushQueuedSince(queueMark);
				return { ...created, seq };
			}),
		{ label: "appendPersistedMessage", maxRetries: 5 },
	);
	if (message.role !== "disp") queueContextCharacterRefresh(message.narratorId, message.id);
	return created;
}

/**
 * Production placement calls stay FAIL-CLOSED on PostgreSQL this phase: the
 * callers still pass `mailboxClaim`/`onPersist` to these entry points instead of
 * driving `queue.materialize(claim, createPgPlacedMessageMaterializer(...))`,
 * and silently dropping the placement would lose the mailbox receipt. The error
 * names the seam so the migration target is unambiguous.
 */
function assertPgPlacement(placement?: MessagePlacementOptions): void {
	if (placement?.mailboxClaim || placement?.onPersist)
		throw new Error(
			"PostgreSQL narrator mailbox/onPersist placement unavailable on this entry point; " +
				"use queue.materialize(claim, createPgPlacedMessageMaterializer(message, hooks))",
		);
}

/** A late signature/cipher frame augments provider replay data; absent keys are not deletions. */
function mergeReasoningMetadata(
	previous: ReasoningProviderMetadata | undefined,
	incoming: ReasoningProviderMetadata,
): ReasoningProviderMetadata {
	const merged = {
		...previous,
		...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined)),
	};
	for (const provider of ["openai", "anthropic", "gemini"] as const) {
		if (incoming[provider]) {
			merged[provider] = {
				...previous?.[provider],
				...Object.fromEntries(
					Object.entries(incoming[provider]).filter(([, value]) => value !== undefined),
				),
			};
		}
	}
	return merged;
}

/**
 * Whether the narrator still has active background work whose completion WAKES
 * it — background bash tasks and background subagents. Two kinds of activity
 * deliberately do NOT count:
 *
 * - services (`bash` + `backgroundKind: "service"`), which are long-lived by
 *   definition and never part of "the turn's work";
 * - transfers, whose terminal commit skips publication entirely
 *   (`commitTerminalTask` returns early), so a transfer completing never
 *   produces a wake-up turn. Counting transfers here would suppress the done
 *   notification with no compensating re-raise — the exact leak this flag
 *   exists to avoid would become a notification that never arrives at all.
 *
 * Consulted only on the done-transition (`idle` + `unread`): a turn that
 * finished while its background work is still running is not worth pinging the
 * user about — the wake-up turn after the last background task completes emits
 * a fresh, unflagged "done". The occupancy store is flushed first so a task
 * started during the final turn is already indexed when we read. Note this
 * makes the done-path `status_change` broadcast wait for one occupancy
 * maintenance pass (a few small indexed reads); other transitions never pay it.
 *
 * Fail-open (false) before the store's startup scan completes or on error: the
 * fallback is simply today's behaviour (notify), never a swallowed attention.
 */
async function hasActiveBackgroundWork(narratorId: string): Promise<boolean> {
	try {
		if (!backgroundOccupancyStore.isReady) return false;
		await backgroundOccupancyStore.flush();
		return backgroundOccupancyStore.countActiveWakeWork(narratorId) > 0;
	} catch (err) {
		logger.warn("Failed to resolve background work occupancy; notifying as usual", {
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

const sqliteNarratorPersistence = {
	/**
	 * Persist a `role: "user"` message.
	 *
	 * `role: "user"` is a protocol/scheduling requirement (providers treat the
	 * trailing user message as the current turn, and the continuation scheduler
	 * only resumes from user/assistant), so system- and AI-injected turns land
	 * here too. Pass `origin` so the UI can attribute them correctly instead of
	 * showing every such turn as if the human typed it.
	 *
	 * `parentToolUseId` places the row in a tool_use subtree — see
	 * {@link MessagePlacementOptions}. Omitting it writes a top-level row, which is
	 * every primary-narrator call site.
	 */
	async persistUserMessage(
		narratorId: string,
		text: string,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
		commandText?: string | null,
		createdBy?: string | null,
		origin?: MessageOriginOptions,
		placement?: MessagePlacementOptions,
	) {
		const composerDocument = validatePersistedComposerDocument(
			placement?.composerDocument,
			contentBlocks ?? [{ type: "text", text }],
		);
		const parentToolUseId = placement?.parentToolUseId ?? null;
		const pg = getNarratorMessageRefsPort();
		if (pg) {
			assertPgPlacement(placement);
			const msg = await pg.append({
				id: placement?.messageId ?? generateId(),
				narratorId,
				parentToolUseId,
				role: "user",
				contentJson: contentBlocks ?? [{ type: "text", text }],
				composerDocument: composerDocument ?? null,
				contextCharsJson: measureMessageCharacters(
					"user",
					contentBlocks ?? [{ type: "text", text }],
					text,
				),
				contentText: text,
				commandText: commandText ?? null,
				createdBy: createdBy ?? null,
				origin: origin?.origin ?? "user",
				originLabel: origin?.originLabel ?? null,
				createdAt: new Date().toISOString(),
			});
			queueContextCharacterRefresh(narratorId, msg.id);
			const creator =
				createdBy && !(placement?.messageId && origin?.origin === "assistant")
					? await pg.creator(createdBy).catch(() => null)
					: null;
			return { ...msg, creator };
		}
		const msgWithSeq = await withDbRetry(
			async () => {
				const id = placementMessageId(placement);
				const now = new Date().toISOString();
				return db.transaction((tx) => {
					let seq = 0;
					const created = insertEnvelope(
						tx,
						{
							id,
							...newEnvelopeColumns(narratorId),
							narratorId,
							parentToolUseId,
							role: "user",
							contentJson: contentBlocks ?? [{ type: "text", text }],
							composerDocument: composerDocument ?? null,
							contextCharsJson: measureMessageCharacters(
								"user",
								contentBlocks ?? [{ type: "text", text }],
								text,
							),
							contentText: text,
							commandText: commandText ?? null,
							createdBy: createdBy ?? null,
							origin: origin?.origin ?? "user",
							originLabel: origin?.originLabel ?? null,
							createdAt: now,
						},
						{
							rows: () => {
								seq = appendMessageRefSync(tx, narratorId, id);
								persistPlacement(tx, narratorId, id, placement);
							},
						},
					);
					return { ...created, seq };
				});
			},
			{ label: "persistUserMessage", maxRetries: 5 },
		);
		queueContextCharacterRefresh(narratorId, msgWithSeq.id);

		// A child row also changes what the PARENT's page shows (the tool card's
		// activity snapshot), and the parent is a different narrator with its own
		// messageVersion. Without this the parent's incremental sync reports "nothing
		// changed" and its open panel keeps the stale card. No-op when there is no
		// parentToolUseId, which is the whole primary-narrator path.
		// Commit is the retry boundary for ALL inputs, not just reserved agent deliveries.
		// A human edit clears the delivery ID; requeueing on a post-commit error would
		// then insert the same input again under a new ID.
		await bumpParentNarratorMessageVersion(parentToolUseId).catch((error) => {
			logger.warn("Committed user message parent-version notification failed", {
				narratorId,
				messageId: msgWithSeq.id,
				error: String(error),
			});
		});
		// This audit user is intentionally not rendered for agent-authored inputs.
		if (placement?.messageId && origin?.origin === "assistant") {
			return { ...msgWithSeq, creator: null };
		}

		// NOTE: the creator row is returned whenever `createdBy` names an account, even
		// for a non-human `origin`. That is DELIBERATELY left as it was: the subagent
		// entry point withholds it for AI-authored text (see
		// `persistSubagentUserMessage`), and applying the same rule here would change
		// what several primary-narrator producers return (a scheduled task run carries
		// its configurer's `createdBy` with `origin: "system"`). Widening it is a
		// behaviour decision about the primary path, not part of opening this seam.
		if (createdBy) {
			try {
				const user = await db.query.users.findFirst({
					where: eq(users.id, createdBy),
					columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
				});
				return { ...msgWithSeq, creator: user ?? null };
			} catch (error) {
				// Display enrichment cannot turn a committed input into a failed write.
				// Keep createdBy on the row so later history reads can recover the creator.
				logger.warn("Committed user message creator lookup failed", {
					narratorId,
					messageId: msgWithSeq.id,
					error: String(error),
				});
			}
		}
		return { ...msgWithSeq, creator: null };
	},

	/**
	 * Persist a `role: "sys"` message: model-visible injected context that is not
	 * a human turn. Defaults to `origin: "system"`; pass `origin` explicitly when
	 * an AI or an identified human triggered the injection.
	 *
	 * `parentToolUseId` places the row in a tool_use subtree — see
	 * {@link MessagePlacementOptions}.
	 */
	async persistSystemMessage(
		narratorId: string,
		text: string,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
		createdBy?: string,
		origin?: MessageOriginOptions,
		placement?: MessagePlacementOptions,
	) {
		const parentToolUseId = placement?.parentToolUseId ?? null;
		const pg = getNarratorMessageRefsPort();
		if (pg) {
			assertPgPlacement(placement);
			const provided = contentBlocks ?? [];
			const native = provided.some(isNativeModelContextBlock);
			const blocks = native ? provided : [{ type: "text", text }, ...provided];
			const created = await pg.append({
				id: placement?.messageId ?? generateId(),
				narratorId,
				parentToolUseId,
				role: "sys",
				contentJson: blocks,
				contextCharsJson: measureMessageCharacters("sys", blocks, text),
				contentText: native ? modelTextFromContentBlocks(blocks) || text : text,
				createdBy: createdBy ?? null,
				origin: origin?.origin ?? "system",
				originLabel: origin?.originLabel ?? null,
				createdAt: new Date().toISOString(),
			});
			queueContextCharacterRefresh(narratorId, created.id);
			return created;
		}
		const msg = await withDbRetry(
			async () =>
				db.transaction((tx) => {
					const id = placementMessageId(placement);
					const now = new Date().toISOString();
					const providedBlocks = contentBlocks ?? [];
					const hasNativeModelContext = providedBlocks.some(isNativeModelContextBlock);
					const blocks: unknown[] = hasNativeModelContext
						? providedBlocks
						: [{ type: "text", text }, ...providedBlocks];
					let seq = 0;
					const created = insertEnvelope(
						tx,
						{
							id,
							...newEnvelopeColumns(narratorId),
							narratorId,
							parentToolUseId,
							role: "sys",
							contentJson: blocks,
							contextCharsJson: measureMessageCharacters("sys", blocks, text),
							contentText: hasNativeModelContext
								? modelTextFromContentBlocks(blocks) || text
								: text,
							createdBy: createdBy ?? null,
							origin: origin?.origin ?? "system",
							originLabel: origin?.originLabel ?? null,
							createdAt: now,
						},
						{
							rows: () => {
								seq = appendMessageRefSync(tx, narratorId, id);
								persistPlacement(tx, narratorId, id, placement);
							},
						},
					);
					return { ...created, seq };
				}),
			{ label: "persistSystemMessage", maxRetries: 5 },
		);
		queueContextCharacterRefresh(narratorId, msg.id);
		if (placement?.messageId || placement?.mailboxClaim) {
			await bumpParentNarratorMessageVersion(parentToolUseId).catch((error) => {
				logger.warn("Committed injection parent-version notification failed", {
					narratorId,
					messageId: msg.id,
					error: String(error),
				});
			});
		} else {
			await bumpParentNarratorMessageVersion(parentToolUseId);
		}
		return msg;
	},

	/**
	 * Persist the assistant card of a user-run tool (`/bash`) with its running ledger row,
	 * in one transaction: the card's tool_use never exists without the row its result
	 * settles.
	 */
	async persistManualToolCall(
		narratorId: string,
		input: {
			messageId: string;
			toolCallId: string;
			toolUseBlock: { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
			streamStartedAt: string;
			createdAt: string;
		},
	): Promise<RefMessage> {
		const { toolUseBlock } = input;
		return appendPersistedMessage(
			{
				id: input.messageId,
				narratorId,
				role: "assistant",
				contentJson: [toolUseBlock],
				contextCharsJson: measureMessageCharacters("assistant", [toolUseBlock]),
				contentText: null,
				createdAt: input.createdAt,
			},
			{
				withRows: (tx) =>
					tx
						.insert(narratorToolCalls)
						.values({
							id: input.toolCallId,
							narratorId,
							messageId: input.messageId,
							toolUseId: toolUseBlock.id,
							toolName: toolUseBlock.name,
							inputJson: toolUseBlock.input,
							inputChars: measureSerializedCharacters(toolUseBlock.input),
							status: "running",
							streamStartedAt: input.streamStartedAt,
							createdAt: input.createdAt,
						})
						.run(),
			},
		);
	},

	/**
	 * Persist the notice of a manual tool load or unload: a user row the model reads at
	 * its seq, written with its ref in one transaction.
	 */
	async persistToolChangeMessage(
		narratorId: string,
		block: {
			type: "tool_loaded" | "tool_unloaded";
			toolName: string;
			toolNames: string[];
			text: string;
			definitionSnapshots?: import("../lib/agent/tool-loading").ToolDefinitionSnapshot[];
		},
		/** `system` for a change the runtime reconciled rather than a `/load` someone typed. */
		origin?: "system",
		enabledTools?: string[],
	): Promise<RefMessage> {
		return appendPersistedMessage(
			{
				id: generateId(),
				narratorId,
				role: "user",
				contentJson: [block],
				contextCharsJson: measureMessageCharacters("user", [block], block.text),
				contentText: block.text,
				...(origin ? { origin } : {}),
				createdAt: new Date().toISOString(),
			},
			enabledTools ? { enabledTools } : undefined,
		);
	},

	/**
	 * Open an epoch (docs/BLOCK_STORAGE-DESIGN.md §7.7): a system row the model never
	 * sees, recording what the epoch's request prefix is rebuilt from.
	 */
	async persistEpochMarker(narratorId: string, epoch: EpochRecord): Promise<RefMessage> {
		return appendPersistedMessage({
			id: generateId(),
			narratorId,
			role: "system",
			contentJson: [{ type: "epoch", epoch }],
			contextCharsJson: { segments: [] },
			contentText: null,
			origin: "system",
			createdAt: new Date().toISOString(),
		});
	},

	async persistDisplayMessage(
		narratorId: string,
		text: string,
		// UI-only content blocks. When provided they replace the default `info`
		// block, letting callers render richer cards (e.g. spec_goal_added) while
		// keeping the message role `disp` so it never enters the model history.
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
	) {
		const msg = await appendPersistedMessage({
			id: generateId(),
			narratorId,
			role: "disp",
			contentJson: contentBlocks ?? [{ type: "info", message: text }],
			contextCharsJson: { segments: [] },
			// Custom-block callers supply already-formatted text; preserve legacy default.
			contentText: contentBlocks ? text : `[Info] ${text}`,
			createdAt: new Date().toISOString(),
		});
		const seq = msg.seq;
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: {
				id: msg.id,
				narratorId,
				role: "disp",
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				seq,
				children: [],
			},
		});
		return { ...msg, seq };
	},

	async persistCompactingMessage(
		narratorId: string,
		beforeMessageId?: string,
		mode: CompactMessageMode = "blocking",
		options?: {
			trigger?: CompactMessageTrigger;
			model?: string;
			contextPercentBefore?: number;
		},
	) {
		const id = generateId();
		const createdAt = new Date().toISOString();
		const model = options?.model?.trim() || settings.agent.summaryModel;
		const compactBlock = startCompactAttempt(
			{
				type: "compact",
				status: "compacting",
				mode,
				trigger: options?.trigger ?? (mode === "background" ? "background" : "manual"),
				...(options?.contextPercentBefore != null
					? { contextPercentBefore: options.contextPercentBefore }
					: {}),
			},
			model,
			createdAt,
		);

		return withDbRetry(
			async () =>
				dbTransactionWithSeqFloor(narratorId, (tx) => {
					let seq: number;
					if (beforeMessageId) {
						const targetRef = tx.query.narratorMessageRefs
							.findFirst({
								where: and(
									eq(narratorMessageRefs.narratorId, narratorId),
									eq(narratorMessageRefs.messageId, beforeMessageId),
								),
							})
							.sync();
						if (!targetRef) throw new NotFoundError("Message", beforeMessageId);
						seq = targetRef.seq;
						// Reserve a counter slot before shifting so appends cannot reuse it.
						claimShiftInsertSlot(tx, narratorId, seq);
					} else {
						seq = claimNextRefSeq(tx, narratorId);
					}

					const msg = insertEnvelope(tx, {
						id,
						...newEnvelopeColumns(narratorId),
						narratorId,
						role: "system",
						contentJson: [compactBlock],
						contextCharsJson: measureMessageCharacters("system", [compactBlock]),
						contentText: "[Compacting]",
						createdAt,
					});

					tx.insert(narratorMessageRefs)
						.values({
							id: generateId(),
							narratorId,
							messageId: id,
							seq,
							isCompact: 0,
						})
						.run();

					tx.update(narrators)
						.set({
							messageVersion: sql`${narrators.messageVersion} + 1`,
							updatedAt: createdAt,
						})
						.where(eq(narrators.id, narratorId))
						.run();

					return { ...msg, seq };
				}),
			{ label: "persistCompactingMessage", maxRetries: 5 },
		);
	},

	async prepareFailedCompactRetry(narratorId: string, messageId: string, model?: string) {
		const now = new Date().toISOString();
		const selectedModel = model?.trim() || settings.agent.summaryModel;
		return withDbRetry(
			async () =>
				db.transaction((tx) => {
					// Authorization is by the caller's ref, not the message's historical
					// owner. A full fork legitimately points at the parent's message row.
					const msg = fillBody(
						tx.query.narratorMessages
							.findFirst({
								...bodyColumns(),
								where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.role, "system")),
							})
							.sync(),
					);
					const ref = tx.query.narratorMessageRefs
						.findFirst({
							where: and(
								eq(narratorMessageRefs.narratorId, narratorId),
								eq(narratorMessageRefs.messageId, messageId),
							),
							columns: { id: true, seq: true, isCompact: true },
						})
						.sync();
					if (!msg || !ref) throw new NotFoundError("Message", messageId);
					const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
					const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
					if (!compactBlock || compactBlock.status !== "failed" || ref.isCompact !== 0) {
						throw new ValidationError("Message is not a retryable failed compact");
					}

					// Read and validate the effective compact boundary in the SAME transaction
					// that transitions this marker back to running. A failed marker is only
					// retryable while it remains strictly after the latest successful compact.
					const compactBoundary = getLatestSuccessfulCompactBoundarySync(tx, narratorId);
					if (compactBoundary && ref.seq <= compactBoundary.seq) {
						throw new ValidationError(
							"Failed compact is no longer retryable because a newer compact succeeded",
						);
					}
					const compactBoundaryMessageId = compactBoundary?.messageId ?? null;
					const retryBlock = {
						...startCompactAttempt(compactBlock, selectedModel, now),
						trigger: "retry" as const,
						retryBaseCompactMessageId: compactBoundaryMessageId,
					};
					const copied = copyMessageForNarratorTx(tx, narratorId, messageId, {
						contentJson: [retryBlock],
						contextCharsJson: measureMessageCharacters("system", [retryBlock]),
						contentText: "[Compacting]",
						contextPercent: null,
					});
					const updated = fillBody(
						tx.query.narratorMessages
							.findFirst({
								...bodyColumns(),
								where: and(
									eq(narratorMessages.id, copied.messageId),
									eq(narratorMessages.role, "system"),
								),
							})
							.sync(),
					);
					if (!updated) throw new NotFoundError("Message", messageId);
					tx.update(narrators)
						.set({
							messageVersion: sql`${narrators.messageVersion} + 1`,
							updatedAt: now,
						})
						.where(eq(narrators.id, narratorId))
						.run();
					const replacedMessageId = copied.copied ? messageId : undefined;
					return {
						...updated,
						seq: copied.ref.seq,
						model: selectedModel,
						compactBoundaryMessageId,
						...(replacedMessageId ? { oldMessageId: replacedMessageId, replacedMessageId } : {}),
					};
				}),
			{ label: "prepareFailedCompactRetry", maxRetries: 5 },
		);
	},

	async persistPlanMessage(narratorId: string, content: string) {
		const id = generateId();
		const now = new Date().toISOString();

		const { msg, seq } = dbTransactionWithSeqFloor(narratorId, (tx) => {
			const msg = insertEnvelope(tx, {
				id,
				...newEnvelopeColumns(narratorId),
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacted", subtype: "plan", summary: content }],
				contextCharsJson: measureMessageCharacters("system", [
					{ type: "compact", status: "compacted", summary: content },
				]),
				contentText: `[Plan] ${content.slice(0, 200)}...`,
				createdAt: now,
			});

			const seq = claimNextRefSeq(tx, narratorId);
			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId: id,
					seq,
					isCompact: 1,
				})
				.run();
			tx.update(narrators)
				.set({
					contextSummary: content,
					contextSummaryChars: measureSummaryCharacters(content),
					apiConversationId: null,
					contextUsageSnapshotJson: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return { msg, seq };
		});

		return { ...msg, seq };
	},

	async clearContext(narratorId: string) {
		const id = generateId();
		const now = new Date().toISOString();

		const { msg, seq } = dbTransactionWithSeqFloor(narratorId, (tx) => {
			const msg = insertEnvelope(tx, {
				id,
				...newEnvelopeColumns(narratorId),
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacted", summary: "" }],
				contextCharsJson: { segments: [] },
				contentText: "[Context cleared]",
				createdAt: now,
			});

			const seq = claimNextRefSeq(tx, narratorId);
			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId: id,
					seq,
					isCompact: 1,
				})
				.run();
			tx.update(narrators)
				.set({
					contextSummary: null,
					contextSummaryChars: 0,
					apiConversationId: null,
					contextUsageSnapshotJson: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return { msg, seq };
		});

		return { ...msg, seq };
	},

	/**
	 * Insert an empty compact marker positioned *before* the given message, so
	 * subsequent context builds start fresh from that point (discarding earlier
	 * context) without running an AI summary. Mirrors `clearContext` but anchors
	 * the marker at a specific message instead of appending at the end.
	 */
	async clearContextBefore(narratorId: string, beforeMessageId: string) {
		const id = generateId();
		const now = new Date().toISOString();

		const { msg, seq } = dbTransactionWithSeqFloor(narratorId, (tx) => {
			const targetRef = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, beforeMessageId),
					),
				})
				.sync();
			if (!targetRef) throw new NotFoundError("Message", beforeMessageId);

			const msg = insertEnvelope(tx, {
				id,
				...newEnvelopeColumns(narratorId),
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacted", summary: "" }],
				contextCharsJson: { segments: [] },
				contentText: "[Context cleared]",
				createdAt: now,
			});

			claimShiftInsertSlot(tx, narratorId, targetRef.seq);
			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId: id,
					seq: targetRef.seq,
					isCompact: 1,
				})
				.run();
			tx.update(narrators)
				.set({
					apiConversationId: null,
					contextUsageSnapshotJson: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return { msg, seq: targetRef.seq };
		});

		return { ...msg, seq };
	},

	async finalizeCompactingMessage(
		messageId: string,
		narratorId: string,
		summary: string,
		contextPercent?: number,
		options?: {
			status?: "compacted" | "failed";
			error?: string;
			mode?: CompactMessageMode;
			expectedCompactBoundaryMessageId?: string | null;
			expectedAttempt?: number;
			expectedSeq?: number;
			/** What the epoch this compact opens froze (§7.7); recorded on success. */
			epoch?: EpochRecord;
		},
	) {
		const now = new Date().toISOString();
		const status = options?.status ?? "compacted";

		return db.transaction((tx) => {
			// The ref is the authorization and ownership boundary. The message row may
			// have been created by the parent narrator and shared into a fork.
			const currentRef = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				})
				.sync();
			const existing = fillBody(
				tx.query.narratorMessages
					.findFirst({
						where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.role, "system")),
						...bodyColumns({ id: true, contentJson: true }),
					})
					.sync(),
			);
			if (!existing || !currentRef) return null;
			const blocks = Array.isArray(existing.contentJson) ? existing.contentJson : [];
			const previous = blocks.map(parseCompactMessageBlock).find(Boolean);
			if (!previous) throw new ValidationError("Message is not a compact message");

			// CAS the lifecycle state and the latest attempt before touching the row.
			// A deleted marker, an already-finished attempt, or a stale retry must
			// never be interpreted as a successful compact.
			const attempts = normalizeCompactAttempts(previous.attempts);
			const latestAttempt = attempts.at(-1);
			if (previous.status !== "compacting" || latestAttempt?.status !== "running") {
				return null;
			}
			const expectedAttempt = options?.expectedAttempt ?? latestAttempt.attempt;
			if (!Number.isInteger(expectedAttempt) || expectedAttempt !== latestAttempt.attempt) {
				return null;
			}
			const expectedSeq = options?.expectedSeq ?? currentRef.seq;
			if (!Number.isInteger(expectedSeq) || expectedSeq !== currentRef.seq) return null;
			const expectedRetryBaseline = previous.retryBaseCompactMessageId ?? null;

			const optionHasBoundary =
				options != null && Object.hasOwn(options, "expectedCompactBoundaryMessageId");
			const markerHasBoundary = Object.hasOwn(previous, "retryBaseCompactMessageId");
			if (status === "compacted" && (optionHasBoundary || markerHasBoundary)) {
				const rawExpectedBoundary = optionHasBoundary
					? options?.expectedCompactBoundaryMessageId
					: previous.retryBaseCompactMessageId;
				const expectedBoundary =
					typeof rawExpectedBoundary === "string" ? rawExpectedBoundary : null;
				const currentBoundary = getLatestSuccessfulCompactBoundarySync(tx, narratorId);
				const boundaryChanged =
					(currentBoundary?.messageId ?? null) !== expectedBoundary ||
					(currentBoundary != null && currentRef.seq <= currentBoundary.seq);
				if (boundaryChanged) {
					throw new AppError(
						"Compact boundary changed while retry was running",
						409,
						"COMPACT_BOUNDARY_CHANGED",
					);
				}
			}

			// A fork may still share the marker. Move only this narrator's ref to a
			// private row before finalizing so the sibling keeps its own attempt state.
			const copied = copyMessageForNarratorTx(tx, narratorId, messageId);
			const finished = finishCompactAttempt(
				{ ...previous, ...(options?.mode ? { mode: options.mode } : {}) },
				status === "compacted" ? "completed" : "failed",
				now,
				options?.error,
			);
			const compactBlock = {
				...finished,
				...(status === "compacted" ? { summary, contextPercentAfter: contextPercent } : {}),
				...(status === "compacted" && options?.epoch ? { epoch: options.epoch } : {}),
			};
			const failureText = truncateCompactError(options?.error ?? "Compact failed");
			const contentText =
				status === "compacted"
					? `[Compact] ${summary.slice(0, 200)}...`
					: `[Compact Failed] ${failureText.slice(0, 200)}...`;

			// Repeat the lifecycle checks on the marker the write replaces (the copy above may
			// have moved this narrator's ref to a private row). The preflight decides whether
			// this attempt is eligible; this compare-and-set is what prevents a late finalize
			// from winning after cancellation or retry.
			const marker = (() => {
				const body = readEnvelopeBody(tx, copied.messageId);
				return Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
			})();
			const markerAttempt = Array.isArray(marker?.attempts)
				? (marker.attempts.at(-1) as Record<string, unknown> | undefined)
				: undefined;
			const refHolds = tx
				.select({ id: narratorMessageRefs.id })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.id, copied.ref.id),
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, copied.messageId),
						eq(narratorMessageRefs.seq, expectedSeq),
					),
				)
				.get();
			const casHolds =
				!!refHolds &&
				marker?.status === previous.status &&
				markerAttempt?.status === latestAttempt.status &&
				markerAttempt?.attempt === expectedAttempt &&
				(marker?.retryBaseCompactMessageId ?? "") === (expectedRetryBaseline ?? "");
			const written =
				casHolds &&
				writeEnvelopeBody(tx, copied.messageId, [compactBlock], {
					set: {
						contextCharsJson: measureMessageCharacters("system", [compactBlock]),
						contentText,
						contextPercent: status === "compacted" ? (contextPercent ?? null) : null,
					},
				});
			const updated = written ? readEnvelope(tx, copied.messageId) : undefined;
			if (!updated) {
				throw new AppError(
					"Compact marker changed before finalize CAS completed",
					409,
					"COMPACT_FINALIZE_CONFLICT",
				);
			}

			tx.update(narratorMessageRefs)
				.set({ isCompact: status === "compacted" ? 1 : 0 })
				.where(eq(narratorMessageRefs.id, copied.ref.id))
				.run();

			tx.update(narrators)
				.set({
					...(status === "compacted"
						? {
								contextSummary: summary,
								contextSummaryChars: measureSummaryCharacters(summary),
								apiConversationId: null,
								contextUsageSnapshotJson: null,
							}
						: {}),
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();

			return { ...updated, seq: copied.ref.seq };
		});
	},

	async persistAssistantMessage(
		narratorId: string,
		sdkMessage: {
			uuid: string;
			session_id: string;
			parent_tool_use_id?: string | null;
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			message: { content: any[]; usage?: any };
			contextPercent?: number;
			meterUsage?: number;
			meterUnit?: string;
			provider?: string;
			credentialId?: string;
			model?: string;
			outputTokens?: number;
			cachedInputTokens?: number;
			cacheCreationInputTokens?: number;
			cacheCreation5mTokens?: number;
			cacheCreation1hTokens?: number;
			reasoningTokens?: number;
			ttftMs?: number;
			durationMs?: number;
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const content = sdkMessage.message.content;

		const contentText = content
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.filter((b: any) => b.type === "text")
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.map((b: any) => b.text)
			.join("\n");

		const usage = sdkMessage.message.usage;
		const pg = getNarratorMessageRefsPort();
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const toolUseBlocks = content.filter((b: any) => b.type === "tool_use") as StoredToolUseBlock[];
		if (pg && toolUseBlocks.length)
			throw new Error("PostgreSQL assistant tool-call persistence unavailable");
		const parentSegmentId = toolUseBlocks.length
			? ((await findExecutionSegmentParent(narratorId))?.executionSegmentId ?? null)
			: null;
		// The step and the ledger rows of its calls are one transaction.
		const msg = await appendPersistedMessage(
			{
				id,
				narratorId,
				messageUuid: sdkMessage.uuid,
				parentToolUseId: sdkMessage.parent_tool_use_id ?? null,
				role: "assistant",
				contentJson: content,
				contextCharsJson: measureMessageCharacters("assistant", content),
				contentText: contentText || null,
				tokensIn: usage?.input_tokens,
				provider: sdkMessage.provider ?? null,
				credentialId: sdkMessage.credentialId ?? null,
				model: sdkMessage.model ?? null,
				outputTokens: sdkMessage.outputTokens ?? null,
				cachedInputTokens: sdkMessage.cachedInputTokens ?? null,
				cacheCreationInputTokens: sdkMessage.cacheCreationInputTokens ?? null,
				cacheCreation5mTokens: sdkMessage.cacheCreation5mTokens ?? null,
				cacheCreation1hTokens: sdkMessage.cacheCreation1hTokens ?? null,
				reasoningTokens: sdkMessage.reasoningTokens ?? null,
				ttftMs: sdkMessage.ttftMs ?? null,
				durationMs: sdkMessage.durationMs ?? null,
				contextPercent: sdkMessage.contextPercent ?? null,
				meterUsage: sdkMessage.meterUsage ?? null,
				meterUnit: sdkMessage.meterUnit ?? null,
				createdAt: now,
			},
			{
				blockMode: "sealed",
				...(toolUseBlocks.length
					? {
							withRows: (tx: DbTx) => {
								for (const block of toolUseBlocks)
									insertToolCallRowTx(tx, {
										narratorId,
										messageId: id,
										parentSegmentId,
										block,
										createdAt: now,
									});
							},
						}
					: {}),
			},
		);

		const seq = msg.seq;
		if (!pg) await bumpParentNarratorMessageVersion(sdkMessage.parent_tool_use_id);
		return { ...msg, seq };
	},

	async createPartialAssistantMessage(
		narratorId: string,
		sdkMessage: {
			uuid: string;
			session_id: string;
			parent_tool_use_id?: string | null;
			contextPercent?: number;
			meterUsage?: number;
			meterUnit?: string;
			tokensIn?: number;
			turnUsage?: Record<string, unknown>;
			provider?: string;
			credentialId?: string;
			model?: string;
			outputTokens?: number;
			cachedInputTokens?: number;
			cacheCreationInputTokens?: number;
			cacheCreation5mTokens?: number;
			cacheCreation1hTokens?: number;
			reasoningTokens?: number;
			ttftMs?: number;
			durationMs?: number;
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();

		// Empty shell: allocate id + ref/seq so `appendBlockToMessage` has a stable
		// target, but do NOT bump messageVersion. Announcing an empty assistant row
		// makes clients render a blank committed message and lets live-row hand-off
		// drop streaming reasoning/text before any content is visible. Visibility
		// starts when `appendBlockToMessage` publishes real blocks.
		const msg = await appendPersistedMessage(
			{
				id,
				narratorId,
				messageUuid: sdkMessage.uuid,
				parentToolUseId: sdkMessage.parent_tool_use_id ?? null,
				role: "assistant",
				contentJson: [],
				contextCharsJson: { segments: [] },
				contentText: null,
				tokensIn: sdkMessage.tokensIn ?? null,
				turnUsageJson: sdkMessage.turnUsage ?? null,
				provider: sdkMessage.provider ?? null,
				credentialId: sdkMessage.credentialId ?? null,
				model: sdkMessage.model ?? null,
				outputTokens: sdkMessage.outputTokens ?? null,
				cachedInputTokens: sdkMessage.cachedInputTokens ?? null,
				cacheCreationInputTokens: sdkMessage.cacheCreationInputTokens ?? null,
				cacheCreation5mTokens: sdkMessage.cacheCreation5mTokens ?? null,
				cacheCreation1hTokens: sdkMessage.cacheCreation1hTokens ?? null,
				reasoningTokens: sdkMessage.reasoningTokens ?? null,
				ttftMs: sdkMessage.ttftMs ?? null,
				durationMs: sdkMessage.durationMs ?? null,
				contextPercent: sdkMessage.contextPercent ?? null,
				meterUsage: sdkMessage.meterUsage ?? null,
				meterUnit: sdkMessage.meterUnit ?? null,
				createdAt: now,
			},
			{ bumpMessageVersion: false },
		);

		return { ...msg, seq: msg.seq };
	},

	async appendBlockToMessage(
		messageId: string,
		narratorId: string,
		block:
			| {
					type: "text";
					text: string;
					outputIndex?: number;
					citations?: import("@shared/citations").TextCitation[];
					fileReferenceContext?: import("@shared/file-reference").FileReferenceContext;
					id?: string;
					revision?: number;
					rawTextLength?: number;
					completed?: boolean;
			  }
			| {
					type: "reasoning";
					text: string;
					id?: string;
					revision?: number;
					rawTextLength?: number;
					completed?: boolean;
					providerMetadata?: import("@server/lib/agent/types").ReasoningProviderMetadata;
					outputIndex?: number;
			  }
			| { type: "redacted_thinking"; data: string; outputIndex?: number; signatureSource?: string }
			| {
					type: "tool_use";
					id: string;
					name: string;
					input: Record<string, unknown>;
					streamStartedAt?: number;
					streamCompletedAt?: number;
					outputIndex?: number;
					thoughtSignature?: string;
					thoughtSignatureSource?: string;
			  }
			| {
					type: "web_search";
					id: string;
					query?: string;
					queries?: string[];
					outputIndex?: number;
			  }
			| {
					type: "image_generation";
					id: string;
					revisedPrompt?: string;
					outputIndex?: number;
					savedPath?: string;
					result?: string;
					width?: number;
					height?: number;
			  },
		options?: {
			republishUnchanged?: boolean;
			/** The provider request writing this item; its blocks are discarded by it. */
			attemptId?: string;
		},
	) {
		// The segment parent is read up front; the block and its ledger row are then one
		// transaction, so a tool_use never commits without the row that pairs its result.
		const toolParentSegmentId =
			block.type === "tool_use"
				? ((await findExecutionSegmentParent(narratorId))?.executionSegmentId ?? null)
				: null;
		const toolCreatedAt = new Date().toISOString();
		let toolCallId: string | undefined;
		// No await between reading and replacing the JSON body: a concurrent checkpoint
		// or translation must not overwrite a newer revision read by another consumer.
		const persisted = db.transaction((tx) => {
			const queueMark = syncQueueMark();
			const existing = fillBody(
				tx.query.narratorMessages
					.findFirst({
						where: eq(narratorMessages.id, messageId),
						...bodyColumns({ id: true, contentJson: true, parentToolUseId: true }),
					})
					.sync(),
			);
			if (!existing) throw new NotFoundError("Assistant message", messageId);

			type StoredAssistantBlock =
				| {
						type: "text";
						text: string;
						outputIndex?: number;
						citations?: import("@shared/citations").TextCitation[];
						fileReferenceContext?: import("@shared/file-reference").FileReferenceContext;
						id?: string;
						revision?: number;
						rawTextLength?: number;
						completed?: boolean;
				  }
				| {
						type: "reasoning";
						text: string;
						id?: string;
						revision?: number;
						rawTextLength?: number;
						completed?: boolean;
						providerMetadata?: import("@server/lib/agent/types").ReasoningProviderMetadata;
						outputIndex?: number;
				  }
				| {
						type: "redacted_thinking";
						data: string;
						outputIndex?: number;
						signatureSource?: string;
				  }
				| {
						type: "tool_use";
						id: string;
						name: string;
						input: Record<string, unknown>;
						streamStartedAt?: number;
						streamCompletedAt?: number;
						outputIndex?: number;
						thoughtSignature?: string;
						thoughtSignatureSource?: string;
				  }
				| {
						type: "web_search";
						id: string;
						query?: string;
						queries?: string[];
						outputIndex?: number;
				  }
				| { type: string; text?: unknown; outputIndex?: unknown; [key: string]: unknown };
			const current = (
				Array.isArray(existing.contentJson) ? existing.contentJson : []
			) as StoredAssistantBlock[];
			let content: StoredAssistantBlock[];
			const matchingIndex =
				(block.type === "text" || block.type === "reasoning") && block.id
					? current.findIndex((entry) => entry.type === block.type && entry.id === block.id)
					: -1;
			if (matchingIndex !== -1 && (block.type === "text" || block.type === "reasoning")) {
				const previous = current[matchingIndex] as Record<string, unknown>;
				const stale =
					typeof previous.revision === "number" &&
					(block.revision == null || block.revision < previous.revision);
				const next: Record<string, unknown> = {
					...previous,
					...Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined)),
				};
				if (block.type === "reasoning" && block.providerMetadata) {
					next.providerMetadata = mergeReasoningMetadata(
						previous.providerMetadata as ReasoningProviderMetadata | undefined,
						block.providerMetadata,
					);
				}
				if (previous.text !== block.text) delete next.translatedText;
				if (stale || isDeepStrictEqual(previous, next)) {
					content = current;
				} else {
					// A checkpoint updates the original chronological slot, even when its
					// metadata arrives after a tool has already been committed.
					content = [...current];
					content[matchingIndex] = next as StoredAssistantBlock;
				}
			} else if (typeof (block as { outputIndex?: unknown }).outputIndex === "number") {
				const getOutputIndex = (entry: StoredAssistantBlock): number | undefined => {
					const outputIndex = (entry as { outputIndex?: unknown }).outputIndex;
					return typeof outputIndex === "number" ? outputIndex : undefined;
				};
				// ECMAScript's stable sort preserves arrival order for ties/unindexed blocks;
				// avoid the former wrapper object + two extra arrays for every checkpoint.
				content = [...current, block as StoredAssistantBlock];
				content.sort((a, b) => {
					const aOrder = getOutputIndex(a) ?? Number.POSITIVE_INFINITY;
					const bOrder = getOutputIndex(b) ?? Number.POSITIVE_INFINITY;
					return aOrder === bOrder ? 0 : aOrder - bOrder;
				});
			} else {
				// Unindexed providers/checkpoints already arrive in occurrence order. Do not
				// pull later reasoning in front of text/tools that were actually seen first.
				content = [...current, block];
			}
			if (content === current && !options?.republishUnchanged) return undefined;
			const writeLedgerRow = () => {
				if (block.type === "tool_use")
					toolCallId = insertToolCallRowTx(tx, {
						narratorId,
						messageId,
						parentSegmentId: toolParentSegmentId,
						block,
						createdAt: toolCreatedAt,
					});
			};
			// One item changed: its block row (and the tool's ledger binding) follows.
			const stamp = { attemptId: options?.attemptId };
			if (content !== current) {
				const textParts: string[] = [];
				for (const entry of content)
					if (entry.type === "text" && typeof entry.text === "string") textParts.push(entry.text);
				const contentText = textParts.join("\n");
				writeEnvelopeBody(tx, messageId, content, {
					set: {
						contextCharsJson: measureMessageCharacters("assistant", content),
						contentText: contentText || null,
					},
					mode: "streaming",
					stamp,
					rows: writeLedgerRow,
				});
				queueContextCharacterRefresh(narratorId, messageId);
			} else {
				writeLedgerRow();
				syncEnvelopeNow(messageId, "streaming", stamp);
			}
			flushQueuedSince(queueMark);
			return existing;
		});
		if (!persisted) return undefined;
		const existing = persisted;

		/**
		 * Publish the partial now that it holds real content.
		 *
		 * Completed blocks are removed from the reconnect streaming snapshot at
		 * `block_complete`, so without this announce a reconnecting client would see
		 * neither the live row nor the committed copy — reasoning and assistant text
		 * vanish until some later reload. Matches the `messageVersion` contract: a
		 * bump always ships with a broadcast of the current message body.
		 */
		const publishPartial = async () => {
			const owner = existing.parentToolUseId
				? await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { parentNarratorId: true },
					})
				: undefined;
			const broadcastTargetId = owner?.parentNarratorId ?? narratorId;
			// The parent embeds this child's messages, so its reconnect version must
			// change at the same boundary as the child's (never for the empty shell).
			await bumpNarratorMessageVersions([narratorId, broadcastTargetId]);
			const published = fillBody(
				await db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, messageId),
					...bodyColumns(),
					with: { toolCalls: true },
				}),
			);
			if (!published) throw new NotFoundError("Assistant message", messageId);
			const ref = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
				columns: { seq: true },
			});
			const projected = enrichToolUseBlocks(truncateToolIO([{ ...published, seq: ref?.seq }]))[0];
			if (!projected) throw new Error(`Cannot publish assistant message ${messageId}`);
			dualBroadcastToNarrator(
				{
					narratorId,
					broadcastTargetId,
					parentToolUseId: existing.parentToolUseId,
				},
				{
					type: "message_updated",
					narratorId,
					message: projected,
				},
			);
		};

		await publishPartial();
		return toolCallId;
	},

	async patchReasoningTranslation(
		messageId: string,
		reasoningIndex: number,
		translatedText: string,
		expected?: { id?: string; text: string },
	) {
		// A translation is block state: no body revision (§5.4).
		return patchEnvelopeState(messageId, (content) => {
			const index = expected?.id
				? content.findIndex(
						(entry) =>
							(entry as { type?: unknown } | null)?.type === "reasoning" &&
							(entry as { id?: unknown }).id === expected.id,
					)
				: reasoningIndex;
			const block = content[index] as Record<string, unknown> | undefined;
			if (!block || block.type !== "reasoning") return null;
			if (expected && block.text !== expected.text) return null;
			if (block.translatedText === translatedText) return null;
			block.translatedText = translatedText;
			return content;
		});
	},

	/**
	 * A state-only write (§5.4): reader-only fields of one envelope's elements, without a
	 * model-history bump, COW or search index. See `patchEnvelopeState`.
	 */
	patchState(messageId: string, mutate: (content: unknown[]) => unknown[] | null): boolean {
		return patchEnvelopeState(messageId, mutate);
	},

	/**
	 * Persist the upstream conversation id so the next activation can resume the
	 * API session instead of paying a cold cache miss.
	 *
	 * `expectedConversationId` makes this a compare-and-set, which matters because
	 * a compact clears `apiConversationId` to signal "the history was replaced,
	 * the next request MUST start a fresh upstream session". A background compact
	 * settles asynchronously and can land after the turn that started it, so an
	 * unconditional write here would overwrite that null with the id the session
	 * was holding in memory. The next activation would then read a non-null id,
	 * skip the upstream session reset, and send compacted history down a session
	 * that still carries the pre-compact turns — which the provider answers twice.
	 *
	 * Pass the value read when the session was created so the write applies only
	 * while nothing else has touched the row. Returns whether it applied.
	 */
	async updateConversationId(
		narratorId: string,
		apiConversationId: string,
		expectedConversationId?: string | null,
	): Promise<boolean> {
		const now = new Date().toISOString();
		const updated = await db
			.update(narrators)
			.set({ apiConversationId, updatedAt: now })
			.where(
				expectedConversationId === undefined
					? eq(narrators.id, narratorId)
					: and(
							eq(narrators.id, narratorId),
							expectedConversationId === null
								? isNull(narrators.apiConversationId)
								: eq(narrators.apiConversationId, expectedConversationId),
						),
			)
			.returning({ id: narrators.id });
		return updated.length > 0;
	},

	async updateStats(narratorId: string, costUsd: number) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				// messageCount is deliberately not touched here. It used to be `+1` per
				// finished loop, which is what made it a turn counter; it is now maintained
				// per message ref in appendMessageRefSync.
				totalCostUsd: sql`COALESCE(${narrators.totalCostUsd}, 0) + ${costUsd}`,
				lastMessageAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));
	},

	async updateMessageHistoryTokenEstimate(
		messageId: string,
		narratorId: string,
		estimate: {
			promptTokens: number;
			turnUsage: Record<string, unknown>;
			contextPercent?: number;
		},
	) {
		return db.transaction((tx) => {
			const updated = tx
				.update(narratorMessages)
				.set({
					tokensIn: estimate.promptTokens,
					turnUsageJson: estimate.turnUsage,
					...(estimate.contextPercent != null ? { contextPercent: estimate.contextPercent } : {}),
				})
				.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
				.returning({ id: narratorMessages.id })
				.get();
			if (!updated) return null;

			const ref = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
					columns: { seq: true },
				})
				.sync();

			return { ...readEnvelope(tx, messageId), seq: ref?.seq };
		});
	},

	async updateTitle(narratorId: string, title: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ title, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updateCwd(narratorId: string, cwd: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ cwd, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updateModel(narratorId: string, model: string) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ model, contextUsageSnapshotJson: null, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updatePermissionMode(narratorId: string, permissionMode: PermissionMode) {
		const now = new Date().toISOString();
		// 切到全部允许时同步强制宽松规划，避免后续进入计划模式仍按用户默认被阻塞。
		const forceRelaxed = permissionMode === "bypassPermissions";
		const parentUpdate = forceRelaxed
			? { permissionMode, relaxedPlan: true as const, updatedAt: now }
			: { permissionMode, updatedAt: now };

		await db.update(narrators).set(parentUpdate).where(eq(narrators.id, narratorId));

		// Sessions that registered this one as their policy source take the same change
		// (unchanged semantics: live dependents only, one level, overwritten).
		await db
			.update(narrators)
			.set(parentUpdate)
			.where(
				and(
					policyDependentsWhere(narratorId),
					inArray(narrators.status, ["working", "waiting", "idle"]),
				),
			);
	},

	async updateReasoningEffort(
		narratorId: string,
		reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null,
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ reasoningEffort, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	/**
	 * Set the tri-state fast-mode override. The deprecated `fastMode` boolean is
	 * mirrored so older readers of the same database still see explicit opt-ins.
	 */
	async updateFastModeOverride(narratorId: string, fastModeOverride: BooleanOverride) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				fastModeOverride,
				fastMode: legacyFastModeMirror(fastModeOverride),
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));
	},

	async updateRelaxedPlan(narratorId: string, relaxedPlan: boolean): Promise<boolean> {
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { permissionMode: true },
		});
		const effectiveRelaxedPlan = forcesRelaxedPlan(current?.permissionMode) ? true : relaxedPlan;
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ relaxedPlan: effectiveRelaxedPlan, updatedAt: now })
			.where(eq(narrators.id, narratorId));
		return effectiveRelaxedPlan;
	},

	async updateReflectionOverrides(
		narratorId: string,
		updates: {
			planReflectionAutoApproveOverride?: BooleanOverride;
			dangerReflectionOverride?: DangerReflectionOverride;
			autoContinuationOverride?: AutoContinuationOverride;
			tasksReminderIntervalOverride?: number | null;
		},
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ ...updates, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateBehaviorFenceSettings(
		narratorId: string,
		updates: {
			behaviorFenceIntervalOverride?: number | null;
			behaviorFenceAttachOverride?: BooleanOverride;
		},
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ ...updates, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateStatus(
		narratorId: string,
		status: "idle" | "working" | "waiting" | "archived",
		options?: {
			substatus?: string[];
			errorMessage?: string;
			errorCode?: string;
			diagnostics?: ApiRequestDiagnostics;
			setTurnStart?: boolean;
			turnStartedAt?: string;
			resumeTurn?: boolean;
			skipErrorMessage?: boolean;
			/** Run finalization must not unarchive a concurrently archived session. */
			unlessArchived?: boolean;
		},
	) {
		let wroteStatus = false;
		const errorMessage = options?.errorMessage;
		const errorCode = options?.errorCode;
		const diagnostics = normalizeApiRequestDiagnostics(options?.diagnostics);
		const setTurnStart = options?.setTurnStart;
		// When transitioning to an active status without explicit substatus,
		// auto-clear stale tags (e.g. leftover "unread"/"error"/"interrupted"),
		// but preserve a background compact that is intentionally running alongside it.
		const requestedSubstatus =
			options?.substatus ?? (status === "working" || status === "waiting" ? [] : undefined);
		const isError = requestedSubstatus?.includes("error");
		const keepsErrorMessage = isError || requestedSubstatus?.includes("payment_required");
		const now = new Date().toISOString();
		const nowMs = new Date(now).getTime();
		const normalizedErrorMessage = keepsErrorMessage ? (errorMessage ?? null) : null;
		// `retryable` was already computed by parseErrorDiagnostics but never persisted, so an
		// external client could see "it failed" without knowing whether retrying makes sense.
		const normalizedErrorRetryable =
			typeof diagnostics?.retryable === "boolean" ? diagnostics.retryable : null;
		const turnStartedAt = setTurnStart ? now : options?.turnStartedAt;
		let actualSubstatus = requestedSubstatus;
		// The generation broadcast to clients: the fresh turn start when this call
		// begins a turn, otherwise the narrator's existing turnStartedAt read from
		// the DB. Broadcasting it on terminal (done/unread) transitions lets the
		// notification layer key dedup on the specific execution generation, so a
		// resubscribe snapshot for the same turn is suppressed while a new turn's
		// completion (e.g. during a disconnect) still notifies.
		let broadcastTurnStartedAt: string | undefined = turnStartedAt;
		const writeStatus = async () => {
			if (requestedSubstatus !== undefined) {
				const row = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { substatus: true, turnStartedAt: true, updatedAt: true },
				});
				if (broadcastTurnStartedAt === undefined) {
					broadcastTurnStartedAt = row?.turnStartedAt ?? undefined;
				}
				const currentSubstatus = parseSubstatus(row?.substatus);
				actualSubstatus = preserveBackgroundCompactingSubstatus(
					currentSubstatus,
					requestedSubstatus,
				);
				// Keep the taken_over mirror alive across full-status overwrites while
				// the user holds this session's run.
				actualSubstatus = preserveHeldSubstatus(narratorId, actualSubstatus);
				actualSubstatus = transitionTurnTimingSubstatus(currentSubstatus, actualSubstatus, {
					status,
					nowMs,
					setTurnStart,
					resumeTurn: options?.resumeTurn,
					fallbackPauseStartedAtMs: row?.updatedAt ? new Date(row.updatedAt).getTime() : null,
				});
			}
			// Retry on transient SQLite locks so a status/substatus transition
			// (e.g. clearing "reflecting" after a danger reflection ends) is never
			// silently dropped when the DB is momentarily busy.
			wroteStatus = await withDbRetry(
				async () => {
					const write = db
						.update(narrators)
						.set({
							status,
							errorMessage: normalizedErrorMessage,
							// Kept in lockstep with errorMessage: cleared on recovery, set only when the
							// provider diagnostics actually told us whether a retry is worthwhile.
							errorRetryable: normalizedErrorMessage ? (normalizedErrorRetryable ?? null) : null,
							updatedAt: now,
							...(turnStartedAt !== undefined && { turnStartedAt }),
							...(actualSubstatus !== undefined && { substatus: JSON.stringify(actualSubstatus) }),
						})
						.where(
							and(
								eq(narrators.id, narratorId),
								options?.unlessArchived ? ne(narrators.status, "archived") : undefined,
							),
						);
					if (options?.unlessArchived)
						return (await write.returning({ id: narrators.id })).length > 0;
					await write;
					return true;
				},
				{ label: "updateStatus.write", maxRetries: 5 },
			);
		};
		if (requestedSubstatus !== undefined) {
			await narratorSubstatusLock.acquire(narratorId, writeStatus);
		} else {
			await writeStatus();
		}

		if (options?.unlessArchived && !wroteStatus) return false;

		backgroundOccupancyStore.refreshNarrator(narratorId);
		// Always emit status_changed so downstream listeners (gateway, notifications)
		// are notified. For errors, also emit the dedicated narrator:error event.
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId,
			status,
			substatus: actualSubstatus,
		});
		// Emit the semantic attention intent for the two persistent, unambiguous
		// "alert the user" states. `waiting` is intentionally excluded — its
		// attention intent is decided by the producer (handlePermission), not
		// re-derived here, because `waiting` is also reused for reflection states.
		// A "done" raised while non-service background work is still running carries
		// `backgroundWorkActive` so notification channels suppress the ping while
		// hooks still observe the event; the flag also rides the status_change
		// broadcast below so the client's sound/PWA decision uses the same value.
		let backgroundWorkActive = false;
		if (status === "idle" && actualSubstatus?.includes("unread")) {
			backgroundWorkActive = await hasActiveBackgroundWork(narratorId);
			eventBus.emit({
				type: "narrator:attention",
				narratorId,
				reason: "done",
				...(backgroundWorkActive ? { backgroundWorkActive } : {}),
			});
		} else if (actualSubstatus?.includes("error")) {
			eventBus.emit({
				type: "narrator:attention",
				narratorId,
				reason: "error",
				detail: normalizedErrorMessage ?? undefined,
			});
		}
		if (isError) {
			eventBus.emit({
				type: "narrator:error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
				diagnostics,
			});
		}

		if (isError) {
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
				errorCode,
				diagnostics,
			});

			if (!options?.skipErrorMessage) {
				try {
					const errText = normalizedErrorMessage ?? "Unknown error";
					const msgId = generateId();
					const contentJson = [
						{ type: "error", message: errText, ...(diagnostics ? { diagnostics } : {}) },
					];
					const contentText = `[Error] ${errText}`;
					// Insert the message and its ref atomically. We MUST use a
					// SYNCHRONOUS transaction here: bun:sqlite +
					// Drizzle's `db.transaction(async (tx) => …)` only wraps the
					// synchronous prefix before the first `await` in BEGIN/COMMIT,
					// so awaited statements (the ref insert) run OUTSIDE the
					// transaction. That left "message without ref" orphans whenever
					// the ref insert hit a lock/error — the card showed up in the
					// frontend (via the broadcast below) but `dismissErrorMessage`
					// could not find the ref → "Message not found". A sync
					// transaction commits both rows atomically. (This used to drop to
					// the raw `sqlite` handle for the same guarantee; Drizzle's sync
					// `db.transaction((tx) => …)` IS the same native synchronous
					// transaction, and going through it lets the seq claim share the
					// single authority in narrator-refs/seq-store.ts.)
					await withDbRetry(
						async () =>
							dbTransactionWithSeqFloor(narratorId, (tx) => {
								insertEnvelope(tx, {
									id: msgId,
									...newEnvelopeColumns(narratorId),
									narratorId,
									role: "system",
									contentJson,
									contentText,
									createdAt: now,
								});
								const seq = claimNextRefSeq(tx, narratorId);
								tx.insert(narratorMessageRefs)
									.values({
										id: generateId(),
										narratorId,
										messageId: msgId,
										seq,
										isCompact: 0,
									})
									.run();
								tx.update(narrators)
									.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
									.where(eq(narrators.id, narratorId))
									.run();
							}),
						{ label: "persistErrorSystemMessage", maxRetries: 5 },
					);
					// Broadcast only after the transaction has committed, so a
					// visible error card always has a backing ref the user can
					// dismiss.
					broadcastToNarrator(narratorId, {
						type: "message",
						narratorId,
						message: {
							id: msgId,
							narratorId,
							role: "system",
							contentJson,
							contentText,
							createdAt: now,
							children: [],
						},
					});
				} catch (e) {
					logger.warn("Failed to persist error system message", {
						narratorId,
						error: String(e),
					});
				}

				// Offer to resume error subagents that the seamless "Continue" path
				// cannot reach (background ones, or foreground ones from earlier
				// turns). Fire-and-forget so a status write is never blocked by it.
				void import("./narrator-subagent-recovery")
					.then(({ persistSubagentRecoveryCard }) => persistSubagentRecoveryCard(narratorId))
					.catch((e) => {
						logger.warn("Failed to persist subagent recovery card", {
							narratorId,
							error: String(e),
						});
					});
			}
		}
		broadcastToNarrator(narratorId, {
			type: "status_change",
			narratorId,
			status,
			substatus: actualSubstatus,
			turnStartedAt: broadcastTurnStartedAt,
			...(backgroundWorkActive ? { backgroundWorkActive } : {}),
		});
	},

	async compareAndSetStatus(
		narratorId: string,
		expectedStatus: string | string[],
		newStatus: "idle" | "working" | "waiting" | "archived",
		options?: {
			substatus?: string[];
			errorMessage?: string;
			diagnostics?: ApiRequestDiagnostics;
		},
	): Promise<boolean> {
		// When transitioning to an active status without explicit substatus,
		// auto-clear stale tags, while preserving background compact state.
		const requestedSubstatus =
			options?.substatus ?? (newStatus === "working" || newStatus === "waiting" ? [] : undefined);
		const errorMessage = options?.errorMessage;
		const diagnostics = normalizeApiRequestDiagnostics(options?.diagnostics);
		const isError = requestedSubstatus?.includes("error");
		const now = new Date().toISOString();
		const nowMs = new Date(now).getTime();
		const normalizedErrorMessage = isError ? (errorMessage ?? null) : null;
		const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
		let actualSubstatus = requestedSubstatus;
		// The execution generation to broadcast on the terminal (done/unread)
		// transition so clients can dedup notifications per turn (see updateStatus).
		let broadcastTurnStartedAt: string | undefined;
		const placeholders = expected.map(() => "?").join(",");
		const runCompareAndSet = async () => {
			if (requestedSubstatus !== undefined) {
				const row = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { substatus: true, turnStartedAt: true },
				});
				broadcastTurnStartedAt = row?.turnStartedAt ?? undefined;
				const currentSubstatus = parseSubstatus(row?.substatus);
				actualSubstatus = preserveBackgroundCompactingSubstatus(
					currentSubstatus,
					requestedSubstatus,
				);
				actualSubstatus = preserveHeldSubstatus(narratorId, actualSubstatus);
				actualSubstatus = transitionTurnTimingSubstatus(currentSubstatus, actualSubstatus, {
					status: newStatus,
					nowMs,
				});
			}
			const substatusJson =
				actualSubstatus !== undefined ? JSON.stringify(actualSubstatus) : undefined;
			// Retry on transient SQLite locks so the terminal working/waiting → idle
			// transition (which clears transient substatus tags) is never dropped.
			return withDbRetry(
				async () =>
					sqlite
						.prepare(
							substatusJson !== undefined
								? `UPDATE narrators SET status = ?, error_message = ?, substatus = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`
								: `UPDATE narrators SET status = ?, error_message = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
						)
						.run(
							...(substatusJson !== undefined
								? [newStatus, normalizedErrorMessage, substatusJson, now, narratorId, ...expected]
								: [newStatus, normalizedErrorMessage, now, narratorId, ...expected]),
						),
				{ label: "compareAndSetStatus.write", maxRetries: 5 },
			);
		};
		const result =
			requestedSubstatus !== undefined
				? await narratorSubstatusLock.acquire(narratorId, runCompareAndSet)
				: await runCompareAndSet();

		if (result.changes === 0) return false;
		backgroundOccupancyStore.refreshNarrator(narratorId);

		// Always emit status_changed; for errors also emit narrator:error.
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId,
			status: newStatus,
			substatus: actualSubstatus,
		});
		// Emit the semantic attention intent for done/error (see updateStatus for
		// why `waiting` is excluded). compareAndSetStatus is the path that marks a
		// finished turn idle+unread, so this is the primary "done" emit point.
		let backgroundWorkActive = false;
		if (newStatus === "idle" && actualSubstatus?.includes("unread")) {
			backgroundWorkActive = await hasActiveBackgroundWork(narratorId);
			eventBus.emit({
				type: "narrator:attention",
				narratorId,
				reason: "done",
				...(backgroundWorkActive ? { backgroundWorkActive } : {}),
			});
		} else if (actualSubstatus?.includes("error")) {
			eventBus.emit({
				type: "narrator:attention",
				narratorId,
				reason: "error",
				detail: normalizedErrorMessage ?? undefined,
			});
		}
		if (isError) {
			eventBus.emit({
				type: "narrator:error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
				diagnostics,
			});
		}
		broadcastToNarrator(narratorId, {
			type: "status_change",
			narratorId,
			status: newStatus,
			substatus: actualSubstatus,
			turnStartedAt: broadcastTurnStartedAt,
			...(backgroundWorkActive ? { backgroundWorkActive } : {}),
		});
		return true;
	},

	/**
	 * Update only the substatus tags without changing the main status.
	 * Broadcasts a substatus_change event to all subscribers.
	 */
	async updateSubstatus(
		narratorId: string,
		substatus: string[],
		options?: { preserveTiming?: boolean },
	) {
		await narratorSubstatusLock.acquire(narratorId, async () => {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { substatus: true },
			});
			const actualSubstatus =
				options?.preserveTiming === false
					? substatus
					: preserveTurnTimingSubstatus(parseSubstatus(row?.substatus), substatus);
			await writeSubstatus(narratorId, actualSubstatus);
			broadcastToNarrator(narratorId, {
				type: "substatus_change",
				narratorId,
				substatus: actualSubstatus,
			});
		});
	},

	/**
	 * Add a single substatus tag. No-op if already present.
	 * Returns the new substatus array.
	 *
	 * Serialized with all other substatus writers to avoid stale read-modify-write
	 * updates clobbering persistent tags like "error" or "unread".
	 */
	async addSubstatus(narratorId: string, tag: string): Promise<string[]> {
		return narratorSubstatusLock.acquire(narratorId, async () => {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { substatus: true },
			});
			const current = parseSubstatus(row?.substatus);
			if (current.includes(tag)) return current;
			const updated = [...current, tag];
			await writeSubstatus(narratorId, updated);
			broadcastToNarrator(narratorId, {
				type: "substatus_change",
				narratorId,
				substatus: updated,
			});
			return updated;
		});
	},

	/**
	 * Remove a single substatus tag. No-op if not present.
	 * Returns the new substatus array.
	 *
	 * Serialized with all other substatus writers to avoid stale read-modify-write
	 * updates clobbering persistent tags like "error" or "unread".
	 */
	async removeSubstatus(narratorId: string, tag: string): Promise<string[]> {
		return narratorSubstatusLock.acquire(narratorId, async () => {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { substatus: true },
			});
			const current = parseSubstatus(row?.substatus);
			if (!current.includes(tag)) return current;
			const updated = current.filter((t) => t !== tag);
			await writeSubstatus(narratorId, updated);
			broadcastToNarrator(narratorId, {
				type: "substatus_change",
				narratorId,
				substatus: updated,
			});
			return updated;
		});
	},

	/** Validate a receipt against its actor, current message and exact persisted attempt. */
	async getToolCallBinding(
		narratorId: string,
		messageId: string,
		toolUseId: string,
		toolCallId: string,
	): Promise<ToolCallBinding> {
		const row = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.id, toolCallId),
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.messageId, messageId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: {
				executionAttempt: true,
				executionIdentityVersion: true,
				executionOriginToolCallId: true,
				executionSegmentId: true,
			},
		});
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
			columns: { messageId: true },
		});
		if (
			!row ||
			!ref ||
			row.executionAttempt < 1 ||
			row.executionIdentityVersion !== 1 ||
			row.executionOriginToolCallId !== null
		)
			throw new ValidationError(
				"Tool execution receipt does not belong to the current narrator/message",
			);
		return Object.freeze({
			toolCallId,
			attempt: row.executionAttempt,
			executionSegmentId: row.executionSegmentId ?? undefined,
		});
	},

	async validateToolCallBinding(narratorId: string, toolUseId: string, binding: ToolCallBinding) {
		const row = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.id, binding.toolCallId),
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
				eq(narratorToolCalls.executionAttempt, binding.attempt),
			),
			columns: { messageId: true },
		});
		if (!row)
			throw new ValidationError("Tool execution binding is stale or belongs to another narrator");
		const receipt = await this.getToolCallBinding(
			narratorId,
			row.messageId,
			toolUseId,
			binding.toolCallId,
		);
		if (
			binding.executionSegmentId !== undefined &&
			binding.executionSegmentId !== receipt.executionSegmentId
		) {
			throw new ValidationError("Tool execution segment does not match its persisted receipt");
		}
		return row.messageId;
	},

	async createInternalRead(
		narratorId: string,
		parentToolUseId: string,
		parentBinding: ToolCallBinding,
		input: Record<string, unknown>,
		sequence: number,
	) {
		const messageId = await this.validateToolCallBinding(
			narratorId,
			parentToolUseId,
			parentBinding,
		);
		const parent = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, parentBinding.toolCallId),
			columns: { toolName: true, status: true },
		});
		if (
			parent?.toolName !== "Eval" ||
			parent.status !== "running" ||
			!Number.isSafeInteger(sequence) ||
			sequence < 1
		) {
			throw new ValidationError("Internal Read requires a running Eval parent");
		}
		const toolCallId = generateId();
		const toolUseId = `internal_read_${generateId()}`;
		const parentReceipt = await this.getToolCallBinding(
			narratorId,
			messageId,
			parentToolUseId,
			parentBinding.toolCallId,
		);
		const createdAt = new Date().toISOString();
		// The internal attempt and its execution segment are one transaction.
		const segmentId = db.transaction((tx) => {
			const executionSegmentId = insertExecutionSegmentTx(tx, {
				narratorId,
				parentSegmentId: parentReceipt.executionSegmentId ?? null,
				toolCallId,
				attempt: 1,
				createdAt,
			});
			tx.insert(narratorToolCalls)
				.values({
					executionSegmentId,
					id: toolCallId,
					narratorId,
					messageId,
					toolUseId,
					toolName: "Read",
					inputChars: measureSerializedCharacters(input),
					inputJson: {
						...input,
						__internalRead: {
							parentToolCallId: parentBinding.toolCallId,
							parentAttempt: parentBinding.attempt,
							sequence,
						},
					},
					status: "initializing",
					executionAttempt: 1,
					executionIdentityVersion: 1,
					createdAt,
				})
				.run();
			return executionSegmentId;
		});
		queueContextCharacterRefresh(narratorId, messageId);
		return {
			toolUseId,
			binding: Object.freeze({ toolCallId, attempt: 1, executionSegmentId: segmentId }),
		};
	},

	async completeInternalRead(
		narratorId: string,
		toolUseId: string,
		binding: ToolCallBinding,
		result: import("../lib/agent/types").ToolResult & { durationMs?: number },
	) {
		const messageId = await this.validateToolCallBinding(narratorId, toolUseId, binding);
		await this.updateToolCallResult(
			toolUseId,
			{
				output: result,
				status: result.isError ? "fail" : "success",
				errorMessage: result.isError ? result.output : undefined,
				durationMs: result.durationMs,
				bumpMessageVersion: false,
			},
			messageId,
			binding.toolCallId,
		);
	},

	/** A retry of this claim cannot start tool I/O twice, including after process recovery. */
	async claimToolCallExecution(
		narratorId: string,
		toolUseId: string,
		binding: ToolCallBinding,
		startedAt: number,
	) {
		await this.validateToolCallBinding(narratorId, toolUseId, binding);
		const attempt = binding.attempt;
		const claimed = await db
			.update(narratorToolCalls)
			.set({
				status: "running",
				executionAttempt: attempt,
				executionStartedAt: new Date(startedAt).toISOString(),
			})
			.where(
				and(
					eq(narratorToolCalls.id, binding.toolCallId),
					eq(narratorToolCalls.executionAttempt, binding.attempt),
					isNull(narratorToolCalls.executionStartedAt),
					// A sealed no-dispatch attempt is never executable, even if a legacy
					// caller resets its visible status without allocating a fresh attempt.
					isNull(narratorToolCalls.fileChangeOperationId),
					inArray(narratorToolCalls.status, ["initializing", "pending", "running"]),
				),
			)
			.returning({ id: narratorToolCalls.id });
		if (claimed.length !== 1)
			throw new ValidationError("Tool attempt has already started or is no longer executable");
		return Object.freeze({ toolCallId: binding.toolCallId, attempt });
	},

	/** A session can publish only into its registered exact delivery slot. */
	async resolveSubagentConclusionReference(
		subagentId: string,
		parentNarratorId: string,
		toolUseId: string,
		expectedOriginToolCallId?: string,
	) {
		const child = await db.query.narrators.findFirst({
			where: eq(narrators.id, subagentId),
			columns: { runtimeRegistrationJson: true },
		});
		const deliverTo = child ? runDeliverToOf(child) : undefined;
		if (
			!deliverTo ||
			deliverTo.narratorId !== parentNarratorId ||
			deliverTo.toolUseId !== toolUseId ||
			!deliverTo.toolCallId ||
			(expectedOriginToolCallId && expectedOriginToolCallId !== deliverTo.toolCallId)
		) {
			throw new ValidationError(
				"Conclusion watcher does not match the registered delivery tool-call",
			);
		}
		const target = await this.resolveToolCallConclusionReference(parentNarratorId, toolUseId, {
			toolCallId: deliverTo.toolCallId,
		});
		return { ...target, originToolCallId: deliverTo.toolCallId };
	},

	/** Resolve an existing history slot, including its COW copy. Never execution authority. */
	async resolveToolCallConclusionReference(
		narratorId: string,
		toolUseId: string,
		reference: { toolCallId?: string; messageId?: string },
	): Promise<{ toolCallId: string; messageId: string }> {
		if (!reference.toolCallId && !reference.messageId) {
			throw new ValidationError("A conclusion requires its original tool-call row or message");
		}
		const original = reference.toolCallId
			? await db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.id, reference.toolCallId),
					columns: { toolUseId: true, executionOriginToolCallId: true },
				})
			: undefined;
		if (original && original.toolUseId !== toolUseId) {
			throw new ValidationError("Conclusion tool-use identity does not match its original row");
		}
		const originId = original?.executionOriginToolCallId ?? reference.toolCallId;
		const rows = await db
			.select({ toolCallId: narratorToolCalls.id, messageId: narratorToolCalls.messageId })
			.from(narratorToolCalls)
			.innerJoin(
				narratorMessageRefs,
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
				),
			)
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
					reference.messageId ? eq(narratorToolCalls.messageId, reference.messageId) : undefined,
					originId
						? sql`(${narratorToolCalls.id} = ${reference.toolCallId} OR ${narratorToolCalls.executionOriginToolCallId} = ${originId})`
						: undefined,
				),
			)
			.limit(2);
		if (rows.length !== 1) {
			throw new ValidationError(
				"Conclusion reference is missing or ambiguous in the parent's history",
			);
		}
		return rows[0];
	},

	/** Resume an unstarted attempt, or append a new attempt after isolating shared history. */
	async prepareToolCallAttempt(narratorId: string, sourceToolCallId: string, resume = false) {
		return toolAttemptCreationLock.acquire(narratorId, async () => {
			const source = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, sourceToolCallId),
			});
			if (!source) throw new NotFoundError("Tool call", sourceToolCallId);
			const ref = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, source.messageId),
				),
				columns: { messageId: true },
			});
			if (!ref) throw new ValidationError("Tool call is not in this narrator's history");
			const shared = await this.isMessageSharedByMultipleNarrators(source.messageId);
			if (
				resume &&
				(source.executionIdentityVersion !== 1 || source.executionOriginToolCallId !== null)
			) {
				throw new ValidationError(
					"Legacy or COW tool rows cannot authorize automatic recovery; create an explicit new attempt",
				);
			}
			if (resume && (source.executionStartedAt || source.fileChangeOperationId)) {
				throw new ValidationError(
					"An already-started tool attempt requires reconciliation, not re-execution",
				);
			}
			if (resume && source.narratorId === narratorId) {
				if (!["initializing", "pending", "running"].includes(source.status)) {
					throw new ValidationError("Only an unstarted pending attempt can resume");
				}
				if (shared) {
					const retainedId = await this.copyOnWriteMessage(
						narratorId,
						source.messageId,
						undefined,
						{
							preserveExecutionOwner: true,
						},
					);
					if (retainedId !== source.messageId)
						throw new ValidationError(
							"Only the actual execution owner can resume a shared attempt",
						);
				}
				return { toolCall: source, requiresFreshPermission: false };
			}
			// COW only copies historical references; none of those clones becomes execution authority.
			const messageId = await this.copyOnWriteMessage(narratorId, source.messageId);
			const parentSegmentId =
				(await findExecutionSegmentParent(narratorId))?.executionSegmentId ?? null;
			// The new attempt and its execution segment are one transaction.
			const toolCall = db.transaction((tx) => {
				const queueMark = syncQueueMark();
				const latest = tx.query.narratorToolCalls
					.findFirst({
						where: and(
							eq(narratorToolCalls.messageId, messageId),
							eq(narratorToolCalls.toolUseId, source.toolUseId),
						),
						orderBy: [desc(narratorToolCalls.executionAttempt)],
						columns: { id: true, executionAttempt: true },
					})
					.sync();
				// Repeating an old request must not allocate a second successor attempt.
				if (latest && latest.executionAttempt > source.executionAttempt) {
					throw new ValidationError("This tool call already has a newer execution attempt");
				}
				const id = generateId();
				const createdAt = new Date().toISOString();
				const executionAttempt = Math.max(
					1,
					(latest?.executionAttempt ?? source.executionAttempt) + 1,
				);
				const executionSegmentId = insertExecutionSegmentTx(tx, {
					narratorId,
					parentSegmentId,
					toolCallId: id,
					attempt: executionAttempt,
					createdAt,
				});
				const [created] = tx
					.insert(narratorToolCalls)
					.values({
						id,
						narratorId,
						messageId,
						toolUseId: source.toolUseId,
						toolName: source.toolName,
						inputJson: source.inputJson,
						inputChars: source.inputChars,
						executionIdentityVersion: 1,
						executionAttempt,
						executionSegmentId,
						status: "initializing",
						createdAt,
						// Deliberately no operation, approval, timing, result, token accounting or tree data.
					})
					.returning()
					.all();
				// The new attempt reopens its tool block in the same commit.
				flushQueuedSince(queueMark);
				return created;
			});
			return {
				toolCall,
				requiresFreshPermission: shared || source.narratorId !== narratorId,
			};
		});
	},

	async updateToolCallExecutionTarget(
		narratorId: string,
		toolUseId: string,
		target: ToolExecutionTarget,
		binding?: ToolCallBinding,
	) {
		if (binding) await this.validateToolCallBinding(narratorId, toolUseId, binding);
		const toolCallId =
			binding?.toolCallId ?? (await resolveToolCallWriteId(toolUseId, { narratorId }));
		if (!toolCallId) throw new NotFoundError("Tool call", toolUseId);
		const existing = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.id, toolCallId),
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			// Production callers always supply the receipt; legacy callers remain supported.
			columns: {
				id: true,
				status: true,
				executionDeviceId: true,
				executionCwd: true,
				executionPathFlavor: true,
				resolvedFilePath: true,
				canonicalFilePath: true,
				runtimeGeneration: true,
				executionTargetsJson: true,
				deviceSelectionSource: true,
			},
		});
		if (!existing) {
			throw new NotFoundError("Tool call", toolUseId);
		}

		const normalizedTarget = normalizeExecutionTarget(target);
		const previousTarget = reconstructToolExecutionTarget(existing);
		const lexicalPath = normalizedTarget.lexicalPath ?? null;
		const canonicalPath = normalizedTarget.canonicalPath ?? null;
		const pathFlavor = normalizedTarget.pathFlavor ?? null;
		const runtimeGeneration = normalizedTarget.runtimeGeneration ?? null;
		const mayRefineBeforeApproval = existing.status === "initializing";

		// Only identity axes that an approval can never legitimately re-resolve are hard-frozen.
		// cwd is deliberately excluded: while the row is still "initializing" a re-run may
		// re-freeze a reconnected device's new defaultCwd, and the targetChanged check below
		// still rejects that once permission handling has begun.
		const frozenAxes: Array<[label: string, previous: unknown, next: unknown]> = [
			["device", previousTarget?.deviceId ?? existing.executionDeviceId, normalizedTarget.deviceId],
			[
				"path flavor",
				previousTarget?.pathFlavor ?? existing.executionPathFlavor,
				normalizedTarget.pathFlavor,
			],
			[
				"runtime generation",
				previousTarget?.runtimeGeneration ?? existing.runtimeGeneration,
				normalizedTarget.runtimeGeneration,
			],
		];
		for (const [label, previous, next] of frozenAxes) {
			if (previous !== null && previous !== undefined && previous !== next) {
				throw new ValidationError(
					`Execution target ${label} for tool call ${toolUseId} is already frozen to ` +
						`"${String(previous)}" and cannot change to "${String(next)}".`,
				);
			}
		}

		const targetChanged =
			previousTarget !== undefined &&
			(previousTarget.backendKind !== normalizedTarget.backendKind ||
				previousTarget.cwd !== normalizedTarget.cwd ||
				previousTarget.lexicalPath !== normalizedTarget.lexicalPath ||
				previousTarget.canonicalPath !== normalizedTarget.canonicalPath ||
				previousTarget.selectionSource !== normalizedTarget.selectionSource);
		if (targetChanged && !mayRefineBeforeApproval) {
			throw new ValidationError(
				`Execution target for tool call ${toolUseId} is already frozen and cannot change ` +
					`after permission handling has begun.`,
			);
		}

		const storedTargets = parseStoredExecutionTargets(existing.executionTargetsJson);
		const executionTargets =
			storedTargets.length > 1 ? [normalizedTarget, ...storedTargets.slice(1)] : [normalizedTarget];
		await db
			.update(narratorToolCalls)
			.set({
				executionDeviceId: normalizedTarget.deviceId,
				executionCwd: normalizedTarget.cwd,
				executionPathFlavor: pathFlavor,
				// Keep this as the lexical projection: old clients must not mistake a
				// symlink/junction-canonical path for the path the user actually supplied.
				resolvedFilePath: lexicalPath,
				canonicalFilePath: canonicalPath,
				runtimeGeneration,
				executionTargetsJson: executionTargets,
				deviceSelectionSource: normalizedTarget.selectionSource,
			})
			.where(eq(narratorToolCalls.id, existing.id));
	},

	async updateToolCallExecutionPlan(
		narratorId: string,
		toolUseId: string,
		plan: ToolExecutionPlan,
		binding?: ToolCallBinding,
	) {
		if (binding) await this.validateToolCallBinding(narratorId, toolUseId, binding);
		const toolCallId =
			binding?.toolCallId ?? (await resolveToolCallWriteId(toolUseId, { narratorId }));
		if (!toolCallId) throw new NotFoundError("Tool call", toolUseId);
		const normalizedPlan = normalizeExecutionPlan(plan);
		const primary = normalizedPlan.endpoints.find(
			(endpoint) => endpoint.key === normalizedPlan.primaryKey,
		);
		if (!primary || normalizedPlan.endpoints.length === 0) {
			throw new ValidationError(
				`Execution plan for tool call ${toolUseId} is missing its primary endpoint.`,
			);
		}
		// ONE read, taken BEFORE delegating to the target writer.
		//
		// Order matters: that writer stores this same column as an ARRAY of targets, so
		// reading afterwards would only ever see the array — which is how the freeze
		// comparison lost each endpoint's `operation` and stopped noticing a read → write
		// escalation on an already-approved target.
		//
		// `status` and `id` are taken from this same row rather than re-queried after the
		// write: neither is touched by the target writer, and the main thread must not run
		// two queries where one suffices.
		const existing = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.id, toolCallId),
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { id: true, status: true, executionTargetsJson: true },
		});
		if (!existing) throw new NotFoundError("Tool call", toolUseId);
		// Compare the ROUTING the column describes, not its raw JSON.
		//
		// A raw `JSON.stringify` comparison could never match here, because the two writers
		// of this column disagree on shape (array of targets vs the plan object). That made
		// the guard fire on every re-write of an IDENTICAL plan once the row left
		// "initializing" — a legitimate no-op reported as a routing change (observed as
		// repeated "Execution plan ... is already frozen" failures writing spec://tasks.json).
		//
		// The comparison must stay shape-agnostic WITHOUT losing precision: reducing both
		// sides to bare targets would drop each endpoint's `operation`, so a read → write
		// escalation on an already-approved target would slip through the freeze — the
		// opposite mistake, and a permission-relevant one. So a stored PLAN is compared as
		// a plan (targets plus operations, the full routing decision), while the legacy
		// array form — which never carried operations — is compared on targets, the only
		// information it holds.
		if (existing.status !== "initializing") {
			const signatures = frozenRoutingSignature(existing.executionTargetsJson, normalizedPlan);
			if (signatures && signatures.frozen !== signatures.incoming) {
				throw new ValidationError(
					`Execution plan for tool call ${toolUseId} is already frozen and cannot change ` +
						`after permission handling has begun.`,
				);
			}
		}
		await this.updateToolCallExecutionTarget(narratorId, toolUseId, primary.target, binding);
		await db
			.update(narratorToolCalls)
			.set({ executionTargetsJson: normalizedPlan })
			.where(eq(narratorToolCalls.id, existing.id));
	},

	async updateToolCallResult(
		toolUseId: string,
		result: {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			output?: any;
			status: "success" | "fail";
			errorMessage?: string;
			durationMs?: number;
			permissionStartedAt?: number;
			executionStartedAt?: number;
			completedAt?: number;
			resultMessageId?: string;
			bumpMessageVersion?: boolean;
			preserveTiming?: boolean;
			/** Detached completions must atomically match their original execution authority. */
			expectedBinding?: ToolCallBinding & { narratorId: string };
			/** Persist a permission redirect/sanitized input in the same CAS as the result. */
			input?: Record<string, unknown>;
			/** Commit publication intent with the exact tool result, synchronously. */
			onPersist?: (tx: DbTx) => void;
		},
		messageId?: string,
		toolCallId?: string,
	) {
		const expected = result.expectedBinding;
		if (
			expected &&
			(!expected.toolCallId || !Number.isInteger(expected.attempt) || expected.attempt < 1)
		) {
			throw new ValidationError("Tool result requires a valid execution binding");
		}
		if (expected && toolCallId && expected.toolCallId !== toolCallId) {
			throw new ValidationError("Tool result binding does not match its target row");
		}
		const exactId =
			expected?.toolCallId ?? (await resolveToolCallWriteId(toolUseId, { toolCallId, messageId }));
		if (!exactId) return;
		const conditions = [eq(narratorToolCalls.id, exactId)];
		if (expected) {
			// Do not validate then await before writing: retries, COW and history edits may
			// retire the receipt while an old tool is finishing. The write itself is the CAS.
			conditions.push(
				eq(narratorToolCalls.narratorId, expected.narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
				eq(narratorToolCalls.executionAttempt, expected.attempt),
				eq(narratorToolCalls.executionIdentityVersion, 1),
				isNull(narratorToolCalls.executionOriginToolCallId),
				sql`exists (select 1 from ${narratorMessageRefs} where ${narratorMessageRefs.narratorId} = ${expected.narratorId} and ${narratorMessageRefs.messageId} = ${narratorToolCalls.messageId})`,
			);
			if (messageId) conditions.push(eq(narratorToolCalls.messageId, messageId));
		}
		const affectedToolCalls = db.transaction((tx) => {
			const queueMark = syncQueueMark();
			const updated = tx
				.update(narratorToolCalls)
				.set({
					outputJson: result.output ?? null,
					outputChars: measureSerializedCharacters(result.output ?? result.errorMessage ?? null),
					status: result.status,
					errorMessage: result.errorMessage ?? null,
					permissionStartedAt:
						typeof result.permissionStartedAt === "number"
							? new Date(result.permissionStartedAt).toISOString()
							: undefined,
					executionStartedAt:
						typeof result.executionStartedAt === "number"
							? new Date(result.executionStartedAt).toISOString()
							: undefined,
					...(result.preserveTiming
						? {}
						: {
								durationMs: result.durationMs ?? null,
								completedAt:
									typeof result.completedAt === "number"
										? new Date(result.completedAt).toISOString()
										: new Date().toISOString(),
							}),
					...(result.resultMessageId != null && { resultMessageId: result.resultMessageId }),
				})
				.where(and(...conditions))
				.returning({
					id: narratorToolCalls.id,
					narratorId: narratorToolCalls.narratorId,
					messageId: narratorToolCalls.messageId,
					toolUseId: narratorToolCalls.toolUseId,
					toolName: narratorToolCalls.toolName,
					executionDeviceId: narratorToolCalls.executionDeviceId,
				})
				.all();
			if (expected && updated.length !== 1) {
				throw new ValidationError("Tool execution binding is stale or belongs to another narrator");
			}
			// A redirected or sanitized input is stored with the result it produced.
			if (result.input !== undefined)
				for (const row of updated) overwriteToolInputTx(tx, row.id, toolUseId, result.input);
			result.onPersist?.(tx);
			// The settled tool block (phase, binding, searchable result) commits with it.
			flushQueuedSince(queueMark);
			return updated;
		});

		// Announce the terminal state with bounded metadata only. External clients need to see
		// "which tool ran on which device, how long it took, did it fail" to follow along; without
		// this they cannot distinguish "the model is thinking" from "a tool has been running for
		// two minutes". Input/output payloads are deliberately excluded.
		for (const toolCall of affectedToolCalls) {
			queueContextCharacterRefresh(toolCall.narratorId, toolCall.messageId ?? undefined);
			eventBus.emit({
				type: "narrator:tool_changed",
				narratorId: toolCall.narratorId,
				toolUseId: toolCall.toolUseId,
				toolName: toolCall.toolName,
				status: result.status,
				...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
				executionDeviceId: toolCall.executionDeviceId,
				...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
			});
		}

		const affectedNarratorIds = affectedToolCalls.map((tc) => tc.narratorId);
		const affectedMessageIds = [
			...new Set(affectedToolCalls.map((tc) => tc.messageId).filter((id): id is string => !!id)),
		];
		if (expected) {
			// Detached results must not infer a parent from a provider-local tool-use id.
			const owner = await db.query.narrators.findFirst({
				where: eq(narrators.id, expected.narratorId),
				columns: { type: true, parentNarratorId: true },
			});
			if (owner?.type === "subagent" && owner.parentNarratorId) {
				affectedNarratorIds.push(owner.parentNarratorId);
			}
		} else if (affectedMessageIds.length > 0) {
			const affectedMessages = await db.query.narratorMessages.findMany({
				where: inArray(narratorMessages.id, affectedMessageIds),
				columns: { parentToolUseId: true },
			});
			const parentToolUseIds = [
				...new Set(
					affectedMessages.map((msg) => msg.parentToolUseId).filter((id): id is string => !!id),
				),
			];
			if (parentToolUseIds.length > 0) {
				const parentToolCalls = await db.query.narratorToolCalls.findMany({
					where: inArray(narratorToolCalls.toolUseId, parentToolUseIds),
					columns: { narratorId: true },
				});
				affectedNarratorIds.push(...parentToolCalls.map((tc) => tc.narratorId));
			}
		}
		if (result.bumpMessageVersion !== false) {
			await bumpNarratorMessageVersions(affectedNarratorIds);
		}
		return affectedToolCalls[0];
	},

	/**
	 * Like updateToolCallResult but only updates rows whose status is still active
	 * (initializing/pending/running). Returns true if any row was actually updated.
	 */
	async updateToolCallResultIfActive(
		toolUseId: string,
		result: {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			output?: any;
			status: "success" | "fail";
			errorMessage?: string;
			durationMs?: number;
			permissionStartedAt?: number;
			executionStartedAt?: number;
			completedAt?: number;
			resultMessageId?: string;
			preserveTiming?: boolean;
		},
		messageId?: string,
		toolCallId?: string,
	): Promise<boolean> {
		const exactId = await resolveToolCallWriteId(toolUseId, { toolCallId, messageId });
		if (!exactId) return false;
		const conditions = [eq(narratorToolCalls.id, exactId)];
		conditions.push(inArray(narratorToolCalls.status, ["initializing", "pending", "running"]));
		const condition = and(...conditions);
		if (!condition) return false;

		const affectedToolCalls = await db
			.update(narratorToolCalls)
			.set({
				outputJson: result.output ?? null,
				outputChars: measureSerializedCharacters(result.output ?? result.errorMessage ?? null),
				status: result.status,
				errorMessage: result.errorMessage ?? null,
				permissionStartedAt:
					typeof result.permissionStartedAt === "number"
						? new Date(result.permissionStartedAt).toISOString()
						: undefined,
				executionStartedAt:
					typeof result.executionStartedAt === "number"
						? new Date(result.executionStartedAt).toISOString()
						: undefined,
				...(result.preserveTiming
					? {}
					: {
							durationMs: result.durationMs ?? null,
							completedAt:
								typeof result.completedAt === "number"
									? new Date(result.completedAt).toISOString()
									: new Date().toISOString(),
						}),
				...(result.resultMessageId != null && { resultMessageId: result.resultMessageId }),
			})
			.where(condition)
			.returning({
				narratorId: narratorToolCalls.narratorId,
				messageId: narratorToolCalls.messageId,
			});
		if (affectedToolCalls.length === 0) return false;
		const affectedNarratorIds = affectedToolCalls.map((tc) => tc.narratorId);
		for (const toolCall of affectedToolCalls)
			queueContextCharacterRefresh(toolCall.narratorId, toolCall.messageId ?? undefined);
		await bumpNarratorMessageVersions(affectedNarratorIds);
		return true;
	},

	async isMessageSharedByMultipleNarrators(messageId: string): Promise<boolean> {
		const refs = await db
			.select({ id: narratorMessageRefs.id })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.messageId, messageId))
			.limit(2);
		return refs.length > 1;
	},

	async getToolCallByToolUseId(toolUseId: string) {
		return db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
		});
	},

	async copyOnWriteMessage(
		narratorId: string,
		messageId: string,
		overrides?: Partial<typeof narratorMessages.$inferInsert>,
		options: {
			preserveExecutionOwner?: boolean;
			/** Writes that belong to the edit, run first in its transaction. */
			beforeWrite?: (tx: DbTx) => void;
			/** Writes that follow the edit once its block rows are rebuilt, in its transaction. */
			afterWrite?: (tx: DbTx, messageId: string) => void;
		} = {},
	): Promise<string> {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!ref) throw new NotFoundError("Message", messageId);
		const semanticEdit =
			overrides != null &&
			(Object.hasOwn(overrides, "contentJson") || Object.hasOwn(overrides, "contentText"));
		if (semanticEdit && overrides) {
			const original = readEnvelope(db, messageId);
			if (!original) throw new NotFoundError("Message", messageId);
			overrides = {
				...overrides,
				contextCharsJson: measureMessageCharacters(
					overrides.role ?? original.role,
					overrides.contentJson !== undefined ? overrides.contentJson : original.contentJson,
					overrides.contentText !== undefined ? overrides.contentText : original.contentText,
				),
			};
		}
		const now = new Date().toISOString();
		const refreshedRecipients: string[] = [];
		const result = db.transaction((tx) => {
			const queueMark = syncQueueMark();
			const id = rewrite(tx);
			flushQueuedSince(queueMark);
			options.afterWrite?.(tx, id);
			return id;
		});
		function rewrite(tx: DbTx): string {
			const original = readEnvelope(tx, messageId);
			if (!original) throw new NotFoundError("Message", messageId);
			options.beforeWrite?.(tx);
			// Read ref membership atomically with the rewrite, including forks made while the
			// caller awaited context accounting. Never mutate a newly-shared row in place.
			const recipients = tx
				.select({ id: narratorMessageRefs.id, narratorId: narratorMessageRefs.narratorId })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.messageId, messageId))
				.limit(1_001)
				.all();
			if (recipients.length > 1_000)
				throw new ValidationError("Message COW exceeds the 1000-recipient limit");
			const currentRef = recipients.find((recipient) => recipient.narratorId === narratorId);
			if (!currentRef) throw new NotFoundError("Message", messageId);
			const bumpVersion = (recipientId: string, replacementId: string) => {
				const narrator = tx.query.narrators
					.findFirst({ where: eq(narrators.id, recipientId), columns: { forkMessageId: true } })
					.sync();
				tx.update(narrators)
					.set({
						...(narrator?.forkMessageId === messageId ? { forkMessageId: replacementId } : {}),
						messageVersion: sql`${narrators.messageVersion} + 1`,
						updatedAt: now,
					})
					.where(eq(narrators.id, recipientId))
					.run();
			};
			const updateOriginal = () => {
				if (overrides && Object.keys(overrides).length > 0) {
					updateEnvelope(tx, messageId, overrides);
					if (semanticEdit)
						updateRecipientMessageRef(tx, narratorId, currentRef.id, {
							kind: "semantic_edit",
							messageId,
						});
					bumpVersion(narratorId, messageId);
				}
				return messageId;
			};
			if (recipients.length === 1) return updateOriginal();
			const originalToolCalls = tx.query.narratorToolCalls
				.findMany({ where: eq(narratorToolCalls.messageId, messageId), limit: 1_001 })
				.sync();
			if (originalToolCalls.length > 1_000)
				throw new ValidationError("Message COW exceeds the 1000-tool limit");
			const cloneRecipient = (
				recipient: { id: string; narratorId: string },
				changes: Partial<typeof narratorMessages.$inferInsert> | undefined,
				kind: "semantic_edit" | "cow",
			) => {
				const replacementId = cowEnvelopeTx(tx, {
					original,
					ref: recipient,
					changes,
					toolCalls: originalToolCalls,
					receipt: kind,
				});
				bumpVersion(recipient.narratorId, replacementId);
				refreshedRecipients.push(recipient.narratorId);
				return replacementId;
			};
			if (
				options.preserveExecutionOwner &&
				original.narratorId === narratorId &&
				originalToolCalls.some(
					(call) =>
						call.narratorId === narratorId &&
						call.executionIdentityVersion === 1 &&
						call.executionOriginToolCallId === null,
				)
			) {
				// Output cleanup/finalization is not a new tool attempt. Isolate the historical
				// recipients instead: keep the actual owner's message ID, tool PK, approval,
				// continuation and Agent origin bindings intact. Copies remain history-only.
				const copyCount = recipients.length - 1;
				const snapshotBytes =
					Buffer.byteLength(JSON.stringify(original)) +
					Buffer.byteLength(JSON.stringify(originalToolCalls));
				if (
					copyCount * (originalToolCalls.length + 1) > 10_000 ||
					copyCount * snapshotBytes > 8 * 1024 * 1024
				)
					throw new ValidationError(
						"Execution-owner output COW exceeds the bounded snapshot budget",
					);
				for (const recipient of recipients)
					if (recipient.narratorId !== narratorId) cloneRecipient(recipient, undefined, "cow");
				return updateOriginal();
			}
			return cloneRecipient(currentRef, overrides, semanticEdit ? "semantic_edit" : "cow");
		}
		for (const recipient of refreshedRecipients) queueContextCharacterRefresh(recipient);
		return result;
	},

	/**
	 * Drop what a discarded provider attempt wrote into an open step: the blocks that
	 * attempt created (by `attemptId` when the step keeps block rows, else the blocks after
	 * the attempt's baseline), and the ledger rows of its calls that never ran. A call that
	 * did run keeps its row and its block, so a result never loses its call. The row
	 * removal and the truncation are one transaction. Null when there was nothing to drop.
	 */
	async discardAttemptBlocks(
		narratorId: string,
		messageId: string,
		baseline: number,
		attemptId?: string,
	): Promise<{
		messageId: string;
		discardedBlocks: number;
		retainedExecutedCalls: number;
		removedToolUseIds: string[];
	} | null> {
		const body = readEnvelopeBody(db, messageId);
		const blocks = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
		// What the rows say must be what the envelope stores now: converge, then read.
		const attemptRows = attemptId
			? db.transaction(() => {
					syncEnvelopeNow(messageId);
					return contentByAttempt(messageId, attemptId);
				})
			: null;
		if (attemptRows ? !attemptRows.some((row) => row.fromAttempt) : blocks.length <= baseline)
			return null;
		// An in-flight partial may have been forked. Keep execution/approval identity on the
		// real owner while isolating sibling snapshots before any mutation.
		let partialId = await this.copyOnWriteMessage(narratorId, messageId, undefined, {
			preserveExecutionOwner: true,
		});
		const discarded = attemptRows
			? attemptRows.flatMap((row) => (row.fromAttempt ? row.elements : []))
			: blocks.slice(baseline);
		const discardedToolUseIds = attemptRows
			? attemptRows.flatMap((row) => (row.fromAttempt && row.toolUseId ? [row.toolUseId] : []))
			: discarded.flatMap((block) => {
					const value = block as Record<string, unknown>;
					return value.type === "tool_use" && typeof value.id === "string" ? [value.id] : [];
				});
		// Which of those calls never ran — only these may be removed.
		const executedToolUseIds = new Set<string>();
		const removableRowIds: string[] = [];
		if (discardedToolUseIds.length > 0) {
			const rows = await db.query.narratorToolCalls.findMany({
				where: and(
					eq(narratorToolCalls.messageId, partialId),
					inArray(narratorToolCalls.toolUseId, discardedToolUseIds),
				),
				columns: { id: true, toolUseId: true, status: true },
			});
			for (const row of rows) {
				if (row.status === "initializing" || row.status === "pending") removableRowIds.push(row.id);
				else executedToolUseIds.add(row.toolUseId);
			}
		}
		// Keep the blocks of tools that actually executed, drop the rest. Order is preserved
		// by filtering the whole array: blocks are kept in `outputIndex` order, and the tool
		// reordering at the step's seal reads tool positions.
		const nextBlocks = attemptRows
			? (attemptRows.flatMap((row) =>
					!row.fromAttempt || (row.toolUseId && executedToolUseIds.has(row.toolUseId))
						? row.elements
						: [],
				) as Array<Record<string, unknown>>)
			: blocks.filter(
					(block, index) =>
						index < baseline ||
						(block.type === "tool_use" &&
							typeof block.id === "string" &&
							executedToolUseIds.has(block.id)),
				);
		const kept = nextBlocks.length - (blocks.length - discarded.length);
		const contentText = nextBlocks
			.flatMap((block) =>
				block.type === "text" && typeof block.text === "string" ? [block.text] : [],
			)
			.join("\n");
		// A fork can acquire a ref after the isolation above; the COW rechecks membership
		// and truncates in the same transaction that removes the unexecuted rows.
		partialId = await this.copyOnWriteMessage(
			narratorId,
			partialId,
			{
				contentJson: nextBlocks,
				contentText: contentText || null,
				contextCharsJson: measureMessageCharacters("assistant", nextBlocks, contentText),
			},
			{
				preserveExecutionOwner: true,
				...(removableRowIds.length
					? {
							beforeWrite: (tx: DbTx) =>
								tx
									.delete(narratorToolCalls)
									.where(inArray(narratorToolCalls.id, removableRowIds))
									.run(),
						}
					: {}),
			},
		);
		return {
			messageId: partialId,
			discardedBlocks: discarded.length - kept,
			retainedExecutedCalls: kept,
			removedToolUseIds: discardedToolUseIds.filter((id) => !executedToolUseIds.has(id)),
		};
	},

	/** Final metadata of a sealed step (upstream id, credential, turn usage). */
	async patchStepMeta(
		messageId: string,
		meta: { messageUuid?: string; credentialId?: string; turnUsageJson?: Record<string, unknown> },
	): Promise<void> {
		const updates = Object.fromEntries(
			Object.entries(meta).filter(([, value]) => value !== undefined),
		);
		// The step is complete: items it left incomplete are interrupted, not streaming.
		db.transaction((tx) => {
			const queueMark = syncQueueMark();
			updateEnvelope(tx, messageId, updates, { mode: "sealed" });
			flushQueuedSince(queueMark);
		});
	},

	/** Seal a step's blocks without changing its metadata (a kept partial after a stop). */
	sealStepBlocks(messageId: string): void {
		db.transaction(() => {
			const queueMark = syncQueueMark();
			syncEnvelopeNow(messageId, "sealed");
			flushQueuedSince(queueMark);
		});
	},

	/** Put a sealed step's tool_use blocks into the model's call order. */
	async reorderStepToolBlocks(
		narratorId: string,
		messageId: string,
		content: unknown[],
		contentText: string | null,
	): Promise<void> {
		db.transaction((tx) => {
			const queueMark = syncQueueMark();
			writeEnvelopeBody(tx, messageId, content, {
				set: { contextCharsJson: measureMessageCharacters("assistant", content, contentText) },
				mode: "sealed",
			});
			flushQueuedSince(queueMark);
		});
		queueContextCharacterRefresh(narratorId, messageId);
	},

	async copyOnWriteToolCallMessage(
		narratorId: string,
		messageId: string,
		_toolUseId: string,
	): Promise<string> {
		return this.copyOnWriteMessage(narratorId, messageId);
	},

	async overwriteToolCallInput(
		toolUseId: string,
		input: Record<string, unknown>,
		toolCallId?: string,
	) {
		logger.info("Overwriting tool call input", {
			toolUseId,
			toolCallId,
			inputKeys: Object.keys(input),
		});
		const exactId = await resolveToolCallWriteId(toolUseId, { toolCallId });
		if (!exactId) return;
		const owner = db.transaction((tx) => {
			overwriteToolInputTx(tx, exactId, toolUseId, input);
			return tx
				.select({
					narratorId: narratorToolCalls.narratorId,
					messageId: narratorToolCalls.messageId,
				})
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, exactId))
				.get();
		});
		if (owner) queueContextCharacterRefresh(owner.narratorId, owner.messageId ?? undefined);
	},

	async getToolCallPlanText(toolUseId: string): Promise<string | null> {
		const tc = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { inputJson: true },
		});
		const plan = (tc?.inputJson as Record<string, unknown> | null)?.plan;
		return typeof plan === "string" && plan.trim() ? plan : null;
	},

	// ── Segment compact ──────────────────────────────────────────────────────

	async persistSegmentCompactMarker(narratorId: string, messageIds: string[]) {
		if (messageIds.length === 0) throw new ValidationError("No messages to compact");

		const id = generateId();
		const now = new Date().toISOString();

		// The refs read MUST live inside the same transaction as the shift+insert:
		// read outside, `insertSeq` is a stale snapshot of where the marker belongs —
		// a concurrent shift/append between the read and the write could move the very
		// rows this marker then hides. Inside the (synchronous) write transaction the
		// read, the shift and the insert observe one consistent seq space.
		const { refs, insertSeq } = dbTransactionWithSeqFloor(narratorId, (tx) => {
			const refs = tx
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
				})
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						inArray(narratorMessageRefs.messageId, messageIds),
					),
				)
				.orderBy(narratorMessageRefs.seq)
				.all();

			if (refs.length === 0) throw new ValidationError("No matching messages found");

			const insertSeq = refs[0].seq;

			// Shift consumes one top-of-history slot — see narrator-refs/seq-store.ts.
			claimShiftInsertSlot(tx, narratorId, insertSeq);

			insertEnvelope(tx, {
				id,
				...newEnvelopeColumns(narratorId),
				narratorId,
				role: "user",
				contentJson: [
					{
						type: "segment_compact",
						status: "compacting",
						messageCount: refs.length,
					},
				],
				contextCharsJson: { segments: [] },
				contentText: "[Segment compacting]",
				createdAt: now,
			});

			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId: id,
					seq: insertSeq,
					isCompact: 0,
				})
				.run();

			const targetMessageIds = refs.map((r) => r.messageId);
			tx.update(narratorMessageRefs)
				.set({ segmentCompactId: id })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						inArray(narratorMessageRefs.messageId, targetMessageIds),
					),
				)
				.run();

			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();

			return { refs, insertSeq };
		});

		const msg = readEnvelope(db, id);
		if (!msg) throw new NotFoundError("Message", id);

		const hiddenMessageIds = refs.map((r) => r.messageId);
		return { message: { ...msg, seq: insertSeq }, hiddenMessageIds };
	},

	async getMessagesForSegmentCompact(narratorId: string, messageIds: string[]) {
		const refs = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					inArray(narratorMessageRefs.messageId, messageIds),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refs.length === 0) return [];

		const ids = refs.map((r) => r.messageId);
		const messages = fillBodies(
			await db.query.narratorMessages.findMany({
				where: inArray(narratorMessages.id, ids),
				...bodyColumns(),
				with: { toolCalls: true },
			}),
		);

		const seqMap = new Map(refs.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	async finalizeSegmentCompact(
		messageId: string,
		narratorId: string,
		summary: string,
		contextPercent?: number,
		options?: { status?: "compacted" | "failed"; error?: string },
	) {
		const now = new Date().toISOString();
		const status = options?.status ?? "compacted";

		const [countRow] = await db
			.select({ cnt: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.segmentCompactId, messageId),
				),
			);
		const messageCount = countRow?.cnt ?? 0;

		const block: Record<string, unknown> = {
			type: "segment_compact",
			status,
			summary,
			messageCount,
		};
		if (status === "failed" && options?.error) {
			block.error = options.error;
		}

		const prefix = status === "failed" ? "[Segment Compact Failed]" : "[Segment Compact]";

		return db.transaction((tx) => {
			const written = writeEnvelopeBody(tx, messageId, [block], {
				set: {
					contextCharsJson: measureMessageCharacters("user", [block]),
					contentText: `${prefix}\n${summary}`,
					contextPercent: contextPercent ?? null,
				},
				where: eq(narratorMessages.narratorId, narratorId),
			});
			const updated = written ? readEnvelope(tx, messageId) : undefined;
			if (!updated) return null;

			if (status === "failed") {
				tx.update(narratorMessageRefs)
					.set({ segmentCompactId: null })
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.segmentCompactId, messageId),
						),
					)
					.run();
			}

			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					apiConversationId: null,
					contextUsageSnapshotJson: null,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();

			const ref = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
					columns: { seq: true },
				})
				.sync();

			return { ...updated, seq: ref?.seq };
		});
	},

	async getSegmentCompactHiddenMessages(narratorId: string, segmentCompactId: string) {
		const refs = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.segmentCompactId, segmentCompactId),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refs.length === 0) return [];

		const ids = refs.map((r) => r.messageId);
		const messages = fillBodies(
			await db.query.narratorMessages.findMany({
				where: inArray(narratorMessages.id, ids),
				...bodyColumns(),
				with: { toolCalls: true },
			}),
		);

		const seqMap = new Map(refs.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	async deleteSegmentCompact(narratorId: string, messageId: string) {
		const msg = fillBody(
			await db.query.narratorMessages.findFirst({
				where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
				...bodyColumns(),
			}),
		);
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const scBlock = blocks.find((b: any) => b.type === "segment_compact");
		if (!scBlock) throw new ValidationError("Message is not a segment compact message");

		const now = new Date().toISOString();

		db.transaction((tx) => {
			tx.update(narratorMessageRefs)
				.set({ segmentCompactId: null })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.segmentCompactId, messageId),
					),
				)
				.run();

			tx.delete(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
				)
				.run();
			tx.delete(narratorMessages)
				.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
				.run();

			tx.update(narrators)
				.set({
					apiConversationId: null,
					contextUsageSnapshotJson: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});
	},

	async getSegmentCompactSummary(narratorId: string, messageId: string) {
		const msg = fillBody(
			await db.query.narratorMessages.findFirst({
				where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
				...bodyColumns(),
			}),
		);
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const scBlock = blocks.find((b: any) => b.type === "segment_compact");
		if (!scBlock) throw new ValidationError("Message is not a segment compact message");

		return scBlock.summary ?? "";
	},

	async updateSegmentCompactSummary(narratorId: string, messageId: string, summary: string) {
		const msg = fillBody(
			await db.query.narratorMessages.findFirst({
				...bodyColumns(),
				where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
			}),
		);
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		const scBlock = blocks.find(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "segment_compact" && b.status === "compacted",
		);
		if (!scBlock) throw new ValidationError("Message is not a compacted segment compact message");

		const newBlock = {
			type: "segment_compact" as const,
			status: "compacted" as const,
			summary,
			messageCount: scBlock.messageCount ?? 0,
		};

		const now = new Date().toISOString();
		db.transaction((tx) => {
			writeEnvelopeBody(tx, messageId, [newBlock], {
				set: {
					contextCharsJson: measureMessageCharacters("user", [newBlock]),
					contentText: `[Segment Compact]\n${summary}`,
				},
			});

			tx.update(narrators)
				.set({ apiConversationId: null, contextUsageSnapshotJson: null, updatedAt: now })
				.where(eq(narrators.id, narratorId))
				.run();
		});
	},
};

/** Explicit partial migration: unsupported API calls must not fall through to SQLite on PG. */
const PG_MESSAGE_METHODS = new Set<PropertyKey>([
	"persistUserMessage",
	"persistSystemMessage",
	"persistDisplayMessage",
	"persistToolChangeMessage",
	"persistEpochMarker",
	"persistAssistantMessage",
	"createPartialAssistantMessage",
]);

/**
 * One guard wrapper per method, installed as a plain own data property.
 *
 * The guard still runs at INVOCATION time (narrator-service captures bound aliases
 * before PG composition binds), and the wrapper is a plain function so
 * `spyOn(narratorPersistence, method)` keeps working: bun's spyOn does not penetrate
 * ANY Proxy — not even a trapless forwarding one (no set/defineProperty trap is ever
 * invoked), which is why the earlier get-trap Proxy here silently swallowed every
 * spy/mock installed by tests. Own writable properties on a plain object are the
 * only shape both the guard and the test doubles can share.
 */
function guardSqliteOnlyPersistenceMethod(
	key: string,
	method: (...args: never[]) => unknown,
): (...args: never[]) => unknown {
	return function guardedPersistenceMethod(this: unknown, ...args: never[]) {
		try {
			assertSqliteNarratorOperation(key);
		} catch (error) {
			// These methods are awaited; a synchronous throw would escape `.catch` chains.
			return Promise.reject(error);
		}
		return Reflect.apply(method, this, args);
	};
}

/** Content writers notify only after their successful commit; status/cost writers are excluded. */
const CONTEXT_CHARACTER_WRITERS = new Map<string, number>([
	["persistCompactingMessage", 0],
	["prepareFailedCompactRetry", 0],
	["persistPlanMessage", 0],
	["clearContext", 0],
	["clearContextBefore", 0],
	["finalizeCompactingMessage", 1],
	["prepareToolCallAttempt", 0],
	["copyOnWriteMessage", 0],
	["persistSegmentCompactMarker", 0],
	["finalizeSegmentCompact", 1],
	["deleteSegmentCompact", 0],
	["updateSegmentCompactSummary", 0],
]);

function notifyContextCharacterWriter(key: string, method: (...args: never[]) => unknown) {
	const narratorArgument = CONTEXT_CHARACTER_WRITERS.get(key);
	if (narratorArgument == null) return method;
	return async function contentWriter(this: unknown, ...args: never[]) {
		const result = await Reflect.apply(method, this, args);
		const narratorId = args[narratorArgument];
		const row =
			result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
		const message =
			row?.message && typeof row.message === "object"
				? (row.message as Record<string, unknown>)
				: undefined;
		const tool =
			row?.toolCall && typeof row.toolCall === "object"
				? (row.toolCall as Record<string, unknown>)
				: undefined;
		const messageId =
			typeof result === "string"
				? result
				: (row?.id ??
					message?.id ??
					tool?.messageId ??
					(key === "updateSegmentCompactSummary" ? args[1] : undefined));
		if (result !== null && typeof narratorId === "string")
			queueContextCharacterRefresh(
				narratorId,
				typeof messageId === "string" ? messageId : undefined,
			);
		return result;
	};
}

export const narratorPersistence: typeof sqliteNarratorPersistence = (() => {
	const wrapped: Record<PropertyKey, unknown> = {};
	for (const key of Reflect.ownKeys(sqliteNarratorPersistence)) {
		const descriptor = Object.getOwnPropertyDescriptor(sqliteNarratorPersistence, key);
		if (!descriptor) continue;
		if (typeof descriptor.value === "function") {
			const method = descriptor.value as (...args: never[]) => unknown;
			wrapped[key] = notifyContextCharacterWriter(
				String(key),
				PG_MESSAGE_METHODS.has(key)
					? method
					: guardSqliteOnlyPersistenceMethod(String(key), method),
			);
		} else Object.defineProperty(wrapped, key, descriptor);
	}
	return wrapped as typeof sqliteNarratorPersistence;
})();
