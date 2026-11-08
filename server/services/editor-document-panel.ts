import { basename } from "node:path";
import {
	FILE_PANEL_PAGE_BYTES,
	FILE_REFERENCE_READ_TIMEOUT_MS,
	type FilePanelInfo,
	type FilePanelPage,
	MAX_FILE_PANEL_BYTES,
	MAX_FILE_REFERENCE_PATH_CHARS,
	MAX_FILE_REFERENCE_SOURCE_BYTES,
} from "../../shared/file-reference";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import { decodeFileBytesAs, detectFileEncoding } from "../lib/agent/tools/encoding-core";
import { AppError } from "../lib/errors";
import {
	listZipArchive,
	readZipEntry,
	ZipArchiveError,
	type ZipListedEntry,
} from "../lib/zip-archive";
import type { EditorActor, EditorBinding } from "./editor-document-service";
import { decodeFilePanelPage, Operation } from "./file-reference-service";

/** A local file the actor may read, bound to its canonical identity for this operation. */
interface LegacyLocalSource {
	binding: EditorBinding;
	info: FilePanelInfo;
	/** Re-run authorization and fail if the binding or backend runtime changed. */
	reauthorize: () => Promise<void>;
}

/**
 * The legacy panel authorization, shared by every read of one local file: input checks,
 * authorize, stat against the canonical identity, then authorize again. Callers read
 * bytes only through `binding.canonicalPath` and must call `reauthorize` after reading.
 */
async function authorizeLegacyLocalSource(
	op: Operation,
	actor: EditorActor,
	path: string | undefined,
	backend: ExecutionBackend,
	/**
	 * "reference" is a file a chat message linked to. The editor authorizer then also applies
	 * the file-reference read policy (secret paths, read boundary), exactly as it does when
	 * the same link opens in the text editor, so this is never broader than that path.
	 */
	origin: "legacy" | "reference" = "legacy",
): Promise<LegacyLocalSource> {
	if (!path || path.length > MAX_FILE_REFERENCE_PATH_CHARS || path.includes("\0"))
		throw new AppError("Invalid file path", 400, "VALIDATION_ERROR");
	if (backend.deviceId !== "local")
		throw new AppError("Legacy panels are local only", 422, "EDITOR_REMOTE_UNSUPPORTED");
	const input = { path, deviceId: "local", origin };
	const binding = await op.wait(() => actor.authorize(input, "read", op.signal, op.remaining));
	const generation = backend.runtimeGeneration;
	const reauthorize = async () => {
		const current = await op.wait(() => actor.authorize(input, "read", op.signal, op.remaining));
		for (const key of [
			"cwd",
			"projectId",
			"lexicalPath",
			"canonicalPath",
		] as const satisfies readonly (keyof EditorBinding)[]) {
			if (current[key] !== binding[key])
				throw new AppError("Editor source binding changed", 403, "EDITOR_IDENTITY_CHANGED");
		}
		if (backend.runtimeGeneration !== generation)
			throw new AppError("Editor runtime changed", 409, "EDITOR_IDENTITY_CHANGED");
	};
	const stat = await op.wait(() =>
		backend.statFile(binding.lexicalPath, {
			signal: op.signal,
			timeoutMs: op.remaining,
		}),
	);
	if (!stat?.isFile) throw new AppError("File unavailable", 404, "NOT_FOUND");
	if (stat.resolvedPath !== binding.canonicalPath)
		throw new AppError("Editor source identity changed", 409, "EDITOR_IDENTITY_CHANGED");
	if (!Number.isSafeInteger(stat.size) || stat.size < 0)
		throw new AppError("Invalid source size", 422, "FILE_REFERENCE_UNAVAILABLE");
	const info: FilePanelInfo = {
		target: { deviceId: "local", path: binding.canonicalPath },
		fileName: basename(binding.canonicalPath),
		size: stat.size,
	};
	await reauthorize();
	return { binding, info, reauthorize };
}

/** Warn on failures and slow operations, off the request path. */
function logLegacyOperation(op: Operation, operation: string, failed: boolean) {
	const elapsedMs = Date.now() - op.startedAt;
	if (failed || elapsedMs >= 500)
		void import("../lib/logger").then(({ logger }) =>
			logger.warn("Legacy file panel operation", { operation, elapsedMs, failed }),
		);
}

