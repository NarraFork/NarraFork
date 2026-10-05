import { TEXT_FILE_EXTENSIONS } from "./text-file-types";

export type SharePreviewKind =
	| "image"
	| "video"
	| "audio"
	| "pdf"
	| "html"
	| "text"
	| "unsupported";
export type ShareTextFormat = "plain" | "code" | "json" | "markdown";
export interface SharePreviewType {
	kind: SharePreviewKind;
	mime: string;
	textFormat?: ShareTextFormat;
	/** Extensionless files require bounded content validation before enabling preview. */
	probeText?: boolean;
}
export interface SharePreviewRef extends SharePreviewType {
	filename: string;
	url?: string;
	downloadUrl: string;
	expiresAt?: string;
	reason?: "unsupported" | "compressed" | "tooLarge";
}
export const SHARE_TEXT_MAX_BYTES = 512 * 1024;
export const SHARE_TEXT_MAX_CHARS = 120_000;
export const SHARE_HTML_MAX_BYTES = 1024 * 1024;
export const SHARE_HTML_OUTPUT_MAX_BYTES = 2 * SHARE_HTML_MAX_BYTES;
export const SHARE_HTML_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export const SHARE_CONTENT_TIMEOUT_MS = 15_000;
export const SHARE_HTML_TIMEOUT_MS = 5_000;

const TYPES: Record<string, [SharePreviewKind, string]> = {
	jpg: ["image", "image/jpeg"],
	jpeg: ["image", "image/jpeg"],
	png: ["image", "image/png"],
	gif: ["image", "image/gif"],
	webp: ["image", "image/webp"],
	svg: ["image", "image/svg+xml"],
	avif: ["image", "image/avif"],
	bmp: ["image", "image/bmp"],
	ico: ["image", "image/x-icon"],
	mp4: ["video", "video/mp4"],
	m4v: ["video", "video/mp4"],
	webm: ["video", "video/webm"],
	mov: ["video", "video/quicktime"],
	ogv: ["video", "video/ogg"],
	mp3: ["audio", "audio/mpeg"],
	m4a: ["audio", "audio/mp4"],
	aac: ["audio", "audio/aac"],
	wav: ["audio", "audio/wav"],
	flac: ["audio", "audio/flac"],
	ogg: ["audio", "audio/ogg"],
	opus: ["audio", "audio/ogg"],
	pdf: ["pdf", "application/pdf"],
	html: ["html", "text/html; charset=utf-8"],
	htm: ["html", "text/html; charset=utf-8"],
};

export function classifySharePreview(filename: string): SharePreviewType {
	const base = filename.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
	// Arbitrary filenames must never resolve Object.prototype entries such as constructor.
	const mapped = Object.hasOwn(TYPES, ext) ? TYPES[ext] : undefined;
	if (mapped) return { kind: mapped[0], mime: mapped[1] };
	if (TEXT_FILE_EXTENSIONS.has(ext) || TEXT_FILE_EXTENSIONS.has(base)) {
		const textFormat =
			ext === "json"
				? "json"
				: ["md", "markdown"].includes(ext)
					? "markdown"
					: ["txt", "log", "csv", "tsv"].includes(ext)
						? "plain"
						: "code";
		return { kind: "text", mime: "text/plain; charset=utf-8", textFormat };
	}
	if (!ext)
		return {
			kind: "text",
			mime: "text/plain; charset=utf-8",
			textFormat: "plain",
			probeText: true,
		};
	return { kind: "unsupported", mime: "application/octet-stream" };
}

/** Validate a bounded UTF-8 prefix; an incomplete final codepoint is permitted. */
export function isShareText(bytes: Uint8Array, complete = false): boolean {
	for (const byte of bytes) {
		if (byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte))) return false;
	}
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !complete });
		return true;
	} catch {
		return false;
	}
}

/** Stable outer height, independent of asynchronous metadata or playback state. */
export function sharePreviewHeight(kind: SharePreviewKind, width: number): number {
	if (kind === "video") return Math.max(96, Math.min(300, (width * 9) / 16)) + 36;
	if (kind === "audio") return 112;
	if (kind === "unsupported") return 76;
	return 280;
}
