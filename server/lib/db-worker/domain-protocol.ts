import type { readPublicationTerminalResultTask } from "../../services/agent-runtime/publication-reader";
import type { ComposerDocumentMetadata, ComposerDocumentParams } from "./composer-document-query";
import { DbReadError } from "./errors";
import type { readEditorOperationEvidence, readRevertPlan } from "./file-read-snapshots";
import type { readIntegrationAuthoritySnapshotTask } from "./integration-authority-read-task";
import type { readKnowledgeEntryDetail } from "./knowledge-entry-reader";
import type { ReadBudgetMeter } from "./read-budget";
import type { readRecallConversation, readRecallToolCallDetail } from "./recall-reader";
import type { ToolDetailMetadata, ToolDetailSnapshotParams } from "./tool-detail-query";
import { TOOL_DETAIL_PAYLOAD_BYTE_LIMIT } from "./tool-detail-selection";

export const DOMAIN_READ_STREAM_CHUNK_BYTES = 64 * 1024;
export const DOMAIN_READ_STREAM_TIMEOUT_MS = 30_000;
export const COMPOSER_DOCUMENT_RESULT_BYTES = 24 * 1024 * 1024;

interface SyncDomainReadTaskMap {
	publicationTerminalResult: {
		params: Parameters<typeof readPublicationTerminalResultTask>[1];
		result: ReturnType<typeof readPublicationTerminalResultTask>;
	};
	knowledgeEntryDetail: {
		params: Parameters<typeof readKnowledgeEntryDetail>[1];
		result: ReturnType<typeof readKnowledgeEntryDetail>;
	};
	recallConversation: {
		params: Parameters<typeof readRecallConversation>[1];
		result: ReturnType<typeof readRecallConversation>;
	};
	recallToolCallDetail: {
		params: Parameters<typeof readRecallToolCallDetail>[1];
		result: ReturnType<typeof readRecallToolCallDetail>;
	};
	editorOperationEvidence: {
		params: Parameters<typeof readEditorOperationEvidence>[1];
		result: ReturnType<typeof readEditorOperationEvidence>;
	};
	revertPlanSnapshot: {
		params: Parameters<typeof readRevertPlan>[1];
		result: ReturnType<typeof readRevertPlan>;
	};
	readerProbe: { params: null; result: { ready: true } };
	platformIntegrationAuthoritySnapshot: {
		params: Parameters<typeof readIntegrationAuthoritySnapshotTask>[1];
		result: ReturnType<typeof readIntegrationAuthoritySnapshotTask>;
	};
}
interface StreamDomainReadTaskMap {
	composerDocument: { params: ComposerDocumentParams; result: ComposerDocumentMetadata };
	toolDetailSnapshot: { params: ToolDetailSnapshotParams; result: ToolDetailMetadata };
}
export type DomainReadTaskMap = SyncDomainReadTaskMap & StreamDomainReadTaskMap;
export type SyncDomainReadTaskKind = keyof SyncDomainReadTaskMap;
export type StreamDomainReadTaskKind = keyof StreamDomainReadTaskMap;
export type DomainReadTaskKind = keyof DomainReadTaskMap;
export type DomainReadParams = {
	[K in DomainReadTaskKind]: { kind: "domainRead"; task: K; input: DomainReadTaskMap[K]["params"] };
}[DomainReadTaskKind];
export type DomainReadStreamParams = Extract<DomainReadParams, { task: StreamDomainReadTaskKind }>;
export interface DomainReadStreamContext {
	signal: AbortSignal;
	deadlineAt: number;
	emit(bytes: Uint8Array): Promise<void>;
}
export interface DomainReadStreamResult<T = unknown> {
	metadata: T;
	bytes: number;
	chunks: number;
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
export function validateIntegrationAuthorityInput(
	input: unknown,
): input is DomainReadTaskMap["platformIntegrationAuthoritySnapshot"]["params"] {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const value = input as Record<string, unknown>;
	if (
		Object.keys(value).length !== 3 ||
		!["authorityId", "includeExpired", "now"].every((key) => Object.hasOwn(value, key)) ||
		typeof value.authorityId !== "string" ||
		value.authorityId.trim().length === 0 ||
		Buffer.byteLength(value.authorityId) > 256 ||
		Array.from(value.authorityId).some((char) => [0, 10, 13].includes(char.charCodeAt(0))) ||
		typeof value.includeExpired !== "boolean" ||
		typeof value.now !== "string" ||
		value.now.length > 40
	)
		return false;
	return (
		/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(
			value.now,
		) && Number.isFinite(Date.parse(value.now))
	);
}
const boundedId = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	Buffer.byteLength(value) <= 256 &&
	!value.includes("\0");
const nullableId = (value: unknown) => value === null || boundedId(value);
const isId = (value: unknown) => typeof value === "string" && value.length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const isReferenceId = (value: unknown) =>
	value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 128);

export const DOMAIN_STREAM_BYTE_LIMITS = {
	composerDocument: COMPOSER_DOCUMENT_RESULT_BYTES,
	// The stored-row cap still applies before projection. JSON escaping and repeated
	// execution-target fields can expand the encoded representation. Allow for both,
	// plus the fixed field names, without lowering the original stored-row cap.
	toolDetailSnapshot: 32 * TOOL_DETAIL_PAYLOAD_BYTE_LIMIT + 128 * 1024,
} satisfies Record<StreamDomainReadTaskKind, number>;

