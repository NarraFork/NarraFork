import {
	FILE_REFERENCE_READ_TIMEOUT_MS,
	FILE_REFERENCE_SEARCH_TIMEOUT_MS,
	type FileReferencePreview,
	type FileReferenceSearchResult,
	type FileTarget,
	MAX_FILE_REFERENCE_COUNT,
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_PATH_CHARS,
	MAX_FILE_REFERENCE_QUERY_CHARS,
	MAX_FILE_REFERENCE_SEARCH_BYTES,
	MAX_FILE_REFERENCE_SOURCE_BYTES,
} from "@shared/file-reference";
import {
	FILE_REFERENCE_IMAGE_MIME_TYPES,
	MAX_FILE_REFERENCE_IMAGE_BYTES,
} from "@shared/file-reference-image";
import { ApiError, authorizedFetch, readFetchError } from "./client";

function basePath(narratorId: string): string {
	return `/api/narrators/${encodeURIComponent(narratorId)}/file-references`;
}

/** Abort and reject over-budget bodies during streaming, before JSON.parse can allocate them. */
async function boundedRequest<T>(
	path: string,
	maxBytes: number,
	timeoutMs: number,
	options: RequestInit = {},
	decode?: (buffer: Uint8Array<ArrayBuffer>, response: Response) => T,
): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("File request timed out")), timeoutMs);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const response = await authorizedFetch(path, { ...options, signal: controller.signal });
		const responseLimit = response.ok ? maxBytes : MAX_FILE_REFERENCE_METADATA_BYTES;
		reader = response.body?.getReader();
		if (!reader) throw new Error("Empty file reference response");
		const cancelRead = () => {
			void reader?.cancel(controller.signal.reason).catch(() => {});
		};
		controller.signal.addEventListener("abort", cancelRead, { once: true });
		try {
			if (Number(response.headers.get("content-length")) > responseLimit)
				throw new Error("File reference response exceeds the byte limit");
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			while (true) {
				controller.signal.throwIfAborted();
				const chunk = await reader.read();
				controller.signal.throwIfAborted();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > responseLimit)
					throw new Error("File reference response exceeds the byte limit");
				chunks.push(chunk.value);
			}
			const buffer = new Uint8Array(bytes);
			let offset = 0;
			for (const chunk of chunks) {
				buffer.set(chunk, offset);
				offset += chunk.byteLength;
			}
			if (!response.ok) {
				const error = await readFetchError(
					new Response(buffer, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					}),
				);
				throw new ApiError(error.message, response.status, error.data);
			}
			return decode
				? decode(buffer, response)
				: (JSON.parse(new TextDecoder().decode(buffer)) as T);
		} finally {
			controller.signal.removeEventListener("abort", cancelRead);
		}
	} catch (error) {
		controller.abort(error);
		void reader?.cancel(error).catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		reader?.releaseLock();
	}
}

function decodeImage(buffer: Uint8Array<ArrayBuffer>, response: Response): Blob {
	const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (!mime || !Object.values(FILE_REFERENCE_IMAGE_MIME_TYPES).some((value) => value === mime))
		throw new Error("Unsupported file reference image MIME type");
	return new Blob([buffer], { type: mime });
}

/** Legacy local file panels only; scoped/remote readers must use imagePreview instead. */
export function localFileImagePreview(path: string, signal?: AbortSignal): Promise<Blob> {
	if (path.length > MAX_FILE_REFERENCE_PATH_CHARS)
		return Promise.reject(new Error("File path exceeds the limit"));
	return boundedRequest(
		`/api/fs/preview?${new URLSearchParams({ path })}`,
		MAX_FILE_REFERENCE_IMAGE_BYTES,
		FILE_REFERENCE_READ_TIMEOUT_MS,
		{ signal },
		decodeImage,
	);
}

/** Metadata-only search/resolve. Preview readers never create snapshots. */
export const fileReferenceApi = {
	search(
		narratorId: string,
		options: { q: string; deviceId?: string; directory?: string },
		signal?: AbortSignal,
	): Promise<FileReferenceSearchResult> {
		if (
			options.q.length > MAX_FILE_REFERENCE_QUERY_CHARS ||
			(options.directory?.length ?? 0) > MAX_FILE_REFERENCE_PATH_CHARS
		)
			return Promise.reject(new Error("File search query exceeds the limit"));
		const query = new URLSearchParams({ q: options.q });
		if (options.deviceId) query.set("deviceId", options.deviceId);
		if (options.directory) query.set("directory", options.directory);
		return boundedRequest(
			`${basePath(narratorId)}/search?${query}`,
			MAX_FILE_REFERENCE_SEARCH_BYTES,
			FILE_REFERENCE_SEARCH_TIMEOUT_MS,
			{ signal },
		);
	},
	resolve(
		narratorId: string,
		targets: FileTarget[],
		signal?: AbortSignal,
	): Promise<{ targets: FileTarget[] }> {
		if (
			targets.length > MAX_FILE_REFERENCE_COUNT ||
			targets.some((target) => target.path.length > MAX_FILE_REFERENCE_PATH_CHARS)
		)
			return Promise.reject(new Error("File targets exceed the limit"));
		const body = JSON.stringify({
			targets: targets.map(({ deviceId, path, selection }) => ({ deviceId, path, selection })),
		});
		if (new TextEncoder().encode(body).byteLength > MAX_FILE_REFERENCE_METADATA_BYTES)
			return Promise.reject(new Error("File target metadata exceeds the limit"));
		return boundedRequest(
			`${basePath(narratorId)}/resolve`,
			MAX_FILE_REFERENCE_SEARCH_BYTES,
			FILE_REFERENCE_READ_TIMEOUT_MS,
			{
				method: "POST",
				body,
				headers: { "Content-Type": "application/json" },
				signal,
			},
		);
	},
	/** Returned Blob is for an img object URL only, especially for SVG; never embed as HTML. */
	imagePreview(narratorId: string, target: FileTarget, signal?: AbortSignal): Promise<Blob> {
		if (target.path.length > MAX_FILE_REFERENCE_PATH_CHARS)
			return Promise.reject(new Error("File path exceeds the limit"));
		const query = new URLSearchParams({ deviceId: target.deviceId, path: target.path });
		return boundedRequest(
			`${basePath(narratorId)}/image-preview?${query}`,
			MAX_FILE_REFERENCE_IMAGE_BYTES,
			FILE_REFERENCE_READ_TIMEOUT_MS,
			{ signal },
			decodeImage,
		);
	},
	preview(
		narratorId: string,
		target: FileTarget,
		signal?: AbortSignal,
	): Promise<FileReferencePreview> {
		const query = new URLSearchParams({ deviceId: target.deviceId, path: target.path });
		// Preview returns saved source; positions belong to the separate resolver.
		return boundedRequest(
			`${basePath(narratorId)}/preview?${query}`,
			MAX_FILE_REFERENCE_SOURCE_BYTES * 6 + MAX_FILE_REFERENCE_METADATA_BYTES,
			FILE_REFERENCE_READ_TIMEOUT_MS,
			{ signal },
		);
	},
};
