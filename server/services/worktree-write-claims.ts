/**
 * In-flight write declarations per worktree.
 *
 * A workspace tree hash covers every byte in the directory, which is what makes
 * it able to see writes no tool input describes. In a *shared* worktree that same
 * property is a liability: several narrators, their subagents, the user's terminal
 * and editor all write to one directory, so the delta between a tool's `before`
 * and `after` boundary also contains whatever landed there from elsewhere. A
 * read-only `git log` can therefore appear to have changed files.
 *
 * The missing information is intent, and it is only knowable while the tools are
 * running: Write/Edit know their target path before they execute. Recording those
 * declarations lets the shell path subtract them — a path another actor
 * *declared* it was writing in an overlapping window is provably not this call's
 * work.
 *
 * This registry is in-memory on purpose. Every concurrent session runs in the same
 * server process, so a module-level map answers the question without putting a DB
 * query on the tool-execution hot path (see the backend main-thread rules). It is
 * also required *at* hook time rather than later, because the resolved set feeds
 * `file_attributions` immediately.
 *
 * Scope note: this resolves what a call owns against *declared* neighbours only.
 * Two shell commands writing the same file declare nothing, so neither can be
 * attributed from memory — and whichever closed first would over-claim. That case
 * is deliberately left to the rollback path, which compares the persisted
 * `ownedPathsJson` of every overlapping call once all of them are final.
 *
 * ## Why nothing here may depend on every claim being closed
 *
 * A claim is opened by the pre-execution hook and closed by the post-execution
 * one, and there are real paths where the second never runs: the tool throws, the
 * turn is aborted between `tool_call` and `tool_result`, a provider error restarts
 * the turn, a re-run's after-hook is skipped because the execution metadata does
 * not name a local device. An unclosed claim that is read as "still running, so it
 * extends to now" overlaps *every* future window forever, and because the shell
 * path only ever subtracts, one leaked declaration silently makes that path
 * permanently unrevertable for other narrators. So an in-flight claim is bounded
 * by {@link IN_FLIGHT_CLAIM_MAX_AGE_MS} regardless of what the caller does, the
 * registry size is bounded unconditionally, and the call sites additionally seal
 * their claims on their own error paths. Both halves are required: the call sites
 * cannot enumerate every failure mode, and the age bound alone would leave a leak
 * live for as long as the bound.
 */
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { normalizePathForComparison } from "../lib/platform-path";

/**
 * One tool call's write window on a worktree.
 *
 * `declared` carries the three-state intent the whole mechanism rests on:
 *   - `null`  — the tool cannot enumerate its writes ahead of time (shell). Its
 *               owned set has to be derived from the tree delta.
 *   - `[]`    — it declared that it writes nothing inside this worktree (a
 *               `spec://` virtual file, a path outside the tree). Owned set empty.
 *   - `[...]` — exactly these worktree-relative paths.
 */
export interface WriteClaim {
	narratorId: string;
	toolUseId: string;
	declared: string[] | null;
	/**
	 * Whether `declared` originated from the tool's own statement of intent.
	 *
	 * Kept separate from `declared !== null` because closing narrows a declaration
	 * to what was actually written, and only a claim that *declared* something may
	 * be used to narrow a neighbour's set. Deriving one shell call's set from
	 * another's derived set is circular (see the module header).
	 */
	wasDeclared: boolean;
	/**
	 * What the call turned out to own, recorded at close.
	 *
	 * Never a subtrahend for an undeclared call: it is derived from the tree delta,
	 * so trusting it to narrow a neighbour would erase a real write. Retained
	 * because it is the honest answer to "what did this call end up touching".
	 */
	resolved: string[] | null;
	/** Epoch ms when the pre-execution boundary was captured. */
	from: number;
	/** Epoch ms when the post-execution boundary was captured; null while in flight. */
	to: number | null;
}

/**
 * How long a closed claim stays queryable.
 *
 * Closed claims still have to answer overlap questions: a shell command that
 * started before a neighbouring Edit and finished after it must still see that
 * Edit's declaration. The window only needs to outlive the longest plausible tool
 * call, not the session.
 */
const CLOSED_CLAIM_TTL_MS = 5 * 60_000;

/**
 * How long an unclosed claim is believed to still be running.
 *
 * Past this it is treated as sealed at `from + IN_FLIGHT_CLAIM_MAX_AGE_MS`, which
 * is what stops a leaked claim from overlapping every future window forever. The
 * bound has to exceed the longest tool a narrator can legitimately hold open —
 * a build or test run behind a permission prompt — so it is generous; correctness
 * for the leak case comes from the call sites sealing their own error paths, and
 * this is the backstop for the modes they cannot see.
 */
const IN_FLIGHT_CLAIM_MAX_AGE_MS = 30 * 60_000;

/** Upper bound per worktree, so a long-lived server cannot grow without limit. */
const MAX_CLAIMS_PER_WORKTREE = 512;

