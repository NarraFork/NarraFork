/**
 * The git a team's merge (M) and work start (W) write, all in the project's repository and
 * never in a person's checkout except on an explicit 「在该目录中快进」:
 *
 * - `mergeTree` / `commitTree`: the merge is computed in the object store (`merge-tree
 *   --write-tree`, git ≥ 2.38) and committed with `commit-tree` (always a merge commit; the
 *   clicking person's identity; `-S` when `commit.gpgsign` is on). No working tree, no index, no
 *   merge state anywhere.
 * - `setPrivateRef` / `deletePrivateRef` / `listPrivateRefs`: the merge commit is parked at
 *   `refs/narrafork/team-merges/<itemId>` (out of `git branch`, safe from gc), created only if
 *   absent or moved only from the value read.
 * - `fastForwardBase`: `git fetch . M:refs/heads/<base>` moves the base only by a fast-forward and
 *   is refused by git itself when the base is checked out in any worktree (never `update-ref` on
 *   a checked-out base: that person's `git status` would show the merge reversed).
 * - `fetchBaseFromOrigin`: `origin/<base>` into the remote-tracking ref only.
 * - `inspectCheckout` / `fastForwardCheckout`: the explicit fast-forward of a person's checkout
 *   (`merge --ff-only`), refused unless the checkout is exactly where the merge was prepared.
 *
 * Every command runs with the hardening of `git-exec-hardening.ts` (no hook of any kind, no
 * fsmonitor, external diff, filters, configuration-defined hooks or custom merge drivers from the
 * repository; signing programs only from the host's own configuration), with a timeout and an
 * output cap. Network commands keep the host's credentials and proxy and never prompt.
 */
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { TEAM_MERGE_CONFLICTS_MAX, TEAM_MERGE_REF_PREFIX } from "@shared/project-teams";
import { AppError, GitError } from "../../lib/errors";
import {
	ensureConfigOverridesHonored,
	GIT_NO_EXEC_CONFIG,
	gitConfigEnv,
	untrustedProgramOverrides,
} from "../../lib/git-exec-hardening";
import type { GitIdentityEnv } from "../../lib/git-identity";
import { envWithAmbientProxy } from "../../lib/net/proxy-env";
import { DEV_NULL } from "../../lib/platform";
import { safeSpawn } from "../../lib/spawn";
import { configuredPrograms } from "./team-git";

/** Ordinary reads and ref writes. */
const SHORT_TIMEOUT_MS = 30_000;
const SMALL_OUTPUT_BYTES = 64 * 1024;
/** `merge-tree` and `merge --ff-only`: the design's 120 s and 1 MB. */
const MERGE_TIMEOUT_MS = 120_000;
const MERGE_OUTPUT_BYTES = 1024 * 1024;
/** Network fetch from origin. */
const FETCH_TIMEOUT_MS = 120_000;
/** Private refs listed at once (one line each). */
const PRIVATE_REFS_OUTPUT_BYTES = 256 * 1024;
/** `merge-tree --write-tree` arrived in git 2.38. */
export const MERGE_TREE_MIN_GIT: readonly [number, number] = [2, 38];

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

type ConfigEntries = ReadonlyArray<readonly [string, string]>;

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	truncated: boolean;
	timedOut: boolean;
}

