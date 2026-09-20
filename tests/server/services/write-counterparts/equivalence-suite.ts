/**
 * The wrapper-equivalence behavior suite, shared by the SQLite runner
 * (`server/services/__tests__/write-counterparts-equivalence.test.ts`, always run)
 * and the PostgreSQL runner (`tests/server/services/write-counterparts/pg-equivalence.test.ts`,
 * run under `PG_INTEGRATION=1` against a real PostgreSQL 17).
 *
 * WHAT IS BEING PINNED
 * --------------------
 * The five atomicity wrappers each have a PostgreSQL counterpart whose sections
 * must produce the SAME durable facts and the SAME domain verdicts as the SQLite
 * original. Each scenario below drives one domain through a backend-agnostic
 * facade, asserting the expected outcomes as it goes and returning a JSON
 * projection of everything observable: statuses, counters, fences, error codes,
 * history-callback invocations. The PG runner additionally asserts its
 * projections DEEP-EQUAL the SQLite runner's — the equivalence claim itself.
 *
 * Error identity is compared on the error's `code` field (every wrapper error
 * class carries one), never on message text.
 */

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import type {
	FileChangeBlobRef,
	FileChangeExecutionBinding,
	FileChangeExecutionReceipt,
	FileChangeState,
} from "@shared/file-change-protocol";
import type { FileChangeBlobRelease } from "../../../../server/services/file-change-blob-store";
import type {
	BeginFileChangeOperation,
	PrepareFileChangeScope,
	SettleFileChangeEffect,
} from "../../../../server/services/file-change-evidence";
import type { FileChangeScopeIdentity } from "../../../../server/services/file-change-identity";
import { createFileChangeIdentity } from "../../../../server/services/file-change-identity";
import type {
	RevertJournalClaim,
	RevertJournalContext,
} from "../../../../server/services/revert-mutation-journal";
import type {
	BeginRevertPlan,
	RevertPlanManifestProof,
	RevertPlanOwner,
	RevertPlanSummary,
} from "../../../../server/services/revert-plan-service";
import {
	fingerprintRevertPlanFiles,
	revertPlanHeaderDigest,
} from "../../../../server/services/revert-plan-service";
import type { WorkspaceWriteLease } from "../../../../server/services/workspace-write-coordinator";
import type { WorkspaceWriteRange } from "../../../../server/services/workspace-write-ranges";

// ─────────────────────────────────────────────────────────────────────────────
// Facades (one per domain, uniform async shape over both backends)
// ─────────────────────────────────────────────────────────────────────────────

export interface BlobCatalogFacade {
	getBudget(): Promise<Record<string, unknown> | null>;
	initializeNamespace(input: {
		expectedGeneration: number | null;
		quotaBytes?: number;
	}): Promise<Record<string, unknown>>;
	beginReconciliation(input: { expectedGeneration: number }): Promise<Record<string, unknown>>;
	completeReconciliation(input: {
		expectedGeneration: number;
		verifiedUsedBytes: number;
		verification: {
			namespaceIdentityVerified: true;
			writersQuiescent: true;
			physicalInventoryComplete: true;
			catalogMatchesInventory: true;
		};
	}): Promise<Record<string, unknown>>;
	reserve(input: {
		expectedGeneration: number;
		ownerEpoch: string;
		expectedSize: number;
		signal: AbortSignal;
	}): Promise<{
		reservationId: string;
		ownerEpoch: string;
		generation: number;
		release(input: FileChangeBlobRelease): Promise<void>;
	}>;
	getMetadata(input: {
		expectedGeneration: number;
		ref: FileChangeBlobRef;
	}): Promise<Record<string, unknown> | null>;
	reconcileBlob(input: {
		expectedGeneration: number;
		ref: FileChangeBlobRef;
		physicalState: "verified" | "missing";
	}): Promise<Record<string, unknown>>;
}

export interface WorkspaceLeaseFacade {
	/**
	 * A complete clean write: admit, register one mutation, settle it, release.
	 * The probe reads the durable mutation counter while the write is in flight.
	 */
	runCleanWrite(
		scope: Readonly<FileChangeScopeIdentity>,
		ranges?: readonly WorkspaceWriteRange[],
	): Promise<{ counterDuringWrite: unknown }>;
	/** A write that marks its outcome uncertain: quarantine, durable lease retained. */
	runUncertainWrite(
		scope: Readonly<FileChangeScopeIdentity>,
		ranges?: readonly WorkspaceWriteRange[],
	): Promise<void>;
	/** Admit on the scope, surfacing the domain error code. */
	admitLease(scope: Readonly<FileChangeScopeIdentity>): Promise<unknown>;
	readLeases(scope: Readonly<FileChangeScopeIdentity>): Promise<Record<string, unknown>[]>;
	readScope(scope: Readonly<FileChangeScopeIdentity>): Promise<Record<string, unknown>>;
}

