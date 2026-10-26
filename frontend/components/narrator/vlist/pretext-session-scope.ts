import { getToken, onTokenChange } from "@frontend/lib/api/client";

/**
 * Presentation caches are session-scoped, not authentication/authorization evidence.
 * A session token never changes during a session, so the token itself is the scope.
 */
function readScope(): string | null {
	try {
		return getToken();
	} catch {
		return null;
	}
}
let scope = readScope();
let epoch = 0;
const listeners = new Set<() => void>();
function updateScope(next: string | null) {
	if (next === scope) return;
	scope = next;
	epoch++;
	for (const listener of listeners) listener();
}
const unsubscribe = onTokenChange((token) => updateScope(token));
export function pretextSessionEpoch(): number {
	updateScope(readScope());
	return epoch;
}
export function onPretextSessionChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