async function run(
	cwd: string,
	args: readonly string[],
	options: {
		config: ConfigEntries;
		timeout?: number;
		maxOutputBytes?: number;
		env?: Record<string, string | undefined>;
		network?: boolean;
	},
): Promise<RunResult> {
	await ensureConfigOverridesHonored();
	const base = options.network ? envWithAmbientProxy() : { ...process.env };
	const result = await safeSpawn({
		cmd: ["git", "--no-optional-locks", "-C", cwd, ...args],
		env: {
			...base,
			GIT_DIR: undefined,
			GIT_COMMON_DIR: undefined,
			GIT_WORK_TREE: undefined,
			GIT_INDEX_FILE: undefined,
			GIT_EXTERNAL_DIFF: undefined,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: undefined,
			SSH_ASKPASS: undefined,
			LC_ALL: "C",
			LANG: "C",
			...(options.env ?? {}),
			...gitConfigEnv(options.config),
		},
		timeout: options.timeout ?? SHORT_TIMEOUT_MS,
		maxOutputBytes: options.maxOutputBytes ?? SMALL_OUTPUT_BYTES,
		killProcessTree: true,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
		timedOut: result.terminationReason === "timeout",
	};
}

/** The first line of git's complaint, for an error message (never the whole output). */
function complaint(result: RunResult): string {
	const line = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map((text) => text.trim())
		.find(Boolean);
	if (result.timedOut) return "git timed out";
	return (line ?? `exit code ${result.exitCode}`).slice(0, 300);
}

function assertSha(value: string): void {
	if (!SHA.test(value)) throw new GitError("Expected a full commit SHA");
}

function assertBranch(branch: string): void {
	if (
		!branch ||
		branch.startsWith("-") ||
		branch.startsWith("refs/") ||
		/[\s~^:?*[\\\0]|\.\.|@\{/.test(branch)
	)
		throw new GitError(`Not a branch name: ${branch}`);
}

function privateRef(itemId: string): string {
	if (!ITEM_ID.test(itemId)) throw new GitError("Unexpected work item id");
	return `${TEAM_MERGE_REF_PREFIX}${itemId}`;
}

// ── Versions ────────────────────────────────────────────────────────────────

let versionProbe: Promise<[number, number, number] | null> | null = null;

/** This host's git version (once per process; null when unreadable). */
export function gitVersion(): Promise<[number, number, number] | null> {
	versionProbe ??= safeSpawn({
		cmd: ["git", "--version"],
		env: { ...process.env, LC_ALL: "C" },
		timeout: 10_000,
		maxOutputBytes: 1024,
	})
		.then((result) => {
			const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout);
			if (result.exitCode !== 0 || !match) return null;
			return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] as [
				number,
				number,
				number,
			];
		})
		.catch(() => null);
	return versionProbe;
}

/** The cached version, without waiting (null until read or when unreadable). */
let knownVersion: [number, number, number] | null | undefined;
export function peekGitVersion(): [number, number, number] | null | undefined {
	if (knownVersion === undefined)
		void gitVersion().then((version) => {
			knownVersion = version;
		});
	return knownVersion;
}

/** Whether a version can compute a merge in the object store. */
export function supportsMergeTree(version: readonly number[] | null | undefined): boolean {
	if (!version) return false;
	const [major = 0, minor = 0] = version;
	const [needMajor, needMinor] = MERGE_TREE_MIN_GIT;
	return major > needMajor || (major === needMajor && minor >= needMinor);
}

/** Replace the version (tests); null forgets it so the real git is asked again. */
export function setGitVersionForTests(version: [number, number, number] | null | "real"): void {
	if (version === "real") {
		versionProbe = null;
		knownVersion = undefined;
		return;
	}
	versionProbe = Promise.resolve(version);
	knownVersion = version;
}

// ── Signing ─────────────────────────────────────────────────────────────────

/** Signing programs and the value git falls back to when a key is unset. */
const SIGNING_PROGRAMS: Readonly<Record<string, string>> = {
	"gpg.program": "gpg",
	"gpg.openpgp.program": "gpg",
	"gpg.x509.program": "gpgsm",
	"gpg.ssh.program": "ssh-keygen",
	"gpg.ssh.defaultkeycommand": "",
};
const HOST_SCOPES = new Set(["system", "global"]);

/**
 * Whether commits are signed (`commit.gpgsign`), and overrides that keep any signing program
 * named by the repository's own configuration (local or worktree scope, which agents can write)
 * from running: such a key is set back to the host's value, or to git's default.
 */
export async function signingConfig(
	repo: string,
	config: ConfigEntries,
): Promise<{ sign: boolean; overrides: Array<readonly [string, string]> }> {
	const result = await run(
		repo,
		["config", "-z", "--show-scope", "--get-regexp", "^(commit\\.gpgsign|gpg\\..*)$"],
		{ config },
	);
	if (result.exitCode === 1 && !result.stdout) return { sign: false, overrides: [] };
	if (result.exitCode !== 0 || result.truncated)
		throw new GitError("git config could not read the signing configuration");
	let sign = false;
	const host = new Map<string, string>();
	const repository = new Set<string>();
	const records = result.stdout.split("\0");
	for (let index = 0; index + 1 < records.length; index += 2) {
		const scope = records[index] ?? "";
		const record = records[index + 1] ?? "";
		const newline = record.indexOf("\n");
		const key = (newline < 0 ? record : record.slice(0, newline)).toLowerCase();
		const value = newline < 0 ? "true" : record.slice(newline + 1);
		if (key === "commit.gpgsign") sign = /^(true|yes|on|1)$/i.test(value.trim());
		else if (key in SIGNING_PROGRAMS) {
			if (HOST_SCOPES.has(scope)) {
				host.set(key, value);
				repository.delete(key);
			} else repository.add(key);
		}
	}
	const overrides = [...repository].map(
		(key) => [key, host.get(key) ?? SIGNING_PROGRAMS[key] ?? ""] as const,
	);
	return { sign, overrides };
}

// ── The repository's git ────────────────────────────────────────────────────

export type MergeTreeResult =
	| { clean: true; tree: string }
	| { clean: false; conflicts: string[]; more: boolean };

export type FastForwardBaseResult =
	| { outcome: "updated" }
	| { outcome: "checked_out"; path: string | null }
	| { outcome: "non_fast_forward" };

/** The hardened, writing git of one repository (the project's main checkout). */
export interface TeamRepoGit {
	/** `git remote get-url --push origin` (insteadOf and pushurl applied); null without origin. */
	originPushUrl(): Promise<string | null>;
	resolve(ref: string): Promise<string | null>;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	mergeTree(ours: string, theirs: string): Promise<MergeTreeResult>;
	commitTree(input: {
		tree: string;
		parents: readonly string[];
		message: string;
		identity: GitIdentityEnv | null;
	}): Promise<string>;
	/** Create the private ref (only if absent: `expected` null) or move it from `expected`. */
	setPrivateRef(itemId: string, commit: string, expected: string | null): Promise<void>;
	/** Delete the private ref if it still holds `expected` (false when it did not). */
	deletePrivateRef(itemId: string, expected: string): Promise<boolean>;
	listPrivateRefs(): Promise<{ itemId: string; commit: string }[]>;
	fastForwardBase(commit: string, base: string): Promise<FastForwardBaseResult>;
	/** The checkout `refs/heads/<branch>` is checked out in, or null. */
	checkedOutAt(branch: string): Promise<string | null>;
	/** `origin/<base>` into `refs/remotes/origin/<base>` only; the error text when it failed. */
	fetchBaseFromOrigin(base: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

export function teamRepoGit(repo: string): TeamRepoGit {
	let overrides: Promise<ConfigEntries> | null = null;
	const config = () => {
		overrides ??= configuredPrograms(repo).then((programs) => [
			...GIT_NO_EXEC_CONFIG,
			...untrustedProgramOverrides(programs),
		]);
		return overrides;
	};
	const git = async (
		args: readonly string[],
		options: Omit<Parameters<typeof run>[2], "config"> = {},
	) => run(repo, args, { ...options, config: await config() });

	const resolve = async (ref: string): Promise<string | null> => {
		if (!ref || ref.startsWith("-")) throw new GitError("Expected a ref");
		const result = await git([
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${ref}^{commit}`,
		]);
		if (result.exitCode === 1) return null;
		const sha = result.stdout.trim();
		if (result.exitCode !== 0 || !SHA.test(sha))
			throw new GitError(`git rev-parse could not read ${ref}: ${complaint(result)}`);
		return sha;
	};

	const checkedOutAt = async (branch: string): Promise<string | null> => {
		assertBranch(branch);
		const result = await git(["worktree", "list", "--porcelain", "-z"], {
			maxOutputBytes: PRIVATE_REFS_OUTPUT_BYTES,
		});
		if (result.exitCode !== 0 || result.truncated)
			throw new GitError(`git worktree list failed: ${complaint(result)}`);
		let path: string | null = null;
		for (const field of result.stdout.split("\0")) {
			if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
			else if (field === `branch refs/heads/${branch}` && path) return path;
			else if (field === "") path = null;
		}
		return null;
	};

	return {
		async originPushUrl() {
			const result = await git(["remote", "get-url", "--push", "origin"], {
				maxOutputBytes: 16 * 1024,
			});
			// Exit 2: no such remote.
			if (result.exitCode === 2) return null;
			if (result.exitCode !== 0 || result.truncated)
				throw new GitError("git remote could not read origin");
			return result.stdout.trim() || null;
		},
		resolve,
		async isAncestor(ancestor, descendant) {
			assertSha(ancestor);
			assertSha(descendant);
			const result = await git(["merge-base", "--is-ancestor", ancestor, descendant]);
			if (result.exitCode === 0) return true;
			if (result.exitCode === 1 && !result.stderr.trim()) return false;
			throw new GitError(`git merge-base failed: ${complaint(result)}`);
		},
		async mergeTree(ours, theirs) {
			assertSha(ours);
			assertSha(theirs);
			const result = await git(
				["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", ours, theirs],
				{ timeout: MERGE_TIMEOUT_MS, maxOutputBytes: MERGE_OUTPUT_BYTES },
			);
			// `<tree>\0` then, on conflict, each conflicting path `\0`-terminated.
			const fields = result.stdout.split("\0");
			const tree = fields[0] ?? "";
			if (result.exitCode === 0 && SHA.test(tree) && !result.truncated)
				return { clean: true, tree };
			if (result.exitCode === 1 && SHA.test(tree)) {
				const paths = fields.slice(1).filter(Boolean);
				// A cut listing loses its last, possibly partial, path.
				if (result.truncated) paths.pop();
				const unique = [...new Set(paths)];
				return {
					clean: false,
					conflicts: unique.slice(0, TEAM_MERGE_CONFLICTS_MAX),
					more: result.truncated || unique.length > TEAM_MERGE_CONFLICTS_MAX,
				};
			}
			throw new GitError(`git merge-tree failed: ${complaint(result)}`);
		},
		async commitTree({ tree, parents, message, identity }) {
			assertSha(tree);
			for (const parent of parents) assertSha(parent);
			const base = await config();
			const signing = await signingConfig(repo, base);
			const result = await run(
				repo,
				[
					"commit-tree",
					...(signing.sign ? ["-S"] : []),
					...parents.flatMap((parent) => ["-p", parent]),
					"-m",
					message,
					tree,
				],
				{ config: [...base, ...signing.overrides], env: identity ?? undefined },
			);
			const commit = result.stdout.trim();
			if (
				result.exitCode !== 0 &&
				/identity unknown|tell me who you are|empty ident/i.test(result.stderr)
			)
				throw new AppError(
					"No git identity to commit the merge with: set yours in NarraFork (Settings, Git identities) or the host's git user.name and user.email",
					409,
					"TEAM_MERGE_IDENTITY_UNKNOWN",
				);
			if (result.exitCode !== 0 || !SHA.test(commit))
				throw new GitError(`git commit-tree failed: ${complaint(result)}`);
			return commit;
		},
		async setPrivateRef(itemId, commit, expected) {
			assertSha(commit);
			if (expected !== null) assertSha(expected);
			const result = await git([
				"update-ref",
				"-m",
				"narrafork: team merge",
				privateRef(itemId),
				commit,
				expected ?? "",
			]);
			if (result.exitCode !== 0)
				throw new GitError(`git update-ref could not keep the merge commit: ${complaint(result)}`);
		},
		async deletePrivateRef(itemId, expected) {
			assertSha(expected);
			const result = await git(["update-ref", "-d", privateRef(itemId), expected]);
			return result.exitCode === 0;
		},
		async listPrivateRefs() {
			const result = await git(
				["for-each-ref", "--format=%(objectname) %(refname)", TEAM_MERGE_REF_PREFIX],
				{ maxOutputBytes: PRIVATE_REFS_OUTPUT_BYTES },
			);
			if (result.exitCode !== 0 || result.truncated)
				throw new GitError(`git for-each-ref failed: ${complaint(result)}`);
			const refs: { itemId: string; commit: string }[] = [];
			for (const line of result.stdout.split("\n")) {
				const [commit, name] = line.trim().split(" ");
				if (!commit || !name?.startsWith(TEAM_MERGE_REF_PREFIX) || !SHA.test(commit)) continue;
				const itemId = name.slice(TEAM_MERGE_REF_PREFIX.length);
				if (ITEM_ID.test(itemId)) refs.push({ itemId, commit });
			}
			return refs;
		},
		async fastForwardBase(commit, base) {
			assertSha(commit);
			assertBranch(base);
			const result = await git(
				[
					"fetch",
					"--no-write-fetch-head",
					"--no-tags",
					"--no-recurse-submodules",
					"--no-auto-maintenance",
					// Not quiet: a refusal says why (checked out, non-fast-forward) only on stderr.
					".",
					`${commit}:refs/heads/${base}`,
				],
				{ timeout: MERGE_TIMEOUT_MS },
			);
			if (result.exitCode === 0) return { outcome: "updated" };
			const text = `${result.stderr}\n${result.stdout}`;
			if (/refusing to fetch into branch/i.test(text)) {
				const quoted = /checked out at '([^']+)'/.exec(text)?.[1] ?? null;
				return { outcome: "checked_out", path: quoted ?? (await checkedOutAt(base)) };
			}
			if (/non-fast-forward|\[rejected\]|rejected/i.test(text))
				return { outcome: "non_fast_forward" };
			throw new GitError(`git fetch could not update ${base}: ${complaint(result)}`);
		},
		checkedOutAt,
		async fetchBaseFromOrigin(base) {
			assertBranch(base);
			const hardened = await config();
			// The host's own credentials and proxy drive a fetch (as the git panel's): the credential
			// helper and ssh command are not emptied, nothing prompts, and nothing from the
			// repository runs as a transport (`ext::`, a local upload-pack, a git proxy).
			const network = hardened.filter(
				([key]) =>
					key !== "credential.helper" && key !== "core.sshCommand" && key !== "core.askPass",
			);
			const sshConfigured = await git(["config", "--get", "core.sshCommand"]);
			const result = await run(
				repo,
				[
					"fetch",
					"--no-write-fetch-head",
					"--no-tags",
					"--no-recurse-submodules",
					"--no-auto-maintenance",
					"--quiet",
					"origin",
					`+refs/heads/${base}:refs/remotes/origin/${base}`,
				],
				{
					config: [
						...network,
						["protocol.ext.allow", "never"],
						["remote.origin.uploadpack", "git-upload-pack"],
						["core.gitProxy", ""],
					],
					network: true,
					timeout: FETCH_TIMEOUT_MS,
					env:
						sshConfigured.exitCode === 0 && sshConfigured.stdout.trim()
							? undefined
							: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
				},
			);
			return result.exitCode === 0 ? { ok: true } : { ok: false, message: complaint(result) };
		},
	};
}

// ── A person's checkout: the explicit fast-forward ──────────────────────────

/** Files in a git directory that mean an operation is in progress there. */
const IN_PROGRESS_MARKERS = [
	"MERGE_HEAD",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"BISECT_LOG",
	"rebase-merge",
	"rebase-apply",
	"sequencer",
] as const;

export type CheckoutBlocker =
	| "stale"
	| "not_on_base"
	| "operation_in_progress"
	| "index_locked"
	| "local_config"
	| "unreadable";

/** Configuration of the checkout's own scope (local / worktree) that rules out a fast-forward. */
async function localProgramsOf(dir: string): Promise<boolean> {
	const result = await run(
		dir,
		[
			"config",
			"-z",
			"--show-scope",
			"--get-regexp",
			"^(filter\\..+\\.(clean|smudge|process)|core\\.hookspath)$",
		],
		{ config: GIT_NO_EXEC_CONFIG.filter(([key]) => key !== "core.hooksPath") },
	);
	if (result.exitCode === 1 && !result.stdout) return false;
	if (result.exitCode !== 0 || result.truncated)
		throw new GitError("git config could not read the checkout's filters and hooks");
	const records = result.stdout.split("\0");
	for (let index = 0; index + 1 < records.length; index += 2)
		if (!HOST_SCOPES.has(records[index] ?? "")) return true;
	return false;
}

/**
 * Whether a person's checkout is exactly where a prepared merge can be fast-forwarded: HEAD is on
 * the base and the base still holds the commit the merge was computed on, no merge, rebase,
 * cherry-pick, revert or bisect is in progress, the index is not locked, and the checkout's own
 * configuration names no filter and no hooks directory (those would run, or be skipped, inside a
 * person's working tree: only the copyable command is offered then). Reads only.
 */
export async function inspectCheckout(
	dir: string,
	base: string,
	baseSha: string,
): Promise<CheckoutBlocker | null> {
	assertBranch(base);
	assertSha(baseSha);
	try {
		const config = [...GIT_NO_EXEC_CONFIG];
		const head = await run(dir, ["symbolic-ref", "--quiet", "HEAD"], { config });
		if (head.exitCode !== 0 || head.stdout.trim() !== `refs/heads/${base}`) return "not_on_base";
		const at = await run(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`], {
			config,
		});
		if (at.exitCode !== 0) return "unreadable";
		if (at.stdout.trim() !== baseSha) return "stale";
		const gitDir = await run(dir, ["rev-parse", "--absolute-git-dir"], { config });
		const path = gitDir.stdout.trim();
		if (gitDir.exitCode !== 0 || !path) return "unreadable";
		const exists = async (name: string) =>
			(await stat(join(path, name)).catch(() => null)) !== null;
		for (const marker of IN_PROGRESS_MARKERS)
			if (await exists(marker)) return "operation_in_progress";
		if (await exists("index.lock")) return "index_locked";
		if (await localProgramsOf(dir)) return "local_config";
		return null;
	} catch {
		return "unreadable";
	}
}

/** The canonical form of a checkout path (realpath when it exists). */
export async function canonicalCheckout(path: string): Promise<string> {
	return realpath(path).catch(() => path);
}

/**
 * `git merge --ff-only <ref>` in a person's checkout, every hook off (`core.hooksPath` and the
 * configuration-defined ones by name). The host's own filters still run, as they would for the
 * person (the checkout's own were ruled out by {@link inspectCheckout}). When git refuses
 * (local changes that the merge would overwrite), nothing changed: the files git named are
 * returned.
 */
export async function fastForwardCheckout(
	dir: string,
	ref: string,
): Promise<{ ok: true } | { ok: false; files: string[]; message: string }> {
	if (!ref.startsWith(TEAM_MERGE_REF_PREFIX)) throw new GitError("Unexpected merge ref");
	const programs = await configuredPrograms(dir);
	const config = [
		...GIT_NO_EXEC_CONFIG,
		["core.hooksPath", DEV_NULL] as const,
		...programs.hooks.map((name) => [`hook.${name}.enabled`, "false"] as const),
	];
	const result = await run(dir, ["merge", "--ff-only", "--no-edit", "--quiet", ref], {
		config,
		timeout: MERGE_TIMEOUT_MS,
		maxOutputBytes: SMALL_OUTPUT_BYTES,
	});
	if (result.exitCode === 0) return { ok: true };
	const files = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.filter((line) => /^\t/.test(line))
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, TEAM_MERGE_CONFLICTS_MAX);
	return { ok: false, files, message: complaint(result) };
}

/** The command a person runs instead of 「在该目录中快进」. */
export function fastForwardCommand(dir: string, itemId: string): string {
	const quote = (value: string) =>
		/^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
	return `git -C ${quote(dir)} merge --ff-only ${privateRef(itemId)}`;
}
