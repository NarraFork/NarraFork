/**
 * Download routes — serves release files and zstd patches.
 * Public endpoints — no auth required.
 * Supports HTTP Range requests (RFC 7233).
 */
import { Hono } from "hono";
import type { StorageBackend } from "../storage/types";

const PATCH_BASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?$/;
export const MAX_RANGE_COUNT = 16;
export const MAX_RANGE_RESPONSE_BYTES = 64 * 1024 * 1024;

type ByteRange = { start: number; end: number };

function patchFilename(filename: string, fromVersion?: string): string {
	return fromVersion ? `${filename}.from-${fromVersion}.zstd-patch` : `${filename}.zstd-patch`;
}

export function createDownloadRoutes(storage: StorageBackend) {
	const routes = new Hono();

	// GET /api/v2/products/:product/releases/:version/download/:filename
	routes.get("/:product/releases/:version/download/:filename", async (c) => {
		const { product, version, filename } = c.req.param();
		const platform = detectPlatformFromFilename(filename);
		if (!platform) {
			return c.json({ error: "Cannot determine platform from filename" }, 400);
		}

		const path = `products/${product}/releases/${version}/${platform}/${filename}`;
		return serveFileWithRange(c, storage, path, filename);
	});

	// GET /api/v2/products/:product/releases/:version/zstd-patch/:filename
	routes.get("/:product/releases/:version/zstd-patch/:filename", async (c) => {
		const { product, version, filename } = c.req.param();
		const platform = detectPlatformFromFilename(filename);
		if (!platform) {
			return c.json({ error: "Cannot determine platform from filename" }, 400);
		}

		const fromVersion = c.req.query("fromVersion");
		if (fromVersion && !PATCH_BASE_VERSION_RE.test(fromVersion)) {
			return c.json({ error: "Invalid patch base version" }, 400);
		}
		const storedFilename = patchFilename(filename, fromVersion);
		const path = `products/${product}/releases/${version}/${platform}/${storedFilename}`;
		return serveFile(c, storage, path, storedFilename);
	});

	// GET /api/v2/products/:product/releases/:version/zstd-patch-meta/:filename
	routes.get("/:product/releases/:version/zstd-patch-meta/:filename", async (c) => {
		const { product, version, filename } = c.req.param();
		const platform = detectPlatformFromFilename(filename);
		if (!platform) {
			return c.json({ error: "Cannot determine platform from filename" }, 400);
		}

		const fromVersion = c.req.query("fromVersion");
		if (fromVersion && !PATCH_BASE_VERSION_RE.test(fromVersion)) {
			return c.json({ error: "Invalid patch base version" }, 400);
		}
		const storedFilename = `${patchFilename(filename, fromVersion)}.meta.json`;
		const path = `products/${product}/releases/${version}/${platform}/${storedFilename}`;
		return serveFile(c, storage, path, storedFilename, "application/json");
	});

	return routes;
}

/**
 * Detect platform from filename convention.
 * e.g. "narrafork-0.1.0-linux-x64" → "linux-x64"
 */
function detectPlatformFromFilename(filename: string): string | null {
	const platformPatterns = [
		"linux-x64-baseline",
		"linux-arm64",
		"linux-x64",
		"darwin-arm64",
		"darwin-x64",
		"macos-arm64",
		"macos-x64",
		"windows-x64-baseline",
		"windows-x64",
		"win-x64-baseline",
		"win-x64",
	];

	for (const pattern of platformPatterns) {
		if (filename.includes(pattern)) {
			// Normalize macos → darwin, windows → win
			return pattern.replace("macos-", "darwin-").replace("windows-", "win-");
		}
	}
	return null;
}

/**
 * Serve a file with HTTP Range support.
 */
async function serveFileWithRange(
	c: import("hono").Context,
	storage: StorageBackend,
	path: string,
	filename: string,
): Promise<Response> {
	const fileSize = await storage.getFileSize(path);
	if (fileSize === null) {
		return c.json({ error: "File not found" }, 404);
	}

	const rangeHeader = c.req.header("Range");

	if (!rangeHeader) {
		// Full file download
		const stream = await storage.getFileStream(path);
		if (!stream) {
			return c.json({ error: "File not found" }, 404);
		}

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${filename}"`,
				"Content-Length": String(fileSize),
				"Accept-Ranges": "bytes",
			},
		});
	}

	// Parse Range header
	const ranges = parseRangeHeader(rangeHeader, fileSize);
	if (!ranges || ranges.length === 0 || totalRangeBytes(ranges) > MAX_RANGE_RESPONSE_BYTES) {
		return new Response("Range Not Satisfiable", {
			status: 416,
			headers: { "Content-Range": `bytes */${fileSize}` },
		});
	}

	if (ranges.length === 1) {
		const { start, end } = ranges[0];
		const stream = await storage.getFileSliceStream(path, start, end);
		if (!stream) {
			return c.json({ error: "Failed to read file slice" }, 500);
		}

		return new Response(stream, {
			status: 206,
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Range": `bytes ${start}-${end}/${fileSize}`,
				"Content-Length": String(end - start + 1),
				"Accept-Ranges": "bytes",
			},
		});
	}

	// Multiple ranges — preflight each bounded stream, then emit multipart bytes lazily.
	const streams: ReadableStream[] = [];
	for (const { start, end } of ranges) {
		const stream = await storage.getFileSliceStream(path, start, end);
		if (!stream) {
			for (const opened of streams) void opened.cancel();
			return c.json({ error: "Failed to read file slice" }, 500);
		}
		streams.push(stream);
	}
	const boundary = `nfup_${Date.now().toString(36)}`;
	const contentLength = multipartContentLength(boundary, ranges, fileSize);

	return new Response(createMultipartRangeStream(streams, boundary, ranges, fileSize), {
		status: 206,
		headers: {
			"Content-Type": `multipart/byteranges; boundary=${boundary}`,
			"Content-Length": String(contentLength),
			"Accept-Ranges": "bytes",
		},
	});
}