/** No editor session or content snapshot: legacy authorization, local bounded IO only. */
export async function readLegacyFilePanel(
	actor: EditorActor,
	path: string | undefined,
	offset: number | undefined,
	signal?: AbortSignal,
	backend: ExecutionBackend = new LocalBackend(),
	timeoutMs = FILE_REFERENCE_READ_TIMEOUT_MS,
): Promise<FilePanelInfo | FilePanelPage> {
	const op = new Operation(timeoutMs, signal);
	let failed = true;
	try {
		if (
			offset !== undefined &&
			(!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILE_PANEL_BYTES)
		)
			throw new AppError("Invalid byte offset", 400, "FILE_REFERENCE_INVALID_OFFSET");
		const { binding, info, reauthorize } = await authorizeLegacyLocalSource(
			op,
			actor,
			path,
			backend,
		);
		if (offset === undefined) {
			failed = false;
			return info;
		}
		if (info.size > MAX_FILE_PANEL_BYTES)
			throw new AppError("File panel source exceeds 1 GiB", 413, "FILE_REFERENCE_SOURCE_TOO_LARGE");
		if (offset > info.size)
			throw new AppError("Offset is beyond EOF", 400, "FILE_REFERENCE_INVALID_OFFSET");
		const readOffset = Math.max(0, offset - 3);
		const readLimit = FILE_PANEL_PAGE_BYTES + offset - readOffset;
		const result = await op.wait(() =>
			backend.readFileBytes(binding.lexicalPath, {
				offset: readOffset,
				maxBytes: readLimit,
				expectedResolvedPath: binding.canonicalPath,
				signal: op.signal,
				timeoutMs: op.remaining,
			}),
		);
		await reauthorize();
		if (result.resolvedPath !== binding.canonicalPath)
			throw new AppError("Atomic page read identity changed", 409, "EDITOR_IDENTITY_CHANGED");
		if (result.totalSize > MAX_FILE_PANEL_BYTES)
			throw new AppError("File panel source exceeds 1 GiB", 413, "FILE_REFERENCE_SOURCE_TOO_LARGE");
		if (
			!Number.isSafeInteger(result.totalSize) ||
			result.totalSize < 0 ||
			result.bytes.byteLength > readLimit ||
			offset > result.totalSize ||
			readOffset + result.bytes.byteLength > result.totalSize
		)
			throw new AppError("Invalid bounded page response", 422, "FILE_REFERENCE_UNAVAILABLE");
		const page = decodeFilePanelPage(
			{ ...info, size: result.totalSize },
			result.bytes,
			offset,
			readOffset,
		);
		op.check();
		failed = false;
		return page;
	} finally {
		op.close();
		logLegacyOperation(op, offset === undefined ? "info" : "page", failed);
	}
}

/** Same cap as the editor's other bounded reads; listings never exceed it. */
export const MAX_ARCHIVE_LIST_ENTRIES = 10_000;
/** Decompressed bytes a single archive entry may produce before the read is aborted. */
export const MAX_ARCHIVE_ENTRY_BYTES = MAX_FILE_REFERENCE_SOURCE_BYTES;
const MAX_ARCHIVE_ENTRY_NAME_CHARS = 4096;
/** Bytes handed to the charset detector when an entry is not valid UTF-8. */
const ENCODING_SAMPLE_BYTES = 64 * 1024;

export interface ArchiveListing extends FilePanelInfo {
	entries: ZipListedEntry[];
}

export type ArchiveEntryRead =
	| { kind: "text"; name: string; size: number; content: string; encoding: string }
	| { kind: "binary"; name: string; size: number };

