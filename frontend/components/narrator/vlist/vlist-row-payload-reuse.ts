/**
 * vlist-row-payload-reuse.ts — Keep a row's PER-KEY payload objects referentially
 * stable across document rebuilds that did not change that row.
 *
 * ── The cost this removes ─────────────────────────────────────────────────────
 *
 * `ExactRow` is memoized, and its comparator compares `interaction` by identity
 * like every other prop. That payload arrives from a map built in a `useMemo`
 * which depends on `renderItems` — and `renderItems` is a FRESH array on every
 * layout commit, including the ones a streaming delta triggers (the coordinator
 * rebuilds and re-emits per frame). So every delta minted a new payload object for
 * EVERY row in the document, the memo compared unequal for every mounted row, and
 * the whole window re-rendered on each frame of a live turn.
 *
 * That is what made the folded row's shimmer stutter. The shimmer is a CSS
 * animation sweeping `background-position` (see `frontend/styles/trace-shimmer.css`),
 * so it costs no React work at all — until React replaces the elements underneath
 * it. A re-render producing byte-identical output still reconciles the row's
 * subtree, and the sweep visibly hitches. The fix is therefore not throttling
 * anything: it is not re-rendering rows that did not change.
 *
 * ── Why a cache rather than narrower deps ─────────────────────────────────────
 *
 * The payload genuinely depends on `renderItems` (it is derived from each item's
 * spec + the selection index), so the dependency is not spurious — what is
 * spurious is the OBJECT IDENTITY changing when the derived content did not. So
 * the builder computes its payload as before and then hands it here: when the
 * previous frame produced an equivalent payload for the same key, the PREVIOUS
 * object is returned and the row's memo stays a hit.
 *
 * ── The generation, and why equality alone is not enough ──────────────────────
 *
 * A payload carries CLOSURES (context-menu actions, tool actions). Comparing them
 * is impossible — they are rebuilt every frame by construction, so a comparison
 * would make every entry a miss — and ignoring them outright is unsound: if the
 * values they close over changed, reusing the old object would leave the row
 * wired to stale handlers.
 *
 * The generation resolves that. It contains the owner and actual operation
 * callbacks captured by the closures, not the document's index/map containers.
 * Per-row captured values (including editor mode and queued controls) belong in
 * the payload comparison. A callback change clears the cache; a message update
 * merely recomputes the projection and reuses rows whose captured values did not
 * change. Depending on whole document indices here would evict every row on each
 * persisted-message update, even when the measurement cache remains a hit.
 *
 * ⚠️ Every field a row paints must stay in the comparison.
 * `vlist-row-payload-reuse.test.ts` pins both directions: a changed field must
 * yield a NEW object (otherwise the row silently keeps stale content — the same
 * class of bug as the frozen live tail), and an untouched row must yield the SAME
 * one (otherwise the regression this exists to prevent is back).
 */

/** The retained state of one builder's cache: its generation plus last frame's map. */
export interface RowPayloadReuseState<T> {
	generation: readonly unknown[];
	map: ReadonlyMap<string, T>;
}

/**
 * Shallow, order-sensitive comparison of two generations.
 *
 * Deliberately identity-based per entry: every generation member is either a
 * memoized object or a primitive, so `===` is the same test React's own dependency
 * comparison applies to them.
 */
export function sameRowPayloadGeneration(
	a: readonly unknown[] | undefined,
	b: readonly unknown[],
): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Open a frame: return the map to compare against, or undefined when the
 * generation moved (every payload must then be rebuilt).
 */
export function beginRowPayloadFrame<T>(
	state: RowPayloadReuseState<T> | null | undefined,
	generation: readonly unknown[],
): ReadonlyMap<string, T> | undefined {
	if (!state) return undefined;
	return sameRowPayloadGeneration(state.generation, generation) ? state.map : undefined;
}

/**
 * Return the previous frame's payload for `key` when it is equivalent to `next`,
 * otherwise adopt `next`.
 */
export function reuseRowPayload<T>(
	previous: ReadonlyMap<string, T> | undefined,
	key: string,
	next: T,
	isEquivalent: (previousPayload: T, nextPayload: T) => boolean,
): T {
	const prior = previous?.get(key);
	if (prior === undefined) return next;
	return isEquivalent(prior, next) ? prior : next;
}

/**
 * Publish this frame's map as what the NEXT frame compares against.
 *
 * Storing the freshly built map (rather than merging into the old one) is what
 * bounds the cache to the current document: a row that was deleted, compacted away
 * or dropped from the loaded window disappears on the next commit.
 */
export function commitRowPayloadFrame<T>(
	ref: { current: RowPayloadReuseState<T> | null },
	generation: readonly unknown[],
	map: ReadonlyMap<string, T>,
): void {
	ref.current = { generation, map };
}

/** Shallow equality for the small readonly index lists a row payload carries. */
export function sameNumberList(
	a: readonly number[] | undefined,
	b: readonly number[] | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** The action-bearing sub-objects of a payload, compared by which keys are bound. */
export function sameBoundActionKeys(
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown> | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	// Sorted so the comparison does not depend on insertion order, which the
	// builders vary by gating (`...(x ? {y} : {})`).
	aKeys.sort();
	bKeys.sort();
	for (let i = 0; i < aKeys.length; i++) {
		if (aKeys[i] !== bKeys[i]) return false;
	}
	return true;
}
