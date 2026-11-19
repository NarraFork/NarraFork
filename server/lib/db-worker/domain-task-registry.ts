import type { Database } from "bun:sqlite";
import {
	checkDomainBudget,
	DOMAIN_READ_STREAM_MAX_CHUNK_BYTES,
	type DomainReadParams,
	type DomainReadStreamContext,
	type DomainReadStreamKind,
	type DomainReadStreamResult,
	type DomainReadTaskMap,
	isDomainReadStreamTask,
	type SyncDomainReadTaskKind,
	validateDomainRead,
} from "./domain-protocol";
import { DbReadError, readAborted } from "./errors";
import { SELECT_ROWS_MAX_BYTES, SELECT_ROWS_MAX_ROWS } from "./protocol";
import type { ReadBudgetMeter } from "./read-budget";

/** Module loading happens before the synchronous, bounded readonly transaction. */
export type DomainReadHandler<K extends SyncDomainReadTaskKind> = (
	sqlite: Database,
	input: DomainReadTaskMap[K]["params"],
	signal: AbortSignal,
	deadlineAt?: number,
) => DomainReadTaskMap[K]["result"];
interface DomainReadModule<K extends SyncDomainReadTaskKind> {
	read: DomainReadHandler<K>;
	validate?: (input: unknown) => boolean;
}
/** Every import is a fixed server-owned literal, never supplied by a task request. */
const loaders: { [K in SyncDomainReadTaskKind]: () => Promise<DomainReadModule<K>> } = {
	narratorBodyTexts: async () => {
		const module = await import("../../services/narrator-message-snapshot-reader");
		return {
			read: module.readNarratorBodyTextsSnapshot,
			validate: module.validateNarratorBodyTexts,
		};
	},
	databaseCleanupContext: async () => ({
		read: (await import("../../services/database-cleanup-read")).readDatabaseCleanupContext,
	}),
	narratorToolRows: async () => {
		const module = await import("../../services/narrator-tool-snapshot-reader");
		return { read: module.readNarratorToolRowsSnapshot, validate: module.validateNarratorToolRows };
	},
	executionPolicyFacts: async () => {
		const module = await import("../../services/execution-policy/facts-reader");
		return {
			read: module.readExecutionPolicyFacts,
			validate: module.validateExecutionPolicyFactsInput,
		};
	},
	platformIntegrationAuthoritySnapshot: async () => ({
		read: (await import("../../services/integration-authority-read-task"))
			.readIntegrationAuthoritySnapshotTask,
	}),
	toolEditEvidenceSnapshot: async () => ({
		read: (await import("../../services/tool-edit-preview-reader")).readToolEditEvidence,
	}),
	editorOperationEvidence: async () => ({
		read: (await import("../../services/file-read-snapshots")).readEditorOperationEvidence,
	}),
	benchmarkSuiteSnapshot: async () => {
		const module = await import("../../services/benchmark-read");
		return {
			read: module.readBenchmarkSuiteSnapshot,
			validate: module.validateBenchmarkSuiteSnapshotInput,
		};
	},
	revertSelectionBodyVerify: async () => {
		const module = await import("../../services/file-read-snapshots");
		return {
			read: module.readRevertSelectionBodyVerify,
			validate: module.validateRevertSelectionBodyVerify,
		};
	},
	benchmarkMetricsSnapshot: async () => {
		const module = await import("../../services/benchmark-read");
		return {
			read: module.readBenchmarkMetricsSnapshot,
			validate: module.validateBenchmarkMetricsSnapshotInput,
		};
	},
	readerProbe: async () => ({
		read: (sqlite) => {
			sqlite.query("SELECT 1").get();
			return { ready: true };
		},
	}),
	recallToolCallDetail: async () => ({
		read: (await import("../../services/search/recall-reader")).readRecallToolCallDetail,
	}),
	recallConversation: async () => ({
		read: (await import("../../services/search/recall-reader")).readRecallConversation,
	}),
	modelHistorySignature: async () => ({
		read: (await import("../../services/agent-runtime/model-history-revision"))
			.readModelHistorySignatureTask,
	}),
	publicationTerminalResult: async () => ({
		read: (await import("../../services/agent-runtime/publication-reader"))
			.readPublicationTerminalResultTask,
	}),
	narratorAggregateScope: async () => {
		const module = await import("../../services/narrator-read-snapshots");
		return {
			read: module.readNarratorAggregateScope,
			validate: module.validateNarratorAggregateScope,
		};
	},
	narratorAggregateRefs: async () => {
		const module = await import("../../services/narrator-read-snapshots");
		return {
			read: module.readNarratorAggregateRefs,
			validate: module.validateNarratorAggregateRefs,
		};
	},
	narratorToolDetail: async () => {
		const module = await import("../../services/narrator-read-snapshots");
		return { read: module.readNarratorToolDetail, validate: module.validateNarratorToolRead };
	},
	narratorToolPreview: async () => {
		const module = await import("../../services/narrator-read-snapshots");
		return { read: module.readNarratorToolPreview, validate: module.validateNarratorToolRead };
	},
	narratorCompactSummary: async () => {
		const module = await import("../../services/narrator-read-snapshots");
		return {
			read: module.readNarratorCompactSummary,
			validate: module.validateNarratorCompactRead,
		};
	},
	knowledgeEntryDetail: async () => ({
		read: (await import("../../services/knowledge/entry-reader")).readKnowledgeEntryDetail,
	}),
	gitCurrentDiffEvidence: async () => ({
		read: (await import("../../services/git-current-diff-reader")).readGitCurrentDiffEvidence,
	}),
	fileBlobCatalogSnapshot: async () => ({
		read: (await import("../../services/file-read-snapshots")).readFileBlobCatalog,
	}),
	revertPlanSnapshot: async () => ({
		read: (await import("../../services/file-read-snapshots")).readRevertPlan,
	}),
	revertSelectionBody: async () => ({
		read: (await import("../../services/file-read-snapshots")).readRevertSelectionBody,
	}),
	narratorMessageRows: async () => {
		const module = await import("../../services/narrator-message-snapshot-reader");
		return {
			read: module.readNarratorMessageRowsSnapshot,
			validate: module.validateNarratorMessageRows,
		};
	},
	executionLogFacets: async () => ({
		read: (await import("../../services/execution-log-reader")).readExecutionLogFacetsTask,
	}),
	continuationRecoveryPage: async () => ({
		read: (await import("../../services/tool-continuation-reader"))
			.readContinuationRecoveryPageTask,
	}),
};
const loadedModules = new Map<SyncDomainReadTaskKind, Promise<unknown>>();
function loadDomain<K extends SyncDomainReadTaskKind>(task: K): Promise<DomainReadModule<K>> {
	let loaded = loadedModules.get(task);
	if (!loaded) {
		loaded = loaders[task]();
		loadedModules.set(task, loaded);
	}
	// The private cache erases K; the fixed, typed loader above preserves its key/module pairing.
	return loaded as Promise<DomainReadModule<K>>;
}
interface DomainStreamModule<K extends DomainReadStreamKind> {
	read(
		sqlite: Database,
		input: DomainReadTaskMap[K]["params"],
		context: DomainReadStreamContext,
	): Promise<DomainReadStreamResult>;
	validate(input: unknown): boolean;
}
const streamLoaders: { [K in DomainReadStreamKind]: () => Promise<DomainStreamModule<K>> } = {
	benchmarkSuiteListSnapshot: async () => {
		const module = await import("../../services/benchmark-read");
		return {
			read: module.readBenchmarkSuiteListSnapshot,
			validate: module.validateBenchmarkSuiteListSnapshotInput,
		};
	},
};
function loadDomainStream<K extends DomainReadStreamKind>(task: K): Promise<DomainStreamModule<K>> {
	return streamLoaders[task]() as Promise<DomainStreamModule<K>>;
}

