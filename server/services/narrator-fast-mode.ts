import { normalizeBooleanOverride } from "../lib/boolean-override";
import { eventBus } from "../lib/event-bus";

export interface ResolvedNarratorFastMode {
	effectiveFastMode: boolean;
	fastModeSource: "user-default" | "override" | "primary" | "unavailable";
	fastModeSourceNarratorId: string | null;
}

/** Only facts owned by this narrator; inherited effective values are never cached. */
export interface NarratorFastModeRow {
	type: "primary" | "subagent";
	fastModeOverride: unknown;
	aclRootNarratorId?: string | null;
	ownerUserId?: string | null;
	runtimeRegistrationJson?: unknown;
}

export interface NarratorFastModeDependencies {
	loadNarrator(id: string, signal: AbortSignal): Promise<NarratorFastModeRow | undefined>;
	loadUserDefault(id: string, signal: AbortSignal): Promise<boolean>;
	/** undefined means unknown; null is an explicitly anonymous active run. */
	getActivePrincipal(id: string): string | null | undefined;
	getPersistedPrincipal(row: NarratorFastModeRow): string | null | undefined;
	events: Pick<typeof eventBus, "on" | "off">;
	readTimeoutMs?: number;
	narratorCapacity?: number;
	userCapacity?: number;
}

const STALE = Symbol("stale-fast-mode-read");
const DEFAULT_READ_TIMEOUT_MS = 30_000;

interface CacheEntry<T> {
	id: string;
	valid: boolean;
	loaded: boolean;
	value?: T;
	/** Missing narrators are not retained, but their request still needs a version check. */
	missingRevision?: number;
	controller: AbortController;
	onInvalidate(listener: () => void): () => void;
	invalidate(): void;
	promise: Promise<T | typeof STALE>;
}

interface Dependency {
	isCurrent(): boolean;
	onInvalidate?: (listener: () => void) => () => void;
}

interface NarratorFact extends NarratorFastModeRow {
	persistedPrincipalLoaded: boolean;
	persistedPrincipal?: string | null;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Fast mode resolution aborted", "AbortError");
}

/** Each waiter owns its cancellation; cancelling one request never cancels other waiters. */
function waitFor<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	deadline: number,
): Promise<T> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	const remaining = deadline - Date.now();
	if (remaining <= 0)
		return Promise.reject(new DOMException("Fast mode read timed out", "TimeoutError"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => finish(() => reject(abortReason(signal as AbortSignal)));
		const timer = setTimeout(
			() => finish(() => reject(new DOMException("Fast mode read timed out", "TimeoutError"))),
			remaining,
		);
		function finish(settle: () => void) {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			settle();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) =>
				finish(() => {
					if (Date.now() >= deadline)
						reject(new DOMException("Fast mode read timed out", "TimeoutError"));
					else resolve(value);
				}),
			(error) => finish(() => reject(error)),
		);
	});
}

/** Entry identities are generations; removing an entry never leaves an unbounded tombstone map. */
class FactCache<T> {
	private entries = new Map<string, CacheEntry<T>>();
	private revision = 0;

	constructor(
		private capacity: number,
		private timeoutMs: number,
		private loader: (id: string, signal: AbortSignal) => Promise<T>,
		private retain: (value: T) => boolean = () => true,
	) {}