function multipartPartHeader(boundary: string, range: ByteRange, fileSize: number): string {
	return `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${range.start}-${range.end}/${fileSize}\r\n\r\n`;
}

function multipartContentLength(boundary: string, ranges: ByteRange[], fileSize: number): number {
	let total = Buffer.byteLength(`--${boundary}--\r\n`);
	for (const range of ranges) {
		total += Buffer.byteLength(multipartPartHeader(boundary, range, fileSize));
		total += range.end - range.start + 1;
		total += 2; // trailing CRLF
	}
	return total;
}

interface MultipartRangeStreamState {
	activeReader?: ReadableStreamDefaultReader;
	activeStreamIndex?: number;
}

async function* multipartRangeChunks(
	streams: ReadableStream[],
	state: MultipartRangeStreamState,
	boundary: string,
	ranges: ByteRange[],
	fileSize: number,
): AsyncGenerator<Uint8Array> {
	const encoder = new TextEncoder();
	try {
		for (let index = 0; index < ranges.length; index++) {
			yield encoder.encode(multipartPartHeader(boundary, ranges[index], fileSize));
			const reader = streams[index].getReader();
			state.activeReader = reader;
			state.activeStreamIndex = index;
			let completed = false;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						completed = true;
						break;
					}
					if (value) yield value instanceof Uint8Array ? value : new Uint8Array(value);
				}
			} finally {
				if (!completed) await reader.cancel().catch(() => {});
				reader.releaseLock();
				state.activeReader = undefined;
				state.activeStreamIndex = undefined;
			}
			yield encoder.encode("\r\n");
		}
		yield encoder.encode(`--${boundary}--\r\n`);
	} finally {
		await Promise.allSettled(streams.map((stream) => stream.cancel()));
	}
}

function createMultipartRangeStream(
	streams: ReadableStream[],
	boundary: string,
	ranges: ByteRange[],
	fileSize: number,
): ReadableStream<Uint8Array> {
	const state: MultipartRangeStreamState = {};
	const iterator = multipartRangeChunks(streams, state, boundary, ranges, fileSize);
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel(reason) {
			const activeReader = state.activeReader;
			const activeStreamIndex = state.activeStreamIndex;
			await Promise.allSettled(
				streams.map((stream, index) =>
					index === activeStreamIndex && activeReader
						? activeReader.cancel(reason)
						: stream.cancel(reason),
				),
			);
			await iterator.return?.(undefined);
		},
	});
}

/**
 * Serve a file without Range support (for smaller files like patch metadata).
 * Uses streaming to avoid loading entire file into memory.
 */
async function serveFile(
	c: import("hono").Context,
	storage: StorageBackend,
	path: string,
	filename: string,
	contentType = "application/octet-stream",
): Promise<Response> {
	const fileSize = await storage.getFileSize(path);
	if (fileSize === null) {
		return c.json({ error: "File not found" }, 404);
	}

	const stream = await storage.getFileStream(path);
	if (!stream) {
		return c.json({ error: "File not found" }, 404);
	}

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": contentType,
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Content-Length": String(fileSize),
		},
	});
}

/**
 * Parse HTTP Range header into an array of {start, end} ranges.
 */
function parseRangeHeader(header: string, fileSize: number): ByteRange[] | null {
	if (!header.startsWith("bytes=")) return null;

	const rangeStr = header.slice(6);
	const parts = rangeStr.split(",").map((s) => s.trim());
	if (parts.length > MAX_RANGE_COUNT) return null;
	const ranges: ByteRange[] = [];

	for (const part of parts) {
		const match = part.match(/^(\d*)-(\d*)$/);
		if (!match) return null;

		let start: number;
		let end: number;

		if (match[1] === "") {
			// Suffix range: -500 means last 500 bytes
			const suffix = Number.parseInt(match[2], 10);
			if (Number.isNaN(suffix) || suffix <= 0) return null;
			start = Math.max(0, fileSize - suffix);
			end = fileSize - 1;
		} else if (match[2] === "") {
			// Open-ended: 500- means from 500 to end
			start = Number.parseInt(match[1], 10);
			end = fileSize - 1;
		} else {
			start = Number.parseInt(match[1], 10);
			end = Number.parseInt(match[2], 10);
		}

		if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
			return null;
		}

		end = Math.min(end, fileSize - 1);
		ranges.push({ start, end });
	}

	return ranges.length > 0 ? ranges : null;
}

function totalRangeBytes(ranges: ByteRange[]): number {
	let total = 0;
	for (const { start, end } of ranges) {
		total += end - start + 1;
		if (total > MAX_RANGE_RESPONSE_BYTES) return total;
	}
	return total;
}
