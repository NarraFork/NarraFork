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
	if (programs.partialClone && !noLazyFetchSupported())
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

/**
 * Git reads the objects and history that are really there: replacement refs (`refs/replace/*`,
 * repository content anyone who can write the repository can add) and a legacy graft file
 * (`info/grafts`) are both ignored. Either could make `merge-base --is-ancestor` call a commit
 * part of the base, or show other trees, parents or blobs to merges, diffs and stats. Added by
 * every team git command (its readers, its writes, the probes) whatever the host's environment
 * says — not by `cleanGitEnv` / `gitConfigEnv`, whose other users (a narrator's worktree, which
 * the person's own git must see the same) keep git's default view. The graft file named does not
 * exist (`/dev/null` itself would be read, with a deprecation hint); an inherited replace-ref
 * namespace or shallow file is dropped.
 */
export const TRUE_HISTORY_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
	GIT_NO_REPLACE_OBJECTS: "1",
	GIT_GRAFT_FILE: join(DEV_NULL, "no-grafts"),
	GIT_REPLACE_REF_BASE: undefined,
	GIT_SHALLOW_FILE: undefined,
});

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
		env: { ...cleanGitEnv(), ...gitConfigEnv([GIT_HARDENING_SENTINEL]) },
		timeout: 10_000,
		maxOutputBytes: 4096,
	});
	return result.exitCode === 0 && result.stdout.trim() === GIT_HARDENING_SENTINEL[1];
}

let probe: HardeningProbe = defaultProbe;
let verdict: Promise<boolean> | null = null;

// ── The environment git inherits ────────────────────────────────────────────

/**
 * Variables that route git to another repository, object store, index or template, add
 * configuration (`git -c` from a parent process), or change what is read: none may reach a
 * hardened command from the server's own environment. The host's configuration FILES
 * (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`) are the operator's and kept,
 * unless `configFiles: false` (the lazy-fetch probe, which uses none).
 */
const ROUTING_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_TEMPLATE_DIR",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_EXTERNAL_DIFF",
	"GIT_QUARANTINE_PATH",
	"GIT_PREFIX",
	"GIT_NO_LAZY_FETCH",
] as const;
const CONFIG_FILE_VARIABLES = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];

/**
 * The server's environment without anything that routes git elsewhere or adds configuration
 * (see {@link ROUTING_VARIABLES}; every `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` too). Callers add
 * their own overrides on top. How history is read (replacement refs, grafts, a shallow file) is
 * left as it is: a narrator's worktree must agree with the person's own git there. Team commands
 * add {@link TRUE_HISTORY_ENV} themselves.
 */
export function cleanGitEnv(
	base: Record<string, string | undefined> = process.env,
	options: { configFiles?: boolean } = {},
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	const drop = new Set<string>([
		...ROUTING_VARIABLES,
		...(options.configFiles === false ? CONFIG_FILE_VARIABLES : []),
	]);
	for (const [key, value] of Object.entries(base)) {
		if (
			drop.has(key) ||
			/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key) ||
			key.startsWith("GIT_INTERNAL_")
		)
			continue;
		env[key] = value;
	}
	return env;
}

// ── Lazy fetching ───────────────────────────────────────────────────────────

/** What the lazy-fetch probe found: inconclusive is never cached. */
export type LazyFetchVerdict = "supported" | "unsupported" | "inconclusive";

/** The cached verdict (supported / unsupported); null until the probe could tell. */
let lazyFetchVerdict: "supported" | "unsupported" | null = null;
let lazyFetchProbe: Promise<LazyFetchVerdict> | null = null;
let lastInconclusiveAt = 0;
/** How long after an inconclusive probe the next one waits. */
let inconclusiveBackoffMs = 30_000;

const PROBE_TIMEOUT_MS = 10_000;

type ScratchDir = (prefix: string) => Promise<string>;
let scratchDir: ScratchDir = (prefix) => mkdtemp(prefix);

/** Replace how the probe makes its scratch directory, and the retry backoff (tests). */
export function setLazyFetchProbeSeamsForTests(seams: {
	scratch?: ScratchDir | null;
	backoffMs?: number | null;
}): void {
	if (seams.scratch !== undefined) scratchDir = seams.scratch ?? ((prefix) => mkdtemp(prefix));
	if (seams.backoffMs !== undefined) inconclusiveBackoffMs = seams.backoffMs ?? 30_000;
}

/** Whether this git is known to honour `GIT_NO_LAZY_FETCH` (an unknown answer is "no"). */
const noLazyFetchSupported = () => lazyFetchVerdict === "supported";

