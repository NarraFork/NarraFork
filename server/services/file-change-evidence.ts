import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeActor,
	type FileChangeExecutionBinding,
	type FileChangeExecutionOutcome,
	type FileChangeExecutionReceipt,
	type FileChangeIdentity,
	type FileChangeMutationPhase,
	type FileChangeSettlement,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { and, asc, eq, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { db } from "../db";
import {
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	fileChangeStorageBudgets,
	fileHistoryClock,
	narratorToolCalls,
} from "../db/schema";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import {
	createFileChangeIdentity,
	type FileChangeScopeIdentity,
	fileChangeExecutionBindingMatches,
	fileChangeIdentityKey,
} from "./file-change-identity";

/** Scheduling/transaction granularity, not permission to truncate a larger operation. */
export const FILE_CHANGE_PREPARE_BATCH_ITEMS = 32;

type EvidenceDatabase = Pick<typeof db, "select" | "insert" | "update" | "transaction" | "$client">;
type Executor = Pick<EvidenceDatabase, "select" | "insert" | "update">;
export type FileChangeScopeRecord = typeof fileChangeScopes.$inferSelect;
export type FileChangeOperationRecord = typeof fileChangeOperations.$inferSelect;
export type FileChangeEffectRecord = typeof fileChangeEffects.$inferSelect;
type PendingSettlement = Exclude<FileChangeSettlement, "settled">;

export interface PrepareFileChangeScope extends Omit<FileChangeScopeIdentity, "id"> {
	id?: string;
	displayRoot?: string;
}

export interface BeginFileChangeOperation {
	sourceInstanceId: string;
	sourceKind: FileChangeOperationRecord["sourceKind"];
	/** Stable actual tool-call/request/task identity, never just a provider toolUseId. */
	sourceId: string;
	attempt: number;
	/** Caller hashes the complete, fixed request/target set, not a sampled prefix. */
	requestDigest: string;
	expectedEffectCount: number;
	actor: FileChangeActor;
	executionBinding: FileChangeExecutionBinding;
	toolCallId?: string | null;
	toolUseId?: string | null;
	backgroundTaskId?: string | null;
	narratorId?: string | null;
	projectId?: string | null;
	ownerUserId?: string | null;
	initiatorSubjectKey?: string | null;
	parentOperationId?: string | null;
	executionSegmentId?: string | null;
}

export interface FileChangeNoDispatchProof {
	/** Trusted IO caller assertion, never derived from an error status or matching bytes. */
	targetDispatched: false;
	reason: "validation_rejected" | "cancelled_before_dispatch";
}

export interface PrepareFileChangeEffect {
	identity: FileChangeIdentity;
	scopeRevision: number;
	requestDigest: string;
	phase?: FileChangeMutationPhase;
	before: FileChangeState;
	intendedAfter: FileChangeState;
}

export interface FileChangeEffectSelector {
	operationId: string;
	mutationId: string;
	requestDigest: string;
}

export interface SettleFileChangeEffect extends FileChangeEffectSelector {
	/** Only the authorized execution backend may supply an immutable durable receipt. */
	receipt: FileChangeExecutionReceipt | null;
	/** Omission uses the receipt's own observation, or explicit unknown when no receipt exists. */
	observedAfter?: FileChangeState;
	/** A coordinator may lower confidence; this can never upgrade an unverified receipt. */
	attributionCeiling?: "measured" | "observed_ambiguous" | "unknown";
	linesAdded?: number | null;
	linesRemoved?: number | null;
}

export interface FileChangeOperationCursor {
	updatedAt: string;
	id: string;
}

export interface FileChangeEffectCursor {
	fileKey: string;
	phase: FileChangeMutationPhase;
}

export interface FileChangeEvidencePage<T, C> {
	items: T[];
	hasMore: boolean;
	nextCursor: C | null;
}

export class FileChangeEvidenceError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `FILE_CHANGE_${code}`);
		this.name = "FileChangeEvidenceError";
	}
}

/**
 * Internal metadata journal; importing it does not open a DB or enable tool writes.
 *
 * ALL methods require the caller to authorize the owning operation/scope/project/device.
 * IDs/digests are not capabilities. Recovery inventory is for trusted maintenance, not a
 * public cross-project endpoint. This service never reads file bodies or writes files.
 *
 * The caller owns backend verification, the workspace coordinator, durable raw publication,
 * and the DB's durability configuration. Inject a ROOT connection: ambient transactions
 * are refused because releasing a savepoint does not make an intent durable. intent_durable
 * means a committed journal under that configuration; it does not upgrade SQLite
 * synchronous=NORMAL to power-loss fsync. Never acknowledge/delete a backend receipt until
 * settleEffect's transaction succeeds. Provisional backend queries should pass receipt:null;
 * any supplied receipt (including unconfirmed ones) is preserved immutably, not overwritten.
 */
export class FileChangeEvidenceService {
	constructor(
		private readonly database: EvidenceDatabase,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		if (!database.$client)
			throw fail("DURABILITY_BOUNDARY", "A root SQLite connection is required");
	}

	private transaction<T>(work: (tx: Executor) => T): T {
		if (this.database.$client.inTransaction) {
			throw fail(
				"DURABILITY_BOUNDARY",
				"Evidence journal writes cannot run in an ambient transaction",
			);
		}
		return this.database.transaction(work);
	}