/** Throttle for the cap warning; at the cap, eviction runs on every tool call. */
const CAP_WARN_INTERVAL_MS = 60_000;
let lastCapWarnAt = 0;

/** worktree key → claims, insertion-ordered (oldest first) for cheap eviction. */
const claimsByWorktree = hotSafe<Map<string, Map<string, WriteClaim>>>(
	"narrafork.worktreeWriteClaims",
	() => new Map(),
);

function worktreeKey(worktreePath: string): string {
	return normalizePathForComparison(worktreePath);
}

/** The moment a claim's window ends, treating an abandoned in-flight claim as sealed. */
function claimEnd(claim: WriteClaim, now: number): number {
	if (claim.to !== null) return claim.to;
	const abandonedAt = claim.from + IN_FLIGHT_CLAIM_MAX_AGE_MS;
	return now < abandonedAt ? now : abandonedAt;
}

/** Whether a claim can no longer answer a question about any future window. */
function isExpired(claim: WriteClaim, now: number): boolean {
	return claimEnd(claim, now) < now - CLOSED_CLAIM_TTL_MS;
}

/**
 * Drop expired claims, then oldest-first while over the cap.
 *
 * The cap is enforced unconditionally, including against claims that are still in
 * flight. Exempting them would make the bound depend on every pre-execution hook
 * having a matching post-execution one, and that premise does not hold (see the
 * module header) — a server that leaks claims would then grow without limit and
 * pay an O(n) scan on every tool call. Evicting a live claim only costs precision
 * for that one call, which the post-execution hook already handles by treating a
 * missing claim as undeclared.
 */
function evict(claims: Map<string, WriteClaim>): void {
	const now = Date.now();
	for (const [toolUseId, claim] of claims) {
		if (isExpired(claim, now)) claims.delete(toolUseId);
	}
	if (claims.size <= MAX_CLAIMS_PER_WORKTREE) return;
	let droppedInFlight = 0;
	for (const [toolUseId, claim] of claims) {
		if (claims.size <= MAX_CLAIMS_PER_WORKTREE) break;
		if (claim.to === null) droppedInFlight++;
		claims.delete(toolUseId);
	}
	// Throttled: at the cap this runs on every tool call, and one line per call would
	// bury the log. The condition itself means claims are leaking, so it must be
	// visible — just not per call.
	if (droppedInFlight > 0 && Date.now() - lastCapWarnAt > CAP_WARN_INTERVAL_MS) {
		lastCapWarnAt = Date.now();
		logger.warn("Evicting in-flight worktree write claims at the registry cap", {
			droppedInFlight,
			cap: MAX_CLAIMS_PER_WORKTREE,
		});
	}
}

/**
 * Register a tool call's write window.
 *
 * Called from the pre-execution snapshot hook, so the claim is visible to any
 * neighbouring tool that starts while this one runs.
 */
export function openClaim(
	worktreePath: string,
	narratorId: string,
	toolUseId: string,
	declared: string[] | null,
	/**
	 * When the `before` state was captured, if earlier than now.
	 *
	 * A session reuses a cached tree hash as the next tool's `before`, so the span
	 * the boundaries describe can begin seconds before the tool ran. The claim has
	 * to cover that span, otherwise a neighbour's write inside the gap falls outside
	 * every overlap query and gets credited to this call.
	 */
	capturedAt?: number,
): void {
	const key = worktreeKey(worktreePath);
	let claims = claimsByWorktree.get(key);
	if (!claims) {
		claims = new Map();
		claimsByWorktree.set(key, claims);
	}
	evict(claims);
	// Re-registering the same id (a re-run) must replace the old window rather
	// than leave a stale one that still overlaps and shadows the new one.
	claims.delete(toolUseId);
	claims.set(toolUseId, {
		narratorId,
		toolUseId,
		declared,
		wasDeclared: declared !== null,
		resolved: null,
		from: capturedAt ?? Date.now(),
		to: null,
	});
}

/**
 * Close a claim, recording what it turned out to own, and report its window.
 *
 * For a *declared* call the resolved set replaces the declaration: a declared path
 * the tool did not end up touching must not keep shadowing a neighbour's write to
 * it. For an undeclared (shell) call the declaration stays null, because the
 * resolved set was derived from the tree delta and using it to narrow another
 * shell call would be circular — the failure that looks like a real write becoming
 * silently unrevertable.
 *
 * Returns null when no claim was open — a tool whose pre-execution hook never ran
 * (remote target, non-git workspace), where there is nothing to reconcile.
 */
export function closeClaim(
	worktreePath: string,
	toolUseId: string,
	resolvedPaths: string[],
): { from: number; to: number } | null {
	const claims = claimsByWorktree.get(worktreeKey(worktreePath));
	const claim = claims?.get(toolUseId);
	if (!claim) return null;
	claim.resolved = resolvedPaths;
	if (claim.wasDeclared) claim.declared = resolvedPaths;
	claim.to = Date.now();
	return { from: claim.from, to: claim.to };
}

