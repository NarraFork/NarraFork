/**
 * The git a team's merge (M) and work start (W) write, all in the project's repository and
 * never in a person's checkout except on an explicit 「在该目录中快进」:
 *
 * - `mergeTree` / `commitTree`: the merge is computed in the object store (`merge-tree
 *   --write-tree`, git ≥ 2.38) and committed with `commit-tree` (always a merge commit; the
 *   clicking person's identity, else the host's global identity; `-S` when the host's
 *   `commit.gpgsign` is on). No working tree, no index, no merge state anywhere.
 * - `setPrivateRef` / `deletePrivateRef` / `listPrivateRefs`: the merge commit is parked at
 *   `refs/narrafork/team-merges/<itemId>` (out of `git branch`, safe from gc), created only if
 *   absent or moved only from the value read.
 * - `fastForwardBase`: `git fetch . M:refs/heads/<base>` moves the base only by a fast-forward and
 *   is refused by git itself when the base is checked out in any worktree (never `update-ref` on
 *   a checked-out base: that person's `git status` would show the merge reversed).
 * - `fetchBaseFromOrigin`: `origin/<base>` into the remote-tracking ref only.
 * - `pushBranch` (G): the item's pinned head to `refs/heads/<branch>` at origin's push URL —
 *   named explicitly, so no `remote.*` setting applies — never forced, no hook, no signing, no
 *   submodule recursion, no push option, the receive-pack program pinned, and the same credential
 *   and transport rules as the fetch.
 * - `inspectCheckout` / `fastForwardCheckout`: the explicit fast-forward of a person's checkout
 *   (`merge --ff-only`), refused unless the checkout is exactly where the merge was prepared, and
 *   checked afterwards (no unmerged entry, no new stash, HEAD still on the base at the merge).
 *
 * The rule for every command here: nothing from the repository's own configuration (local or
 * worktree scope, which agents can write — `.git/config` is shared by every worktree) may run a
 * program or choose credentials, transport or identity. Sensitive keys are read with
 * `--show-scope` (`scopedConfig`); only system and global values are honoured, and a repository
 * value is overridden at command scope with the host's value or a neutral one — or, where no
 * neutral value exists, the command is refused. On top of that every command carries the
 * hardening of `git-exec-hardening.ts` (no hook of any kind, no fsmonitor, external diff, filters,
 * configuration-defined hooks or custom merge drivers), re-read right before each command that
 * can run a program, plus a timeout, an output cap and the job's abort signal.
 */
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { TEAM_MERGE_CONFLICTS_MAX, TEAM_MERGE_REF_PREFIX } from "@shared/project-teams";
import { AppError, GitError } from "../../lib/errors";
import {
	cleanGitEnv,
	GIT_NO_EXEC_CONFIG,
	gitConfigEnv,
	TRUE_HISTORY_ENV,
	untrustedProgramOverrides,
} from "../../lib/git-exec-hardening";
import type { GitIdentityEnv } from "../../lib/git-identity";
import { envWithAmbientProxy } from "../../lib/net/proxy-env";
import { DEV_NULL } from "../../lib/platform";
import { safeSpawn } from "../../lib/spawn";
import { assertTrueHistory, configuredPrograms, prepareTeamRepo } from "./team-git";