	prepareScope(input: PrepareFileChangeScope): FileChangeScopeRecord {
		const values = normalizeScope(input);
		return this.transaction((tx) => {
			const existing = tx
				.select()
				.from(fileChangeScopes)
				.where(
					and(
						eq(fileChangeScopes.sourceInstanceId, values.sourceInstanceId),
						eq(fileChangeScopes.deviceId, values.deviceId),
						eq(fileChangeScopes.workspaceInstanceId, values.workspaceInstanceId),
					),
				)
				.get();
			if (existing) {
				if (
					(input.id !== undefined && input.id !== existing.id) ||
					existing.pathFlavor !== values.pathFlavor ||
					!targetPathSemantics(values.pathFlavor).equals(
						existing.canonicalRoot,
						values.canonicalRoot,
					)
				) {
					throw fail(
						"IDENTITY_CONFLICT",
						"A workspace instance cannot change its root or identity",
					);
				}
				return existing;
			}
			const timestamp = this.now();
			const row = {
				...values,
				id: input.id ?? generateId(),
				status: "needs_verification" as const,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			assertMetadata(row);
			return boundedRecord(tx.insert(fileChangeScopes).values(row).returning().get());
		});
	}

	/** Records verification already performed by an authorized backend; does not perform it. */
	recordScopeVerification(input: {
		scopeId: string;
		canonicalRoot: string;
		rootIdentity: Record<string, string>;
	}): FileChangeScopeRecord {
		assertString(input.scopeId, "scopeId");
		assertString(input.canonicalRoot, "canonicalRoot", FILE_CHANGE_LIMITS.metadataBytes);
		const entries = Object.entries(input.rootIdentity);
		if (!entries.length || entries.length > 32)
			throw fail("INVALID_INPUT", "Invalid root identity");
		for (const [key, value] of entries) {
			assertString(key, "root identity key");
			assertString(value, "root identity value");
		}
		assertMetadata(input);
		return this.transaction((tx) => {
			const scope = requireScope(tx, input.scopeId);
			if (
				scope.activeLeaseId !== null ||
				scope.activeMutationCount > 0 ||
				(scope.status === "needs_verification" && scope.rootIdentityJson !== null)
			) {
				throw fail(
					"TARGET_UNVERIFIED",
					"Active or unsettled writes require recovery; root-path verification cannot clear their barrier",
				);
			}
			if (
				scope.status === "retired" ||
				!targetPathSemantics(scope.pathFlavor).equals(scope.canonicalRoot, input.canonicalRoot) ||
				(scope.rootIdentityJson !== null && !jsonEqual(scope.rootIdentityJson, input.rootIdentity))
			) {
				throw fail(
					"IDENTITY_CONFLICT",
					"A retired or changed root requires a new workspace instance",
				);
			}
			return boundedRecord(
				tx
					.update(fileChangeScopes)
					.set({ status: "active", rootIdentityJson: input.rootIdentity, updatedAt: this.now() })
					.where(eq(fileChangeScopes.id, scope.id))
					.returning()
					.get(),
			);
		});
	}

	/**
	 * Only the trusted Write/Edit driver may attest that it has dispatched NO target IO.
	 * This is not recovery: an existing ordinary intent/effect can never be rewritten as
	 * zero effects. The actual row binding and proof are committed together, without
	 * inventing before/after bytes or a backend receipt. Standard preparation still
	 * requires at least one effect; this terminal record can never authorize execution.
	 */
	beginNoDispatchOperation(
		input: BeginFileChangeOperation,
		proof: FileChangeNoDispatchProof,
	): FileChangeOperationRecord {
		if (
			proof.targetDispatched !== false ||
			!["validation_rejected", "cancelled_before_dispatch"].includes(proof.reason) ||
			input.sourceKind !== "tool" ||
			!input.toolCallId ||
			input.sourceId !== input.toolCallId ||
			input.expectedEffectCount !== 1 ||
			!input.narratorId ||
			input.actor.narratorId !== input.narratorId ||
			!["primary", "subagent"].includes(input.actor.kind)
		) {
			throw fail(
				"INVALID_INPUT",
				"A bound file-tool attempt and explicit no-dispatch proof are required",
			);
		}
		const values = { ...normalizeOperation(input), expectedEffectCount: 0 };
		const terminal = {
			executionOutcome:
				proof.reason === "cancelled_before_dispatch"
					? ("interrupted" as const)
					: ("failed" as const),
			effectOutcome: "no_change" as const,
			settlement: "settled" as const,
			coverage: "complete" as const,
			attributionGrade: "unknown" as const,
			preparedEffectCount: 0,
			settledEffectCount: 0,
			unresolvedEffectCount: 0,
			evidenceBytes: 0,
			reason: `no_dispatch:${proof.reason}`,
		};
		return this.transaction((tx) => {
			const tool = tx
				.select({
					id: narratorToolCalls.id,
					narratorId: narratorToolCalls.narratorId,
					toolUseId: narratorToolCalls.toolUseId,
					toolName: narratorToolCalls.toolName,
					version: narratorToolCalls.executionIdentityVersion,
					origin: narratorToolCalls.executionOriginToolCallId,
					checkpoint: narratorToolCalls.isFileHistoryCheckpoint,
					attempt: narratorToolCalls.executionAttempt,
					status: narratorToolCalls.status,
					startedAt: narratorToolCalls.executionStartedAt,
					deviceId: narratorToolCalls.executionDeviceId,
					generation: narratorToolCalls.runtimeGeneration,
					operationId: narratorToolCalls.fileChangeOperationId,
				})
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, values.sourceId))
				.get();
			if (
				!tool ||
				tool.version !== 1 ||
				tool.origin !== null ||
				tool.checkpoint ||
				tool.attempt !== values.attempt ||
				tool.narratorId !== values.narratorId ||
				tool.toolUseId !== values.toolUseId ||
				!["Write", "Edit"].includes(tool.toolName) ||
				tool.deviceId !== input.executionBinding.deviceId ||
				tool.generation !== input.executionBinding.runtimeGeneration
			) {
				throw fail(
					"IDENTITY_CONFLICT",
					"No-dispatch proof does not match an actual frozen file-tool attempt",
				);
			}
			const existing = tx
				.select()
				.from(fileChangeOperations)
				.where(
					and(
						eq(fileChangeOperations.sourceInstanceId, values.sourceInstanceId),
						eq(fileChangeOperations.sourceKind, values.sourceKind),
						eq(fileChangeOperations.sourceId, values.sourceId),
						eq(fileChangeOperations.attempt, values.attempt),
					),
				)
				.get();
			if (existing) {
				const expected = { ...values, ...terminal };
				if (
					tool.operationId !== existing.id ||
					!Object.entries(expected).every(([key, value]) =>
						jsonEqual(existing[key as keyof FileChangeOperationRecord], value),
					) ||
					tx
						.select({ id: fileChangeEffects.id })
						.from(fileChangeEffects)
						.where(eq(fileChangeEffects.operationId, existing.id))
						.limit(1)
						.get()
				) {
					throw fail(
						"REQUEST_CONFLICT",
						"An existing execution attempt cannot become a no-dispatch operation",
					);
				}
				return existing;
			}
			if (tool.operationId !== null || tool.status !== "running" || tool.startedAt === null) {
				throw fail(
					"INVALID_TRANSITION",
					"No-dispatch evidence must be recorded by the live claimed tool attempt",
				);
			}
			const timestamp = this.now();
			const row = {
				...values,
				...terminal,
				id: generateId(),
				startedAt: timestamp,
				finishedAt: timestamp,
				updatedAt: timestamp,
			};
			assertMetadata(row);
			const recorded = boundedRecord(tx.insert(fileChangeOperations).values(row).returning().get());
			const linked = tx
				.update(narratorToolCalls)
				.set({ fileChangeOperationId: recorded.id })
				.where(
					and(
						eq(narratorToolCalls.id, tool.id),
						eq(narratorToolCalls.executionAttempt, values.attempt),
						isNull(narratorToolCalls.fileChangeOperationId),
					),
				)
				.returning({ id: narratorToolCalls.id })
				.get();
			if (!linked)
				throw fail("REQUEST_CONFLICT", "Tool attempt was already linked to other evidence");
			return recorded;
		});
	}

	beginOperation(input: BeginFileChangeOperation): FileChangeOperationRecord {
		const values = normalizeOperation(input);
		return this.transaction((tx) => {
			const existing = tx
				.select()
				.from(fileChangeOperations)
				.where(
					and(
						eq(fileChangeOperations.sourceInstanceId, values.sourceInstanceId),
						eq(fileChangeOperations.sourceKind, values.sourceKind),
						eq(fileChangeOperations.sourceId, values.sourceId),
						eq(fileChangeOperations.attempt, values.attempt),
					),
				)
				.get();
			if (existing) {
				for (const key of Object.keys(values) as (keyof typeof values)[]) {
					if (!jsonEqual(existing[key], values[key])) {
						throw fail(
							"REQUEST_CONFLICT",
							"An execution attempt cannot change its request or actor",
						);
					}
				}
				return existing;
			}
			const timestamp = this.now();
			tx.insert(fileHistoryClock).values({ id: 1, lastSeq: 0 }).onConflictDoNothing().run();
			const clock = tx
				.update(fileHistoryClock)
				.set({ lastSeq: sql`${fileHistoryClock.lastSeq} + 1` })
				.where(eq(fileHistoryClock.id, 1))
				.returning({ lastSeq: fileHistoryClock.lastSeq })
				.get();
			if (!clock) throw fail("JOURNAL_UNAVAILABLE", "File history clock is not initialized");
			const row = {
				...values,
				id: generateId(),
				journalSeq: clock.lastSeq,
				startedAt: timestamp,
				updatedAt: timestamp,
			};
			assertMetadata(row);
			return boundedRecord(tx.insert(fileChangeOperations).values(row).returning().get());
		});
	}

	/**
	 * At most 32 effects per synchronous transaction. Repeating the exact batch is safe;
	 * adding/replacing targets after the declared count is reached is not. A partial batch
	 * never makes the operation executable, and failed batches roll back refs AND counters.
	 */
	prepareEffects(operationId: string, inputs: PrepareFileChangeEffect[]): FileChangeEffectRecord[] {
		assertString(operationId, "operationId");
		assertInteger(inputs.length, "batch size", 1, FILE_CHANGE_PREPARE_BATCH_ITEMS);
		const normalized = inputs.map(normalizeEffect);
		return this.transaction((tx) => {
			const initialOperation = requireOperation(tx, operationId);
			assertJournal(initialOperation);
			let operation = initialOperation;
			const results: FileChangeEffectRecord[] = [];
			for (const input of normalized) {
				const mutationId = mutationKey(operation, input.fileKey, input.phase);
				const values = {
					operationId,
					scopeId: input.identity.scopeId,
					fileKey: input.fileKey,
					identityJson: input.identity,
					scopeRevision: input.scopeRevision,
					mutationId,
					requestDigest: input.requestDigest,
					phase: input.phase,
					beforeStateJson: input.before,
					intendedAfterStateJson: input.intendedAfter,
					beforeBlobDigest: stateBlob(input.before)?.digest ?? null,
					intendedAfterBlobDigest: stateBlob(input.intendedAfter)?.digest ?? null,
				};
				const existing = tx
					.select()
					.from(fileChangeEffects)
					.where(eq(fileChangeEffects.mutationId, mutationId))
					.get();
				if (existing) {
					for (const key of Object.keys(values) as (keyof typeof values)[]) {
						if (!jsonEqual(existing[key], values[key])) {
							throw fail("REQUEST_CONFLICT", "A mutation cannot change its prepared evidence");
						}
					}
					results.push(existing);
					continue;
				}
				if (operation.settlement !== "preparing" || operation.executionOutcome !== "running") {
					throw fail("INVALID_TRANSITION", "Only a preparing operation may add effects");
				}
				if (operation.preparedEffectCount >= operation.expectedEffectCount) {
					throw fail("INCOMPLETE_SET", "Effects exceed the fixed declared target set");
				}
				assertEffectScope(tx, operation, input.identity, input.scopeRevision, false);
				assertReadyStates(tx, [input.before, input.intendedAfter]);
				// Deliberately count each referenced before+intended size, without global dedup/SUM.
				const evidenceBytes =
					operation.evidenceBytes + stateBytes(input.before) + stateBytes(input.intendedAfter);
				assertEvidenceBudget(evidenceBytes);
				const timestamp = this.now();
				const row = {
					...values,
					journalSeq: operation.journalSeq,
					id: generateId(),
					observedAfterStateJson: unknownAfter(),
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				assertMetadata(row);
				results.push(boundedRecord(tx.insert(fileChangeEffects).values(row).returning().get()));
				operation = tx
					.update(fileChangeOperations)
					.set({
						preparedEffectCount: operation.preparedEffectCount + 1,
						evidenceBytes,
						updatedAt: timestamp,
					})
					.where(eq(fileChangeOperations.id, operationId))
					.returning()
					.get() as typeof operation;
			}
			return results;
		});
	}

	/** Convenience for a fully enumerated set; still yields between bounded transactions. */
	async prepareOperation(
		input: BeginFileChangeOperation & { effects: PrepareFileChangeEffect[] },
		options: { signal?: AbortSignal } = {},
	): Promise<FileChangeOperationRecord> {
		options.signal?.throwIfAborted();
		assertInteger(input.effects.length, "effects length", 1, FILE_CHANGE_LIMITS.revertFiles);
		if (input.effects.length !== input.expectedEffectCount)
			throw fail("INCOMPLETE_SET", "Expected effect count does not match the complete input");
		// Reject the whole over-budget request before persisting a prefix.
		let bytes = 0;
		const keys = new Set<string>();
		const effects: PrepareFileChangeEffect[] = [];
		for (const raw of input.effects) {
			const effect = normalizeEffect(raw);
			const key = `${effect.fileKey}:${effect.phase}`;
			if (keys.has(key)) throw fail("REQUEST_CONFLICT", "The fixed effect set contains duplicates");
			keys.add(key);
			effects.push(effect);
			bytes += stateBytes(effect.before) + stateBytes(effect.intendedAfter);
			assertEvidenceBudget(bytes);
		}
		options.signal?.throwIfAborted();
		const operation = this.beginOperation(input);
		for (let offset = 0; offset < effects.length; offset += FILE_CHANGE_PREPARE_BATCH_ITEMS) {
			options.signal?.throwIfAborted();
			this.prepareEffects(
				operation.id,
				effects.slice(offset, offset + FILE_CHANGE_PREPARE_BATCH_ITEMS),
			);
			await yieldToEventLoop();
		}
		return this.finalizePreparation(operation.id, options);
	}

	/**
	 * An effect's durable flag can be committed a page at a time, but the OPERATION remains
	 * preparing until every page is durable. markApplying always checks both gates. Restart
	 * may repeat this method; no in-memory progress is required and no file action is replayed.
	 */
	async finalizePreparation(
		operationId: string,
		options: { signal?: AbortSignal } = {},
	): Promise<FileChangeOperationRecord> {
		assertString(operationId, "operationId");
		let cursor: FileChangeEffectCursor | undefined;
		let verifiedEffectCount = 0;
		for (;;) {
			options.signal?.throwIfAborted();
			const page = this.transaction((tx) => {
				const operation = requireOperation(tx, operationId);
				assertJournal(operation);
				if (operation.settlement !== "preparing") return null;
				if (
					operation.executionOutcome !== "running" ||
					operation.preparedEffectCount !== operation.expectedEffectCount
				) {
					throw fail(
						"INCOMPLETE_SET",
						"Every declared effect must be prepared before intent becomes durable",
					);
				}
				const effects = selectEffects(tx, operationId, cursor, FILE_CHANGE_PREPARE_BATCH_ITEMS);
				for (const effect of effects) {
					if (effect.settlement !== "preparing" && effect.settlement !== "intent_durable") {
						throw fail("INVALID_TRANSITION", "A preparing operation contains an attempted effect");
					}
					assertEffectScope(tx, operation, effect.identityJson, effect.scopeRevision, true);
					assertKnownPreparedStates(effect);
					assertReadyStates(tx, [effect.beforeStateJson, effect.intendedAfterStateJson]);
					tx.update(fileChangeEffects)
						.set({ settlement: "intent_durable", updatedAt: this.now() })
						.where(eq(fileChangeEffects.id, effect.id))
						.run();
				}
				return effects;
			});
			const last = page?.at(-1);
			if (!last || !page) break;
			verifiedEffectCount += page.length;
			assertInteger(verifiedEffectCount, "verified effects", 0, FILE_CHANGE_LIMITS.revertFiles);
			cursor = effectCursor(last);
			await yieldToEventLoop();
		}
		options.signal?.throwIfAborted();
		return this.transaction((tx) => {
			const operation = requireOperation(tx, operationId);
			assertJournal(operation);
			if (operation.settlement !== "preparing") return operation;
			if (
				operation.executionOutcome !== "running" ||
				operation.preparedEffectCount !== operation.expectedEffectCount ||
				verifiedEffectCount !== operation.expectedEffectCount ||
				effectExists(tx, operationId, ne(fileChangeEffects.settlement, "intent_durable"))
			) {
				throw fail("INCOMPLETE_SET", "The operation's complete intent is not durable");
			}
			return tx
				.update(fileChangeOperations)
				.set({ settlement: "intent_durable", coverage: "complete", updatedAt: this.now() })
				.where(eq(fileChangeOperations.id, operationId))
				.returning()
				.get();
		});
	}

	/**
	 * Only the first successful durable transition grants mayExecute=true. A retry after
	 * response loss returns false: query the backend's receipt, never blindly write again.
	 * The caller must still hold the coordinator and validate live target/content guards.
	 */
	markApplying(
		input: FileChangeEffectSelector & { executionBinding: FileChangeExecutionBinding },
	): {
		effect: FileChangeEffectRecord;
		mayExecute: boolean;
	} {
		validateSelector(input);
		const binding = normalizeBinding(input.executionBinding);
		return this.transaction((tx) => {
			const operation = requireOperation(tx, input.operationId);
			assertJournal(operation);
			const effect = requireEffect(tx, input);
			if (!fileChangeExecutionBindingMatches(operation.executionBindingJson, binding))
				throw fail("STALE_BINDING", "Execution binding changed after preparation");
			if (["applying", "settled", "reconcile_required"].includes(effect.settlement)) {
				return { effect, mayExecute: false };
			}
			if (
				(operation.settlement !== "intent_durable" && operation.settlement !== "applying") ||
				operation.executionOutcome !== "running" ||
				effect.settlement !== "intent_durable"
			) {
				throw fail(
					"INVALID_TRANSITION",
					"The complete operation intent must be durable before applying",
				);
			}
			assertEffectScope(tx, operation, effect.identityJson, effect.scopeRevision, true);
			assertKnownPreparedStates(effect);
			assertReadyStates(tx, [effect.beforeStateJson, effect.intendedAfterStateJson]);
			const timestamp = this.now();
			tx.update(fileChangeOperations)
				.set({ settlement: "applying", updatedAt: timestamp })
				.where(eq(fileChangeOperations.id, operation.id))
				.run();
			const applied = tx
				.update(fileChangeEffects)
				.set({ settlement: "applying", updatedAt: timestamp })
				.where(eq(fileChangeEffects.id, effect.id))
				.returning()
				.get();
			return { effect: applied, mayExecute: true };
		});
	}

	settleEffect(input: SettleFileChangeEffect): FileChangeEffectRecord {
		validateSelector(input);
		const receipt = input.receipt === null ? null : normalizeReceipt(input.receipt);
		const observedAfter = normalizeState(
			input.observedAfter === undefined
				? (receipt?.observedAfter ?? unknownAfter())
				: input.observedAfter,
		);
		const linesAdded = nullableLines(input.linesAdded);
		const linesRemoved = nullableLines(input.linesRemoved);
		const requestedCeiling = input.attributionCeiling;
		if (
			requestedCeiling !== undefined &&
			!["measured", "observed_ambiguous", "unknown"].includes(requestedCeiling)
		) {
			throw fail("INVALID_INPUT", "Invalid attribution confidence ceiling");
		}
		if (receipt && !jsonEqual(receipt.observedAfter, observedAfter)) {
			throw fail("RECEIPT_CONFLICT", "The observed state must be the receipt's own observation");
		}
		const receiptDigest = receipt === null ? null : digest(receipt);
		return this.transaction((tx) => {
			const operation = requireOperation(tx, input.operationId);
			assertJournal(operation);
			const effect = requireEffect(tx, input);
			if (
				receipt &&
				(receipt.mutationId !== effect.mutationId ||
					receipt.requestDigest !== effect.requestDigest ||
					!fileChangeExecutionBindingMatches(
						operation.executionBindingJson,
						receipt.executionBinding,
					))
			) {
				throw fail("RECEIPT_CONFLICT", "Receipt identity does not match the durable intent");
			}
			const attributionCeiling = settlementAttributionCeiling(effect, requestedCeiling);
			const noChange = fileChangeStatesEqual(effect.beforeStateJson, observedAfter);
			const executionConfirmed = !!receipt?.confirmed && receipt.outcome !== "unknown";
			const confirmedNotApplied = executionConfirmed && receipt?.outcome === "not_applied";
			const measured =
				executionConfirmed &&
				receipt?.outcome === "applied" &&
				effect.beforeStateJson.kind !== "unknown" &&
				fileChangeStatesEqual(effect.intendedAfterStateJson, observedAfter);
			const resolved = measured || confirmedNotApplied;
			// The caller samples this ceiling once at the end of actual file IO,
			// before the first settlement. Later activity cannot reopen this evidence;
			// the immutable receipt/derived-value comparison below remains mandatory.
			const attributionGrade =
				attributionCeiling === "unknown"
					? "unknown"
					: measured && attributionCeiling === "measured"
						? "measured"
						: observedAfter.kind === "unknown"
							? "unknown"
							: "observed_ambiguous";
			// not_applied is evidence about THIS mutation, not about a before→observation delta.
			const outcome =
				confirmedNotApplied || (measured && noChange)
					? "no_change"
					: measured
						? "changed"
						: "unknown";
			const values = {
				observedAfterStateJson: observedAfter,
				observedAfterBlobDigest: stateBlob(observedAfter)?.digest ?? null,
				executionReceiptJson: receipt,
				executionReceiptDigest: receiptDigest,
				executionConfirmed,
				outcome,
				attributionGrade,
				// Existing pre-column receipts stay byte-for-byte/field-for-field frozen.
				attributionCeiling:
					effect.executionReceiptDigest !== null && effect.attributionCeiling === null
						? null
						: attributionCeiling,
				settlement: resolved ? ("settled" as const) : ("reconcile_required" as const),
				linesAdded: confirmedNotApplied
					? 0
					: attributionGrade === "measured"
						? noChange
							? 0
							: linesAdded
						: null,
				linesRemoved: confirmedNotApplied
					? 0
					: attributionGrade === "measured"
						? noChange
							? 0
							: linesRemoved
						: null,
			} satisfies Partial<FileChangeEffectRecord>;
			if (effect.executionReceiptDigest !== null) {
				if (
					effect.executionReceiptDigest !== receiptDigest ||
					!Object.entries(values).every(([key, value]) =>
						jsonEqual(effect[key as keyof FileChangeEffectRecord], value),
					)
				) {
					throw fail(
						"RECEIPT_CONFLICT",
						"An existing receipt or its evidence cannot be overwritten",
					);
				}
				return effect;
			}
			if (effect.settlement !== "applying" && effect.settlement !== "reconcile_required") {
				throw fail("INVALID_TRANSITION", "Only an attempted effect can receive execution evidence");
			}
			if (
				effect.observedAfterStateJson.kind !== "unknown" &&
				!jsonEqual(effect.observedAfterStateJson, observedAfter)
			) {
				throw fail("RECEIPT_CONFLICT", "A previously recorded observation cannot be overwritten");
			}
			assertReadyStates(tx, [effect.beforeStateJson, effect.intendedAfterStateJson, observedAfter]);
			const newObservedBytes =
				effect.observedAfterStateJson.kind === "unknown" &&
				!fileChangeStatesEqual(effect.intendedAfterStateJson, observedAfter)
					? stateBytes(observedAfter)
					: 0;
			const evidenceBytes = operation.evidenceBytes + newObservedBytes;
			assertEvidenceBudget(evidenceBytes);
			assertMetadata({ ...effect, ...values });
			const timestamp = this.now();
			const settled = tx
				.update(fileChangeEffects)
				.set({ ...values, updatedAt: timestamp })
				.where(eq(fileChangeEffects.id, effect.id))
				.returning()
				.get();
			const updated = {
				...operation,
				evidenceBytes,
				settledEffectCount: operation.settledEffectCount + (resolved ? 1 : 0),
				unresolvedEffectCount:
					operation.unresolvedEffectCount +
					(resolved ? 0 : 1) -
					(effect.settlement === "reconcile_required" ? 1 : 0),
			};
			const aggregate = operationAggregate(tx, updated);
			tx.update(fileChangeOperations)
				.set({
					...aggregate,
					evidenceBytes,
					settledEffectCount: updated.settledEffectCount,
					unresolvedEffectCount: updated.unresolvedEffectCount,
					updatedAt: timestamp,
				})
				.where(eq(fileChangeOperations.id, operation.id))
				.run();
			return settled;
		});
	}

	/** Tool/process outcome is separate from actual file effects, including failed-but-written. */
	finishOperation(
		operationId: string,
		outcome: Exclude<FileChangeExecutionOutcome, "running">,
	): FileChangeOperationRecord {
		assertString(operationId, "operationId");
		if (!["succeeded", "failed", "interrupted"].includes(outcome))
			throw fail("INVALID_INPUT", "A terminal execution outcome is required");
		return this.transaction((tx) => {
			const operation = requireOperation(tx, operationId);
			assertJournal(operation);
			if (operation.executionOutcome !== "running") {
				if (operation.executionOutcome !== outcome)
					throw fail("REQUEST_CONFLICT", "A terminal execution outcome is immutable");
				return operation;
			}
			const updated = { ...operation, executionOutcome: outcome };
			return tx
				.update(fileChangeOperations)
				.set({
					...operationAggregate(tx, updated),
					executionOutcome: outcome,
					finishedAt: this.now(),
					updatedAt: this.now(),
				})
				.where(eq(fileChangeOperations.id, operationId))
				.returning()
				.get();
		});
	}

	/** Authorized owning-resource lookup, not authorization by identifier. */
	getScope(scopeId: string): FileChangeScopeRecord | null {
		assertString(scopeId, "scopeId");
		return (
			this.database.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, scopeId)).get() ??
			null
		);
	}

	getOperation(operationId: string): FileChangeOperationRecord | null {
		assertString(operationId, "operationId");
		return (
			this.database
				.select()
				.from(fileChangeOperations)
				.where(eq(fileChangeOperations.id, operationId))
				.get() ?? null
		);
	}

	getEffect(operationId: string, mutationId: string): FileChangeEffectRecord | null {
		assertString(operationId, "operationId");
		assertString(mutationId, "mutationId");
		return (
			this.database
				.select()
				.from(fileChangeEffects)
				.where(
					and(
						eq(fileChangeEffects.operationId, operationId),
						eq(fileChangeEffects.mutationId, mutationId),
					),
				)
				.get() ?? null
		);
	}

	listEffects(
		operationId: string,
		options: { cursor?: FileChangeEffectCursor; limit?: number } = {},
	): FileChangeEvidencePage<FileChangeEffectRecord, FileChangeEffectCursor> {
		assertString(operationId, "operationId");
		const limit = pageLimit(options.limit);
		validateEffectCursor(options.cursor);
		return boundedPage(
			selectEffects(this.database, operationId, options.cursor, limit + 1),
			limit,
			effectCursor,
		);
	}

	/**
	 * One indexed state at a time (call for all four pending states during recovery).
	 * Tuple cursors seek inside the compound index; an OR expansion only constrains
	 * settlement in SQLite's plan and would rescan the entire already-seen prefix.
	 * Includes incomplete preparation, committed intent, applying, and unresolved receipts;
	 * no lease expiry deletes a row or implies not_applied. Empty pages are not file evidence.
	 */
	listPendingOperations(options: {
		settlement: PendingSettlement;
		cursor?: FileChangeOperationCursor;
		limit?: number;
	}) {
		if (
			!["preparing", "intent_durable", "applying", "reconcile_required"].includes(
				options.settlement,
			)
		)
			throw fail("INVALID_INPUT", "A single pending settlement state is required");
		const limit = pageLimit(options.limit);
		if (options.cursor) {
			assertString(options.cursor.id, "cursor id");
			assertString(options.cursor.updatedAt, "cursor timestamp", 64);
		}
		const c = options.cursor;
		const rows = this.database
			.select({
				id: fileChangeOperations.id,
				sourceInstanceId: fileChangeOperations.sourceInstanceId,
				sourceKind: fileChangeOperations.sourceKind,
				sourceId: fileChangeOperations.sourceId,
				attempt: fileChangeOperations.attempt,
				requestDigest: fileChangeOperations.requestDigest,
				projectId: fileChangeOperations.projectId,
				narratorId: fileChangeOperations.narratorId,
				ownerUserId: fileChangeOperations.ownerUserId,
				expectedEffectCount: fileChangeOperations.expectedEffectCount,
				preparedEffectCount: fileChangeOperations.preparedEffectCount,
				settledEffectCount: fileChangeOperations.settledEffectCount,
				unresolvedEffectCount: fileChangeOperations.unresolvedEffectCount,
				evidenceBytes: fileChangeOperations.evidenceBytes,
				settlement: fileChangeOperations.settlement,
				executionOutcome: fileChangeOperations.executionOutcome,
				effectOutcome: fileChangeOperations.effectOutcome,
				coverage: fileChangeOperations.coverage,
				attributionGrade: fileChangeOperations.attributionGrade,
				reason: fileChangeOperations.reason,
				updatedAt: fileChangeOperations.updatedAt,
			})
			.from(fileChangeOperations)
			.where(
				and(
					eq(fileChangeOperations.settlement, options.settlement),
					c
						? sql`(${fileChangeOperations.updatedAt}, ${fileChangeOperations.id}) > (${c.updatedAt}, ${c.id})`
						: undefined,
				),
			)
			.orderBy(asc(fileChangeOperations.updatedAt), asc(fileChangeOperations.id))
			.limit(limit + 1)
			.all();
		return boundedPage(rows, limit, (row) => ({ updatedAt: row.updatedAt, id: row.id }));
	}
}

