/**
 * File-change evidence is independent of the tool's execution status and of UI
 * attribution. Only actual, settled file effects may authorize an automatic undo.
 * No filesystem bytes, host-only storage paths, or provider payloads belong here.
 */
export const FILE_CHANGE_EVIDENCE_VERSION = 2;

export interface FileHistoryTarget {
	deviceId: string;
	pathFlavor: FileChangePathFlavor;
	canonicalPath: string;
}

const MIB = 1024 * 1024;

/** Shared admission budgets. Exceeding one never turns a prefix into complete evidence. */
export const FILE_CHANGE_LIMITS = Object.freeze({
	blobBytes: 32 * MIB,
	fileToolRequestBytes: 3 * 32 * MIB,
	fileToolRequestFields: 16,
	operationEvidenceBytes: 256 * MIB,
	streamChunkBytes: MIB,
	metadataBytes: 8 * 1024,
	previewFileBytes: MIB,
	summaryBytes: 256 * 1024,
	historyPageItems: 100,
	revertFiles: 1000,
	historyMessageRefChanges: 5000,
	historyToolRelatedChanges: 10_000,
	historyCowBytes: 4 * MIB,
	capturePaths: 100_000,
	captureCandidateBytes: 512 * MIB,
	captureConcurrency: 2,
	captureQueueItems: 64,
	planLifetimeMs: 10 * 60_000,
	blobSoftQuotaBytes: 5 * 1024 * MIB,
	minimumFreeBytes: 1024 * MIB,
	unreferencedGraceMs: 7 * 24 * 60 * 60_000,
	completedRevertRetentionMs: 30 * 24 * 60 * 60_000,
	remoteReceiptEntries: 100_000,
	remoteReceiptBytes: 64 * MIB,
});

/**
 * Message roles that never persist tool calls or disk operations.
 * Leftover sys/user/disp cards after an interrupt must not veto file coverage.
 */
export const NON_OPERATION_ROLES: ReadonlySet<string> = new Set([
	"sys",
	"disp",
	"system",
	"user",
]);

/** spec:// is deliberately not a disk-path flavor. */
export type FileChangePathFlavor = "posix" | "windows";

export interface FileChangeIdentity {
	sourceInstanceId: string;
	deviceId: string;
	workspaceInstanceId: string;
	scopeId: string;
	pathFlavor: FileChangePathFlavor;
	/** A symlink entry and the file it refers to are different recovery objects. */
	objectRole: "entry" | "referent";
	/** Uses the target backend's grammar, never the server's guess. */
	canonicalPath: string;
	lexicalPath: string;
	/** Presentation only; never use this field as a storage or authorization key. */
	displayPath: string;
}

/** A connection generation guards execution but does not split persistent identity. */
export interface FileChangeExecutionBinding {
	deviceId: string;
	runtimeEpoch: string;
	runtimeGeneration: number;
	fencingToken: number;
}

export type FileChangeActorKind = "human" | "primary" | "subagent" | "external_unknown";

export interface FileChangeActor {
	kind: FileChangeActorKind;
	/** Stable even when the linked narrator/user is deleted or anonymized. */
	subjectKey: string;
	narratorId: string | null;
	userId: string | null;
	label: string | null;
	deleted: boolean;
	parentSubjectKey: string | null;
}

export interface FileChangeBlobRef {
	algorithm: "sha256";
	digest: string;
	sizeBytes: number;
}

export type FileChangeUnavailableReason =
	| "legacy_unverified"
	| "capture_failed"
	| "capture_incomplete"
	| "capture_concurrent"
	| "missing_before"
	| "missing_after"
	| "unreadable"
	| "unsupported_object"
	| "unsupported_backend"
	| "target_unverified"
	| "result_unknown"
	| "content_changed"
	| "quota_exceeded"
	| "budget_exceeded"
	| "cancelled"
	| "expired"
	| "object_missing";

/** A known absence and an unobserved object can never share the same value. */
export type FileChangeState =
	| { kind: "absent" }
	| { kind: "regular"; blob: FileChangeBlobRef; mode: number | null }
	| { kind: "symlink"; target: FileChangeBlobRef; mode: number | null }
	| { kind: "unknown"; reason: FileChangeUnavailableReason };

