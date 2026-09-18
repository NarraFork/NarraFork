import {
	and,
	asc,
	eq,
	getTableColumns,
	inArray,
	isNull,
	lte,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narratorToolCalls, narratorToolContinuations } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { runAtomicWrite } from "./agent-runtime/runtime-write";

export type ToolContinuationRecord = typeof narratorToolContinuations.$inferSelect;
export type ToolContinuationKind = ToolContinuationRecord["kind"];
export type ToolContinuationState = ToolContinuationRecord["state"];
export type ToolContinuationRecoveryPhase =
	| "result_written"
	| "owner_continuation_pending"
	| "owner_continuation_started";

export interface PutToolContinuationInput {
	toolCallId: string;
	narratorId: string;
	updateEpoch: string;
	kind: ToolContinuationKind;
	state?: ToolContinuationState;
	payloadJson?: Record<string, unknown> | null;
	deadlineAt?: string | null;
	errorMessage?: string | null;
}

export interface ClaimToolContinuationInput {
	deadlineAt: string;
	claimToken?: string;
	now?: string;
}

export interface CompleteToolContinuationInput {
	claimToken: string;
	payloadJson?: Record<string, unknown> | null;
}

export interface FailToolContinuationInput {
	claimToken: string;
	errorMessage: string;
	payloadJson?: Record<string, unknown> | null;
}

export interface RenewToolContinuationClaimInput {
	claimToken: string;
	deadlineAt: string;
	now?: string;
}

export interface MarkExecutionUnknownInput {
	claimToken: string;
	errorMessage: string;
	payloadJson: Record<string, unknown>;
	now?: string;
}

export interface FinalizeRecoveryFailureInput {
	errorMessage: string;
	payloadJson: Record<string, unknown>;
}

export interface MarkResultWrittenInput {
	claimToken: string;
	payloadJson?: Record<string, unknown> | null;
}

export interface ToolContinuationRecoveryItem {
	record: ToolContinuationRecord;
	messageId: string;
	messageCreatedAt: string;
	toolCallCreatedAt: string;
	toolUseOrder: number;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolContinuationProtectionSets {
	toolCallIds: Set<string>;
	narratorIds: Set<string>;
	backgroundTaskIds: Set<string>;
}

export interface ToolContinuationToolCallResult {
	id: string;
	toolUseId: string;
	messageId: string;
	status: (typeof narratorToolCalls.$inferSelect)["status"];
	outputJson: unknown;
}

export interface SendAwaitCheckpointRow {
	record: ToolContinuationRecord;
	toolCallStatus: (typeof narratorToolCalls.$inferSelect)["status"];
}

export interface CheckpointSendAwaitInput {
	toolCallId: string;
	narratorId: string;
	updateEpoch: string;
	payloadJson: Record<string, unknown>;
	deadlineAt: string | null;
}

export interface CancelInterruptibleContinuationsInput {
	errorMessage?: string;
	recoveryToken?: string;
	includeOwnerStarted?: boolean;
	/** Cancel only the parent's delivery record for background Agent work; never aborts its runner. */
	includeBackgroundAgentOwner?: boolean;
}

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ROWS_PER_EPOCH = 10_000;
const TERMINAL_STATES: ToolContinuationState[] = ["completed", "cancelled"];
const CLAIMABLE_STATES: ToolContinuationState[] = ["paused", "waiting"];
const STALE_RECLAIMABLE_KINDS: ToolContinuationKind[] = [
	"foreground_agent",
	"background_agent",
	"await_agent",
	"send_await",
];
const NON_IDEMPOTENT_KINDS: ToolContinuationKind[] = ["deferred_tool", "pending_permission"];
const TERMINAL_TOOL_CALL_STATUSES = ["success", "fail"] as const;

function isoNow(): string {
	return new Date().toISOString();
}

function normalizeTimestamp(value: string, field: string): string {
	const timestamp = new Date(value);
	if (Number.isNaN(timestamp.getTime())) {
		throw new ValidationError(`${field} must be a valid timestamp`);
	}
	return timestamp.toISOString();
}

function validateUpdateEpoch(updateEpoch: string): void {
	if (!updateEpoch.trim()) {
		throw new ValidationError("updateEpoch is required");
	}
}

function validateClaimToken(claimToken: string): void {
	if (!claimToken) throw new ValidationError("claimToken is required");
}

function normalizePayload(
	payloadJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
	if (payloadJson == null) return null;

	let serialized: string;
	try {
		serialized = JSON.stringify(payloadJson);
	} catch {
		throw new ValidationError("payloadJson must be JSON-serializable");
	}
	if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
		throw new ValidationError(`payloadJson exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`);
	}
	return payloadJson;
}

