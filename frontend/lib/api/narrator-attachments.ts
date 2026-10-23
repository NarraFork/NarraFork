import { ApiError, authorizedFetch, readFetchError } from "./client";

export interface AttachmentPreviewSelector {
	messageId: string;
	attachmentId: string;
}
const MAX_BYTES = 1024 * 1024;
/** Only server-owned occurrence selectors; no path, source device or workspace input. */
export const narratorAttachmentApi = {
	async preview(
		narratorId: string,
		selector: AttachmentPreviewSelector,
		callerSignal?: AbortSignal,
	) {
		if (
			![narratorId, selector.messageId, selector.attachmentId].every(
				(value) => typeof value === "string" && value.length > 0 && value.length <= 128,
			)
		)
			throw new Error("Attachment selector is unavailable");
		const controller = new AbortController();
		const signal = callerSignal
			? AbortSignal.any([callerSignal, controller.signal])
			: controller.signal;
		const timer = setTimeout(
			() => controller.abort(new Error("Attachment preview timed out")),
			5_000,
		);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		const cancel = () => {
			void reader?.cancel(signal.reason).catch(() => {});
		};
		try {
			const response = await authorizedFetch(
				`/api/narrators/${encodeURIComponent(narratorId)}/messages/${encodeURIComponent(selector.messageId)}/attachments/${encodeURIComponent(selector.attachmentId)}/preview`,
				{ signal },
			);
			const cap = response.ok ? MAX_BYTES : 64 * 1024;
			if (Number(response.headers.get("content-length")) > cap)
				throw new Error("Attachment preview exceeds its byte limit");
			reader = response.body?.getReader();
			if (!reader) throw new Error("Empty attachment preview");
			signal.addEventListener("abort", cancel, { once: true });
			const chunks: Uint8Array[] = [];
			let size = 0;
			while (true) {
				signal.throwIfAborted();
				const next = await reader.read();
				signal.throwIfAborted();
				if (next.done) break;
				size += next.value.byteLength;
				if (size > cap) throw new Error("Attachment preview exceeds its byte limit");
				chunks.push(next.value);
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			if (!response.ok) {
				const failure = await readFetchError(
					new Response(bytes, { status: response.status, headers: response.headers }),
				);
				throw new ApiError(failure.message, response.status, failure.data);
			}
			if (
				!response.headers.get("content-type")?.startsWith("text/plain") ||
				response.headers.get("X-Attachment-Truncated") !== "false" ||
				Number(response.headers.get("X-Attachment-Size")) !== size
			)
				throw new Error("Complete attachment preview is unavailable");
			return {
				content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				size,
				truncated: false as const,
			};
		} catch (error) {
			controller.abort(error);
			void reader?.cancel(error).catch(() => {});
			throw error;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			reader?.releaseLock();
		}
	},
};