export interface EvidenceFacade {
	prepareScope(input: PrepareFileChangeScope): Promise<Record<string, unknown>>;
	recordScopeVerification(input: {
		scopeId: string;
		canonicalRoot: string;
		rootIdentity: Record<string, string>;
	}): Promise<Record<string, unknown>>;
	beginOperation(input: BeginFileChangeOperation): Promise<Record<string, unknown>>;
	prepareEffects(
		operationId: string,
		inputs: import("../../../../server/services/file-change-evidence").PrepareFileChangeEffect[],
	): Promise<Record<string, unknown>[]>;
	finalizePreparation(operationId: string): Promise<Record<string, unknown>>;
	markApplying(input: {
		operationId: string;
		mutationId: string;
		requestDigest: string;
		executionBinding: FileChangeExecutionBinding;
	}): Promise<{ effect: Record<string, unknown>; mayExecute: boolean }>;
	settleEffect(input: SettleFileChangeEffect): Promise<Record<string, unknown>>;
	finishOperation(
		operationId: string,
		outcome: "succeeded" | "failed" | "interrupted",
	): Promise<Record<string, unknown>>;
	getOperation(operationId: string): Promise<Record<string, unknown> | null>;
	getEffect(operationId: string, mutationId: string): Promise<Record<string, unknown> | null>;
}

export interface PlanFacade {
	begin(input: BeginRevertPlan): Promise<RevertPlanSummary>;
	appendFiles(
		owner: RevertPlanOwner,
		planId: string,
		inputs: import("../../../../server/services/revert-plan-service").AppendRevertPlanFile[],
	): Promise<
		Pick<{ id: string; fileKey: string; sequence: number }, "id" | "fileKey" | "sequence">[]
	>;
	finalize(
		owner: RevertPlanOwner,
		planId: string,
		proof: RevertPlanManifestProof,
	): Promise<RevertPlanSummary>;
}

export interface JournalFacade {
	startExecution(
		ctx: RevertJournalContext,
		proof: RevertPlanManifestProof,
	): Promise<{ operation: Record<string, unknown>; started: boolean }>;
	claimApply(
		ctx: RevertJournalContext,
		fixed: import("../../../../server/services/revert-plan-service").RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
	): Promise<RevertJournalClaim>;
	recordApplyReceipt(
		ctx: RevertJournalContext,
		fileId: string,
		receipt: FileChangeExecutionReceipt,
	): Promise<Record<string, unknown>>;
	finishFiles(ctx: RevertJournalContext): Promise<Record<string, unknown>>;
	commit(ctx: RevertJournalContext, history: HistoryProbe): Promise<Record<string, unknown>>;
	beginCompensation(ctx: RevertJournalContext): Promise<Record<string, unknown>>;
	claimCompensate(
		ctx: RevertJournalContext,
		fixed: import("../../../../server/services/revert-plan-service").RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
	): Promise<RevertJournalClaim>;
	recordCompensateReceipt(
		ctx: RevertJournalContext,
		fileId: string,
		receipt: FileChangeExecutionReceipt,
	): Promise<Record<string, unknown>>;
	finishCompensation(ctx: RevertJournalContext): Promise<Record<string, unknown>>;
}

