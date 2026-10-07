import { basename } from "node:path";
import {
	FILE_PANEL_PAGE_BYTES,
	FILE_REFERENCE_READ_TIMEOUT_MS,
	type FilePanelInfo,
	type FilePanelPage,
	MAX_FILE_PANEL_BYTES,
	MAX_FILE_REFERENCE_PATH_CHARS,
} from "../../shared/file-reference";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import { AppError } from "../lib/errors";
import type { EditorActor, EditorBinding } from "./editor-document-service";
import { decodeFilePanelPage, Operation } from "./file-reference-service";

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
		if (!path || path.length > MAX_FILE_REFERENCE_PATH_CHARS || path.includes("\0"))
			throw new AppError("Invalid file path", 400, "VALIDATION_ERROR");
		if (backend.deviceId !== "local")
			throw new AppError("Legacy panels are local only", 422, "EDITOR_REMOTE_UNSUPPORTED");
		if (
			offset !== undefined &&
			(!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILE_PANEL_BYTES)
		)
			throw new AppError("Invalid byte offset", 400, "FILE_REFERENCE_INVALID_OFFSET");
		const input = { path, deviceId: "local", origin: "legacy" as const };
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
		const elapsedMs = Date.now() - op.startedAt;
		if (failed || elapsedMs >= 500)
			void import("../lib/logger").then(({ logger }) =>
				logger.warn("Legacy file panel operation", {
					operation: offset === undefined ? "info" : "page",
					elapsedMs,
					failed,
				}),
			);
	}
}