function settlementAttributionCeiling(
	effect: FileChangeEffectRecord,
	requested: SettleFileChangeEffect["attributionCeiling"],
): NonNullable<FileChangeEffectRecord["attributionCeiling"]> {
	// A provisional observation may be resolved by a later durable receipt, but a
	// lost in-memory activity flag must not upgrade its previously recorded ceiling.
	const stored =
		effect.attributionCeiling ??
		(effect.executionReceiptDigest !== null || effect.settlement === "reconcile_required"
			? effect.attributionGrade
			: "measured");
	const rank = { unknown: 0, observed_ambiguous: 1, measured: 2 } as const;
	if (!Object.hasOwn(rank, stored)) {
		throw fail("RECEIPT_CONFLICT", "An unrecognized attribution ceiling cannot be overwritten");
	}
	if (requested !== undefined && rank[requested] > rank[stored]) {
		throw fail(
			"RECEIPT_CONFLICT",
			"A recorded attribution ceiling cannot be overwritten with higher confidence",
		);
	}
	// Once a receipt exists, settleEffect still compares ALL derived values and
	// rejects a lower ceiling too. Only unfrozen reconciliation may reduce it.
	return requested ?? stored;
}

function operationAggregate(
	tx: Executor,
	operation: FileChangeOperationRecord,
): Pick<
	FileChangeOperationRecord,
	"settlement" | "effectOutcome" | "attributionGrade" | "coverage" | "reason"
