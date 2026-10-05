import { basename } from "node:path";
import { Hono } from "hono";
import {
	classifySharePreview,
	isShareText,
	SHARE_CONTENT_TIMEOUT_MS,
	SHARE_HTML_CSP,
	SHARE_HTML_MAX_BYTES,
	SHARE_TEXT_MAX_BYTES,
} from "../../shared/share-preview";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { decodeUtf8Prefix } from "../lib/read-file-capped";
import { renderShareHtml } from "../lib/share-preview-html";
import { getShare } from "../lib/shares";

export const shareRoutes = new Hono();
const PREVIEW_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	// Also protects direct navigation to SVG/HTML, not just iframe embedding.
	"Content-Security-Policy": `sandbox; ${SHARE_HTML_CSP}`,
};

async function shareFile(shareId: string) {
	const record = getShare(shareId);
	if (!record) throw new NotFoundError("Share", shareId);
	const file = Bun.file(record.storagePath);
	if (!(await file.exists())) throw new NotFoundError("Share file", shareId);
	return { record, file };
}

/** A source-bounded read: never collect a whole text file and then truncate it. */
async function textPrefix(file: ReturnType<typeof Bun.file>, limit: number, signal: AbortSignal) {
	const started = performance.now();
	const reader = file
		.slice(0, limit + 1)
		.stream()
		.getReader();
	const controller = AbortSignal.any([signal, AbortSignal.timeout(SHARE_CONTENT_TIMEOUT_MS)]);
	const bytes = new Uint8Array(limit + 1);
	let length = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	controller.addEventListener("abort", abort, { once: true });
	try {
		controller.throwIfAborted();
		while (length < bytes.length) {
			const { done, value } = await reader.read();
			controller.throwIfAborted();
			if (done) break;
			const chunk = value.subarray(0, bytes.length - length);
			bytes.set(chunk, length);
			length += chunk.length;
		}
		return {
			bytes: bytes.subarray(0, Math.min(length, limit)),
			truncated: length > limit || file.size > limit,
		};
	} catch (error) {
		if (controller.aborted)
			throw new AppError(
				"Text preview cancelled or timed out",
				signal.aborted ? 499 : 504,
				"SHARE_PREVIEW_TIMEOUT",
			);
		throw error;
	} finally {
		controller.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		const elapsedMs = performance.now() - started;
		if (elapsedMs > 250) logger.warn("Slow share text preview", { elapsedMs, byteLimit: limit });
	}
}

shareRoutes.get("/:shareId", async (c) => {
	const { record, file } = await shareFile(c.req.param("shareId"));
	const base = basename(record.originalName);
	const encodedFilename = encodeURIComponent(base).replace(/%20/g, "+");
	const asciiFallback = base.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
	return new Response(file, {
		headers: {
			"Content-Type": file.type || "application/octet-stream",
			"Content-Length": String(file.size),
			"Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

// Small preflight lets players/iframes distinguish missing shares from decoder failures.
shareRoutes.get("/:shareId/preview-info", async (c) => {
	const { record, file } = await shareFile(c.req.param("shareId"));
	let preview = classifySharePreview(record.originalName);
	if (preview.kind === "text") {
		const prefix = await textPrefix(file, 4096, c.req.raw.signal);
		if (!isShareText(prefix.bytes, !prefix.truncated))
			preview = { kind: "unsupported", mime: "application/octet-stream" };
	}
	if (preview.kind === "unsupported")
		throw new ValidationError("Preview not supported for this file type");
	if (preview.kind === "html" && file.size > SHARE_HTML_MAX_BYTES)
		throw new AppError(
			"HTML preview exceeds 1 MiB; please download",
			413,
			"SHARE_PREVIEW_TOO_LARGE",
		);
	return c.json({ ...preview, size: file.size, expiresAt: record.expiresAt.toISOString() }, 200, {
		"Cache-Control": "no-store",
	});
});

shareRoutes.get("/:shareId/preview", async (c) => {
	const { record, file } = await shareFile(c.req.param("shareId"));
	const preview = classifySharePreview(record.originalName);
	if (preview.kind === "unsupported")
		throw new ValidationError("Preview not supported for this file type");
	if (preview.kind === "html") {
		if (file.size > SHARE_HTML_MAX_BYTES)
			throw new AppError(
				"HTML preview exceeds 1 MiB; please download",
				413,
				"SHARE_PREVIEW_TOO_LARGE",
			);
		const html = await renderShareHtml(record.storagePath, c.req.raw.signal);
		return new Response(html, { headers: { ...PREVIEW_HEADERS, "Content-Type": preview.mime } });
	}
	if (preview.kind === "text") {
		const prefix = await textPrefix(file, SHARE_TEXT_MAX_BYTES, c.req.raw.signal);
		if (!isShareText(prefix.bytes, !prefix.truncated))
			throw new ValidationError("Preview not supported for binary content");
		return new Response(decodeUtf8Prefix(prefix.bytes), {
			headers: {
				...PREVIEW_HEADERS,
				"Content-Type": preview.mime,
				"X-Preview-Truncated": String(prefix.truncated),
			},
		});
	}
	// Bun's file response supplies bounded native streaming and Range/206/416.
	// Keep the original BunFile, not .stream() or .arrayBuffer(), to retain this behavior.
	return new Response(file, {
		headers: {
			...PREVIEW_HEADERS,
			"Content-Type": preview.mime,
			"Content-Disposition": "inline",
			"Content-Length": String(file.size),
			"Accept-Ranges": "bytes",
			// Native PDF viewers are disabled by CSP sandbox; PDF uses browser isolation.
			...(preview.kind === "pdf"
				? { "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'" }
				: {}),
		},
	});
});
