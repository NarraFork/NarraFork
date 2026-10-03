import { textDocumentStore } from "@frontend/lib/text-document-store";

export interface DocumentMatch {
	start: number;
	end: number;
}
/** Restart the entire search after an epoch replacement; no old carry/matches survive it. */
export async function findDocumentMatch(
	id: string,
	query: string,
	current: DocumentMatch | null,
	direction: 1 | -1,
	signal?: AbortSignal,
): Promise<DocumentMatch | null> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const epoch = textDocumentStore.getSnapshot(id)?.epoch;
		try {
			const match = await findSnapshotDocumentMatch(
				id,
				query,
				attempt ? null : current,
				direction,
				signal,
			);
			if (textDocumentStore.getSnapshot(id)?.epoch === epoch) return match;
		} catch (error) {
			if (signal?.aborted || textDocumentStore.getSnapshot(id)?.epoch === epoch) throw error;
		}
	}
	throw new Error("Document source changed repeatedly while searching");
}

/** Previous is a source search too; it never searches the mounted row DOM. */
async function findSnapshotDocumentMatch(
	id: string,
	query: string,
	current: DocumentMatch | null,
	direction: 1 | -1,
	signal?: AbortSignal,
): Promise<DocumentMatch | null> {
	if (!query) return null;
	if (direction === 1) {
		const next = await textDocumentStore.search(id, query, current?.end ?? 0, signal);
		return next ?? (current ? textDocumentStore.search(id, query, 0, signal) : null);
	}
	const length = textDocumentStore.getSnapshot(id)?.length ?? 0;
	const backwards = async (before: number): Promise<DocumentMatch | null> => {
		let end = before;
		let pages = 0;
		while (end > 0) {
			if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
			const start = Math.max(0, end - 8192);
			const text = await textDocumentStore.readRange(
				id,
				start,
				Math.min(length, end + query.length - 1),
				signal,
			);
			const offset = text.lastIndexOf(query, end - start - 1);
			if (offset >= 0) return { start: start + offset, end: start + offset + query.length };
			end = start;
			// Cache hits still yield to user input instead of chaining an entire scan's microtasks.
			if (++pages % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		return null;
	};
	return (await backwards(current?.start ?? length)) ?? (current ? backwards(length) : null);
}
