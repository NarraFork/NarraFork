import {
	type CreateEditorDocumentInput,
	type CreateEditorUploadInput,
	EDITOR_DOCUMENT_MAX_CHARS,
	EDITOR_IO_TIMEOUT_MS,
	EDITOR_METADATA_MAX_BYTES,
	EDITOR_TRANSFER_CHUNK_BYTES,
	EDITOR_TRANSFER_MAX_BYTES,
	type EditorCommitInput,
	type EditorCommitResult,
	type EditorDocumentDescriptor,
	type EditorOperationResult,
	type EditorUploadDescriptor,
} from "@shared/editor-document";
import { ApiError, authorizedFetch, readFetchError } from "./client";

function base(narratorId: string) {
	return `/api/narrators/${encodeURIComponent(narratorId)}/editor-documents`;
}
function documentPath(narratorId: string, docId: string) {
	return `${base(narratorId)}/${encodeURIComponent(docId)}`;
}
function uploadPath(narratorId: string, docId: string, uploadId: string) {
	return `${documentPath(narratorId, docId)}/uploads/${encodeURIComponent(uploadId)}`;
}

/** Bound actual streamed bytes, including responses without Content-Length. */
export async function readEditorBody(
	response: Response,
	limit: number,
	signal?: AbortSignal,
): Promise<Blob> {
	// Fetch exposes decompressed bytes; compressed Content-Length is not their length.
	const contentEncoding = response.headers.get("content-encoding");
	const lengthHeader =
		contentEncoding && contentEncoding !== "identity"
			? null
			: response.headers.get("content-length");
	const declaredBytes = lengthHeader === null ? null : Number(lengthHeader);
	if (
		declaredBytes !== null &&
		(!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > limit)
	) {
		await response.body?.cancel();
		throw new Error("Editor response exceeds its byte budget");
	}
	const reader = response.body?.getReader();
	if (!reader) {
		if (declaredBytes) throw new Error("Editor response ended before its declared length");
		return new Blob([]);
	}
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let pending = new Uint8Array(EDITOR_TRANSFER_CHUNK_BYTES);
	let pendingSize = 0;
	let size = 0;
	let yieldedAt = performance.now();
	const abort = () => {
		void reader.cancel(signal?.reason).catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error("Editor response exceeds its byte budget");
			let offset = 0;
			while (offset < value.length) {
				const copied = Math.min(value.length - offset, pending.length - pendingSize);
				pending.set(value.subarray(offset, offset + copied), pendingSize);
				pendingSize += copied;
				offset += copied;
				if (pendingSize === pending.length) {
					chunks.push(pending);
					pending = new Uint8Array(EDITOR_TRANSFER_CHUNK_BYTES);
					pendingSize = 0;
				}
			}
			if (performance.now() - yieldedAt > 8) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				yieldedAt = performance.now();
			}
		}
		if (declaredBytes !== null && declaredBytes !== size)
			throw new Error("Editor response length mismatch");
		if (pendingSize) chunks.push(pending.subarray(0, pendingSize));
		return new Blob(chunks, { type: "text/plain;charset=utf-8" });
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}

function timedSignal(signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(EDITOR_IO_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
async function checkedFetch(path: string, options: RequestInit, signal: AbortSignal) {
	const response = await authorizedFetch(path, { ...options, signal });
	if (!response.ok) {
		const body = await readEditorBody(response, EDITOR_METADATA_MAX_BYTES, signal);
		const bounded = new Response(body, { status: response.status, headers: response.headers });
		const failure = await readFetchError(bounded, "Editor request failed");
		throw new ApiError(failure.message, response.status, failure.data);
	}
	return response;
}
async function metadata<T>(
	path: string,
	method: string,
	input?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const boundedSignal = timedSignal(signal);
	if (
		input &&
		typeof input === "object" &&
		Object.values(input).some(
			(value) => typeof value === "string" && value.length > EDITOR_METADATA_MAX_BYTES,
		)
	)
		throw new Error("Editor metadata exceeds its byte budget");
	const body = input === undefined ? undefined : JSON.stringify(input);
	if (body && new TextEncoder().encode(body).byteLength > EDITOR_METADATA_MAX_BYTES)
		throw new Error("Editor metadata exceeds its byte budget");
	const response = await checkedFetch(
		path,
		{
			method,
			...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } }),
		},
		boundedSignal,
	);
	if (response.status === 204) return undefined as T;
	const result = await readEditorBody(response, EDITOR_METADATA_MAX_BYTES, boundedSignal);
	boundedSignal.throwIfAborted();
	return JSON.parse(await result.text()) as T;
}

