import { describe, expect, test } from "bun:test";
import type { GitBranchEntry } from "@shared/git-branches";
import {
	aheadBehindLabel,
	branchRowDisabledReason,
	branchSwitchRequest,
	filterBranches,
	localNameForRemote,
} from "./git-branch-list";

function entry(name: string, overrides: Partial<GitBranchEntry> = {}): GitBranchEntry {
	return {
		name,
		sha: "a".repeat(40),
		committedAt: "2026-08-01T10:00:00+08:00",
		subject: `${name} subject`,
		upstream: null,
		ahead: 0,
		behind: 0,
		upstreamGone: false,
		worktreePath: null,
		...overrides,
	};
}

const t = (key: string) => (key === "branches.upstreamGone" ? "upstream gone" : key);

describe("filterBranches", () => {
	const branches = [
		entry("main", { upstream: "origin/main" }),
		entry("feature/login", { subject: "登录鉴权" }),
		entry("release/2026.01", { subject: "bump versions" }),
	];

	test("an empty query keeps every branch in order", () => {
		expect(filterBranches(branches, "").map((item) => item.name)).toEqual([
			"main",
			"feature/login",
			"release/2026.01",
		]);
		expect(filterBranches(branches, "   ")).toHaveLength(3);
	});

	test("matches name, upstream and subject case-insensitively", () => {
		expect(filterBranches(branches, "LOGIN").map((item) => item.name)).toEqual(["feature/login"]);
		expect(filterBranches(branches, "origin/main").map((item) => item.name)).toEqual(["main"]);
		expect(filterBranches(branches, "鉴权").map((item) => item.name)).toEqual(["feature/login"]);
		expect(filterBranches(branches, "nothing")).toEqual([]);
	});
});

describe("localNameForRemote", () => {
	test("drops only the remote segment, keeping nested names", () => {
		expect(localNameForRemote("origin/feature/x")).toBe("feature/x");
		expect(localNameForRemote("origin/main")).toBe("main");
		expect(localNameForRemote("main")).toBe("main");
	});
});

describe("branchSwitchRequest", () => {
	const localNames = new Set(["main", "feature/login"]);

	test("a local row switches to its own name", () => {
		expect(branchSwitchRequest(entry("main"), { localNames, remote: false })).toEqual({
			branch: "main",
		});
	});

	test("a remote row is a plain switch when the local branch already exists", () => {
		// `checkout --track origin/feature/login` would refuse: the local name is taken.
		expect(
			branchSwitchRequest(entry("origin/feature/login"), { localNames, remote: true }),
		).toEqual({ branch: "feature/login" });
	});

	test("a remote row without a local counterpart creates it from the remote ref", () => {
		expect(branchSwitchRequest(entry("origin/feature/new"), { localNames, remote: true })).toEqual({
			branch: "feature/new",
			create: true,
			startPoint: "origin/feature/new",
		});
	});
});

describe("branchRowDisabledReason", () => {
	const options = { current: false, canWrite: true };

	test("the current branch and another worktree's checkout are both blocked", () => {
		expect(branchRowDisabledReason(entry("main"), { ...options, current: true })).toBe("current");
		expect(branchRowDisabledReason(entry("side", { worktreePath: "/repo-side" }), options)).toBe(
			"worktree",
		);
		expect(branchRowDisabledReason(entry("free"), options)).toBeNull();
	});

	test("a read-only workspace blocks every remaining row", () => {
		expect(branchRowDisabledReason(entry("free"), { canWrite: false, current: false })).toBe(
			"readOnly",
		);
		// Being on the branch is still the more useful explanation there.
		expect(branchRowDisabledReason(entry("main"), { canWrite: false, current: true })).toBe(
			"current",
		);
	});
});

describe("aheadBehindLabel", () => {
	test("renders counts as arrows and names a gone upstream", () => {
		expect(aheadBehindLabel(entry("main"), t)).toBeNull();
		expect(aheadBehindLabel(entry("main", { ahead: 2 }), t)).toBe("↑2");
		expect(aheadBehindLabel(entry("main", { behind: 1 }), t)).toBe("↓1");
		expect(aheadBehindLabel(entry("main", { ahead: 2, behind: 3 }), t)).toBe("↑2 ↓3");
		expect(aheadBehindLabel(entry("main", { upstreamGone: true }), t)).toBe("upstream gone");
	});
});
