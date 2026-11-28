import {
	APPEARANCE_KEYS,
	type AppearancePreferenceKey,
	type AppearanceValue,
	type AppearanceValues,
	appearanceDefinition,
	isAppearanceValue,
} from "@shared/appearance-preferences";
import { getAppBase } from "./base-path";

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}
type OperationIds = Partial<Record<AppearancePreferenceKey, string>>;
interface LocalState {
	customEnabled: boolean;
	sync: Partial<Record<AppearancePreferenceKey, boolean>>;
	values: AppearanceValues;
	cache: AppearanceValues;
	pending: AppearanceValues;
	operations: OperationIds;
}
export type AppearancePatch = Record<string, unknown> & {
	appearancePreferences?: AppearanceValues;
};
type Transport = (patch: AppearancePatch, signal: AbortSignal) => Promise<unknown>;
const emptyState = (): LocalState => ({
	customEnabled: false,
	sync: {},
	values: {},
	cache: {},
	pending: {},
	operations: {},
});

/** No API/React imports: this module is also used by the pre-mount theme readers. */
export class AppearancePreferenceStore {
	private state = emptyState();
	private saved = emptyState();
	private anonymousEdits: AppearanceValues = {};
	// A different tab's acknowledgement must never acknowledge this tab's queue.
	private ownedPending: AppearanceValues = {};
	private ownedOperations: OperationIds = {};
	private writer = Math.random().toString(36).slice(2);
	private operationSeq = 0;
	private listeners = new Set<() => void>();
	private userId: string | null = null;
	private epoch = 0;
	private transport: Transport | null = null;
	private remote: AppearanceValues = {};
	private working: Promise<void> | null = null;
	private abort: AbortController | null = null;
	private revision = 0;
	ready = false;
	error: unknown = null;

	constructor(
		private storage: () => StorageLike | null,
		private namespace: () => string = () => "/",
	) {}

	subscribe = (cb: () => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};
	getSnapshot = () => this.revision;
	getUserId = () => this.userId;
	get customEnabled() {
		return this.state.customEnabled;
	}