/** Ordinary reads and ref writes. */
const SHORT_TIMEOUT_MS = 30_000;
const SMALL_OUTPUT_BYTES = 64 * 1024;
/** `merge-tree` and `merge --ff-only`: the design's 120 s and 1 MB. */
const MERGE_TIMEOUT_MS = 120_000;
const MERGE_OUTPUT_BYTES = 1024 * 1024;
/** Network fetch from origin. */
const FETCH_TIMEOUT_MS = 120_000;
/** G: the push of an item's branch: 120 s, 64 KB. */
const PUSH_TIMEOUT_MS = 120_000;
const PUSH_OUTPUT_BYTES = 64 * 1024;
/** Private refs one listing returns (the rest on the next call). */
export const PRIVATE_REFS_PAGE = 1000;
/** Private refs deleted in one `update-ref --stdin` transaction. */
const DELETE_BATCH = 200;
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
		signal?: AbortSignal;
		stdoutStream?: { maxBytes: number; onChunk: (chunk: Uint8Array) => boolean | undefined };
		stdin?: Uint8Array;
	},
): Promise<RunResult> {
	options.signal?.throwIfAborted();
	// Before anything that could read an object: no lazy fetch through a promisor remote.
	await prepareTeamRepo(cwd);
	options.signal?.throwIfAborted();
	// Nothing inherited routes git to another repository, object store or configuration.
	const base = cleanGitEnv(options.network ? envWithAmbientProxy() : process.env);
	const result = await safeSpawn({
		cmd: ["git", "--no-optional-locks", "-C", cwd, ...args],
		env: {
			...base,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: undefined,
			SSH_ASKPASS: undefined,
			LC_ALL: "C",
			LANG: "C",
			...(options.env ?? {}),
			...gitConfigEnv(options.config),
			// Replacement refs and grafts are never read (`TRUE_HISTORY_ENV`).
			...TRUE_HISTORY_ENV,
		},
		timeout: options.timeout ?? SHORT_TIMEOUT_MS,
		maxOutputBytes: options.maxOutputBytes ?? SMALL_OUTPUT_BYTES,
		...(options.stdoutStream
			? { stdoutStream: options.stdoutStream, maxStderrBytes: SMALL_OUTPUT_BYTES }
			: {}),
		signal: options.signal,
		...(options.stdin ? { stdin: options.stdin } : {}),
		killProcessTree: true,
	});
	options.signal?.throwIfAborted();
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
		env: { ...cleanGitEnv(), LC_ALL: "C" },
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

// ── Configuration by scope ──────────────────────────────────────────────────

/** One configuration value with the scope it came from (`system`, `global`, `local`, …). */
export interface ScopedConfigEntry {
	scope: string;
	/** As `--get-regexp` prints it: section and name lowercased, a subsection as written. */
	key: string;
	value: string;
}

const HOST_SCOPES = new Set(["system", "global"]);

/** A value the repository's own configuration set (anything but system, global or command). */
const isRepositoryScope = (scope: string) => !HOST_SCOPES.has(scope) && scope !== "command";

/**
 * The configured values matching `pattern` with their scopes, in git's order (system, global,
 * local, worktree). Command-scope values (NarraFork's own overrides) are left out. Reading
 * configuration runs nothing.
 */
export async function scopedConfig(
	cwd: string,
	pattern: string,
	signal?: AbortSignal,
): Promise<ScopedConfigEntry[]> {
	const result = await run(cwd, ["config", "-z", "--show-scope", "--get-regexp", pattern], {
		config: GIT_NO_EXEC_CONFIG,
		signal,
	});
	if (result.exitCode === 1 && !result.stdout) return [];
	if (result.exitCode !== 0 || result.truncated)
		throw new GitError(`git config could not read ${pattern}`);
	const entries: ScopedConfigEntry[] = [];
	const records = result.stdout.split("\0");
	for (let index = 0; index + 1 < records.length; index += 2) {
		const scope = records[index] ?? "";
		const record = records[index + 1] ?? "";
		const newline = record.indexOf("\n");
		const key = newline < 0 ? record : record.slice(0, newline);
		// A bare `[section] key` (no `=`) is a boolean true.
		const value = newline < 0 ? "true" : record.slice(newline + 1);
		if (scope !== "command") entries.push({ scope, key, value });
	}
	return entries;
}

/** Every host (system/global) value of a key, in order. */
export function hostValues(entries: readonly ScopedConfigEntry[], key: string): string[] {
	return entries
		.filter((entry) => entry.key === key && HOST_SCOPES.has(entry.scope))
		.map((entry) => entry.value);
}

/** The effective host value of a key (the last system/global one). */
export function hostValue(entries: readonly ScopedConfigEntry[], key: string): string | undefined {
	return hostValues(entries, key).at(-1);
}

/** The keys the repository's own configuration sets, in first-seen order. */
export function repositoryKeys(entries: readonly ScopedConfigEntry[]): string[] {
	return [...new Set(entries.filter((entry) => isRepositoryScope(entry.scope)).map((e) => e.key))];
}

const truthy = (value: string | undefined) =>
	value !== undefined && /^(true|yes|on|1)$/i.test(value.trim());

// ── Signing and identity ────────────────────────────────────────────────────

/** Signing keys and the value git uses when a key is unset. */
const SIGNING_DEFAULTS: Readonly<Record<string, string>> = {
	"gpg.program": "gpg",
	"gpg.openpgp.program": "gpg",
	"gpg.x509.program": "gpgsm",
	"gpg.ssh.program": "ssh-keygen",
	"gpg.ssh.defaultkeycommand": "",
	"gpg.format": "openpgp",
	"user.signingkey": "",
};

/**
 * Whether commits are signed (the host's `commit.gpgsign` only), and overrides that set every
 * signing key the repository's own configuration names (`gpg.*program`, `gpg.format`,
 * `gpg.ssh.defaultKeyCommand`, `user.signingKey`) back to the host's value, or git's default.
 */
export async function signingConfig(
	repo: string,
	signal?: AbortSignal,
): Promise<{ sign: boolean; overrides: Array<readonly [string, string]> }> {
	const entries = await scopedConfig(
		repo,
		"^(commit\\.gpgsign|gpg\\..*|user\\.signingkey)$",
		signal,
	);
	const overrides: Array<readonly [string, string]> = [];
	for (const key of repositoryKeys(entries)) {
		const lower = key.toLowerCase();
		if (lower === "commit.gpgsign") continue;
		if (lower in SIGNING_DEFAULTS || /^gpg\..*program$/.test(lower))
			overrides.push([key, hostValue(entries, key) ?? SIGNING_DEFAULTS[lower] ?? ""]);
	}
	return { sign: truthy(hostValue(entries, "commit.gpgsign")), overrides };
}

/**
 * The host's own git identity (system/global `user.*`, with `author.*` / `committer.*` over it),
 * never the repository's. Null when the host has none.
 */
export async function hostIdentity(
	repo: string,
	signal?: AbortSignal,
): Promise<GitIdentityEnv | null> {
	const entries = await scopedConfig(repo, "^(user|author|committer)\\.(name|email)$", signal);
	const name = hostValue(entries, "user.name");
	const email = hostValue(entries, "user.email");
	const authorName = hostValue(entries, "author.name") ?? name;
	const authorEmail = hostValue(entries, "author.email") ?? email;
	const committerName = hostValue(entries, "committer.name") ?? name;
	const committerEmail = hostValue(entries, "committer.email") ?? email;
	if (
		!authorName?.trim() ||
		!authorEmail?.trim() ||
		!committerName?.trim() ||
		!committerEmail?.trim()
	)
		return null;
	return {
		GIT_AUTHOR_NAME: authorName,
		GIT_AUTHOR_EMAIL: authorEmail,
		GIT_COMMITTER_NAME: committerName,
		GIT_COMMITTER_EMAIL: committerEmail,
	};
}

function identityUnknown(): AppError {
	return new AppError(
		"No git identity to commit the merge with: set yours in NarraFork (Settings, Git identities) or the host's global git user.name and user.email",
		409,
		"TEAM_MERGE_IDENTITY_UNKNOWN",
	);
}

// ── Network ─────────────────────────────────────────────────────────────────

const NETWORK_PATTERN =
	"^(credential\\..*|core\\.askpass|core\\.sshcommand|core\\.gitproxy|http\\..*|remote\\.origin\\.(url|proxy|vcs|uploadpack)|url\\..*\\.insteadof|protocol\\..*)$";

/** A network fetch the repository's configuration makes unsafe: the key that does. */
export class UnsafeRemoteConfigError extends AppError {
	constructor(readonly key: string) {
		super(
			`The repository's own configuration sets ${key}, which could run a program or choose the credentials or transport of a fetch; NarraFork does not fetch with it (set it in the global configuration instead)`,
			409,
			"TEAM_REMOTE_CONFIG_UNSAFE",
		);
	}
}

/** The proxy the server's own environment names for a URL (what an unset `http.proxy` means). */
function ambientProxy(env: Record<string, string | undefined>, url: string | undefined): string {
	const https = url?.startsWith("https:") ?? true;
	return (
		(https ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy)) ??
		env.ALL_PROXY ??
		env.all_proxy ??
		""
	);
}

