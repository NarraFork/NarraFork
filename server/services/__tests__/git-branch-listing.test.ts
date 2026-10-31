/**
 * `parseGitBranches` — the single parser behind the local and remote branch listings.
 *
 * Built from raw `for-each-ref` text rather than a mock, because the wire format is
 * the contract: two ref kinds share one format string, `%(symref)` has to be read
 * apart from `%(upstream)`, and a byte-budget cut can end mid-record.
 */
import { describe, expect, test } from "bun:test";
import { GIT_BRANCH_LIST_LIMIT, isValidGitBranchName } from "@shared/git-branches";
import { GIT_BRANCH_REF_FORMAT, parseGitBranches } from "../git-branch-listing";

interface RefRecord {
	name: string;
	sha?: string;
	upstream?: string;
	track?: string;
	date?: string;
	subject?: string;
	head?: string;
	symref?: string;
}

/** One newline-terminated record in the exact field order of the format string. */
function ref(record: RefRecord): string {
	return [
		record.name,
		record.sha ?? "a".repeat(40),
		record.upstream ?? "",
		record.track ?? "",
		record.date ?? "2026-08-01T10:00:00+08:00",
		record.subject ?? "subject",
		record.head ?? " ",
		record.symref ?? "",
	].join("\0");
}

describe("GIT_BRANCH_REF_FORMAT", () => {
	test("keeps the eight NUL-separated fields the parser reads", () => {
		// Lockstep guard: the Go executor copies this string verbatim. `%00` is the
		// ref-filter escape; `%x00` is pretty-format-only and would print literally.
		expect(GIT_BRANCH_REF_FORMAT.split("%00")).toEqual([
			"%(refname:lstrip=2)",
			"%(objectname)",
			"%(upstream:short)",
			"%(upstream:track)",
			"%(committerdate:iso-strict)",
			"%(contents:subject)",
			"%(HEAD)",
			"%(symref)",
		]);
	});
});

