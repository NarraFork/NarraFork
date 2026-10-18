import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, readSync } from "node:fs";
import { link, lstat, open, opendir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rejectEditorSymlinks } from "./editor-source-path";

export { rejectEditorSymlinks } from "./editor-source-path";

import { parentPort } from "node:worker_threads";
import {
	EDITOR_DOCUMENT_MAX_CHARS,
	EDITOR_FILE_MAX_BYTES,
	EDITOR_MAX_OPERATIONS,
	EDITOR_MAX_SESSIONS,
	EDITOR_MAX_UPLOADS_PER_SESSION,
	EDITOR_METADATA_MAX_BYTES,
	EDITOR_SESSION_IDLE_MS,
	EDITOR_TRANSFER_CHUNK_BYTES,
	EDITOR_TRANSFER_MAX_BYTES,
	EDITOR_USER_MAX_OPERATIONS,
	type EditorBom,
	type EditorRawEncoding,
	type EditorRawSeal,
} from "../../shared/editor-document";
import { EditorStreamCodec } from "../../shared/editor-stream-codec";
// The settings-free core: this worker is a fresh thread per job, and loading settings (with the
// model catalog) only to encode bytes cost ~170 ms per editor operation.
import {
	decodeFileBytesAs,
	detectFileEncoding,
	encodeFileBytesAs,
} from "../lib/agent/tools/encoding-core";

import {
	type EditorOperationMetadata,
	editorOperationMetadataSchema,
} from "../lib/validators/editor-documents";

export interface EditorVersionMetadata {
	baseHash: string;
	encoding: string;
	eol: "LF" | "CRLF" | "CR";
	sourceBytes: number;
	utf8Bytes: number;
}
export type EditorWorkerRequest =
	| { action: "metadata"; sourcePath: string }
	| { action: "content"; sourcePath: string; metadata: EditorVersionMetadata }
	| { action: "disk-state"; sourcePath: string }
	| { action: "seal"; path: string }
	| {
			action: "raw-seal";
			path: string;
			/** Borrowed from the admitted parent job; never opened/closed by this worker. */
			fd?: number;
			encoding: EditorRawEncoding;
			bom: EditorBom;
			expected: EditorRawSeal;
	  }
	| {
			action: "prepare";
			before: Uint8Array | null;
			uploadPath: string;
			conflictPath: string;
			baseHash: string | null;
			encoding: string;
			digest: string;
			hashKind?: "raw-sha256";
			recovery?: {
				path: string;
				userId: string;
				narratorId: string;
				operationId: string;
				snapshotRevision: number;
			};
	  }
	| { action: "cleanup"; root: string };
export type EditorWorkerResult =
	| { kind: "source"; metadata: EditorVersionMetadata }
	| { kind: "disk-state"; metadata: EditorVersionMetadata | null }
	| { kind: "content"; bytes: Uint8Array }
	| { kind: "sealed"; bytes: number; digest: string }
	| { kind: "prepared"; nextBytes: Uint8Array; hash: string; bytes: number }
	| { kind: "conflict"; metadata: EditorVersionMetadata; absent: boolean }
	| { kind: "cleaned"; operations: EditorOperationMetadata[] };