	get(id: string): CacheEntry<T> {
		const cached = this.entries.get(id);
		if (cached) {
			this.entries.delete(id);
			this.entries.set(id, cached);
			return cached;
		}
		const controller = new AbortController();
		const invalidated = Promise.withResolvers<typeof STALE>();
		const listeners = new Set<() => void>();
		const entry: CacheEntry<T> = {
			id,
			valid: true,
			loaded: false,
			controller,
			onInvalidate(listener) {
				if (!entry.valid) listener();
				else listeners.add(listener);
				return () => listeners.delete(listener);
			},
			invalidate() {
				entry.valid = false;
				invalidated.resolve(STALE);
				for (const listener of listeners) listener();
				listeners.clear();
				controller.abort();
			},
			promise: Promise.resolve<typeof STALE>(STALE),
		};
		this.entries.set(id, entry);
		while (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.invalidate(oldest);
		}
		// Start after publishing the entry, so synchronous throws and reentrant invalidation
		// share exactly the same cleanup path as Worker failures.
		const read = Promise.resolve().then(() => this.loader(id, controller.signal));
		entry.promise = Promise.race([
			waitFor(read, controller.signal, Date.now() + this.timeoutMs),
			invalidated.promise,
		]).then(
			(value): T | typeof STALE => {
				if (value === STALE || !this.isCurrent(entry)) return STALE;
				entry.loaded = true;
				entry.value = value;
				if (!this.retain(value)) {
					this.entries.delete(id);
					entry.missingRevision = this.revision;
				}
				return value;
			},
			(error): typeof STALE => {
				if (!this.isCurrent(entry)) return STALE;
				this.entries.delete(id);
				entry.valid = false;
				controller.abort(error);
				throw error;
			},
		);
		return entry;
	}

	isCurrent(entry: CacheEntry<T>): boolean {
		return (
			entry.valid &&
			(this.entries.get(entry.id) === entry || entry.missingRevision === this.revision)
		);
	}

	invalidate(id: string): void {
		this.revision++;
		const entry = this.entries.get(id);
		this.entries.delete(id);
		entry?.invalidate();
	}

	invalidateWhere(predicate: (value: T) => boolean): void {
		for (const [id, entry] of this.entries) {
			if (!entry.loaded || predicate(entry.value as T)) this.invalidate(id);
		}
		// Also invalidate request-local, uncached missing results.
		this.revision++;
	}

