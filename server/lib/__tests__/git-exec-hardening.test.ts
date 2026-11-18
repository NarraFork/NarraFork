/**
 * The read-only git hardening of team worktrees (P3 review round 2): configured filters and
 * configuration-defined hooks are disabled by name, and a git that ignores environment
 * overrides is refused (checked once per process, a refusal is retried).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	ensureConfigOverridesHonored,
	gitConfigEnv,
	parseProgramConfig,
	setGitHardeningProbeForTests,
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
			GIT_CONFIG_KEY_0: "a.b",
			GIT_CONFIG_VALUE_0: "1",
		});
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
});