/**
 * How ssh is chosen for a fetch: an operator's `GIT_SSH_COMMAND` / `GIT_SSH` in the server's
 * environment wins; else the host's (system/global) `core.sshCommand`, passed explicitly; else
 * `ssh -o BatchMode=yes`. A repository's `core.sshCommand` never applies.
 */
export function sshSettings(
	entries: readonly ScopedConfigEntry[],
	env: Record<string, string | undefined>,
): { overrides: Array<readonly [string, string]>; env: Record<string, string> } {
	const host = hostValue(entries, "core.sshcommand");
	if (env.GIT_SSH_COMMAND) return { overrides: [["core.sshCommand", host ?? ""]], env: {} };
	// `GIT_SSH` alone ranks below any core.sshCommand (even the empty override): passed on as
	// the command it names, quoted.
	if (env.GIT_SSH)
		return {
			overrides: [["core.sshCommand", ""]],
			env: { GIT_SSH_COMMAND: shellWord(env.GIT_SSH) },
		};
	if (host) return { overrides: [["core.sshCommand", host]], env: {} };
	return {
		overrides: [["core.sshCommand", ""]],
		env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
	};
}

/**
 * Command-scope overrides for a fetch from origin that keep the repository's configuration from
 * choosing credentials, programs or transport: credential helpers back to the host's list (reset,
 * then the host's re-added), every other repository `credential.*`, `core.askPass` and `http.*`
 * key to the host's value or a neutral one (`sslVerify` true, a proxy the server's own, extra
 * headers and cookie files none); a repository `http.*` key with neither, a repository
 * `remote.origin.vcs`, or a repository `url.*.insteadOf` that rewrites origin's URL refuses the
 * fetch (`UnsafeRemoteConfigError`). Transports are limited to https, http, ssh, git and local
 * paths; `ext::` never.
 */
export function networkOverrides(
	entries: readonly ScopedConfigEntry[],
	env: Record<string, string | undefined>,
): { overrides: Array<readonly [string, string]>; env: Record<string, string> } {
	const originUrl = entries.filter((entry) => entry.key === "remote.origin.url").at(-1)?.value;
	const overrides: Array<readonly [string, string]> = [];
	for (const key of repositoryKeys(entries)) {
		const lower = key.toLowerCase();
		if (lower === "remote.origin.url" || lower === "core.sshcommand") continue;
		// `--upload-pack` on the command line replaces a repository `remote.origin.uploadpack`.
		if (lower.startsWith("protocol.") || lower === "remote.origin.uploadpack") continue;
		// First match wins and command scope comes last: a repository value cannot be overridden.
		if (lower === "core.gitproxy" || lower === "remote.origin.vcs")
			throw new UnsafeRemoteConfigError(key);
		if (lower.startsWith("url.") && lower.endsWith(".insteadof")) {
			const prefixes = entries
				.filter((entry) => entry.key === key && isRepositoryScope(entry.scope))
				.map((entry) => entry.value);
			if (originUrl && prefixes.some((prefix) => prefix && originUrl.startsWith(prefix)))
				throw new UnsafeRemoteConfigError(key);
			continue;
		}
		if (isHelperKey(lower) || isExtraHeaderKey(lower)) continue;
		// Security defaults (true) never become false through an empty override.
		if (lower.endsWith(".protectprotocol") || lower.endsWith(".sanitizeprompt")) {
			overrides.push([key, hostValue(entries, key) ?? "true"]);
			continue;
		}
		const host = hostValue(entries, key);
		if (host !== undefined) {
			overrides.push([key, host]);
			continue;
		}
		if (lower.startsWith("credential.") || lower === "core.askpass") {
			overrides.push([key, ""]);
			continue;
		}
		if (lower === "remote.origin.proxy" || (lower.startsWith("http.") && lower.endsWith(".proxy")))
			overrides.push([key, ambientProxy(env, originUrl)]);
		else if (lower.startsWith("http.") && lower.endsWith(".sslverify"))
			overrides.push([key, "true"]);
		else if (lower.startsWith("http.") && lower.endsWith(".cookiefile")) overrides.push([key, ""]);
		else if (lower.startsWith("http.") && lower.endsWith(".savecookies"))
			overrides.push([key, "false"]);
		else throw new UnsafeRemoteConfigError(key);
	}
	// Credential helpers: one empty value resets the whole list (every `credential.*.helper` key
	// shares it), then the host's helpers are added back in the order git read them.
	const helpers: Array<readonly [string, string]> = [];
	if (repositoryKeys(entries).some((key) => isHelperKey(key.toLowerCase())))
		helpers.push(
			["credential.helper", ""],
			...entries
				.filter((entry) => HOST_SCOPES.has(entry.scope) && isHelperKey(entry.key.toLowerCase()))
				.map((entry) => [entry.key, entry.value] as const),
		);
	// Extra headers accumulate the same way: reset, then the host's again, in order.
	if (repositoryKeys(entries).some((key) => isExtraHeaderKey(key.toLowerCase())))
		helpers.push(
			["http.extraHeader", ""],
			...entries
				.filter(
					(entry) => HOST_SCOPES.has(entry.scope) && isExtraHeaderKey(entry.key.toLowerCase()),
				)
				.map((entry) => [entry.key, entry.value] as const),
		);
	const ssh = sshSettings(entries, env);
	return {
		overrides: [
			...helpers,
			...overrides,
			...ssh.overrides,
			["core.gitProxy", ""],
			["remote.origin.uploadpack", "git-upload-pack"],
			["protocol.allow", "never"],
			["protocol.https.allow", "always"],
			["protocol.http.allow", "always"],
			["protocol.ssh.allow", "always"],
			["protocol.git.allow", "always"],
			["protocol.file.allow", "always"],
			["protocol.ext.allow", "never"],
		],
		env: ssh.env,
	};
}