/**
 * End a claim's window now without narrowing what it declared.
 *
 * For the error paths: the tool threw, the turn was aborted, or the post-execution
 * hook was skipped, so nothing measured what the call actually wrote. Sealing stops
 * the claim from being read as "still running" — the leak that makes a declaration
 * overlap every future window — while keeping the declaration itself, because a
 * tool that may have written its target must still shadow a neighbour inside the
 * span it really occupied. If the post-execution hook does arrive later it can
 * still close the claim normally.
 *
 * Returns false when no claim was open.
 */
export function sealClaim(worktreePath: string, toolUseId: string): boolean {
	const claims = claimsByWorktree.get(worktreeKey(worktreePath));
	const claim = claims?.get(toolUseId);
	if (!claim || claim.to !== null) return false;
	claim.to = Date.now();
	return true;
}

/**
 * Seal every in-flight claim a narrator holds on a worktree.
 *
 * Called from the loop's error/abort cleanup, which is the one place that knows a
 * turn ended without its remaining tools reporting results. Write/Edit/Bash never
 * execute eagerly, so on an interrupt their `tool_call` has been emitted and their
 * `tool_result` never will be — without this their declarations would outlive the
 * turn.
 *
 * Returns how many were sealed, for logging.
 */
export function sealNarratorClaims(worktreePath: string, narratorId: string): number {
	const claims = claimsByWorktree.get(worktreeKey(worktreePath));
	if (!claims) return 0;
	const now = Date.now();
	let sealed = 0;
	for (const claim of claims.values()) {
		if (claim.narratorId !== narratorId || claim.to !== null) continue;
		claim.to = now;
		sealed++;
	}
	return sealed;
}

/**
 * Read back an open claim's declaration and window start.
 *
 * The post-execution hook resolves the owned set from the declaration recorded by
 * the pre-execution hook rather than from a value passed between them, so the two
 * halves cannot disagree about what was declared.
 *
 * Returns null when no claim is open (evicted, or the pre-execution hook never
 * ran). Callers treat that as "undeclared", which is the conservative reading:
 * an undeclared call derives its set by subtracting foreign declarations instead
 * of claiming everything a declaration would have permitted.
 */
export function peekClaim(
	worktreePath: string,
	toolUseId: string,
): {
	declared: string[] | null;
	resolved: string[] | null;
	from: number;
	to: number | null;
} | null {
	const claims = claimsByWorktree.get(worktreeKey(worktreePath));
	const claim = claims?.get(toolUseId);
	if (!claim) return null;
	return {
		declared: claim.declared,
		resolved: claim.resolved,
		from: claim.from,
		to: claim.to,
	};
}

/**
 * Whether a claim's window overlaps `[from, to]`.
 *
 * An in-flight claim extends to now, but no further than
 * {@link IN_FLIGHT_CLAIM_MAX_AGE_MS} past its start: past that it is a leak rather
 * than a running tool, and treating it as open would let it overlap every window
 * for the rest of the process's life.
 */
function overlaps(claim: WriteClaim, from: number, to: number): boolean {
	return claim.from <= to && claimEnd(claim, Date.now()) >= from;
}

/**
 * Paths other actors declared they were writing during `[from, to]`.
 *
 * This is the subtrahend for the shell path: a tree delta minus everything a
 * neighbour explicitly claimed. Only *declared* sets are usable here — deriving
 * one shell call's set from another's would be circular, so a claim that never
 * declared anything contributes nothing even after it closes with a resolved set.
 *
 * Claims from the same narrator are not foreign. They are that narrator's own
 * earlier work, which a rollback of this window legitimately includes; treating
 * them as foreign would leave a narrator unable to undo its own writes. Subagents
 * have their own narrator ids, so their declarations *are* foreign here — which is
 * correct, and the rollback path reports subagent overlap separately.
 */
export function foreignDeclaredPaths(
	worktreePath: string,
	narratorId: string,
	toolUseId: string,
	from: number,
	to: number,
): Set<string> {
	const claims = claimsByWorktree.get(worktreeKey(worktreePath));
	const foreign = new Set<string>();
	if (!claims) return foreign;
	for (const claim of claims.values()) {
		if (claim.toolUseId === toolUseId) continue;
		if (claim.narratorId === narratorId) continue;
		if (!claim.wasDeclared) continue;
		if (!claim.declared || claim.declared.length === 0) continue;
		if (!overlaps(claim, from, to)) continue;
		for (const path of claim.declared) foreign.add(path);
	}
	return foreign;
}

/** Forget every claim for a worktree. Used when a worktree is destroyed, and by tests. */
export function clearClaims(worktreePath: string): void {
	claimsByWorktree.delete(worktreeKey(worktreePath));
}

/** Number of claims retained for a worktree. Exported so tests can pin the bound. */
export function claimCount(worktreePath: string): number {
	return claimsByWorktree.get(worktreeKey(worktreePath))?.size ?? 0;
}