	clear(): void {
		this.revision++;
		for (const entry of this.entries.values()) entry.invalidate();
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

const unavailable = (): ResolvedNarratorFastMode => ({
	effectiveFastMode: false,
	fastModeSource: "unavailable",
	fastModeSourceNarratorId: null,
});

/** Injectable core: tests use in-memory facts and an isolated event bus, never a runtime DB. */
export function createNarratorFastModeResolver(dependencies: NarratorFastModeDependencies) {
	const timeoutMs = dependencies.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const narratorCapacity = dependencies.narratorCapacity ?? 1024;
	const userCapacity = dependencies.userCapacity ?? 256;
	if (narratorCapacity < 2 || userCapacity < 1 || timeoutMs <= 0)
		throw new Error("Fast mode cache requires at least two narrator entries and one user entry");
	const narrators = new FactCache<NarratorFact | undefined>(
		narratorCapacity,
		timeoutMs,
		async (id, signal) => {
			const row = await dependencies.loadNarrator(id, signal);
			return row ? { ...row, persistedPrincipalLoaded: false } : undefined;
		},
		(value) => value !== undefined,
	);
	const users = new FactCache(userCapacity, timeoutMs, dependencies.loadUserDefault);
	let disposed = false;

	function persistedPrincipal(row: NarratorFact) {
		if (!row.persistedPrincipalLoaded) {
			row.persistedPrincipal = dependencies.getPersistedPrincipal(row);
			row.persistedPrincipalLoaded = true;
		}
		return row.persistedPrincipal;
	}

	async function read<T>(
		cache: FactCache<T>,
		id: string,
		actualDependencies: Dependency[],
		signal: AbortSignal | undefined,
		deadline: number,
	): Promise<T | typeof STALE> {
		const entry = cache.get(id);
		actualDependencies.push({
			isCurrent: () => cache.isCurrent(entry),
			onInvalidate: entry.onInvalidate,
		});
		if (entry.loaded) return entry.value as T;
		// An earlier dependency may change while an upper layer is loading. Wake the
		// whole attempt immediately (e.g. a child now pinned on need not wait for root).
		const changed = Promise.withResolvers<typeof STALE>();
		const unsubscribe = actualDependencies.flatMap((dependency) =>
			dependency.onInvalidate ? [dependency.onInvalidate(() => changed.resolve(STALE))] : [],
		);
		try {
			return await waitFor(Promise.race([entry.promise, changed.promise]), signal, deadline);
		} finally {
			for (const remove of unsubscribe) remove();
		}
	}

	async function resolveNarratorFastMode(
		narratorId: string,
		options: { signal?: AbortSignal } = {},
	): Promise<ResolvedNarratorFastMode> {
		const { signal } = options;
		const deadline = Date.now() + timeoutMs;
		while (true) {
			if (disposed) throw new Error("Fast mode resolver has been disposed");
			if (signal?.aborted) throw abortReason(signal);
			if (Date.now() >= deadline)
				throw new DOMException("Fast mode resolution timed out", "TimeoutError");
			const actualDependencies: Dependency[] = [];
			const own = await read(narrators, narratorId, actualDependencies, signal, deadline);
			if (own === STALE) continue;
			let result: ResolvedNarratorFastMode;
			const override = normalizeBooleanOverride(own?.fastModeOverride);
			if (!own) {
				result = unavailable();
			} else if (override !== "inherit") {
				result = {
					effectiveFastMode: override === "on",
					fastModeSource: "override",
					fastModeSourceNarratorId: null,
				};
			} else {
				const rootId = own.type === "primary" ? narratorId : own.aclRootNarratorId;
				const root = !rootId
					? undefined
					: rootId === narratorId
						? own
						: await read(narrators, rootId, actualDependencies, signal, deadline);
				if (root === STALE) continue;
				if (!root || root.type !== "primary" || !rootId) {
					result = unavailable();
				} else {
					const rootOverride = normalizeBooleanOverride(root.fastModeOverride);
					let effectiveFastMode = rootOverride === "on";
					if (rootOverride === "inherit") {
						const active = dependencies.getActivePrincipal(rootId);
						actualDependencies.push({
							isCurrent: () => dependencies.getActivePrincipal(rootId) === active,
						});
						const principal = active !== undefined ? active : persistedPrincipal(root);
						if (principal) {
							const userDefault = await read(
								users,
								principal,
								actualDependencies,
								signal,
								deadline,
							);
							if (userDefault === STALE) continue;
							effectiveFastMode = userDefault;
						}
					}
					result = {
						effectiveFastMode,
						fastModeSource: own.type === "subagent" ? "primary" : "user-default",
						fastModeSourceNarratorId: own.type === "subagent" ? rootId : null,
					};
				}
			}
			// No await between validating every actual dependency and freezing this snapshot.
			if (signal?.aborted) throw abortReason(signal);
			if (Date.now() >= deadline)
				throw new DOMException("Fast mode resolution timed out", "TimeoutError");
			if (actualDependencies.every((dependency) => dependency.isCurrent())) return result;
		}
	}

	const onNarratorChanged = ({ narratorId }: { narratorId: string }) =>
		narrators.invalidate(narratorId);
	const onUserChanged = ({ userId }: { userId: string }) => users.invalidate(userId);
	const onImported = () => narrators.clear();
	const onNarratorDeleted = ({ narratorId }: { narratorId: string }) => {
		narrators.invalidate(narratorId);
		// Deleting a root also SET NULLs its children's persisted ACL-root column.
		// Only inspect the bounded in-memory cache; never query or walk a child tree.
		narrators.invalidateWhere((row) => row?.aclRootNarratorId === narratorId);
	};
	const onAccessChanged = (event: { narratorId: string; reason: string }) => {
		if (event.reason === "owner_changed") narrators.invalidate(event.narratorId);
	};
	const onAuthChanged = ({ userId }: { userId?: string }) => {
		if (!userId) {
			narrators.clear();
			users.clear();
			return;
		}
		users.invalidate(userId);
		narrators.invalidateWhere((row) => {
			if (!row || row.ownerUserId === userId) return true;
			try {
				return persistedPrincipal(row) === userId;
			} catch {
				return true;
			}
		});
	};
	const { events } = dependencies;
	events.on("narrator:fast_mode_changed", onNarratorChanged);
	events.on("narrator:execution_principal_changed", onNarratorChanged);
	events.on("narrator:imported", onImported);
	events.on("narrator:deleted", onNarratorDeleted);
	events.on("user:fast_mode_default_changed", onUserChanged);
	events.on("narrator:access_changed", onAccessChanged);
	events.on("auth:changed", onAuthChanged);

	return {
		resolveNarratorFastMode,
		reset() {
			narrators.clear();
			users.clear();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			events.off("narrator:fast_mode_changed", onNarratorChanged);
			events.off("narrator:execution_principal_changed", onNarratorChanged);
			events.off("narrator:imported", onImported);
			events.off("narrator:deleted", onNarratorDeleted);
			events.off("user:fast_mode_default_changed", onUserChanged);
			events.off("narrator:access_changed", onAccessChanged);
			events.off("auth:changed", onAuthChanged);
			narrators.clear();
			users.clear();
		},
		getCacheSizes: () => ({ narrators: narrators.size, users: users.size }),
	};
}

async function createDefaultResolver() {
	// Lazy dependencies keep pure factory imports independent of DB startup and avoid
	// cycles through runtime ownership, narrator persistence and route registration.
	const [
		{ eq },
		{ db },
		schema,
		{ readQuery },
		{ executionPrincipalOf },
		{ getExecutionOwner, getRunControl },
		{ activeNarrators },
	] = await Promise.all([
		import("drizzle-orm"),
		import("../db"),
		import("../db/schema"),
		import("../db/worker-read"),
		import("../lib/runtime-source"),
		import("./agent-runtime/ownership"),
		import("./narrator-session-state"),
	]);
	return createNarratorFastModeResolver({
		events: eventBus,
		getActivePrincipal: (id) => {
			if (getExecutionOwner(id)?.kind === "tool-replay")
				return activeNarrators.get(id)?._currentUserId;
			return getRunControl(id)?.principal;
		},
		getPersistedPrincipal: (row) => executionPrincipalOf(row)?.userId,
		loadNarrator: async (id, signal) => {
			const [row] = await readQuery(
				db
					.select({
						type: schema.narrators.type,
						fastModeOverride: schema.narrators.fastModeOverride,
						aclRootNarratorId: schema.narrators.aclRootNarratorId,
						ownerUserId: schema.narrators.ownerUserId,
						runtimeRegistrationJson: schema.narrators.runtimeRegistrationJson,
					})
					.from(schema.narrators)
					.where(eq(schema.narrators.id, id))
					.limit(1),
				{
					signal,
					maxRows: 1,
					timeoutMs: DEFAULT_READ_TIMEOUT_MS,
				},
			);
			return row;
		},
		loadUserDefault: async (id, signal) => {
			const [row] = await readQuery(
				db
					.select({ fastModeDefault: schema.userPreferences.fastModeDefault })
					.from(schema.userPreferences)
					.where(eq(schema.userPreferences.userId, id))
					.limit(1),
				{
					signal,
					maxRows: 1,
					timeoutMs: DEFAULT_READ_TIMEOUT_MS,
				},
			);
			return row?.fastModeDefault ?? false;
		},
	});
}

let defaultResolver: ReturnType<typeof createDefaultResolver> | undefined;
let readyResolver: ReturnType<typeof createNarratorFastModeResolver> | undefined;

export async function resolveNarratorFastMode(
	narratorId: string,
	options?: { signal?: AbortSignal },
): Promise<ResolvedNarratorFastMode> {
	if (options?.signal?.aborted) throw abortReason(options.signal);
	if (readyResolver) return readyResolver.resolveNarratorFastMode(narratorId, options);
	defaultResolver ??= createDefaultResolver();
	const loading = defaultResolver;
	let resolver: Awaited<typeof loading>;
	try {
		resolver = await waitFor(loading, options?.signal, Date.now() + DEFAULT_READ_TIMEOUT_MS);
	} catch (error) {
		// A cancelled caller does not invalidate another caller's shared initialization.
		void loading.catch(() => {
			if (defaultResolver === loading) defaultResolver = undefined;
		});
		throw error;
	}
	readyResolver = resolver;
	return resolver.resolveNarratorFastMode(narratorId, options);
}