describe("parseGitBranches", () => {
	test("reads every %(upstream:track) form", () => {
		const parsed = parseGitBranches({
			heads: [
				ref({ name: "main", upstream: "origin/main", track: "[ahead 2]", head: "*" }),
				ref({ name: "behind", upstream: "origin/behind", track: "[behind 3]" }),
				ref({ name: "both", upstream: "origin/both", track: "[ahead 4, behind 5]" }),
				ref({ name: "gone", upstream: "origin/gone", track: "[gone]" }),
				ref({ name: "plain" }),
			].join("\n"),
			branch: "main",
			headSha: "a".repeat(40),
		});
		const byName = Object.fromEntries(parsed.local.map((entry) => [entry.name, entry]));
		expect([byName.main?.ahead, byName.main?.behind, byName.main?.upstreamGone]).toEqual([
			2,
			0,
			false,
		]);
		expect([byName.behind?.ahead, byName.behind?.behind]).toEqual([0, 3]);
		expect([byName.both?.ahead, byName.both?.behind]).toEqual([4, 5]);
		expect(byName.gone?.upstreamGone).toBe(true);
		// No upstream at all is not "[gone]" and carries no counts.
		expect([byName.plain?.upstream, byName.plain?.ahead, byName.plain?.upstreamGone]).toEqual([
			null,
			0,
			false,
		]);
	});

	test("drops symbolic refs such as refs/remotes/origin/HEAD", () => {
		const parsed = parseGitBranches({
			remoteRefs: [
				ref({ name: "origin/HEAD", symref: "refs/remotes/origin/main" }),
				ref({ name: "origin/main" }),
			].join("\n"),
			branch: "main",
			headSha: "a".repeat(40),
		});
		expect(parsed.remote.map((entry) => entry.name)).toEqual(["origin/main"]);
	});

	test("a truncated byte budget never yields a half-parsed branch", () => {
		const complete = ref({ name: "kept", date: "2026-08-02T10:00:00+08:00" });
		const partial = "half\0aaa111\0origin/half";
		const truncated = parseGitBranches({
			heads: `${complete}\n${partial}`,
			branch: "",
			headSha: "",
			truncated: true,
		});
		expect(truncated.local.map((entry) => entry.name)).toEqual(["kept"]);
		expect(truncated.truncated).toBe(true);
		// A cut inside the only record lists nothing rather than a guess.
		const onlyPartial = parseGitBranches({ heads: partial, branch: "", truncated: true });
		expect(onlyPartial.local).toEqual([]);
		// Without the truncation flag the short record still fails the field count.
		const notTruncated = parseGitBranches({
			heads: `${complete}\n${partial}`,
			branch: "",
			headSha: "",
		});
		expect(notTruncated.local.map((entry) => entry.name)).toEqual(["kept"]);
	});

	test("lists the current branch first even when it is the oldest commit", () => {
		const parsed = parseGitBranches({
			heads: [
				ref({ name: "recent", date: "2026-08-09T10:00:00+08:00" }),
				ref({ name: "main", date: "2026-01-01T10:00:00+08:00", head: "*" }),
			].join("\n"),
			branch: "main",
			headSha: "a".repeat(40),
		});
		expect(parsed.local.map((entry) => entry.name)).toEqual(["main", "recent"]);
	});

	test("keeps the current branch when the record cap would drop it", () => {
		// Simulates git's own --count window: 300 newer refs arrived without "main",
		// which is exactly the case the synthesised record exists for.
		const heads = Array.from({ length: GIT_BRANCH_LIST_LIMIT + 5 }, (_, index) =>
			ref({
				name: `feature/${index}`,
				date: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T10:00:00+08:00`,
			}),
		).join("\n");
		const parsed = parseGitBranches({
			heads,
			branch: "main",
			headSha: "b".repeat(40),
		});
		expect(parsed.local).toHaveLength(GIT_BRANCH_LIST_LIMIT);
		expect(parsed.local.at(-1)?.name).toBe("main");
		expect(parsed.local.at(-1)?.sha).toBe("b".repeat(40));
		expect(parsed.truncated).toBe(true);
	});

	test("marks a branch checked out in another worktree, never the current one", () => {
		const parsed = parseGitBranches({
			heads: [ref({ name: "main", head: "*" }), ref({ name: "side" }), ref({ name: "free" })].join(
				"\n",
			),
			worktrees: [
				"worktree /repo",
				`HEAD ${"a".repeat(40)}`,
				"branch refs/heads/main",
				"",
				"worktree /repo-side",
				`HEAD ${"b".repeat(40)}`,
				"branch refs/heads/side",
				"",
				"worktree /repo-detached",
				`HEAD ${"c".repeat(40)}`,
				"detached",
				"",
			].join("\n"),
			branch: "main",
			headSha: "a".repeat(40),
		});
		const byName = Object.fromEntries(parsed.local.map((entry) => [entry.name, entry]));
		// The current worktree's own checkout is not a conflict with itself.
		expect(byName.main?.worktreePath).toBeNull();
		expect(byName.side?.worktreePath).toBe("/repo-side");
		expect(byName.free?.worktreePath).toBeNull();
	});

	test("resolves the default remote: upstream, then origin, then the sole remote", () => {
		const heads = ref({ name: "main", upstream: "upstream/main", head: "*" });
		expect(
			parseGitBranches({ heads, remoteNames: "upstream\norigin\n", branch: "main" }).defaultRemote,
		).toBe("upstream");
		// The upstream names a remote this repository no longer has.
		expect(
			parseGitBranches({ heads, remoteNames: "origin\nfork\n", branch: "main" }).defaultRemote,
		).toBe("origin");
		expect(parseGitBranches({ heads, remoteNames: "solo\n", branch: "main" }).defaultRemote).toBe(
			"solo",
		);
		expect(
			parseGitBranches({ heads, remoteNames: "fork\nother\n", branch: "main" }).defaultRemote,
		).toBeNull();
		expect(parseGitBranches({ heads, remoteNames: "", branch: "main" }).defaultRemote).toBeNull();
	});

	test("detached and unborn HEADs are different states", () => {
		const detached = parseGitBranches({ heads: "", branch: "", headSha: "c".repeat(40) });
		expect(detached).toMatchObject({ branch: null, detached: true, headSha: "c".repeat(40) });
		const unborn = parseGitBranches({ heads: "", branch: "main", headSha: "" });
		expect(unborn).toMatchObject({ branch: "main", detached: false, headSha: null, local: [] });
	});

	test("keeps non-ASCII and punctuation branch names intact", () => {
		const parsed = parseGitBranches({
			heads: [
				ref({ name: "功能/登录+鉴权", head: "*" }),
				ref({ name: "fix/a+b", subject: "修复：登录失败" }),
			].join("\n"),
			branch: "功能/登录+鉴权",
			headSha: "a".repeat(40),
		});
		expect(parsed.local.map((entry) => entry.name)).toEqual(["功能/登录+鉴权", "fix/a+b"]);
		expect(parsed.local[1]?.subject).toBe("修复：登录失败");
		expect(parsed.branch).toBe("功能/登录+鉴权");
	});

	test("clamps a long commit subject instead of shipping it whole", () => {
		const parsed = parseGitBranches({
			heads: ref({ name: "main", subject: "x".repeat(400), head: "*" }),
			branch: "main",
		});
		expect(parsed.local[0]?.subject).toHaveLength(201);
		expect(parsed.local[0]?.subject.endsWith("…")).toBe(true);
	});
});

describe("isValidGitBranchName", () => {
	test("accepts the names git accepts", () => {
		for (const name of [
			"main",
			"feature/login",
			"fix/a+b",
			"release/2026.01",
			"功能/登录",
			"a".repeat(200),
		])
			expect(isValidGitBranchName(name)).toBe(true);
	});

	test("rejects what git check-ref-format --branch rejects", () => {
		for (const name of [
			"",
			"-dash",
			"a".repeat(201),
			"@",
			"a..b",
			"a b",
			"a~b",
			"a^b",
			"a:b",
			"a?b",
			"a*b",
			"a[b",
			"a\\b",
			"a@{1}",
			"/lead",
			"trail/",
			"double//slash",
			"trailing.",
			".hidden/branch",
			"branch.lock",
			"feature/x.lock",
		])
			expect(isValidGitBranchName(name)).toBe(false);
	});
});
