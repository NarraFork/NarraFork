/**
 * Placing a chapter whose start commit the trunk no longer contains.
 *
 * Run against real repositories rather than a mocked git, because the whole question is
 * what `merge-base` answers in three situations that look alike from the database's point
 * of view: the commit is an ancestor of the branch, the commit was rewritten off the
 * branch, and the commit has no relationship to the branch at all. Only git can
 * distinguish them, so a mock would be asserting the assumption instead of the behaviour.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeSpawn } from "../lib/spawn";
import {
	clearAnchorFallbackCache,
	MAX_ANCHOR_FALLBACK_LOOKUPS,
	resolveAnchorFallbacks,
} from "./ruler-anchor-fallback";

const tempDirs: string[] = [];

afterEach(() => {
	clearAnchorFallbackCache();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

async function commit(repo: string, file: string, body: string, message: string): Promise<string> {
	writeFileSync(join(repo, file), body);
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-m", message]);
	return git(repo, ["rev-parse", "HEAD"]);
}

async function makeRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "nf-anchor-fallback-"));
	tempDirs.push(dir);
	await git(dir, ["init", "-b", "main"]);
	await git(dir, ["config", "user.email", "test@narrafork.local"]);
	await git(dir, ["config", "user.name", "Anchor Test"]);
	await git(dir, ["config", "commit.gpgsign", "false"]);
	return dir;
}

describe("resolveAnchorFallbacks", () => {
	test("returns a commit that is still on the branch unchanged", async () => {
		// The "just not paged in yet" case. Answering with the commit itself is what lets
		// the client tell it apart from a rewrite without a second query, so the identity
		// here is load-bearing rather than incidental.
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");
		await commit(repo, "a.txt", "2\n", "later");

		const { resolved } = await resolveAnchorFallbacks(repo, "main", [base]);
		expect(resolved.get(base)).toBe(base);
	});

	test("returns the fork point for a commit a rebase moved off the branch", async () => {
		// The reported bug: the chapter's start commit exists, is not reachable from main,
		// and had no position at all. `merge-base` names where the work actually diverged.
		const repo = await makeRepo();
		const forkPoint = await commit(repo, "a.txt", "1\n", "fork point");

		await git(repo, ["checkout", "-b", "side"]);
		const sideStart = await commit(repo, "b.txt", "side\n", "side work");

		await git(repo, ["checkout", "main"]);
		await commit(repo, "a.txt", "2\n", "trunk moved on");

		const { resolved } = await resolveAnchorFallbacks(repo, "main", [sideStart]);
		expect(resolved.get(sideStart)).toBe(forkPoint);
		// The point of the whole exercise: the answer is NOT the original commit, which is
		// how the caller knows the position is approximate.
		expect(resolved.get(sideStart)).not.toBe(sideStart);
	});

	test("omits a commit with no shared history rather than guessing a position", async () => {
		// An unrelated root (an imported orphan branch) has no merge base. Inventing one
		// would drop the card onto a commit it has nothing to do with, which is worse than
		// the "cannot place this" message the caller falls back to.
		const repo = await makeRepo();
		await commit(repo, "a.txt", "1\n", "main root");

		await git(repo, ["checkout", "--orphan", "orphan"]);
		await git(repo, ["rm", "-rf", "--cached", "."]);
		const orphanHead = await commit(repo, "c.txt", "orphan\n", "orphan root");
		await git(repo, ["checkout", "main"]);

		const { resolved } = await resolveAnchorFallbacks(repo, "main", [orphanHead]);
		expect(resolved.has(orphanHead)).toBe(false);
	});

	test("omits a sha that does not exist instead of throwing", async () => {
		// Reached from stale rows after a `gc` or a re-clone. The endpoint must still
		// answer for every other chapter.
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");

		const { resolved } = await resolveAnchorFallbacks(repo, "main", [
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			base,
		]);
		expect(resolved.has("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(false);
		expect(resolved.get(base)).toBe(base);
	});

	test("makes no git call for an empty input", async () => {
		// The endpoint calls this on every page fetch, so a healthy project must not pay a
		// subprocess for it. A nonexistent path would fail loudly if git ran.
		const { resolved, spent } = await resolveAnchorFallbacks("/nonexistent/path", "main", []);
		expect(resolved.size).toBe(0);
		expect(spent).toBe(0);
	});

	test("caps how many lookups one request can spawn", async () => {
		// Each lookup is a subprocess on a request path that pages. Past the cap chapters
		// keep the pre-existing "cannot place this" behaviour, which is a message the user
		// already understands — unlike an endpoint that stalls.
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");
		await git(repo, ["checkout", "-b", "side"]);
		const sideShas: string[] = [];
		for (let i = 0; i < MAX_ANCHOR_FALLBACK_LOOKUPS + 5; i++) {
			sideShas.push(await commit(repo, "b.txt", `side ${i}\n`, `side ${i}`));
		}
		await git(repo, ["checkout", "main"]);
		await commit(repo, "a.txt", "2\n", "trunk moved on");

		const { resolved, spent } = await resolveAnchorFallbacks(repo, "main", sideShas);
		expect(resolved.size).toBe(MAX_ANCHOR_FALLBACK_LOOKUPS);
		expect(spent).toBe(MAX_ANCHOR_FALLBACK_LOOKUPS);
		for (const sha of resolved.keys()) expect(resolved.get(sha)).toBe(base);
	});

	test("serves a repeated question from cache", async () => {
		// Scrolling the timeline refetches the endpoint per page and asks about the same
		// handful of shas each time. Verified by deleting the repository between calls:
		// only a cached answer can survive that.
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");

		expect((await resolveAnchorFallbacks(repo, "main", [base])).resolved.get(base)).toBe(base);
		rmSync(repo, { recursive: true, force: true });
		expect((await resolveAnchorFallbacks(repo, "main", [base])).resolved.get(base)).toBe(base);
	});

	test("reports a cache hit as costing no budget", async () => {
		// `spent` is what a multi-round caller subtracts from its allowance. Counting cache
		// hits would make the second round of a scrolled page believe the budget was
		// exhausted by answers that spawned nothing.
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");

		expect((await resolveAnchorFallbacks(repo, "main", [base])).spent).toBe(1);
		expect((await resolveAnchorFallbacks(repo, "main", [base])).spent).toBe(0);
	});

	test("honours a caller-supplied budget smaller than the global cap", async () => {
		// The Ruler endpoint asks in two rounds and must not hand the first round a fresh
		// full allowance, or one request could spawn a multiple of the cap.
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");
		await git(repo, ["checkout", "-b", "side"]);
		const sideShas: string[] = [];
		for (let i = 0; i < 5; i++) {
			sideShas.push(await commit(repo, "b.txt", `side ${i}\n`, `side ${i}`));
		}
		await git(repo, ["checkout", "main"]);
		await commit(repo, "a.txt", "2\n", "trunk moved on");

		const { resolved, spent } = await resolveAnchorFallbacks(repo, "main", sideShas, { budget: 2 });
		expect(spent).toBe(2);
		expect(resolved.size).toBe(2);
		for (const sha of resolved.keys()) expect(resolved.get(sha)).toBe(base);
	});

	test("answers nothing, and spawns nothing, once the budget is used up", async () => {
		// The second round of the Ruler endpoint is skipped when the first exhausted the
		// allowance; a budget of 0 arriving anyway must be inert rather than unbounded.
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");

		const { resolved, spent } = await resolveAnchorFallbacks(repo, "main", [base], { budget: 0 });
		expect(resolved.size).toBe(0);
		expect(spent).toBe(0);
	});

	test("gives every chapter's own start commit a chance before any ancestor", async () => {
		/*
		 * The unfairness this pins down. The endpoint used to collect, for each unplaceable
		 * chapter, every sha on its parent chain into ONE set and let the budget be eaten in
		 * insertion order. With more chapters × chain depth than the cap, a deep chain
		 * belonging to an early chapter consumed the whole allowance and a later chapter's
		 * OWN start commit — the cheapest and most accurate answer available, and the first
		 * thing `resolveAnchorFallback` looks for — was never asked about at all.
		 *
		 * Modelled here the way the endpoint now asks: round one is one sha per chapter. The
		 * assertion is that with as many chapters as the cap allows lookups, EVERY chapter
		 * gets its own answer, however deep the chains behind them are.
		 */
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");
		await git(repo, ["checkout", "-b", "side"]);

		// One "own start commit" per chapter, plus a deep tail per chapter standing in for
		// its ancestors — far more shas in total than the cap.
		const ownStartShas: string[] = [];
		const ancestorShas: string[] = [];
		for (let i = 0; i < MAX_ANCHOR_FALLBACK_LOOKUPS; i++) {
			ownStartShas.push(await commit(repo, "b.txt", `own ${i}\n`, `own ${i}`));
			for (let depth = 0; depth < 3; depth++) {
				ancestorShas.push(await commit(repo, "b.txt", `anc ${i}.${depth}\n`, `anc ${i}.${depth}`));
			}
		}
		await git(repo, ["checkout", "main"]);
		await commit(repo, "a.txt", "2\n", "trunk moved on");

		let budget = MAX_ANCHOR_FALLBACK_LOOKUPS;
		const first = await resolveAnchorFallbacks(repo, "main", ownStartShas, { budget });
		budget -= first.spent;

		// Every chapter placed, none crowded out by another chapter's ancestors.
		for (const sha of ownStartShas) expect(first.resolved.get(sha)).toBe(base);
		// And the allowance is genuinely spent, so round two asks for nothing — which is
		// the honest trade: chapters are placed, approximate ancestor positions are not.
		expect(budget).toBe(0);
		const second = await resolveAnchorFallbacks(repo, "main", ancestorShas, { budget });
		expect(second.spent).toBe(0);
		expect(second.resolved.size).toBe(0);
	});

	test("spends the remainder of one allowance on ancestors, never a second allowance", async () => {
		// The complementary case: few chapters, so round one leaves budget, and round two
		// may use exactly what is left and no more.
		const repo = await makeRepo();
		const base = await commit(repo, "a.txt", "1\n", "base");
		await git(repo, ["checkout", "-b", "side"]);
		const own = await commit(repo, "b.txt", "own\n", "own");
		const ancestors: string[] = [];
		for (let i = 0; i < MAX_ANCHOR_FALLBACK_LOOKUPS + 5; i++) {
			ancestors.push(await commit(repo, "b.txt", `anc ${i}\n`, `anc ${i}`));
		}
		await git(repo, ["checkout", "main"]);
		await commit(repo, "a.txt", "2\n", "trunk moved on");

		let budget = MAX_ANCHOR_FALLBACK_LOOKUPS;
		const first = await resolveAnchorFallbacks(repo, "main", [own], { budget });
		budget -= first.spent;
		expect(first.resolved.get(own)).toBe(base);
		expect(budget).toBe(MAX_ANCHOR_FALLBACK_LOOKUPS - 1);

		const second = await resolveAnchorFallbacks(repo, "main", ancestors, { budget });
		expect(second.spent).toBe(MAX_ANCHOR_FALLBACK_LOOKUPS - 1);
		expect(first.spent + second.spent).toBe(MAX_ANCHOR_FALLBACK_LOOKUPS);
	});
});
