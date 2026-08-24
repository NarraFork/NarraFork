/**
 * session-store.ts — The single gate every `sessionStorage` write goes through.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sessionStorage` has the one lifecycle that matches a reported hang exactly:
 * it SURVIVES a reload and is only cleared when the tab is closed. A tab that
 * became unusable, stayed unusable across a forced refresh, and recovered only
 * after being closed and reopened is describing this API, not a JS leak (a
 * reload rebuilds the whole realm) and not GPU state (that is per-renderer, not
 * per-origin).
 *
 * Two independent faults produced that state, and both were structural rather
 * than a mistuned constant:
 *
 *  1. UNBOUNDED KEY COUNT. Draft and input-history keys are scoped per
 *     `(user, narrator)`, so every narrator ever opened in the tab left two
 *     entries behind. Nothing ever enumerated the area to expire them — the only
 *     cleanup in the codebase removed a legacy key shape. Permission and ask
 *     drafts are keyed per request id, which is unbounded in the same way for
 *     any request that never reached a decision.
 *
 *  2. SYNCHRONOUS FULL-VALUE WRITE PER KEYSTROKE. The draft effects depended on
 *     the live input value, so each keystroke re-serialised and re-wrote the
 *     entire body. `sessionStorage` is synchronous and Chrome persists it for
 *     session restore, so this lands on the main thread — the thread an IME must
 *     wait for to place its candidate window. That is why typing (and, once the
 *     main thread is saturated, the rest of the desktop) stuttered while CPU and
 *     memory both looked idle.
 *
 * The two faults MULTIPLY. Fault 1 grows the area toward the ~5MB quota; fault 2
 * pays a full synchronous write, against that oversized area, on every keystroke.
 * Past the quota `setItem` throws, every previous call site swallowed the error,
 * and the write cost was paid for nothing — a state with no self-healing path,
 * which is what made it persist until the tab was closed.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 *   - a byte budget enforced on WRITE, with LRU eviction of this module's own
 *     namespaces (never of keys it does not own);
 *   - per-namespace key caps, so one unbounded id space cannot starve others;
 *   - a two-tier eviction order, so an entry that holds NOTHING the user typed is
 *     never the reason one that does gets dropped (see `SessionWritePriority`);
 *   - coalesced writes: a hot key is written at most once per flush window, and
 *     always flushed on `pagehide`/`visibilitychange` so nothing is lost;
 *   - quota failure is HANDLED (evict, retry once, then report) instead of
 *     silently discarded.
 *
 * DELIBERATELY REACT-FREE, and it never throws: storage is unavailable in
 * private-mode variants and inside some embedded webviews, and a draft is a
 * convenience, never a source of truth (the server owns narrator drafts). Every
 * entry point degrades to a no-op instead of taking a panel down.
 */

/**
 * Namespaces this module owns. Only these are eligible for eviction — the guard
 * that keeps a budget sweep from deleting unrelated keys (auth tokens, another
 * feature's state) that happen to share the origin.
 */
export type SessionNamespace =
	| "narrator-draft"
	| "narrator-history"
	| "chat-draft"
	| "permission-draft"
	| "ask-draft"
	| "ui-flag";

/**
 * Total budget in UTF-16 code units across every owned entry.
 *
 * Chrome's real ceiling is ~5MB per area and a `QuotaExceededError` is a cliff:
 * the write fails after its cost is already paid. Sitting well under it means
 * eviction is driven by THIS budget — which can be enforced predictably — rather
 * than by the browser's hard limit. Characters (not bytes) because that is what
 * a value's `.length` reports, so accounting needs no encoding pass.
 */
const TOTAL_BUDGET_CHARS = 1_500_000;

/**
 * Per-namespace key caps.
 *
 * The narrator caps bound "how many narrators has this tab visited" to a working
 * set rather than a session history; the request-scoped caps bound id spaces that
 * grow with every prompt the user never answered. A cap is enforced on insert, so
 * an id space cannot grow without bound even while the byte budget still has room.
 */
