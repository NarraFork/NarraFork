import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type { ModelHistorySignature } from "../../services/agent-runtime/model-history-revision";
import type { readPublicationTerminalResultTask } from "../../services/agent-runtime/publication-reader";
import { BENCHMARK_SUITE_SNAPSHOT_MAX_BYTES } from "../../services/benchmark-limits";
import type { readBenchmarkSuiteSnapshot } from "../../services/benchmark-read";
import type { readExecutionLogFacetsTask } from "../../services/execution-log-reader";
import type { readExecutionPolicyFacts } from "../../services/execution-policy/facts-reader";
import type {
	readEditorOperationEvidence,
	readFileBlobCatalog,
	readRevertPlan,
	readRevertSelectionBody,
} from "../../services/file-read-snapshots";
import type { readGitCurrentDiffEvidence } from "../../services/git-current-diff-reader";
import type { readIntegrationAuthoritySnapshotTask } from "../../services/integration-authority-read-task";
import type { readKnowledgeEntryDetail } from "../../services/knowledge/entry-reader";
import type { readNarratorMessageRowsSnapshot } from "../../services/narrator-message-snapshot-reader";
import type {
	NarratorAggregateRefsParams,
	NarratorAggregateRefsResult,
	NarratorAggregateScopeParams,
	NarratorAggregateScopeResult,
	NarratorCompactReadParams,
	NarratorCompactReadResult,
	NarratorToolDetailResult,
	NarratorToolPreviewResult,
	NarratorToolReadParams,
} from "../../services/narrator-read-snapshots";
import type { readNarratorToolRowsSnapshot } from "../../services/narrator-tool-snapshot-reader";
import type {
	RecallConversationSnapshot,
	RecallToolCallRow,
} from "../../services/search/recall-reader";
import type { readContinuationRecoveryPageTask } from "../../services/tool-continuation-reader";
import type { readToolEditEvidence } from "../../services/tool-edit-preview-reader";
import { NARRATOR_MESSAGE_RESULT_MAX_BYTES } from "./domain-limits";
import { DbReadError } from "./errors";
import type { ReadBudgetMeter } from "./read-budget";

type DomainResult<T> = T extends (...args: never[]) => infer R ? Awaited<R> : never;

