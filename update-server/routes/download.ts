/**
 * Download routes — serves release files, blockmaps, and zstd patches.
 * Public endpoints — no auth required.
 * Supports HTTP Range requests (RFC 7233).
 */
import { Hono } from "hono";
import type { StorageBackend } from "../storage/types";

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

	// GET /api/v2/products/:product/releases/:version/blockmap/:filename
	routes.get("/:product/releases/:version/blockmap/:filename", async (c) => {
		const { product, version, filename } = c.req.param();
		const platform = detectPlatformFromFilename(filename);
		if (!platform) {
			return c.json({ error: "Cannot determine platform from filename" }, 400);
		}

		const path = `products/${product}/releases/${version}/${platform}/${filename}.blockmap`;
		return serveFile(c, storage, path, `${filename}.blockmap`);
	});

	// GET /api/v2/products/:product/releases/:version/zstd-patch/:filename
	routes.get("/:product/releases/:version/zstd-patch/:filename", async (c) => {
		const { product, version, filename } = c.req.param();
		const platform = detectPlatformFromFilename(filename);
		if (!platform) {
			return c.json({ error: "Cannot determine platform from filename" }, 400);
		}

		const path = `products/${product}/releases/${version}/${platform}/${filename}.zstd-patch`;
		return serveFile(c, storage, path, `${filename}.zstd-patch`);
	});

	// GET /api/v2/products/:product/releases/:version/zstd-patch-meta/:filename
	routes.get("/:product/releases/:version/zstd-patch-meta/:filename", async (c) => {
		const { product, version, filename } = c.req.param();
		const platform = detectPlatformFromFilename(filename);
		if (!platform) {
			return c.json({ error: "Cannot determine platform from filename" }, 400);
		}

		const path = `products/${product}/releases/${version}/${platform}/${filename}.zstd-patch.meta.json`;
		return serveFile(c, storage, path, `${filename}.zstd-patch.meta.json`, "application/json");
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
	if (!ranges || ranges.length === 0) {
		return new Response("Range Not Satisfiable", {
			status: 416,
			headers: { "Content-Range": `bytes */${fileSize}` },
		});
	}

	if (ranges.length === 1) {
		// Single range
		const { start, end } = ranges[0];
		const slice = await storage.getFileSlice(path, start, end);
		if (!slice) {
			return c.json({ error: "Failed to read file slice" }, 500);
		}

		return new Response(new Uint8Array(slice), {
			status: 206,
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Range": `bytes ${start}-${end}/${fileSize}`,
				"Content-Length": String(end - start + 1),
				"Accept-Ranges": "bytes",
			},
		});
	}

	// Multiple ranges — multipart/byteranges
	const boundary = `nfup_${Date.now().toString(36)}`;
	const parts: Buffer[] = [];

	for (const { start, end } of ranges) {
		const slice = await storage.getFileSlice(path, start, end);
		if (!slice) {
			return c.json({ error: "Failed to read file slice" }, 500);
		}

		const header = `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${start}-${end}/${fileSize}\r\n\r\n`;
		parts.push(Buffer.from(header));
		parts.push(slice);
		parts.push(Buffer.from("\r\n"));
	}

	parts.push(Buffer.from(`--${boundary}--\r\n`));
	const body = Buffer.concat(parts);

	return new Response(new Uint8Array(body), {
		status: 206,
		headers: {
			"Content-Type": `multipart/byteranges; boundary=${boundary}`,
			"Content-Length": String(body.length),
			"Accept-Ranges": "bytes",
		},
	});
}

/**
 * Serve a file without Range support (for smaller files like blockmaps).
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
function parseRangeHeader(
	header: string,
	fileSize: number,
): Array<{ start: number; end: number }> | null {
	if (!header.startsWith("bytes=")) return null;

	const rangeStr = header.slice(6);
	const parts = rangeStr.split(",").map((s) => s.trim());
	const ranges: Array<{ start: number; end: number }> = [];

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
