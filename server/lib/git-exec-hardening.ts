/**
 * Git configuration that keeps a server-side, read-only git command from running repository code.
 *
 * A checkout's configuration can name programs git runs on its own: hooks from a hooks directory
 * (`core.hooksPath` may be relative and point inside the worktree, e.g. Husky's ignored
 * `.husky/_`) or defined in configuration (`hook.<name>.command` / `.event`, which ignore
 * `core.hooksPath`), an fsmonitor, clean/smudge/process filters selected by `.gitattributes`,
 * an external diff, an ssh command or a credential helper. A command the server runs in a
 * checkout an agent could write to must not run any of them: nobody approved that code. The
 * server never writes into such a checkout with git (a base sync is the worker's job); what it
 * still runs there — status, rev-list, diff --name-only, worktree list/remove — runs with:
 *
 * - `GIT_NO_EXEC_CONFIG`, passed as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`:
 *   command-scope configuration, above every file scope, inherited by the git subprocesses a
 *   command starts itself (`git worktree remove` runs `git status`);
 * - `GIT_OPTIONAL_LOCKS=0`, so a status never writes the index (index writes fire
 *   `post-index-change`);
 * - every configured filter emptied, every configuration-defined hook disabled by name, and every
 *   custom merge driver emptied (`merge-tree` runs them; an empty driver runs nothing and the
 *   file counts as a conflict) — `untrustedProgramOverrides`, names read with
 *   `PROGRAM_CONFIG_QUERY`; reading configuration runs nothing.
 *
 * Git older than 2.31 silently ignores `GIT_CONFIG_COUNT`. `ensureConfigOverridesHonored` reads
 * a sentinel back through the same environment once per process and refuses otherwise.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "./errors";
import { DEV_NULL } from "./platform";
import { safeSpawn } from "./spawn";

/** Read back to prove this git honors command-scope overrides from the environment. */
export const GIT_HARDENING_SENTINEL = ["narrafork.hardened", "1"] as const;

/** Configuration that disables every program git would run on its own, except named ones. */
export const GIT_NO_EXEC_CONFIG: ReadonlyArray<readonly [string, string]> = [
	GIT_HARDENING_SENTINEL,
	["core.hooksPath", DEV_NULL],
	["core.fsmonitor", "false"],
	["core.untrackedCache", "false"],
	["diff.external", ""],
	["core.sshCommand", ""],
	["credential.helper", ""],
	["core.askPass", ""],
	// Runs when an object store has alternates (`objects/info/alternates`), on fetches.
	["core.alternateRefsCommand", ""],
	// No detached `git maintenance` / `gc --auto` after a writing command.
	["maintenance.auto", "false"],
	["gc.auto", "0"],
];

/**
 * Lists configured filters, configuration-defined hooks and custom merge drivers: `key\nvalue\0`
 * records.
 */
export const PROGRAM_CONFIG_QUERY = [
	"config",
	"-z",
	"--get-regexp",
	"^(filter\\..+\\.(clean|smudge|process)|hook\\..+\\.(command|event)|merge\\..+\\.driver|extensions\\.partialclone|remote\\..+\\.(promisor|partialclonefilter))$",
] as const;

export interface GitConfiguredPrograms {
	filters: string[];
	hooks: string[];
	/** Custom merge drivers (`merge.<name>.driver`); absent when none was read. */
	drivers?: string[];
	/**
	 * The repository is (or names) a partial clone (`extensions.partialClone`, a
	 * `remote.*.promisor` or `remote.*.partialCloneFilter`): a missing object would be fetched
	 * lazily, running the promisor remote's upload-pack, which `GIT_NO_LAZY_FETCH` forbids where
	 * this git honours it (git 2.45, checked by behaviour); otherwise the repository is refused.
	 */
	partialClone?: true;
}