/** Only explicitly registered stream handlers may await ACK in a readonly snapshot. */
export async function runDomainReadStream(
	sqlite: Database,
	params: Extract<DomainReadParams, { task: DomainReadStreamKind }>,
	context: DomainReadStreamContext,
	meter?: ReadBudgetMeter,
): Promise<DomainReadStreamResult> {
	const definition = validateDomainRead(params, meter);
	const check = () => {
		if (context.signal.aborted) throw readAborted();
		if (Date.now() >= context.deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "database read task timed out");
	};
	check();
	const module = await loadDomainStream(params.task);
	check();
	if (!module.validate(params.input))
		throw new DbReadError("DB_READ_INVALID", "Invalid domain read parameters");
	let bytes = 0,
		chunks = 0,
		emitting = false;
	let completion: DomainReadStreamResult | undefined;
	let failure: unknown;
	let failed = false;
	try {
		const result = await module.read(sqlite, params.input, {
			signal: context.signal,
			deadlineAt: context.deadlineAt,
			emit: async (part: Uint8Array) => {
				check();
				if (emitting)
					throw new DbReadError(
						"DB_READ_SNAPSHOT_CLEANUP_FAILED",
						"Overlapping domain stream chunks",
					);
				if (
					!(part instanceof Uint8Array) ||
					part.byteLength < 1 ||
					part.byteLength > DOMAIN_READ_STREAM_MAX_CHUNK_BYTES ||
					!Number.isSafeInteger(bytes + part.byteLength)
				)
					throw new DbReadError("DB_READ_BUDGET", "Domain stream exceeded its chunk budget");
				const length = part.byteLength;
				emitting = true;
				try {
					meter?.observe("resultBytes", bytes + length, SELECT_ROWS_MAX_BYTES, "result");
					await context.emit(new Uint8Array(part));
					bytes += length;
					chunks++;
					check();
				} finally {
					emitting = false;
				}
			},
		});
		check();
		checkDomainBudget(result, definition.maxResultBytes, definition.maxArrayItems, meter);
		if (
			emitting ||
			!Number.isSafeInteger(result.rowCount) ||
			result.rowCount < 0 ||
			result.bytes !== bytes ||
			result.chunks !== chunks
		)
			throw new DbReadError("DB_READ_PROTOCOL", "Invalid domain stream completion");
		meter?.observe("rows", result.rowCount, SELECT_ROWS_MAX_ROWS, "result");
		completion = result;
	} catch (error) {
		failure = error;
		failed = true;
	}
	if (sqlite.inTransaction) {
		try {
			sqlite.close(true);
		} catch {}
		throw new DbReadError(
			"DB_READ_SNAPSHOT_CLEANUP_FAILED",
			"Readonly snapshot cleanup did not confirm release",
		);
	}
	if (failed) throw failure;
	if (!completion) throw new DbReadError("DB_READ_PROTOCOL", "Missing domain stream completion");
	return completion;
}