/** Malformed or unsupported archives are a property of the file, not a server fault. */
function archiveFailure(error: unknown): unknown {
	if (!(error instanceof ZipArchiveError)) return error;
	if (error.reason === "ENTRY_NOT_FOUND")
		return new AppError(error.message, 404, "ARCHIVE_ENTRY_NOT_FOUND");
	if (error.reason === "ENTRY_TOO_LARGE")
		return new AppError(error.message, 413, "ARCHIVE_ENTRY_TOO_LARGE");
	if (error.reason === "ENTRY_UNREADABLE")
		return new AppError(error.message, 422, "ARCHIVE_ENTRY_UNREADABLE");
	if (error.reason === "TOO_MANY_ENTRIES")
		return new AppError(error.message, 413, "ARCHIVE_TOO_MANY_ENTRIES");
	return new AppError(error.message, 422, "ARCHIVE_UNREADABLE");
}

/** List a local zip-family archive's entries under the legacy panel authorization. */
export async function listLegacyArchive(
	actor: EditorActor,
	path: string | undefined,
	signal?: AbortSignal,
	origin: "legacy" | "reference" = "legacy",
	backend: ExecutionBackend = new LocalBackend(),
	timeoutMs = FILE_REFERENCE_READ_TIMEOUT_MS,
): Promise<ArchiveListing> {
	const op = new Operation(timeoutMs, signal);
	let failed = true;
	try {
		const { binding, info, reauthorize } = await authorizeLegacyLocalSource(
			op,
			actor,
			path,
			backend,
			origin,
		);
		if (info.size > MAX_FILE_PANEL_BYTES)
			throw new AppError("Archive exceeds 1 GiB", 413, "FILE_REFERENCE_SOURCE_TOO_LARGE");
		const listing = await op
			.wait(() => listZipArchive(binding.canonicalPath, { maxEntries: MAX_ARCHIVE_LIST_ENTRIES }))
			.catch((error: unknown) => {
				throw archiveFailure(error);
			});
		await reauthorize();
		if (listing.archiveSize !== info.size)
			throw new AppError("Archive changed while reading", 409, "EDITOR_IDENTITY_CHANGED");
		op.check();
		failed = false;
		return { ...info, entries: listing.entries };
	} finally {
		op.close();
		logLegacyOperation(op, "archive", failed);
	}
}

/**
 * Read one entry of a local archive. Text is decoded server-side (strict UTF-8, then the
 * shared legacy-charset detector); binary content is never sent, only its size.
 */
export async function readLegacyArchiveEntry(
	actor: EditorActor,
	path: string | undefined,
	entryName: string | undefined,
	signal?: AbortSignal,
	origin: "legacy" | "reference" = "legacy",
	backend: ExecutionBackend = new LocalBackend(),
	timeoutMs = FILE_REFERENCE_READ_TIMEOUT_MS,
): Promise<ArchiveEntryRead> {
	const op = new Operation(timeoutMs, signal);
	let failed = true;
	try {
		if (!entryName || entryName.length > MAX_ARCHIVE_ENTRY_NAME_CHARS || entryName.includes("\0"))
			throw new AppError("Invalid archive entry name", 400, "VALIDATION_ERROR");
		const { binding, info, reauthorize } = await authorizeLegacyLocalSource(
			op,
			actor,
			path,
			backend,
			origin,
		);
		if (info.size > MAX_FILE_PANEL_BYTES)
			throw new AppError("Archive exceeds 1 GiB", 413, "FILE_REFERENCE_SOURCE_TOO_LARGE");
		const { entry, bytes } = await op
			.wait(() =>
				readZipEntry(binding.canonicalPath, entryName, MAX_ARCHIVE_ENTRY_BYTES, {
					maxEntries: MAX_ARCHIVE_LIST_ENTRIES,
				}),
			)
			.catch((error: unknown) => {
				throw archiveFailure(error);
			});
		await reauthorize();
		op.check();
		failed = false;
		if (bytes.includes(0)) return { kind: "binary", name: entry.name, size: bytes.byteLength };
		let content: string;
		let encoding = "utf-8";
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			// Charset detection is synchronous; a bounded sample keeps a 1 MiB entry off the
			// main thread's critical path (the full buffer measured ~200 ms, the sample ~10 ms).
			encoding = detectFileEncoding(bytes.subarray(0, ENCODING_SAMPLE_BYTES));
			content = decodeFileBytesAs(bytes, encoding);
		}
		return { kind: "text", name: entry.name, size: bytes.byteLength, content, encoding };
	} finally {
		op.close();
		logLegacyOperation(op, "archive-entry", failed);
	}
}