export const editorDocumentApi = {
	create(narratorId: string, input: CreateEditorDocumentInput, signal?: AbortSignal) {
		return metadata<EditorDocumentDescriptor>(base(narratorId), "POST", input, signal);
	},
	async source(
		narratorId: string,
		docId: string,
		versionHandle: string,
		signal?: AbortSignal,
		expectedBytes?: number,
	): Promise<string> {
		const boundedSignal = timedSignal(signal);
		const response = await checkedFetch(
			`${documentPath(narratorId, docId)}/content?version=${encodeURIComponent(versionHandle)}`,
			{},
			boundedSignal,
		);
		const body = await readEditorBody(response, EDITOR_TRANSFER_MAX_BYTES, boundedSignal);
		if (expectedBytes !== undefined && body.size !== expectedBytes)
			throw new Error("Editor source length does not match its version metadata");
		// Blob.text uses the browser's asynchronous decoding path; no JSON or
		// unbounded string concatenation in the response consumption loop.
		const text = await body.text();
		boundedSignal.throwIfAborted();
		if (text.length > EDITOR_DOCUMENT_MAX_CHARS)
			throw new Error("Editor document exceeds its character budget");
		return text;
	},
	/** Explicitly incomplete display excerpt. Never use this result as editable source. */
	async sourcePreview(
		narratorId: string,
		docId: string,
		versionHandle: string,
		signal?: AbortSignal,
		maxChars = 32 * 1024,
	): Promise<{ content: string; truncated: boolean }> {
		if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 32 * 1024)
			throw new Error("Invalid editor excerpt budget");
		const boundedSignal = timedSignal(signal);
		const response = await checkedFetch(
			`${documentPath(narratorId, docId)}/content?version=${encodeURIComponent(versionHandle)}`,
			{},
			boundedSignal,
		);
		const reader = response.body?.getReader();
		if (!reader) return { content: "", truncated: false };
		const abort = () => {
			void reader.cancel(boundedSignal.reason).catch(() => {});
		};
		boundedSignal.addEventListener("abort", abort, { once: true });
		const decoder = new TextDecoder();
		let content = "";
		try {
			while (true) {
				boundedSignal.throwIfAborted();
				const { done, value } = await reader.read();
				boundedSignal.throwIfAborted();
				if (done) return { content: content + decoder.decode(), truncated: false };
				const bytes = Math.min(value.length, (maxChars - content.length) * 4 + 4);
				content += decoder.decode(value.subarray(0, bytes), { stream: true });
				if (content.length >= maxChars || bytes < value.length) {
					void reader.cancel().catch(() => {});
					return { content: content.slice(0, maxChars), truncated: true };
				}
			}
		} finally {
			boundedSignal.removeEventListener("abort", abort);
			void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	},
	async sourceBlob(
		narratorId: string,
		docId: string,
		versionHandle: string,
		signal?: AbortSignal,
	): Promise<Blob> {
		const boundedSignal = timedSignal(signal);
		const response = await checkedFetch(
			`${documentPath(narratorId, docId)}/content?version=${encodeURIComponent(versionHandle)}`,
			{},
			boundedSignal,
		);
		return readEditorBody(response, EDITOR_TRANSFER_MAX_BYTES, boundedSignal);
	},
	createUpload(
		narratorId: string,
		docId: string,
		input: CreateEditorUploadInput,
		signal?: AbortSignal,
	) {
		return metadata<EditorUploadDescriptor>(
			`${documentPath(narratorId, docId)}/uploads`,
			"POST",
			input,
			signal,
		);
	},
	async upload(
		narratorId: string,
		docId: string,
		uploadId: string,
		blob: Blob,
		signal?: AbortSignal,
	) {
		if (blob.size > EDITOR_TRANSFER_MAX_BYTES)
			throw new Error("Editor upload exceeds its byte budget");
		const boundedSignal = timedSignal(signal);
		const response = await checkedFetch(
			uploadPath(narratorId, docId, uploadId),
			{
				method: "PUT",
				body: blob,
				headers: { "Content-Type": "application/octet-stream" },
			},
			boundedSignal,
		);
		return JSON.parse(
			await (await readEditorBody(response, EDITOR_METADATA_MAX_BYTES, boundedSignal)).text(),
		) as EditorUploadDescriptor;
	},
	commit(
		narratorId: string,
		docId: string,
		uploadId: string,
		input: EditorCommitInput = {},
		signal?: AbortSignal,
	) {
		return metadata<EditorCommitResult>(
			`${uploadPath(narratorId, docId, uploadId)}/commit`,
			"POST",
			input,
			signal,
		);
	},
	getUpload(narratorId: string, docId: string, uploadId: string, signal?: AbortSignal) {
		return metadata<EditorUploadDescriptor>(
			uploadPath(narratorId, docId, uploadId),
			"GET",
			undefined,
			signal,
		);
	},
	operation(narratorId: string, operationId: string, signal?: AbortSignal) {
		return metadata<EditorOperationResult>(
			`/api/narrators/${encodeURIComponent(narratorId)}/editor-operations/${encodeURIComponent(operationId)}`,
			"GET",
			undefined,
			signal,
		);
	},
	cancelUpload(narratorId: string, docId: string, uploadId: string) {
		return metadata<unknown>(uploadPath(narratorId, docId, uploadId), "DELETE");
	},
	release(narratorId: string, docId: string) {
		return metadata<unknown>(documentPath(narratorId, docId), "DELETE");
	},
};