export type KnownFileChangeState = Exclude<FileChangeState, { kind: "unknown" }>;

export type FileChangeCaptureCoverage = "complete" | "partial" | "unavailable" | "legacy_unknown";
export type FileChangeTemporalConsistency =
	| "platform_quiescent"
	| "concurrent_observation"
	| "unknown";

/** One scan attempt, NOT a property of the deduplicated tree object. */
export interface FileChangeCaptureReceipt {
	id: string;
	scopeId: string;
	startedAt: string;
	finishedAt: string | null;
	treeHash: string | null;
	snapshotCommitSha: string | null;
	coverage: FileChangeCaptureCoverage;
	temporalConsistency: FileChangeTemporalConsistency;
	policyVersion: number;
	ignorePolicyDigest: string | null;
	manifest: FileChangeBlobRef | null;
	omittedCount: number | null;
	reason: FileChangeUnavailableReason | null;
}

export type FileChangeExecutionOutcome = "running" | "succeeded" | "failed" | "interrupted";
export type FileChangeEffectOutcome = "pending" | "no_change" | "changed" | "unknown";
export type FileChangeSettlement =
	| "preparing"
	| "intent_durable"
	| "applying"
	| "settled"
	| "reconcile_required";
export type FileChangeAttributionGrade = "measured" | "observed_ambiguous" | "unknown";
export type FileChangeMutationPhase = "apply" | "compensate";

/** Durable backend acknowledgement; never reconstructed from matching current bytes. */
export interface FileChangeExecutionReceipt {
	receiptId: string;
	mutationId: string;
	requestDigest: string;
	executionBinding: FileChangeExecutionBinding;
	confirmed: boolean;
	observedAfter: FileChangeState;
	/** Whether this specific mutation reached disk, not the enclosing tool's exit status. */
	outcome: "applied" | "not_applied" | "unknown";
}

/** A revert phase binds its actual granted lease before dispatch. A missing
 * receipt remains pending/unknown; it is never inferred from matching disk bytes. */
export interface FileChangeRevertPhaseJournal {
	executionBinding: FileChangeExecutionBinding;
	receipt: FileChangeExecutionReceipt | null;
}

/** Apply and compensation are separate immutable acknowledgements. This envelope
 * is bounded metadata in revert_operation_files, not raw filesystem contents. */
export interface FileChangeRevertMutationJournal {
	version: 1;
	apply: FileChangeRevertPhaseJournal | null;
	compensate: FileChangeRevertPhaseJournal | null;
}

export interface FileChangeEffect {
	id: string;
	operationId: string;
	attempt: number;
	mutationId: string;
	requestDigest: string;
	phase: FileChangeMutationPhase;
	identity: FileChangeIdentity;
	before: FileChangeState;
	/** Bytes the actual encoder/replacer intended to write, not the model input. */
	intendedAfter: FileChangeState;
	/** Read/receipt result; may include an intervening external write. */
	observedAfter: FileChangeState;
	outcome: FileChangeEffectOutcome;
	settlement: FileChangeSettlement;
	attribution: FileChangeAttributionGrade;
	/** A matching current hash is not a substitute for this execution receipt. */
	executionConfirmed: boolean;
	/** Original immutable acknowledgement, when one was actually received. */
	executionReceipt?: FileChangeExecutionReceipt | null;
	linesAdded: number | null;
	linesRemoved: number | null;
}

export type FileChangeRevertScope = "narrator" | "workspace";
export type FileChangeRevertStatus =
	| "planned"
	| "prepared"
	| "applying"
	| "files_verified"
	| "committed"
	| "compensating"
	| "compensated"
	| "recovery_required"
	| "cancelled"
	| "expired";

export type FileChangeRevertSelector =
	| { kind: "all" }
	| { kind: "from_seq"; minSeq: number }
	| { kind: "messages"; messageIds: string[] }
	| { kind: "tool_calls"; toolCallIds: string[] }
	| { kind: "after_block"; messageId: string; keepThroughBlockIndex: number };

export type FileChangeRevertAction = "revert_files" | "rollback_to_block" | "delete_tool_block";

