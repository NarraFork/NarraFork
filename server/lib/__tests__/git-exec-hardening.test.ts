/**
 * The read-only git hardening of team worktrees (P3 review round 2): configured filters and
 * configuration-defined hooks are disabled by name, and a git that ignores environment
 * overrides is refused (checked once per process, a refusal is retried).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	ensureConfigOverridesHonored,
	gitConfigEnv,
	PROGRAM_CONFIG_QUERY,
	parseProgramConfig,
	probeLazyFetchHonoured,
	setGitHardeningProbeForTests,
	setNoLazyFetchSupportForTests,
	untrustedProgramOverrides,
} from "../git-exec-hardening";

afterEach(() => setGitHardeningProbeForTests(null));

describe("git exec hardening", () => {
	test("filters and configuration-defined hooks are disabled by name", () => {
		const programs = parseProgramConfig(
			"filter.lfs.clean\ngit-lfs clean\0filter.my.dots.smudge\ncat\0hook.lint.command\nnpm run lint\0hook.lint.event\npre-commit\0hook.Other.event\npost-merge\0",
		);
		expect(programs).toEqual({ filters: ["lfs", "my.dots"], hooks: ["lint", "Other"] });
		expect(untrustedProgramOverrides(programs)).toContainEqual(["hook.lint.enabled", "false"]);
		expect(untrustedProgramOverrides(programs)).toContainEqual(["hook.Other.enabled", "false"]);
		expect(untrustedProgramOverrides(programs)).toContainEqual(["filter.my.dots.process", ""]);
		expect(gitConfigEnv([["a.b", "1"]])).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_NO_LAZY_FETCH: "1",
			GIT_CONFIG_KEY_0: "a.b",
			GIT_CONFIG_VALUE_0: "1",
		});
	});

	test("custom merge drivers are named by the query and emptied", () => {
		expect(PROGRAM_CONFIG_QUERY.at(-1)).toContain("merge\\..+\\.driver");
		const programs = parseProgramConfig(
			"merge.evil.driver\ntouch /tmp/x\0merge.Ours.Name.driver\ncat\0merge.renormalize\ntrue\0hook.lint.command\nx\0",
		);
		expect(programs).toEqual({ filters: [], hooks: ["lint"], drivers: ["evil", "Ours.Name"] });
		expect(untrustedProgramOverrides(programs)).toEqual([
			["hook.lint.enabled", "false"],
			["merge.evil.driver", ""],
			["merge.Ours.Name.driver", ""],
		]);
	});

	test("this git honors the overrides; a git that does not is refused, and asked again", async () => {
		await ensureConfigOverridesHonored();
		let asked = 0;
		setGitHardeningProbeForTests(async () => {
			asked++;
			return false;
		});
		await expect(ensureConfigOverridesHonored()).rejects.toThrow(
			"git 2.31 or newer is required for team worktrees",
		);
		await expect(ensureConfigOverridesHonored()).rejects.toThrow("git 2.31");
		expect(asked).toBe(2);
		setGitHardeningProbeForTests(async () => {
			asked++;
			return true;
		});
		await ensureConfigOverridesHonored();
		await ensureConfigOverridesHonored();
		expect(asked).toBe(3);
	});

	test("lazy fetching: this git honours GIT_NO_LAZY_FETCH by behaviour; promisor settings are seen", async () => {
		// git 2.45 is the first with it ("git --no-lazy-fetch", RelNotes 2.45.0); probed, not parsed.
		expect(await probeLazyFetchHonoured()).toBe(true);
		for (const record of [
			"extensions.partialclone\norigin\0",
			"remote.evil.promisor\ntrue\0",
			"remote.evil.partialclonefilter\nblob:none\0",
		])
			expect(parseProgramConfig(record).partialClone).toBe(true);
		expect(parseProgramConfig("remote.origin.url\nx\0").partialClone).toBeUndefined();
		// A git that does not honour it: any promisor setting refuses the repository.
		setNoLazyFetchSupportForTests(false);
		try {
			expect(() =>
				untrustedProgramOverrides(parseProgramConfig("remote.evil.promisor\ntrue\0")),
			).toThrow(expect.objectContaining({ code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE" }));
			expect(() => untrustedProgramOverrides(parseProgramConfig(""))).not.toThrow();
		} finally {
			setNoLazyFetchSupportForTests(null);
		}
		setNoLazyFetchSupportForTests(true);
		try {
			expect(() =>
				untrustedProgramOverrides(parseProgramConfig("remote.evil.promisor\ntrue\0")),
			).not.toThrow();
		} finally {
			setNoLazyFetchSupportForTests(null);
		}
	});
});