> {
	const complete =
		operation.expectedEffectCount !== null &&
		operation.preparedEffectCount === operation.expectedEffectCount;
	const allSettled = complete && operation.settledEffectCount === operation.expectedEffectCount;
	const ambiguous = effectExists(
		tx,
		operation.id,
		eq(fileChangeEffects.attributionGrade, "observed_ambiguous"),
	);
	const unmeasured = effectExists(
		tx,
		operation.id,
		ne(fileChangeEffects.attributionGrade, "measured"),
	);
	const changed = effectExists(tx, operation.id, eq(fileChangeEffects.outcome, "changed"));
	const terminal = operation.executionOutcome !== "running";
	const unresolved = operation.unresolvedEffectCount > 0 || (terminal && !allSettled);
	return {
		settlement:
			allSettled && terminal
				? "settled"
				: operation.settlement === "preparing"
					? "preparing"
					: unresolved
						? "reconcile_required"
						: "applying",
		effectOutcome: unresolved
			? "unknown"
			: allSettled
				? changed
					? "changed"
					: "no_change"
				: "pending",
		attributionGrade:
			allSettled && !unmeasured ? "measured" : ambiguous ? "observed_ambiguous" : "unknown",
		coverage: allSettled
			? "complete"
			: unresolved
				? "partial"
				: complete
					? "complete"
					: "unavailable",
		reason: unresolved ? "result_unknown" : null,
	};
}