export function isDomainReadStreamTask(params: {
	kind: string;
	task?: unknown;
}): params is DomainReadStreamParams {
	return (
		params.kind === "domainRead" &&
		typeof params.task === "string" &&
		Object.hasOwn(DOMAIN_STREAM_BYTE_LIMITS, params.task)
	);
}

export const DOMAIN_READ_DEFINITIONS: { [K in DomainReadTaskKind]: DomainDefinition } = {
	publicationTerminalResult: {
		maxInputBytes: 4096,
		maxResultBytes: 65536,
		maxArrayItems: 128,
		validate: (input) => {
			if (
				!record(input) ||
				Object.keys(input).some(
					(key) => key !== "run" && key !== "options" && key !== "fromBlocks",
				) ||
				typeof input.fromBlocks !== "boolean" ||
				!record(input.run) ||
				Object.keys(input.run).length !== 4
			)
				return false;
			const run = input.run;
			if (
				(run.producerKind !== "agent" && run.producerKind !== "bash") ||
				!boundedId(run.taskId) ||
				!boundedId(run.logicalRunId) ||
				!boundedId(run.recipientId)
			)
				return false;
			if (input.options === undefined) return true;
			return (
				record(input.options) &&
				Object.keys(input.options).every(
					(key) => key === "settledRunId" || key === "includeEventKind",
				) &&
				(input.options.settledRunId === undefined || boundedId(input.options.settledRunId)) &&
				(input.options.includeEventKind === undefined ||
					typeof input.options.includeEventKind === "boolean")
			);
		},
	},
	knowledgeEntryDetail: {
		maxInputBytes: 1024,
		maxResultBytes: 132 * 1024 * 1024,
		maxArrayItems: 10_000,
		validate: (input) =>
			record(input) && Object.keys(input).length === 1 && boundedId(input.entryId),
	},
	recallToolCallDetail: {
		maxInputBytes: 1024,
		maxResultBytes: 40 * 1024 * 1024,
		maxArrayItems: 10_000,
		validate: (input) =>
			record(input) &&
			Object.keys(input).length === 2 &&
			boundedId(input.toolCallId) &&
			nullableId(input.narratorId),
	},
	recallConversation: {
		maxInputBytes: 1024,
		maxResultBytes: 4 * 1024 * 1024,
		maxArrayItems: 10_000,
		validate: (input) =>
			record(input) &&
			Object.keys(input).length === 3 &&
			boundedId(input.narratorId) &&
			nullableId(input.messageId) &&
			Number.isInteger(input.limit) &&
			Number(input.limit) >= 1 &&
			Number(input.limit) <= 50,
	},
	editorOperationEvidence: {
		maxInputBytes: 2048,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10000,
		validate: (input) =>
			record(input) && boundedId(input.sourceInstanceId) && boundedId(input.sourceId),
	},
	revertPlanSnapshot: {
		maxInputBytes: 4096,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10000,
		validate: (input) =>
			record(input) &&
			record(input.owner) &&
			boundedId(input.owner.subjectKey) &&
			nullableId(input.owner.narratorId) &&
			nullableId(input.owner.projectId) &&
			boundedId(input.planId) &&
			nullableId(input.cursor) &&
			Number.isInteger(input.limit) &&
			Number(input.limit) >= 0 &&
			Number(input.limit) <= 101,
	},
	readerProbe: {
		maxInputBytes: 128 * 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: (input) => input === null,
	},
	platformIntegrationAuthoritySnapshot: {
		maxInputBytes: 4096,
		maxResultBytes: 24 * 1024 * 1024,
		maxArrayItems: 2001,
		validate: validateIntegrationAuthorityInput,
	},
	composerDocument: {
		maxInputBytes: 128 * 1024,
		maxResultBytes: 128 * 1024,
		maxArrayItems: 0,
		validate: (input) =>
			record(input) &&
			isId(input.narratorId) &&
			isId(input.messageId) &&
			typeof input.blockReads === "boolean",
	},
	toolDetailSnapshot: {
		maxInputBytes: 128 * 1024,
		maxResultBytes: 128 * 1024,
		maxArrayItems: 128,
		validate: (input) =>
			record(input) &&
			isId(input.narratorId) &&
			isId(input.toolUseId) &&
			record(input.reference) &&
			isReferenceId(input.reference.toolCallId) &&
			isReferenceId(input.reference.messageId) &&
			Array.isArray(input.columns) &&
			input.columns.length > 0 &&
			input.columns.length <= 128 &&
			input.columns.every(
				(column) =>
					record(column) &&
					isId(column.key) &&
					isId(column.name) &&
					typeof column.type === "string" &&
					typeof column.virtual === "boolean",
			),
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
	const bytes = checkDomainBudget(
		params.input,
		definition.maxInputBytes,
		definition.maxInputArrayItems ?? definition.maxArrayItems,
		meter,
		"input",
	);
	if (isDomainReadStreamTask(params) && bytes > definition.maxInputBytes)
		throw new DbReadError("DB_READ_BUDGET", "Domain stream exceeded its input byte budget");
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