/** Extend the map, fixed definition and fixed lazy handler registry together. No module paths on wire. */
export const DOMAIN_READ_STREAM_MAX_CHUNK_BYTES = 64 * 1024;
export const DOMAIN_READ_STREAM_TIMEOUT_MS = 30_000;
export type DomainReadStreamKind = "benchmarkSuiteListSnapshot";
export interface DomainReadStreamContext {
	signal: AbortSignal;
	deadlineAt: number;
	emit(bytes: Uint8Array): Promise<void>;
}
export interface DomainReadStreamResult {
	rowCount: number;
	bytes: number;
	chunks: number;
}
export interface DomainReadTaskMap {
	narratorBodyTexts: {
		params: import("../../services/narrator-message-snapshot-reader").NarratorBodyTextsParams;
		result: ReturnType<
			typeof import("../../services/narrator-message-snapshot-reader").readNarratorBodyTextsSnapshot
		>;
	};
	benchmarkMetricsSnapshot: {
		params: Parameters<
			typeof import("../../services/benchmark-read").readBenchmarkMetricsSnapshot
		>[1];
		result: ReturnType<typeof import("../../services/benchmark-read").readBenchmarkMetricsSnapshot>;
	};
	databaseCleanupContext: {
		params: Record<string, never>;
		result: ReturnType<
			typeof import("../../services/database-cleanup-read").readDatabaseCleanupContext
		>;
	};
	revertSelectionBodyVerify: {
		params: Parameters<
			typeof import("../../services/file-read-snapshots").readRevertSelectionBodyVerify
		>[1];
		result: ReturnType<
			typeof import("../../services/file-read-snapshots").readRevertSelectionBodyVerify
		>;
	};
	benchmarkSuiteListSnapshot: { params: Record<string, never>; result: DomainReadStreamResult };
	benchmarkSuiteSnapshot: {
		params: Parameters<typeof readBenchmarkSuiteSnapshot>[1];
		result: DomainResult<typeof readBenchmarkSuiteSnapshot>;
	};
	narratorToolRows: {
		params: Parameters<typeof readNarratorToolRowsSnapshot>[1];
		result: DomainResult<typeof readNarratorToolRowsSnapshot>;
	};
	executionPolicyFacts: {
		params: Parameters<typeof readExecutionPolicyFacts>[1];
		result: DomainResult<typeof readExecutionPolicyFacts>;
	};
	readerProbe: { params: null; result: { ready: true } };
	recallToolCallDetail: { params: RecallToolCallDetailParams; result: RecallToolCallRow | null };
	recallConversation: { params: RecallConversationParams; result: RecallConversationSnapshot };
	modelHistorySignature: { params: ModelHistorySignatureParams; result: ModelHistorySignature };
	publicationTerminalResult: {
		params: Parameters<typeof readPublicationTerminalResultTask>[1];
		result: DomainResult<typeof readPublicationTerminalResultTask>;
	};
	narratorAggregateScope: {
		params: NarratorAggregateScopeParams;
		result: NarratorAggregateScopeResult;
	};
	narratorAggregateRefs: {
		params: NarratorAggregateRefsParams;
		result: NarratorAggregateRefsResult;
	};
	narratorToolDetail: { params: NarratorToolReadParams; result: NarratorToolDetailResult };
	narratorToolPreview: { params: NarratorToolReadParams; result: NarratorToolPreviewResult };
	narratorCompactSummary: { params: NarratorCompactReadParams; result: NarratorCompactReadResult };
	knowledgeEntryDetail: {
		params: Parameters<typeof readKnowledgeEntryDetail>[1];
		result: DomainResult<typeof readKnowledgeEntryDetail>;
	};
	gitCurrentDiffEvidence: {
		params: Parameters<typeof readGitCurrentDiffEvidence>[1];
		result: DomainResult<typeof readGitCurrentDiffEvidence>;
	};
	fileBlobCatalogSnapshot: {
		params: Parameters<typeof readFileBlobCatalog>[1];
		result: DomainResult<typeof readFileBlobCatalog>;
	};
	revertPlanSnapshot: {
		params: Parameters<typeof readRevertPlan>[1];
		result: DomainResult<typeof readRevertPlan>;
	};
	revertSelectionBody: {
		params: Parameters<typeof readRevertSelectionBody>[1];
		result: DomainResult<typeof readRevertSelectionBody>;
	};
	narratorMessageRows: {
		params: Parameters<typeof readNarratorMessageRowsSnapshot>[1];
		result: DomainResult<typeof readNarratorMessageRowsSnapshot>;
	};
	executionLogFacets: {
		params: Parameters<typeof readExecutionLogFacetsTask>[1];
		result: DomainResult<typeof readExecutionLogFacetsTask>;
	};
	continuationRecoveryPage: {
		params: Parameters<typeof readContinuationRecoveryPageTask>[1];
		result: DomainResult<typeof readContinuationRecoveryPageTask>;
	};
	platformIntegrationAuthoritySnapshot: {
		params: Parameters<typeof readIntegrationAuthoritySnapshotTask>[1];
		result: DomainResult<typeof readIntegrationAuthoritySnapshotTask>;
	};
	toolEditEvidenceSnapshot: {
		params: Parameters<typeof readToolEditEvidence>[1];
		result: DomainResult<typeof readToolEditEvidence>;
	};
	editorOperationEvidence: {
		params: Parameters<typeof readEditorOperationEvidence>[1];
		result: DomainResult<typeof readEditorOperationEvidence>;
	};
}
export type DomainReadTaskKind = keyof DomainReadTaskMap;
export type SyncDomainReadTaskKind = Exclude<DomainReadTaskKind, DomainReadStreamKind>;
export function isDomainReadStreamTask(params: {
	kind: string;
	task?: unknown;
}): params is Extract<DomainReadParams, { task: DomainReadStreamKind }> {
	return params.kind === "domainRead" && params.task === "benchmarkSuiteListSnapshot";
}
export type DomainReadParams = {
	[K in DomainReadTaskKind]: { kind: "domainRead"; task: K; input: DomainReadTaskMap[K]["params"] };
}[DomainReadTaskKind];
export interface RecallToolCallDetailParams {
	toolCallId: string;
	narratorId: string | null;
}
export interface RecallConversationParams {
	narratorId: string;
	messageId: string | null;
	limit: number;
}
export interface ModelHistorySignatureParams {
	narratorId: string;
}

