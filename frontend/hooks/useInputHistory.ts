import {
	type FileReferenceInput,
	readFileReferences,
	sameFileReferenceInput,
	trimFileReferenceInput,
} from "@frontend/components/narrator/composer/file-reference-input";
import { readSession, removeSession, writeSession } from "@frontend/lib/session-store";
import type { FileReference } from "@shared/file-reference";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

const MAX_HISTORY = 50;
/**
 * Longest single entry kept for recall.
 *
 * Was 20k. Recall exists so the user can re-send something they just typed; a
 * multi-thousand-character body is retrieved from the transcript, not with the up
 * arrow. The old ceiling let 50 entries reach 1M characters for ONE narrator,
 * against a ~5MB area shared by every narrator the tab ever opened.
 */
export const MAX_HISTORY_MESSAGE_CHARS = 2_000;
/** Whole-list ceiling, enforced on write so the list is trimmed rather than dropped. */
const MAX_HISTORY_STORAGE_CHARS = 24_000;

function readHistoryEntry(value: unknown): FileReferenceInput | null {
	if (typeof value === "string")
		return value.length <= MAX_HISTORY_MESSAGE_CHARS ? { text: value, fileReferences: [] } : null;
	if (!value || typeof value !== "object") return null;
	const entry = value as FileReferenceInput;
	if (typeof entry.text !== "string" || entry.text.length > MAX_HISTORY_MESSAGE_CHARS) return null;
	return { text: entry.text, fileReferences: readFileReferences(entry.fileReferences, entry.text) };
}

export function readInputHistoryEntries(storageKey: string | null): FileReferenceInput[] {
	if (storageKey === null) return [];
	try {
		const raw = readSession("narrator-history", storageKey);
		if (!raw || raw.length > MAX_HISTORY_STORAGE_CHARS) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.slice(0, MAX_HISTORY)
			.map(readHistoryEntry)
			.filter((entry): entry is FileReferenceInput => entry !== null);
	} catch {
		return [];
	}
}

/**
 * Write a history list under the CURRENT limits.
 *
 * Exported so the legacy-key sweep can adopt a pre-facade list without copying
 * the trimming rules: entries past the per-message ceiling are dropped, then the
 * list is trimmed from the oldest end until it fits. A second implementation
 * would be the thing that lets the two drift.
 */
export function writeInputHistoryEntries(
	storageId: string,
	entries: Array<string | FileReferenceInput>,
): void {
	const kept = entries
		.map(readHistoryEntry)
		.filter((entry): entry is FileReferenceInput => entry !== null)
		.slice(0, MAX_HISTORY)
		.map((entry) => (entry.fileReferences.length ? entry : entry.text));
	if (kept.length === 0) {
		removeSession("narrator-history", storageId);
		return;
	}
	let list = kept;
	let serialized = JSON.stringify(list);
	while (list.length > 1 && serialized.length > MAX_HISTORY_STORAGE_CHARS) {
		list = list.slice(0, -1);
		serialized = JSON.stringify(list);
	}
	if (serialized.length > MAX_HISTORY_STORAGE_CHARS) {
		removeSession("narrator-history", storageId);
		return;
	}
	writeSession("narrator-history", storageId, serialized);
}

/**
 * 消息输入历史记录 hook。
 * 记录用户发送的消息，支持上下箭头翻阅。
 * 历史按 sessionStorage 持久化（页面刷新后保留，关闭标签页后清空）。
 *
 * 写入经由 `lib/session-store`：带合并写入、命名空间条目上限和 LRU 淘汰，
 * 因此"标签页访问过的每个叙述者"不会无上限累积。
 *
 * `storageKey` 传 null 表示"尚不知道该写到哪里"（例如当前用户还没加载完）：
 * 此时读写都不落盘。历史 key 按 `(user, narrator)` 划分，用一个占位 key 顶替
 * 会占掉命名空间配额，并让登录态就绪前后各留一份互不相干的历史。
 */
