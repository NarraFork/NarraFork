/**
 * The "start as a team" option's state: on only for a directory that resolves to a git project
 * the user may write in; otherwise off with a reason, never hidden.
 *
 * Run: bun test --isolate frontend/components/narrator/create-narrator-team.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { ResolveProjectDirectoryResponse } from "@shared/project-directory";
import { type TeamStartLookup, teamStartEligibility } from "./create-narrator-team";

const project = (
	overrides: Partial<{ archived: boolean; canWrite: boolean }> = {},
): ResolveProjectDirectoryResponse => ({
	status: "project",
	project: {
		id: "p1",
		name: "repo",
		gitPath: "/work/repo",
		archived: false,
		canWrite: true,
		...overrides,
	},
});

function lookup(overrides: Partial<TeamStartLookup> = {}): TeamStartLookup {
	return {
		isRemoteDevice: false,
		cwd: "/work/repo",
		lookedUpCwd: "/work/repo",
		isLoading: false,
		error: null,
		data: project(),
		...overrides,
	};
}

describe("team option on", () => {
	test("a project the user can write in", () => {
		expect(teamStartEligibility(lookup())).toEqual({
			ok: true,
			project: { id: "p1", name: "repo" },
		});
	});

	test("a git repository without a project yet (made at submit)", () => {
		expect(
			teamStartEligibility(lookup({ data: { status: "repository", root: "/work/new" } })),
		).toEqual({ ok: true, repositoryRoot: "/work/new" });
	});
});

describe("team option off, with the reason", () => {
	test.each<[string, Partial<TeamStartLookup>, string]>([
		["a remote execution device", { isRemoteDevice: true }, "remoteDevice"],
		["no directory", { cwd: "  " }, "chooseDirectory"],
		["the lookup is running", { isLoading: true, data: undefined }, "checking"],
		["the answer is for a directory since changed", { cwd: "/work/other" }, "checking"],
		["no answer yet", { data: undefined }, "checking"],
		["PostgreSQL (503)", { error: Object.assign(new Error("pg"), { status: 503 }) }, "postgres"],
		[
			"any other failure",
			{ error: Object.assign(new Error("x"), { status: 500 }) },
			"lookupFailed",
		],
		["not a git repository", { data: { status: "not_git" } }, "notGit"],
		["not a directory", { data: { status: "not_directory" } }, "notDirectory"],
		["a project the user cannot read", { data: { status: "no_access" } }, "noAccess"],
		["an archived project", { data: project({ archived: true }) }, "archived"],
		["a read-only project", { data: project({ canWrite: false }) }, "readOnly"],
	])("%s", (_name, overrides, reason) => {
		expect(teamStartEligibility(lookup(overrides))).toEqual({ ok: false, reason } as never);
	});

	test("a remote device wins over a stale answer saying yes", () => {
		expect(teamStartEligibility(lookup({ isRemoteDevice: true })).ok).toBe(false);
	});

	test("a mocked or malformed answer is not read as a yes", () => {
		expect(
			teamStartEligibility(
				lookup({ data: { paths: {} } as unknown as ResolveProjectDirectoryResponse }),
			),
		).toEqual({ ok: false, reason: "checking" });
	});
});