function normalizePutInput(input: PutToolContinuationInput, timestamp: string) {
	validateUpdateEpoch(input.updateEpoch);
	const state = input.state ?? "paused";
	return {
		id: generateId(),
		toolCallId: input.toolCallId,
		narratorId: input.narratorId,
		updateEpoch: input.updateEpoch,
		kind: input.kind,
		state,
		payloadJson: normalizePayload(input.payloadJson),
		deadlineAt: input.deadlineAt ? normalizeTimestamp(input.deadlineAt, "deadlineAt") : null,
		claimToken: null,
		claimedAt: null,
		errorMessage: input.errorMessage ?? null,
		completedAt: TERMINAL_STATES.includes(state) ? timestamp : null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function assertEpochRowLimit(rows: unknown[], updateEpoch: string): void {
	if (rows.length > MAX_ROWS_PER_EPOCH) {
		throw new Error(
			`Continuation epoch ${updateEpoch} exceeds the ${MAX_ROWS_PER_EPOCH}-row safety limit`,
		);
	}
}

function toolUseOrder(contentJson: unknown, toolUseId: string): number {
	if (!Array.isArray(contentJson)) return Number.MAX_SAFE_INTEGER;
	const index = contentJson.findIndex(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "tool_use" &&
			(block as { id?: unknown }).id === toolUseId,
	);
	return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function normalizeToolInput(inputJson: unknown): Record<string, unknown> {
	return typeof inputJson === "object" && inputJson !== null && !Array.isArray(inputJson)
		? (inputJson as Record<string, unknown>)
		: {};
}

export function isResolvedContinuationFailure(
	record: Pick<ToolContinuationRecord, "state" | "kind" | "payloadJson">,
): boolean {
	if (record.state !== "failed" || !NON_IDEMPOTENT_KINDS.includes(record.kind)) return false;
	const recoveryStatus = record.payloadJson?.recoveryStatus;
	return (
		(recoveryStatus === "execution_unknown" || recoveryStatus === "failed") &&
		record.payloadJson?.toolErrorWritten === true
	);
}

export function getToolContinuationRecoveryPhase(
	record: Pick<ToolContinuationRecord, "payloadJson">,
): ToolContinuationRecoveryPhase | null {
	const phase = record.payloadJson?.recoveryPhase;
	return phase === "result_written" ||
		phase === "owner_continuation_pending" ||
		phase === "owner_continuation_started"
		? phase
		: null;
}

/** A completed legacy row means execution finished, but owner delivery may still need retrying. */
export function hasPersistedToolContinuationResult(
	record: Pick<ToolContinuationRecord, "state" | "kind" | "payloadJson">,
): boolean {
	return (
		getToolContinuationRecoveryPhase(record) !== null ||
		record.state === "completed" ||
		isResolvedContinuationFailure(record)
	);
}

export function isToolContinuationOwnerMounted(
	record: Pick<ToolContinuationRecord, "state" | "payloadJson">,
): boolean {
	return (
		record.state === "cancelled" ||
		getToolContinuationRecoveryPhase(record) === "owner_continuation_started"
	);
}

async function listMessageContinuations(
	messageId: string,
	updateEpoch: string,
): Promise<ToolContinuationRecord[]> {
	const rows = await db
		.select({ record: getTableColumns(narratorToolContinuations) })
		.from(narratorToolContinuations)
		.innerJoin(narratorToolCalls, eq(narratorToolContinuations.toolCallId, narratorToolCalls.id))
		.where(
			and(
				eq(narratorToolCalls.messageId, messageId),
				eq(narratorToolContinuations.updateEpoch, updateEpoch),
			),
		)
		.orderBy(asc(narratorToolContinuations.createdAt), asc(narratorToolContinuations.id))
		.limit(MAX_ROWS_PER_EPOCH + 1);
	assertEpochRowLimit(rows, updateEpoch);
	return rows.map(({ record }) => record);
}

export const toolContinuationService = {
	async getByToolCallId(toolCallId: string): Promise<ToolContinuationRecord | null> {
		const row = await db
			.select()
			.from(narratorToolContinuations)
			.where(eq(narratorToolContinuations.toolCallId, toolCallId))
			.get();
		return row ?? null;
	},

	async getToolCallResult(toolCallId: string): Promise<ToolContinuationToolCallResult | null> {
		const row = await db
			.select({
				id: narratorToolCalls.id,
				toolUseId: narratorToolCalls.toolUseId,
				messageId: narratorToolCalls.messageId,
				status: narratorToolCalls.status,
				outputJson: narratorToolCalls.outputJson,
			})
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, toolCallId))
			.get();
		return row ?? null;
	},

	async create(input: PutToolContinuationInput): Promise<ToolContinuationRecord> {
		const timestamp = isoNow();
		const [created] = await db
			.insert(narratorToolContinuations)
			.values(normalizePutInput(input, timestamp))
			.returning();
		if (!created) throw new Error("Failed to create tool continuation");
		return created;
	},

	async upsert(input: PutToolContinuationInput): Promise<ToolContinuationRecord> {
		const timestamp = isoNow();
		const row = normalizePutInput(input, timestamp);
		const [upserted] = await db
			.insert(narratorToolContinuations)
			.values(row)
			.onConflictDoUpdate({
				target: narratorToolContinuations.toolCallId,
				set: {
					narratorId: row.narratorId,
					updateEpoch: row.updateEpoch,
					kind: row.kind,
					state: row.state,
					payloadJson: row.payloadJson,
					deadlineAt: row.deadlineAt,
					claimToken: null,
					claimedAt: null,
					errorMessage: row.errorMessage,
					completedAt: row.completedAt,
					updatedAt: timestamp,
				},
				setWhere: or(
					notInArray(narratorToolContinuations.state, ["resuming"]),
					and(
						eq(narratorToolContinuations.state, "resuming"),
						lte(narratorToolContinuations.deadlineAt, timestamp),
					),
				),
			})
			.returning();
		if (upserted) return upserted;

		const existing = await this.getByToolCallId(input.toolCallId);
		if (
			existing?.state === "resuming" &&
			(existing.deadlineAt === null || existing.deadlineAt > timestamp)
		) {
			throw new Error(
				`Cannot upsert tool continuation ${input.toolCallId} while an active claim is resuming`,
			);
		}
		throw new Error("Failed to upsert tool continuation because its state changed concurrently");
	},

	async checkpointSendAwait(
		input: CheckpointSendAwaitInput,
	): Promise<ToolContinuationRecord | null> {
		validateUpdateEpoch(input.updateEpoch);
		const timestamp = isoNow();
		const payloadJson = normalizePayload(input.payloadJson);
		const deadlineAt = input.deadlineAt ? normalizeTimestamp(input.deadlineAt, "deadlineAt") : null;
		return runAtomicWrite(db, "tool-continuation.checkpointSendAwait", (tx) => {
			const toolCall = tx
				.select({ status: narratorToolCalls.status, completedAt: narratorToolCalls.completedAt })
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, input.toolCallId))
				.get();
			const existing = tx
				.select()
				.from(narratorToolContinuations)
				.where(eq(narratorToolContinuations.toolCallId, input.toolCallId))
				.get();

			if (!toolCall) {
				if (
					!existing ||
					existing.updateEpoch !== input.updateEpoch ||
					existing.kind !== "send_await"
				) {
					return null;
				}
				return (
					tx
						.update(narratorToolContinuations)
						.set({
							state: "cancelled",
							claimToken: null,
							claimedAt: null,
							deadlineAt: null,
							errorMessage: "Send tool call was deleted before planned-update recovery",
							completedAt: timestamp,
							updatedAt: timestamp,
						})
						.where(
							and(
								eq(narratorToolContinuations.id, existing.id),
								eq(narratorToolContinuations.updateEpoch, input.updateEpoch),
								notInArray(narratorToolContinuations.state, TERMINAL_STATES),
							),
						)
						.returning()
						.get() ?? existing
				);
			}

			if (TERMINAL_TOOL_CALL_STATUSES.includes(toolCall.status as "success" | "fail")) {
				if (
					!existing ||
					existing.updateEpoch !== input.updateEpoch ||
					existing.kind !== "send_await"
				) {
					return null;
				}
				if (existing.state === "cancelled" || isToolContinuationOwnerMounted(existing)) {
					return existing;
				}
				const recoveryPhase = getToolContinuationRecoveryPhase(existing) ?? "result_written";
				return (
					tx
						.update(narratorToolContinuations)
						.set({
							state: "completed",
							payloadJson: normalizePayload({
								...(existing.payloadJson ?? {}),
								recoveryPhase,
							}),
							claimToken: null,
							claimedAt: null,
							deadlineAt: null,
							errorMessage: null,
							completedAt: toolCall.completedAt ?? timestamp,
							updatedAt: timestamp,
						})
						.where(
							and(
								eq(narratorToolContinuations.id, existing.id),
								eq(narratorToolContinuations.updateEpoch, input.updateEpoch),
								eq(narratorToolContinuations.kind, "send_await"),
							),
						)
						.returning()
						.get() ?? existing
				);
			}

			const row = normalizePutInput(
				{
					toolCallId: input.toolCallId,
					narratorId: input.narratorId,
					updateEpoch: input.updateEpoch,
					kind: "send_await",
					state: "waiting",
					payloadJson,
					deadlineAt,
				},
				timestamp,
			);
			return (
				tx
					.insert(narratorToolContinuations)
					.values(row)
					.onConflictDoUpdate({
						target: narratorToolContinuations.toolCallId,
						set: {
							narratorId: row.narratorId,
							updateEpoch: row.updateEpoch,
							kind: row.kind,
							state: row.state,
							payloadJson: row.payloadJson,
							deadlineAt: row.deadlineAt,
							claimToken: null,
							claimedAt: null,
							errorMessage: null,
							completedAt: null,
							updatedAt: timestamp,
						},
						setWhere: or(
							notInArray(narratorToolContinuations.state, ["resuming", "completed", "cancelled"]),
							and(
								eq(narratorToolContinuations.state, "resuming"),
								lte(narratorToolContinuations.deadlineAt, timestamp),
							),
						),
					})
					.returning()
					.get() ??
				existing ??
				null
			);
		});
	},

	async reconcileSendAwaitResult(
		toolCallId: string,
		updateEpoch: string,
	): Promise<ToolContinuationRecord | null> {
		validateUpdateEpoch(updateEpoch);
		const current = await this.getByToolCallId(toolCallId);
		if (!current || current.kind !== "send_await" || current.updateEpoch !== updateEpoch)
			return null;
		return this.checkpointSendAwait({
			toolCallId,
			narratorId: current.narratorId,
			updateEpoch,
			payloadJson: current.payloadJson ?? {},
			deadlineAt: current.deadlineAt,
		});
	},

	async listSendAwaitCheckpointRows(updateEpoch: string): Promise<SendAwaitCheckpointRow[]> {
		validateUpdateEpoch(updateEpoch);
		const rows = await db
			.select({
				record: getTableColumns(narratorToolContinuations),
				toolCallStatus: narratorToolCalls.status,
			})
			.from(narratorToolContinuations)
			.innerJoin(narratorToolCalls, eq(narratorToolContinuations.toolCallId, narratorToolCalls.id))
			.where(
				and(
					eq(narratorToolContinuations.updateEpoch, updateEpoch),
					eq(narratorToolContinuations.kind, "send_await"),
				),
			)
			.limit(MAX_ROWS_PER_EPOCH + 1);
		assertEpochRowLimit(rows, updateEpoch);
		return rows;
	},

	async bindRecoveryTokenForNarrator(
		narratorId: string,
		updateEpoch: string,
		recoveryToken: string,
	): Promise<ToolContinuationRecord[]> {
		validateUpdateEpoch(updateEpoch);
		validateClaimToken(recoveryToken);
		const rows = (await this.listByEpoch(updateEpoch)).filter(
			(row) => row.narratorId === narratorId && !isToolContinuationOwnerMounted(row),
		);
		const updated: ToolContinuationRecord[] = [];
		for (const row of rows) {
			const timestamp = isoNow();
			const [next] = await db
				.update(narratorToolContinuations)
				.set({
					payloadJson: normalizePayload({
						...(row.payloadJson ?? {}),
						recoveryToken,
					}),
					updatedAt: timestamp,
				})
				.where(
					and(
						eq(narratorToolContinuations.id, row.id),
						eq(narratorToolContinuations.updateEpoch, updateEpoch),
						notInArray(narratorToolContinuations.state, ["cancelled"]),
					),
				)
				.returning();
			if (next) updated.push(next);
		}
		return updated;
	},

	async listByEpoch(updateEpoch: string): Promise<ToolContinuationRecord[]> {
		validateUpdateEpoch(updateEpoch);
		const rows = await db
			.select()
			.from(narratorToolContinuations)
			.where(eq(narratorToolContinuations.updateEpoch, updateEpoch))
			.orderBy(asc(narratorToolContinuations.createdAt), asc(narratorToolContinuations.id))
			.limit(MAX_ROWS_PER_EPOCH + 1);
		assertEpochRowLimit(rows, updateEpoch);
		return rows;
	},

	async listRecoveryQueueByEpoch(updateEpoch: string): Promise<ToolContinuationRecoveryItem[]> {
		validateUpdateEpoch(updateEpoch);
		const rows = await db
			.select({
				record: getTableColumns(narratorToolContinuations),
				messageId: narratorToolCalls.messageId,
				messageCreatedAt: narratorMessages.createdAt,
				toolCallCreatedAt: narratorToolCalls.createdAt,
				toolUseId: narratorToolCalls.toolUseId,
				toolName: narratorToolCalls.toolName,
				inputJson: narratorToolCalls.inputJson,
				contentJson: narratorMessages.contentJson,
			})
			.from(narratorToolContinuations)
			.innerJoin(narratorToolCalls, eq(narratorToolContinuations.toolCallId, narratorToolCalls.id))
			.innerJoin(narratorMessages, eq(narratorToolCalls.messageId, narratorMessages.id))
			.where(eq(narratorToolContinuations.updateEpoch, updateEpoch))
			.orderBy(
				asc(narratorToolContinuations.narratorId),
				asc(narratorMessages.createdAt),
				asc(narratorMessages.id),
				asc(narratorToolCalls.createdAt),
				asc(narratorToolCalls.id),
			)
			.limit(MAX_ROWS_PER_EPOCH + 1);
		assertEpochRowLimit(rows, updateEpoch);
		return rows
			.map(({ toolUseId, inputJson, contentJson, ...row }) => ({
				...row,
				input: normalizeToolInput(inputJson),
				toolUseOrder: toolUseOrder(contentJson, toolUseId),
			}))
			.sort(
				(a, b) =>
					a.record.narratorId.localeCompare(b.record.narratorId) ||
					a.messageCreatedAt.localeCompare(b.messageCreatedAt) ||
					a.messageId.localeCompare(b.messageId) ||
					a.toolUseOrder - b.toolUseOrder ||
					a.toolCallCreatedAt.localeCompare(b.toolCallCreatedAt) ||
					a.record.toolCallId.localeCompare(b.record.toolCallId),
			);
	},

	async getProtectionSets(updateEpoch: string): Promise<ToolContinuationProtectionSets> {
		validateUpdateEpoch(updateEpoch);
		const rows = await db
			.select()
			.from(narratorToolContinuations)
			.where(eq(narratorToolContinuations.updateEpoch, updateEpoch))
			.limit(MAX_ROWS_PER_EPOCH + 1);

		if (rows.length > MAX_ROWS_PER_EPOCH) {
			throw new Error(
				`Continuation epoch ${updateEpoch} exceeds the ${MAX_ROWS_PER_EPOCH}-row safety limit`,
			);
		}

		const protectionSets: ToolContinuationProtectionSets = {
			toolCallIds: new Set<string>(),
			narratorIds: new Set<string>(),
			backgroundTaskIds: new Set<string>(),
		};
		for (const row of rows) {
			if (isToolContinuationOwnerMounted(row)) continue;
			protectionSets.toolCallIds.add(row.toolCallId);
			protectionSets.narratorIds.add(row.narratorId);
			const subagentId = row.payloadJson?.subagentId;
			if (typeof subagentId === "string" && subagentId) {
				protectionSets.narratorIds.add(subagentId);
			}
			const backgroundTaskId = row.payloadJson?.backgroundTaskId;
			if (typeof backgroundTaskId === "string" && backgroundTaskId) {
				protectionSets.backgroundTaskIds.add(backgroundTaskId);
			}
		}
		return protectionSets;
	},

	async claim(
		toolCallId: string,
		input: ClaimToolContinuationInput,
	): Promise<ToolContinuationRecord | null> {
		const claimedAt = input.now ? normalizeTimestamp(input.now, "now") : isoNow();
		const deadlineAt = normalizeTimestamp(input.deadlineAt, "deadlineAt");
		if (deadlineAt <= claimedAt) {
			throw new ValidationError("deadlineAt must be later than the claim time");
		}
		const claimToken = input.claimToken ?? generateId();
		validateClaimToken(claimToken);

		const [claimed] = await db
			.update(narratorToolContinuations)
			.set({
				state: "resuming",
				claimToken,
				claimedAt,
				deadlineAt,
				errorMessage: null,
				completedAt: null,
				updatedAt: claimedAt,
			})
			.where(
				and(
					eq(narratorToolContinuations.toolCallId, toolCallId),
					or(
						inArray(narratorToolContinuations.state, CLAIMABLE_STATES),
						and(
							inArray(narratorToolContinuations.kind, STALE_RECLAIMABLE_KINDS),
							or(
								eq(narratorToolContinuations.state, "failed"),
								and(
									eq(narratorToolContinuations.state, "resuming"),
									lte(narratorToolContinuations.deadlineAt, claimedAt),
								),
							),
						),
					),
				),
			)
			.returning();
		return claimed ?? null;
	},

	async complete(
		toolCallId: string,
		input: CompleteToolContinuationInput,
	): Promise<ToolContinuationRecord | null> {
		validateClaimToken(input.claimToken);
		const timestamp = isoNow();
		const [completed] = await db
			.update(narratorToolContinuations)
			.set({
				state: "completed",
				...(input.payloadJson !== undefined && {
					payloadJson: normalizePayload(input.payloadJson),
				}),
				claimToken: null,
				claimedAt: null,
				deadlineAt: null,
				errorMessage: null,
				completedAt: timestamp,
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(narratorToolContinuations.toolCallId, toolCallId),
					eq(narratorToolContinuations.state, "resuming"),
					eq(narratorToolContinuations.claimToken, input.claimToken),
				),
			)
			.returning();
		return completed ?? null;
	},

	async fail(
		toolCallId: string,
		input: FailToolContinuationInput,
	): Promise<ToolContinuationRecord | null> {
		validateClaimToken(input.claimToken);
		const timestamp = isoNow();
		const [failed] = await db
			.update(narratorToolContinuations)
			.set({
				state: "failed",
				...(input.payloadJson !== undefined && {
					payloadJson: normalizePayload(input.payloadJson),
				}),
				claimToken: null,
				claimedAt: null,
				deadlineAt: null,
				errorMessage: input.errorMessage,
				completedAt: null,
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(narratorToolContinuations.toolCallId, toolCallId),
					eq(narratorToolContinuations.state, "resuming"),
					eq(narratorToolContinuations.claimToken, input.claimToken),
				),
			)
			.returning();
		return failed ?? null;
	},

	async renewClaim(
		toolCallId: string,
		input: RenewToolContinuationClaimInput,
	): Promise<ToolContinuationRecord | null> {
		validateClaimToken(input.claimToken);
		const renewedAt = input.now ? normalizeTimestamp(input.now, "now") : isoNow();
		const deadlineAt = normalizeTimestamp(input.deadlineAt, "deadlineAt");
		if (deadlineAt <= renewedAt) {
			throw new ValidationError("deadlineAt must be later than the renewal time");
		}
		const [renewed] = await db
			.update(narratorToolContinuations)
			.set({ deadlineAt, updatedAt: renewedAt })
			.where(
				and(
					eq(narratorToolContinuations.toolCallId, toolCallId),
					eq(narratorToolContinuations.state, "resuming"),
					eq(narratorToolContinuations.claimToken, input.claimToken),
				),
			)
			.returning();
		return renewed ?? null;
	},

	async markExecutionUnknown(
		toolCallId: string,
		input: MarkExecutionUnknownInput,
	): Promise<ToolContinuationRecord | null> {
		validateClaimToken(input.claimToken);
		const timestamp = input.now ? normalizeTimestamp(input.now, "now") : isoNow();
		const [failed] = await db
			.update(narratorToolContinuations)
			.set({
				state: "failed",
				payloadJson: normalizePayload(input.payloadJson),
				claimToken: null,
				claimedAt: null,
				deadlineAt: null,
				errorMessage: input.errorMessage,
				completedAt: timestamp,
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(narratorToolContinuations.toolCallId, toolCallId),
					inArray(narratorToolContinuations.kind, NON_IDEMPOTENT_KINDS),
					eq(narratorToolContinuations.state, "resuming"),
					eq(narratorToolContinuations.claimToken, input.claimToken),
					or(
						isNull(narratorToolContinuations.deadlineAt),
						lte(narratorToolContinuations.deadlineAt, timestamp),
					),
				),
			)
			.returning();
		return failed ?? null;
	},

	async finalizeRecoveryFailure(
		toolCallId: string,
		input: FinalizeRecoveryFailureInput,
	): Promise<ToolContinuationRecord | null> {
		const timestamp = isoNow();
		const [finalized] = await db
			.update(narratorToolContinuations)
			.set({
				payloadJson: normalizePayload(input.payloadJson),
				completedAt: timestamp,
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(narratorToolContinuations.toolCallId, toolCallId),
					inArray(narratorToolContinuations.kind, NON_IDEMPOTENT_KINDS),
					eq(narratorToolContinuations.state, "failed"),
					eq(narratorToolContinuations.errorMessage, input.errorMessage),
				),
			)
			.returning();
		return finalized ?? null;
	},

	async markResultWritten(
		toolCallId: string,
		input: MarkResultWrittenInput,
	): Promise<ToolContinuationRecord | null> {
		validateClaimToken(input.claimToken);
		const current = await this.getByToolCallId(toolCallId);
		if (!current || current.state !== "resuming" || current.claimToken !== input.claimToken) {
			return null;
		}
		const timestamp = isoNow();
		const payloadJson = normalizePayload({
			...(current.payloadJson ?? {}),
			...(input.payloadJson ?? {}),
			recoveryPhase: "result_written",
		});
		const [updated] = await db
			.update(narratorToolContinuations)
			.set({ payloadJson, updatedAt: timestamp })
			.where(
				and(
					eq(narratorToolContinuations.toolCallId, toolCallId),
					eq(narratorToolContinuations.state, "resuming"),
					eq(narratorToolContinuations.claimToken, input.claimToken),
				),
			)
			.returning();
		return updated ?? null;
	},

	async markOwnerContinuationPendingForMessage(
		messageId: string,
		updateEpoch: string,
		recoveryToken?: string,
	): Promise<ToolContinuationRecord[] | null> {
		validateUpdateEpoch(updateEpoch);
		if (recoveryToken !== undefined) validateClaimToken(recoveryToken);
		const rows = await listMessageContinuations(messageId, updateEpoch);
		const deliverable = rows.filter((row) => row.state !== "cancelled");
		if (
			deliverable.some(
				(row) =>
					!hasPersistedToolContinuationResult(row) ||
					(recoveryToken !== undefined && row.payloadJson?.recoveryToken !== recoveryToken),
			)
		) {
			return null;
		}
		const timestamp = isoNow();
		const updated: ToolContinuationRecord[] = [];
		for (const row of deliverable) {
			if (isToolContinuationOwnerMounted(row)) {
				updated.push(row);
				continue;
			}
			const [next] = await db
				.update(narratorToolContinuations)
				.set({
					payloadJson: normalizePayload({
						...(row.payloadJson ?? {}),
						recoveryPhase: "owner_continuation_pending",
					}),
					updatedAt: timestamp,
				})
				.where(
					and(
						eq(narratorToolContinuations.id, row.id),
						eq(narratorToolContinuations.updateEpoch, updateEpoch),
						notInArray(narratorToolContinuations.state, ["cancelled"]),
						...(recoveryToken
							? [
									sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryToken') = ${recoveryToken}`,
								]
							: []),
					),
				)
				.returning();
			if (!next) return null;
			updated.push(next);
		}
		return updated;
	},

	async markOwnerContinuationStartedForMessage(
		messageId: string,
		updateEpoch: string,
		recoveryToken?: string,
	): Promise<ToolContinuationRecord[] | null> {
		validateUpdateEpoch(updateEpoch);
		if (recoveryToken !== undefined) validateClaimToken(recoveryToken);
		const rows = await listMessageContinuations(messageId, updateEpoch);
		const deliverable = rows.filter((row) => row.state !== "cancelled");
		if (
			recoveryToken !== undefined &&
			deliverable.some((row) => row.payloadJson?.recoveryToken !== recoveryToken)
		) {
			return null;
		}
		if (
			deliverable.some(
				(row) =>
					getToolContinuationRecoveryPhase(row) !== "owner_continuation_pending" &&
					!isToolContinuationOwnerMounted(row),
			)
		) {
			return null;
		}
		const timestamp = isoNow();
		const updated: ToolContinuationRecord[] = [];
		for (const row of deliverable) {
			if (isToolContinuationOwnerMounted(row)) {
				updated.push(row);
				continue;
			}
			const [next] = await db
				.update(narratorToolContinuations)
				.set({
					state: "completed",
					payloadJson: normalizePayload({
						...(row.payloadJson ?? {}),
						recoveryPhase: "owner_continuation_started",
					}),
					claimToken: null,
					claimedAt: null,
					deadlineAt: null,
					completedAt: timestamp,
					updatedAt: timestamp,
				})
				.where(
					and(
						eq(narratorToolContinuations.id, row.id),
						eq(narratorToolContinuations.updateEpoch, updateEpoch),
						notInArray(narratorToolContinuations.state, ["cancelled"]),
						sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryPhase') = 'owner_continuation_pending'`,
						...(recoveryToken
							? [
									sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryToken') = ${recoveryToken}`,
								]
							: []),
					),
				)
				.returning();
			if (!next) return null;
			updated.push(next);
		}
		return updated;
	},

	async hasUnwrittenResultsForNarrator(narratorId: string, updateEpoch: string): Promise<boolean> {
		validateUpdateEpoch(updateEpoch);
		const rows = await db
			.select({ record: getTableColumns(narratorToolContinuations) })
			.from(narratorToolContinuations)
			.where(
				and(
					eq(narratorToolContinuations.narratorId, narratorId),
					eq(narratorToolContinuations.updateEpoch, updateEpoch),
					notInArray(narratorToolContinuations.state, ["cancelled"]),
				),
			)
			.limit(MAX_ROWS_PER_EPOCH + 1);
		assertEpochRowLimit(rows, updateEpoch);
		return rows.some(({ record }) => !hasPersistedToolContinuationResult(record));
	},

	async markOwnerContinuationStartedForNarrator(
		narratorId: string,
		updateEpoch: string,
	): Promise<boolean> {
		validateUpdateEpoch(updateEpoch);
		const rows = await db
			.select({ messageId: narratorToolCalls.messageId })
			.from(narratorToolContinuations)
			.innerJoin(narratorToolCalls, eq(narratorToolContinuations.toolCallId, narratorToolCalls.id))
			.where(
				and(
					eq(narratorToolContinuations.narratorId, narratorId),
					eq(narratorToolContinuations.updateEpoch, updateEpoch),
					notInArray(narratorToolContinuations.state, ["cancelled"]),
				),
			)
			.limit(MAX_ROWS_PER_EPOCH + 1);
		assertEpochRowLimit(rows, updateEpoch);
		for (const messageId of new Set(rows.map((row) => row.messageId))) {
			const pending = await this.markOwnerContinuationPendingForMessage(messageId, updateEpoch);
			if (!pending) return false;
			const started = await this.markOwnerContinuationStartedForMessage(messageId, updateEpoch);
			if (!started) return false;
		}
		return true;
	},

	async cancelInterruptibleForNarrator(
		narratorId: string,
		updateEpoch: string,
		input: string | CancelInterruptibleContinuationsInput = {},
	): Promise<ToolContinuationRecord[]> {
		validateUpdateEpoch(updateEpoch);
		const options = typeof input === "string" ? { errorMessage: input } : input;
		if (options.recoveryToken !== undefined) validateClaimToken(options.recoveryToken);
		const timestamp = isoNow();
		const cancellableState = options.includeOwnerStarted
			? and(
					notInArray(narratorToolContinuations.state, ["cancelled"]),
					or(
						notInArray(narratorToolContinuations.state, TERMINAL_STATES),
						and(
							eq(narratorToolContinuations.state, "completed"),
							sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryPhase') IN ('owner_continuation_pending', 'owner_continuation_started')`,
						),
					),
				)
			: notInArray(narratorToolContinuations.state, TERMINAL_STATES);
		const cancellableKind = options.includeBackgroundAgentOwner
			? undefined
			: notInArray(narratorToolContinuations.kind, ["background_agent"]);
		return db
			.update(narratorToolContinuations)
			.set({
				state: "cancelled",
				claimToken: null,
				claimedAt: null,
				deadlineAt: null,
				errorMessage: options.errorMessage ?? null,
				completedAt: timestamp,
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(narratorToolContinuations.narratorId, narratorId),
					eq(narratorToolContinuations.updateEpoch, updateEpoch),
					cancellableKind,
					cancellableState,
					...(options.recoveryToken
						? [
								sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryToken') = ${options.recoveryToken}`,
							]
						: []),
				),
			)
			.returning();
	},

	async cancelEpoch(updateEpoch: string, errorMessage?: string): Promise<number> {
		validateUpdateEpoch(updateEpoch);
		const timestamp = isoNow();
		const cancelled = await db
			.update(narratorToolContinuations)
			.set({
				state: "cancelled",
				claimToken: null,
				claimedAt: null,
				deadlineAt: null,
				errorMessage: errorMessage ?? null,
				completedAt: timestamp,
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(narratorToolContinuations.updateEpoch, updateEpoch),
					notInArray(narratorToolContinuations.state, TERMINAL_STATES),
				),
			)
			.returning({ id: narratorToolContinuations.id });
		return cancelled.length;
	},

	async updateDeadline(
		toolCallId: string,
		deadlineAt: string | null,
		claimToken?: string,
	): Promise<ToolContinuationRecord | null> {
		if (claimToken !== undefined) validateClaimToken(claimToken);
		const timestamp = isoNow();
		const normalizedDeadline = deadlineAt ? normalizeTimestamp(deadlineAt, "deadlineAt") : null;
		const stateCondition = claimToken
			? and(
					eq(narratorToolContinuations.state, "resuming"),
					eq(narratorToolContinuations.claimToken, claimToken),
				)
			: inArray(narratorToolContinuations.state, CLAIMABLE_STATES);
		const [updated] = await db
			.update(narratorToolContinuations)
			.set({ deadlineAt: normalizedDeadline, updatedAt: timestamp })
			.where(and(eq(narratorToolContinuations.toolCallId, toolCallId), stateCondition))
			.returning();
		return updated ?? null;
	},

	async hasUnfinishedForMessage(messageId: string, updateEpoch: string): Promise<boolean> {
		validateUpdateEpoch(updateEpoch);
		const rows = await listMessageContinuations(messageId, updateEpoch);
		return rows.some((row) => !isToolContinuationOwnerMounted(row));
	},
};
