import { type ProgressPhase, shouldShowThinkingChars } from "@shared/progress-phase";
import { useCallback, useSyncExternalStore } from "react";

export interface CompactProgressSnapshot {
	phase: ProgressPhase;
	thinkingChars: number;
	outputChars: number;
	retryCount: number;
}

export interface CompactProgressLabels {
	compacting: string;
	segmentCompacting: string;
	outputChars: string;
	thinking: string;
	thinkingChars: string;
	retrying: string;
}

type Listener = () => void;

const snapshots = new Map<string, CompactProgressSnapshot>();
const listeners = new Map<string, Set<Listener>>();

function snapshotKey(messageId: string, isSegment: boolean): string {
	return `${isSegment ? "segment" : "context"}:${messageId}`;
}

function sameSnapshot(a: CompactProgressSnapshot | undefined, b: CompactProgressSnapshot): boolean {
	return (
		a?.phase === b.phase &&
		a?.thinkingChars === b.thinkingChars &&
		a?.outputChars === b.outputChars &&
		a?.retryCount === b.retryCount
	);
}

function notify(key: string): void {
	for (const listener of listeners.get(key) ?? []) listener();
}

/**
 * Store only the label-driving snapshot fields. Call sites may pass a wider WS
 * event object; mode/model/output/thinking blobs must never enter the Map.
 */
function toSnapshot(progress: CompactProgressSnapshot): CompactProgressSnapshot {
	return {
		phase: progress.phase,
		thinkingChars: progress.thinkingChars,
		outputChars: progress.outputChars,
		retryCount: progress.retryCount ?? 0,
	};
}

export function setCompactProgress(
	messageId: string,
	isSegment: boolean,
	progress: CompactProgressSnapshot,
): void {
	if (!messageId) return;
	const key = snapshotKey(messageId, isSegment);
	const next = toSnapshot(progress);
	if (sameSnapshot(snapshots.get(key), next)) return;
	snapshots.set(key, next);
	notify(key);
}

export function getCompactProgress(
	messageId: string | null | undefined,
	isSegment: boolean,
): CompactProgressSnapshot | null {
	return messageId ? (snapshots.get(snapshotKey(messageId, isSegment)) ?? null) : null;
}

export function clearCompactProgress(
	messageId: string | null | undefined,
	isSegment?: boolean,
): void {
	if (!messageId) return;
	if (isSegment == null) {
		clearCompactProgress(messageId, false);
		clearCompactProgress(messageId, true);
		return;
	}
	const key = snapshotKey(messageId, isSegment);
	if (!snapshots.delete(key)) return;
	notify(key);
}

export function clearAllCompactProgress(): void {
	if (snapshots.size === 0) return;
	const keys = [...snapshots.keys()];
	snapshots.clear();
	for (const key of keys) notify(key);
}

/**
 * Clear every identity a COW compact replacement may name.
 *
 * Progress is keyed by the `messageId` that `compact_progress` broadcast (the
 * marker being compacted). `compact_done` only carries that id on retries, and
 * when it does the payload often names the NEW id under `messageId`/
 * `newMessageId` while the OLD id rides `oldMessageId`/`replacedMessageId`.
 * Clearing only `replacement.messageId` therefore misses the common case.
 *
 * Returns true when at least one non-empty alias id was attempted.
 */
export function clearCompactProgressAliases(
	aliases:
		| {
				oldMessageId?: string;
				replacedMessageId?: string;
				messageId?: string;
				newMessageId?: string;
				replacementMessageId?: string;
		  }
		| null
		| undefined,
	isSegment?: boolean,
): boolean {
	const ids = [
		aliases?.oldMessageId,
		aliases?.replacedMessageId,
		aliases?.messageId,
		aliases?.newMessageId,
		aliases?.replacementMessageId,
	];
	const seen = new Set<string>();
	let attempted = false;
	for (const id of ids) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		attempted = true;
		clearCompactProgress(id, isSegment);
	}
	return attempted;
}

function subscribeCompactProgress(key: string | null, listener: Listener): () => void {
	if (!key) return () => {};
	let bucket = listeners.get(key);
	if (!bucket) {
		bucket = new Set();
		listeners.set(key, bucket);
	}
	bucket.add(listener);
	return () => {
		bucket?.delete(listener);
		if (bucket?.size === 0) listeners.delete(key);
	};
}

export function useCompactProgress(
	messageId: string | null | undefined,
	isSegment: boolean,
): CompactProgressSnapshot | null {
	const key = messageId ? snapshotKey(messageId, isSegment) : null;
	const subscribe = useCallback(
		(listener: Listener) => subscribeCompactProgress(key, listener),
		[key],
	);
	const getSnapshot = useCallback(() => (key ? (snapshots.get(key) ?? null) : null), [key]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function interpolate(template: string, count: number): string {
	return template.replace(/\{\{count\}\}|\{count\}/g, String(count));
}

export function formatCompactProgressText(
	labels: CompactProgressLabels,
	progress: CompactProgressSnapshot,
	isSegment: boolean,
): string {
	const label = isSegment ? labels.segmentCompacting : labels.compacting;
	if (progress.retryCount > 0)
		return `${label} · ${interpolate(labels.retrying, progress.retryCount)}`;
	if (progress.phase === "thinking") {
		if (!shouldShowThinkingChars(progress.thinkingChars)) return `${label} · ${labels.thinking}`;
		return `${label} · ${labels.thinking} · ${interpolate(labels.thinkingChars, progress.thinkingChars)}`;
	}
	return `${label} · ${interpolate(labels.outputChars, progress.outputChars)}`;
}
