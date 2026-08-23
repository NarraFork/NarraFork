import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { Hono } from "hono";
import sanitizeHtml from "sanitize-html";
import { NotFoundError, ValidationError } from "../lib/errors";
import { getShare } from "../lib/shares";

export const shareRoutes = new Hono();

// ── MIME type mapping for preview ────────────────────────────────────────────

const PREVIEW_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".ogg": "video/ogg",
	".pdf": "application/pdf",
	".html": "text/html",
	".htm": "text/html",
};

function getPreviewMime(filename: string): string | null {
	const ext = extname(filename).toLowerCase();
	return PREVIEW_MIME[ext] ?? null;
}

// ── Download endpoint ────────────────────────────────────────────────────────

shareRoutes.get("/:shareId", async (c) => {
	const { shareId } = c.req.param();
	const record = getShare(shareId);
	if (!record) throw new NotFoundError("Share", shareId);

	const file = Bun.file(record.storagePath);
	if (!(await file.exists())) {
		throw new NotFoundError("Share file", shareId);
	}

	const filename = record.originalName;
	const base = basename(filename);
	// RFC 5987 encoding for non-ASCII filenames
	const encodedFilename = encodeURIComponent(base).replace(/%20/g, "+");
	// ASCII-safe fallback: replace non-ASCII chars with underscores
	const asciiFallback = base.replace(/[^\x20-\x7E]/g, "_");

	// Use BunFile directly as Response body — Bun natively handles it with
	// correct Content-Length, enabling browsers to show download progress.
	// (ReadableStream from file.stream() triggers chunked transfer encoding,
	// which strips Content-Length and breaks progress reporting.)
	return new Response(file, {
		headers: {
			"Content-Type": file.type || "application/octet-stream",
			"Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`,
			"Cache-Control": "no-cache",
		},
	});
});

// ── Preview endpoint ─────────────────────────────────────────────────────────

shareRoutes.get("/:shareId/preview", async (c) => {
	const { shareId } = c.req.param();
	const record = getShare(shareId);
	if (!record) throw new NotFoundError("Share", shareId);

	const file = Bun.file(record.storagePath);
	if (!(await file.exists())) {
		throw new NotFoundError("Share file", shareId);
	}

	const mime = getPreviewMime(record.originalName);
	if (!mime) {
		// The share and its file both exist; only inline preview is unavailable for this
		// type. A 400 also stops the client from retrying as if the share had expired.
		// (As a NotFoundError `entity` this sentence went into "{entity} not found: {id}",
		// which reads as nonsense in any language once that template is translated.)
		throw new ValidationError("Preview not supported for this file type");
	}

	const contentType = mime;
	const isHtml = contentType === "text/html";

	if (isHtml) {
		// Sanitize HTML before serving
		const raw = readFileSync(record.storagePath, "utf-8");
		const clean = sanitizeHtml(raw, {
			allowedTags: sanitizeHtml.defaults.allowedTags.concat([
				"img",
				"video",
				"audio",
				"source",
				"figure",
				"figcaption",
				"picture",
				"details",
				"summary",
				"mark",
				"time",
				"main",
				"nav",
				"header",
				"footer",
				"section",
				"article",
				"aside",
			]),
			allowedAttributes: {
				...sanitizeHtml.defaults.allowedAttributes,
				img: ["src", "alt", "width", "height", "loading"],
				video: ["src", "controls", "width", "height", "poster", "preload"],
				audio: ["src", "controls", "preload"],
				source: ["src", "type"],
				a: ["href", "title", "target", "rel"],
				"*": ["class", "id", "style"],
			},
			allowedSchemes: ["http", "https", "data"],
			allowedStyles: {
				"*": {
					color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb/, /^hsl/, /^[a-z]+$/],
					"background-color": [/^#[0-9a-fA-F]{3,8}$/, /^rgb/, /^hsl/, /^[a-z]+$/],
					"font-size": [/^\d+(\.\d+)?(px|em|rem|%)$/],
					"font-weight": [/^\d{3}$/, /^(normal|bold|bolder|lighter)$/],
					"text-align": [/^(left|right|center|justify)$/],
					"text-decoration": [/^(none|underline|line-through|overline)$/],
					margin: [/^-?\d+(\.\d+)?(px|em|rem|%)(\s+-?\d+(\.\d+)?(px|em|rem|%)){0,3}$/],
					"margin-top": [/^-?\d+(\.\d+)?(px|em|rem|%)$/],
					"margin-bottom": [/^-?\d+(\.\d+)?(px|em|rem|%)$/],
					"margin-left": [/^-?\d+(\.\d+)?(px|em|rem|%)$/],
					"margin-right": [/^-?\d+(\.\d+)?(px|em|rem|%)$/],
					padding: [/^\d+(\.\d+)?(px|em|rem|%)(\s+\d+(\.\d+)?(px|em|rem|%)){0,3}$/],
					"padding-top": [/^\d+(\.\d+)?(px|em|rem|%)$/],
					"padding-bottom": [/^\d+(\.\d+)?(px|em|rem|%)$/],
					"padding-left": [/^\d+(\.\d+)?(px|em|rem|%)$/],
					"padding-right": [/^\d+(\.\d+)?(px|em|rem|%)$/],
					border: [/^\d+(\.\d+)?px\s+(solid|dashed|dotted|double|none)/],
					"border-radius": [/^\d+(\.\d+)?(px|em|rem|%)$/],
					// display: intentionally omitted — prevents layout attacks (e.g. contents, fixed)
					"max-width": [/^\d+(\.\d+)?(px|em|rem|%|vw)$/],
					"max-height": [/^\d+(\.\d+)?(px|em|rem|%|vh)$/],
					width: [/^\d+(\.\d+)?(px|em|rem|%|vw)$/],
					height: [/^\d+(\.\d+)?(px|em|rem|%|vh)$/],
				},
			},
		});

		return new Response(clean, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy":
					"default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:;",
				"Cache-Control": "no-cache",
			},
		});
	}

	// Non-HTML: serve inline with correct MIME type
	return new Response(file, {
		headers: {
			"Content-Type": contentType,
			"Content-Disposition": "inline",
			"Cache-Control": "private, max-age=3600",
		},
	});
});
