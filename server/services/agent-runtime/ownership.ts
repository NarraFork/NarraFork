import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import type { ActiveNarrator, ActiveSubagentSettings } from "../narrator-session-state";
import { getManualOverrideMap } from "../subagent-manual-override";
import type { RunningSubagentExecutionSnapshot } from "../subagent-runner";

export type ExecutionKind = "primary" | "subagent" | "tool-replay";

/** Execution epochs are unrelated to durable tool attempts or publication tokens. */
export interface ExecutionOwner {
	readonly narratorId: string;
	readonly epoch: string;
	readonly kind: ExecutionKind;
	isCurrent(): boolean;
	/** Compare-and-release: a late finalizer cannot release a newer execution. */
	release(): boolean;
}

interface RuntimeRecord {
	owner?: ExecutionOwner;
	phase?: "suspended";
	pass?: object;
	bufferSoftStop?: boolean;
	session?: ActiveNarrator;
	subagentSettings?: ActiveSubagentSettings;
	toolReplayCompletion?: Promise<void>;
	subagentExecution?: RunningSubagentExecutionSnapshot & { token: string };
}

const records = hotSafe<Map<string, RuntimeRecord>>(
	"narrafork.agentRuntime.records",
	() => new Map(),
);

function recordFor(narratorId: string): RuntimeRecord {
	let record = records.get(narratorId);
	if (!record) {
		record = {};
		records.set(narratorId, record);
	}
	return record;
}

function prune(narratorId: string): void {
	const record = records.get(narratorId);
	if (
		record &&
		!record.owner &&
		!record.bufferSoftStop &&
		!record.session &&
		!record.subagentSettings &&
		!record.toolReplayCompletion &&
		!record.subagentExecution
	)
		records.delete(narratorId);
}

export function getExecutionOwner(narratorId: string): ExecutionOwner | undefined {
	return records.get(narratorId)?.owner;
}

/** Synchronous CAS, called inside the existing short start admission, not a tree lock. */
export function tryClaimExecution(narratorId: string, kind: ExecutionKind): ExecutionOwner | null {
	const record = recordFor(narratorId);
	if (record.owner) return null;
	delete record.phase;
	delete record.pass;
	const owner: ExecutionOwner = {
		narratorId,
		epoch: randomUUID(),
		kind,
		isCurrent: () => records.get(narratorId)?.owner === owner,
		release: () => {
			if (!owner.isCurrent()) return false;
			delete record.owner;
			delete record.phase;
			delete record.pass;
			prune(narratorId);
			return true;
		},
	};
	record.owner = owner;
	return owner;
}

/** Ownership survives suspension; only the existing control channel may resume it. */
export function isExecutionSuspended(narratorId: string): boolean {
	const record = records.get(narratorId);
	if (!record?.owner) return false;
	return (
		(record.phase === "suspended" || legacyOwners.has(record.owner)) &&
		getManualOverrideMap().has(narratorId)
	);
}

export function setExecutionSuspended(owner: ExecutionOwner, suspended: boolean): boolean {
	const record = records.get(owner.narratorId);
	// The single orchestrator keeps its invocation reservation while waiting for
	// control; suspension must not open the slot to a second borrowed invocation.
	if (record?.owner !== owner) return false;
	if (suspended) record.phase = "suspended";
	else delete record.phase;
	return true;
}

/** A borrowed runner owner still admits at most one executor invocation at a time. */
export function claimExecutionPass(owner: ExecutionOwner): (() => void) | null {
	const record = records.get(owner.narratorId);
	if (record?.owner !== owner || record.pass || isExecutionSuspended(owner.narratorId)) return null;
	const pass = {};
	record.pass = pass;
	return () => {
		if (record.owner === owner && record.pass === pass) delete record.pass;
	};
}

export function requestRuntimeBufferSoftStop(narratorId: string): void {
	recordFor(narratorId).bufferSoftStop = true;
}

export function hasRuntimeBufferSoftStop(narratorId: string): boolean {
	return records.get(narratorId)?.bufferSoftStop === true;
}

export function clearRuntimeBufferSoftStop(narratorId: string): void {
	const record = records.get(narratorId);
	if (!record) return;
	delete record.bufferSoftStop;
	prune(narratorId);
}

/** Existing primary callbacks keep their field API, backed by the same runtime control state. */
function attachSessionControlView(
	narratorId: string,
	record: RuntimeRecord,
	session: ActiveNarrator,
): void {
	const initial = session._bufferSoftStop;
	if (initial !== undefined) record.bufferSoftStop = initial;
	Object.defineProperty(session, "_bufferSoftStop", {
		configurable: true,
		enumerable: true,
		get: () => record.bufferSoftStop,
		set: (value: boolean | undefined) => {
			if (records.get(narratorId)?.session !== session) return;
			record.bufferSoftStop = value;
		},
	});
}

type ViewField = Exclude<keyof RuntimeRecord, "owner" | "phase" | "pass" | "bufferSoftStop">;

