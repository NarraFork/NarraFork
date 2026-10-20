import {
	and,
	asc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNull,
	lte,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "../db";
import {
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
} from "../db/schema";
import { readQuery, readQueryFirst } from "../db/worker-read";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { getInstanceMaintenanceAuthority } from "../lib/instance-lock";
import { runAtomicWrite } from "./agent-runtime/runtime-write";
import {
	getRecoverySource,
	getRegisteredRecoverySource,
	getReservedRecoverySourceEpochs,
	hasReservedRecoverySourceEpoch,
	isRecoveryDiscoveryActive,
} from "./recovery-handoff";

export type EpochScope = string | readonly string[];

declare const coldAuthorizationBrand: unique symbol;
export type ColdContinuationAuthorization = { readonly [coldAuthorizationBrand]: true };
export interface ColdContinuationTakeoverEvidence {
	sourceEpoch: string;
	executionAttempt: number;
	authorization: ColdContinuationAuthorization;
}

const coldRecoveryPasses = new WeakMap<
	ColdContinuationAuthorization,
	{
		epochs: Set<string>;
		attempts: Map<string, number>;
		expiresAt: number;
	}
>();

/** Internal startup boundary: call ONLY after claiming root authorization, before mounting queues. */
export function beginColdRecoveryPass(input: {
	rootEpoch: string;
	sourceEpochs: readonly string[];
	unstartedTools: readonly { toolCallId: string; executionAttempt: number }[];
}): { authorization: ColdContinuationAuthorization; close(): void } {
	assertColdInstanceAuthority();
	const epochs = new Set(normalizeEpochScope([input.rootEpoch, ...input.sourceEpochs]));
	for (const epoch of epochs) {
		if (!getRegisteredRecoverySource(epoch) || hasReservedRecoverySourceEpoch(epoch))
			throw new ValidationError(
				"Cold recovery pass requires registered, non-reserved root/source authority",
			);
	}
	if (input.unstartedTools.length > MAX_ROWS_PER_EPOCH)
		throw new ValidationError("Cold recovery receipt budget exceeded");
	const attempts = new Map<string, number>();
	for (const receipt of input.unstartedTools) {
		if (
			!Number.isInteger(receipt.executionAttempt) ||
			receipt.executionAttempt < 1 ||
			attempts.has(receipt.toolCallId)
		) {
			throw new ValidationError("Invalid or duplicate cold recovery execution receipt");
		}
		attempts.set(receipt.toolCallId, receipt.executionAttempt);
	}
	const authorization = Object.freeze({}) as ColdContinuationAuthorization;
	coldRecoveryPasses.set(authorization, { epochs, attempts, expiresAt: Date.now() + 300_000 });
	return {
		authorization,
		close: () => {
			coldRecoveryPasses.delete(authorization);
		},
	};
}

declare const ordinaryColdAuthorizationBrand: unique symbol;
export type OrdinaryColdAdoptionAuthorization = {
	readonly [ordinaryColdAuthorizationBrand]: true;
};
const ordinaryColdPasses = new WeakMap<
	OrdinaryColdAdoptionAuthorization,
	{
		rootEpoch: string;
		toolCallId: string;
		recordId: string;
		sourceEpoch: string;
		narratorId: string;
		executionAttempt: number;
		updatedAt: string;
		expiresAt: number;
	}
>();

function ordinaryColdSource(rootEpoch: string) {
	assertColdInstanceAuthority();
	const source = getRecoverySource(rootEpoch);
	if (
		!isRecoveryDiscoveryActive() ||
		source?.kind !== "ordinary" ||
		getReservedRecoverySourceEpochs().length
	) {
		throw new ValidationError(
			"Ordinary cold adoption requires discovery, registered ordinary authority and no hot handoff",
		);
	}
	return source;
}

/** Only the fresh ordinary classification authorizes this one record, not its old manifest. */
export async function beginOrdinaryColdAdoptionPass(input: {
	rootEpoch: string;
	toolCallId: string;
}) {
	ordinaryColdSource(input.rootEpoch);
	const receipt = await readQueryFirst(
		db
			.select({
				recordId: narratorToolContinuations.id,
				sourceEpoch: narratorToolContinuations.updateEpoch,
				narratorId: narratorToolContinuations.narratorId,
				executionAttempt: narratorToolCalls.executionAttempt,
				updatedAt: narratorToolContinuations.updatedAt,
			})
			.from(narratorToolContinuations)
			.innerJoin(narratorToolCalls, eq(narratorToolCalls.id, narratorToolContinuations.toolCallId))
			.where(eq(narratorToolContinuations.toolCallId, input.toolCallId))
			.limit(1),
		{ site: "toolContinuation.coldAdoptionReceipt" },
	);
	if (!receipt || hasReservedRecoverySourceEpoch(receipt.sourceEpoch))
		throw new ValidationError(
			"Ordinary cold adoption requires an actual non-reserved execution receipt",
		);
	ordinaryColdSource(input.rootEpoch);
	const authorization = Object.freeze({}) as OrdinaryColdAdoptionAuthorization;
	ordinaryColdPasses.set(authorization, { ...input, ...receipt, expiresAt: Date.now() + 300_000 });
	return {
		authorization,
		close: () => {
			ordinaryColdPasses.delete(authorization);
		},
	};
}

function assertColdInstanceAuthority(): void {
	const authority = getInstanceMaintenanceAuthority();
	if (!authority.allowed)
		throw new ValidationError(
			`Cold continuation takeover requires exclusive instance authority: ${authority.reason}`,
		);
}

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
	updateEpoch?: string;
	deadlineAt: string;
	claimToken?: string;
	now?: string;
}

