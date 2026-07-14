import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

const MAX_HISTORY = 50;
const MAX_HISTORY_MESSAGE_CHARS = 20_000;
const MAX_HISTORY_STORAGE_CHARS = 512_000;

/**
 * 消息输入历史记录 hook。
 * 记录用户发送的消息，支持上下箭头翻阅。
 * 历史按 sessionStorage 持久化（页面刷新后保留，关闭标签页后清空）。
 */
export function useInputHistory(storageKey: string) {
	const indexRef = useRef(-1);
	const draftRef = useRef("");
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
		draftRef.current = "";
		notify();
	}, [storageKey, notify]);

	const getHistory = useCallback((): string[] => {
		try {
			const raw = sessionStorage.getItem(storageKey);
			if (!raw) return [];
			if (raw.length > MAX_HISTORY_STORAGE_CHARS) {
				sessionStorage.removeItem(storageKey);
				return [];
			}
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed
				.filter((item): item is string => typeof item === "string")
				.filter((item) => item.length <= MAX_HISTORY_MESSAGE_CHARS)
				.slice(0, MAX_HISTORY);
		} catch {
			return [];
		}
	}, [storageKey]);

	const setHistory = useCallback(
		(history: string[]) => {
			try {
				sessionStorage.setItem(storageKey, JSON.stringify(history.slice(0, MAX_HISTORY)));
			} catch {
				// Ignore storage quota/private mode errors. Chat content itself is already persisted server-side.
			}
		},
		[storageKey],
	);

	/** 发送消息后调用，将消息推入历史并重置浏览位置 */
	const push = useCallback(
		(message: string) => {
			const trimmed = message.trim();
			if (!trimmed) return;
			if (trimmed.length > MAX_HISTORY_MESSAGE_CHARS) {
				indexRef.current = -1;
				notify();
				return;
			}
			const history = getHistory();
			// 去重：如果最近一条相同则不重复添加
			if (history[0] === trimmed) {
				indexRef.current = -1;
				notify();
				return;
			}
			const next = [trimmed, ...history].slice(0, MAX_HISTORY);
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
	const navigate = useCallback(
		(direction: "up" | "down", currentInput: string): string | null => {
			const history = getHistory();
			if (history.length === 0) return null;

			if (direction === "up") {
				// 首次按上箭头时保存当前草稿
				if (indexRef.current === -1) {
					draftRef.current = currentInput;
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

	return { push, navigate, reset, isBrowsing };
}