const NAMESPACE_KEY_CAPS: Record<SessionNamespace, number> = {
	"narrator-draft": 8,
	"narrator-history": 8,
	// One entry per `(user, room)` whose composer holds unsent text or attachment
	// ids. Bounded like the narrator caps and for the same reason: a tab that
	// visits many rooms must keep a working set, not a visit history.
	"chat-draft": 12,
	"permission-draft": 24,
	"ask-draft": 24,
	"ui-flag": 16,
};

/**
 * Largest value this module will store, per entry.
 *
 * A body past this is not worth a synchronous main-thread write: narrator drafts
 * are synced server-side and everything else here is a convenience. The previous
 * per-call-site limits ran to 200k-512k characters, which let a HANDFUL of
 * entries approach the whole quota on their own.
 */
const MAX_VALUE_CHARS = 64_000;

/** Coalescing window (ms) for a hot key. Short enough to survive a crash, long
 * enough that a fast typist produces one write instead of dozens. */
const FLUSH_DELAY_MS = 400;

const KEY_PREFIX = "nf.s.";

/**
 * How much a caller stands to lose if this entry is evicted.
 *
 * Recency alone is the wrong eviction order here, because the hot path writes
 * entries that carry NOTHING worth keeping. Every narrator a tab opens mirrors
 * its draft on hydration, and for an untouched narrator that mirror is the empty
 * string — yet it took a slot, and being the most recent write it outranked a
 * draft the user had actually typed. Eight visited narrators later, the typed one
 * was gone, and hydration then "restored" the server copy over it.
 *
 * `"disposable"` says: this entry is reconstructible from a source of truth (or
 * holds nothing at all), so evict it before anything the user authored. It is a
 * property of the VALUE, not of the namespace — the same key is disposable while
 * empty and durable once typed into.
 */
export type SessionWritePriority = "durable" | "disposable";

interface OwnedEntry {
	namespace: SessionNamespace;
	chars: number;
	/** Monotonic touch counter — the LRU ordering WITHIN a priority tier. */
	touched: number;
	/** Eviction tier; disposable entries are dropped before durable ones. */
	priority: SessionWritePriority;
}

/** Metadata for owned keys. Mirrors what is in storage; never the source of truth. */
const owned = new Map<string, OwnedEntry>();

interface PendingWrite {
	/** null means "remove this key". */
	value: string | null;
	priority: SessionWritePriority;
}

const pending = new Map<string, PendingWrite>();

/**
 * Eviction order: disposable entries first, then least-recently-touched.
 *
 * Sorting by priority BEFORE recency is the whole fix. Ordering by `touched`
 * alone let a freshly-written empty mirror protect itself and evict a typed
 * draft, which is invisible at the storage layer and only shows up as a composer
 * that blanked itself after a narrator switch.
 */
function evictionOrder(a: OwnedEntry, b: OwnedEntry): number {
	if (a.priority !== b.priority) return a.priority === "disposable" ? -1 : 1;
	return a.touched - b.touched;
}

function evictionCandidates(protectedKey: string): Array<[string, OwnedEntry]> {
	return [...owned.entries()]
		.filter(([key]) => key !== protectedKey)
		.sort((a, b) => evictionOrder(a[1], b[1]));
}

let totalChars = 0;
let touchCounter = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;
let quotaFailures = 0;

function storage(): Storage | null {
	try {
		// Touch the object AND probe access: some embedded webviews expose the
		// property but throw on first use, so a truthiness check is not enough.
		const area = globalThis.sessionStorage;
		if (!area) return null;
		return area;
	} catch {
		return null;
	}
}

function physicalKey(namespace: SessionNamespace, id: string): string {
	return `${KEY_PREFIX}${namespace}.${id}`;
}

/**
 * Adopt whatever this module already wrote in a previous page lifecycle.
 *
 * A reload keeps `sessionStorage` but resets module state, so without this the
 * budget would start at zero while the area was already full — the exact blind
 * spot that let the old code accumulate across refreshes. Runs once, reads only
 * lengths (never parses values), and drops anything unparseable.
 */
