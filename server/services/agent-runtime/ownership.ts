import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import type {
	RunCancelWith,
	RunDeliverTo,
	RuntimeRunBinding,
} from "../../lib/validators/runtime-registration";
import { backgroundOccupancyStore } from "../background-occupancy-store";
import type { ActiveNarrator } from "../narrator-session-state";

/** A model run, or a bounded tool/input replay that excludes one. Never a role. */
export type ExecutionKind = "run" | "tool-replay";

/** Result of one run as its caller/finalizer sees it. */
export interface RunResult {
	started: boolean;
	logicalRunId?: string;
	/** Model-visible result for whoever the run delivers to (tagged, with file changes). */
	output: string;
	finalText: string;
	hasError: boolean;
	interrupted: boolean;
	timedOut: boolean;
	terminalStatus?: import("./input").RuntimeTerminalStatus;
	/** True when the caller was handed back early (detach); the run continues. */
	handoff?: boolean;
	/**
	 * A delegated session's result (outline P2 PR 9b): the head of the note added to it, as data
	 * for the Agent call's card. Absent for every other run, and when no note was written.
	 */
	outlineReport?: import("@shared/outline-report-note").OutlineReportNote;
}

/**
 * Relationship state of the run an owner is executing. One per owner, generic for
 * every session: who cancels it, whether a caller is waiting for its result, and how
 * a suspended hold is woken. Durable facts live in the registration; this is the
 * live half.
 */
export interface RunControl {
	readonly startedAt: number;
	/** The final persisted registration; the run never reconstructs its merge rules. */
	binding?: RuntimeRunBinding;
	logicalRunId?: string;
	/** Tool call the run delivers its result to (display adapter and legacy admission). */
	deliverTo?: RunDeliverTo;
	/** Registered absolute deadline. */
	deadlineAt?: string;
	/** Execution principal of the run (attribution of its result notice). */
	principal?: string | null;
	/** The exact caller attempt whose cancellation cancels this run; detach clears it. */
	cancelWith?: RunCancelWith;
	/** Whole-run cancellation (caller attempt, deadline, task cancel). */
	readonly cancel: AbortController;
	timedOut: boolean;
	/** File-change provenance segment of this run, when it delivers to a tool call. */
	executionSegmentId?: string;
	/** A caller is waiting in the foreground; resolved once, by terminal or detach. */
	waiter?: (result: RunResult) => void;
	/** The finalizer has claimed how the result is delivered; a detach can no longer start. */
	finalizing?: boolean;
	/** A detach that claimed the caller and is still registering the task projection. */
	detaching?: Promise<void>;
	/** Drops the caller-attempt listener (detach). */
	detachCaller?: () => void;
	/** Set while the run is suspended by a hold. */
	wake?: (reason: "input" | "release" | "cancel") => void;
	readonly terminal: Promise<RunResult>;
}

/** A user control hold on a session's result: survives runs, mirrored as `taken_over`. */
export interface RunHold {
	/** The user let go while a turn was still running; deliver when it ends. */
	released: boolean;
	/** Retained after a failed terminal commit; release retries without a model pass. */
	result?: RunResult;
}

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
	bufferSoftStop?: boolean;
	session?: ActiveNarrator;
	toolReplayCompletion?: Promise<void>;
	run?: RunControl;
	hold?: RunHold;
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
		!record.toolReplayCompletion &&
		!record.run &&
		!record.hold
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
	const owner: ExecutionOwner = {
		narratorId,
		epoch: randomUUID(),
		kind,
		isCurrent: () => records.get(narratorId)?.owner === owner,
		release: () => {
			if (!owner.isCurrent()) return false;
			delete record.owner;
			delete record.phase;
			delete record.run;
			prune(narratorId);
			publishRuntimeLiveness(narratorId);
			return true;
		},
	};
	record.owner = owner;
	publishRuntimeLiveness(narratorId);
	return owner;
}

/** Ownership survives suspension; only the existing control channel may resume it. */
export function isExecutionSuspended(narratorId: string): boolean {
	const record = records.get(narratorId);
	if (!record?.owner) return false;
	return record.phase === "suspended";
}

/** Live run state of the current owner, if it is executing a run. */
export function getRunControl(narratorId: string): RunControl | undefined {
	return records.get(narratorId)?.run;
}

/** Attach run state to the owner that executes it; cleared on release. */
export function setRunControl(owner: ExecutionOwner, run: RunControl | undefined): void {
	const record = records.get(owner.narratorId);
	if (record?.owner !== owner) return;
	if (run) record.run = run;
	else delete record.run;
}

