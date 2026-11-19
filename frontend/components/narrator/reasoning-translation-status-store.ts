import type { ReasoningTranslationStatus } from "@shared/reasoning-translation";
import { useCallback, useSyncExternalStore } from "react";

type BusyState = "queued" | "running";
type Listener = () => void;

const snapshots = new Map<string, BusyState>();
const holders = new Map<string, Map<string, BusyState>>();
const listeners = new Map<string, Set<Listener>>();

function groupKey(narratorId: string, groupId: string): string {
	return JSON.stringify([narratorId, groupId]);
}

/** A complete, connection-validated holder projection; it never enters document state. */
export function setReasoningTranslationStatus(
	narratorId: string,
	visibilityId: string,
	groups: ReasoningTranslationStatus["groups"],
): void {
	const holderKey = JSON.stringify([narratorId, visibilityId]);
	const previous = holders.get(holderKey);
	const next = new Map<string, BusyState>();
	for (const group of groups) {
		if (group.state !== "idle") next.set(groupKey(narratorId, group.groupId), group.state);
	}
	if (next.size) holders.set(holderKey, next);
	else holders.delete(holderKey);
	const affected = new Set([...(previous?.keys() ?? []), ...next.keys()]);
	for (const key of affected) {
		let state: BusyState | undefined;
		for (const holder of holders.values()) {
			const candidate = holder.get(key);
			if (candidate === "running") {
				state = candidate;
				break;
			}
			if (candidate) state = candidate;
		}
		if (snapshots.get(key) === state) continue;
		if (state) snapshots.set(key, state);
		else snapshots.delete(key);
		for (const listener of listeners.get(key) ?? []) listener();
	}
}

export function clearReasoningTranslationStatus(narratorId: string, visibilityId: string): void {
	setReasoningTranslationStatus(narratorId, visibilityId, []);
}

export function useReasoningTranslationStatus(
	narratorId: string | undefined,
	groupId: string | undefined,
): BusyState | null {
	const key = narratorId && groupId ? groupKey(narratorId, groupId) : null;
	const subscribe = useCallback(
		(listener: Listener) => {
			if (!key) return () => {};
			let bucket = listeners.get(key);
			if (!bucket) {
				bucket = new Set();
				listeners.set(key, bucket);
			}
			bucket.add(listener);
			return () => {
				bucket.delete(listener);
				if (!bucket.size) listeners.delete(key);
			};
		},
		[key],
	);
	const getSnapshot = useCallback(() => (key ? (snapshots.get(key) ?? null) : null), [key]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