	private key() {
		return `narrafork_appearance_sync_v1:${this.namespace()}:${this.userId}`;
	}
	private readStorage(key: string): string | null {
		try {
			return this.storage()?.getItem(key) ?? null;
		} catch {
			return null;
		}
	}
	private writeStorage(key: string, value: string) {
		try {
			this.storage()?.setItem(key, value);
		} catch {
			/* Keep this session usable without storage. */
		}
	}
	private load(): LocalState {
		const result = emptyState();
		const raw = this.readStorage(this.key());
		if (!raw || raw.length > 48_000) return result;
		try {
			const parsed = JSON.parse(raw);
			result.customEnabled = parsed?.customEnabled === true;
			for (const key of APPEARANCE_KEYS) {
				if (typeof parsed?.sync?.[key] === "boolean") result.sync[key] = parsed.sync[key];
				for (const field of ["values", "cache", "pending"] as const) {
					if (isAppearanceValue(key, parsed?.[field]?.[key]))
						result[field][key] = parsed[field][key];
				}
				if (result.pending[key] !== undefined) {
					const operation = parsed?.operations?.[key];
					result.operations[key] =
						typeof operation === "string" && operation.length <= 96 ? operation : `legacy:${key}`;
				}
			}
		} catch {
			/* A damaged cache is not account data. */
		}
		return result;
	}
	private persist() {
		if (!this.userId) return;
		// storage events are asynchronous. Merge only this operation's changes into
		// the latest disk record so a different tab's unrelated edit is not lost.
		if (this.readStorage(this.key()) !== null) {
			const latest = this.load();
			if (this.state.customEnabled !== this.saved.customEnabled)
				latest.customEnabled = this.state.customEnabled;
			for (const field of ["sync", "values", "cache"] as const) {
				for (const key of APPEARANCE_KEYS) {
					const next = this.state[field][key];
					const previous = this.saved[field][key];
					if (next === previous) continue;
					if (next === undefined) {
						// Completing an old request must not delete another tab's newer edit.
						if (latest[field][key] === previous) delete latest[field][key];
					} else Object.assign(latest[field], { [key]: next });
				}
			}
			for (const key of APPEARANCE_KEYS) {
				const operation = this.state.operations[key];
				const previous = this.saved.operations[key];
				if (operation === previous) continue;
				if (operation && this.state.pending[key] !== undefined) {
					latest.operations[key] = operation;
					latest.pending[key] = this.state.pending[key];
				} else if (latest.operations[key] === previous) {
					delete latest.operations[key];
					delete latest.pending[key];
				}
			}
			this.state = latest;
		}
		this.saved = structuredClone(this.state);
		this.writeStorage(this.key(), JSON.stringify(this.state));
	}
	private emit() {
		this.revision++;
		for (const cb of this.listeners) cb();
	}
	private legacy(key: AppearancePreferenceKey): AppearanceValue {
		const def = appearanceDefinition(key);
		const raw = def.storageKey ? this.readStorage(def.storageKey) : null;
		if (raw === null) return def.fallback;
		let value: unknown = raw;
		if (typeof def.fallback === "boolean") value = raw === "true";
		if (typeof def.fallback === "number") {
			const parsed = Number.parseInt(raw, 10);
			value = Number.isFinite(parsed)
				? Math.max(def.min ?? -Infinity, Math.min(def.max ?? Infinity, parsed))
				: def.fallback;
		}
		return isAppearanceValue(key, value) ? value : def.fallback;
	}
	isSynced = (key: AppearancePreferenceKey): boolean => {
		const def = appearanceDefinition(key);
		return this.state.customEnabled && def.customizable
			? (this.state.sync[key] ?? def.defaultSync)
			: def.defaultSync;
	};
	get = (key: AppearancePreferenceKey): AppearanceValue => {
		const def = appearanceDefinition(key);
		if (!this.userId) return this.anonymousEdits[key] ?? this.legacy(key);
		if (this.isSynced(key)) {
			return (
				this.ownedPending[key] ??
				this.state.pending[key] ??
				this.remote[key] ??
				this.state.cache[key] ??
				this.state.values[key] ??
				def.fallback
			);
		}
		return this.state.values[key] ?? def.fallback;
	};
	private mirror() {
		for (const key of APPEARANCE_KEYS) {
			const storageKey = appearanceDefinition(key)?.storageKey;
			if (storageKey) {
				const value = String(this.get(key));
				if (this.readStorage(storageKey) !== value) this.writeStorage(storageKey, value);
			}
		}
	}
	activate(userId: string | null, force = false) {
		if (!force && this.userId === userId) return;
		const staged = this.userId === null && userId !== null ? this.anonymousEdits : {};
		this.anonymousEdits = {};
		this.epoch++;
		this.abort?.abort();
		this.abort = null;
		this.userId = userId;
		this.ready = false;
		this.transport = null;
		this.remote = {};
		this.error = null;
		this.state = userId ? this.load() : emptyState();
		this.saved = structuredClone(this.state);
		// Recover persisted explicit edits on initialization, not on every storage event.
		this.ownedPending = { ...this.state.pending };
		this.ownedOperations = { ...this.state.operations };
		if (userId) {
			// Claim legacy, unscoped settings once. A later account must not inherit the
			// preceding account's active OLED/theme/cache mirrors.
			const ownerKey = `narrafork_appearance_legacy_owner:${this.namespace()}`;
			const owner = this.readStorage(ownerKey);
			if (!owner || owner === userId) {
				for (const key of APPEARANCE_KEYS) {
					if (appearanceDefinition(key)?.storageKey && this.state.values[key] === undefined) {
						this.state.values[key] = this.legacy(key);
					}
				}
				this.writeStorage(ownerKey, userId);
			}
			for (const key of APPEARANCE_KEYS) {
				const value = staged[key];
				if (value === undefined) continue;
				this.state.values[key] = value;
				if (this.isSynced(key)) this.queue(key, value);
			}
			this.persist();
			this.mirror();
		}
		this.emit();
	}
	hydrate(userId: string, prefs: Record<string, unknown>, transport: Transport) {
		this.activate(userId);
		this.transport = transport;
		const wasReady = this.ready;
		let changed = !wasReady;
		const extra = prefs.appearancePreferences;
		for (const key of APPEARANCE_KEYS) {
			const def = appearanceDefinition(key);
			const candidate = def.field
				? prefs[def.field]
				: extra && typeof extra === "object"
					? (extra as Record<string, unknown>)[key]
					: undefined;
			if (isAppearanceValue(key, candidate)) {
				if (this.remote[key] !== candidate) changed = true;
				this.remote[key] = candidate;
				this.state.cache[key] = candidate;
			} else if (this.remote[key] !== undefined) {
				delete this.remote[key];
				delete this.state.cache[key];
				changed = true;
			}
		}
		this.ready = true;
		if (changed) {
			this.persist();
			this.mirror();
			this.emit();
		}
		// Only pending explicit edits can be replayed. Loading defaults never uploads.
		if (!wasReady) this.flush();
	}
	private queue(key: AppearancePreferenceKey, value: AppearanceValue) {
		const operation = `${this.writer}:${++this.operationSeq}`;
		this.state.pending[key] = value;
		this.state.operations[key] = operation;
		this.ownedPending[key] = value;
		this.ownedOperations[key] = operation;
	}
	set = (key: AppearancePreferenceKey, value: AppearanceValue) => {
		if (!isAppearanceValue(key, value)) return;
		if (!this.userId) {
			const storageKey = appearanceDefinition(key)?.storageKey;
			if (storageKey) {
				this.anonymousEdits[key] = value;
				// During identity lookup, do not turn a session's edit into an
				// unscoped legacy value that a different account could later claim.
				if (!this.readStorage("narrafork_token")) this.writeStorage(storageKey, String(value));
			}
			this.emit();
			return;
		}
		if (this.isSynced(key)) this.queue(key, value);
		else this.state.values[key] = value;
		this.persist();
		this.mirror();
		this.emit();
		this.flush();
	};
	private transition(previous: Map<AppearancePreferenceKey, boolean>) {
		for (const key of APPEARANCE_KEYS) {
			if (previous.get(key) === this.isSynced(key)) continue;
			if (this.isSynced(key)) {
				// Existing account values win on opt-in. Seed only an absent account key.
				if (this.remote[key] === undefined)
					this.queue(key, this.state.values[key] ?? appearanceDefinition(key).fallback);
			} else {
				// Keep an existing independent value across default/custom mode changes.
				this.state.values[key] ??=
					this.state.pending[key] ??
					this.remote[key] ??
					this.state.cache[key] ??
					appearanceDefinition(key).fallback;
				delete this.state.pending[key];
				delete this.state.operations[key];
				delete this.ownedPending[key];
				delete this.ownedOperations[key];
			}
		}
		this.persist();
		this.mirror();
		this.emit();
		this.flush();
	}
	setCustomEnabled = (enabled: boolean) => {
		if (!this.ready || this.state.customEnabled === enabled) return;
		const previous = new Map(APPEARANCE_KEYS.map((key) => [key, this.isSynced(key)]));
		this.state.customEnabled = enabled;
		this.transition(previous);
	};
	setSynced = (key: AppearancePreferenceKey, enabled: boolean) => {
		if (!this.ready || !this.state.customEnabled || !appearanceDefinition(key)?.customizable)
			return;
		const previous = new Map(APPEARANCE_KEYS.map((item) => [item, this.isSynced(item)]));
		this.state.sync[key] = enabled;
		this.transition(previous);
	};
	/** Route existing account mutation hooks without changing their unrelated fields. */
	splitPatch(patch: Record<string, unknown>): Record<string, unknown> {
		const remote: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(patch)) {
			const def = appearanceDefinition(key);
			if (def?.field && def.customizable && isAppearanceValue(key, value)) {
				// The store owns all presentation writes, including ordering/retry.
				this.set(key as AppearancePreferenceKey, value);
			} else remote[key] = value;
		}
		return remote;
	}
	/** Events contain only this tab's origin data. No cross-origin identity inference. */
	onStorage(key: string | null) {
		if (!this.userId) {
			this.emit();
			return;
		}
		if (key !== null && key !== this.key()) return;
		this.state = this.load();
		this.saved = structuredClone(this.state);
		for (const key of APPEARANCE_KEYS) {
			if (!this.isSynced(key)) {
				delete this.ownedPending[key];
				delete this.ownedOperations[key];
			}
		}
		this.mirror();
		this.emit();
		this.flush();
	}
	retry = () => {
		this.error = null;
		this.flush();
	};
	flush(): Promise<void> {
		if (this.working) return this.working;
		if (!this.ready || !this.transport || !this.userId) return Promise.resolve();
		if (!APPEARANCE_KEYS.some((key) => this.ownedPending[key] !== undefined && this.isSynced(key)))
			return Promise.resolve();
		const epoch = this.epoch;
		this.working = Promise.resolve()
			.then(async () => {
				while (this.epoch === epoch && this.ready && this.transport) {
					const sent: AppearanceValues = {};
					const sentOperations: OperationIds = {};
					const patch: AppearancePatch = {};
					for (const key of APPEARANCE_KEYS) {
						const value = this.ownedPending[key];
						if (value === undefined || !this.isSynced(key)) continue;
						sent[key] = value;
						sentOperations[key] = this.ownedOperations[key];
						const def = appearanceDefinition(key);
						if (def.field) patch[def.field] = value;
						else {
							patch.appearancePreferences ??= {};
							patch.appearancePreferences[key] = value;
						}
					}
					if (!Object.keys(sent).length) break;
					try {
						this.abort = new AbortController();
						await this.transport(patch, this.abort.signal);
						if (this.epoch !== epoch) break;
						this.error = null;
						for (const key of APPEARANCE_KEYS) {
							const value = sent[key];
							if (value === undefined) continue;
							this.remote[key] = value;
							this.state.cache[key] = value;
							if (this.state.operations[key] === sentOperations[key]) {
								delete this.state.pending[key];
								delete this.state.operations[key];
							}
							if (this.ownedOperations[key] === sentOperations[key]) {
								delete this.ownedPending[key];
								delete this.ownedOperations[key];
							}
						}
						this.persist();
						this.mirror();
						this.emit();
					} catch (error) {
						if (this.epoch === epoch) {
							this.error = error;
							this.persist();
							this.emit();
						}
						break;
					}
				}
			})
			.finally(() => {
				this.working = null;
				// Account changes can occur while an old request is in flight.
				if (
					this.ready &&
					(this.epoch !== epoch ||
						(!this.error &&
							APPEARANCE_KEYS.some(
								(key) => this.ownedPending[key] !== undefined && this.isSynced(key),
							)))
				)
					this.flush();
			});
		return this.working;
	}
}

export const appearanceStore = new AppearancePreferenceStore(
	() => (typeof localStorage === "undefined" ? null : localStorage),
	getAppBase,
);
let observing = false;
function ensureObservers() {
	if (observing || typeof window === "undefined") return;
	observing = true;
	window.addEventListener("storage", (event) => appearanceStore.onStorage(event.key));
	window.addEventListener("online", appearanceStore.retry);
}
export function subscribeAppearancePreferences(cb: () => void) {
	ensureObservers();
	return appearanceStore.subscribe(cb);
}