/** Legacy Map API with no backing Map: all reads/writes project the single record. */
export function createRuntimeMapView<K extends ViewField>(
	field: K,
): Map<string, NonNullable<RuntimeRecord[K]>> {
	type Value = NonNullable<RuntimeRecord[K]>;
	return new (class extends Map<string, Value> {
		override get size(): number {
			let count = 0;
			for (const record of records.values()) if (record[field] !== undefined) count++;
			return count;
		}
		override get(id: string): Value | undefined {
			return records.get(id)?.[field] as Value | undefined;
		}
		override has(id: string): boolean {
			return this.get(id) !== undefined;
		}
		override set(id: string, value: Value): this {
			const record = recordFor(id);
			record[field] = value;
			if (field === "session") attachSessionControlView(id, record, value as ActiveNarrator);
			return this;
		}
		override delete(id: string): boolean {
			const record = records.get(id);
			if (!record || record[field] === undefined) return false;
			delete record[field];
			if (field === "session") delete record.bufferSoftStop;
			prune(id);
			return true;
		}
		override clear(): void {
			for (const id of records.keys()) this.delete(id);
		}
		override *entries(): MapIterator<[string, Value]> {
			for (const [id, record] of records) {
				if (record[field] !== undefined) yield [id, record[field] as Value];
			}
		}
		override *keys(): MapIterator<string> {
			for (const [id] of this.entries()) yield id;
		}
		override *values(): MapIterator<Value> {
			for (const [, value] of this.entries()) yield value;
		}
		override [Symbol.iterator](): MapIterator<[string, Value]> {
			return this.entries();
		}
		override forEach(
			callback: (value: Value, key: string, map: Map<string, Value>) => void,
			thisArg?: unknown,
		): void {
			for (const [id, value] of this.entries()) callback.call(thisArg, value, id, this);
		}
	})();
}

/** Read-only compatibility query. There is no independently writable admission Set. */
export const executionAdmissions = {
	has: (narratorId: string): boolean => getExecutionOwner(narratorId) !== undefined,
};

// Old --hot closures still hold the ORIGINAL Map/Set objects, even after their module
// has been re-evaluated. Copying values alone would leave those closures writing a
// second authority. Keep those objects, drain their native storage once, and replace
// their methods in place with forwarding/CAS adapters. Modern callers use the views
// above; only old closures use the epoch-bound legacy mutation surface.
const LEGACY_ADOPTED = Symbol.for("narrafork.agentRuntime.legacyAdopted");
const legacyOwners = hotSafe<WeakSet<ExecutionOwner>>(
	"narrafork.agentRuntime.legacyOwners",
	() => new WeakSet(),
);
const legacyOwnerSources = hotSafe<WeakMap<ExecutionOwner, Set<object>>>(
	"narrafork.agentRuntime.legacyOwnerSources",
	() => new WeakMap(),
);

interface LegacyBinding<T = unknown> {
	value: T;
	field?: ViewField;
	owner?: ExecutionOwner;
}

function bindLegacyOwner(narratorId: string, kind: ExecutionKind, source: object): ExecutionOwner {
	let owner = getExecutionOwner(narratorId);
	if (owner && !legacyOwners.has(owner)) {
		throw new AppError("Narrator already has an execution owner", 409, "NARRATOR_EXECUTION_BUSY");
	}
	if (!owner) {
		owner = tryClaimExecution(narratorId, kind) ?? undefined;
		if (!owner) throw new Error("Legacy execution adoption lost its synchronous claim");
		legacyOwners.add(owner);
	}
	const sources = legacyOwnerSources.get(owner) ?? new Set<object>();
	sources.add(source);
	legacyOwnerSources.set(owner, sources);
	return owner;
}

function releaseLegacyBinding(binding: LegacyBinding, terminal = false): void {
	if (!binding.owner) return;
	const sources = legacyOwnerSources.get(binding.owner);
	sources?.delete(binding);
	if (terminal && binding.owner.isCurrent()) {
		const record = records.get(binding.owner.narratorId);
		for (const source of sources ?? []) {
			const cache = source as LegacyBinding;
			if (
				record &&
				(cache.field === "session" || cache.field === "subagentSettings") &&
				record[cache.field] === cache.value
			)
				delete record[cache.field];
		}
	}
	if (sources?.size === 0) legacyOwnerSources.delete(binding.owner);
	// The old outer finally is terminal even if its inner cleanup threw before
	// deleting a settings/session cache. Those caches must not pin execution forever.
	if (terminal || sources?.size === 0) binding.owner.release();
}

function legacyMapKind(field: ViewField, value: unknown): ExecutionKind | undefined {
	if (field === "subagentSettings" || field === "subagentExecution") return "subagent";
	if (field === "toolReplayCompletion") return "tool-replay";
	const session = value as ActiveNarrator;
	return session.alive && session._loopRunning ? "primary" : undefined;
}

