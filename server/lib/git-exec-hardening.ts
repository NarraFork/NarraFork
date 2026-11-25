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
import { tmpdir } from "node:os";
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
	"^(filter\\..+\\.(clean|smudge|process)|hook\\..+\\.(command|event)|merge\\..+\\.driver|extensions\\.partialclone)$",
] as const;

export interface GitConfiguredPrograms {
	filters: string[];
	hooks: string[];
	/** Custom merge drivers (`merge.<name>.driver`); absent when none was read. */
	drivers?: string[];
	/**
	 * The repository is a partial clone (`extensions.partialClone`): a missing object would be
	 * fetched lazily, running the promisor remote's upload-pack, which `GIT_NO_LAZY_FETCH`
	 * forbids (git ≥ 2.44; older git is refused).
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
		else if (key.toLowerCase() === "extensions.partialclone") partialClone = true;
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
			"This repository is a partial clone and this git (older than 2.44) cannot be kept from fetching missing objects through its promisor remote; update git to use it with teams",
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

/** `GIT_NO_LAZY_FETCH` arrived in git 2.44 (known once the version was read; false until then). */
let noLazyFetchSupported = false;
let lazyFetchProbe: Promise<void> | null = null;

async function probeLazyFetchSupport(): Promise<void> {
	const result = await safeSpawn({
		cmd: ["git", "--version"],
		cwd: tmpdir(),
		env: { ...process.env, LC_ALL: "C" },
		timeout: 10_000,
		maxOutputBytes: 1024,
	}).catch(() => null);
	const match = /git version (\d+)\.(\d+)/.exec(result?.stdout ?? "");
	const major = Number(match?.[1] ?? 0);
	const minor = Number(match?.[2] ?? 0);
	noLazyFetchSupported = major > 2 || (major === 2 && minor >= 44);
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