function normalizeScope(input: PrepareFileChangeScope) {
	for (const key of ["sourceInstanceId", "deviceId", "workspaceInstanceId"] as const)
		assertString(input[key], key);
	if (input.id !== undefined) assertString(input.id, "scopeId");
	if (input.pathFlavor !== "posix" && input.pathFlavor !== "windows")
		throw fail("INVALID_INPUT", "Explicit disk path flavor required");
	assertString(input.canonicalRoot, "canonicalRoot", FILE_CHANGE_LIMITS.metadataBytes);
	const paths = targetPathSemantics(input.pathFlavor);
	if (!paths.isAbsolute(input.canonicalRoot))
		throw fail("INVALID_INPUT", "Scope root must be absolute on its device");
	const displayRoot = input.displayRoot ?? input.canonicalRoot;
	assertString(displayRoot, "displayRoot", FILE_CHANGE_LIMITS.metadataBytes);
	const values = {
		sourceInstanceId: input.sourceInstanceId,
		deviceId: input.deviceId,
		workspaceInstanceId: input.workspaceInstanceId,
		pathFlavor: input.pathFlavor,
		canonicalRoot: paths.resolve(input.canonicalRoot, "."),
		displayRoot,
	};
	assertMetadata(values);
	return values;
}

function normalizeOperation(input: BeginFileChangeOperation) {
	assertString(input.sourceInstanceId, "sourceInstanceId");
	assertString(input.sourceId, "sourceId");
	if (
		!["tool", "editor", "background_task", "external", "git", "revert", "import"].includes(
			input.sourceKind,
		)
	)
		throw fail("INVALID_INPUT", "Invalid operation source kind");
	assertInteger(input.attempt, "attempt", 1);
	assertDigest(input.requestDigest);
	assertInteger(
		input.expectedEffectCount,
		"expectedEffectCount",
		1,
		FILE_CHANGE_LIMITS.revertFiles,
	);
	const values = {
		evidenceVersion: FILE_CHANGE_EVIDENCE_VERSION,
		sourceInstanceId: input.sourceInstanceId,
		sourceKind: input.sourceKind,
		sourceId: input.sourceId,
		attempt: input.attempt,
		requestDigest: input.requestDigest,
		expectedEffectCount: input.expectedEffectCount,
		actorSubjectKey: input.actor.subjectKey,
		actorJson: normalizeActor(input.actor),
		executionBindingJson: normalizeBinding(input.executionBinding),
		toolCallId: nullableId(input.toolCallId),
		toolUseId: nullableId(input.toolUseId),
		backgroundTaskId: nullableId(input.backgroundTaskId),
		narratorId: nullableId(input.narratorId),
		projectId: nullableId(input.projectId),
		ownerUserId: nullableId(input.ownerUserId),
		initiatorSubjectKey: nullableId(input.initiatorSubjectKey),
		parentOperationId: nullableId(input.parentOperationId),
		executionSegmentId: nullableId(input.executionSegmentId),
	};
	assertMetadata(values);
	return values;
}

