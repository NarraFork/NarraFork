import type { SubagentOutputCount } from "@shared/subagent-output-counts";
import { useCallback, useSyncExternalStore } from "react";

type Listener = () => void;

/** A provider's wire id alone cannot identify a persisted execution. */
export interface SubagentOutputCountRef {
	toolUseId?: string;
	toolCallId?: string;
	executionAttempt?: number;
}

interface Entry {
	snapshot: SubagentOutputCount;
}
interface Scope {
	retainers: number;
	entries: Map<string, Entry>;
	listeners: Map<string, Set<Listener>>;
	/** Bounded late-frame rejection, discarded with the final owner lease. */
	retired: Set<string>;
}

const scopes = new Map<string, Scope>();

function keyFor(ref: SubagentOutputCountRef): string | undefined {
	return ref.toolCallId &&
		typeof ref.executionAttempt === "number" &&
		Number.isSafeInteger(ref.executionAttempt) &&
		ref.executionAttempt >= 0
		? JSON.stringify([ref.toolCallId, ref.executionAttempt])
		: undefined;
}

function scopeFor(ownerNarratorId: string): Scope {
	let scope = scopes.get(ownerNarratorId);
	if (!scope) {
		scope = { retainers: 0, entries: new Map(), listeners: new Map(), retired: new Set() };
		scopes.set(ownerNarratorId, scope);
	}
	return scope;
}

function notify(scope: Scope, key: string): void {
	for (const listener of scope.listeners.get(key) ?? []) listener();
}

function prune(ownerNarratorId: string, scope: Scope): void {
	if (scope.retainers === 0 && scope.listeners.size === 0) scopes.delete(ownerNarratorId);
}

/** Each mounted panel owns one lease; releasing another panel never clears this one. */
export function retainSubagentOutputCounts(ownerNarratorId: string): () => void {
	const scope = scopeFor(ownerNarratorId);
	scope.retainers++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		scope.retainers--;
		if (scope.retainers === 0) {
			const keys = [...scope.entries.keys()];
			scope.entries.clear();
			scope.retired.clear();
			for (const key of keys) notify(scope, key);
		}
		prune(ownerNarratorId, scope);
	};
}

function sameCount(a: SubagentOutputCount, b: SubagentOutputCount): boolean {
	return (
		a.logicalRunId === b.logicalRunId &&
		a.childNarratorId === b.childNarratorId &&
		a.toolUseId === b.toolUseId &&
		a.count === b.count &&
		a.active === b.active
	);
}

function runKey(value: SubagentOutputCount): string {
	return JSON.stringify([value.toolCallId, value.attempt, value.logicalRunId]);
}

function retire(scope: Scope, value: SubagentOutputCount): void {
	scope.retired.add(runKey(value));
	// Active entries are retained separately; historical terminal identities have
	// a fixed memory budget even when a panel remains mounted for days.
	while (scope.retired.size > 1024) {
		const oldest = scope.retired.values().next().value;
		if (oldest === undefined) break;
		scope.retired.delete(oldest);
	}
}

function stop(scope: Scope, key: string, value: SubagentOutputCount): void {
	retire(scope, value);
	if (scope.listeners.has(key)) {
		if (!value.active) return;
		scope.entries.set(key, { snapshot: { ...value, active: false } });
	} else scope.entries.delete(key);
	notify(scope, key);
}

function put(scope: Scope, value: SubagentOutputCount, authoritative: boolean): void {
	const key = keyFor({ toolCallId: value.toolCallId, executionAttempt: value.attempt });
	if (!key || scope.retired.has(runKey(value))) return;
	for (const [otherKey, entry] of scope.entries) {
		if (entry.snapshot.toolCallId !== value.toolCallId) continue;
		if (entry.snapshot.attempt > value.attempt) return;
		if (entry.snapshot.attempt < value.attempt) stop(scope, otherKey, entry.snapshot);
	}
	const previous = scope.entries.get(key)?.snapshot;
	if (previous) {
		if (previous.logicalRunId !== value.logicalRunId) {
			// A new live run can follow retirement, but cannot hijack an active one.
			if (previous.active && !authoritative) return;
			retire(scope, previous);
		} else {
			if (
				previous.toolUseId !== value.toolUseId ||
				previous.childNarratorId !== value.childNarratorId
			)
				return;
			// Rolling back a provider attempt can legitimately lower this run's count.
			if (value.active && !previous.active) return;
		}
		if (sameCount(previous, value)) return;
	}
	if (!value.active) {
		retire(scope, value);
		if (!scope.listeners.has(key)) {
			if (scope.entries.delete(key)) notify(scope, key);
			return;
		}
	}
	scope.entries.set(key, { snapshot: value });
	notify(scope, key);
}

/** Render-only updates: never write a tool row, streaming tail, or layout document. */
export function setSubagentOutputCount(ownerNarratorId: string, value: SubagentOutputCount): void {
	const scope = scopes.get(ownerNarratorId);
	if (scope && scope.retainers > 0) put(scope, value, false);
}

/** An explicit empty list retires old counts; an omitted field must not call this. */
export function replaceSubagentOutputCounts(
	ownerNarratorId: string,
	values: readonly SubagentOutputCount[],
): void {
	const scope = scopes.get(ownerNarratorId);
	if (!scope || scope.retainers === 0) return;
	const incoming = new Set(
		values.map((value) =>
			keyFor({
				toolCallId: value.toolCallId,
				executionAttempt: value.attempt,
			}),
		),
	);
	for (const [key, entry] of scope.entries) {
		if (!incoming.has(key)) stop(scope, key, entry.snapshot);
	}
	for (const value of values) put(scope, value, true);
}

export function getSubagentOutputCount(
	ownerNarratorId: string,
	ref: SubagentOutputCountRef,
): SubagentOutputCount | undefined {
	const key = keyFor(ref);
	const value = key ? scopes.get(ownerNarratorId)?.entries.get(key)?.snapshot : undefined;
	return value && (!ref.toolUseId || value.toolUseId === ref.toolUseId) ? value : undefined;
}

export function subscribeSubagentOutputCount(
	ownerNarratorId: string,
	ref: SubagentOutputCountRef,
	listener: Listener,
): () => void {
	const key = keyFor(ref);
	if (!key) return () => {};
	const scope = scopeFor(ownerNarratorId);
	let listeners = scope.listeners.get(key);
	if (!listeners) {
		listeners = new Set();
		scope.listeners.set(key, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			scope.listeners.delete(key);
			if (!scope.entries.get(key)?.snapshot.active) scope.entries.delete(key);
		}
		prune(ownerNarratorId, scope);
	};
}

export function useSubagentOutputCount(
	ownerNarratorId: string | undefined,
	ref: SubagentOutputCountRef,
): SubagentOutputCount | undefined {
	const { toolUseId, toolCallId, executionAttempt } = ref;
	const subscribe = useCallback(
		(listener: Listener) =>
			ownerNarratorId
				? subscribeSubagentOutputCount(
						ownerNarratorId,
						{ toolUseId, toolCallId, executionAttempt },
						listener,
					)
				: () => {},
		[ownerNarratorId, toolUseId, toolCallId, executionAttempt],
	);
	const snapshot = useCallback(
		() =>
			ownerNarratorId
				? getSubagentOutputCount(ownerNarratorId, { toolUseId, toolCallId, executionAttempt })
				: undefined,
		[ownerNarratorId, toolUseId, toolCallId, executionAttempt],
	);
	return useSyncExternalStore(subscribe, snapshot, () => undefined);
}