export function listRuns(): Array<{ narratorId: string; run: RunControl }> {
	return [...records].flatMap(([narratorId, record]) =>
		record.run ? [{ narratorId, run: record.run }] : [],
	);
}

/** Live runs registered to be cancelled with `callerNarratorId`'s in-flight attempts. */
export function listRunsCancelledWith(callerNarratorId: string): RunControl[] {
	const runs: RunControl[] = [];
	for (const record of records.values())
		if (record.run?.cancelWith?.narratorId === callerNarratorId) runs.push(record.run);
	return runs;
}

export function getRunHold(narratorId: string): RunHold | undefined {
	return records.get(narratorId)?.hold;
}

export function setRunHold(narratorId: string, hold: RunHold | undefined): void {
	const record = recordFor(narratorId);
	if (hold) record.hold = hold;
	else delete record.hold;
	prune(narratorId);
}

export function listRunHolds(): string[] {
	return [...records].flatMap(([id, record]) => (record.hold ? [id] : []));
}

/** Keep the durable mirror until terminal persistence succeeds, including a deferred release. */
export function preserveHeldSubstatus(narratorId: string, next: string[]): string[] {
	const hold = records.get(narratorId)?.hold;
	return hold && !next.includes("taken_over") ? [...next, "taken_over"] : next;
}

/** Held and not yet released by the user: the condition the takeover badge shows. */
export function isRunHeldForDisplay(narratorId: string): boolean {
	const hold = records.get(narratorId)?.hold;
	return !!hold && !hold.released;
}

/** Preserve isNarratorActive || isLoopRunning, including session-only cleanup windows. */
export function publishRuntimeLiveness(narratorId: string): void {
	const record = records.get(narratorId);
	backgroundOccupancyStore.setRuntimeLive(
		narratorId,
		Boolean(record?.session) ||
			(!isExecutionSuspended(narratorId) && Boolean(record?.owner || record?.toolReplayCompletion)),
	);
}

export function setExecutionSuspended(owner: ExecutionOwner, suspended: boolean): boolean {
	const record = records.get(owner.narratorId);
	// The single orchestrator keeps its invocation reservation while waiting for
	// control; suspension must not open the slot to a second borrowed invocation.
	if (record?.owner !== owner) return false;
	if (suspended) record.phase = "suspended";
	else delete record.phase;
	publishRuntimeLiveness(owner.narratorId);
	return true;
}

/** Session callbacks keep their field API, backed by the same runtime control state. */
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

type ViewField = Exclude<
	keyof RuntimeRecord,
	"owner" | "phase" | "bufferSoftStop" | "run" | "hold"
>;

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
			publishRuntimeLiveness(id);
			return this;
		}
		override delete(id: string): boolean {
			const record = records.get(id);
			if (!record || record[field] === undefined) return false;
			delete record[field];
			if (field === "session") delete record.bufferSoftStop;
			prune(id);
			publishRuntimeLiveness(id);
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
	publishRuntimeLiveness(narratorId);
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
			if (record && cache.field === "session" && record[cache.field] === cache.value)
				delete record[cache.field];
		}
	}
	if (sources?.size === 0) legacyOwnerSources.delete(binding.owner);
	// The old outer finally is terminal even if its inner cleanup threw before
	// deleting a settings/session cache. Those caches must not pin execution forever.
	if (terminal || sources?.size === 0) binding.owner.release();
}

function legacyMapKind(field: ViewField, value: unknown): ExecutionKind | undefined {
	if (field === "toolReplayCompletion") return "tool-replay";
	const session = value as ActiveNarrator;
	return session.alive && session._loopRunning ? "run" : undefined;
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
		releaseLegacyBinding(binding, field === "toolReplayCompletion");
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
		binding.owner = bindLegacyOwner(id, "run", binding);
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

// Adopt the loop reservation before session metadata: an old finalizer may
// already have cleared alive/_loopRunning, yet still owns its original admission.
adoptLegacyAdmissions();
adoptLegacyMap("narrafork.activeNarrators", "session");
adoptLegacyMap("narrafork.narratorToolExecutionAdmissions", "toolReplayCompletion");

// A newly installed occupancy store may share already-populated hot runtime records.
// Re-seed them after legacy adoption, even when no runtime view mutation will follow.
for (const narratorId of records.keys()) publishRuntimeLiveness(narratorId);
