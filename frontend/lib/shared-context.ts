/**
 * React contexts that survive a module being evaluated more than once.
 *
 * `createContext()` mints a BRAND NEW context object on every module evaluation,
 * and React matches providers to consumers by that object's identity. Normally a
 * module is evaluated once, so the identity is stable — but two situations break
 * that assumption:
 *
 *  1. **Vite dev / Fast Refresh.** An updated module is served under a fresh
 *     `?t=` query, which is a different URL and therefore a separate module
 *     instance. Code loaded LATER (a lazy route chunk, a Dockview panel mounted
 *     on demand) imports the new instance, while an ancestor that was never part
 *     of the update — `main.tsx` and the providers it mounted — keeps holding the
 *     old one. Provider and consumer then reference two different context
 *     objects, so the consumer reads the default value.
 *  2. **Chunk duplication in a production build.** A module small enough to fall
 *     below the shared-chunk thresholds can be inlined into several chunks; each
 *     copy runs its own `createContext()`.
 *
 * Both surface identically: a consumer inside a lazily-mounted subtree sees
 * `null` and throws "useXxx must be used within XxxProvider", even though the
 * provider is mounted right there in the tree.
 *
 * Keying the context by a STRING in a global registry removes identity from the
 * module instance: every copy of the module resolves the same context object, so
 * provider and consumer always agree. Use this for contexts whose provider lives
 * in the app shell while consumers are reached through lazy chunks.
 */

import { createContext } from "react";

/**
 * `Symbol.for` is itself a cross-realm/cross-copy registry, so the map is found
 * again even by a duplicate of THIS module.
 */
const REGISTRY_KEY = Symbol.for("narrafork.shared-react-contexts");

type SharedContextRegistry = Map<string, unknown>;

function registry(): SharedContextRegistry {
	const store = globalThis as typeof globalThis & {
		[REGISTRY_KEY]?: SharedContextRegistry;
	};
	let existing = store[REGISTRY_KEY];
	if (!existing) {
		existing = new Map<string, unknown>();
		store[REGISTRY_KEY] = existing;
	}
	return existing;
}

/**
 * Get (or create) the context registered under `key`.
 *
 * `key` must be globally unique and STABLE across releases — it is the identity.
 * `defaultValue` is only used the first time a key is seen; later callers get the
 * already-registered context, which is the entire point.
 */
export function createSharedContext<T>(key: string, defaultValue: T): React.Context<T> {
	const contexts = registry();
	const existing = contexts.get(key);
	if (existing) return existing as React.Context<T>;
	const created = createContext<T>(defaultValue);
	contexts.set(key, created);
	return created;
}