/** Parse {@link PROGRAM_CONFIG_QUERY} output (exit 1 with no output means none). */
export function parseProgramConfig(stdout: string): GitConfiguredPrograms {
	const filters = new Set<string>();
	const hooks = new Set<string>();
	const drivers = new Set<string>();
	let partialClone = false;
	for (const record of stdout.split("\0")) {
		const key = record.split("\n", 1)[0] ?? "";
		const last = key.lastIndexOf(".");
		if (last <= 0) continue;
		if (key.startsWith("filter.")) filters.add(key.slice("filter.".length, last));
		else if (key.startsWith("hook.")) hooks.add(key.slice("hook.".length, last));
		else if (key.startsWith("merge.") && key.slice(last + 1).toLowerCase() === "driver")
			drivers.add(key.slice("merge.".length, last));
		else if (
			key.toLowerCase() === "extensions.partialclone" ||
			(key.toLowerCase().startsWith("remote.") && /\.(promisor|partialclonefilter)$/i.test(key))
		)
			partialClone = true;
	}
	const programs: GitConfiguredPrograms = {
		filters: [...filters].filter(Boolean),
		hooks: [...hooks].filter(Boolean),
	};
	const named = [...drivers].filter(Boolean);
	if (named.length > 0) programs.drivers = named;
	if (partialClone) programs.partialClone = true;
	return programs;
}

/** Overrides that empty every named filter and disable every configuration-defined hook. */
export function untrustedProgramOverrides(
	programs: GitConfiguredPrograms,
): Array<readonly [string, string]> {
	if (programs.partialClone && !noLazyFetchSupported)
		throw new AppError(
			"This repository is a partial clone (or names a promisor remote) and this git cannot be kept from fetching missing objects through it (GIT_NO_LAZY_FETCH needs git 2.45); update git to use it with teams",
			409,
			"GIT_TOO_OLD_FOR_PARTIAL_CLONE",
		);
	return [
		...programs.filters.flatMap((name) => [
			[`filter.${name}.clean`, ""] as const,
			[`filter.${name}.smudge`, ""] as const,
			[`filter.${name}.process`, ""] as const,
			[`filter.${name}.required`, "false"] as const,
		]),
		...programs.hooks.map((name) => [`hook.${name}.enabled`, "false"] as const),
		// An empty driver runs no program: git reports the file as a conflict instead.
		...(programs.drivers ?? []).map((name) => [`merge.${name}.driver`, ""] as const),
	];
}