function adoptLegacyMap<K extends ViewField>(key: string, field: K): void {
	type Value = NonNullable<RuntimeRecord[K]>;
	const legacy = hotSafe<Map<string, Value>>(key, () => new Map());
	if (Object.hasOwn(legacy, LEGACY_ADOPTED)) return;
	const entries = [...legacy.entries()];
	const view = createRuntimeMapView(field);
	// These are cleanup receipts (old value + epoch), never a second read authority.
	const bindings = new Map<string, LegacyBinding<Value>>();
	const set = (id: string, value: Value): Map<string, Value> => {
		const previous = bindings.get(id);
		const current = getExecutionOwner(id);
		if (previous?.owner && !previous.owner.isCurrent() && current) return legacy;
		if (current && !legacyOwners.has(current)) {
			throw new AppError("Narrator already has an execution owner", 409, "NARRATOR_EXECUTION_BUSY");
		}
		const binding: LegacyBinding<Value> = { value, field };
		const kind = legacyMapKind(field, value) ?? current?.kind;
		if (kind) binding.owner = bindLegacyOwner(id, kind, binding);
		view.set(id, value);
		bindings.set(id, binding);
		if (previous) releaseLegacyBinding(previous);
		return legacy;
	};
	const remove = (id: string): boolean => {
		const binding = bindings.get(id);
		if (!binding) return false;
		bindings.delete(id);
		// A modern run may have replaced the value even if a very old finally is
		// still draining. Never let delete(id), which carries no caller token,
		// erase that replacement merely because it uses the same narrator id.
		const current = getExecutionOwner(id);
		if (
			view.get(id) === binding.value &&
			(!current || current === binding.owner || (!binding.owner && legacyOwners.has(current)))
		)
			view.delete(id);
		releaseLegacyBinding(
			binding,
			field === "subagentExecution" || field === "toolReplayCompletion",
		);
		return true;
	};
	for (const [id, value] of entries) set(id, value);
	Map.prototype.clear.call(legacy);
	Object.defineProperties(legacy, {
		[LEGACY_ADOPTED]: { value: true },
		size: { get: () => view.size },
		get: { value: (id: string) => view.get(id) },
		has: { value: (id: string) => view.has(id) },
		set: { value: set },
		delete: { value: remove },
		clear: {
			value: () => {
				for (const id of bindings.keys()) remove(id);
			},
		},
		entries: { value: () => view.entries() },
		keys: { value: () => view.keys() },
		values: { value: () => view.values() },
		[Symbol.iterator]: { value: () => view.entries() },
		forEach: {
			value: (
				callback: (value: Value, id: string, map: Map<string, Value>) => void,
				thisArg?: unknown,
			) => {
				for (const [id, value] of view) callback.call(thisArg, value, id, legacy);
			},
		},
	});
}

function adoptLegacyAdmissions(): void {
	const legacy = hotSafe<Set<string>>("narrafork.narratorLoopAdmissions", () => new Set());
	if (Object.hasOwn(legacy, LEGACY_ADOPTED)) return;
	const ids = [...legacy];
	const bindings = new Map<string, LegacyBinding>();
	const add = (id: string): Set<string> => {
		const previous = bindings.get(id);
		if (previous?.owner?.isCurrent()) return legacy;
		const binding: LegacyBinding = { value: id };
		binding.owner = bindLegacyOwner(id, "primary", binding);
		bindings.set(id, binding);
		if (previous) releaseLegacyBinding(previous);
		return legacy;
	};
	const remove = (id: string): boolean => {
		const binding = bindings.get(id);
		if (!binding) return false;
		bindings.delete(id);
		releaseLegacyBinding(binding, true);
		return true;
	};
	function* values(): SetIterator<string> {
		for (const [id, record] of records) if (record.owner) yield id;
	}
	for (const id of ids) add(id);
	Set.prototype.clear.call(legacy);
	Object.defineProperties(legacy, {
		[LEGACY_ADOPTED]: { value: true },
		size: {
			get: () => {
				let count = 0;
				for (const _ of values()) count++;
				return count;
			},
		},
		has: { value: executionAdmissions.has },
		add: { value: add },
		delete: { value: remove },
		clear: {
			value: () => {
				for (const id of bindings.keys()) remove(id);
			},
		},
		keys: { value: values },
		values: { value: values },
		[Symbol.iterator]: { value: values },
		entries: {
			value: function* (): SetIterator<[string, string]> {
				for (const id of values()) yield [id, id];
			},
		},
		forEach: {
			value: (
				callback: (value: string, key: string, set: Set<string>) => void,
				thisArg?: unknown,
			) => {
				for (const id of values()) callback.call(thisArg, id, id, legacy);
			},
		},
	});
}

// Adopt the loop reservation before session metadata: an old primary finalizer may
// already have cleared alive/_loopRunning, yet still owns its original admission.
// The runner snapshot also covers old children in async preparation before settings
// registration; its old token-checked unregister is the authoritative legacy terminal.
adoptLegacyAdmissions();
adoptLegacyMap("narrafork.activeNarrators", "session");
adoptLegacyMap("narrafork:runningSubagentExecutions", "subagentExecution");
adoptLegacyMap("narrafork.activeSubagentSettings", "subagentSettings");
adoptLegacyMap("narrafork.narratorToolExecutionAdmissions", "toolReplayCompletion");