/**
 * Push-only configuration a repository can set: a `url.*.pushInsteadOf` (and the `insteadOf` the
 * fetch rules already read), and `remote.<name>.*` of every remote (a remote whose name is the
 * very URL pushed to applies to an explicit URL too).
 */
const PUSH_PATTERN =
	"^(url\\..*\\.(insteadof|pushinsteadof)|remote\\..*\\.(url|pushurl|receivepack|uploadpack|vcs|proxy|push|mirror))$";

/** Command-scope settings a push always carries: nothing signed, recursed, followed or added. */
const PUSH_NEUTRAL: ConfigEntries = [
	["push.gpgSign", "false"],
	["push.recurseSubmodules", "no"],
	["push.followTags", "false"],
	["push.negotiate", "false"],
	["push.autoSetupRemote", "false"],
	// One empty value resets the list of push options.
	["push.pushOption", ""],
];

/**
 * Refuse a push whose URL the repository's own configuration would rewrite or reconfigure: a
 * repository `url.*.insteadOf` / `url.*.pushInsteadOf` whose prefix starts the URL, or a
 * repository `remote.<URL>.*` (a remote named by the URL itself). The host's own rewrites are the
 * operator's and apply.
 */
export function assertPushUrlUntouched(entries: readonly ScopedConfigEntry[], url: string): void {
	for (const entry of entries) {
		if (!isRepositoryScope(entry.scope)) continue;
		const lower = entry.key.toLowerCase();
		if (
			lower.startsWith("url.") &&
			(lower.endsWith(".insteadof") || lower.endsWith(".pushinsteadof")) &&
			entry.value &&
			url.startsWith(entry.value)
		)
			throw new UnsafeRemoteConfigError(entry.key);
		if (lower.startsWith("remote.")) {
			const name = entry.key.slice("remote.".length, entry.key.lastIndexOf("."));
			if (name === url) throw new UnsafeRemoteConfigError(entry.key);
		}
	}
}

/** A URL with any userinfo (`user:token@`) removed, for messages. */
export function redactUserinfo(text: string): string {
	return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]+@/gi, "$1");
}

/** The outcome of a push of one branch. */
export type PushBranchResult =
	| { outcome: "pushed" }
	| { outcome: "up_to_date" }
	/** The remote branch has commits the head lacks (or a hook there refused it). */
	| { outcome: "rejected"; message: string }
	| { outcome: "failed"; message: string };

/** Read `git push --porcelain` for one destination ref. */
export function parsePushPorcelain(
	stdout: string,
	destination: string,
): { flag: string; summary: string } | null {
	for (const line of stdout.split("\n")) {
		const match = /^([ +\-*=!])\t([^\t]*)\t?(.*)$/.exec(line);
		if (!match) continue;
		const refs = match[2] ?? "";
		const to = refs.slice(refs.lastIndexOf(":") + 1);
		if (to === destination) return { flag: match[1] ?? "", summary: (match[3] ?? "").trim() };
	}
	return null;
}

const isHelperKey = (lower: string) => lower.startsWith("credential.") && lower.endsWith(".helper");
const isExtraHeaderKey = (lower: string) =>
	lower.startsWith("http.") && lower.endsWith(".extraheader");

/** Only the local transport, for `fetch .` (an `insteadOf` on `.` cannot reach anything else). */
const LOCAL_ONLY_PROTOCOLS: ConfigEntries = [
	["protocol.allow", "never"],
	["protocol.file.allow", "always"],
	["protocol.ext.allow", "never"],
];

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
	/** Refuse a shallow repository or one with a graft file (`TEAM_GIT_HISTORY_ALTERED`). */
	assertTrueHistory(): Promise<void>;
	/** Whether `ancestor` is in `descendant`'s history (refused like `assertTrueHistory`). */
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	mergeTree(ours: string, theirs: string): Promise<MergeTreeResult>;
	/**
	 * A commit of `tree`; `identity` is the person's NarraFork identity, else the host's global
	 * one is used (never the repository's), and with neither 409 `TEAM_MERGE_IDENTITY_UNKNOWN`.
	 */
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
	/**
	 * Delete many private refs, each only if it still holds its commit: a batch at a time in one
	 * `update-ref --stdin` transaction, one by one when a batch is refused. Returns how many went.
	 */
	deletePrivateRefs(refs: readonly { itemId: string; commit: string }[]): Promise<number>;
	/** Up to `limit` private refs (streamed, never cut by a byte cap); `more` when there are more. */
	listPrivateRefs(
		limit?: number,
	): Promise<{ refs: { itemId: string; commit: string }[]; more: boolean }>;
	fastForwardBase(commit: string, base: string): Promise<FastForwardBaseResult>;
	/** The checkout `refs/heads/<branch>` is checked out in, or null. */
	checkedOutAt(branch: string): Promise<string | null>;
	/** The repository's common git directory (absolute, resolved). */
	commonDir(): Promise<string>;
	/** `origin/<base>` into `refs/remotes/origin/<base>` only; the error text when it failed. */
	fetchBaseFromOrigin(base: string): Promise<{ ok: true } | { ok: false; message: string }>;
	/**
	 * G: push `head` to `refs/heads/<branch>` at `url` (origin's push URL as read): no `+`, no
	 * lease, so a remote branch with commits the head lacks is rejected. Refused before anything
	 * runs (`TEAM_REMOTE_CONFIG_UNSAFE`) when the repository's own configuration would choose the
	 * transport, credentials or a program, or rewrite the URL.
	 */
	pushBranch(input: { url: string; head: string; branch: string }): Promise<PushBranchResult>;
}