/** The commit probe: the suite counts invocations; the facade adapts sync/async. */
export interface HistoryProbe {
	calls: () => number;
	/** The facade wraps this into whatever callback shape its backend takes. */
	apply(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture kit (the parts only a concrete backend can supply)
// ─────────────────────────────────────────────────────────────────────────────

export interface EquivalenceKit {
	blob: BlobCatalogFacade;
	workspace: WorkspaceLeaseFacade;
	evidence: EvidenceFacade;
	plan: PlanFacade;
	journal: JournalFacade;
	/** The namespace key every facade is bound to. */
	namespaceKey: string;
	/** The owner epoch every lease claim is made under. */
	ownerEpoch: string;
	/** The runtime authority every claim checks against. */
	runtime: { runtimeEpoch: string; runtimeGeneration: number };
	/** Install a scope row directly (prepareScope + verify shape), returning its identity. */
	seedVerifiedScope(overrides?: {
		canonicalRoot?: string;
		workspaceInstanceId?: string;
	}): Promise<FileChangeScopeIdentity>;
	/**
	 * Give a scope a durable lease owned by `ownerEpoch` (the journal claim's
	 * precondition), returning the scope row's revision and fencing token.
	 */
	seedLeasedScope(scope: Readonly<FileChangeScopeIdentity>): Promise<{
		revision: number;
		fencingToken: number;
		leaseId: string;
	}>;
	/** The fixed plan file's metadata row, as the journal's claim requires it. */
	fixedFileMetadata(
		planId: string,
		fileId: string,
	): Promise<import("../../../../server/services/revert-plan-service").RevertPlanFileMetadata>;
	/** Whether the history callback's write committed with the marker. */
	historyWriteVisible(): Promise<boolean>;
	/** A revert operation row projection, for assertions. */
	readRevertOperation(planId: string): Promise<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

export function digestOf(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function blobRef(text: string, sizeBytes: number): FileChangeBlobRef {
	return { algorithm: "sha256", digest: digestOf(text), sizeBytes };
}

function regularState(text: string, sizeBytes: number): FileChangeState {
	return { kind: "regular", blob: blobRef(text, sizeBytes), mode: null };
}

function identityOf(
	scope: Readonly<FileChangeScopeIdentity>,
	path: string,
): import("@shared/file-change-protocol").FileChangeIdentity {
	// Built through the production constructor, so the identity is byte-identical
	// to what the services compute when they re-derive it from the scope.
	return createFileChangeIdentity(scope as FileChangeScopeIdentity, {
		deviceId: scope.deviceId,
		pathFlavor: scope.pathFlavor,
		lexicalPath: `${scope.canonicalRoot}/${path}`,
		canonicalPath: `${scope.canonicalRoot}/${path}`,
		objectRole: "entry",
	});
}

function bindingOf(
	deviceId: string,
	fencingToken: number,
	runtime: { runtimeEpoch: string; runtimeGeneration: number },
): FileChangeExecutionBinding {
	return {
		deviceId,
		runtimeEpoch: runtime.runtimeEpoch,
		runtimeGeneration: runtime.runtimeGeneration,
		fencingToken,
	};
}

function fakeRollbackLease(
	scope: Readonly<FileChangeScopeIdentity>,
	binding: FileChangeExecutionBinding,
	scopeRevision: number,
): WorkspaceWriteLease {
	return {
		token: Object.freeze({ id: Symbol("equivalence-lease") }),
		kind: "rollback",
		leaseId: "equivalence-rollback-fixture",
		ranges: [{ kind: "subtree", canonicalPath: scope.canonicalRoot }],
		scope,
		scopeRevision,
		executionBinding: binding,
		overlappedUncoordinatedActivity: false,
		pendingMutationCount: 0,
		assertCurrent: () => {},
		registerMutation: () => {},
		assertMutationPending: () => {},
		settle: () => {},
		markUncertain: () => {},
	};
}

/** Publish a ready blob through the catalog's own reserve→release flow. */
export async function publishBlob(
	blob: BlobCatalogFacade,
	generation: number,
	ownerEpoch: string,
	text: string,
	sizeBytes: number,
): Promise<FileChangeBlobRef> {
	const ref = blobRef(text, sizeBytes);
	const lease = await blob.reserve({
		expectedGeneration: generation,
		ownerEpoch,
		expectedSize: sizeBytes,
		signal: new AbortController().signal,
	});
	await lease.release({ ref, published: true });
	return ref;
}

const VERIFICATION = {
	namespaceIdentityVerified: true,
	writersQuiescent: true,
	physicalInventoryComplete: true,
	catalogMatchesInventory: true,
} as const;

/** Bring up (or re-attest) a ready namespace, returning its generation. */
export async function readyNamespace(blob: BlobCatalogFacade): Promise<number> {
	const existing = await blob.getBudget();
	if (!existing) {
		await blob.initializeNamespace({ expectedGeneration: null, quotaBytes: 1_000_000 });
	}
	const current = (await blob.getBudget()) as { generation: number; usedBytes: number };
	// Re-attestation is the startup path: the existing row is invalidated, never
	// trusted, and reconciliation must run to completion before admissions.
	const gen = current.generation;
	await blob.initializeNamespace({ expectedGeneration: gen, quotaBytes: 1_000_000 });
	await blob.beginReconciliation({ expectedGeneration: gen + 1 });
	await blob.completeReconciliation({
		expectedGeneration: gen + 2,
		verifiedUsedBytes: current.usedBytes,
		verification: VERIFICATION,
	});
	// completeReconciliation does NOT bump the generation; read it back rather than
	// arithmetic-guessing it.
	return ((await blob.getBudget()) as { generation: number }).generation;
}

/** The error's comparable identity, never its message. */
export function errorCode(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) return String(error.code);
	return String(error);
}

async function captureError(fn: () => Promise<unknown> | unknown): Promise<string> {
	try {
		await fn();
		return "NO_ERROR";
	} catch (error) {
		return errorCode(error);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: the blob catalog
// ─────────────────────────────────────────────────────────────────────────────

export async function blobCatalogScenario(kit: EquivalenceKit): Promise<unknown> {
	const { blob, ownerEpoch } = kit;
	const projection: Record<string, unknown> = {};

	// A fresh namespace: unverified, generation 0, zero counters.
	const initial = await blob.initializeNamespace({ expectedGeneration: null, quotaBytes: 1000 });
	expect(initial.status).toBe("unverified");
	expect(initial.generation).toBe(0);
	// Reinitialization with a stale expectation is a generation fence.
	projection.staleInit = await captureError(() =>
		blob.initializeNamespace({ expectedGeneration: 99 }),
	);

	const reconciling = await blob.beginReconciliation({ expectedGeneration: 0 });
	expect(reconciling.status).toBe("reconciling");
	expect(reconciling.generation).toBe(1);

	// Admissions are fenced while reconciling.
	projection.reserveWhileReconciling = await captureError(() =>
		blob.reserve({
			expectedGeneration: 1,
			ownerEpoch,
			expectedSize: 10,
			signal: new AbortController().signal,
		}),
	);

	const ready = await blob.completeReconciliation({
		expectedGeneration: 1,
		verifiedUsedBytes: 0,
		verification: VERIFICATION,
	});
	expect(ready.status).toBe("ready");
	// completeReconciliation does NOT bump the generation; beginReconciliation's is
	// the last fence movement.
	expect(ready.generation).toBe(1);

	// Quota accounting through the full reserve → release flow.
	const lease = await blob.reserve({
		expectedGeneration: 1,
		ownerEpoch,
		expectedSize: 400,
		signal: new AbortController().signal,
	});
	expect(lease.generation).toBe(1);
	let budget = await blob.getBudget();
	expect(budget?.reservedBytes).toBe(400);

	projection.overQuota = await captureError(() =>
		blob.reserve({
			expectedGeneration: 1,
			ownerEpoch,
			expectedSize: 601,
			signal: new AbortController().signal,
		}),
	);

	const ref = blobRef("blob-catalog-scenario", 400);
	await lease.release({ ref, published: true });
	budget = await blob.getBudget();
	expect(budget?.usedBytes).toBe(400);
	expect(budget?.reservedBytes).toBe(0);
	const metadata = await blob.getMetadata({ expectedGeneration: 1, ref });
	expect(metadata?.status).toBe("ready");
	expect(metadata?.sizeBytes).toBe(400);
	// Releasing again with the SAME result is an idempotent no-op.
	await lease.release({ ref, published: true });
	projection.conflictingRelease = await captureError(() =>
		lease.release({ ref: null, published: false }),
	);

	// Worker-side metadata correction is a maintenance-mode operation: it belongs
	// to a reconciliation window, so open one. The generation moves with it.
	await blob.beginReconciliation({ expectedGeneration: 1 });
	const corrected = await blob.reconcileBlob({
		expectedGeneration: 2,
		ref: blobRef("blob-catalog-reconciled", 5),
		physicalState: "verified",
	});
	expect(corrected.status).toBe("ready");
	await blob.completeReconciliation({
		expectedGeneration: 2,
		verifiedUsedBytes: 400,
		verification: VERIFICATION,
	});

	projection.staleReserve = await captureError(() =>
		blob.reserve({
			expectedGeneration: 1,
			ownerEpoch,
			expectedSize: 1,
			signal: new AbortController().signal,
		}),
	);
	projection.finalBudget = summarizeBudget(await blob.getBudget());
	return projection;
}

function summarizeBudget(budget: Record<string, unknown> | null) {
	return budget
		? {
				status: budget.status,
				generation: budget.generation,
				usedBytes: budget.usedBytes,
				reservedBytes: budget.reservedBytes,
				quotaBytes: budget.quotaBytes,
			}
		: null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: the workspace durable lease lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function workspaceLeaseScenario(kit: EquivalenceKit): Promise<unknown> {
	const { workspace } = kit;
	const projection: Record<string, unknown> = {};
	const scope = await kit.seedVerifiedScope({ canonicalRoot: "/equiv/lease" });

	// A clean write: the counter is visible while the write is in flight, and the
	// finalizer releases everything — lease cleared, counter zero, revision bumped
	// once for the claim and once for the release.
	const { counterDuringWrite } = await workspace.runCleanWrite(scope);
	projection.counterDuringWrite = counterDuringWrite;
	let row = await workspace.readScope(scope);
	expect(row.activeLeaseId).toBeNull();
	expect(row.activeMutationCount).toBe(0);
	expect(row.fencingToken).toBe(1);
	expect(row.revision).toBe(2);
	expect(row.status).toBe("active");

	// Ended A keeps only its physical file barrier, not the scope-wide owner.
	const rangesA = [{ kind: "file" as const, canonicalPath: `${scope.canonicalRoot}/A.txt` }];
	await workspace.runUncertainWrite(scope, rangesA);
	row = await workspace.readScope(scope);
	expect(row.status).toBe("active");
	expect(row.activeLeaseId).toBeNull();
	expect(row.activeMutationCount).toBe(0);
	projection.admitOnBarrier = await captureError(() => workspace.admitLease(scope));
	const quarantined = (await workspace.readLeases(scope)).filter(
		(lease) => lease.status === "quarantined",
	);
	expect(quarantined).toHaveLength(1);
	expect(quarantined[0]?.executionEndedAt).not.toBeNull();
	expect(quarantined[0]?.rangesJson).toEqual({ version: 1, ranges: rangesA });
	projection.quarantineRanges = quarantined[0]?.rangesJson;
	// Sibling B in the SAME scope can complete without recovering A first.
	await workspace.runCleanWrite(scope, [
		{ kind: "file", canonicalPath: `${scope.canonicalRoot}/B.txt` },
	]);
	row = await workspace.readScope(scope);
	expect(row.status).toBe("active");
	expect(row.activeLeaseId).toBeNull();
	expect(row.activeMutationCount).toBe(0);
	expect(row.fencingToken).toBe(3);
	expect(row.revision).toBe(6);
	projection.admitAfterSibling = await captureError(() => workspace.admitLease(scope));
	// Recovery equivalence is NOT claimed here: PG exposes durable sections,
	// not SQLite's scheduler/reservation or external observation orchestration.
	projection.finalScope = {
		status: row.status,
		revision: row.revision,
		fencingToken: row.fencingToken,
		activeMutationCount: row.activeMutationCount,
	};
	return projection;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: the evidence store
// ─────────────────────────────────────────────────────────────────────────────

export async function evidenceScenario(kit: EquivalenceKit): Promise<unknown> {
	const { evidence, blob, ownerEpoch } = kit;
	const projection: Record<string, unknown> = {};
	const generation = await readyNamespace(blob);
	const scopeN = `evidence-${digestOf(`${ownerEpoch}-evidence-scope`).slice(0, 8)}`;
	const scopeInput = {
		sourceInstanceId: "source-1",
		deviceId: "device-1",
		workspaceInstanceId: `ws-${scopeN}`,
		pathFlavor: "posix" as const,
		canonicalRoot: `/equiv/${scopeN}`,
	};
	const before = regularState("evidence-before", 10);
	const intended = regularState("evidence-intended", 12);
	await publishBlob(blob, generation, ownerEpoch, "evidence-before", 10);
	await publishBlob(blob, generation, ownerEpoch, "evidence-intended", 12);

	const binding = bindingOf(scopeInput.deviceId, 0, kit.runtime);
	const operationInput: BeginFileChangeOperation = {
		sourceInstanceId: scopeInput.sourceInstanceId,
		sourceKind: "tool",
		sourceId: "tool-call-1",
		attempt: 1,
		requestDigest: digestOf("evidence-request"),
		expectedEffectCount: 1,
		actor: {
			kind: "primary",
			subjectKey: "narrator:test",
			narratorId: null,
			userId: null,
			label: null,
			deleted: false,
			parentSubjectKey: null,
		},
		executionBinding: binding,
		toolCallId: "tool-call-1",
		toolUseId: "toolu_1",
		narratorId: null,
		projectId: null,
		ownerUserId: null,
		initiatorSubjectKey: null,
		parentOperationId: null,
		executionSegmentId: null,
	};

	const scopeRow = await evidence.prepareScope(scopeInput);
	expect(scopeRow.status).toBe("needs_verification");
	// Idempotent: the same workspace instance returns the same row.
	expect((await evidence.prepareScope(scopeInput)).id).toBe(scopeRow.id);
	projection.conflictingScopeId = await captureError(() =>
		evidence.prepareScope({ ...scopeInput, id: "different-id" }),
	);
	// Verification is recorded, not performed: the scope becomes executable.
	const scopeId = String(scopeRow.id);
	const verifiedScope = await evidence.recordScopeVerification({
		scopeId,
		canonicalRoot: scopeInput.canonicalRoot,
		rootIdentity: { marker: "verified" },
	});
	expect(verifiedScope.status).toBe("active");
	const scope: FileChangeScopeIdentity = {
		id: scopeId,
		sourceInstanceId: scopeInput.sourceInstanceId,
		deviceId: scopeInput.deviceId,
		workspaceInstanceId: scopeInput.workspaceInstanceId,
		pathFlavor: scopeInput.pathFlavor,
		canonicalRoot: scopeInput.canonicalRoot,
	};
	const identity = identityOf(scope, "file.txt");

	const operation = await evidence.beginOperation(operationInput);
	expect(operation.journalSeq).toBe(1);
	const operationId = String(operation.id);
	expect((await evidence.beginOperation(operationInput)).id).toBe(operation.id);
	projection.conflictingOperation = await captureError(() =>
		evidence.beginOperation({ ...operationInput, requestDigest: digestOf("changed") }),
	);
	const second = await evidence.beginOperation({
		...operationInput,
		sourceId: "tool-call-2",
		toolCallId: "tool-call-2",
		attempt: 2,
		requestDigest: digestOf("evidence-request-2"),
	});
	expect(second.journalSeq).toBe(2);

	const effects = await evidence.prepareEffects(operationId, [
		{
			identity,
			scopeRevision: 0,
			requestDigest: operationInput.requestDigest,
			before,
			intendedAfter: intended,
		},
	]);
	expect(effects).toHaveLength(1);
	// Repeating the exact batch is safe.
	const repeated = await evidence.prepareEffects(operationId, [
		{
			identity,
			scopeRevision: 0,
			requestDigest: operationInput.requestDigest,
			before,
			intendedAfter: intended,
		},
	]);
	expect(repeated[0].id).toBe(effects[0].id);
	projection.overDeclared = await captureError(() =>
		evidence.prepareEffects(operationId, [
			{
				identity: identityOf(scope, "other.txt"),
				scopeRevision: 0,
				requestDigest: operationInput.requestDigest,
				before,
				intendedAfter: intended,
			},
		]),
	);

	const durable = await evidence.finalizePreparation(operationId);
	expect(durable.settlement).toBe("intent_durable");

	const mutationId = String(effects[0].mutationId);
	const first = await evidence.markApplying({
		operationId,
		mutationId,
		requestDigest: operationInput.requestDigest,
		executionBinding: binding,
	});
	expect(first.mayExecute).toBe(true);
	const second2 = await evidence.markApplying({
		operationId,
		mutationId,
		requestDigest: operationInput.requestDigest,
		executionBinding: binding,
	});
	expect(second2.mayExecute).toBe(false);
	expect(second2.effect.id).toBe(first.effect.id);

	const receipt: FileChangeExecutionReceipt = {
		receiptId: "receipt-1",
		mutationId,
		requestDigest: operationInput.requestDigest,
		executionBinding: binding,
		confirmed: true,
		observedAfter: intended,
		outcome: "applied",
	};
	const settled = await evidence.settleEffect({
		operationId,
		mutationId,
		requestDigest: operationInput.requestDigest,
		receipt,
	});
	expect(settled.settlement).toBe("settled");
	expect(settled.outcome).toBe("changed");
	expect(settled.attributionGrade).toBe("measured");
	// The immutable receipt cannot be overwritten.
	projection.overwriteReceipt = await captureError(() =>
		evidence.settleEffect({
			operationId,
			mutationId,
			requestDigest: operationInput.requestDigest,
			receipt: { ...receipt, receiptId: "receipt-2" },
		}),
	);

	const finished = await evidence.finishOperation(operationId, "succeeded");
	expect(finished.executionOutcome).toBe("succeeded");
	expect(finished.settlement).toBe("settled");
	expect(finished.effectOutcome).toBe("changed");
	projection.conflictingFinish = await captureError(() =>
		evidence.finishOperation(operationId, "failed"),
	);

	projection.operation = summarizeOperation(await evidence.getOperation(operationId));
	projection.effect = summarizeEffect(
		(await evidence.getEffect(operationId, mutationId)) as Record<string, unknown>,
	);
	return projection;
}

function summarizeOperation(operation: Record<string, unknown> | null) {
	return operation
		? {
				settlement: operation.settlement,
				executionOutcome: operation.executionOutcome,
				effectOutcome: operation.effectOutcome,
				coverage: operation.coverage,
				attributionGrade: operation.attributionGrade,
				preparedEffectCount: operation.preparedEffectCount,
				settledEffectCount: operation.settledEffectCount,
				unresolvedEffectCount: operation.unresolvedEffectCount,
			}
		: null;
}

function summarizeEffect(effect: Record<string, unknown> | null) {
	return effect
		? {
				settlement: effect.settlement,
				outcome: effect.outcome,
				attributionGrade: effect.attributionGrade,
				executionConfirmed: effect.executionConfirmed,
			}
		: null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 + 5: the revert plan and the mutation journal (one continuous flow)
// ─────────────────────────────────────────────────────────────────────────────

export async function revertFlowScenario(kit: EquivalenceKit): Promise<unknown> {
	const { blob, plan, journal, ownerEpoch, runtime } = kit;
	const projection: Record<string, unknown> = {};
	const generation = await readyNamespace(blob);
	const scope = await kit.seedVerifiedScope({ canonicalRoot: "/equiv/revert" });

	// Publish the manifest blobs and the file-state blobs through the catalog.
	const selector = await publishBlob(blob, generation, ownerEpoch, "revert-selector", 20);
	const planRef = await publishBlob(blob, generation, ownerEpoch, "revert-plan", 30);
	const history = await publishBlob(blob, generation, ownerEpoch, "revert-history", 40);
	const expectedBlob = await publishBlob(blob, generation, ownerEpoch, "revert-expected", 10);
	const desiredBlob = await publishBlob(blob, generation, ownerEpoch, "revert-desired", 12);

	const identity = identityOf(scope, "file.txt");
	const owner: RevertPlanOwner = {
		subjectKey: "narrator:revert-test",
		// Null lineage: the FK-targeted narrator/project rows deliberately do not
		// exist — the journal's owner context is vocabulary, not a database
		// reference, on both backends.
		narratorId: null,
		projectId: null,
	};

	// Bring one plan all the way to files_verified; used twice: once for the commit
	// path, once for the compensation path (a COMMITTED plan cannot compensate).
	const toFilesVerified = async (idempotencyKey: string) => {
		const header = {
			...owner,
			idempotencyKey,
			requestDigest: digestOf(`revert-flow-request-${idempotencyKey}`),
			kind: "revert" as const,
			revertScope: "workspace" as const,
			selectorKind: "all" as const,
			selector,
			historyManifest: history,
			expectedMessageVersion: 1,
			expectedFileCount: 1,
			parentRevertId: null,
		};
		const file = {
			sequence: 0,
			identity,
			expected: { kind: "regular" as const, blob: expectedBlob, mode: null },
			desired: { kind: "regular" as const, blob: desiredBlob, mode: null },
		};
		// The proof the trusted planner would supply, built with the production
		// digest helpers so both backends verify the same commitment.
		const fingerprint = fingerprintRevertPlanFiles([file]);
		const proof: RevertPlanManifestProof = {
			source: "trusted_published_planner_v1",
			headerDigest: revertPlanHeaderDigest(header),
			orderedFilesDigest: fingerprint.orderedFilesDigest,
			fileEvidenceBytes: fingerprint.fileEvidenceBytes,
			computation: "complete",
			selectorCoverage: "complete",
			historyCoverage: "complete",
			omittedFiles: 0,
			unknownFiles: 0,
		};

		const summary = await plan.begin({ ...header, plan: planRef, manifestProof: proof });
		expect(summary.status).toBe("planned");
		const appended = await plan.appendFiles(owner, summary.id, [file]);
		expect(appended).toHaveLength(1);
		// Re-appending the same batch is an idempotent no-op returning the same row.
		expect((await plan.appendFiles(owner, summary.id, [file]))[0].id).toBe(appended[0].id);
		const prepared = await plan.finalize(owner, summary.id, proof);
		expect(prepared.status).toBe("prepared");
		// Re-finalizing returns the winner's state, not an error.
		expect((await plan.finalize(owner, summary.id, proof)).status).toBe("prepared");

		const ctx: RevertJournalContext = {
			owner,
			planId: summary.id,
			planHash: summary.planHash ?? "",
		};
		const started = await journal.startExecution(ctx, proof);
		expect(started.started).toBe(true);
		// startExecution is idempotent against an already-applying plan.
		expect((await journal.startExecution(ctx, proof)).started).toBe(false);
		const leased = await kit.seedLeasedScope(scope);
		const leaseBinding = bindingOf(scope.deviceId, leased.fencingToken, runtime);
		const lease = fakeRollbackLease(scope, leaseBinding, leased.revision);
		const fixedMetadata = await kit.fixedFileMetadata(summary.id, appended[0].id);
		const claim = await journal.claimApply(ctx, fixedMetadata, lease);
		expect(claim.mayExecute).toBe(true);
		const applyReceipt: FileChangeExecutionReceipt = {
			receiptId: `receipt-apply-${idempotencyKey}`,
			mutationId: claim.mutationId,
			requestDigest: claim.requestDigest,
			executionBinding: leaseBinding,
			confirmed: true,
			observedAfter: file.desired,
			outcome: "applied",
		};
		expect((await journal.recordApplyReceipt(ctx, claim.file.id, applyReceipt)).status).toBe(
			"verified",
		);
		expect((await journal.finishFiles(ctx)).status).toBe("files_verified");
		return {
			header,
			file,
			proof,
			summary,
			ctx,
			claim,
			applyReceipt,
			lease,
			fixedMetadata,
			appended,
			started,
			leaseBinding,
		};
	};

	// ── plan A: idempotency and the commit path ──
	const a = await toFilesVerified("revert-flow-A");
	// Idempotent begin: same input, same row.
	expect((await plan.begin({ ...a.header, plan: planRef, manifestProof: a.proof })).id).toBe(
		a.summary.id,
	);
	projection.conflictingBegin = await captureError(() =>
		plan.begin({
			...a.header,
			requestDigest: digestOf("changed-request"),
			plan: planRef,
			manifestProof: { ...a.proof, headerDigest: digestOf("else") },
		}),
	);
	// Re-claiming returns the original binding, never a second dispatch grant.
	const reclaim = await journal.claimApply(a.ctx, a.fixedMetadata, a.lease);
	expect(reclaim.mayExecute).toBe(false);
	expect(reclaim.file.id).toBe(a.claim.file.id);
	// A DIFFERENT receipt over the durable one is a conflict, on both backends.
	projection.conflictingReceipt = await captureError(() =>
		journal.recordApplyReceipt(a.ctx, a.claim.file.id, {
			...a.applyReceipt,
			receiptId: "other",
		}),
	);

	const historyProbe: HistoryProbe = { calls: () => probe.calls, apply: () => probe.calls++ };
	const probe = { calls: 0 };
	const committed = await journal.commit(a.ctx, historyProbe);
	expect(committed.status).toBe("committed");
	expect(probe.calls).toBe(1);
	// An already committed retry never calls history a second time.
	expect((await journal.commit(a.ctx, historyProbe)).status).toBe("committed");
	expect(probe.calls).toBe(1);
	projection.historyWritesCommitted = await kit.historyWriteVisible();

	// ── plan B: the compensation path (never committed) ──
	const b = await toFilesVerified("revert-flow-B");
	await journal.beginCompensation(b.ctx);
	const claimC = await journal.claimCompensate(b.ctx, b.fixedMetadata, b.lease);
	expect(claimC.mayExecute).toBe(true);
	const compensateReceipt: FileChangeExecutionReceipt = {
		receiptId: "receipt-compensate",
		mutationId: claimC.mutationId,
		requestDigest: claimC.requestDigest,
		executionBinding: b.leaseBinding,
		confirmed: true,
		observedAfter: b.file.expected,
		outcome: "applied",
	};
	expect(
		(await journal.recordCompensateReceipt(b.ctx, claimC.file.id, compensateReceipt)).status,
	).toBe("compensated");
	expect((await journal.finishCompensation(b.ctx)).status).toBe("compensated");

	projection.operationA = await kit.readRevertOperation(a.summary.id);
	projection.operationB = await kit.readRevertOperation(b.summary.id);
	return projection;
}
