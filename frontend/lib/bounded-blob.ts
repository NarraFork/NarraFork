/** Stream the byte budget, never read an unbounded Blob then check its size. */
export async function readBoundedBlob(
	response: Response,
	maxBytes = 8 * 1024 * 1024,
	signal?: AbortSignal,
): Promise<Blob> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("INVALID_BLOB_BUDGET");
	const fail = () => new Error("RESOURCE_TOO_LARGE");
	if (Number(response.headers.get("content-length")) > maxBytes) {
		void response.body?.cancel().catch(() => {});
		throw fail();
	}
	const reader = response.body?.getReader();
	if (!reader) return new Blob([], { type: response.headers.get("content-type") ?? "" });
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let bytes = 0;
	const abort = () => {
		void reader.cancel(signal?.reason).catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		signal?.throwIfAborted();
		while (true) {
			const { value, done } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel();
				throw fail();
			}
			chunks.push(new Uint8Array(value));
		}
		return new Blob(chunks, {
			type: response.headers.get("content-type") ?? "application/octet-stream",
		});
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