function normalizeActor(actor: FileChangeActor): FileChangeActor {
	assertKeys(actor, [
		"kind",
		"subjectKey",
		"narratorId",
		"userId",
		"label",
		"deleted",
		"parentSubjectKey",
	]);
	if (
		!["human", "primary", "subagent", "external_unknown"].includes(actor.kind) ||
		typeof actor.deleted !== "boolean"
	)
		throw fail("INVALID_INPUT", "Invalid actor snapshot");
	assertString(actor.subjectKey, "actor subjectKey");
	if (actor.label !== null) assertString(actor.label, "actor label", 512);
	return {
		kind: actor.kind,
		subjectKey: actor.subjectKey,
		narratorId: nullableId(actor.narratorId),
		userId: nullableId(actor.userId),
		label: actor.label,
		deleted: actor.deleted,
		parentSubjectKey: nullableId(actor.parentSubjectKey),
	};
}

function normalizeBinding(binding: FileChangeExecutionBinding): FileChangeExecutionBinding {
	assertKeys(binding, ["deviceId", "runtimeEpoch", "runtimeGeneration", "fencingToken"]);
	assertString(binding.deviceId, "binding deviceId");
	assertString(binding.runtimeEpoch, "runtimeEpoch");
	assertInteger(binding.runtimeGeneration, "runtimeGeneration");
	assertInteger(binding.fencingToken, "fencingToken");
	return {
		deviceId: binding.deviceId,
		runtimeEpoch: binding.runtimeEpoch,
		runtimeGeneration: binding.runtimeGeneration,
		fencingToken: binding.fencingToken,
	};
}