function fail(message: string): never {
	throw new Error(message);
}
function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
async function boundedRead(path: string, max: number, source = false): Promise<Uint8Array> {
	if (source) await rejectEditorSymlinks(path);
	const entryBefore = await lstat(path);
	if (!entryBefore.isFile() || entryBefore.isSymbolicLink() || entryBefore.size > max)
		fail("File exceeds its byte budget or is not regular");
	// lstat is only an early refusal: a FIFO can replace a regular file before open.
	// NONBLOCK prevents waiting for its writer, and fstat below rejects the opened object.
	const file = await open(
		path,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
	);
	try {
		const initial = await file.stat({ bigint: true });
		if (!initial.isFile() || initial.size > BigInt(max))
			fail("File exceeds its byte budget or is not regular");
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const buffer = Buffer.allocUnsafe(Math.min(EDITOR_TRANSFER_CHUNK_BYTES, max + 1 - total));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > max) fail("File grew beyond its byte budget");
			chunks.push(buffer.subarray(0, bytesRead));
		}
		const final = await file.stat({ bigint: true });
		const entry = await lstat(path, { bigint: true });
		if (
			entry.isSymbolicLink() ||
			final.size !== initial.size ||
			final.mtimeNs !== initial.mtimeNs ||
			final.ctimeNs !== initial.ctimeNs ||
			entry.dev !== initial.dev ||
			entry.ino !== initial.ino ||
			entry.size !== final.size ||
			entry.mtimeNs !== final.mtimeNs ||
			entry.ctimeNs !== final.ctimeNs ||
			BigInt(total) !== initial.size
		)
			fail("File changed while reading");
		if (source) await rejectEditorSymlinks(path);
		return Buffer.concat(chunks, total);
	} finally {
		await file.close();
	}
}
function normalized(text: string): string {
	return text.replace(/\r\n|\r/g, "\n");
}
function eolOf(text: string): EditorVersionMetadata["eol"] {
	let crlf = 0,
		lf = 0,
		cr = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\r") {
			if (text[i + 1] === "\n") {
				crlf++;
				i++;
			} else cr++;
		} else if (text[i] === "\n") lf++;
	}
	return crlf > 0 && crlf >= lf && crlf >= cr ? "CRLF" : cr > lf ? "CR" : "LF";
}
function detectEditorEncoding(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	try {
		// Full-document strict validation, never a prefix guess that loses a legacy tail.
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (!text.includes("\0")) return "utf-8";
	} catch {
		/* Legacy charsets require the existing full-input detector. */
	}
	return detectFileEncoding(bytes);
}
function decode(bytes: Uint8Array, requested?: string) {
	if (bytes.byteLength > EDITOR_FILE_MAX_BYTES) fail("Source file exceeds 20 MiB");
	const encoding = requested ?? detectEditorEncoding(bytes);
	const text = decodeFileBytesAs(bytes, encoding);
	if (text.length > EDITOR_DOCUMENT_MAX_CHARS) fail("Decoded document exceeds its UTF-16 budget");
	if (text.includes("\0")) fail("Binary files cannot be edited");
	return { text, encoding };
}
async function writeVersion(
	bytes: Uint8Array,
	output: string,
	encoding?: string,
): Promise<EditorVersionMetadata> {
	const decoded = decode(bytes, encoding);
	const utf8 = new TextEncoder().encode(normalized(decoded.text));
	if (utf8.byteLength > EDITOR_TRANSFER_MAX_BYTES)
		fail("Normalized source exceeds transfer budget");
	const file = await open(output, "wx", 0o600);
	try {
		await file.writeFile(utf8);
	} finally {
		await file.close();
	}
	return {
		baseHash: hash(decoded.text),
		encoding: decoded.encoding,
		eol: eolOf(decoded.text),
		sourceBytes: bytes.byteLength,
		utf8Bytes: utf8.byteLength,
	};
}
export async function runEditorWorker(request: EditorWorkerRequest): Promise<EditorWorkerResult> {
	if (request.action === "cleanup") {
		// Startup only, before admitting sessions. Directory inventory and deletion are off-thread.
		// Cover every session's uploads, conflict and in-flight objects plus recovery receipts.
		// Keep a finite inventory budget and the enclosing job's timeout, rather than the old
		// 4096-entry budget that was smaller than the newly admitted lightweight session set.
		const maxObjects =
			EDITOR_MAX_SESSIONS * (EDITOR_MAX_UPLOADS_PER_SESSION + 3) + EDITOR_MAX_OPERATIONS * 2;
		const dir = await opendir(request.root);
		let count = 0;
		const operations: EditorOperationMetadata[] = [];
		const users = new Map<string, number>();
		try {
			for await (const entry of dir) {
				if (++count > maxObjects)
					fail("Editor orphan inventory exceeds startup budget; maintenance required");
				const path = join(request.root, entry.name);
				if (/^ed-[a-f0-9-]+\.json$/.test(entry.name) && entry.isFile()) {
					const bytes = await boundedRead(path, EDITOR_METADATA_MAX_BYTES);
					const metadata = editorOperationMetadataSchema.parse(
						JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
					);
					if (`ed-${metadata.operationId}.json` !== entry.name)
						fail("Editor operation metadata identity mismatch");
					if (metadata.createdAt > Date.now() + 60_000) fail("Invalid editor recovery timestamp");
					if (Date.now() - metadata.createdAt > EDITOR_SESSION_IDLE_MS) {
						await unlink(path);
						continue;
					}
					users.set(metadata.userId, (users.get(metadata.userId) ?? 0) + 1);
					if (
						operations.length >= EDITOR_MAX_OPERATIONS ||
						(users.get(metadata.userId) ?? 0) > EDITOR_USER_MAX_OPERATIONS
					)
						fail("Editor recovery quota exceeded");
					operations.push(metadata);
					continue;
				}
				if (!/^ed-[a-f0-9-]+$/.test(entry.name) || !entry.isFile())
					fail("Unexpected editor temporary object; maintenance required");
				await unlink(path);
			}
		} finally {
			try {
				await dir.close();
			} catch {
				/* Async iteration already closed it. */
			}
		}
		return { kind: "cleaned", operations };
	}
	if (request.action === "disk-state") {
		// Bounded identity probe only. Never allocates a session; never streams body bytes
		// back to the client; result is NOT installed as a new baseline server-side.
		let source: Uint8Array;
		try {
			source = await boundedRead(request.sourcePath, EDITOR_FILE_MAX_BYTES, true);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { kind: "disk-state", metadata: null };
			throw error;
		}
		const decoded = decode(source);
		const text = normalized(decoded.text);
		const metadata: EditorVersionMetadata = {
			baseHash: hash(decoded.text),
			encoding: decoded.encoding,
			eol: eolOf(decoded.text),
			sourceBytes: source.byteLength,
			utf8Bytes: Buffer.byteLength(text, "utf8"),
		};
		if (metadata.utf8Bytes > EDITOR_TRANSFER_MAX_BYTES)
			fail("Normalized source exceeds transfer budget");
		return { kind: "disk-state", metadata };
	}
	if (request.action === "metadata" || request.action === "content") {
		const source = await boundedRead(request.sourcePath, EDITOR_FILE_MAX_BYTES, true);
		const decoded = decode(source);
		const text = normalized(decoded.text);
		const metadata: EditorVersionMetadata = {
			baseHash: hash(decoded.text),
			encoding: decoded.encoding,
			eol: eolOf(decoded.text),
			sourceBytes: source.byteLength,
			utf8Bytes: Buffer.byteLength(text, "utf8"),
		};
		if (metadata.utf8Bytes > EDITOR_TRANSFER_MAX_BYTES)
			fail("Normalized source exceeds transfer budget");
		if (request.action === "metadata") return { kind: "source", metadata };
		if (
			(Object.keys(metadata) as (keyof EditorVersionMetadata)[]).some(
				(key) => metadata[key] !== request.metadata[key],
			)
		) {
			const error = new Error("The file changed since the editor session was opened");
			Object.assign(error, { code: "EDITOR_SOURCE_CHANGED" });
			throw error;
		}
		return { kind: "content", bytes: new TextEncoder().encode(text) };
	}
	if (request.action === "raw-seal") {
		if (request.fd === undefined) fail("EDITOR_STAGE_SEAL_FD_REQUIRED");
		const entry = lstatSync(request.path),
			stat = fstatSync(request.fd);
		if (
			!entry.isFile() ||
			!stat.isFile() ||
			stat.nlink !== 1 ||
			entry.nlink !== 1 ||
			stat.size > EDITOR_FILE_MAX_BYTES ||
			stat.size !== request.expected.bytes ||
			stat.dev !== entry.dev ||
			stat.ino !== entry.ino
		)
			fail("EDITOR_STAGE_SEAL_FAILED");
		const codec = new EditorStreamCodec(request.encoding),
			format = createHash("sha256"),
			buffer = new Uint8Array(EDITOR_TRANSFER_CHUNK_BYTES);
		let total = 0;
		for (;;) {
			// Synchronous ONLY in this dedicated worker: after its exit there can be
			// no detached async read/fstat still using the parent's borrowed descriptor.
			const bytesRead = readSync(request.fd, buffer, 0, buffer.length, total);
			total += bytesRead;
			const chunk = codec.push(buffer.subarray(0, bytesRead), !bytesRead);
			format.update(chunk.tags);
			if (!bytesRead) break;
		}
		const metadata = codec.finish();
		if (
			metadata.bom !== request.bom ||
			metadata.baseHash !== request.expected.rawDigest ||
			metadata.textDigest !== request.expected.textDigest ||
			metadata.textLength !== request.expected.textLength ||
			metadata.lineCount - 1 !== request.expected.newlines ||
			total !== request.expected.bytes ||
			format.digest("hex") !== request.expected.formatDigest
		)
			fail("EDITOR_STAGE_SEAL_FAILED");
		return { kind: "sealed", bytes: total, digest: metadata.baseHash };
	}
	if (request.action === "seal") {
		const bytes = await boundedRead(request.path, EDITOR_TRANSFER_MAX_BYTES);
		const digest = createHash("sha256");
		for (let offset = 0; offset < bytes.byteLength; offset += EDITOR_TRANSFER_CHUNK_BYTES)
			digest.update(bytes.subarray(offset, offset + EDITOR_TRANSFER_CHUNK_BYTES));
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (text.length > EDITOR_DOCUMENT_MAX_CHARS || text.includes("\0"))
			fail("Upload exceeds text budget or is binary");
		return { kind: "sealed", bytes: bytes.byteLength, digest: digest.digest("hex") };
	}
	const previous = request.before === null ? null : decode(request.before, request.encoding).text;
	const currentHash =
		request.before === null
			? null
			: request.hashKind === "raw-sha256"
				? hash(request.before)
				: hash(previous ?? "");
	if (currentHash !== request.baseHash) {
		return {
			kind: "conflict",
			absent: previous === null,
			metadata: {
				...(await writeVersion(
					request.before ?? new Uint8Array(),
					request.conflictPath,
					request.encoding,
				)),
				...(request.hashKind === "raw-sha256"
					? { baseHash: currentHash ?? hash(new Uint8Array()) }
					: {}),
			},
		};
	}
	const uploaded = await boundedRead(
		request.uploadPath,
		request.hashKind === "raw-sha256" ? EDITOR_FILE_MAX_BYTES : EDITOR_TRANSFER_MAX_BYTES,
	);
	if (hash(uploaded) !== request.digest) fail("Sealed upload digest changed");
	let nextBytes: Uint8Array, savedHash: string;
	if (request.hashKind === "raw-sha256") {
		nextBytes = uploaded;
		savedHash = request.digest;
	} else {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(uploaded);
		if (text.length > EDITOR_DOCUMENT_MAX_CHARS || text.includes("\0"))
			fail("Upload exceeds text budget or is binary");
		const ending = eolOf(previous ?? text);
		const nextText = normalized(text).replaceAll(
			"\n",
			ending === "CRLF" ? "\r\n" : ending === "CR" ? "\r" : "\n",
		);
		nextBytes = encodeFileBytesAs(nextText, request.encoding);
		const bom =
			request.encoding === "utf-8"
				? [0xef, 0xbb, 0xbf]
				: request.encoding === "utf-16le"
					? [0xff, 0xfe]
					: request.encoding === "utf-16be"
						? [0xfe, 0xff]
						: null;
		const before = request.before;
		if (before && bom?.every((byte, index) => before[index] === byte)) {
			// Normalized editor snapshots omit the original file's encoding signature.
			nextBytes = Buffer.concat([before.subarray(0, bom.length), nextBytes]);
		}
		if (nextBytes.byteLength > EDITOR_FILE_MAX_BYTES) fail("Final encoded file exceeds 20 MiB");
		const persisted = decodeFileBytesAs(nextBytes, request.encoding);
		if (persisted !== nextText)
			fail("The selected encoding cannot represent all characters losslessly");
		savedHash = hash(persisted);
	}
	if (request.recovery) {
		const { path, ...recovery } = request.recovery;
		const metadata = editorOperationMetadataSchema.parse({
			...recovery,
			version: 1,
			...(request.hashKind ? { hashKind: request.hashKind } : {}),
			hash: savedHash,
			rawDigest: hash(nextBytes),
			bytes: nextBytes.byteLength,
			createdAt: Date.now(),
		});
		const body = new TextEncoder().encode(JSON.stringify(metadata));
		if (body.byteLength > EDITOR_METADATA_MAX_BYTES)
			fail("Recovery metadata exceeds its byte budget");
		const temporary = join(dirname(path), `ed-${recovery.operationId}`);
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(body);
			await file.sync();
			await file.close();
			try {
				await link(temporary, path); // Exclusive atomic publication; never replace a recovery record.
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// The runtime may recapture/reconstruct before dispatch after losing blob history.
				// Reuse only the same operation and exact output; keep the original creation time.
				const existing = editorOperationMetadataSchema.parse(
					JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await boundedRead(path, EDITOR_METADATA_MAX_BYTES),
						),
					),
				);
				if (
					existing.operationId !== metadata.operationId ||
					existing.userId !== metadata.userId ||
					existing.narratorId !== metadata.narratorId ||
					existing.snapshotRevision !== metadata.snapshotRevision ||
					existing.hash !== metadata.hash ||
					existing.hashKind !== metadata.hashKind ||
					existing.rawDigest !== metadata.rawDigest ||
					existing.bytes !== metadata.bytes
				)
					fail("Recovery metadata does not match this preparation");
			}
		} finally {
			await file.close();
			await unlink(temporary);
		}
		if (process.platform !== "win32") {
			const directory = await open(dirname(path), constants.O_RDONLY);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	}
	return { kind: "prepared", nextBytes, bytes: nextBytes.byteLength, hash: savedHash };
}
if (parentPort) {
	const port = parentPort;
	port.once("message", async (request: EditorWorkerRequest) => {
		try {
			const result = await runEditorWorker(request);
			if (result.kind === "prepared") {
				const bytes = new Uint8Array(result.nextBytes);
				port.postMessage({ result: { ...result, nextBytes: bytes } }, [bytes.buffer]);
			} else if (result.kind === "content") {
				port.postMessage({ result }, [result.bytes.buffer as ArrayBuffer]);
			} else port.postMessage({ result });
		} catch (error) {
			port.postMessage({
				error: error instanceof Error ? error.message.slice(0, 256) : "Editor worker failed",
				code:
					(error as { code?: string }).code === "EDITOR_SOURCE_CHANGED"
						? "EDITOR_SOURCE_CHANGED"
						: undefined,
			});
		} finally {
			port.close();
		}
	});
	// No request (including cleanup) may be dispatched by the parent before this.
	port.postMessage({ type: "editor-worker-ready", version: 1 });
}
