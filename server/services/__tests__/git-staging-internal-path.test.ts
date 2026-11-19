import { expect, test } from "bun:test";
import { GIT_STAGING_EXCLUDE_PATHSPEC, isGitStagingInternalPath } from "../git-staging-files";

test("ordinary Git keeps the root-anchored internal-data exclusion", () => {
	expect(GIT_STAGING_EXCLUDE_PATHSPEC).toBe(":(top,exclude,glob)[.]narrafork/git-staging/**");
	for (const path of [
		".narrafork/git-staging",
		".narrafork/git-staging/lists.json",
		"./.narrafork/git-staging/indexes/frozen.index",
		"././.narrafork/git-staging/execution/pending.json",
	])
		expect(isGitStagingInternalPath(path)).toBe(true);
});

test("the internal-data exclusion leaves other user files available", () => {
	for (const path of [
		".narrafork/plans/change.md",
		".narrafork/git-staging-notes.txt",
		"nested/.narrafork/git-staging/lists.json",
		"git-staging/lists.json",
		"file.txt",
	])
		expect(isGitStagingInternalPath(path)).toBe(false);
});