export function useInputHistory(storageKey: string | null) {
	const indexRef = useRef(-1);
	const draftRef = useRef<FileReferenceInput>({ text: "", fileReferences: [] });
	const storageKeyRef = useRef(storageKey);
	// Track browsing version so useSyncExternalStore can react to index changes
	const versionRef = useRef(0);
	const subscribersRef = useRef(new Set<() => void>());
	const subscribe = useCallback((cb: () => void) => {
		subscribersRef.current.add(cb);
		return () => {
			subscribersRef.current.delete(cb);
		};
	}, []);
	const getSnapshot = useCallback(() => versionRef.current, []);
	useSyncExternalStore(subscribe, getSnapshot);
	const notify = useCallback(() => {
		versionRef.current++;
		for (const cb of subscribersRef.current) cb();
	}, []);

	useEffect(() => {
		if (storageKeyRef.current === storageKey) return;
		storageKeyRef.current = storageKey;
		indexRef.current = -1;
		draftRef.current = { text: "", fileReferences: [] };
		notify();
	}, [storageKey, notify]);

	const getHistory = useCallback(() => readInputHistoryEntries(storageKey), [storageKey]);

	const setHistory = useCallback(
		(history: FileReferenceInput[]) => {
			if (storageKey == null) return;
			// Trimming (oldest end first, so recent entries survive an overflow) lives in
			// writeInputHistoryEntries, shared with the legacy-key migration.
			writeInputHistoryEntries(storageKey, history);
		},
		[storageKey],
	);

	/** 发送消息后调用，将消息推入历史并重置浏览位置 */
	const push = useCallback(
		(message: string, fileReferences: FileReference[] = []) => {
			const trimmed = message.trim();
			const entry = trimFileReferenceInput({
				text: message,
				fileReferences: readFileReferences(fileReferences, message),
			});
			if (!trimmed && entry.fileReferences.length === 0) return;
			if (trimmed.length > MAX_HISTORY_MESSAGE_CHARS) {
				indexRef.current = -1;
				notify();
				return;
			}
			const history = getHistory();
			// 去重：如果最近一条相同则不重复添加
			if (history[0] && sameFileReferenceInput(history[0], entry)) {
				indexRef.current = -1;
				notify();
				return;
			}
			const next = [entry, ...history].slice(0, MAX_HISTORY);
			setHistory(next);
			indexRef.current = -1;
			notify();
		},
		[getHistory, setHistory, notify],
	);

	/**
	 * 处理上下箭头键。返回新的输入值，如果不应处理则返回 null。
	 * @param direction "up" | "down"
	 * @param currentInput 当前输入框的值
	 */
	const navigateEntry = useCallback(
		(
			direction: "up" | "down",
			currentInput: string,
			fileReferences: FileReference[] = [],
		): FileReferenceInput | null => {
			const history = getHistory();
			if (history.length === 0) return null;

			if (direction === "up") {
				// 首次按上箭头时保存当前草稿
				if (indexRef.current === -1) {
					draftRef.current = {
						text: currentInput,
						fileReferences: readFileReferences(fileReferences, currentInput),
					};
				}
				const nextIndex = Math.min(indexRef.current + 1, history.length - 1);
				if (nextIndex === indexRef.current && indexRef.current !== -1) return null;
				indexRef.current = nextIndex;
				notify();
				return history[nextIndex];
			}

			// direction === "down"
			if (indexRef.current <= -1) return null;
			const nextIndex = indexRef.current - 1;
			indexRef.current = nextIndex;
			notify();
			if (nextIndex === -1) {
				// 回到草稿
				return draftRef.current;
			}
			return history[nextIndex];
		},
		[getHistory, notify],
	);

	/** 重置浏览位置（用户手动编辑输入框时调用） */
	const reset = useCallback(() => {
		indexRef.current = -1;
		notify();
	}, [notify]);

	/** 是否正在浏览历史（index !== -1） */
	const isBrowsing = indexRef.current !== -1;

	const navigate = useCallback(
		(direction: "up" | "down", currentInput: string): string | null =>
			navigateEntry(direction, currentInput)?.text ?? null,
		[navigateEntry],
	);
	return { push, navigate, navigateEntry, reset, isBrowsing };
}
