/**
 * Text to add to a session's composer from somewhere else in the tab ("discuss this page in a
 * session" puts a link to the page there). The session may not be open yet: its panel is being
 * added, or the phone is navigating to it. So a request waits here until that session's
 * composer is ready (its draft loaded, so the draft cannot overwrite the text) and then appends
 * it; a composer already listening gets it at once.
 *
 * In memory and bounded: a few requests per session, a few sessions, two minutes each. Nothing
 * is persisted; a request nobody picks up is dropped.
 */

const TTL_MS = 2 * 60 * 1000;
const MAX_PER_SESSION = 4;
const MAX_SESSIONS = 16;
const MAX_TEXT = 4000;
/** Composers of one session listening at once (the same session open in a few places). */
const MAX_LISTENERS = 8;

type Listener = (text: string) => void;

const pending = new Map<string, Array<{ text: string; at: number }>>();
/** Per session, the composers listening, oldest first; the newest one gets the text. */
const listeners = new Map<string, Listener[]>();

function prune(now: number): void {
	for (const [narratorId, list] of pending) {
		const live = list.filter((item) => now - item.at < TTL_MS);
		if (live.length === 0) pending.delete(narratorId);
		else if (live.length !== list.length) pending.set(narratorId, live);
	}
}

/** Append `text` to the session's composer now, or once it is ready. */
export function requestComposerAppend(narratorId: string, text: string): void {
	const value = text.slice(0, MAX_TEXT);
	if (!narratorId || !value) return;
	const listener = listeners.get(narratorId)?.at(-1);
	if (listener) {
		listener(value);
		return;
	}
	const now = Date.now();
	prune(now);
	const list = pending.get(narratorId) ?? [];
	list.push({ text: value, at: now });
	pending.delete(narratorId);
	pending.set(narratorId, list.slice(-MAX_PER_SESSION));
	while (pending.size > MAX_SESSIONS) {
		const oldest = pending.keys().next().value;
		if (oldest === undefined) break;
		pending.delete(oldest);
	}
}

/**
 * Receive the session's appends: the waiting ones at once, later ones as they come. One composer
 * per session gets the text, not every copy: the most recent listener still mounted, so when the
 * newest copy of a session's composer goes away an older one takes over.
 */
export function listenComposerAppend(narratorId: string, listener: Listener): () => void {
	const stack = (listeners.get(narratorId) ?? []).filter((l) => l !== listener);
	stack.push(listener);
	listeners.set(narratorId, stack.slice(-MAX_LISTENERS));
	prune(Date.now());
	const waiting = pending.get(narratorId);
	pending.delete(narratorId);
	for (const item of waiting ?? []) listener(item.text);
	return () => {
		const remaining = (listeners.get(narratorId) ?? []).filter((l) => l !== listener);
		if (remaining.length > 0) listeners.set(narratorId, remaining);
		else listeners.delete(narratorId);
	};
}

/** Tests: forget everything. */
export function resetComposerAppendsForTest(): void {
	pending.clear();
	listeners.clear();
}