export async function runDomainRead(
	sqlite: Database,
	params: DomainReadParams,
	signal: AbortSignal,
	deadlineAt = Number.POSITIVE_INFINITY,
	meter?: ReadBudgetMeter,
): Promise<unknown> {
	if (isDomainReadStreamTask(params))
		throw new DbReadError("DB_READ_INVALID", "Domain stream requires a consumer");
	if (!Object.hasOwn(loaders, params.task))
		throw new DbReadError("DB_READ_UNSUPPORTED", "Unregistered database read task");
	if (signal.aborted) throw readAborted();
	const checkDeadline = () => {
		if (Date.now() >= deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "database read task timed out");
	};
	checkDeadline();
	const definition = validateDomainRead(params, meter);
	const module = await loadDomain(params.task);
	if (module.read.constructor.name === "AsyncFunction")
		throw new DbReadError("DB_READ_INVALID", "Domain read handlers must be synchronous");
	if (signal.aborted) throw readAborted();
	if (module.validate && !module.validate(params.input))
		throw new DbReadError("DB_READ_INVALID", "Invalid domain read parameters");
	checkDeadline();
	return sqlite.transaction(() => {
		const result = module.read(sqlite, params.input, signal, deadlineAt);
		if (result && typeof result === "object" && "then" in result)
			throw new DbReadError("DB_READ_INVALID", "Domain read handlers must be synchronous");
		checkDomainBudget(result, definition.maxResultBytes, definition.maxArrayItems, meter);
		if (definition.validateResult && !definition.validateResult(result))
			throw new DbReadError("DB_READ_INVALID", "Invalid domain read result");
		checkDeadline();
		return result;
	})();
}
