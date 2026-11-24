import type { Database } from "bun:sqlite";
import {
	checkDomainBudget,
	DOMAIN_READ_STREAM_CHUNK_BYTES,
	DOMAIN_STREAM_BYTE_LIMITS,
	type DomainReadParams,
	type DomainReadStreamContext,
	type DomainReadStreamParams,
	type DomainReadStreamResult,
	type DomainReadTaskMap,
	isDomainReadStreamTask,
	type StreamDomainReadTaskKind,
	type SyncDomainReadTaskKind,
	validateDomainRead,
} from "./domain-protocol";
import { DbReadError, readAborted } from "./errors";
import type { ReadBudgetMeter } from "./read-budget";

type DomainReadHandler<K extends SyncDomainReadTaskKind> = (
	sqlite: Database,
	input: DomainReadTaskMap[K]["params"],
	signal: AbortSignal,
	deadlineAt?: number,
) => DomainReadTaskMap[K]["result"];
interface DomainReadModule<K extends SyncDomainReadTaskKind> {
	read: DomainReadHandler<K>;
	validate?: (input: unknown) => boolean;
}
const loaders: { [K in SyncDomainReadTaskKind]: () => Promise<DomainReadModule<K>> } = {
	publicationTerminalResult: async () => ({
		read: (await import("../../services/agent-runtime/publication-reader"))
			.readPublicationTerminalResultTask,
	}),
	knowledgeEntryDetail: async () => ({
		read: (await import("./knowledge-entry-reader")).readKnowledgeEntryDetail,
	}),
	recallConversation: async () => ({
		read: (await import("./recall-reader")).readRecallConversation,
	}),
	recallToolCallDetail: async () => ({
		read: (await import("./recall-reader")).readRecallToolCallDetail,
	}),
	editorOperationEvidence: async () => ({
		read: (await import("./file-read-snapshots")).readEditorOperationEvidence,
	}),
	revertPlanSnapshot: async () => ({
		read: (await import("./file-read-snapshots")).readRevertPlan,
	}),
	readerProbe: async () => ({
		read: (sqlite) => {
			sqlite.query("SELECT 1").get();
			return { ready: true };
		},
	}),
	platformIntegrationAuthoritySnapshot: async () => ({
		read: (await import("./integration-authority-read-task")).readIntegrationAuthoritySnapshotTask,
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

type StreamHandler<K extends StreamDomainReadTaskKind> = (
	sqlite: Database,
	input: DomainReadTaskMap[K]["params"],
	context: DomainReadStreamContext,
) => Promise<DomainReadTaskMap[K]["result"]>;

function streamJsonSnapshot<P, M>(
	read: (sqlite: Database, input: P, signal: AbortSignal) => M & { json?: string },
): (sqlite: Database, input: P, context: DomainReadStreamContext) => Promise<M> {
	return async (sqlite, input, { signal, emit }) => {
		const { json, ...metadata } = read(sqlite, input, signal);
		if (json !== undefined) {
			const encoder = new TextEncoder();
			const buffer = new Uint8Array(DOMAIN_READ_STREAM_CHUNK_BYTES);
			for (let offset = 0; offset < json.length; ) {
				let end = Math.min(json.length, offset + buffer.length);
				const last = json.charCodeAt(end - 1);
				if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
				const { read, written } = encoder.encodeInto(json.slice(offset, end), buffer);
				await emit(buffer.subarray(0, written));
				offset += read;
			}
		}
		return metadata as M;
	};
}

const streamLoaders: { [K in StreamDomainReadTaskKind]: () => Promise<StreamHandler<K>> } = {
	composerDocument: async () =>
		streamJsonSnapshot((await import("./composer-document-query")).readComposerDocument),
	toolDetailSnapshot: async () =>
		streamJsonSnapshot((await import("./tool-detail-query")).readToolDetailSnapshot),
};

function loadStream<K extends StreamDomainReadTaskKind>(task: K): Promise<StreamHandler<K>> {
	return streamLoaders[task]() as Promise<StreamHandler<K>>;
}

export async function runDomainReadStream(
	sqlite: Database,
	params: DomainReadStreamParams,
	context: DomainReadStreamContext,
	meter: ReadBudgetMeter,
): Promise<DomainReadStreamResult> {
	const definition = validateDomainRead(params, meter);
	const maxBytes = DOMAIN_STREAM_BYTE_LIMITS[params.task];
	const check = () => {
		if (context.signal.aborted) throw readAborted();
		if (Date.now() >= context.deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "database read task timed out");
	};
	let bytes = 0;
	let chunks = 0;
	let emitting = false;
	const run = async () => {
		check();
		const read = await loadStream(params.task);
		check();
		const metadata = await read(sqlite, params.input, {
			...context,
			emit: async (part) => {
				check();
				if (emitting) throw new DbReadError("DB_READ_PROTOCOL", "Overlapping domain stream frames");
				if (
					!(part instanceof Uint8Array) ||
					part.byteLength === 0 ||
					part.byteLength > DOMAIN_READ_STREAM_CHUNK_BYTES ||
					bytes + part.byteLength > maxBytes
				)
					throw new DbReadError("DB_READ_BUDGET", "Domain stream exceeded its byte budget");
				const length = part.byteLength;
				emitting = true;
				try {
					await context.emit(new Uint8Array(part));
					bytes += length;
					chunks++;
					meter.observe("resultBytes", bytes, maxBytes, "result");
					check();
				} finally {
					emitting = false;
				}
			},
		});
		check();
		if (emitting)
			throw new DbReadError("DB_READ_PROTOCOL", "Domain stream completed before its final ACK");
		if (
			checkDomainBudget(metadata, definition.maxResultBytes, definition.maxArrayItems, meter) >
			definition.maxResultBytes
		)
			throw new DbReadError("DB_READ_BUDGET", "Domain stream exceeded its metadata budget");
		return { metadata, bytes, chunks };
	};
	return run().finally(() => {
		if (sqlite.inTransaction) {
			try {
				sqlite.close(true);
			} catch {
				/* The one-shot owner still waits for native exit. */
			}
			throw new DbReadError(
				"DB_READ_SNAPSHOT_CLEANUP_FAILED",
				"Domain stream retained a SQLite snapshot",
			);
		}
	});
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
