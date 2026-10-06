import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { textDocumentStore } from "../lib/text-document-store";
import { EMPTY_DOCUMENT_VIEW, TextDocumentViewSession } from "../lib/text-document-view-session";
import { textDocumentWorkerClient } from "../lib/text-document-worker-client";
import type {
	DocumentPosition,
	TextDocumentViewOptions,
} from "../lib/text-document-worker-protocol";

export type { TextDocumentViewOptions } from "../lib/text-document-worker-protocol";

/** Main thread only reads/paints bounded raw windows; two independent worker pumps do all CPU work. */
export function useTextDocumentView(ref: TextDocumentRef, options: TextDocumentViewOptions) {
	const subscribe = useCallback(
		(listener: () => void) => textDocumentStore.subscribe(ref.id, listener),
		[ref.id],
	);
	const snapshot = useCallback(() => textDocumentStore.getSnapshot(ref.id), [ref.id]);
	const stored = useSyncExternalStore(subscribe, snapshot, snapshot);
	const current = stored ?? ref;
	const documentKey = JSON.stringify([current.id, current.epoch]);
	const [result, setResult] = useState(EMPTY_DOCUMENT_VIEW);
	const session = useMemo(
		() => new TextDocumentViewSession(textDocumentWorkerClient, setResult),
		[],
	);
	const optionsKey = JSON.stringify(options);
	const viewOptions = useMemo(
		() => JSON.parse(optionsKey) as TextDocumentViewOptions,
		[optionsKey],
	);

	useEffect(() => {
		const registered = textDocumentStore.getSnapshot(ref.id);
		if (!registered || registered.epoch === ref.epoch) textDocumentStore.register(ref);
	}, [ref]);
	useEffect(() => {
		const release = textDocumentWorkerClient.retain(ref.id);
		return () => {
			session.stop();
			release();
		};
	}, [ref.id, session]);
	useEffect(() => {
		// Appends merge the latest targets; they do not abort an already-running
		// prefix or discard its valid visible rows/colours when it finishes.
		session.setTarget(current, viewOptions);
	}, [current, viewOptions, session]);

	const visible = result.documentKey === documentKey ? result : EMPTY_DOCUMENT_VIEW;
	const retry = useCallback(() => {
		textDocumentWorkerClient.retry();
		session.stop();
		session.setTarget(current, viewOptions);
	}, [session, current, viewOptions]);
	const locateOffset = useCallback(
		(offset: number): Promise<DocumentPosition> =>
			textDocumentWorkerClient.position(current, viewOptions, offset),
		[current, viewOptions],
	);
	const positionAtOffset = useCallback(
		(offset: number): DocumentPosition | undefined => {
			for (const row of visible.rows) {
				if (offset < row.start || offset > row.end) continue;
				let lo = 0,
					hi = row.points.length;
				while (lo < hi) {
					const mid = (lo + hi) >>> 1;
					if (row.points[mid].offset <= offset) lo = mid + 1;
					else hi = mid;
				}
				return {
					index: row.index,
					top: row.top,
					left: row.points[Math.max(0, lo - 1)]?.x ?? row.left,
				};
			}
			return undefined;
		},
		[visible],
	);
	const offsetAtPosition = useCallback(
		(x: number, y: number): number => {
			const rows = visible.rows;
			if (!rows.length) return 0;
			const row =
				rows.find((row) => y >= row.top && y < row.top + row.height) ??
				(y < rows[0].top ? rows[0] : rows[rows.length - 1]);
			const points = row.points;
			let lo = 0,
				hi = points.length;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (points[mid].x < x) lo = mid + 1;
				else hi = mid;
			}
			if (!lo) return points[0]?.offset ?? row.start;
			if (lo === points.length) return points[lo - 1]?.offset ?? row.end;
			return x - points[lo - 1].x < points[lo].x - x ? points[lo - 1].offset : points[lo].offset;
		},
		[visible],
	);

	return { ...visible, retry, locateOffset, positionAtOffset, offsetAtPosition };
}
