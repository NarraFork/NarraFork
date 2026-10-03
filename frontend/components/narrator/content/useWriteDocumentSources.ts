import type {
	TextDocumentRangeReader,
	TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import { isTextDocumentRef } from "@shared/pretext-layout/tool-detail";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { receiveWriteDocument } from "./document-source";

export interface WriteDocumentSourcePin {
	toolCallId?: string;
	messageId?: string;
	executionAttempt?: number;
}
export interface WriteDocumentSourceRequest extends WriteDocumentSourcePin {
	toolUseId: string;
}
export type WriteDocumentSourceEnsurer = (
	narratorId: string,
	toolUseId: string,
	pin?: WriteDocumentSourcePin,
	signal?: AbortSignal,
) => Promise<TextDocumentRef>;

export function isExactWriteDocumentPin(
	pin?: WriteDocumentSourcePin,
): pin is Required<WriteDocumentSourcePin> {
	return (
		!!pin?.toolCallId &&
		!!pin.messageId &&
		Number.isSafeInteger(pin.executionAttempt) &&
		(pin.executionAttempt as number) >= 0
	);
}

export function writeDocumentSourceKey(toolUseId: string, pin?: WriteDocumentSourcePin): string {
	return JSON.stringify([
		toolUseId,
		pin?.toolCallId ?? null,
		pin?.messageId ?? null,
		pin?.executionAttempt ?? null,
	]);
}

/** Historical Writes recover a descriptor, not a giant full-detail HTTP/React payload. */
export function useWriteDocumentSources(
	narratorId: string,
	requests: readonly WriteDocumentSourceRequest[],
	ensure: WriteDocumentSourceEnsurer | undefined,
	reader: TextDocumentRangeReader | undefined,
) {
	const client = useQueryClient();
	const observed = useRef({
		narratorId,
		writes: new Set<string>(),
		retained: new Map<string, TextDocumentRef>(),
		errors: new Set<string>(),
	});
	if (observed.current.narratorId !== narratorId)
		observed.current = { narratorId, writes: new Set(), retained: new Map(), errors: new Set() };
	const noteWrite = useCallback((toolUseId: string, pin?: WriteDocumentSourcePin) => {
		observed.current.writes.add(writeDocumentSourceKey(toolUseId, pin));
		if (observed.current.writes.size > 8192)
			observed.current.writes.delete(observed.current.writes.values().next().value as string);
	}, []);
	const isWrite = useCallback(
		(toolUseId: string, pin?: WriteDocumentSourcePin) =>
			observed.current.writes.has(writeDocumentSourceKey(toolUseId, pin)),
		[],
	);
	const wanted = useMemo(() => {
		const unique = new Map<string, WriteDocumentSourceRequest>();
		for (const request of requests)
			if (isWrite(request.toolUseId, request) && isExactWriteDocumentPin(request))
				unique.set(writeDocumentSourceKey(request.toolUseId, request), request);
		return [...unique.values()].slice(0, 6);
	}, [requests, isWrite]);
	const results = useQueries({
		queries: wanted.map((request) => ({
			queryKey: [
				"write-document-source",
				narratorId,
				writeDocumentSourceKey(request.toolUseId, request),
			],
			queryFn: ({ signal }: { signal: AbortSignal }) => {
				if (!ensure) throw new Error("Write document source transport unavailable");
				return ensure(narratorId, request.toolUseId, request, signal);
			},
			enabled: !!ensure,
			staleTime: 10 * 60 * 1000,
			gcTime: 10 * 60 * 1000,
			retry: 1,
		})),
	});
	for (const [index, result] of results.entries()) {
		const key = writeDocumentSourceKey(wanted[index].toolUseId, wanted[index]);
		if (isTextDocumentRef(result.data)) {
			observed.current.retained.set(key, result.data);
			observed.current.errors.delete(key);
		} else if (result.isError) observed.current.errors.add(key);
		else observed.current.errors.delete(key);
	}
	const revision = JSON.stringify([
		[...observed.current.retained]
			.map(([key, ref]) => [key, ref.id, ref.epoch, ref.revision, ref.length, ref.complete])
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		[...observed.current.errors].sort(),
	]);
	// The primitive revision changes only when a descriptor arrives; scroll/query observers cannot rebuild the list.
	const resolve = useCallback(
		(toolUseId: string, pin?: WriteDocumentSourcePin) => {
			void revision;
			const document = observed.current.retained.get(writeDocumentSourceKey(toolUseId, pin));
			return document
				? receiveWriteDocument({ ref: document, offset: 0 }, undefined, reader)
				: undefined;
		},
		[revision, reader],
	);
	const hasError = useCallback(
		(toolUseId: string, pin?: WriteDocumentSourcePin) => {
			void revision;
			return observed.current.errors.has(writeDocumentSourceKey(toolUseId, pin));
		},
		[revision],
	);
	const retryErrors = useCallback(() => {
		void client.invalidateQueries({
			queryKey: ["write-document-source", narratorId],
			predicate: (query) => query.state.status === "error",
		});
	}, [client, narratorId]);
	return { noteWrite, isWrite, resolve, hasError, retryErrors };
}