/**
 * Whether every hardened command is already kept from fetching a missing object lazily
 * (`GIT_NO_LAZY_FETCH` honoured, as settled by {@link ensureConfigOverridesHonored}). When not,
 * a repository must be checked for partial-clone / promisor settings before any command that
 * reads objects (`untrustedProgramOverrides` refuses it).
 */
export const lazyFetchPrevented = (): boolean => noLazyFetchSupported();

/**
 * Probe the behaviour itself: a scratch partial clone whose promisor remote (a scratch
 * repository next to it) holds a blob the clone lacks. With `GIT_NO_LAZY_FETCH=1` `cat-file -e`
 * must fail; without it (explicitly unset), the same command must fetch the blob and succeed.
 * `supported` when both hold, `unsupported` when the blob was fetched despite the variable, and
 * `inconclusive` when anything else went wrong (no scratch space, git failing, the control not
 * fetching): that answer is not cached. Every command runs with a clean environment — nothing
 * inherited routes it to another repository or adds configuration — and a timeout; the scratch
 * directory is removed afterwards. Never rejects.
 */
export async function probeLazyFetch(): Promise<LazyFetchVerdict> {
	let dir: string | null = null;
	try {
		dir = await scratchDir(join(tmpdir(), "nf-lazy-fetch-"));
		const git = (cwd: string, args: string[], env: Record<string, string | undefined> = {}) =>
			safeSpawn({
				cmd: ["git", "-C", cwd, ...args],
				env: {
					...cleanGitEnv(process.env, { configFiles: false }),
					LC_ALL: "C",
					GIT_TERMINAL_PROMPT: "0",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: DEV_NULL,
					GIT_CEILING_DIRECTORIES: dir ?? undefined,
					...TRUE_HISTORY_ENV,
					...env,
				},
				timeout: PROBE_TIMEOUT_MS,
				maxOutputBytes: 4096,
				killProcessTree: true,
			});
		const source = join(dir, "source");
		const clone = join(dir, "clone");
		await mkdir(source);
		await mkdir(clone);
		if ((await git(source, ["init", "-q"])).exitCode !== 0) return "inconclusive";
		await writeFile(join(source, "blob"), "narrafork lazy fetch probe\n");
		const blob = await git(source, ["hash-object", "-w", "blob"]);
		const oid = blob.stdout.trim();
		if (blob.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(oid)) return "inconclusive";
		for (const args of [
			["config", "uploadpack.allowAnySHA1InWant", "true"],
			["config", "uploadpack.allowFilter", "true"],
		])
			if ((await git(source, args)).exitCode !== 0) return "inconclusive";
		if ((await git(clone, ["init", "-q"])).exitCode !== 0) return "inconclusive";
		for (const args of [
			["config", "core.repositoryformatversion", "1"],
			["config", "extensions.partialClone", "probe"],
			["config", "remote.probe.url", source],
			["config", "remote.probe.promisor", "true"],
		])
			if ((await git(clone, args)).exitCode !== 0) return "inconclusive";
		const lookup = ["-c", "protocol.file.allow=always", "cat-file", "-e", oid];
		const refused = await git(clone, lookup, { GIT_NO_LAZY_FETCH: "1" });
		if (refused.exitCode === 0) return "unsupported";
		const control = await git(clone, lookup, { GIT_NO_LAZY_FETCH: undefined });
		return control.exitCode === 0 ? "supported" : "inconclusive";
	} catch {
		return "inconclusive";
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/** The boolean form of {@link probeLazyFetch} (supported or not). */
export async function probeLazyFetchHonoured(): Promise<boolean> {
	return (await probeLazyFetch()) === "supported";
}

/**
 * Settle the lazy-fetch verdict once (single-flight): a supported or unsupported answer is kept
 * for the process, an inconclusive one is not (the next call after the backoff probes again).
 * Meanwhile partial clones and promisor remotes are refused, everything else proceeds.
 */
async function settleLazyFetchVerdict(): Promise<void> {
	if (lazyFetchVerdict !== null) return;
	if (!lazyFetchProbe && Date.now() - lastInconclusiveAt < inconclusiveBackoffMs) return;
	lazyFetchProbe ??= probeLazyFetch()
		.catch((): LazyFetchVerdict => "inconclusive")
		.then((verdict) => {
			if (verdict === "inconclusive") lastInconclusiveAt = Date.now();
			else lazyFetchVerdict = verdict;
			lazyFetchProbe = null;
			return verdict;
		});
	await lazyFetchProbe;
}

/** Force the lazy-fetch verdict (tests); null forgets it so git is probed again. */
export function setNoLazyFetchSupportForTests(supported: boolean | null): void {
	lazyFetchProbe = null;
	lastInconclusiveAt = 0;
	lazyFetchVerdict = supported === null ? null : supported ? "supported" : "unsupported";
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
	await settleLazyFetchVerdict();
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
