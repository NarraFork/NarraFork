/**
 * Utilities for surviving Bun --hot reloads.
 *
 * When Bun hot-reloads a module, all module-level variables are re-initialised
 * while the process (and its globalThis) stays alive.  Old setInterval / fs.watch
 * callbacks still reference the previous module's closures, so naïvely re-creating
 * timers or Maps leads to duplicates and leaks.
 *
 * These helpers pin values to globalThis via `Symbol.for()` keys so they persist
 * across module re-evaluations.
 */

// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key access
const g = globalThis as any;

/**
 * Retrieve (or lazily create) a globalThis-pinned value.
 * Use for persistent state (Maps, Sets, arrays) that must survive hot reloads.
 */
export function hotSafe<T>(key: string, factory: () => T): T {
	const sym = Symbol.for(key);
	if (!g[sym]) g[sym] = factory();
	return g[sym];
}

/**
 * Replace a globalThis-pinned timer.  Clears the previous interval (if any)
 * before storing the new one.  Use for timers that must be recreated on each
 * hot reload (e.g. because the callback references the new module's state).
 *
 * Returns the new timer handle.
 */
export function hotTimer(
	key: string,
	create: () => ReturnType<typeof setInterval>,
): ReturnType<typeof setInterval> {
	const sym = Symbol.for(key);
	if (g[sym]) clearInterval(g[sym]);
	const timer = create();
	g[sym] = timer;
	return timer;
}

/**
 * Clear a globalThis-pinned timer and remove the reference.
 * Counterpart to `hotTimer` for shutdown / stop paths.
 */
export function hotTimerClear(key: string): void {
	const sym = Symbol.for(key);
	if (g[sym]) {
		clearInterval(g[sym]);
		g[sym] = undefined;
	}
}

/**
 * One-shot guard: returns `true` on the first call for a given key,
 * `false` on subsequent calls (including after hot reloads).
 * Use for `process.on("exit")` registration, event-bus listener setup, etc.
 */
export function hotOnce(key: string): boolean {
	const sym = Symbol.for(key);
	if (g[sym]) return false;
	g[sym] = true;
	return true;
}