function adoptExistingEntries(area: Storage): void {
	const stale: string[] = [];
	for (let index = 0; index < area.length; index++) {
		const key = area.key(index);
		if (!key?.startsWith(KEY_PREFIX)) continue;
		const namespace = key.slice(KEY_PREFIX.length).split(".")[0] as SessionNamespace;
		if (!(namespace in NAMESPACE_KEY_CAPS)) {
			stale.push(key);
			continue;
		}
		const value = area.getItem(key);
		if (value === null) continue;
		// Adopted entries are DURABLE. The priority a previous page lifecycle wrote
		// with is not stored (it is a write-time hint, not part of the value), and
		// guessing "disposable" would make a reload the thing that discards a typed
		// draft — the exact failure this tier exists to prevent. A durable guess only
		// costs one eviction round, and the next write restates the real priority.
		owned.set(key, {
			namespace,
			chars: value.length,
			touched: ++touchCounter,
			priority: "durable",
		});
		totalChars += value.length;
	}
	for (const key of stale) {
		try {
			area.removeItem(key);
		} catch {
			// A failed cleanup only costs budget accuracy, never correctness.
		}
	}
}

let adopted = false;

function ensureInitialised(area: Storage): void {
	if (!adopted) {
		adopted = true;
		adoptExistingEntries(area);
	}
	installLifecycleListeners();
}

/**
 * Flush before the page can be discarded.
 *
 * `pagehide` is the reliable end-of-lifecycle signal (`beforeunload` is skipped
 * for bfcache and on mobile); `visibilitychange` covers a tab backgrounded and
 * then frozen. Without these, coalescing would silently lose the last edit —
 * which is why the delay can be as long as it is.
 */
function installLifecycleListeners(): void {
	if (listenersInstalled || typeof window === "undefined") return;
	listenersInstalled = true;
	const flushNow = () => flush();
	window.addEventListener("pagehide", flushNow);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flushNow();
	});
}

function scheduleFlush(): void {
	if (flushTimer !== null) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		flush();
	}, FLUSH_DELAY_MS);
}

/**
 * Evict owned entries until `needed` characters fit — disposable ones first.
 *
 * Only touches keys in `owned`, so a sweep can never remove state belonging to
 * another feature. `protectedKey` is the key being written: evicting it to make
 * room for itself would be a no-op loop.
 */
function evictUntilFits(area: Storage, needed: number, protectedKey: string): void {
	if (totalChars + needed <= TOTAL_BUDGET_CHARS) return;
	const candidates = evictionCandidates(protectedKey);
	for (const [key, entry] of candidates) {
		if (totalChars + needed <= TOTAL_BUDGET_CHARS) return;
		try {
			area.removeItem(key);
		} catch {
			// Keep going: the budget matters more than this one removal.
		}
		owned.delete(key);
		pending.delete(key);
		totalChars = Math.max(0, totalChars - entry.chars);
	}
}

/**
 * Free space for the quota-cliff retry by dropping owned entries outright.
 *
 * Unlike `evictUntilFits` this consults NO budget: it is reached only after the
 * browser rejected a write that our accounting believed would fit, so any
 * budget-relative target is by definition already satisfied and would evict
 * nothing. It releases a fraction of the owned entries — disposable first, then
 * oldest — which is enough to let one retry through while leaving the active
 * working set intact.
 */
function evictLeastRecentlyUsed(area: Storage, protectedKey: string): void {
	const candidates = evictionCandidates(protectedKey);
	if (candidates.length === 0) return;
	// Half the owned entries, and never fewer than one: a single oversized
	// neighbour is a common cause, and dropping everything would throw away drafts
	// the user can still see on screen.
	const dropCount = Math.max(1, Math.floor(candidates.length / 2));
	for (const [key, entry] of candidates.slice(0, dropCount)) {
		try {
			area.removeItem(key);
		} catch {
			// Budget accuracy only.
		}
		owned.delete(key);
		pending.delete(key);
		totalChars = Math.max(0, totalChars - entry.chars);
	}
}

/**
 * Enforce a namespace's key cap, dropping disposable entries before durable ones.
 *
 * This is the cap that actually bit: `narrator-draft` holds 8 keys, and every
 * narrator a tab opens mirrors its draft — empty for the ones nobody typed in.
 * Ordered by recency alone, those empty mirrors were the NEWEST entries and so
 * evicted the one draft that had text in it.
 */
