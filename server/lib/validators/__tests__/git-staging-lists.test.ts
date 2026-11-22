import { expect, test } from "bun:test";
import { GIT_STAGING_LIMITS, type GitStagingAction } from "@shared/git-staging-lists";
import {
	gitStagingActionSchema,
	gitStagingDiffQuerySchema,
	gitStagingFilesQuerySchema,
} from "../git";

const base = { workspaceKey: "workspace" };
const version = { expectedGeneration: 2, observationId: "observation" };
const move = { ...version, action: "move", fromListId: "A", toListId: "B" };

test("dynamic actions require explicit current observation except initialization and synchronization", () => {
	const actions: GitStagingAction[] = [
		{ action: "init" },
		{ action: "sync" },
		{ ...version, action: "create", name: "A" },
		{ ...version, action: "rename", listId: "A", name: "B" },
		{ ...version, action: "activate", listId: "A" },
		{ ...version, action: "delete", listId: "A" },
		{ ...version, action: "move", fromListId: "A", toListId: "B", unitIds: ["file:unit:opaque"] },
		{ ...version, action: "commit", listId: "A", message: "Commit" },
		{ ...version, action: "recover", operationId: "operation" },
	];
	for (const action of actions)
		expect(gitStagingActionSchema.parse({ ...base, ...action })).toEqual({ ...base, ...action });
	for (const action of ["stage", "unstage", "retrySave", "capture", "removeEmpty"])
		expect(
			gitStagingActionSchema.safeParse({ ...base, ...version, action, listId: "A", paths: ["a"] })
				.success,
		).toBe(false);
	for (const action of actions.filter((a) => a.action !== "init" && a.action !== "sync")) {
		const {
			expectedGeneration: _generation,
			observationId: _observation,
			...unversioned
		} = action as typeof action & typeof version;
		expect(gitStagingActionSchema.safeParse({ ...base, ...unversioned }).success).toBe(false);
	}
});

test("move has exactly one source-bound complete selection", () => {
	for (const selection of [
		{ paths: ["file"] },
		{ unitIds: ["f:unit:1"] },
		{ all: true },
		{ scope: { filter: ["M"], directory: "src" } },
		{ scope: { directory: "src", filter: [] } },
	])
		expect(gitStagingActionSchema.safeParse({ ...base, ...move, ...selection }).success).toBe(true);
	for (const selection of [
		{},
		{ paths: [] },
		{ unitIds: [] },
		{ all: false },
		{ scope: {} },
		{ scope: { filter: [] } },
		{ paths: ["a"], unitIds: ["id"] },
		{ all: true, scope: {} },
		{ paths: ["a", "a"] },
		{ unitIds: ["a", "a"] },
		{ unitIds: ["bad\0id"] },
		{ unitIds: ["id\n"] },
	])
		expect(gitStagingActionSchema.safeParse({ ...base, ...move, ...selection }).success).toBe(
			false,
		);
	expect(
		gitStagingActionSchema.safeParse({ ...base, ...move, toListId: "A", all: true }).success,
	).toBe(true);
});

test("names preserve Unicode and meaningful whitespace", () => {
	for (const name of [" A ", "\uFEFFA\uFEFF", "\u0085", "中文".repeat(60)])
		expect(
			gitStagingActionSchema.parse({ ...base, ...version, action: "create", name }),
		).toHaveProperty("name", name);
	for (const name of ["", " ", "\uFEFF", "\uD800", "\u007f", "a".repeat(121)])
		expect(
			gitStagingActionSchema.safeParse({ ...base, ...version, action: "create", name }).success,
		).toBe(false);
});

test("paths, unit identifiers and versions have bounded structural validation", () => {
	for (const paths of [
		[],
		["../a"],
		["a/../b"],
		["./a"],
		["/a"],
		["C:/a"],
		["a\0b"],
		[".git/config"],
		["a", "a"],
		["x".repeat(4097)],
		Array.from({ length: GIT_STAGING_LIMITS.maxFilesPerOperation + 1 }, (_, i) => `a${i}`),
	])
		expect(gitStagingActionSchema.safeParse({ ...base, ...move, paths }).success).toBe(false);
	for (const expectedGeneration of [-1, 1.1, NaN, Number.MAX_SAFE_INTEGER + 1])
		expect(
			gitStagingActionSchema.safeParse({ ...base, ...move, expectedGeneration, all: true }).success,
		).toBe(false);
	for (const listId of ["", "../A", "a/b", "x".repeat(129)])
		expect(
			gitStagingActionSchema.safeParse({ ...base, ...version, action: "delete", listId }).success,
		).toBe(false);
});

test("relative colon filenames are accepted without admitting absolute Windows drive paths", () => {
	for (const path of ["a:b.txt", "src/a:b.txt"]) {
		expect(gitStagingDiffQuerySchema.safeParse({ ...base, path }).success).toBe(true);
		expect(gitStagingActionSchema.safeParse({ ...base, ...move, paths: [path] }).success).toBe(
			true,
		);
	}
	for (const path of ["C:/outside", "C:\\outside", "\\\\server\\share", "/outside"])
		expect(gitStagingDiffQuerySchema.safeParse({ ...base, path }).success).toBe(false);
});

test("HTTP clients cannot provide authenticated identity or unknown operation fields", () => {
	const action = { ...base, ...version, action: "commit", listId: "A", message: "Commit" };
	for (const extra of [
		{ identity: { name: "forged", email: "forged@example.test" } },
		{ patch: "untrusted" },
		{ snapshotScope: { snapshotId: "old" } },
	])
		expect(gitStagingActionSchema.safeParse({ ...action, ...extra }).success).toBe(false);
});

test("file reads use bounded cursors and server-side status filters", () => {
	expect(gitStagingFilesQuerySchema.parse({ ...base, limit: "200", filter: "MMA" })).toEqual({
		...base,
		limit: 200,
		filter: ["M", "A"],
	});
	for (const query of [
		{ limit: "201" },
		{ limit: "0" },
		{ cursor: "x".repeat(4097) },
		{ filter: "X" },
	])
		expect(gitStagingFilesQuerySchema.safeParse({ ...base, ...query }).success).toBe(false);
	expect(
		gitStagingDiffQuerySchema.parse({ ...base, path: "deleted/中文.txt", oldPath: "old/中文.txt" }),
	).toEqual({ ...base, path: "deleted/中文.txt", oldPath: "old/中文.txt" });
	expect(gitStagingDiffQuerySchema.safeParse(base).success).toBe(false);
});
