/**
 * Work that must happen AFTER `performGracefulShutdown` finished but BEFORE `process.exit`.
 *
 * The one current consumer is unattended mode, which powers the machine off once NarraFork
 * has closed cleanly. Keeping the hook list here (instead of calling the service from
 * `main.ts`) means `main.ts` stays headless of features: it runs whatever is registered and
 * nothing when nothing is.
 *
 * Keys are unique so a Bun --hot re-evaluation replaces a hook instead of stacking a second
 * copy of it — a duplicated hook here would issue the OS power-off twice.
 */

import { hotSafe } from "./hot-safe";
import { logger } from "./logger";

export type PostShutdownHook = (context: { reason: string }) => Promise<void> | void;

const hooks = hotSafe<Map<string, PostShutdownHook>>(
	"narrafork.postShutdownHooks",
	() => new Map<string, PostShutdownHook>(),
);

/** Register (or, with `null`, remove) the hook for a key. */
export function registerPostShutdownHook(key: string, hook: PostShutdownHook | null): void {
	if (!hook) {
		hooks.delete(key);
		return;
	}
	hooks.set(key, hook);
}

/**
 * Run every registered hook, bounded by a single deadline.
 *
 * Never rejects: the caller is about to `process.exit(0)` and a hook that throws or hangs
 * must not change that outcome. A timeout is logged and the sequence continues, because the
 * shutdown itself already succeeded — the hook's failure is diagnosed, not escalated.
 */
export async function runPostShutdownHooks(reason: string, timeoutMs = 10_000): Promise<void> {
	const entries = [...hooks.entries()];
	if (entries.length === 0) return;
	const deadline = Date.now() + timeoutMs;
	await Promise.all(
		entries.map(async ([key, hook]) => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				logger.warn("Post-shutdown hook skipped after deadline", { hook: key, reason });
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.resolve()
						.then(() => hook({ reason }))
						.catch((error) => {
							logger.warn("Post-shutdown hook failed", {
								hook: key,
								reason,
								error: error instanceof Error ? error.message : String(error),
							});
						}),
					new Promise<void>((resolve) => {
						timer = setTimeout(() => {
							logger.warn("Post-shutdown hook timed out", {
								hook: key,
								reason,
								timeoutMs: remaining,
							});
							resolve();
						}, remaining);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}),
	);
}

/** Test seam: drop every hook so a registered fake cannot leak into a later test. */
export function resetPostShutdownHooksForTests(): void {
	hooks.clear();
}