function normalizeEffect(input: PrepareFileChangeEffect) {
	assertDigest(input.requestDigest);
	assertInteger(input.scopeRevision, "scopeRevision");
	const phase = input.phase ?? "apply";
	if (phase !== "apply" && phase !== "compensate")
		throw fail("INVALID_INPUT", "Invalid mutation phase");
	const fileKey = fileChangeIdentityKey(input.identity);
	assertKeys(input.identity, [
		"sourceInstanceId",
		"deviceId",
		"workspaceInstanceId",
		"scopeId",
		"pathFlavor",
		"objectRole",
		"canonicalPath",
		"lexicalPath",
		"displayPath",
	]);
	const before = normalizeState(input.before);
	const intendedAfter = normalizeState(input.intendedAfter);
	if (before.kind === "unknown" || intendedAfter.kind === "unknown")
		throw fail(
			"UNKNOWN_INTENT",
			"Protected intent requires known before and intended-after states",
		);
	const result = {
		identity: { ...input.identity },
		fileKey,
		scopeRevision: input.scopeRevision,
		requestDigest: input.requestDigest,
		phase,
		before,
		intendedAfter,
	};
	assertMetadata(result);
	return result;
}

function normalizeReceipt(receipt: FileChangeExecutionReceipt): FileChangeExecutionReceipt {
	assertKeys(receipt, [
		"receiptId",
		"mutationId",
		"requestDigest",
		"executionBinding",
		"confirmed",
		"observedAfter",
		"outcome",
	]);
	assertString(receipt.receiptId, "receiptId");
	assertString(receipt.mutationId, "receipt mutationId");
	assertDigest(receipt.requestDigest);
	if (
		typeof receipt.confirmed !== "boolean" ||
		!["applied", "not_applied", "unknown"].includes(receipt.outcome)
	)
		throw fail("INVALID_INPUT", "Invalid execution receipt");
	const normalized = {
		receiptId: receipt.receiptId,
		mutationId: receipt.mutationId,
		requestDigest: receipt.requestDigest,
		executionBinding: normalizeBinding(receipt.executionBinding),
		confirmed: receipt.confirmed,
		observedAfter: normalizeState(receipt.observedAfter),
		outcome: receipt.outcome,
	};
	assertMetadata(normalized);
	return normalized;
}

function normalizeState(state: FileChangeState): FileChangeState {
	if (!state || typeof state !== "object")
		throw fail("INVALID_INPUT", "Absence must be explicit, never null");
	if (state.kind === "absent") {
		assertKeys(state, ["kind"]);
		return { kind: "absent" };
	}
	if (state.kind === "unknown") {
		assertKeys(state, ["kind", "reason"]);
		if (
			![
				"legacy_unverified",
				"capture_failed",
				"capture_incomplete",
				"capture_concurrent",
				"missing_before",
				"missing_after",
				"unreadable",
				"unsupported_object",
				"unsupported_backend",
				"target_unverified",
				"result_unknown",
				"content_changed",
				"quota_exceeded",
				"budget_exceeded",
				"cancelled",
				"expired",
				"object_missing",
			].includes(state.reason)
		)
			throw fail("INVALID_INPUT", "Invalid unknown-state reason");
		return { kind: "unknown", reason: state.reason };
	}
	if (state.kind !== "regular" && state.kind !== "symlink")
		throw fail("INVALID_INPUT", "Unsupported file object");
	assertKeys(
		state,
		state.kind === "regular" ? ["kind", "blob", "mode"] : ["kind", "target", "mode"],
	);
	if (state.mode !== null) assertInteger(state.mode, "mode", 0, 0xffff);
	const ref = state.kind === "regular" ? state.blob : state.target;
	assertKeys(ref, ["algorithm", "digest", "sizeBytes"]);
	if (ref.algorithm !== "sha256")
		throw fail("INVALID_INPUT", "Only SHA-256 blob references are supported");
	assertDigest(ref.digest);
	assertInteger(ref.sizeBytes, "blob size", 0, FILE_CHANGE_LIMITS.blobBytes);
	const blob = { algorithm: "sha256" as const, digest: ref.digest, sizeBytes: ref.sizeBytes };
	return state.kind === "regular"
		? { kind: "regular", blob, mode: state.mode }
		: { kind: "symlink", target: blob, mode: state.mode };
}

function assertJournal(
	operation: FileChangeOperationRecord,
): asserts operation is FileChangeOperationRecord & {
	requestDigest: string;
	expectedEffectCount: number;
	executionBindingJson: FileChangeExecutionBinding;
} {
	if (
		operation.evidenceVersion !== FILE_CHANGE_EVIDENCE_VERSION ||
		operation.requestDigest === null ||
		operation.expectedEffectCount === null ||
		operation.executionBindingJson === null
	)
		throw fail("LEGACY_UNVERIFIED", "Pre-journal operations cannot authorize execution");
	assertDigest(operation.requestDigest);
	assertInteger(
		operation.expectedEffectCount,
		"expectedEffectCount",
		1,
		FILE_CHANGE_LIMITS.revertFiles,
	);
	assertInteger(
		operation.preparedEffectCount,
		"preparedEffectCount",
		0,
		operation.expectedEffectCount,
	);
	assertInteger(
		operation.settledEffectCount,
		"settledEffectCount",
		0,
		operation.preparedEffectCount,
	);
	assertInteger(
		operation.unresolvedEffectCount,
		"unresolvedEffectCount",
		0,
		operation.preparedEffectCount - operation.settledEffectCount,
	);
	assertEvidenceBudget(operation.evidenceBytes);
	normalizeBinding(operation.executionBindingJson);
}

function assertKnownPreparedStates(effect: FileChangeEffectRecord) {
	const before = normalizeState(effect.beforeStateJson);
	const intended = normalizeState(effect.intendedAfterStateJson);
	if (
		before.kind === "unknown" ||
		intended.kind === "unknown" ||
		effect.beforeBlobDigest !== (stateBlob(before)?.digest ?? null) ||
		effect.intendedAfterBlobDigest !== (stateBlob(intended)?.digest ?? null)
	)
		throw fail("UNKNOWN_INTENT", "Prepared states or reverse references are incomplete");
}

function assertEffectScope(
	tx: Executor,
	operation: FileChangeOperationRecord,
	identity: FileChangeIdentity,
	revision: number,
	requireVerified: boolean,
) {
	const scope = requireScope(tx, identity.scopeId);
	if (scope.status === "retired" || (requireVerified && scope.status !== "active"))
		throw fail("TARGET_UNVERIFIED", "The workspace scope is not verified for execution");
	if (
		scope.sourceInstanceId !== operation.sourceInstanceId ||
		scope.deviceId !== operation.executionBindingJson?.deviceId ||
		scope.sourceInstanceId !== identity.sourceInstanceId ||
		scope.deviceId !== identity.deviceId ||
		scope.workspaceInstanceId !== identity.workspaceInstanceId ||
		scope.pathFlavor !== identity.pathFlavor ||
		scope.revision !== revision ||
		scope.fencingToken !== operation.executionBindingJson?.fencingToken
	)
		throw fail("IDENTITY_CONFLICT", "Effect scope or execution fence does not match its operation");
	const normalized = createFileChangeIdentity(scope, identity);
	if (!jsonEqual(normalized, identity))
		throw fail("IDENTITY_CONFLICT", "Effect identity is not the canonical scoped backend target");
}