/** The absolute, resolved common git directory of a checkout. */
export async function commonGitDir(dir: string, signal?: AbortSignal): Promise<string> {
	const result = await run(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		config: GIT_NO_EXEC_CONFIG,
		signal,
	});
	const path = result.stdout.trim();
	if (result.exitCode !== 0 || !path)
		throw new GitError(`git rev-parse failed: ${complaint(result)}`);
	return realpath(path).catch(() => path);
}

export function teamRepoGit(repo: string, options: { signal?: AbortSignal } = {}): TeamRepoGit {
	const { signal } = options;
	/**
	 * The hardening plus the repository's filters, hooks and merge drivers by name, read again
	 * right before every command that could run one (the configuration can change in between).
	 */
	const programConfig = async (): Promise<ConfigEntries> => [
		...GIT_NO_EXEC_CONFIG,
		...untrustedProgramOverrides(await configuredPrograms(repo)),
	];
	/** Reads that run no program (rev-parse, merge-base, for-each-ref, worktree list, config). */
	const read = (args: readonly string[], extra: Omit<Parameters<typeof run>[2], "config"> = {}) =>
		run(repo, args, { config: GIT_NO_EXEC_CONFIG, signal, ...extra });
	const write = async (
		args: readonly string[],
		extra: Omit<Parameters<typeof run>[2], "config"> & { config?: ConfigEntries } = {},
	) => {
		const { config: more = [], ...rest } = extra;
		return run(repo, args, { config: [...(await programConfig()), ...more], signal, ...rest });
	};

	const resolve = async (ref: string): Promise<string | null> => {
		if (!ref || ref.startsWith("-")) throw new GitError("Expected a ref");
		const result = await read([
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
		const result = await read(["worktree", "list", "--porcelain", "-z"], {
			maxOutputBytes: 1024 * 1024,
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
			const result = await read(["remote", "get-url", "--push", "origin"], {
				maxOutputBytes: 16 * 1024,
			});
			// Exit 2: no such remote.
			if (result.exitCode === 2) return null;
			if (result.exitCode !== 0 || result.truncated)
				throw new GitError("git remote could not read origin");
			return result.stdout.trim() || null;
		},
		resolve,
		assertTrueHistory: () => assertTrueHistory(repo),
		async isAncestor(ancestor, descendant) {
			assertSha(ancestor);
			assertSha(descendant);
			await assertTrueHistory(repo);
			const result = await read(["merge-base", "--is-ancestor", ancestor, descendant]);
			if (result.exitCode === 0) return true;
			if (result.exitCode === 1 && !result.stderr.trim()) return false;
			throw new GitError(`git merge-base failed: ${complaint(result)}`);
		},
		async mergeTree(ours, theirs) {
			assertSha(ours);
			assertSha(theirs);
			const result = await write(
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
			const who = identity ?? (await hostIdentity(repo, signal));
			if (!who) throw identityUnknown();
			const signing = await signingConfig(repo, signal);
			const result = await write(
				[
					"commit-tree",
					...(signing.sign ? ["-S"] : []),
					...parents.flatMap((parent) => ["-p", parent]),
					"-m",
					message,
					tree,
				],
				{ config: signing.overrides, env: who },
			);
			const commit = result.stdout.trim();
			if (
				result.exitCode !== 0 &&
				/identity unknown|tell me who you are|empty ident/i.test(result.stderr)
			)
				throw identityUnknown();
			if (result.exitCode !== 0 || !SHA.test(commit))
				throw new GitError(`git commit-tree failed: ${complaint(result)}`);
			return commit;
		},
		async setPrivateRef(itemId, commit, expected) {
			assertSha(commit);
			if (expected !== null) assertSha(expected);
			const result = await write([
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
			const result = await write(["update-ref", "-d", privateRef(itemId), expected]);
			return result.exitCode === 0;
		},
		async deletePrivateRefs(refs) {
			let deleted = 0;
			for (let index = 0; index < refs.length; index += DELETE_BATCH) {
				const batch = refs.slice(index, index + DELETE_BATCH);
				for (const ref of batch) assertSha(ref.commit);
				const input = batch
					.map((ref) => `delete ${privateRef(ref.itemId)}\0${ref.commit}\0`)
					.join("");
				const result = await write(["update-ref", "--stdin", "-z"], {
					stdin: new TextEncoder().encode(input),
				});
				if (result.exitCode === 0) {
					deleted += batch.length;
					continue;
				}
				// One of them moved meanwhile: the transaction refused them all.
				for (const ref of batch) {
					const one = await write(["update-ref", "-d", privateRef(ref.itemId), ref.commit]);
					if (one.exitCode === 0) deleted++;
				}
			}
			return deleted;
		},
		async listPrivateRefs(limit = PRIVATE_REFS_PAGE) {
			const refs: { itemId: string; commit: string }[] = [];
			let more = false;
			let pending = "";
			const decoder = new TextDecoder();
			const take = (line: string) => {
				const [commit, name] = line.trim().split(" ");
				if (!commit || !name?.startsWith(TEAM_MERGE_REF_PREFIX) || !SHA.test(commit)) return;
				const itemId = name.slice(TEAM_MERGE_REF_PREFIX.length);
				if (!ITEM_ID.test(itemId)) return;
				if (refs.length >= limit) more = true;
				else refs.push({ itemId, commit });
			};
			// Streamed line by line: however many refs there are, at most `limit` are kept and the
			// listing stops right after the first one past it.
			const result = await read(
				["for-each-ref", "--format=%(objectname) %(refname)", TEAM_MERGE_REF_PREFIX],
				{
					maxOutputBytes: 0,
					stdoutStream: {
						maxBytes: Number.MAX_SAFE_INTEGER,
						onChunk: (chunk) => {
							pending += decoder.decode(chunk, { stream: true });
							const lines = pending.split("\n");
							pending = lines.pop() ?? "";
							for (const line of lines) take(line);
							return !more;
						},
					},
				},
			);
			if (!more && pending) take(pending);
			if (result.exitCode !== 0 && !more)
				throw new GitError(`git for-each-ref failed: ${complaint(result)}`);
			return { refs, more };
		},
		async fastForwardBase(commit, base) {
			assertSha(commit);
			assertBranch(base);
			const result = await write(
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
				{ timeout: MERGE_TIMEOUT_MS, config: LOCAL_ONLY_PROTOCOLS },
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
		commonDir: () => commonGitDir(repo, signal),
		async fetchBaseFromOrigin(base) {
			assertBranch(base);
			const entries = await scopedConfig(repo, NETWORK_PATTERN, signal);
			const env = envWithAmbientProxy();
			let network: ReturnType<typeof networkOverrides>;
			try {
				network = networkOverrides(entries, env);
			} catch (error) {
				if (error instanceof UnsafeRemoteConfigError) return { ok: false, message: error.message };
				throw error;
			}
			// The host's credentials drive a fetch, so the hardening's emptied credential helper,
			// askpass and ssh command are replaced by `networkOverrides`' host-only values.
			const hardened = (await programConfig()).filter(
				([key]) =>
					key !== "credential.helper" && key !== "core.sshCommand" && key !== "core.askPass",
			);
			const result = await run(
				repo,
				[
					"fetch",
					"--no-write-fetch-head",
					"--no-tags",
					"--no-recurse-submodules",
					"--no-auto-maintenance",
					// Only the refspec given moves a ref: no configured `remote.origin.fetch` mapping
					// (which could force-update a local branch) and no pruning.
					"--refmap=",
					"--no-prune",
					"--no-prune-tags",
					// First value wins for upload-pack: only the command line beats the repository's.
					"--upload-pack=git-upload-pack",
					"--quiet",
					"origin",
					`+refs/heads/${base}:refs/remotes/origin/${base}`,
				],
				{
					config: [
						...hardened,
						...network.overrides,
						["fetch.prune", "false"],
						["fetch.pruneTags", "false"],
						["remote.origin.prune", "false"],
						["remote.origin.pruneTags", "false"],
					],
					network: true,
					timeout: FETCH_TIMEOUT_MS,
					env: network.env,
					signal,
				},
			);
			return result.exitCode === 0
				? { ok: true }
				: { ok: false, message: redactUserinfo(complaint(result)) };
		},
		async pushBranch({ url, head, branch }) {
			assertSha(head);
			assertBranch(branch);
			if (!url || url.startsWith("-") || unsafeForCommand(url))
				throw new GitError("Not a URL to push to");
			const entries = await scopedConfig(repo, NETWORK_PATTERN, signal);
			const pushEntries = await scopedConfig(repo, PUSH_PATTERN, signal);
			assertPushUrlUntouched(pushEntries, url);
			const network = networkOverrides(entries, envWithAmbientProxy());
			// As for the fetch: the host's credentials and ssh, never the hardening's emptied ones.
			const hardened = (await programConfig()).filter(
				([key]) =>
					key !== "credential.helper" && key !== "core.sshCommand" && key !== "core.askPass",
			);
			const destination = `refs/heads/${branch}`;
			const result = await run(
				repo,
				[
					"push",
					"--porcelain",
					// No hook (pre-push), on top of the hooks directory and every configured hook off.
					"--no-verify",
					"--no-signed",
					"--no-recurse-submodules",
					"--no-follow-tags",
					// First value wins: only the command line beats a configured receive-pack.
					"--receive-pack=git-receive-pack",
					url,
					`${head}:${destination}`,
				],
				{
					config: [...hardened, ...network.overrides, ...PUSH_NEUTRAL],
					network: true,
					timeout: PUSH_TIMEOUT_MS,
					maxOutputBytes: PUSH_OUTPUT_BYTES,
					env: network.env,
					signal,
				},
			);
			const line = parsePushPorcelain(result.stdout, destination);
			if (line?.flag === "!")
				return {
					outcome: "rejected",
					message: redactUserinfo(line.summary || complaint(result)).slice(0, 300),
				};
			if (result.exitCode === 0 && line?.flag === "=") return { outcome: "up_to_date" };
			if (result.exitCode === 0 && line && line.flag !== "-") return { outcome: "pushed" };
			return {
				outcome: "failed",
				message: redactUserinfo(result.truncated ? "git push said too much" : complaint(result)),
			};
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
	| "other_repository"
	| "altered_history"
	| "unsafe_path"
	| "unreadable";

/**
 * Whether git's working tree for `dir` is `dir` itself (`rev-parse --show-toplevel`, resolved):
 * a `core.worktree` elsewhere would make a merge write files somewhere else.
 */
async function worksInPlace(dir: string, signal?: AbortSignal): Promise<boolean> {
	const top = await run(dir, ["rev-parse", "--show-toplevel"], {
		config: GIT_NO_EXEC_CONFIG,
		signal,
	});
	const path = top.stdout.trim();
	if (top.exitCode !== 0 || !path) return false;
	const [mine, theirs] = await Promise.all([
		realpath(path).catch(() => path),
		realpath(dir).catch(() => dir),
	]);
	return mine === theirs;
}

/**
 * Whether the checkout's own (local / worktree) configuration names a filter, a hooks directory or
 * a working tree of its own (`core.worktree`).
 */
async function localProgramsOf(dir: string, signal?: AbortSignal): Promise<boolean> {
	const entries = await scopedConfig(
		dir,
		"^(filter\\..+\\.(clean|smudge|process)|core\\.hookspath|core\\.worktree)$",
		signal,
	);
	return entries.some((entry) => isRepositoryScope(entry.scope));
}

/**
 * Whether a person's checkout is exactly where a prepared merge can be fast-forwarded: it belongs
 * to the project's repository (same common git directory, when `repo` is given), HEAD is on the
 * base and the base still holds the commit the merge was computed on, no merge, rebase,
 * cherry-pick, revert or bisect is in progress, the index is not locked, and the checkout's own
 * configuration names no filter and no hooks directory (those would run, or be skipped, inside a
 * person's working tree: only the copyable command is offered then). Reads only.
 */
export async function inspectCheckout(
	dir: string,
	base: string,
	baseSha: string,
	options: { repo?: string; signal?: AbortSignal } = {},
): Promise<CheckoutBlocker | null> {
	assertBranch(base);
	assertSha(baseSha);
	// No command can be offered for it, and nothing here acts on a path like that either.
	if (unsafeForCommand(dir)) return "unsafe_path";
	const { signal } = options;
	try {
		const config = [...GIT_NO_EXEC_CONFIG];
		if (options.repo) {
			const [mine, theirs] = await Promise.all([
				commonGitDir(dir, signal),
				commonGitDir(options.repo, signal),
			]);
			if (mine !== theirs) return "other_repository";
		}
		// A shallow history or a graft file would fool the person's own git (the command).
		if (await historyAltered(dir)) return "altered_history";
		const head = await run(dir, ["symbolic-ref", "--quiet", "HEAD"], { config, signal });
		if (head.exitCode !== 0 || head.stdout.trim() !== `refs/heads/${base}`) return "not_on_base";
		const at = await run(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`], {
			config,
			signal,
		});
		if (at.exitCode !== 0) return "unreadable";
		if (at.stdout.trim() !== baseSha) return "stale";
		const gitDir = await run(dir, ["rev-parse", "--absolute-git-dir"], { config, signal });
		const path = gitDir.stdout.trim();
		if (gitDir.exitCode !== 0 || !path) return "unreadable";
		if (!(await worksInPlace(dir, signal))) return "local_config";
		const exists = async (name: string) =>
			(await stat(join(path, name)).catch(() => null)) !== null;
		for (const marker of IN_PROGRESS_MARKERS)
			if (await exists(marker)) return "operation_in_progress";
		if (await exists("index.lock")) return "index_locked";
		if (await localProgramsOf(dir, signal)) return "local_config";
		return null;
	} catch (error) {
		if (signal?.aborted) throw error;
		return "unreadable";
	}
}

/** Whether `assertTrueHistory` refuses the repository at `dir` (other failures propagate). */
async function historyAltered(dir: string): Promise<boolean> {
	try {
		await assertTrueHistory(dir);
		return false;
	} catch (error) {
		if (error instanceof AppError && error.code === "TEAM_GIT_HISTORY_ALTERED") return true;
		throw error;
	}
}

/** The canonical form of a checkout path (realpath when it exists). */
export async function canonicalCheckout(path: string): Promise<string> {
	return realpath(path).catch(() => path);
}

export type FastForwardCheckoutResult =
	| { ok: true }
	| {
			ok: false;
			/**
			 * `refused`: git changed nothing; `incomplete`: something is off afterwards; `moved`: HEAD
			 * left the base; `unsafe`: the checkout's own configuration names a program the merge
			 * could run (read right before it), so only the command is offered.
			 */
			kind: "refused" | "incomplete" | "moved" | "unsafe";
			files: string[];
			message: string;
	  };

/**
 * `git merge --ff-only <ref>` in a person's checkout, after HEAD is checked to be on `base` right
 * before. Nothing of the checkout's own configuration runs: every hook off (`core.hooksPath` and
 * the configuration-defined ones by name, read right before), no fsmonitor or external diff, no
 * autostash (`--no-autostash`, `merge.autoStash=false`), no submodule recursion, no signature
 * check (`--no-verify-signatures`, signing programs only from the host); the host's own filters
 * still run, as they would for the person (the checkout's own were ruled out by
 * {@link inspectCheckout}). When git refuses (local changes the merge would overwrite) nothing
 * changed and the files git named are returned. Afterwards the checkout must have no unmerged
 * entry, no new stash, and HEAD still on `base` at `mergeCommit`; otherwise it is reported.
 */
export async function fastForwardCheckout(
	dir: string,
	ref: string,
	expect: { base: string; mergeCommit: string },
	signal?: AbortSignal,
): Promise<FastForwardCheckoutResult> {
	if (!ref.startsWith(TEAM_MERGE_REF_PREFIX)) throw new GitError("Unexpected merge ref");
	assertBranch(expect.base);
	assertSha(expect.mergeCommit);
	const plain = [...GIT_NO_EXEC_CONFIG];
	const headRef = async () =>
		(await run(dir, ["symbolic-ref", "--quiet", "HEAD"], { config: plain, signal })).stdout.trim();
	const stashTip = async () =>
		(
			await run(dir, ["rev-parse", "--verify", "--quiet", "refs/stash"], { config: plain, signal })
		).stdout.trim();
	if ((await headRef()) !== `refs/heads/${expect.base}`)
		return {
			ok: false,
			kind: "moved",
			files: [],
			message: `HEAD is no longer on ${expect.base}`,
		};
	// Right before the merge, whatever the earlier inspection saw: a filter (clean, smudge,
	// process) or a hooks directory of the checkout's own configuration refuses it. Filters are not
	// emptied instead: that would check files out wrong (Git LFS). Its own diff drivers (an
	// attribute can name one) are emptied below; fsmonitor and `diff.external` are off in the
	// hardening, and `--no-stat` runs no diff at all.
	const own = await scopedConfig(
		dir,
		"^(filter\\..+\\.(clean|smudge|process)|core\\.hookspath|core\\.worktree|diff\\..+\\.(command|textconv))$",
		signal,
	);
	const ownKeys = repositoryKeys(own);
	const unsafe = ownKeys.filter((key) => !key.toLowerCase().startsWith("diff."));
	if (unsafe.length > 0)
		return {
			ok: false,
			kind: "unsafe",
			files: [],
			message: `The checkout's own configuration sets ${unsafe.slice(0, 5).join(", ")}; run the command yourself`,
		};
	if (!(await worksInPlace(dir, signal)))
		return {
			ok: false,
			kind: "unsafe",
			files: [],
			message: `git's working tree for ${dir} is somewhere else; run the command yourself`,
		};
	const diffDrivers = ownKeys
		.filter((key) => key.toLowerCase().startsWith("diff."))
		.map((key) => [key, ""] as const);
	const stashBefore = await stashTip();
	const programs = await configuredPrograms(dir);
	const signing = await signingConfig(dir, signal);
	const config: ConfigEntries = [
		...GIT_NO_EXEC_CONFIG,
		["core.hooksPath", DEV_NULL],
		...programs.hooks.map((name) => [`hook.${name}.enabled`, "false"] as const),
		...(programs.drivers ?? []).map((name) => [`merge.${name}.driver`, ""] as const),
		["merge.autoStash", "false"],
		["merge.verifySignatures", "false"],
		["submodule.recurse", "false"],
		...diffDrivers,
		...signing.overrides,
	];
	const result = await run(
		dir,
		[
			"merge",
			"--ff-only",
			"--no-edit",
			"--no-autostash",
			"--no-verify-signatures",
			// An ignored local file is the person's: never overwritten by a tracked one.
			"--no-overwrite-ignore",
			"--no-stat",
			"--quiet",
			ref,
		],
		{ config, timeout: MERGE_TIMEOUT_MS, maxOutputBytes: SMALL_OUTPUT_BYTES, signal },
	);
	// Whatever git said, check what the checkout looks like now.
	const unmerged = await run(dir, ["ls-files", "-u", "-z"], {
		config: plain,
		maxOutputBytes: SMALL_OUTPUT_BYTES,
		signal,
	});
	const unmergedFiles = [
		...new Set(
			unmerged.stdout
				.split("\0")
				.map((record) => record.slice(record.indexOf("\t") + 1))
				.filter(Boolean),
		),
	].slice(0, TEAM_MERGE_CONFLICTS_MAX);
	const stashAfter = await stashTip();
	const problems: string[] = [];
	if (unmerged.exitCode !== 0) problems.push("its index could not be read");
	if (unmergedFiles.length > 0) problems.push("it has unmerged files");
	if (stashAfter !== stashBefore) problems.push("a new stash appeared");
	if (result.exitCode === 0) {
		if ((await headRef()) !== `refs/heads/${expect.base}`) problems.push("HEAD left the base");
		const at = await run(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
			config: plain,
			signal,
		});
		if (at.stdout.trim() !== expect.mergeCommit) problems.push("HEAD is not the merge");
	}
	if (problems.length > 0)
		return {
			ok: false,
			kind: "incomplete",
			files: unmergedFiles,
			message: `The fast-forward of ${dir} needs a look: ${problems.join(", ")}`,
		};
	if (result.exitCode === 0) return { ok: true };
	const files = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.filter((line) => /^\t/.test(line))
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, TEAM_MERGE_CONFLICTS_MAX);
	return { ok: false, kind: "refused", files, message: complaint(result) };
}

/**
 * A value as one POSIX shell word: bare when it has only safe characters, otherwise
 * single-quoted, a quote closing, escaping and reopening (`'\\''`). Inside single quotes sh
 * expands nothing, so only the quote itself needs care.
 */
const shellWord = (value: string) =>
	/^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** The command a person runs instead of 「在该目录中快进」, for each shell. */
export interface FastForwardCommands {
	/** POSIX sh / Git Bash. */
	sh: string;
	/** Windows PowerShell / pwsh. */
	powershell: string;
	/** The shell to show first: the server's platform's. */
	preferred: "sh" | "powershell";
}

/**
 * A value as one PowerShell single-quoted string. PowerShell ends such a string at any
 * single-quote-class character — `'` and the typographic U+2018 ‘ U+2019 ’ U+201A ‚ U+201B ‛ —
 * and reads two in a row as one literal quote (the second), so each is doubled.
 */
const powershellWord = (value: string) => `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`;

/**
 * Characters no copyable command may carry: C0/C1 controls (newline, carriage return, NUL…),
 * DEL and the Unicode line/paragraph separators. A pasted line break ends a command early in
 * either shell, whatever the quoting.
 */
const unsafeCommandCharacter = (code: number) =>
	code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/** Whether a path cannot be put in a copyable command (see {@link unsafeCommandCharacter}). */
export const unsafeForCommand = (value: string) => {
	for (let i = 0; i < value.length; i++)
		if (unsafeCommandCharacter(value.charCodeAt(i))) return true;
	return false;
};

/**
 * What a person runs instead of 「在该目录中快进」: it does nothing unless that checkout's HEAD is
 * exactly `refs/heads/<base>`, then fast-forwards to the prepared merge commit itself, never
 * stashing and never overwriting an ignored file. A POSIX shell form and a PowerShell form (the
 * default follows the server's platform). Offered only while the checkout is on the base, and
 * never for a directory whose path carries a control character or line break (null).
 */
export function fastForwardCommand(
	dir: string,
	base: string,
	mergeCommit: string,
	platform: NodeJS.Platform = process.platform,
): FastForwardCommands | null {
	assertBranch(base);
	assertSha(mergeCommit);
	if (unsafeForCommand(dir) || unsafeForCommand(base)) return null;
	const merge = `merge --ff-only --no-autostash --no-overwrite-ignore ${mergeCommit}`;
	// The person's git ignores replacement refs too (the merge was computed without them).
	const sh = `git --no-replace-objects -C ${shellWord(dir)}`;
	const ps = `git --no-replace-objects -C ${powershellWord(dir)}`;
	return {
		sh: `[ "$(${sh} symbolic-ref --quiet HEAD)" = ${shellWord(`refs/heads/${base}`)} ] && ${sh} ${merge}`,
		powershell: `if ((${ps} symbolic-ref --quiet HEAD) -ceq ${powershellWord(`refs/heads/${base}`)}) { ${ps} ${merge} } else { Write-Error ${powershellWord(`Not on ${base}: nothing was changed`)} }`,
		preferred: platform === "win32" ? "powershell" : "sh",
	};
}
