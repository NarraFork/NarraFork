/**
 * Tools routes — serves and accepts helper binaries under data/tools/.
 *
 * GET is public (NarraFork instances fetch zstd, ripgrep, and the remote
 * executor from here). PUT requires an upload-role token.
 */

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { requireAuth } from "../lib/auth";
import type { StorageBackend } from "../storage/types";

/**
 * The remote executor is a ~8 MB static Go binary; the ceiling leaves room for
 * larger helpers without letting an upload token consume unbounded disk.
 */
export const MAX_TOOL_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * Tool filenames address a single flat file inside data/tools/. Anything with a
 * path separator, a traversal segment, or a NUL byte is rejected before it
 * reaches storage, because the local storage backend joins paths without its own
 * containment check.
 */
export function isSafeToolFilename(filename: string | undefined): boolean {
	if (!filename || filename.length > 255) return false;
	if (filename === "." || filename === "..") return false;
	return /^[A-Za-z0-9._-]+$/.test(filename);
}

export function createToolRoutes(storage: StorageBackend) {
	const routes = new Hono();

	// GET /api/v2/tools/:filename — public helper binary download.
	routes.get("/:filename", async (c) => {
		const filename = c.req.param("filename");
		if (!isSafeToolFilename(filename)) {
			return c.json({ error: "Invalid filename" }, 400);
		}
		const path = `tools/${filename}`;
		const size = await storage.getFileSize(path);
		if (size === null) return c.json({ error: "Tool not found" }, 404);
		const stream = await storage.getFileStream(path);
		if (!stream) return c.json({ error: "Tool not found" }, 404);
		return new Response(stream, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${filename}"`,
				"Content-Length": String(size),
			},
		});
	});

	// PUT /api/v2/tools/:filename — publish a helper binary or manifest.
	//
	// Streams the request body to a temp file while counting bytes and computing
	// SHA-512, matching the Go implementation's MaxBytesReader approach. This avoids
	// buffering up to 64 MB in the JS heap — a concern when Content-Length is
	// missing or dishonest.
	routes.put("/:filename", requireAuth("upload"), async (c) => {
		const filename = c.req.param("filename");
		if (!isSafeToolFilename(filename)) {
			return c.json({ error: "Invalid filename" }, 400);
		}

		const declaredLength = Number(c.req.header("content-length") ?? Number.NaN);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_TOOL_UPLOAD_BYTES) {
			return c.json({ error: "Tool upload exceeds size limit" }, 413);
		}

		const body = c.req.raw.body;
		if (!body) {
			return c.json({ error: "Tool upload is empty" }, 400);
		}

		// Stream body to a temp file, enforcing byte limit and computing hash.
		const tempPath = join(
			tmpdir(),
			`nf-tool-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const hasher = new Bun.CryptoHasher("sha512");
		let totalBytes = 0;
		let limitExceeded = false;

		try {
			const reader = body.getReader();
			const chunks: Uint8Array[] = [];

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > MAX_TOOL_UPLOAD_BYTES) {
					limitExceeded = true;
					// Cancel the remaining stream to free resources promptly.
					await reader.cancel();
					break;
				}
				hasher.update(value);
				chunks.push(value);
			}

			if (limitExceeded) {
				return c.json({ error: "Tool upload exceeds size limit" }, 413);
			}

			if (totalBytes === 0) {
				return c.json({ error: "Tool upload is empty" }, 400);
			}

			// Concatenate and write to temp file, then move into storage.
			const buffer = Buffer.concat(chunks);
			await writeFile(tempPath, buffer);
			await storage.saveFile(`tools/${filename}`, buffer);

			return c.json({
				success: true,
				filename,
				size: totalBytes,
				sha512: hasher.digest("base64"),
			});
		} finally {
			// Clean up temp file (best effort; storage.saveFile might have already consumed it).
			try {
				await unlink(tempPath);
			} catch {
				// Temp file may not exist if we failed before writing it.
			}
		}
	});

	return routes;
}