/** Bind a UI consent action to its immutable journal program, not an apply-time selector. */
export function fileChangeRevertActionMatches(
	action: FileChangeRevertAction,
	kind: string,
	selector: FileChangeRevertSelector,
): boolean {
	if (action === "revert_files")
		return kind === "revert" && (selector.kind === "all" || selector.kind === "from_seq");
	if (action === "rollback_to_block")
		return kind === "rollback_to_block" && selector.kind === "after_block";
	return (
		action === "delete_tool_block" &&
		kind === "history_delete" &&
		selector.kind === "tool_calls" &&
		selector.toolCallIds.length === 1
	);
}

/** An advisory about missing attribution evidence, not a claim that any files were reverted. */
export interface FileChangeEvidenceUncertaintyWarning {
	code: "WORKSPACE_SCOPE_EVIDENCE_UNCERTAIN";
	unknownCount: number;
	legacyCount: number;
	warningScanComplete: boolean;
	countsLowerBound: boolean;
	sampleFilePaths: string[];
}

/** Explicit incompleteness survives pagination, old data, and failed measurements. */
export interface FileChangeProjectionCompleteness {
	fileHistoryComplete: boolean;
	contributorsTruncated: boolean;
	countsLowerBound: boolean;
	warningScanComplete: boolean;
	asOfRevision: number | null;
}

export function isKnownFileChangeState(state: FileChangeState): state is KnownFileChangeState {
	return state.kind !== "unknown";
}

/** Compares known bytes/object metadata; unknown is never equal, even to itself. */
export function fileChangeStatesEqual(left: FileChangeState, right: FileChangeState): boolean {
	if (left.kind === "unknown" || right.kind === "unknown" || left.kind !== right.kind) return false;
	if (left.kind === "absent" && right.kind === "absent") return true;
	if (left.kind === "regular" && right.kind === "regular") {
		return left.mode === right.mode && blobRefsEqual(left.blob, right.blob);
	}
	if (left.kind === "symlink" && right.kind === "symlink") {
		return left.mode === right.mode && blobRefsEqual(left.target, right.target);
	}
	return false;
}

function blobRefsEqual(left: FileChangeBlobRef, right: FileChangeBlobRef): boolean {
	return (
		left.algorithm === right.algorithm &&
		left.digest === right.digest &&
		left.sizeBytes === right.sizeBytes
	);
}

/**
 * A positive, bound acknowledgement that THIS mutation never wrote. It proves
 * neither that the workspace stayed unchanged nor that the desired state exists.
 * In particular, a missing receipt or matching current bytes is not this proof.
 */
export function hasConfirmedNoFileChange(effect: FileChangeEffect): boolean {
	const receipt = effect.executionReceipt;
	return (
		effect.settlement === "settled" &&
		effect.outcome === "no_change" &&
		effect.executionConfirmed === true &&
		receipt?.confirmed === true &&
		receipt.outcome === "not_applied" &&
		receipt.mutationId === effect.mutationId &&
		receipt.requestDigest === effect.requestDigest &&
		receipt.executionBinding.deviceId === effect.identity.deviceId
	);
}

/** Necessary evidence prerequisites, not permission or a replacement for current-state checks. */
export function hasSettledMeasuredFileEffect(effect: FileChangeEffect): boolean {
	const receipt = effect.executionReceipt;
	return (
		effect.settlement === "settled" &&
		effect.executionConfirmed === true &&
		receipt?.confirmed === true &&
		receipt.outcome === "applied" &&
		receipt.mutationId === effect.mutationId &&
		receipt.requestDigest === effect.requestDigest &&
		receipt.executionBinding.deviceId === effect.identity.deviceId &&
		fileChangeStatesEqual(receipt.observedAfter, effect.observedAfter) &&
		effect.attribution === "measured" &&
		(effect.outcome === "changed" || effect.outcome === "no_change") &&
		isKnownFileChangeState(effect.before) &&
		fileChangeStatesEqual(effect.intendedAfter, effect.observedAfter) &&
		(effect.outcome === "no_change") === fileChangeStatesEqual(effect.before, effect.observedAfter)
	);
}