function assertReadyStates(tx: Executor, states: FileChangeState[]) {
	const budget = tx
		.select({ status: fileChangeStorageBudgets.status })
		.from(fileChangeStorageBudgets)
		.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
		.get();
	if (budget?.status !== "ready")
		throw fail(
			"CATALOG_UNVERIFIED",
			"Blob storage reconciliation must finish before protected evidence is used",
		);
	for (const state of states) {
		const ref = stateBlob(state);
		if (!ref) continue;
		const blob = tx
			.select({ sizeBytes: fileChangeBlobs.sizeBytes, status: fileChangeBlobs.status })
			.from(fileChangeBlobs)
			.where(eq(fileChangeBlobs.digest, ref.digest))
			.get();
		if (blob?.status !== "ready" || blob.sizeBytes !== ref.sizeBytes)
			throw fail(
				"BLOB_NOT_READY",
				"Evidence references require a ready catalog object with matching size",
			);
	}
}

function requireScope(tx: Executor, id: string): FileChangeScopeRecord {
	const row = tx.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, id)).get();
	if (!row) throw fail("NOT_FOUND", "File-change scope not found");
	return row;
}

function requireOperation(tx: Executor, id: string): FileChangeOperationRecord {
	const row = tx.select().from(fileChangeOperations).where(eq(fileChangeOperations.id, id)).get();
	if (!row) throw fail("NOT_FOUND", "File-change operation not found");
	return row;
}

function requireEffect(tx: Executor, input: FileChangeEffectSelector): FileChangeEffectRecord {
	const row = tx
		.select()
		.from(fileChangeEffects)
		.where(eq(fileChangeEffects.mutationId, input.mutationId))
		.get();
	if (!row || row.operationId !== input.operationId)
		throw fail("NOT_FOUND", "Effect does not belong to this operation");
	if (row.requestDigest !== input.requestDigest)
		throw fail("REQUEST_CONFLICT", "Mutation request digest changed");
	return row;
}

function effectExists(tx: Executor, operationId: string, condition: SQL): boolean {
	// Prefix of idx_fc_effect_operation_file; at most the fixed 1000-row operation,
	// never a global aggregation and never fetches JSON/body fields.
	return (
		tx
			.select({ id: fileChangeEffects.id })
			.from(fileChangeEffects)
			.where(and(eq(fileChangeEffects.operationId, operationId), condition))
			.limit(1)
			.get() !== undefined
	);
}

function selectEffects(
	tx: Executor,
	operationId: string,
	cursor: FileChangeEffectCursor | undefined,
	limit: number,
): FileChangeEffectRecord[] {
	return tx
		.select()
		.from(fileChangeEffects)
		.where(
			and(
				eq(fileChangeEffects.operationId, operationId),
				cursor
					? sql`(${fileChangeEffects.fileKey}, ${fileChangeEffects.phase}) > (${cursor.fileKey}, ${cursor.phase})`
					: undefined,
			),
		)
		.orderBy(asc(fileChangeEffects.fileKey), asc(fileChangeEffects.phase))
		.limit(limit)
		.all();
}

function boundedPage<T, C>(
	rows: T[],
	limit: number,
	toCursor: (row: T) => C,
): FileChangeEvidencePage<T, C> {
	const items: T[] = [];
	let bytes = 1024; // Envelope and bounded cursor overhead.
	for (const row of rows) {
		const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
		if (items.length === limit || bytes + size > FILE_CHANGE_LIMITS.summaryBytes) break;
		items.push(row);
		bytes += size;
	}
	if (rows.length && !items.length)
		throw fail("METADATA_BUDGET", "An evidence row exceeds the summary budget");
	const hasMore = rows.length > items.length;
	const last = items.at(-1);
	return { items, hasMore, nextCursor: hasMore && last ? toCursor(last) : null };
}

function validateSelector(input: FileChangeEffectSelector) {
	assertString(input.operationId, "operationId");
	assertString(input.mutationId, "mutationId");
	assertDigest(input.requestDigest);
}

function validateEffectCursor(cursor: FileChangeEffectCursor | undefined) {
	if (!cursor) return;
	assertDigest(cursor.fileKey);
	if (cursor.phase !== "apply" && cursor.phase !== "compensate")
		throw fail("INVALID_INPUT", "Invalid effect cursor phase");
}

function effectCursor(effect: FileChangeEffectRecord): FileChangeEffectCursor {
	return { fileKey: effect.fileKey, phase: effect.phase };
}

function mutationKey(
	operation: FileChangeOperationRecord,
	fileKey: string,
	phase: FileChangeMutationPhase,
): string {
	return digest([operation.id, operation.attempt, fileKey, phase]);
}

function stateBlob(state: FileChangeState) {
	return state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
}

function stateBytes(state: FileChangeState): number {
	return stateBlob(state)?.sizeBytes ?? 0;
}

function unknownAfter(): FileChangeState {
	return { kind: "unknown", reason: "missing_after" };
}

function nullableId(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	assertString(value, "identifier");
	return value;
}

function nullableLines(value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	assertInteger(value, "measured lines");
	return value;
}

function pageLimit(value: number = FILE_CHANGE_LIMITS.historyPageItems): number {
	assertInteger(value, "page limit", 1, FILE_CHANGE_LIMITS.historyPageItems);
	return value;
}

function assertEvidenceBudget(bytes: number) {
	assertInteger(bytes, "evidence bytes", 0, FILE_CHANGE_LIMITS.operationEvidenceBytes);
}

function assertString(value: string, name: string, maxBytes = 256) {
	if (
		typeof value !== "string" ||
		!value ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > maxBytes
	)
		throw fail("INVALID_INPUT", `Invalid or oversized ${name}`);
}

function assertInteger(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw fail("BUDGET_EXCEEDED", `Invalid or over-budget ${name}`);
}

function assertDigest(value: string) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		throw fail("INVALID_INPUT", "Expected a lowercase SHA-256 digest");
}

function assertMetadata(value: unknown) {
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > FILE_CHANGE_LIMITS.metadataBytes)
		throw fail("METADATA_BUDGET", "Evidence metadata exceeds its bounded row budget");
}

function boundedRecord<T>(record: T): T {
	// Check DB defaults too, not only the explicitly inserted fields. A failure here
	// is still inside the short transaction and rolls the oversized row back.
	assertMetadata(record);
	return record;
}

function assertKeys(value: object, keys: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw fail("INVALID_INPUT", "Unexpected fields in evidence metadata");
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item,
	);
}

function jsonEqual(left: unknown, right: unknown): boolean {
	return stableJson(left) === stableJson(right);
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function fail(code: string, message: string) {
	return new FileChangeEvidenceError(code, message);
}
