import {
	SHARE_HTML_OUTPUT_MAX_BYTES,
	SHARE_TEXT_MAX_BYTES,
	SHARE_TEXT_MAX_CHARS,
	type SharePreviewRef,
} from "@shared/share-preview";
import { apiUrl } from "../../../../lib/base-path";

export type SharePreviewError =
	| "unavailable"
	| "unsupported"
	| "tooLarge"
	| "busy"
	| "timeout"
	| "loadError"
	| "codec";
export function shareErrorForStatus(status: number): SharePreviewError {
	if (status === 404 || status === 410) return "unavailable";
	if (status === 400 || status === 422) return "unsupported";
	if (status === 413) return "tooLarge";
	if (status === 429) return "busy";
	if (status === 504) return "timeout";
	return "loadError";
}

/** Never turn stored tool metadata into an arbitrary iframe or authenticated URL. */
export function sharePreviewUrl(ref: SharePreviewRef): string | null {
	return ref.url && /^\/api\/shares\/[\w-]+\/preview$/.test(ref.url) ? apiUrl(ref.url) : null;
}
export function shareDownloadUrl(ref: SharePreviewRef): string | null {
	return /^\/api\/shares\/[\w-]+$/.test(ref.downloadUrl) ? apiUrl(ref.downloadUrl) : null;
}

export function readShareText(response: Response, signal: AbortSignal) {
	return readShareContent(response, signal, SHARE_TEXT_MAX_BYTES, SHARE_TEXT_MAX_CHARS);
}
export function readShareHtml(response: Response, signal: AbortSignal) {
	return readShareContent(
		response,
		signal,
		SHARE_HTML_OUTPUT_MAX_BYTES,
		SHARE_HTML_OUTPUT_MAX_BYTES,
	);
}
async function readShareContent(
	response: Response,
	signal: AbortSignal,
	maxBytes: number,
	maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { text: "", truncated: false };
	const decoder = new TextDecoder();
	let text = "";
	let byteCount = 0;
	let truncated = response.headers.get("x-preview-truncated") === "true";
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		signal.throwIfAborted();
		while (true) {
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			const available = maxBytes - byteCount;
			const chunk = value.subarray(0, available);
			byteCount += chunk.length;
			text += decoder.decode(chunk, { stream: true });
			if (value.length > available || text.length > maxChars) {
				truncated = true;
				break;
			}
		}
		if (!truncated) text += decoder.decode();
		return {
			text: text.slice(0, maxChars),
			truncated: truncated || text.length > maxChars,
		};
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
	}
}

export function formatShareJson(text: string, truncated: boolean): string {
	if (truncated || text.length > SHARE_TEXT_MAX_CHARS) return text;
	try {
		JSON.parse(text); // Validate bounded input, but never stringify with quadratic indentation.
		const parts: string[] = [];
		let length = 0;
		let depth = 0;
		let quoted = false;
		let escaped = false;
		let previous = "";
		for (const char of text) {
			let fragment = char;
			if (quoted) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') quoted = false;
			} else {
				if (/\s/.test(char)) continue;
				if (char !== "}" && char !== "]" && (previous === "{" || previous === "["))
					fragment = `\n${"  ".repeat(depth)}${char}`;
				if (char === '"') quoted = true;
				else if (char === "{" || char === "[") {
					if (++depth > 32) return text;
				} else if (char === "}" || char === "]") {
					depth--;
					if (previous !== "{" && previous !== "[") fragment = `\n${"  ".repeat(depth)}${char}`;
				} else if (char === ",") fragment = `,\n${"  ".repeat(depth)}`;
				else if (char === ":") fragment = ": ";
			}
			if (length + fragment.length > SHARE_TEXT_MAX_CHARS) return text;
			parts.push(fragment);
			length += fragment.length;
			previous = char;
		}
		return parts.join("");
	} catch {
		return text;
	}
}

export function releaseShareMedia(media: HTMLMediaElement | null): void {
	if (!media) return;
	media.pause();
	media.removeAttribute("src");
	media.load();
}