export interface CompleteToolContinuationInput {
	claimToken: string;
	updateEpoch?: string;
	payloadJson?: Record<string, unknown> | null;
}

export interface FailToolContinuationInput {
	claimToken: string;
	updateEpoch?: string;
	errorMessage: string;
	payloadJson?: Record<string, unknown> | null;
}

export interface RenewToolContinuationClaimInput {
	claimToken: string;
	updateEpoch?: string;
	deadlineAt: string;
	now?: string;
}

export interface MarkExecutionUnknownInput {
	claimToken: string;
	updateEpoch?: string;
	errorMessage: string;
	payloadJson: Record<string, unknown>;
	now?: string;
}

export interface FinalizeRecoveryFailureInput {
	updateEpoch?: string;
	errorMessage: string;
	payloadJson: Record<string, unknown>;
}

export interface MarkResultWrittenInput {
	claimToken: string;
	updateEpoch?: string;
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
const MAX_RECOVERY_BYTES = 16 * 1024 * 1024;
const METADATA_PAGE_SIZE = 100;
const MAX_BOUNDED_READ_ATTEMPTS = 3;
const payloadBytes = sql<number>`coalesce(length(cast(${narratorToolContinuations.payloadJson} as blob)), 0)`;
const toolInputBytes = sql<number>`coalesce(length(cast(${narratorToolCalls.inputJson} as blob)), 0)`;
const messageContentBytes = sql<number>`coalesce(length(cast(${narratorMessages.contentJson} as blob)), 0)`;
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

function normalizeEpochScope(scope: EpochScope): string[] {
	const epochs = [...new Set(typeof scope === "string" ? [scope] : scope)];
	if (epochs.length === 0 || epochs.length > 65)
		throw new ValidationError("Recovery scope must contain 1 to 65 epochs");
	for (const epoch of epochs) validateUpdateEpoch(epoch);
	return epochs;
}

function epochCondition(scope: EpochScope) {
	const epochs = normalizeEpochScope(scope);
	return inArray(narratorToolContinuations.updateEpoch, epochs);
}

function assertCarryover(
	existing: ToolContinuationRecord,
	input: Pick<PutToolContinuationInput, "updateEpoch" | "narratorId" | "toolCallId">,
	authorizedSources: readonly string[] = getReservedRecoverySourceEpochs(input.updateEpoch),
): boolean {
	if (existing.narratorId !== input.narratorId)
		throw new ValidationError("Continuation checkpoint owner mismatch");
	if (existing.updateEpoch === input.updateEpoch) return false;
	if (existing.narratorId === input.narratorId && authorizedSources.includes(existing.updateEpoch))
		return true;
	throw new ValidationError(
		`Cannot checkpoint tool continuation ${input.toolCallId}: epoch ${existing.updateEpoch} is outside reserved recovery sources for ${input.updateEpoch}`,
	);
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

async function withExecutionReceipt(
	input: PutToolContinuationInput,
): Promise<PutToolContinuationInput> {
	const tool = await readQueryFirst(
		db
			.select({ executionAttempt: narratorToolCalls.executionAttempt })
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, input.toolCallId))
			.limit(1),
		{ site: "toolContinuation.executionReceipt" },
	);
	return tool
		? { ...input, payloadJson: { ...input.payloadJson, executionAttempt: tool.executionAttempt } }
		: input;
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

function assertEpochRowLimit(rows: unknown[], updateEpoch: EpochScope): void {
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

class ContinuationScopeChangedError extends ValidationError {
	constructor() {
		super("Continuation recovery scope changed during bounded read");
	}
}

// Recovery writes may grow payloads after metadata validation. Start over with fresh
// metadata and empty budgets/results; never retry budget failures or relax SQL byte guards.
async function retryBoundedContinuationRead<T>(read: () => Promise<T>): Promise<T> {
	for (let attempt = 1; attempt < MAX_BOUNDED_READ_ATTEMPTS; attempt++) {
		try {
			return await read();
		} catch (error) {
			if (!(error instanceof ContinuationScopeChangedError)) throw error;
		}
	}
	return read();
}

async function readBoundedContinuations(
	scope: EpochScope,
	filter?: SQL,
): Promise<ToolContinuationRecord[]> {
	return retryBoundedContinuationRead(async () => {
		const metadata: { id: string; bytes: number }[] = [];
		let cursor: string | undefined;
		let totalBytes = 0;
		while (true) {
			const page = await readQuery(
				db
					.select({ id: narratorToolContinuations.id, bytes: payloadBytes })
					.from(narratorToolContinuations)
					.where(
						and(
							epochCondition(scope),
							filter,
							cursor ? gt(narratorToolContinuations.id, cursor) : undefined,
						),
					)
					.orderBy(asc(narratorToolContinuations.id))
					.limit(METADATA_PAGE_SIZE + 1),
				{ site: "toolContinuation.recoveryMetadata" },
			);
			assertEpochRowLimit([...metadata, ...page], scope);
			for (const row of page.slice(0, METADATA_PAGE_SIZE)) {
				totalBytes += row.bytes;
				if (row.bytes > MAX_PAYLOAD_BYTES || totalBytes > MAX_RECOVERY_BYTES)
					throw new ValidationError("Continuation recovery payload budget exceeded");
				metadata.push(row);
			}
			if (page.length <= METADATA_PAGE_SIZE) break;
			cursor = metadata.at(-1)?.id;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		const records: ToolContinuationRecord[] = [];
		for (let offset = 0; offset < metadata.length; offset += METADATA_PAGE_SIZE) {
			const page = metadata.slice(offset, offset + METADATA_PAGE_SIZE);
			const rows = await readQuery(
				db
					.select()
					.from(narratorToolContinuations)
					.where(
						and(
							epochCondition(scope),
							filter,
							or(
								...page.map((row) =>
									and(eq(narratorToolContinuations.id, row.id), lte(payloadBytes, row.bytes)),
								),
							),
						),
					),
				{ site: "toolContinuation.recoveryPayloads" },
			);
			if (rows.length !== page.length) throw new ContinuationScopeChangedError();
			records.push(...rows);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		return records.sort(
			(a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
		);
	});
}

async function listMessageContinuations(
	messageId: string,
	updateEpoch: EpochScope,
): Promise<ToolContinuationRecord[]> {
	return readBoundedContinuations(
		updateEpoch,
		inArray(
			narratorToolContinuations.toolCallId,
			db
				.select({ id: narratorToolCalls.id })
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.messageId, messageId)),
		),
	);
}

export const toolContinuationService = {
	beginColdRecoveryPass,
	beginOrdinaryColdAdoptionPass,

	/** A single cold record may move only onto its freshly selected ordinary owner/child. */
	async controlledOrdinaryColdAdoption(
		input: PutToolContinuationInput,
		authorization: OrdinaryColdAdoptionAuthorization,
	): Promise<ToolContinuationRecord | null> {
		const pass = ordinaryColdPasses.get(authorization);
		if (
			!pass ||
			pass.expiresAt < Date.now() ||
			pass.rootEpoch !== input.updateEpoch ||
			pass.toolCallId !== input.toolCallId ||
			pass.narratorId !== input.narratorId
		)
			throw new ValidationError(
				"Ordinary cold adoption requires a live single-record authorization",
			);
		const timestamp = isoNow();
		const normalized = normalizePutInput(input, timestamp);
		return runAtomicWrite(db, "tool-continuation.ordinaryColdAdoption", (tx) => {
			const source = ordinaryColdSource(pass.rootEpoch);
			const existing = tx
				.select()
				.from(narratorToolContinuations)
				.where(eq(narratorToolContinuations.id, pass.recordId))
				.get();
			const tool = tx
				.select({
					narratorId: narratorToolCalls.narratorId,
					toolName: narratorToolCalls.toolName,
					executionAttempt: narratorToolCalls.executionAttempt,
					executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
					executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
					isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
					executionStartedAt: narratorToolCalls.executionStartedAt,
					fileChangeOperationId: narratorToolCalls.fileChangeOperationId,
					status: narratorToolCalls.status,
				})
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, input.toolCallId))
				.get();
			const owner = tx
				.select({
					id: narrators.id,
					logicalRunId: narrators.logicalRunId,
					status: narrators.status,
					substatus: narrators.substatus,
				})
				.from(narrators)
				.where(eq(narrators.id, input.narratorId))
				.get();
			const severed = (row: { substatus: string | null }) => {
				try {
					const tags: unknown = row.substatus ? JSON.parse(row.substatus) : [];
					return (
						!Array.isArray(tags) ||
						tags.some((tag) =>
							["error", "taken_over", "manual_override", "cancelled"].includes(tag),
						)
					);
				} catch {
					return true;
				}
			};
			const selected = (row: {
				id: string;
				logicalRunId: string | null;
				status: string;
				substatus: string | null;
			}) =>
				source.pendingNarratorIds.includes(row.id) &&
				source.logicalRuns?.some(
					(target) => target.narratorId === row.id && target.logicalRunId === row.logicalRunId,
				) &&
				!severed(row) &&
				["working", "waiting", "idle"].includes(row.status);
			if (
				!existing ||
				!tool ||
				!owner ||
				existing.toolCallId !== input.toolCallId ||
				existing.updateEpoch !== pass.sourceEpoch ||
				existing.narratorId !== input.narratorId ||
				existing.updatedAt !== pass.updatedAt ||
				existing.state === "cancelled" ||
				isToolContinuationOwnerMounted(existing) ||
				severed(owner) ||
				tool.narratorId !== input.narratorId ||
				tool.executionAttempt < 1 ||
				tool.executionAttempt !== pass.executionAttempt ||
				existing.payloadJson?.executionAttempt !== tool.executionAttempt ||
				tool.executionIdentityVersion !== 1 ||
				tool.executionOriginToolCallId !== null ||
				tool.isFileHistoryCheckpoint
			)
				return null;
			const agent = input.kind === "foreground_agent" || input.kind === "background_agent";
			if (agent) {
				const subagentId = input.payloadJson?.subagentId;
				const logicalRunId = input.payloadJson?.logicalRunId;
				if (
					typeof subagentId !== "string" ||
					typeof logicalRunId !== "string" ||
					!logicalRunId ||
					tool.toolName !== "Agent" ||
					!tool.executionStartedAt
				)
					return null;
				const child = tx
					.select({
						id: narrators.id,
						logicalRunId: narrators.logicalRunId,
						status: narrators.status,
						substatus: narrators.substatus,
						type: narrators.type,
						originToolCallId: narrators.originToolCallId,
						parentNarratorId: narrators.parentNarratorId,
						createdAt: narrators.createdAt,
					})
					.from(narrators)
					.where(eq(narrators.id, subagentId))
					.get();
				if (
					!child ||
					!selected(child) ||
					child.type !== "subagent" ||
					child.originToolCallId !== input.toolCallId ||
					child.parentNarratorId !== input.narratorId ||
					child.logicalRunId !== logicalRunId ||
					!(Date.parse(child.createdAt) >= Date.parse(tool.executionStartedAt)) ||
					(input.kind === "foreground_agent" && !selected(owner)) ||
					(existing.payloadJson?.subagentId !== undefined &&
						existing.payloadJson.subagentId !== child.id) ||
					(existing.payloadJson?.logicalRunId !== undefined &&
						existing.payloadJson.logicalRunId !== logicalRunId)
				)
					return null;
			} else if (
				!selected(owner) ||
				!NON_IDEMPOTENT_KINDS.includes(input.kind) ||
				!NON_IDEMPOTENT_KINDS.includes(existing.kind)
			)
				return null;
			const result = hasPersistedToolContinuationResult(existing);
			if (result && !["success", "fail"].includes(tool.status)) return null;
			if (
				!result &&
				!agent &&
				(tool.executionStartedAt !== null ||
					tool.fileChangeOperationId !== null ||
					!["initializing", "running", "pending"].includes(tool.status))
			)
				return null;
			if (
				!result &&
				agent &&
				![
					"initializing",
					"running",
					"pending",
					...(input.kind === "background_agent" ? ["success"] : []),
				].includes(tool.status)
			)
				return null;
			const { id: _id, createdAt: _createdAt, ...replacement } = normalized;
			const adopted =
				tx
					.update(narratorToolContinuations)
					.set(
						result
							? {
									updateEpoch: input.updateEpoch,
									claimToken: null,
									claimedAt: null,
									deadlineAt: null,
									updatedAt: timestamp,
								}
							: {
									...replacement,
									state: "waiting",
									claimToken: null,
									claimedAt: null,
									deadlineAt: null,
									payloadJson: normalizePayload({
										...input.payloadJson,
										executionAttempt: tool.executionAttempt,
									}),
								},
					)
					.where(
						and(
							eq(narratorToolContinuations.id, existing.id),
							eq(narratorToolContinuations.updateEpoch, pass.sourceEpoch),
							eq(narratorToolContinuations.updatedAt, pass.updatedAt),
						),
					)
					.returning()
					.get() ?? null;
			if (adopted) ordinaryColdPasses.delete(authorization);
			return adopted;
		});
	},
	async getByToolCallId(toolCallId: string): Promise<ToolContinuationRecord | null> {
		const row = await readQueryFirst(
			db
				.select()
				.from(narratorToolContinuations)
				.where(eq(narratorToolContinuations.toolCallId, toolCallId))
				.limit(1),
			{ site: "toolContinuation.byToolCall" },
		);
		return row ?? null;
	},

	async getToolCallResult(toolCallId: string): Promise<ToolContinuationToolCallResult | null> {
		const row = await readQueryFirst(
			db
				.select({
					id: narratorToolCalls.id,
					toolUseId: narratorToolCalls.toolUseId,
					messageId: narratorToolCalls.messageId,
					status: narratorToolCalls.status,
					outputJson: narratorToolCalls.outputJson,
				})
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, toolCallId))
				.limit(1),
			{ site: "toolContinuation.toolResult" },
		);
		return row ?? null;
	},

	async create(input: PutToolContinuationInput): Promise<ToolContinuationRecord> {
		input = await withExecutionReceipt(input);
		const timestamp = isoNow();
		const [created] = await db
			.insert(narratorToolContinuations)
			.values(normalizePutInput(input, timestamp))
			.returning();
		if (!created) throw new Error("Failed to create tool continuation");
		return created;
	},

	async upsert(input: PutToolContinuationInput): Promise<ToolContinuationRecord> {
		input = await withExecutionReceipt(input);
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
				setWhere: and(
					eq(narratorToolContinuations.updateEpoch, input.updateEpoch),
					eq(narratorToolContinuations.narratorId, input.narratorId),
					isNull(narratorToolContinuations.claimToken),
					inArray(narratorToolContinuations.state, CLAIMABLE_STATES),
					sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryPhase') IS NULL`,
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
		if (existing?.updateEpoch !== input.updateEpoch) {
			throw new ValidationError(
				`Cannot upsert tool continuation ${input.toolCallId} across epoch ${existing?.updateEpoch} -> ${input.updateEpoch}`,
			);
		}
		throw new Error(
			"Failed to upsert tool continuation because its state changed concurrently or has a protected result/claim",
		);
	},

	/** Preserve ticket-authorized carryover verbatim, including its execution and delivery owner. */
	async checkpoint(input: PutToolContinuationInput): Promise<ToolContinuationRecord> {
		// This snapshot only permits a read-only carryover return, never a write after release.
		const authorizedSources = getReservedRecoverySourceEpochs(input.updateEpoch);
		const existing = await this.getByToolCallId(input.toolCallId);
		if (existing && assertCarryover(existing, input, authorizedSources)) return existing;
		if (
			existing?.state === "resuming" ||
			existing?.state === "cancelled" ||
			(existing && hasPersistedToolContinuationResult(existing))
		)
			return existing;
		return this.upsert(input);
	},

	/** Never callable with a hot handoff ticket. The durable execution receipt wins over the manifest. */
	async controlledColdTakeover(
		input: PutToolContinuationInput,
		evidence: ColdContinuationTakeoverEvidence,
	): Promise<ToolContinuationRecord | null> {
		assertColdInstanceAuthority();
		const pass = coldRecoveryPasses.get(evidence.authorization);
		if (
			!pass ||
			pass.expiresAt < Date.now() ||
			[...pass.epochs].some(
				(epoch) => !getRegisteredRecoverySource(epoch) || hasReservedRecoverySourceEpoch(epoch),
			) ||
			!pass.epochs.has(input.updateEpoch) ||
			!pass.epochs.has(evidence.sourceEpoch) ||
			pass.attempts.get(input.toolCallId) !== evidence.executionAttempt
		) {
			throw new ValidationError(
				"Cold continuation takeover requires a live authorized root/source execution receipt",
			);
		}
		const timestamp = isoNow();
		const normalized = normalizePutInput(input, timestamp);
		return runAtomicWrite(db, "tool-continuation.controlledColdTakeover", (tx) => {
			const tool = tx
				.select({
					narratorId: narratorToolCalls.narratorId,
					executionAttempt: narratorToolCalls.executionAttempt,
					executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
					executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
					isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
					executionStartedAt: narratorToolCalls.executionStartedAt,
					status: narratorToolCalls.status,
					fileChangeOperationId: narratorToolCalls.fileChangeOperationId,
				})
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, input.toolCallId))
				.get();
			const existing = tx
				.select()
				.from(narratorToolContinuations)
				.where(eq(narratorToolContinuations.toolCallId, input.toolCallId))
				.get();
			if (
				!tool ||
				!existing ||
				existing.updateEpoch !== evidence.sourceEpoch ||
				existing.narratorId !== input.narratorId ||
				tool.narratorId !== input.narratorId ||
				tool.executionAttempt < 1 ||
				tool.executionIdentityVersion !== 1 ||
				tool.executionOriginToolCallId !== null ||
				tool.isFileHistoryCheckpoint ||
				tool.executionAttempt !== evidence.executionAttempt ||
				tool.executionStartedAt !== null ||
				tool.fileChangeOperationId !== null ||
				!["initializing", "running", "pending"].includes(tool.status)
			)
				return null;
			if (
				!NON_IDEMPOTENT_KINDS.includes(existing.kind) ||
				!NON_IDEMPOTENT_KINDS.includes(input.kind) ||
				hasPersistedToolContinuationResult(existing) ||
				isToolContinuationOwnerMounted(existing)
			)
				return null;
			const preserve = existing.updateEpoch === input.updateEpoch;
			const { id: _id, createdAt: _createdAt, ...replacement } = normalized;
			return (
				tx
					.update(narratorToolContinuations)
					.set(
						preserve
							? {
									state: "waiting",
									claimToken: null,
									claimedAt: null,
									deadlineAt: null,
									updatedAt: timestamp,
								}
							: replacement,
					)
					.where(
						and(
							eq(narratorToolContinuations.id, existing.id),
							eq(narratorToolContinuations.updateEpoch, evidence.sourceEpoch),
							existing.claimToken
								? eq(narratorToolContinuations.claimToken, existing.claimToken)
								: isNull(narratorToolContinuations.claimToken),
						),
					)
					.returning()
					.get() ?? null
			);
		});
	},

	/** Reattach an already-created Agent only by its immutable execution provenance, never its name. */
	async controlledColdReattachAgent(
		input: PutToolContinuationInput,
		evidence: ColdContinuationTakeoverEvidence & { subagentId: string; logicalRunId: string },
	): Promise<ToolContinuationRecord | null> {
		assertColdInstanceAuthority();
		const pass = coldRecoveryPasses.get(evidence.authorization);
		if (
			!pass ||
			pass.expiresAt < Date.now() ||
			[...pass.epochs].some(
				(epoch) => !getRegisteredRecoverySource(epoch) || hasReservedRecoverySourceEpoch(epoch),
			) ||
			!pass.epochs.has(input.updateEpoch) ||
			!pass.epochs.has(evidence.sourceEpoch)
		)
			throw new ValidationError("Cold Agent reattachment requires live root/source authority");
		if (!["foreground_agent", "background_agent"].includes(input.kind))
			throw new ValidationError("Cold Agent reattachment requires an Agent continuation");
		const timestamp = isoNow();
		return runAtomicWrite(db, "tool-continuation.controlledColdReattachAgent", (tx) => {
			const tool = tx
				.select({
					narratorId: narratorToolCalls.narratorId,
					toolName: narratorToolCalls.toolName,
					executionAttempt: narratorToolCalls.executionAttempt,
					executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
					executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
					isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
					executionStartedAt: narratorToolCalls.executionStartedAt,
					status: narratorToolCalls.status,
				})
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, input.toolCallId))
				.get();
			const child = tx
				.select({
					originToolCallId: narrators.originToolCallId,
					parentNarratorId: narrators.parentNarratorId,
					logicalRunId: narrators.logicalRunId,
					createdAt: narrators.createdAt,
				})
				.from(narrators)
				.where(eq(narrators.id, evidence.subagentId))
				.get();
			const existing = tx
				.select()
				.from(narratorToolContinuations)
				.where(eq(narratorToolContinuations.toolCallId, input.toolCallId))
				.get();
			if (
				!tool ||
				!child ||
				!existing ||
				existing.updateEpoch !== evidence.sourceEpoch ||
				existing.narratorId !== input.narratorId ||
				tool.narratorId !== input.narratorId ||
				tool.executionAttempt < 1 ||
				tool.executionIdentityVersion !== 1 ||
				tool.executionOriginToolCallId !== null ||
				tool.isFileHistoryCheckpoint ||
				tool.toolName !== "Agent" ||
				tool.executionAttempt !== evidence.executionAttempt ||
				!tool.executionStartedAt ||
				child.originToolCallId !== input.toolCallId ||
				child.parentNarratorId !== input.narratorId ||
				!evidence.logicalRunId ||
				child.logicalRunId !== evidence.logicalRunId ||
				!(Date.parse(child.createdAt) >= Date.parse(tool.executionStartedAt)) ||
				isToolContinuationOwnerMounted(existing) ||
				hasPersistedToolContinuationResult(existing)
			)
				return null;
			return (
				tx
					.update(narratorToolContinuations)
					.set({
						updateEpoch: input.updateEpoch,
						kind: input.kind,
						state: "waiting",
						claimToken: null,
						claimedAt: null,
						deadlineAt: null,
						payloadJson: normalizePayload({
							...existing.payloadJson,
							...input.payloadJson,
							subagentId: evidence.subagentId,
							logicalRunId: evidence.logicalRunId,
							executionAttempt: evidence.executionAttempt,
						}),
						updatedAt: timestamp,
					})
					.where(
						and(
							eq(narratorToolContinuations.id, existing.id),
							eq(narratorToolContinuations.updateEpoch, evidence.sourceEpoch),
							existing.claimToken
								? eq(narratorToolContinuations.claimToken, existing.claimToken)
								: isNull(narratorToolContinuations.claimToken),
						),
					)
					.returning()
					.get() ?? null
			);
		});
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

			if (existing && assertCarryover(existing, input)) return existing;
			// The recovery owner, not a checkpoint, owns an in-flight claim's result phase.
			if (
				existing?.state === "resuming" &&
				(existing.deadlineAt === null || existing.deadlineAt > timestamp)
			)
				return existing;

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
						setWhere: and(
							eq(narratorToolContinuations.updateEpoch, input.updateEpoch),
							isNull(narratorToolContinuations.claimToken),
							inArray(narratorToolContinuations.state, CLAIMABLE_STATES),
							sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryPhase') IS NULL`,
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
		normalizeEpochScope(updateEpoch);
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

	async listSendAwaitCheckpointRows(updateEpoch: EpochScope): Promise<SendAwaitCheckpointRow[]> {
		const records = await readBoundedContinuations(
			updateEpoch,
			eq(narratorToolContinuations.kind, "send_await"),
		);
		const rows: SendAwaitCheckpointRow[] = [];
		for (let offset = 0; offset < records.length; offset += METADATA_PAGE_SIZE) {
			const page = records.slice(offset, offset + METADATA_PAGE_SIZE);
			const tools = await readQuery(
				db
					.select({ id: narratorToolCalls.id, status: narratorToolCalls.status })
					.from(narratorToolCalls)
					.where(
						inArray(
							narratorToolCalls.id,
							page.map((record) => record.toolCallId),
						),
					),
				{ site: "toolContinuation.checkpointTools" },
			);
			const statuses = new Map(tools.map((tool) => [tool.id, tool.status]));
			for (const record of page) {
				const toolCallStatus = statuses.get(record.toolCallId);
				if (toolCallStatus) rows.push({ record, toolCallStatus });
			}
		}
		return rows;
	},

	async bindRecoveryTokenForNarrator(
		narratorId: string,
		updateEpoch: EpochScope,
		recoveryToken: string,
	): Promise<ToolContinuationRecord[]> {
		normalizeEpochScope(updateEpoch);
		validateClaimToken(recoveryToken);
		const rows = (
			await readBoundedContinuations(
				updateEpoch,
				eq(narratorToolContinuations.narratorId, narratorId),
			)
		).filter((row) => !isToolContinuationOwnerMounted(row));
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
						eq(narratorToolContinuations.updateEpoch, row.updateEpoch),
						row.claimToken
							? eq(narratorToolContinuations.claimToken, row.claimToken)
							: isNull(narratorToolContinuations.claimToken),
						notInArray(narratorToolContinuations.state, ["cancelled"]),
					),
				)
				.returning();
			if (next) updated.push(next);
		}
		return updated;
	},

	async listByEpoch(updateEpoch: EpochScope): Promise<ToolContinuationRecord[]> {
		return readBoundedContinuations(updateEpoch);
	},

	async listRecoveryQueueByEpoch(updateEpoch: EpochScope): Promise<ToolContinuationRecoveryItem[]> {
		return retryBoundedContinuationRead(async () => {
			// Validate the entire union before materializing any payload, message, or tool input.
			const metadata: { id: string; bytes: number; inputBytes: number; contentBytes: number }[] =
				[];
			let cursor: string | undefined;
			let totalBytes = 0;
			while (true) {
				const page = await readQuery(
					db
						.select({
							id: narratorToolContinuations.id,
							bytes: payloadBytes,
							inputBytes: toolInputBytes,
							contentBytes: messageContentBytes,
						})
						.from(narratorToolContinuations)
						.innerJoin(
							narratorToolCalls,
							eq(narratorToolContinuations.toolCallId, narratorToolCalls.id),
						)
						.innerJoin(narratorMessages, eq(narratorToolCalls.messageId, narratorMessages.id))
						.where(
							and(
								epochCondition(updateEpoch),
								cursor ? gt(narratorToolContinuations.id, cursor) : undefined,
							),
						)
						.orderBy(asc(narratorToolContinuations.id))
						.limit(METADATA_PAGE_SIZE + 1),
					{ site: "toolContinuation.recoveryMetadata" },
				);
				assertEpochRowLimit([...metadata, ...page], updateEpoch);
				for (const row of page.slice(0, METADATA_PAGE_SIZE)) {
					totalBytes += row.bytes + row.inputBytes + row.contentBytes;
					if (row.bytes > MAX_PAYLOAD_BYTES || totalBytes > MAX_RECOVERY_BYTES)
						throw new ValidationError("Continuation recovery payload budget exceeded");
					metadata.push(row);
				}
				if (page.length <= METADATA_PAGE_SIZE) break;
				cursor = metadata.at(-1)?.id;
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
			const result: ToolContinuationRecoveryItem[] = [];
			for (let offset = 0; offset < metadata.length; offset += METADATA_PAGE_SIZE) {
				const page = metadata.slice(offset, offset + METADATA_PAGE_SIZE);
				const rows = await readQuery(
					db
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
						.innerJoin(
							narratorToolCalls,
							eq(narratorToolContinuations.toolCallId, narratorToolCalls.id),
						)
						.innerJoin(narratorMessages, eq(narratorToolCalls.messageId, narratorMessages.id))
						.where(
							and(
								epochCondition(updateEpoch),
								or(
									...page.map((row) =>
										and(
											eq(narratorToolContinuations.id, row.id),
											lte(payloadBytes, row.bytes),
											lte(toolInputBytes, row.inputBytes),
											lte(messageContentBytes, row.contentBytes),
										),
									),
								),
							),
						),
					{ site: "toolContinuation.recoveryQueue" },
				);
				if (rows.length !== page.length) throw new ContinuationScopeChangedError();
				result.push(
					...rows.map(({ toolUseId, inputJson, contentJson, ...row }) => ({
						...row,
						input: normalizeToolInput(inputJson),
						toolUseOrder: toolUseOrder(contentJson, toolUseId),
					})),
				);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
			return result.sort(
				(a, b) =>
					a.record.narratorId.localeCompare(b.record.narratorId) ||
					a.messageCreatedAt.localeCompare(b.messageCreatedAt) ||
					a.messageId.localeCompare(b.messageId) ||
					a.toolUseOrder - b.toolUseOrder ||
					a.toolCallCreatedAt.localeCompare(b.toolCallCreatedAt) ||
					a.record.toolCallId.localeCompare(b.record.toolCallId),
			);
		});
	},

	async getProtectionSets(updateEpoch: EpochScope): Promise<ToolContinuationProtectionSets> {
		const rows = await readBoundedContinuations(updateEpoch);

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
					input.updateEpoch
						? eq(narratorToolContinuations.updateEpoch, input.updateEpoch)
						: undefined,
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
					input.updateEpoch
						? eq(narratorToolContinuations.updateEpoch, input.updateEpoch)
						: undefined,
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
					input.updateEpoch
						? eq(narratorToolContinuations.updateEpoch, input.updateEpoch)
						: undefined,
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
					input.updateEpoch
						? eq(narratorToolContinuations.updateEpoch, input.updateEpoch)
						: undefined,
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
					input.updateEpoch
						? eq(narratorToolContinuations.updateEpoch, input.updateEpoch)
						: undefined,
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
					input.updateEpoch
						? eq(narratorToolContinuations.updateEpoch, input.updateEpoch)
						: undefined,
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
					input.updateEpoch
						? eq(narratorToolContinuations.updateEpoch, input.updateEpoch)
						: undefined,
				),
			)
			.returning();
		return updated ?? null;
	},

	async markOwnerContinuationPendingForMessage(
		messageId: string,
		updateEpoch: EpochScope,
		recoveryToken?: string,
	): Promise<ToolContinuationRecord[] | null> {
		normalizeEpochScope(updateEpoch);
		if (recoveryToken !== undefined) validateClaimToken(recoveryToken);
		const rows = await listMessageContinuations(messageId, updateEpoch);
		const deliverable = rows.filter((row) => row.state !== "cancelled");
		if (
			deliverable.some(
				(row) =>
					!isToolContinuationOwnerMounted(row) &&
					(!hasPersistedToolContinuationResult(row) ||
						(recoveryToken !== undefined && row.payloadJson?.recoveryToken !== recoveryToken)),
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
						eq(narratorToolContinuations.updateEpoch, row.updateEpoch),
						row.claimToken
							? eq(narratorToolContinuations.claimToken, row.claimToken)
							: isNull(narratorToolContinuations.claimToken),
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
		updateEpoch: EpochScope,
		recoveryToken?: string,
	): Promise<ToolContinuationRecord[] | null> {
		normalizeEpochScope(updateEpoch);
		if (recoveryToken !== undefined) validateClaimToken(recoveryToken);
		const rows = await listMessageContinuations(messageId, updateEpoch);
		const deliverable = rows.filter((row) => row.state !== "cancelled");
		if (
			recoveryToken !== undefined &&
			deliverable.some(
				(row) =>
					!isToolContinuationOwnerMounted(row) && row.payloadJson?.recoveryToken !== recoveryToken,
			)
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
						eq(narratorToolContinuations.updateEpoch, row.updateEpoch),
						row.claimToken
							? eq(narratorToolContinuations.claimToken, row.claimToken)
							: isNull(narratorToolContinuations.claimToken),
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

	async hasUnwrittenResultsForNarrator(
		narratorId: string,
		updateEpoch: EpochScope,
	): Promise<boolean> {
		const rows = await readBoundedContinuations(
			updateEpoch,
			and(
				eq(narratorToolContinuations.narratorId, narratorId),
				notInArray(narratorToolContinuations.state, ["cancelled"]),
			),
		);
		return rows.some((record) => !hasPersistedToolContinuationResult(record));
	},

	async markOwnerContinuationStartedForNarrator(
		narratorId: string,
		updateEpoch: EpochScope,
	): Promise<boolean> {
		normalizeEpochScope(updateEpoch);
		const rows = await readQuery(
			db
				.select({ messageId: narratorToolCalls.messageId })
				.from(narratorToolContinuations)
				.innerJoin(
					narratorToolCalls,
					eq(narratorToolContinuations.toolCallId, narratorToolCalls.id),
				)
				.where(
					and(
						eq(narratorToolContinuations.narratorId, narratorId),
						epochCondition(updateEpoch),
						notInArray(narratorToolContinuations.state, ["cancelled"]),
					),
				)
				.limit(MAX_ROWS_PER_EPOCH + 1),
			{ site: "toolContinuation.ownerMessages" },
		);
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
		updateEpoch: EpochScope,
		input: string | CancelInterruptibleContinuationsInput = {},
	): Promise<ToolContinuationRecord[]> {
		normalizeEpochScope(updateEpoch);
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
		const filter = and(
			eq(narratorToolContinuations.narratorId, narratorId),
			cancellableKind,
			cancellableState,
			options.recoveryToken
				? sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryToken') = ${options.recoveryToken}`
				: undefined,
		);
		const rows = await readBoundedContinuations(updateEpoch, filter);
		const result: ToolContinuationRecord[] = [];
		const changes = {
			state: "cancelled" as const,
			claimToken: null,
			claimedAt: null,
			deadlineAt: null,
			errorMessage: options.errorMessage ?? null,
			completedAt: timestamp,
			updatedAt: timestamp,
		};
		for (let offset = 0; offset < rows.length; offset += METADATA_PAGE_SIZE) {
			const page = rows.slice(offset, offset + METADATA_PAGE_SIZE);
			const changed = await db
				.update(narratorToolContinuations)
				.set(changes)
				.where(
					and(
						filter,
						or(
							...page.map((row) =>
								and(
									eq(narratorToolContinuations.id, row.id),
									eq(narratorToolContinuations.updateEpoch, row.updateEpoch),
									row.claimToken
										? eq(narratorToolContinuations.claimToken, row.claimToken)
										: isNull(narratorToolContinuations.claimToken),
								),
							),
						),
					),
				)
				.returning({ id: narratorToolContinuations.id });
			const ids = new Set(changed.map((row) => row.id));
			result.push(...page.filter((row) => ids.has(row.id)).map((row) => ({ ...row, ...changes })));
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		return result;
	},

	/** Cleanup for an executor write that completed after its gate's cancellation cleanup. */
	async cancelUnclaimedCheckpoint(toolCallId: string, updateEpoch: string): Promise<boolean> {
		validateUpdateEpoch(updateEpoch);
		const timestamp = isoNow();
		const rows = await db
			.update(narratorToolContinuations)
			.set({ state: "cancelled", completedAt: timestamp, updatedAt: timestamp })
			.where(
				and(
					eq(narratorToolContinuations.toolCallId, toolCallId),
					eq(narratorToolContinuations.updateEpoch, updateEpoch),
					eq(narratorToolContinuations.kind, "deferred_tool"),
					inArray(narratorToolContinuations.state, CLAIMABLE_STATES),
					isNull(narratorToolContinuations.claimToken),
					sql`json_extract(${narratorToolContinuations.payloadJson}, '$.recoveryPhase') IS NULL`,
				),
			)
			.returning({ id: narratorToolContinuations.id });
		return rows.length === 1;
	},

	async cancelEpoch(updateEpoch: string, errorMessage?: string): Promise<number> {
		normalizeEpochScope(updateEpoch);
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
					epochCondition(updateEpoch),
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

	async hasUnfinishedForMessage(messageId: string, updateEpoch: EpochScope): Promise<boolean> {
		normalizeEpochScope(updateEpoch);
		const rows = await listMessageContinuations(messageId, updateEpoch);
		return rows.some((row) => !isToolContinuationOwnerMounted(row));
	},
};