function enforceNamespaceCap(
	area: Storage,
	namespace: SessionNamespace,
	protectedKey: string,
): void {
	const cap = NAMESPACE_KEY_CAPS[namespace];
	const entries = evictionCandidates(protectedKey).filter(
		([, entry]) => entry.namespace === namespace,
	);
	// `entries` excludes the protected key, so the cap compares against cap - 1.
	let excess = entries.length - (cap - 1);
	for (const [key, entry] of entries) {
		if (excess <= 0) return;
		excess--;
		try {
			area.removeItem(key);
		} catch {
			// Same reasoning as evictUntilFits.
		}
		owned.delete(key);
		pending.delete(key);
		totalChars = Math.max(0, totalChars - entry.chars);
	}
}

/**
 * Write one key through, making room first and handling a quota cliff.
 *
 * Returns false when the value could not be stored. A caller cannot do anything
 * useful with that (the server owns the real draft), so nothing branches on it —
 * but it drives `quotaFailures`, which turns a previously invisible failure into
 * something `sessionStoreStats()` can report.
 */
function writeThrough(
	area: Storage,
	key: string,
	value: string | null,
	priority: SessionWritePriority,
): boolean {
	const existing = owned.get(key);

	if (value === null) {
		if (existing) {
			owned.delete(key);
			totalChars = Math.max(0, totalChars - existing.chars);
		}
		try {
			area.removeItem(key);
			return true;
		} catch {
			return false;
		}
	}

	const namespace = key.slice(KEY_PREFIX.length).split(".")[0] as SessionNamespace;
	// Account for the replacement, not the sum: overwriting a key frees its old
	// size. Without this a repeatedly-written key would evict everything else.
	const delta = value.length - (existing?.chars ?? 0);
	enforceNamespaceCap(area, namespace, key);
	evictUntilFits(area, Math.max(0, delta), key);

	const commit = (): boolean => {
		try {
			area.setItem(key, value);
			owned.set(key, { namespace, chars: value.length, touched: ++touchCounter, priority });
			totalChars = Math.max(0, totalChars - (existing?.chars ?? 0)) + value.length;
			return true;
		} catch {
			return false;
		}
	};

	if (commit()) return true;

	// Quota cliff: the browser's real limit is below our accounting (another area
	// consumer, a stale estimate, or a per-origin limit shared with keys we do not
	// own). Free space and retry ONCE — an unbounded retry loop on a full area
	// would reproduce the stall this module prevents.
	//
	// ⚠️ Eviction here must NOT go through `evictUntilFits`: that helper measures
	// against this module's own character budget, and the whole reason we are on
	// this path is that the budget said the write fits while the browser
	// disagreed. Asking it to make room is a no-op, so the retry would fail for
	// exactly the same reason as the first attempt. Free the least-recently-used
	// owned entries unconditionally instead.
	quotaFailures++;
	evictLeastRecentlyUsed(area, key);
	if (commit()) return true;

	// Still failing: drop the key entirely so a stale value can never be read
	// back as if it were current.
	try {
		area.removeItem(key);
	} catch {
		// Nothing further to try.
	}
	if (existing) {
		owned.delete(key);
		totalChars = Math.max(0, totalChars - existing.chars);
	}
	return false;
}

/** Write every coalesced change immediately. */
export function flush(): void {
	if (flushTimer !== null) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (pending.size === 0) return;
	const area = storage();
	if (!area) {
		pending.clear();
		return;
	}
	ensureInitialised(area);
	const queue = [...pending.entries()];
	pending.clear();
	for (const [key, write] of queue) writeThrough(area, key, write.value, write.priority);
}

/**
 * Read a value, or null when absent/unavailable.
 *
 * Reads see pending writes first, so a read-after-write within one flush window
 * observes the value the caller just set rather than the stale stored one.
 */
export function readSession(namespace: SessionNamespace, id: string): string | null {
	const area = storage();
	if (!area) return null;
	ensureInitialised(area);
	const key = physicalKey(namespace, id);
	const queued = pending.get(key);
	if (queued !== undefined) return queued.value;
	const value = area.getItem(key);
	if (value === null) return null;
	const entry = owned.get(key);
	// Touch on read: a narrator being actively read from is part of the working
	// set and must not be the next eviction victim.
	if (entry) entry.touched = ++touchCounter;
	else {
		// Same reasoning as `adoptExistingEntries`: a value found in storage with no
		// metadata predates this page lifecycle, and assuming it is disposable would
		// let a reload discard authored text.
		owned.set(key, {
			namespace,
			chars: value.length,
			touched: ++touchCounter,
			priority: "durable",
		});
		totalChars += value.length;
	}
	return value;
}