function domainId(value: unknown, max = 256): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= max && value.trim().length > 0
	);
}
function pointer(value: unknown): value is string {
	return domainId(value) && Buffer.byteLength(value) <= 256;
}
function shape(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): input is Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	return (
		required.every((key) => Object.hasOwn(input, key)) &&
		Object.keys(input).every((key) => required.includes(key) || optional.includes(key))
	);
}
function ids(input: unknown, max = 500): input is string[] {
	if (!Array.isArray(input) || input.length > max) return false;
	for (const value of input) if (!domainId(value)) return false;
	return true;
}
export function validateRecallToolCallDetailInput(
	input: unknown,
): input is RecallToolCallDetailParams {
	return (
		shape(input, ["toolCallId", "narratorId"]) &&
		domainId(input.toolCallId) &&
		(input.narratorId === null || domainId(input.narratorId))
	);
}
export function validateRecallConversationInput(input: unknown): input is RecallConversationParams {
	return (
		shape(input, ["narratorId", "messageId", "limit"]) &&
		domainId(input.narratorId) &&
		(input.messageId === null || domainId(input.messageId)) &&
		typeof input.limit === "number" &&
		Number.isInteger(input.limit) &&
		input.limit >= 1 &&
		input.limit <= 50
	);
}
export function validateModelHistorySignatureInput(
	input: unknown,
): input is ModelHistorySignatureParams {
	return shape(input, ["narratorId"]) && pointer(input.narratorId);
}
export function validatePublicationTerminalResultInput(
	input: unknown,
): input is DomainReadTaskMap["publicationTerminalResult"]["params"] {
	if (
		!shape(input, ["run"], ["options"]) ||
		!shape(input.run, ["producerKind", "taskId", "logicalRunId", "recipientId"])
	)
		return false;
	const run = input.run;
	if (
		(run.producerKind !== "agent" && run.producerKind !== "bash") ||
		!pointer(run.taskId) ||
		!pointer(run.logicalRunId) ||
		!pointer(run.recipientId)
	)
		return false;
	if (input.options === undefined) return true;
	return (
		shape(input.options, [], ["settledRunId", "includeEventKind"]) &&
		(input.options.settledRunId === undefined || pointer(input.options.settledRunId)) &&
		(input.options.includeEventKind === undefined ||
			typeof input.options.includeEventKind === "boolean")
	);
}
export function validateNarratorAggregateScopeInput(
	input: unknown,
): input is NarratorAggregateScopeParams {
	return (
		shape(input, ["narratorId", "toolUseIds"]) &&
		domainId(input.narratorId) &&
		ids(input.toolUseIds)
	);
}
export function validateNarratorAggregateRefsInput(
	input: unknown,
): input is NarratorAggregateRefsParams {
	return (
		shape(input, ["narratorId", "messageIds"]) &&
		domainId(input.narratorId) &&
		ids(input.messageIds)
	);
}
export function validateNarratorToolInput(input: unknown): input is NarratorToolReadParams {
	if (
		!shape(input, ["narratorId", "toolUseId", "reference"]) ||
		!domainId(input.narratorId) ||
		!domainId(input.toolUseId)
	)
		return false;
	if (input.reference === null) return true;
	return (
		shape(input.reference, [], ["toolCallId", "messageId", "executionAttempt"]) &&
		Object.entries(input.reference).every(([key, value]) =>
			key === "executionAttempt" ? integer(value, Number.MAX_SAFE_INTEGER) : domainId(value, 128),
		)
	);
}
export function validateNarratorCompactInput(input: unknown): input is NarratorCompactReadParams {
	return (
		shape(input, ["narratorId", "messageId"]) &&
		domainId(input.narratorId) &&
		domainId(input.messageId)
	);
}
function hexDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}
function integer(value: unknown, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
export function validateKnowledgeEntryInput(
	input: unknown,
): input is DomainReadTaskMap["knowledgeEntryDetail"]["params"] {
	return shape(input, ["entryId"]) && domainId(input.entryId);
}
export function validateGitEvidenceInput(
	input: unknown,
): input is DomainReadTaskMap["gitCurrentDiffEvidence"]["params"] {
	if (
		!shape(input, ["baseline"]) ||
		!input.baseline ||
		typeof input.baseline !== "object" ||
		Array.isArray(input.baseline)
	)
		return false;
	const baseline = input.baseline as Record<string, unknown>;
	if (
		(baseline.sourceInstanceId !== null && typeof baseline.sourceInstanceId !== "string") ||
		!text(baseline.canonicalRoot, 8192) ||
		typeof baseline.rootIdentity !== "string" ||
		!Array.isArray(baseline.files) ||
		baseline.files.length > 200
	)
		return false;
	for (const file of baseline.files)
		if (
			!file ||
			typeof file !== "object" ||
			!text(file.filePath, 8192) ||
			!text(file.canonicalPath, 8192)
		)
			return false;
	return true;
}
export function validateFileBlobInput(
	input: unknown,
): input is DomainReadTaskMap["fileBlobCatalogSnapshot"]["params"] {
	if (
		!shape(input, ["kind", "digest", "status", "after", "limit"]) ||
		(input.kind !== "budget" && input.kind !== "metadata" && input.kind !== "reservations") ||
		(input.digest !== null && !hexDigest(input.digest)) ||
		(input.status !== null &&
			input.status !== "reserved" &&
			input.status !== "reconcile_required") ||
		!integer(input.limit, 100)
	)
		return false;
	return (
		input.after === null ||
		(shape(input.after, ["createdAt", "id"]) &&
			text(input.after.createdAt, 256) &&
			pointer(input.after.id))
	);
}
export function validateRevertPlanInput(
	input: unknown,
): input is DomainReadTaskMap["revertPlanSnapshot"]["params"] {
	return (
		shape(input, ["owner", "planId", "cursor", "limit"]) &&
		shape(input.owner, ["subjectKey", "narratorId", "projectId"]) &&
		text(input.owner.subjectKey, 1024) &&
		(input.owner.narratorId === null || pointer(input.owner.narratorId)) &&
		(input.owner.projectId === null || pointer(input.owner.projectId)) &&
		pointer(input.planId) &&
		(input.cursor === null || hexDigest(input.cursor)) &&
		integer(input.limit, 101)
	);
}
export function validateRevertBodyInput(
	input: unknown,
): input is DomainReadTaskMap["revertSelectionBody"]["params"] {
	return (
		shape(input, ["id", "contentBytes", "digestOnly"]) &&
		pointer(input.id) &&
		integer(input.contentBytes, FILE_CHANGE_LIMITS.historyCowBytes) &&
		typeof input.digestOnly === "boolean"
	);
}
function pointerList(value: unknown, max: number, min = 0): value is string[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) return false;
	for (const item of value) if (!pointer(item)) return false;
	return true;
}
export function validateNarratorMessageRowsInput(
	input: unknown,
): input is DomainReadTaskMap["narratorMessageRows"]["params"] {
	return (
		shape(input, ["messageIds", "includeTools", "includeCreator"]) &&
		ids(input.messageIds, 128) &&
		typeof input.includeTools === "boolean" &&
		typeof input.includeCreator === "boolean"
	);
}
export function validateExecutionLogFacetsInput(
	input: unknown,
): input is DomainReadTaskMap["executionLogFacets"]["params"] {
	return shape(input, []);
}
export function validateContinuationRecoveryInput(
	input: unknown,
): input is DomainReadTaskMap["continuationRecoveryPage"]["params"] {
	if (
		!shape(input, ["epochs", "rows"]) ||
		!pointerList(input.epochs, 65, 1) ||
		!Array.isArray(input.rows) ||
		input.rows.length < 1 ||
		input.rows.length > 40
	)
		return false;
	let total = 0;
	const maximum = 16 * 1024 * 1024;
	for (const row of input.rows) {
		if (
			!shape(row, ["id", "bytes", "inputBytes", "contentBytes"]) ||
			!pointer(row.id) ||
			!integer(row.bytes, 65536) ||
			!integer(row.inputBytes, maximum) ||
			!integer(row.contentBytes, maximum)
		)
			return false;
		total += row.bytes + row.inputBytes + row.contentBytes;
		if (total > maximum) return false;
	}
	return true;
}
export function validateNarratorToolRowsInput(
	input: unknown,
): input is DomainReadTaskMap["narratorToolRows"]["params"] {
	return shape(input, ["toolCallIds"]) && ids(input.toolCallIds, 128);
}
export function validateToolEditEvidenceInput(
	input: unknown,
): input is DomainReadTaskMap["toolEditEvidenceSnapshot"]["params"] {
	return shape(input, ["toolCallId"]) && pointer(input.toolCallId);
}
export function validateEditorOperationInput(
	input: unknown,
): input is DomainReadTaskMap["editorOperationEvidence"]["params"] {
	return (
		shape(input, ["sourceInstanceId", "sourceId"]) &&
		pointer(input.sourceInstanceId) &&
		pointer(input.sourceId)
	);
}
export function validateIntegrationAuthorityInput(
	input: unknown,
): input is DomainReadTaskMap["platformIntegrationAuthoritySnapshot"]["params"] {
	if (
		!shape(input, ["authorityId", "includeExpired", "now"]) ||
		!pointer(input.authorityId) ||
		Array.from(input.authorityId).some((char) => [0, 10, 13].includes(char.charCodeAt(0))) ||
		typeof input.includeExpired !== "boolean" ||
		typeof input.now !== "string" ||
		input.now.length > 40
	)
		return false;
	return (
		/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(
			input.now,
		) && Number.isFinite(Date.parse(input.now))
	);
}
export function validateBenchmarkSuiteInput(
	input: unknown,
): input is DomainReadTaskMap["benchmarkSuiteSnapshot"]["params"] {
	return (
		shape(input, ["suiteId", "format"]) &&
		pointer(input.suiteId) &&
		(input.format === "raw" || input.format === "json")
	);
}
export function validateRevertBodyVerifyInput(
	input: unknown,
): input is DomainReadTaskMap["revertSelectionBodyVerify"]["params"] {
	if (!shape(input, ["entries"]) || !Array.isArray(input.entries) || input.entries.length > 16)
		return false;
	let bytes = 0;
	for (const entry of input.entries) {
		if (
			!shape(entry, ["id", "contentBytes", "digest"]) ||
			!pointer(entry.id) ||
			!integer(entry.contentBytes, 4 * 1024 * 1024) ||
			!hexDigest(entry.digest)
		)
			return false;
		bytes += entry.contentBytes;
		if (bytes > 4 * 1024 * 1024) return false;
	}
	return true;
}
export function validateDatabaseCleanupInput(
	input: unknown,
): input is DomainReadTaskMap["databaseCleanupContext"]["params"] {
	return shape(input, []);
}
export function validateDatabaseCleanupResult(
	result: unknown,
): result is DomainReadTaskMap["databaseCleanupContext"]["result"] {
	return (
		shape(result, ["narrators", "runningTerminalIds", "liveTeamIds"]) &&
		Array.isArray(result.narrators) &&
		result.narrators.every((row) => !!row && typeof row === "object" && !Array.isArray(row)) &&
		Array.isArray(result.runningTerminalIds) &&
		result.runningTerminalIds.every(pointer) &&
		Array.isArray(result.liveTeamIds) &&
		result.liveTeamIds.every(pointer)
	);
}
interface DomainDefinition {
	maxInputBytes: number;
	maxResultBytes: number;
	maxInputArrayItems?: number;
	maxArrayItems: number;
	validate(input: unknown): boolean;
	validateResult?(result: unknown): boolean;
}
const SNAPSHOT_BYTES = 4 * 1024 * 1024;
const DETAIL_BYTES = 40 * 1024 * 1024;
export const DOMAIN_READ_DEFINITIONS: { [K in DomainReadTaskKind]: DomainDefinition } = {
	narratorBodyTexts: {
		maxInputBytes: 64 * 1024,
		maxResultBytes: NARRATOR_MESSAGE_RESULT_MAX_BYTES,
		maxArrayItems: 128,
		validate: (input) => {
			if (!shape(input, ["entries"]) || !Array.isArray(input.entries) || input.entries.length > 128)
				return false;
			let bytes = 0;
			for (const entry of input.entries) {
				if (
					!shape(entry, ["id", "maxBytes"], ["exactBytes"]) ||
					!pointer(entry.id) ||
					!integer(entry.maxBytes, 128 * 1024 * 1024) ||
					(entry.exactBytes !== undefined &&
						(!integer(entry.exactBytes, entry.maxBytes) || entry.exactBytes < 0))
				)
					return false;
				bytes += entry.maxBytes;
				if (bytes > 128 * 1024 * 1024) return false;
			}
			return true;
		},
	},
	narratorToolRows: {
		maxInputBytes: 64 * 1024,
		maxResultBytes: 132 * 1024 * 1024,
		maxArrayItems: 10_000,
		validate: validateNarratorToolRowsInput,
	},
	executionPolicyFacts: {
		maxInputBytes: 1024,
		maxResultBytes: 256 * 1024 * 1024,
		maxArrayItems: 10_000,
		validate: validateModelHistorySignatureInput,
	},
	platformIntegrationAuthoritySnapshot: {
		maxInputBytes: 4096,
		maxResultBytes: 24 * 1024 * 1024,
		maxArrayItems: 2001,
		validate: validateIntegrationAuthorityInput,
	},
	toolEditEvidenceSnapshot: {
		maxInputBytes: 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateToolEditEvidenceInput,
	},
	editorOperationEvidence: {
		maxInputBytes: 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateEditorOperationInput,
	},
	benchmarkSuiteSnapshot: {
		maxInputBytes: 1024,
		maxResultBytes: BENCHMARK_SUITE_SNAPSHOT_MAX_BYTES,
		maxArrayItems: 10_000,
		validate: validateBenchmarkSuiteInput,
	},
	benchmarkSuiteListSnapshot: {
		maxInputBytes: 1024,
		maxResultBytes: 1024,
		maxArrayItems: 10_000,
		validate: (input) => shape(input, []),
	},
	revertSelectionBodyVerify: {
		maxInputBytes: 64 * 1024,
		maxResultBytes: 1024,
		maxArrayItems: 10_000,
		maxInputArrayItems: 16,
		validate: validateRevertBodyVerifyInput,
	},
	databaseCleanupContext: {
		maxInputBytes: 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateDatabaseCleanupInput,
		validateResult: validateDatabaseCleanupResult,
	},
	benchmarkMetricsSnapshot: {
		maxInputBytes: 1024,
		maxResultBytes: NARRATOR_MESSAGE_RESULT_MAX_BYTES,
		maxArrayItems: 10_000,
		validate: (input) => shape(input, ["narratorId"]) && pointer(input.narratorId),
	},
	readerProbe: {
		maxInputBytes: 128 * 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: (input) => input === null,
	},
	// Dedicated combined detail allowance, not a generic SELECT or tool-input size contract.
	recallToolCallDetail: {
		maxInputBytes: 1024,
		maxResultBytes: DETAIL_BYTES,
		maxArrayItems: 10_000,
		validate: validateRecallToolCallDetailInput,
	},
	recallConversation: {
		maxInputBytes: 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateRecallConversationInput,
	},
	modelHistorySignature: {
		maxInputBytes: 1024,
		maxResultBytes: 4096,
		maxArrayItems: 1,
		validate: validateModelHistorySignatureInput,
	},
	publicationTerminalResult: {
		maxInputBytes: 4096,
		maxResultBytes: 65536,
		maxArrayItems: 128,
		validate: validatePublicationTerminalResultInput,
	},
	narratorAggregateScope: {
		maxInputBytes: 128 * 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateNarratorAggregateScopeInput,
	},
	narratorAggregateRefs: {
		maxInputBytes: 128 * 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateNarratorAggregateRefsInput,
	},
	narratorToolDetail: {
		maxInputBytes: 2048,
		maxResultBytes: DETAIL_BYTES,
		maxArrayItems: 10_000,
		validate: validateNarratorToolInput,
	},
	narratorToolPreview: {
		maxInputBytes: 2048,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateNarratorToolInput,
	},
	narratorCompactSummary: {
		maxInputBytes: 1024,
		maxResultBytes: DETAIL_BYTES,
		maxArrayItems: 10_000,
		validate: validateNarratorCompactInput,
	},
	knowledgeEntryDetail: {
		maxInputBytes: 1024,
		maxResultBytes: 132 * 1024 * 1024,
		maxArrayItems: 10_000,
		validate: validateKnowledgeEntryInput,
	},
	gitCurrentDiffEvidence: {
		maxInputBytes: 2 * 1024 * 1024,
		maxResultBytes: 32 * 1024 * 1024,
		maxArrayItems: 10_000,
		validate: validateGitEvidenceInput,
	},
	fileBlobCatalogSnapshot: {
		maxInputBytes: 2048,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateFileBlobInput,
	},
	revertPlanSnapshot: {
		maxInputBytes: 2048,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: validateRevertPlanInput,
	},
	revertSelectionBody: {
		maxInputBytes: 1024,
		maxResultBytes: FILE_CHANGE_LIMITS.summaryBytes * 2,
		maxArrayItems: 10_000,
		validate: validateRevertBodyInput,
	},
	narratorMessageRows: {
		maxInputBytes: 64 * 1024,
		maxResultBytes: NARRATOR_MESSAGE_RESULT_MAX_BYTES,
		maxArrayItems: 10_000,
		validate: validateNarratorMessageRowsInput,
	},
	executionLogFacets: {
		maxInputBytes: 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 20000,
		validate: validateExecutionLogFacetsInput,
	},
	continuationRecoveryPage: {
		maxInputBytes: 32768,
		maxResultBytes: 34 * 1024 * 1024,
		maxInputArrayItems: 65,
		maxArrayItems: 40,
		validate: validateContinuationRecoveryInput,
	},
};
/** Validate structure before clone; numeric DTO budgets are observations, without serialization. */
export function checkDomainBudget(
	value: unknown,
	maxBytes: number,
	maxArrayItems: number,
	meter?: ReadBudgetMeter,
	phase: "input" | "result" = "result",
): number {
	let bytes = 0;
	const visiting = new Set<object>();
	const walk = (item: unknown, depth: number): void => {
		if (depth > 32)
			throw new DbReadError("DB_READ_BUDGET", "Domain read exceeded its nesting budget");
		bytes += 16;
		if (typeof item === "string") bytes += Buffer.byteLength(item);
		else if (item instanceof Uint8Array) bytes += item.byteLength;
		else if (item && typeof item === "object") {
			if (visiting.has(item)) throw new DbReadError("DB_READ_INVALID", "Invalid domain read value");
			if (Array.isArray(item))
				meter?.observe(
					phase === "input" ? "domainInputItems" : "domainResultItems",
					item.length,
					maxArrayItems,
					phase,
				);
			visiting.add(item);
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				bytes += Buffer.byteLength(key);
				walk((item as Record<string, unknown>)[key], depth + 1);
			}
			visiting.delete(item);
		} else if (typeof item === "function" || typeof item === "symbol")
			throw new DbReadError("DB_READ_INVALID", "Invalid domain read value");
		meter?.observe(
			phase === "input" ? "domainInputBytes" : "domainResultBytes",
			bytes,
			maxBytes,
			phase,
		);
	};
	walk(value, 0);
	return bytes;
}
export function validateDomainRead(
	params: DomainReadParams,
	meter?: ReadBudgetMeter,
): DomainDefinition {
	if (!Object.hasOwn(DOMAIN_READ_DEFINITIONS, params.task))
		throw new DbReadError("DB_READ_UNSUPPORTED", "Unregistered database read task");
	const definition = DOMAIN_READ_DEFINITIONS[params.task];
	checkDomainBudget(
		params.input,
		definition.maxInputBytes,
		definition.maxInputArrayItems ?? definition.maxArrayItems,
		meter,
		"input",
	);
	if (!definition.validate(params.input))
		throw new DbReadError("DB_READ_INVALID", "Invalid domain read parameters");
	return definition;
}
/** Keep generic task/input pairing checked before erasing it into the discriminated wire union. */
export function createDomainReadParams<K extends DomainReadTaskKind>(
	task: K,
	input: DomainReadTaskMap[K]["params"],
): DomainReadParams {
	const request = { kind: "domainRead", task, input } as DomainReadParams;
	validateDomainRead(request);
	return request;
}
