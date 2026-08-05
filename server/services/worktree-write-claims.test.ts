/**
 * The write-declaration registry, tested on its own.
 *
 * Its whole job is answering "was this path someone else's during my window", and
 * every one of those words is load-bearing: getting the actor or the window wrong
 * makes a rollback either discard a neighbour's work or refuse to undo its own.
 * These cases pin the boundaries directly, because through the snapshot hooks they
 * are only observable as a changed file list.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	claimCount,
	clearClaims,
	closeClaim,
	foreignDeclaredPaths,
	openClaim,
	peekClaim,
	sealClaim,
	sealNarratorClaims,
} from "./worktree-write-claims";

const WORKTREE = "/tmp/nf-claims-test-worktree";

afterEach(() => {
	clearClaims(WORKTREE);
});

/** The overlap query as the post-execution hook issues it: from claim start to now. */
function foreignFor(narratorId: string, toolUseId: string): string[] {
	const claim = peekClaim(WORKTREE, toolUseId);
	return [
		...foreignDeclaredPaths(WORKTREE, narratorId, toolUseId, claim?.from ?? Date.now(), Date.now()),
	].sort();
}

describe("worktree write claims", () => {
	test("a concurrent narrator's declared path is foreign", () => {
		openClaim(WORKTREE, "shell-narrator", "shell-1", null);
		openClaim(WORKTREE, "other-narrator", "edit-1", ["theirs.txt"]);
		expect(foreignFor("shell-narrator", "shell-1")).toEqual(["theirs.txt"]);
	});

	test("the narrator's own other calls are not foreign", () => {
		// A narrator has to be able to undo its own earlier writes; treating them as
		// someone else's would make its own history unrevertable.
		openClaim(WORKTREE, "mine", "shell-1", null);
		openClaim(WORKTREE, "mine", "edit-1", ["mine.txt"]);
		expect(foreignFor("mine", "shell-1")).toEqual([]);
	});

	test("a claim's own declaration is not foreign to itself", () => {
		openClaim(WORKTREE, "mine", "edit-1", ["mine.txt"]);
		expect(foreignFor("mine", "edit-1")).toEqual([]);
	});

	test("an undeclared neighbour contributes nothing to subtract", () => {
		// Two shell commands cannot separate each other from memory: neither declared
		// anything. Subtracting a derived set from another derived set would be
		// circular, so this returns nothing and the ambiguity is resolved later from
		// the attribution timeline.
		openClaim(WORKTREE, "mine", "shell-1", null);
		openClaim(WORKTREE, "other", "shell-2", null);
		expect(foreignFor("mine", "shell-1")).toEqual([]);
	});

	test("a neighbour that closed before the window began is not foreign", () => {
		openClaim(WORKTREE, "other", "edit-1", ["theirs.txt"]);
		closeClaim(WORKTREE, "edit-1", ["theirs.txt"]);
		// Opened strictly after the neighbour finished, so a later write to the same
		// file is genuinely this call's and must stay revertable.
		const from = Date.now() + 1_000;
		openClaim(WORKTREE, "mine", "shell-1", null, from);
		expect([...foreignDeclaredPaths(WORKTREE, "mine", "shell-1", from, from + 10)]).toEqual([]);
	});

	test("a neighbour still in flight overlaps a window that started earlier", () => {
		// An in-flight claim has no end, so it must extend to now rather than be read
		// as a zero-length window.
		openClaim(WORKTREE, "mine", "shell-1", null, Date.now() - 5_000);
		openClaim(WORKTREE, "other", "edit-1", ["theirs.txt"]);
		expect(foreignFor("mine", "shell-1")).toEqual(["theirs.txt"]);
	});

	test("a claim window can start before the claim was registered", () => {
		// Sessions reuse a cached tree hash as the next tool's `before`, so the span the
		// boundaries describe begins when that hash was captured. A neighbour writing in
		// that gap is inside the span and must be visible.
		const captured = Date.now() - 10_000;
		openClaim(WORKTREE, "other", "edit-1", ["theirs.txt"]);
		closeClaim(WORKTREE, "edit-1", ["theirs.txt"]);
		openClaim(WORKTREE, "mine", "shell-1", null, captured);
		expect(peekClaim(WORKTREE, "shell-1")?.from).toBe(captured);
		expect(foreignFor("mine", "shell-1")).toEqual(["theirs.txt"]);
	});

	test("closing replaces the declaration with what was actually written", () => {
		// A declared path the tool did not touch must stop shadowing a neighbour's
		// write to it, or that write would be silently unattributable.
		openClaim(WORKTREE, "other", "edit-1", ["declared-but-untouched.txt"]);
		closeClaim(WORKTREE, "edit-1", []);
		openClaim(WORKTREE, "mine", "shell-1", null, Date.now() - 1_000);
		expect(foreignFor("mine", "shell-1")).toEqual([]);
	});

	test("closing reports the window and is a no-op for an unknown call", () => {
		openClaim(WORKTREE, "mine", "edit-1", ["a.txt"]);
		const window = closeClaim(WORKTREE, "edit-1", ["a.txt"]);
		expect(window?.to).toBeGreaterThanOrEqual(window?.from ?? 0);
		// A tool whose pre-execution hook never ran (remote target, non-git workspace)
		// has nothing to reconcile.
		expect(closeClaim(WORKTREE, "never-opened", [])).toBeNull();
	});

	test("re-opening the same call replaces its window instead of stacking one", () => {
		// A re-run reuses the toolUseId. A leftover window would still overlap and
		// shadow the new run's own writes.
		openClaim(WORKTREE, "mine", "edit-1", ["first.txt"]);
		openClaim(WORKTREE, "mine", "edit-1", ["second.txt"]);
		expect(peekClaim(WORKTREE, "edit-1")?.declared).toEqual(["second.txt"]);
	});

	test("an empty declaration is distinct from no declaration", () => {
		// `[]` means "declared, writes nothing here" (a spec:// URI); null means "cannot
		// declare" (a shell command). The two take different attribution paths.
		openClaim(WORKTREE, "mine", "spec-write", []);
		openClaim(WORKTREE, "mine", "shell", null);
		expect(peekClaim(WORKTREE, "spec-write")?.declared).toEqual([]);
		expect(peekClaim(WORKTREE, "shell")?.declared).toBeNull();
	});

	test("claims are scoped per worktree", () => {
		const other = `${WORKTREE}-second`;
		openClaim(WORKTREE, "mine", "shell-1", null);
		openClaim(other, "other", "edit-1", ["elsewhere.txt"]);
		try {
			expect(foreignFor("mine", "shell-1")).toEqual([]);
		} finally {
			clearClaims(other);
		}
	});

	test("path comparison ignores trailing separators", () => {
		// `/a/b` and `/a/b/` are one directory; keyed literally they would be two
		// registries, and neighbours would stop being visible to each other.
		openClaim(WORKTREE, "mine", "shell-1", null);
		openClaim(`${WORKTREE}/`, "other", "edit-1", ["theirs.txt"]);
		expect(foreignFor("mine", "shell-1")).toEqual(["theirs.txt"]);
	});

	test("clearing forgets a worktree's claims", () => {
		openClaim(WORKTREE, "mine", "edit-1", ["a.txt"]);
		clearClaims(WORKTREE);
		expect(peekClaim(WORKTREE, "edit-1")).toBeNull();
	});

	test("closed claims are evicted once the registry exceeds its cap", () => {
		// The map must not grow without bound in a long-running server.
		for (let index = 0; index < 700; index++) {
			const id = `closed-${index}`;
			openClaim(WORKTREE, "mine", id, [`file-${index}.txt`]);
			closeClaim(WORKTREE, id, [`file-${index}.txt`]);
		}
		// Oldest first, so the earliest closed claims are the ones dropped.
		expect(peekClaim(WORKTREE, "closed-0")).toBeNull();
		expect(peekClaim(WORKTREE, "closed-699")).not.toBeNull();
	});

	test("a claim past its TTL is evicted rather than kept forever", () => {
		// Every claim in the cap test above was created in the same millisecond, so the
		// TTL branch never ran there — the cap was doing all the work. A claim whose
		// whole window (start plus the in-flight age bound) predates the TTL must be
		// dropped by the eviction pass, which runs on every openClaim.
		const ancient = Date.now() - 90 * 60_000;
		openClaim(WORKTREE, "gone", "ancient", ["theirs.txt"], ancient);
		expect(peekClaim(WORKTREE, "ancient")).not.toBeNull();

		openClaim(WORKTREE, "mine", "trigger-eviction", null);
		expect(peekClaim(WORKTREE, "ancient")).toBeNull();
		expect(foreignFor("mine", "trigger-eviction")).toEqual([]);
	});

	test("the registry stays bounded even when every claim is in flight", () => {
		// The cap must not depend on each pre-execution hook having a matching
		// post-execution one: an aborted turn, a throwing tool, or a re-run on a remote
		// target all leave a claim open. Exempting in-flight claims from eviction made
		// the map unbounded and put an O(n) scan on every tool call.
		for (let index = 0; index < 700; index++) {
			openClaim(WORKTREE, "mine", `in-flight-${index}`, [`file-${index}.txt`]);
		}
		expect(claimCount(WORKTREE)).toBeLessThanOrEqual(513);
	});

	test("an abandoned in-flight claim stops overlapping every later window", () => {
		// The leak that matters: an unclosed claim read as "extends to now" overlaps
		// forever, and because the shell path only subtracts, one leaked declaration
		// makes that path permanently unrevertable for every other narrator here.
		const twoHoursAgo = Date.now() - 2 * 60 * 60_000;
		openClaim(WORKTREE, "gone", "leaked", ["victim.txt"], twoHoursAgo);

		// A shell command starting now must not have `victim.txt` subtracted from it.
		openClaim(WORKTREE, "mine", "shell-now", null);
		expect(foreignFor("mine", "shell-now")).toEqual([]);
	});

	test("a recently opened in-flight claim is still foreign", () => {
		// The age bound must not break the case it exists to protect: a genuinely
		// running neighbour has to keep shadowing a concurrent shell command.
		openClaim(WORKTREE, "other", "running-edit", ["theirs.txt"]);
		openClaim(WORKTREE, "mine", "shell-now", null);
		expect(foreignFor("mine", "shell-now")).toEqual(["theirs.txt"]);
	});

	test("sealing ends a window without discarding what it declared", () => {
		// The error path: the tool threw or the turn was aborted, so nothing measured
		// what it wrote. It may well have written its declared target before failing, so
		// a neighbour inside the span it really occupied must still see the declaration —
		// only the window's end is pinned.
		openClaim(WORKTREE, "other", "threw", ["maybe-written.txt"], Date.now() - 1_000);
		expect(sealClaim(WORKTREE, "threw")).toBe(true);
		const sealed = peekClaim(WORKTREE, "threw");
		expect(sealed?.declared).toEqual(["maybe-written.txt"]);
		expect(sealed?.to).not.toBeNull();
		// Sealing twice is a no-op, and an unknown call reports nothing to seal.
		expect(sealClaim(WORKTREE, "threw")).toBe(false);
		expect(sealClaim(WORKTREE, "never-opened")).toBe(false);

		// A shell window that overlaps the sealed span still subtracts it.
		openClaim(WORKTREE, "mine", "shell-1", null, Date.now() - 2_000);
		expect(foreignFor("mine", "shell-1")).toEqual(["maybe-written.txt"]);
	});

	test("sealing a narrator's claims leaves other narrators' in flight", () => {
		// The turn-level cleanup: an abort ends one narrator's tools, not the whole
		// worktree's. Sealing a neighbour's running claim would make its concurrent
		// write attributable to someone else.
		openClaim(WORKTREE, "aborted", "a-1", ["a.txt"]);
		openClaim(WORKTREE, "aborted", "a-2", null);
		openClaim(WORKTREE, "other", "b-1", ["b.txt"]);

		expect(sealNarratorClaims(WORKTREE, "aborted")).toBe(2);
		expect(peekClaim(WORKTREE, "a-1")?.to).not.toBeNull();
		expect(peekClaim(WORKTREE, "a-2")?.to).not.toBeNull();
		expect(peekClaim(WORKTREE, "b-1")?.to).toBeNull();
		// Already sealed, so a second pass finds nothing.
		expect(sealNarratorClaims(WORKTREE, "aborted")).toBe(0);
		expect(sealNarratorClaims(WORKTREE, "never-ran")).toBe(0);
	});

	test("a closed shell claim's derived set is never used to narrow a neighbour", () => {
		// The circularity the module header rules out. A shell command's resolved set is
		// derived from the tree delta, so treating it as a declaration lets Bash A
		// "declare" a file it merely observed, and an overlapping Bash B's real write to
		// that file is subtracted away — silently unrevertable.
		openClaim(WORKTREE, "other", "shell-a", null, Date.now() - 2_000);
		closeClaim(WORKTREE, "shell-a", ["built.txt"]);
		// Closed but still inside the TTL, so it does participate in overlap queries —
		// which is exactly the window the previous test suite never covered.
		const closed = peekClaim(WORKTREE, "shell-a");
		expect(closed).not.toBeNull();
		expect(closed?.to).not.toBeNull();
		// The resolved set is still recorded; it just is not a declaration.
		expect(closed?.resolved).toEqual(["built.txt"]);
		expect(closed?.declared).toBeNull();

		openClaim(WORKTREE, "mine", "shell-b", null, Date.now() - 1_000);
		expect(foreignFor("mine", "shell-b")).toEqual([]);
	});

	test("a closed declared claim keeps narrowing, but only to what it wrote", () => {
		// The counterpart: a Write/Edit *did* declare, so its closed set is a real
		// declaration and must still shadow an overlapping shell command.
		openClaim(WORKTREE, "other", "edit-1", ["declared.txt", "untouched.txt"], Date.now() - 2_000);
		closeClaim(WORKTREE, "edit-1", ["declared.txt"]);
		openClaim(WORKTREE, "mine", "shell-1", null, Date.now() - 1_000);
		// `untouched.txt` was declared but never written, so it stops shadowing.
		expect(foreignFor("mine", "shell-1")).toEqual(["declared.txt"]);
	});
});