/**
 * Queue a value for storage. Oversized values are REMOVED rather than stored, so
 * a body that grows past the cap cannot leave a truncated stale copy behind.
 *
 * `priority` defaults to `"durable"`, so a caller that never thinks about it gets
 * the safe tier. Pass `"disposable"` only for a value that is reconstructible
 * from a source of truth or carries nothing the user produced — an empty draft
 * mirror being the case this exists for. Marking authored text disposable would
 * silently make it the first thing evicted.
 */
export function writeSession(
	namespace: SessionNamespace,
	id: string,
	value: string,
	priority: SessionWritePriority = "durable",
): void {
	const area = storage();
	if (!area) return;
	ensureInitialised(area);
	if (value.length > MAX_VALUE_CHARS) {
		removeSession(namespace, id);
		return;
	}
	pending.set(physicalKey(namespace, id), { value, priority });
	scheduleFlush();
}

/** Queue a removal. Applied immediately in the metadata, flushed with the batch. */
export function removeSession(namespace: SessionNamespace, id: string): void {
	const area = storage();
	if (!area) return;
	ensureInitialised(area);
	// A removal frees space, so its own tier never decides anything; `durable`
	// keeps the queue entry shape uniform.
	pending.set(physicalKey(namespace, id), { value: null, priority: "durable" });
	scheduleFlush();
}

/**
 * Remove every owned entry in a namespace except the ids in `keep`.
 *
 * ⚠️ `keep` must be the COMPLETE set of ids still in use. A caller that passes
 * only "its own" id deletes everybody else's: several `NarratorPanel`s are
 * mounted at once in the graph nodes, the dockview panels and DirectorLayout, so
 * a per-panel call would drop the drafts of every other visible panel. That
 * hazard is why nothing calls this on mount.
 *
 * Routine convergence needs no caller: `NAMESPACE_KEY_CAPS` bounds each
 * namespace on every insert, so a tab that visited many narrators keeps a
 * working set rather than a session history. This exists for the case where a
 * caller genuinely knows the full live set and wants to reclaim immediately
 * instead of at the next cap boundary.
 */
export function retainSession(namespace: SessionNamespace, keep: readonly string[]): void {
	const area = storage();
	if (!area) return;
	ensureInitialised(area);
	const keepKeys = new Set(keep.map((id) => physicalKey(namespace, id)));
	for (const [key, entry] of [...owned.entries()]) {
		if (entry.namespace !== namespace || keepKeys.has(key)) continue;
		try {
			area.removeItem(key);
		} catch {
			// Budget accuracy only.
		}
		owned.delete(key);
		pending.delete(key);
		totalChars = Math.max(0, totalChars - entry.chars);
	}
}

/** Diagnostics for tests and for explaining a slow tab. */
export function sessionStoreStats(): {
	entries: number;
	chars: number;
	pending: number;
	quotaFailures: number;
	byNamespace: Record<string, number>;
} {
	const byNamespace: Record<string, number> = {};
	for (const entry of owned.values()) {
		byNamespace[entry.namespace] = (byNamespace[entry.namespace] ?? 0) + 1;
	}
	return {
		entries: owned.size,
		chars: totalChars,
		pending: pending.size,
		quotaFailures,
		byNamespace,
	};
}

/** Test seam: forget module state without touching the backing area. */
export function resetSessionStoreForTest(): void {
	owned.clear();
	pending.clear();
	totalChars = 0;
	touchCounter = 0;
	quotaFailures = 0;
	adopted = false;
	if (flushTimer !== null) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
}

export const SESSION_STORE_LIMITS = {
	TOTAL_BUDGET_CHARS,
	MAX_VALUE_CHARS,
	FLUSH_DELAY_MS,
	NAMESPACE_KEY_CAPS,
	KEY_PREFIX,
} as const;
