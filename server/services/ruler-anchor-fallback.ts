/**
 * Where to draw a chapter whose start commit is no longer on the trunk.
 *
 * The Ruler positions a chapter at the commit it forked from. That works until the
 * trunk's history is rewritten under it — a rebase, a squash-merge, an amend — after
 * which the chapter's `startCommitSha` names a commit that still exists in the
 * repository but is not reachable from `main` anymore. It gets no tick, no position, and
 * the view previously dropped it while telling the user to "open it from the story
 * network view instead" — advice that does not work, because that view anchors on the
 * same sha.
 *
 * The fork point is still locatable: `merge-base <startCommitSha> <branch>` is the
 * newest trunk commit the chapter's history and the trunk agree on. Drawing there is off
 * by the rewrite, which is the honest answer — it is where the work actually diverged.
 *
 * Note the second, benign case this also answers. When the start commit IS reachable
 * from the branch but simply has not been paged in yet, `merge-base` returns that same
 * sha. The caller can therefore tell "history was rewritten" (fallback differs from the
 * start commit) from "just not loaded yet" (fallback equals it) without a second query,
 * and the UI needs exactly that distinction: only the second case is fixed by loading
 * more commits.
 */

import { logger } from "../lib/logger";
import { gitService } from "./git-service";

/**
 * Hard ceiling on `merge-base` spawns per request.
 *
 * Each lookup is a subprocess, and this runs on the request path of a view that pages,
 * so an unbounded loop over chapters would multiply per page fetch. Chapters that fall
 * past the cap keep the old behaviour (reported as unplaceable) rather than delaying the
 * response — worst case is the message the user already sees.
 */
export const MAX_ANCHOR_FALLBACK_LOOKUPS = 25;

/** Concurrent `merge-base` spawns. Matches the graph route's refresh fan-out. */
const LOOKUP_CONCURRENCY = 4;

/**
 * How long a resolved fallback stays cached.
 *
 * Short on purpose: the answer depends on the branch's current shape, so a commit
 * landing on trunk must be able to change it. Long enough that scrolling the timeline —
 * which refetches this endpoint per page and asks about the same handful of shas every
 * time — spawns git once rather than once per page.
 */
const CACHE_TTL_MS = 60_000;

/** Bound on the cache itself, so a long-lived server cannot accumulate entries. */
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
	sha: string | null;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(gitPath: string, branch: string, sha: string): string {
	return `${gitPath}\u0000${branch}\u0000${sha}`;
}

function readCache(key: string, now: number): CacheEntry | undefined {
	const hit = cache.get(key);
	if (!hit) return undefined;
	if (hit.expiresAt <= now) {
		cache.delete(key);
		return undefined;
	}
	return hit;
}

function writeCache(key: string, sha: string | null, now: number): void {
	if (cache.size >= MAX_CACHE_ENTRIES) {
		// Oldest insertion first — Map preserves insertion order, and every entry has the
		// same TTL, so the first key is also the soonest to expire.
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(key, { sha, expiresAt: now + CACHE_TTL_MS });
}

/** Test seam: the cache is process-wide, and a stale entry would leak between cases. */
export function clearAnchorFallbackCache(): void {
	cache.clear();
}

/** Outcome of one resolution round, including what it cost. */
export interface AnchorFallbackResult {
	/** Trunk commit per sha. Unresolvable shas are absent — see the function doc. */
	resolved: Map<string, string>;
	/**
	 * How many `merge-base` subprocesses this round actually spawned.
	 *
	 * Cache hits are free and therefore not counted: the budget exists to bound
	 * subprocess spawns per request, not answers per request. A caller that resolves in
	 * several rounds subtracts this from the budget it passes to the next one.
	 */
	spent: number;
}

/**
 * Resolve each sha to the trunk commit a chapter starting there should be drawn at.
 *
 * Shas that cannot be resolved — deleted objects, a branch that does not exist, git
 * failing — are simply absent from the result. That is the same "no position" the caller
 * already handles, and guessing a position would move a chapter to a commit it has
 * nothing to do with.
 *
 * `budget` caps the spawns THIS call may make, defaulting to the whole per-request
 * allowance. It is a parameter rather than a constant because a caller that has to ask
 * in priority rounds (see the Ruler endpoint: every chapter's own start commit first,
 * ancestors only afterwards) must be able to spend the remainder of one allowance across
 * those rounds. Without it, the first round would silently get a fresh full budget and
 * a request could spawn a multiple of the cap.
 */
export async function resolveAnchorFallbacks(
	gitPath: string,
	branch: string,
	shas: string[],
	{ budget = MAX_ANCHOR_FALLBACK_LOOKUPS }: { budget?: number } = {},
): Promise<AnchorFallbackResult> {
	const resolved = new Map<string, string>();
	if (shas.length === 0) return { resolved, spent: 0 };

	// One timestamp for the whole batch, used for BOTH the expiry check and the entries
	// this batch writes. Reading with the batch's `now` while writing with each lookup's
	// own `Date.now()` made a TTL that drifted by however long the batch ran, so two
	// answers obtained in the same request could expire seconds apart.
	const now = Date.now();
	const pending: string[] = [];
	for (const sha of new Set(shas)) {
		if (!sha) continue;
		const hit = readCache(cacheKey(gitPath, branch, sha), now);
		if (hit) {
			if (hit.sha) resolved.set(sha, hit.sha);
			continue;
		}
		pending.push(sha);
	}

	const budgeted = pending.slice(0, Math.max(0, budget));
	if (budgeted.length < pending.length) {
		logger.debug("Anchor fallback lookups hit their per-request budget", {
			gitPath,
			branch,
			requested: pending.length,
			resolved: budgeted.length,
			budget,
		});
	}

	for (let i = 0; i < budgeted.length; i += LOOKUP_CONCURRENCY) {
		const batch = budgeted.slice(i, i + LOOKUP_CONCURRENCY);
		await Promise.all(
			batch.map(async (sha) => {
				let base: string | null = null;
				try {
					const result = await gitService.getMergeBase(gitPath, sha, branch, { silent: true });
					base = result.trim() || null;
				} catch {
					// Unrelated histories, a missing object, a branch that is gone. All mean the
					// same thing here: there is no trunk commit to draw this chapter at.
					base = null;
				}
				writeCache(cacheKey(gitPath, branch, sha), base, now);
				if (base) resolved.set(sha, base);
			}),
		);
	}

	// Every budgeted sha was a cache miss, so each one spawned exactly one lookup —
	// including the ones that resolved to null, which cost the same subprocess.
	return { resolved, spent: budgeted.length };
}
