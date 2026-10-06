import { settings } from "@server/lib/settings";
import type { ExecutionTargetContext } from "./types";

// Leave room for other device work; neither a large Bash nor both rule lists may fan out
// into one metadata RPC per path. The device transport still owns its global admission limit.
const PATH_IDENTITY_CONCURRENCY = 4;

/** Resolve a batch atomically: deduplicate before dispatch, cancel and drain on any failure. */
export async function resolveCanonicalPaths(
	paths: readonly string[],
	context: ExecutionTargetContext,
	generationLabel: string,
	signal?: AbortSignal,
): Promise<string[]> {
	signal?.throwIfAborted();
	const deviceCap = settings.devices?.maxConcurrentRpcPerDevice;
	// Match the transport's positive finite / integer normalization. Its fallback cap
	// exceeds our batch budget, so malformed or absent configuration still uses four.
	const concurrency =
		context.backend.kind === "remote" &&
		typeof deviceCap === "number" &&
		Number.isFinite(deviceCap) &&
		deviceCap > 0
			? Math.min(PATH_IDENTITY_CONCURRENCY, Math.max(1, Math.floor(deviceCap)))
			: PATH_IDENTITY_CONCURRENCY;
	const unique: string[] = [];
	const byIdentity = new Map<string, number>();
	const indexes = paths.map((path) => {
		// Use the existing target lexical grammar, not host paths or inferred symlink
		// equivalence. Every distinct lexical identity still needs a backend probe.
		const absolute = context.paths.resolve(context.target.cwd, path);
		const key = context.paths.identityKey(absolute);
		let index = byIdentity.get(key);
		if (index === undefined) {
			index = unique.length;
			byIdentity.set(key, index);
			unique.push(absolute);
		}
		return index;
	});

	const batch = new AbortController();
	const abort = () => batch.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const canonical: string[] = new Array(unique.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (!batch.signal.aborted) {
			const index = next++;
			if (index >= unique.length) return;
			try {
				const identity = await context.backend.resolvePathIdentity(unique[index], {
					signal: batch.signal,
				});
				if (identity.runtimeGeneration !== context.target.runtimeGeneration) {
					throw new Error(
						`${generationLabel} generation drifted: expected ${context.target.runtimeGeneration}, ` +
							`got ${identity.runtimeGeneration}.`,
					);
				}
				canonical[index] = identity.canonicalPath;
			} catch (error) {
				// Preserve the first error, prevent new work, and reclaim every in-flight RPC.
				batch.abort(error);
			}
		}
	}
	try {
		await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
		batch.signal.throwIfAborted();
		return indexes.map((index) => canonical[index]);
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
