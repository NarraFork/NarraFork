/**
 * The read-only git hardening of team worktrees (P3 review round 2): configured filters and
 * configuration-defined hooks are disabled by name, and a git that ignores environment
 * overrides is refused (checked once per process, a refusal is retried).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanGitEnv,
	ensureConfigOverridesHonored,
	gitConfigEnv,
	PROGRAM_CONFIG_QUERY,
	parseProgramConfig,
	probeLazyFetch,
	probeLazyFetchHonoured,
	setGitHardeningProbeForTests,
	setLazyFetchProbeSeamsForTests,
	setNoLazyFetchSupportForTests,
	untrustedProgramOverrides,
} from "../git-exec-hardening";

afterEach(() => {
	setGitHardeningProbeForTests(null);
	setLazyFetchProbeSeamsForTests({ scratch: null, backoffMs: null });
});

const PROMISOR = "remote.evil.promisor\ntrue\0";

async function listTree(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }))
		if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
	return out.sort();
}

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

	test("the server's environment cannot route git elsewhere or add configuration", () => {
		const env = cleanGitEnv({
			PATH: "/bin",
			HOME: "/home/x",
			GIT_DIR: "/r/.git",
			GIT_WORK_TREE: "/r",
			GIT_COMMON_DIR: "/r/.git",
			GIT_INDEX_FILE: "/r/index",
			GIT_OBJECT_DIRECTORY: "/o",
			GIT_ALTERNATE_OBJECT_DIRECTORIES: "/a",
			GIT_NAMESPACE: "n",
			GIT_CEILING_DIRECTORIES: "/",
			GIT_TEMPLATE_DIR: "/t",
			GIT_CONFIG: "/c",
			GIT_CONFIG_PARAMETERS: "'core.hookspath'='/evil'",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: "/evil",
			GIT_EXTERNAL_DIFF: "x",
			GIT_NO_LAZY_FETCH: "0",
			GIT_CONFIG_GLOBAL: "/g",
			GIT_CONFIG_NOSYSTEM: "1",
		});
		// The operator's configuration files stay; the probe drops them too.
		expect(env).toEqual({
			PATH: "/bin",
			HOME: "/home/x",
			GIT_CONFIG_GLOBAL: "/g",
			GIT_CONFIG_NOSYSTEM: "1",
		});
		expect(cleanGitEnv({ PATH: "/bin", GIT_CONFIG_GLOBAL: "/g" }, { configFiles: false })).toEqual({
			PATH: "/bin",
		});
	});

	test("the lazy-fetch probe never writes to a repository the environment points at", async () => {
		const victim = await mkdtemp(join(tmpdir(), "nf-probe-victim-"));
		const saved = { ...process.env };
		try {
			const init = Bun.spawnSync(["git", "init", "-q", victim], {
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			});
			expect(init.exitCode).toBe(0);
			const gitDir = join(victim, ".git");
			const config = await readFile(join(gitDir, "config"), "utf8");
			const files = await listTree(gitDir);
			Object.assign(process.env, {
				GIT_DIR: gitDir,
				GIT_WORK_TREE: victim,
				GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
				GIT_INDEX_FILE: join(gitDir, "index"),
				GIT_COMMON_DIR: gitDir,
				GIT_TEMPLATE_DIR: join(victim, "templates"),
				GIT_NO_LAZY_FETCH: "1",
			});
			expect(await probeLazyFetch()).toBe("supported");
			expect(await readFile(join(gitDir, "config"), "utf8")).toBe(config);
			expect(await listTree(gitDir)).toEqual(files);
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
			await rm(victim, { recursive: true, force: true });
		}
	});

	test("no scratch space is inconclusive: not cached, promisor repositories wait, others proceed", async () => {
		let scratches = 0;
		setLazyFetchProbeSeamsForTests({
			backoffMs: 0,
			scratch: async (prefix) => {
				scratches++;
				if (scratches === 1) throw new Error("ENOSPC: no space left on device");
				return mkdtemp(prefix);
			},
		});
		setNoLazyFetchSupportForTests(null);
		try {
			// The first probe cannot tell: the hardening itself still proceeds…
			await ensureConfigOverridesHonored();
			expect(scratches).toBe(1);
			// …a promisor repository is refused, an ordinary one is not.
			expect(() => untrustedProgramOverrides(parseProgramConfig(PROMISOR))).toThrow(
				expect.objectContaining({ code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE" }),
			);
			expect(() => untrustedProgramOverrides(parseProgramConfig(""))).not.toThrow();
			// The next call probes again and keeps the answer.
			await ensureConfigOverridesHonored();
			expect(scratches).toBe(2);
			expect(() => untrustedProgramOverrides(parseProgramConfig(PROMISOR))).not.toThrow();
			await ensureConfigOverridesHonored();
			expect(scratches).toBe(2);
		} finally {
			setNoLazyFetchSupportForTests(null);
		}
	});

	test("an inconclusive probe is retried only after its backoff", async () => {
		let scratches = 0;
		setLazyFetchProbeSeamsForTests({
			backoffMs: 60_000,
			scratch: async () => {
				scratches++;
				throw new Error("EACCES");
			},
		});
		setNoLazyFetchSupportForTests(null);
		try {
			await ensureConfigOverridesHonored();
			await ensureConfigOverridesHonored();
			expect(scratches).toBe(1);
			setLazyFetchProbeSeamsForTests({ backoffMs: 0 });
			await ensureConfigOverridesHonored();
			expect(scratches).toBe(2);
		} finally {
			setNoLazyFetchSupportForTests(null);
		}
	});
});
