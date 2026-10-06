import { textDocumentStore } from "@frontend/lib/text-document-store";
import type {
	TextDocumentRangeReader,
	TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import type { WriteDocumentSourceEnsurer } from "./useWriteDocumentSources";

const retiredEpochs = new Set<string>();
let reboundSequence = 0;
const epochKey = (ref: TextDocumentRef) => JSON.stringify([ref.id, ref.epoch]);

/** A stale descriptor must not roll a recovered local document back to retired bytes. */
export function currentRecoveredDocumentRef(ref: TextDocumentRef): TextDocumentRef {
	return retiredEpochs.has(epochKey(ref)) ? (textDocumentStore.getSnapshot(ref.id) ?? ref) : ref;
}

export class DocumentSourceReboundError extends Error {
	readonly code = "TEXT_DOCUMENT_SOURCE_REBOUND";
	constructor() {
		super("Document source was rebound; restart the read from the new epoch");
	}
}

/** Stable UI id/raw offsets, but every regenerated source gets a fresh byte-cache epoch. */
export function recoveringDocumentRangeReader(
	reader: TextDocumentRangeReader,
	ensure?: WriteDocumentSourceEnsurer,
): TextDocumentRangeReader {
	const active = new Map<string, { localEpoch: string; transport: TextDocumentRef }>();
	const jobs = new Map<string, Promise<TextDocumentRef>>();
	const recover: TextDocumentRangeReader = async (local, offset, limit, signal) => {
		const retired = retiredEpochs.has(epochKey(local));
		if (retired && textDocumentStore.getSnapshot(local.id)?.epoch !== local.epoch)
			throw new DocumentSourceReboundError();
		const mapping = active.get(local.id);
		const transport = mapping?.localEpoch === local.epoch ? mapping.transport : local;
		let response: Awaited<ReturnType<TextDocumentRangeReader>>;
		try {
			if (retired) {
				// A cached descriptor can outlive its evicted rebound. Do not read
				// retired bytes, but let the existing exact-pin recovery regenerate it.
				throw Object.assign(new Error("Document rebound was evicted"), {
					status: 404,
					code: "TEXT_DOCUMENT_SOURCE_EXPIRED",
				});
			}
			response = await reader(transport, offset, limit, signal);
		} catch (error) {
			const detail = error as {
				status?: number;
				code?: string;
				message?: string;
				data?: { code?: string };
			};
			const code = detail?.data?.code ?? detail?.code ?? detail?.message ?? "";
			const stale =
				detail?.status === 404 ||
				/(?:TEXT_DOCUMENT_)?(?:INVALID_SOURCE|SOURCE_EXPIRED|SOURCE_NOT_FOUND|NOT_FOUND|EXPIRED)/.test(
					code,
				);
			const source = textDocumentStore.getSnapshot(local.id)?.source ?? local.source;
			if (
				!ensure ||
				!stale ||
				signal?.aborted ||
				!source?.toolCallId ||
				!source.messageId ||
				!Number.isSafeInteger(source.executionAttempt) ||
				(source.executionAttempt as number) < 0
			)
				throw error;
			const key = epochKey(local);
			let job = jobs.get(key);
			if (!job) {
				job = ensure(source.narratorId, source.toolUseId, {
					toolCallId: source.toolCallId,
					messageId: source.messageId,
					executionAttempt: source.executionAttempt,
				}).finally(() => jobs.delete(key));
				jobs.set(key, job);
			}
			const fresh = await job;
			if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
			if (
				fresh.source?.toolCallId !== source.toolCallId ||
				fresh.source?.messageId !== source.messageId ||
				fresh.source?.executionAttempt !== source.executionAttempt ||
				fresh.source?.narratorId !== source.narratorId ||
				fresh.source?.toolUseId !== source.toolUseId ||
				fresh.source?.field !== "content"
			)
				throw new Error("Recovered document differs from its pinned source");
			const latest = textDocumentStore.getSnapshot(local.id);
			if (latest && latest.epoch !== local.epoch) throw new DocumentSourceReboundError();
			const rebound = {
				...fresh,
				id: local.id,
				epoch: `recovered:${++reboundSequence}:${fresh.id}`,
				revision: Math.max(local.revision + 1, fresh.revision),
				preview: undefined,
			};
			active.set(local.id, { localEpoch: rebound.epoch, transport: fresh });
			retiredEpochs.add(key);
			if (active.size > 8192) active.delete(active.keys().next().value as string);
			if (retiredEpochs.size > 8192)
				retiredEpochs.delete(retiredEpochs.values().next().value as string);
			// register(new epoch) drops ALL cached pages before any new bytes can be returned.
			textDocumentStore.register(rebound, recover);
			throw new DocumentSourceReboundError();
		}
		if (retiredEpochs.has(epochKey(local))) throw new DocumentSourceReboundError();
		if (response.ref.id !== transport.id || response.ref.epoch !== transport.epoch)
			throw new Error("Document source changed during range read");
		return transport.id === local.id && transport.epoch === local.epoch
			? response
			: {
					...response,
					ref: { ...local, complete: response.ref.complete, originKnown: response.ref.originKnown },
				};
	};
	return recover;
}

/** A multi-page copy/find must restart, not retain already collected pages across a rebind. */
export async function readCurrentDocumentRange(
	id: string,
	start: number,
	end?: number,
	signal?: AbortSignal,
): Promise<string> {
	if (!textDocumentStore.getSnapshot(id)) throw new Error("Document source is missing");
	// The inner read pin ends before its Promise reaches this wrapper. Keep a
	// logical operation pin through epoch validation/retries, so a concurrent
	// streaming reset cannot delete a successfully read source in that gap.
	const release = textDocumentStore.retain(id);
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			const before = textDocumentStore.getSnapshot(id);
			if (!before) throw new Error("Document source is missing");
			const limit = Math.min(before.length, end ?? before.length);
			try {
				const text = await textDocumentStore.readRange(id, Math.min(start, limit), limit, signal);
				if (textDocumentStore.getSnapshot(id)?.epoch === before.epoch) return text;
			} catch (error) {
				if (signal?.aborted || textDocumentStore.getSnapshot(id)?.epoch === before.epoch)
					throw error;
			}
		}
		throw new Error("Document source changed repeatedly while reading");
	} finally {
		release();
	}
}
