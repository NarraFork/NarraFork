import {
	type CreateEditorDocumentInput,
	type CreateEditorDraftAnchorInput,
	type CreateEditorUploadInput,
	EDITOR_DOCUMENT_MAX_CHARS,
	EDITOR_IO_TIMEOUT_MS,
	EDITOR_METADATA_MAX_BYTES,
	EDITOR_TRANSFER_CHUNK_BYTES,
	EDITOR_TRANSFER_MAX_BYTES,
	type EditorCommitInput,
	type EditorCommitResult,
	type EditorDiskState,
	type EditorDocumentDescriptor,
	type EditorDraftAnchorDescriptor,
	type EditorOperationResult,
	type EditorRawDocumentDescriptor,
	type EditorRawSeal,
	type EditorReadMode,
	type EditorRecoveryScope,
	type EditorRecoveryScopeInput,
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
	async uploadRaw(
		narratorId: string,
		docId: string,
		uploadId: string,
		spool: {
			seal?: EditorRawSeal;
			chunks(): AsyncIterable<{
				seq: number;
				offset: number;
				digest: string;
				data: Uint8Array<ArrayBuffer>;
			}>;
		},
		signal: AbortSignal,
	) {
		if (!spool.seal) throw new Error("EDITOR_ATTEMPT_INCOMPLETE");
		for await (const chunk of spool.chunks()) {
			for (let retry = 0; ; retry++) {
				try {
					const response = await checkedFetch(
						`${uploadPath(narratorId, docId, uploadId)}/chunks/${chunk.seq}`,
						{
							method: "PUT",
							headers: {
								"Content-Type": "application/octet-stream",
								"X-Editor-Offset": String(chunk.offset),
								"X-Editor-Bytes": String(chunk.data.length),
								"X-Editor-Digest": chunk.digest,
							},
							body: chunk.data,
						},
						timedSignal(signal),
					);
					await readEditorBody(response, EDITOR_METADATA_MAX_BYTES, signal);
					break;
				} catch (error) {
					if (signal.aborted || retry || (error instanceof ApiError && error.status < 500))
						throw error;
				}
			}
		}
		return metadata<EditorUploadDescriptor>(
			`${uploadPath(narratorId, docId, uploadId)}/seal`,
			"POST",
			spool.seal,
			signal,
		);
	},
	recoveryScope(narratorId: string, input: EditorRecoveryScopeInput, signal?: AbortSignal) {
		const query = new URLSearchParams({
			deviceId: input.deviceId ?? "local",
			origin: input.origin,
		});
		return metadata<EditorRecoveryScope>(
			`${base(narratorId)}/recovery-scope?${query}`,
			"GET",
			undefined,
			signal,
		);
	},
	createDraftAnchor(narratorId: string, input: CreateEditorDraftAnchorInput, signal?: AbortSignal) {
		return metadata<EditorDraftAnchorDescriptor>(
			`${base(narratorId)}/draft-anchors`,
			"POST",
			input,
			signal,
		);
	},
	getDraftAnchor(
		narratorId: string,
		anchorId: string,
		scope: EditorRecoveryScopeInput,
		signal?: AbortSignal,
	) {
		const query = new URLSearchParams({
			deviceId: scope.deviceId ?? "local",
			origin: scope.origin,
		});
		return metadata<EditorDraftAnchorDescriptor>(
			`${base(narratorId)}/draft-anchors/${encodeURIComponent(anchorId)}?${query}`,
			"GET",
			undefined,
			signal,
		);
	},
	releaseDraftAnchor(narratorId: string, anchorId: string, scope: EditorRecoveryScopeInput) {
		const query = new URLSearchParams({
			deviceId: scope.deviceId ?? "local",
			origin: scope.origin,
		});
		return metadata<{ released: boolean }>(
			`${base(narratorId)}/draft-anchors/${encodeURIComponent(anchorId)}?${query}`,
			"DELETE",
		);
	},
	publishDraftAnchor(
		narratorId: string,
		anchorId: string,
		scope: EditorRecoveryScopeInput,
		signal?: AbortSignal,
	) {
		return metadata<EditorDraftAnchorDescriptor>(
			`${base(narratorId)}/draft-anchors/${encodeURIComponent(anchorId)}/publish`,
			"POST",
			scope,
			signal,
		);
	},
	claimDraftAnchor(
		narratorId: string,
		anchorId: string,
		scope: EditorRecoveryScopeInput,
		signal?: AbortSignal,
	) {
		return metadata<EditorDraftAnchorDescriptor>(
			`${base(narratorId)}/draft-anchors/${encodeURIComponent(anchorId)}/claim`,
			"POST",
			scope,
			signal,
		);
	},
	/** No speculative next fetch: completion of consume is the application ACK. */
	async rawSource(
		narratorId: string,
		document: EditorRawDocumentDescriptor,
		consume: (bytes: Uint8Array<ArrayBuffer>, eof: boolean) => Promise<void>,
		signal: AbortSignal,
		credit: () => number = () => EDITOR_TRANSFER_CHUNK_BYTES,
	) {
		const path = `${documentPath(narratorId, document.docId)}/raw-reads`;
		const bounded = timedSignal(signal);
		const { readId } = await metadata<{ readId: string }>(
			path,
			"POST",
			{ versionHandle: document.versionHandle },
			bounded,
		);
		let offset = 0;
		try {
			for (;;) {
				bounded.throwIfAborted();
				const maxBytes = credit();
				if (
					!Number.isSafeInteger(maxBytes) ||
					maxBytes < 1 ||
					maxBytes > EDITOR_TRANSFER_CHUNK_BYTES
				)
					throw new Error("Invalid editor credit");
				const response = await checkedFetch(
					`${path}/${encodeURIComponent(readId)}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ offset, maxBytes }),
					},
					bounded,
				);
				const reader = response.body?.getReader();
				const buffer = new Uint8Array(maxBytes);
				let size = 0;
				const cancel = () => {
					void reader?.cancel(bounded.reason).catch(() => {});
				};
				bounded.addEventListener("abort", cancel, { once: true });
				try {
					while (reader) {
						bounded.throwIfAborted();
						const chunk = await reader.read();
						bounded.throwIfAborted();
						if (chunk.done) break;
						if (size + chunk.value.length > maxBytes)
							throw new Error("Editor raw chunk exceeds credit");
						buffer.set(chunk.value, size);
						size += chunk.value.length;
					}
				} catch (error) {
					await reader?.cancel(error);
					throw error;
				} finally {
					bounded.removeEventListener("abort", cancel);
					reader?.releaseLock();
				}
				const eof = response.headers.get("x-editor-eof");
				if (eof !== "0" && eof !== "1") throw new Error("Editor raw EOF marker missing");
				offset += size;
				if (
					offset > document.sourceBytes ||
					(!size && eof !== "1") ||
					(eof === "1" && offset !== document.sourceBytes)
				)
					throw new Error("Editor raw source length mismatch");
				await consume(buffer.subarray(0, size), eof === "1");
				bounded.throwIfAborted();
				if (eof === "1") break;
			}
		} finally {
			// Deliberately not the cancelled load signal: closing must still reach the server.
			await metadata(`${path}/${encodeURIComponent(readId)}`, "DELETE").catch(() => {});
		}
	},
	async readMode(
		narratorId: string,
		input: Pick<CreateEditorDocumentInput, "path" | "deviceId" | "origin">,
		signal?: AbortSignal,
	): Promise<EditorReadMode> {
		const legacy = input.deviceId && input.deviceId !== "local" ? "bounded-preview" : "text-v1";
		const query = new URLSearchParams({
			path: input.path,
			deviceId: input.deviceId ?? "local",
			origin: input.origin,
		});
		let result: { protocols: string[]; readMode?: EditorReadMode };
		try {
			result = await metadata(
				`${base(narratorId)}/capabilities?${query}`,
				"GET",
				undefined,
				signal,
			);
		} catch (error) {
			if (!(error instanceof ApiError) || error.status !== 404) throw error;
			return legacy;
		}
		if (["raw-v2", "text-v1", "bounded-preview"].includes(result.readMode ?? ""))
			return result.readMode as EditorReadMode;
		// An older Host's protocol list is not proof of this target's raw capability.
		if (Array.isArray(result.protocols) && result.protocols.includes("text-v1")) return legacy;
		throw new Error("Editor protocol negotiation unavailable");
	},
	async create(narratorId: string, input: CreateEditorDocumentInput, signal?: AbortSignal) {
		const document = await metadata<EditorDocumentDescriptor>(
			base(narratorId),
			"POST",
			input,
			signal,
		);
		if (input.protocol === "raw-v2" && document.protocol !== "raw-v2") {
			await metadata(`${documentPath(narratorId, document.docId)}`, "DELETE").catch(() => {});
			throw new Error("Raw editor protocol unavailable; refresh file capabilities");
		}
		return document;
	},
	diskState(narratorId: string, docId: string, signal?: AbortSignal) {
		return metadata<EditorDiskState>(
			`${documentPath(narratorId, docId)}/disk-state`,
			"GET",
			undefined,
			signal,
		);
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
