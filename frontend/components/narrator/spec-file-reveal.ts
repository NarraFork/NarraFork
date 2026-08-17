/**
 * spec-file-reveal.ts — reveal one Dynamic Spec file from elsewhere in the chat.
 *
 * ## The problem this solves
 *
 * An injection bubble reporting "you saved spec://index.md" should be able to open that
 * file. But the clicking row and the Spec panel have no shared React parent: on the
 * dock surface the panel is a dockview SIBLING of chat, and it usually does not exist
 * yet at click time (the click is what opens it).
 *
 * The established fix for the sibling half is `NarratorDockContext`'s register/call
 * bridges, and for the DOM-descendant half it is the bubbling `spec-open-tasks`
 * CustomEvent. Neither works here: a dock panel is not a DOM descendant of the chat
 * viewport, so an event cannot reach it, and the dock context cannot carry the second
 * step because the panel registers itself only after it mounts.
 *
 * So this is a tiny module-level registry keyed by narrator id. It is deliberately NOT
 * a React context: the whole point is to be reachable from a panel that mounted as a
 * result of the call, which no provider above the caller can express.
 *
 * ## Why the retry, and why it is bounded
 *
 * `revealSpecFile` is normally called right after asking the host to open the panel, so
 * the selector is not registered yet — the panel mounts a frame or two later. A single
 * synchronous attempt would silently do nothing on the common path.
 *
 * The retry is bounded (and short) because the honest failure mode is "this surface has
 * no Spec panel", and retrying forever would leave a timer running for a click that can
 * never land. Giving up quietly matches the surrounding rule: a row that cannot reach
 * its destination does nothing rather than reporting an error the reader cannot act on.
 */

/** Per-narrator file selector, published by a mounted SpecPanel. */
const selectors = new Map<string, (uri: string) => void>();

/** How long to keep trying while a just-opened panel mounts. */
const REVEAL_TIMEOUT_MS = 2_000;
const REVEAL_POLL_MS = 50;

/**
 * Publish this panel's selector. Returns its unregister function.
 *
 * Registration is last-write-wins per narrator, and unregistering only clears the entry
 * when it is still this panel's — a remount ordered as (new registers, old unregisters)
 * must not leave the map empty.
 */
export function registerSpecFileSelector(
	narratorId: string,
	select: (uri: string) => void,
): () => void {
	selectors.set(narratorId, select);
	return () => {
		if (selectors.get(narratorId) === select) selectors.delete(narratorId);
	};
}

/**
 * Ask this narrator's Spec panel to select `uri`, waiting briefly for it to mount.
 *
 * Returns a cancel function so a caller that unmounts can stop the pending attempt
 * rather than selecting a file in a panel the reader has since navigated away from.
 */
export function revealSpecFile(narratorId: string, uri: string): () => void {
	const immediate = selectors.get(narratorId);
	if (immediate) {
		immediate(uri);
		return () => {};
	}
	const deadline = Date.now() + REVEAL_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const attempt = () => {
		const select = selectors.get(narratorId);
		if (select) {
			select(uri);
			return;
		}
		if (Date.now() >= deadline) return;
		timer = setTimeout(attempt, REVEAL_POLL_MS);
	};
	timer = setTimeout(attempt, REVEAL_POLL_MS);
	return () => {
		if (timer) clearTimeout(timer);
	};
}

/** Test seam: drop all registrations. */
export function __resetSpecFileSelectors(): void {
	selectors.clear();
}