/** The environment carrying configuration overrides (replaces any inherited GIT_CONFIG_*). */
export function gitConfigEnv(
	entries: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
	const env: Record<string, string> = {
		GIT_CONFIG_COUNT: String(entries.length),
		// A status never refreshes the index on disk (no index write, no post-index-change).
		GIT_OPTIONAL_LOCKS: "0",
		// A missing object is never fetched lazily from a (repository-configured) promisor remote.
		GIT_NO_LAZY_FETCH: "1",
	};
	entries.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

/** `diff` arguments that never run external diff or textconv programs. */
export function noExternalDiffArgs(args: readonly string[]): string[] {
	return args[0] === "diff"
		? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
		: [...args];
}

type HardeningProbe = () => Promise<boolean>;

async function defaultProbe(): Promise<boolean> {
	const result = await safeSpawn({
		cmd: ["git", "config", "--get", GIT_HARDENING_SENTINEL[0]],
		cwd: tmpdir(),
		env: { ...process.env, ...gitConfigEnv([GIT_HARDENING_SENTINEL]) },
		timeout: 10_000,
		maxOutputBytes: 4096,
	});
	return result.exitCode === 0 && result.stdout.trim() === GIT_HARDENING_SENTINEL[1];
}

let probe: HardeningProbe = defaultProbe;
let verdict: Promise<boolean> | null = null;

/**
 * Whether this git honours `GIT_NO_LAZY_FETCH` (git 2.45, "git --no-lazy-fetch"): known once the
 * behaviour probe ran (false until then, and when it could not tell).
 */
let noLazyFetchSupported = false;
let lazyFetchProbe: Promise<void> | null = null;

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe the behaviour itself, once per process: a scratch partial clone whose promisor remote
 * (a scratch repository next to it) holds a blob the clone lacks. With `GIT_NO_LAZY_FETCH=1`
 * `cat-file -e` must fail; without it, the same command must fetch the blob and succeed (the
 * control: otherwise the setup proves nothing and the answer is "not honoured"). Bounded: a
 * handful of git commands with a timeout each, in a temporary directory removed afterwards.
 */
export async function probeLazyFetchHonoured(): Promise<boolean> {
	const dir = await mkdtemp(join(tmpdir(), "nf-lazy-fetch-"));
	const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
		safeSpawn({
			cmd: ["git", "-C", cwd, ...args],
			env: {
				...process.env,
				LC_ALL: "C",
				GIT_TERMINAL_PROMPT: "0",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: DEV_NULL,
				...env,
			},
			timeout: PROBE_TIMEOUT_MS,
			maxOutputBytes: 4096,
			killProcessTree: true,
		});
	try {
		const source = join(dir, "source");
		const clone = join(dir, "clone");
		await mkdir(source);
		await mkdir(clone);
		if ((await git(source, ["init", "-q"])).exitCode !== 0) return false;
		await writeFile(join(source, "blob"), "narrafork lazy fetch probe\n");
		const blob = await git(source, ["hash-object", "-w", "blob"]);
		const oid = blob.stdout.trim();
		if (blob.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(oid)) return false;
		for (const args of [
			["config", "uploadpack.allowAnySHA1InWant", "true"],
			["config", "uploadpack.allowFilter", "true"],
		])
			await git(source, args);
		if ((await git(clone, ["init", "-q"])).exitCode !== 0) return false;
		for (const args of [
			["config", "core.repositoryformatversion", "1"],
			["config", "extensions.partialClone", "probe"],
			["config", "remote.probe.url", source],
			["config", "remote.probe.promisor", "true"],
		])
			await git(clone, args);
		const lookup = ["-c", "protocol.file.allow=always", "cat-file", "-e", oid];
		const refused = await git(clone, lookup, { GIT_NO_LAZY_FETCH: "1" });
		if (refused.exitCode === 0) return false;
		const control = await git(clone, lookup);
		return control.exitCode === 0;
	} catch {
		return false;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

async function probeLazyFetchSupport(): Promise<void> {
	noLazyFetchSupported = await probeLazyFetchHonoured();
}

/** Force the `GIT_NO_LAZY_FETCH` support verdict (tests); null reads git again. */
export function setNoLazyFetchSupportForTests(supported: boolean | null): void {
	if (supported === null) {
		lazyFetchProbe = null;
		noLazyFetchSupported = false;
		return;
	}
	lazyFetchProbe = Promise.resolve();
	noLazyFetchSupported = supported;
}

/** Replace the probe (tests); null restores git. Clears the cached verdict. */
export function setGitHardeningProbeForTests(next: HardeningProbe | null): void {
	probe = next ?? defaultProbe;
	verdict = null;
}

/**
 * Refuse unless this git honors environment configuration overrides (git ≥ 2.31): otherwise
 * none of the overrides above would apply. Checked once per process (a failed check is retried).
 */
export async function ensureConfigOverridesHonored(): Promise<void> {
	lazyFetchProbe ??= probeLazyFetchSupport();
	await lazyFetchProbe;
	verdict ??= probe().catch(() => false);
	const honored = await verdict;
	if (!honored) {
		verdict = null;
		throw new AppError(
			"git 2.31 or newer is required for team worktrees: this git ignores configuration overrides from the environment, so it cannot be kept from running repository hooks and filters",
			409,
			"GIT_TOO_OLD_FOR_HARDENING",
		);
	}
}
