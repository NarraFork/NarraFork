import { createHash } from "node:crypto";
import { type BigIntStats, fstat, read } from "node:fs";
import { lstat } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import iconv from "iconv-lite";
import {
	EDITOR_FILE_MAX_BYTES,
	EDITOR_TRANSFER_CHUNK_BYTES,
	type EditorRawEncoding,
	type EditorRawMetadata,
} from "../../shared/editor-document";
import { EditorStreamCodec, editorRawEncoding } from "../../shared/editor-stream-codec";
import { rejectEditorSymlinks } from "./editor-source-path";

export type StreamWorkerRequest =
	| {
			action: "open";
			stream: string;
			path: string;
			fd: number;
			encoding?: EditorRawEncoding;
			expected?: EditorRawMetadata;
	  }
	| { action: "read"; stream: string; offset: number; maxBytes: number }
	| { action: "close"; stream: string }
	| { action: "diagnostics"; stream: string }
	| { action: "codec-open"; stream: string; encoding: EditorRawEncoding }
	| { action: "codec-chunk"; stream: string; bytes: Uint8Array; eof: boolean };
export type StreamWorkerResult = {
	metadata?: EditorRawMetadata;
	bytes?: Uint8Array;
	eof?: boolean;
	counters?: { preflightBytes: number; bodyBytes: number; fds: number };
};
function identity(stat: BigIntStats) {
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
/** Parent owns this descriptor so a terminated Bun Worker cannot orphan it.
 * Closing here fences further IO; the parent closes the handle after ACK/exit. */
function sourceReader(fd: number) {
	let closed = false;
	const pending = new Set<Promise<unknown>>();
	const io = <T>(start: () => Promise<T>) => {
		if (closed) throw new Error("EDITOR_STREAM_CANCELLED");
		const task = start();
		pending.add(task);
		return task.finally(() => {
			pending.delete(task);
		});
	};
	return {
		get fd() {
			return closed ? -1 : fd;
		},
		stat: (_options: { bigint: true }) =>
			io(
				() =>
					new Promise<BigIntStats>((resolve, reject) => {
						fstat(fd, { bigint: true }, (error, stat) => (error ? reject(error) : resolve(stat)));
					}),
			),
		read: (buffer: Buffer, offset: number, length: number, position: number) =>
			io(
				() =>
					new Promise<{ bytesRead: number }>((resolve, reject) => {
						read(fd, buffer, offset, length, position, (error, bytesRead) =>
							error ? reject(error) : resolve({ bytesRead }),
						);
					}),
			),
		close: async () => {
			closed = true;
			await Promise.allSettled(pending);
		},
	};
}
type Source = {
	file: ReturnType<typeof sourceReader>;
	path: string;
	identity: string;
	offset: number;
	metadata: EditorRawMetadata;
	hash: ReturnType<typeof createHash>;
};
const sources = new Map<string, Source>();
let preflightBytes = 0,
	bodyBytes = 0;
function analyzer(encoding: EditorRawEncoding) {
	const encoder =
		encoding === "gbk" || encoding === "gb18030" ? iconv.getEncoder(encoding) : undefined;
	const roundtrip = createHash("sha256");
	const codec = new EditorStreamCodec(encoding, (text) => {
		if (encoder) roundtrip.update(encoder.write(text));
	});
	return {
		codec,
		finish: () => {
			const metadata = codec.finish();
			if (encoder) {
				const tail = encoder.end();
				if (tail) roundtrip.update(tail);
				if (roundtrip.digest("hex") !== metadata.baseHash)
					throw new Error("EDITOR_ENCODING_NOT_REVERSIBLE");
			}
			return metadata;
		},
	};
}
const codecs = new Map<string, ReturnType<typeof analyzer>>();
type Opening = {
	cancelled: boolean;
	done: Promise<void>;
	finish(): void;
	file?: ReturnType<typeof sourceReader>;
};
const opening = new Map<string, Opening>();
async function verify(source: Source) {
	await rejectEditorSymlinks(source.path);
	if (
		identity(await source.file.stat({ bigint: true })) !== source.identity ||
		identity(await lstat(source.path, { bigint: true })) !== source.identity
	)
		throw new Error("EDITOR_SOURCE_CHANGED");
}
async function close(stream: string) {
	const pending = opening.get(stream);
	if (pending) {
		pending.cancelled = true;
		await pending.done;
	}
	const source = sources.get(stream);
	sources.delete(stream);
	codecs.delete(stream);
	await source?.file.close();
}
export async function runStreamWorker(request: StreamWorkerRequest): Promise<StreamWorkerResult> {
	const { stream } = request;
	let pendingOpen: Opening | undefined;
	try {
		if (request.action === "diagnostics")
			return {
				counters: {
					preflightBytes,
					bodyBytes,
					fds:
						sources.size +
						[...opening.values()].filter((value) => value.file && value.file.fd >= 0).length,
				},
			};
		if (request.action === "close") {
			await close(stream);
			return {};
		}
		if (request.action === "codec-open") {
			if (codecs.has(stream) || codecs.size + sources.size >= 8) throw new Error("EDITOR_BUSY");
			codecs.set(stream, analyzer(request.encoding));
			return {};
		}
		if (request.action === "codec-chunk") {
			const codec = codecs.get(stream);
			if (!codec || request.bytes.length > EDITOR_TRANSFER_CHUNK_BYTES)
				throw new Error("EDITOR_STREAM_INVALID");
			codec.codec.push(request.bytes, request.eof);
			if (!request.eof) return {};
			const metadata = codec.finish();
			codecs.delete(stream);
			return { metadata };
		}
		if (request.action === "open") {
			if (sources.has(stream) || sources.size + codecs.size >= 8) throw new Error("EDITOR_BUSY");
			let finish!: () => void;
			const done = new Promise<void>((resolve) => {
				finish = resolve;
			});
			pendingOpen = { cancelled: false, done, finish };
			opening.set(stream, pendingOpen);
			await rejectEditorSymlinks(request.path);
			if (pendingOpen.cancelled) throw new Error("EDITOR_STREAM_CANCELLED");
			const file = sourceReader(request.fd);
			pendingOpen.file = file;
			try {
				const stat = await file.stat({ bigint: true });
				if (!stat.isFile() || stat.size > BigInt(EDITOR_FILE_MAX_BYTES))
					throw new Error("EDITOR_RAW_LIMIT");
				if (request.expected) {
					if (stat.size !== BigInt(request.expected.sourceBytes))
						throw new Error("EDITOR_SOURCE_CHANGED");
					const source: Source = {
						file,
						path: request.path,
						identity: identity(stat),
						offset: 0,
						metadata: request.expected,
						hash: createHash("sha256"),
					};
					await verify(source);
					if (pendingOpen.cancelled) throw new Error("EDITOR_STREAM_CANCELLED");
					sources.set(stream, source);
					return { metadata: request.expected };
				}
				const buffer = Buffer.alloc(EDITOR_TRANSFER_CHUNK_BYTES);
				const sample = await file.read(buffer, 0, buffer.length, 0);
				preflightBytes += sample.bytesRead;
				const analysis = analyzer(
					editorRawEncoding(buffer.subarray(0, sample.bytesRead), request.encoding),
				);
				const codec = analysis.codec;
				let offset = 0;
				for (;;) {
					if (pendingOpen.cancelled) throw new Error("EDITOR_STREAM_CANCELLED");
					const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
					preflightBytes += bytesRead;
					codec.push(buffer.subarray(0, bytesRead), bytesRead === 0);
					offset += bytesRead;
					if (!bytesRead) break;
				}
				const metadata = analysis.finish();
				const source: Source = {
					file,
					path: request.path,
					identity: identity(stat),
					offset: 0,
					metadata,
					hash: createHash("sha256"),
				};
				await verify(source);
				if (BigInt(metadata.sourceBytes) !== stat.size) throw new Error("EDITOR_SOURCE_CHANGED");
				if (pendingOpen.cancelled) throw new Error("EDITOR_STREAM_CANCELLED");
				sources.set(stream, source);
				return { metadata };
			} catch (error) {
				await file.close();
				throw error;
			}
		}
		const source = sources.get(stream);
		if (
			!source ||
			request.offset !== source.offset ||
			!Number.isSafeInteger(request.maxBytes) ||
			request.maxBytes < 1 ||
			request.maxBytes > EDITOR_TRANSFER_CHUNK_BYTES
		)
			throw new Error("EDITOR_STREAM_INVALID");
		await verify(source);
		const buffer = Buffer.alloc(
			Math.min(request.maxBytes, source.metadata.sourceBytes - source.offset),
		);
		const { bytesRead } = await source.file.read(buffer, 0, buffer.length, source.offset);
		bodyBytes += bytesRead;
		source.offset += bytesRead;
		source.hash.update(buffer.subarray(0, bytesRead));
		const eof = source.offset === source.metadata.sourceBytes;
		if (!bytesRead && !eof) throw new Error("EDITOR_SOURCE_CHANGED");
		if (eof) {
			await verify(source);
			if (source.hash.digest("hex") !== source.metadata.baseHash)
				throw new Error("EDITOR_SOURCE_CHANGED");
			await close(stream);
		}
		return { bytes: Uint8Array.from(buffer.subarray(0, bytesRead)), eof };
	} catch (error) {
		// open owns its FD until its inner catch has closed it. A concurrent close
		// waits for this acknowledgement before returning the stream permit.
		if (request.action !== "open") await close(stream);
		throw error;
	} finally {
		if (pendingOpen) {
			opening.delete(stream);
			pendingOpen.finish();
		}
	}
}
if (parentPort) {
	parentPort.on(
		"message",
		async ({ id, request }: { id: number; request: StreamWorkerRequest }) => {
			try {
				const result = await runStreamWorker(request);
				parentPort?.postMessage(
					{ id, result },
					result.bytes ? [result.bytes.buffer as ArrayBuffer] : [],
				);
			} catch (error) {
				parentPort?.postMessage({
					id,
					error: error instanceof Error ? error.message : String(error),
					code: (error as NodeJS.ErrnoException).code,
				});
			}
		},
	);
	parentPort.postMessage({ ready: true });
}
