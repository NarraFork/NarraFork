/**
 * The GitHub CLI (`gh`) for a team's pull request flow (G), isolated like the team's git:
 *
 * - **Where it runs.** From a NarraFork-owned empty directory (`<home>/run/gh`), never a
 *   repository, and always with an explicit `-R host/owner/repo` (or the repository as the
 *   argument of `repo view`). gh runs `git remote -v` in its directory even with `-R`; the
 *   environment points `GIT_DIR` at a path that does not exist and stops discovery at that
 *   directory (`GIT_CEILING_DIRECTORIES`), so any git gh starts finds no repository at all.
 * - **Its environment.** The server's own, with the ambient proxy restored and everything that
 *   routes git elsewhere removed (`cleanGitEnv`). Of gh's own variables only the operator's
 *   credentials and configuration are kept (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
 *   `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`); the editor, browser, pager, debug and
 *   forced-terminal variables are dropped, and prompts, the update notifiers, colour, the pager
 *   and the spinner are off.
 * - **Which subcommands.** `--version`, `auth status --json hosts`, `repo view --json`, `pr list
 *   --head --json`, `pr create --head --base --title --body-file -`, `pr view --json`, `pr checks
 *   --json` and `pr merge --<method> --match-head-commit`. None pushes or touches a local
 *   repository: `pr create` always names `--head` (without it gh would push), `pr merge` never
 *   gets `--delete-branch` (which deletes local branches) or `--admin`, and `pr checkout` is never
 *   used.
 * - **Inputs.** The host, owner, repository, branch, pull request number and commit come from
 *   parsing and are checked against strict patterns before they reach argv; free text (the title)
 *   goes as `--title=<value>` and the body through stdin (`--body-file -`). No shell.
 * - **Outputs.** Every run has a timeout, an output cap and the job's abort signal (the process
 *   tree is killed); JSON is size-capped and parsed with Zod, and a cut output is a failure.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TeamPrMergeMethod } from "@shared/project-teams";
import { z } from "zod";
import { cleanGitEnv } from "../../lib/git-exec-hardening";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { envWithAmbientProxy } from "../../lib/net/proxy-env";
import { safeSpawn } from "../../lib/spawn";

/** A repository on a GitHub host, as gh names it: `host/owner/repo`. */
export interface GhRepo {
	host: string;
	owner: string;
	repo: string;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/;
const OWNER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BRANCH_MAX = 255;

/** gh refused, failed or could not run: `kind` says which, `message` is gh's first complaint. */
export class GhError extends Error {
	constructor(
		readonly kind: "missing" | "failed" | "timeout" | "output" | "invalid",
		message: string,
	) {
		super(message);
	}
}

/** Whether a host name may reach gh's argv (lowercase DNS name, no port, no userinfo). */
export function isGhHost(host: string): boolean {
	return host.length <= 253 && HOST.test(host);
}

/** Whether `host/owner/repo` is safe to pass to gh. */
export function isGhRepo(target: GhRepo): boolean {
	return (
		isGhHost(target.host) &&
		OWNER.test(target.owner) &&
		REPO.test(target.repo) &&
		target.repo !== "." &&
		target.repo !== ".." &&
		!target.repo.startsWith("-")
	);
}

function repoArg(target: GhRepo): string {
	if (!isGhRepo(target)) throw new GhError("invalid", "Not a GitHub repository name");
	return `${target.host}/${target.owner}/${target.repo}`;
}

/** Whether a string carries a C0/C1 control character or DEL. */
export function hasControl(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/** A branch name as git and gh accept it on the command line. */
export function isGhBranch(branch: string): boolean {
	return (
		branch.length > 0 &&
		branch.length <= BRANCH_MAX &&
		!branch.startsWith("-") &&
		!branch.startsWith("refs/") &&
		!branch.endsWith("/") &&
		!branch.endsWith(".lock") &&
		!/[\s~^:?*[\\]|\.\.|@\{|\/\//.test(branch) &&
		!hasControl(branch)
	);
}

function branchArg(branch: string): string {
	if (!isGhBranch(branch)) throw new GhError("invalid", "Not a branch name");
	return branch;
}

function numberArg(pr: number): string {
	if (!Number.isSafeInteger(pr) || pr <= 0 || pr > 1_000_000_000)
		throw new GhError("invalid", "Not a pull request number");
	return String(pr);
}

// ── Running gh ──────────────────────────────────────────────────────────────

/** gh's own variables an operator may set for the server; every other `GH_*` is dropped. */
const KEPT_GH_VARIABLES = new Set([
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GH_HOST",
	"GH_CONFIG_DIR",
]);
/** Variables that would make gh start a program or change its output. */
const DROPPED_VARIABLES = new Set([
	"EDITOR",
	"VISUAL",
	"GIT_EDITOR",
	"BROWSER",
	"PAGER",
	"DEBUG",
	"CLICOLOR_FORCE",
	"GLAMOUR_STYLE",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
]);

/** The directory gh runs in (created on first use; never a repository). */
export function ghWorkDir(): string {
	return getNarraforkPath("run", "gh");
}

/** Where `GIT_DIR` points for gh: a path that never exists, so no git gh starts finds a repository. */
export const ghNoRepository = (dir: string) => join(dir, "no-repository");

/** The environment gh runs with (exported for the tests that assert it). */
export function ghEnv(dir: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(cleanGitEnv(envWithAmbientProxy()))) {
		if (DROPPED_VARIABLES.has(key)) continue;
		if ((key.startsWith("GH_") || key.startsWith("GITHUB_")) && !KEPT_GH_VARIABLES.has(key))
			continue;
		env[key] = value;
	}
	return {
		...env,
		GH_PROMPT_DISABLED: "1",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
		GH_SPINNER_DISABLED: "1",
		GH_PAGER: "cat",
		NO_COLOR: "1",
		CLICOLOR: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_DIR: ghNoRepository(dir),
		GIT_CEILING_DIRECTORIES: dir,
	};
}

let preparedDir: string | null = null;

async function prepareWorkDir(): Promise<string> {
	const dir = ghWorkDir();
	if (preparedDir !== dir) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		preparedDir = dir;
	}
	// Nothing in it may look like a repository to a git gh starts.
	const entries = await readdir(dir).catch(() => [] as string[]);
	if (entries.includes(".git"))
		throw new GhError("failed", "gh's working directory holds a .git; it is not used");
	return dir;
}

/** The gh binary on the server's PATH, or null when there is none. */
export function ghBinary(): string | null {
	return Bun.which("gh", { PATH: process.env.PATH ?? "" });
}

interface GhResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runGh(
	args: readonly string[],
	options: {
		timeout: number;
		maxOutputBytes: number;
		stdin?: Uint8Array;
		signal?: AbortSignal;
		/** Exit codes that still carry the answer (`pr checks`: 1 failing, 8 pending). */
		okExitCodes?: readonly number[];
	},
): Promise<GhResult> {
	options.signal?.throwIfAborted();
	const bin = ghBinary();
	if (!bin) throw new GhError("missing", "gh is not installed on the host");
	const dir = await prepareWorkDir();
	const result = await safeSpawn({
		cmd: [bin, ...args],
		cwd: dir,
		env: ghEnv(dir),
		timeout: options.timeout,
		maxOutputBytes: options.maxOutputBytes,
		...(options.stdin ? { stdin: options.stdin } : {}),
		signal: options.signal,
		killProcessTree: true,
	});
	options.signal?.throwIfAborted();
	if (result.terminationReason === "timeout") throw new GhError("timeout", "gh timed out");
	if (result.stdoutTruncated || result.stderrTruncated)
		throw new GhError("output", "gh's answer was too large");
	const ok = [0, ...(options.okExitCodes ?? [])];
	if (!ok.includes(result.exitCode))
		throw new GhError("failed", firstLine(result.stderr) ?? `gh exited ${result.exitCode}`);
	return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/** gh's first meaningful line, cut short (never the whole output). */
export function firstLine(text: string): string | null {
	const line = text
		.split("\n")
		.map((entry) => entry.trim())
		.find(Boolean);
	return line ? line.slice(0, 300) : null;
}

function parseJson<T>(schema: z.ZodType<T>, stdout: string, what: string): T {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new GhError("invalid", `gh ${what} did not answer JSON`);
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new GhError("invalid", `gh ${what} answered unexpected JSON`);
	return parsed.data;
}

// ── Probes ──────────────────────────────────────────────────────────────────

const VERSION_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
const SMALL_BYTES = 64 * 1024;

/** `gh --version` (5 s): the version, or a `GhError`. */
export async function ghVersion(signal?: AbortSignal): Promise<string> {
	const result = await runGh(["--version"], {
		timeout: VERSION_TIMEOUT_MS,
		maxOutputBytes: 4096,
		signal,
	});
	const match = /gh version (\d+\.\d+\.\d+)/.exec(result.stdout);
	if (!match?.[1]) throw new GhError("invalid", "gh --version said nothing recognizable");
	return match[1];
}

const authSchema = z.object({
	hosts: z.record(
		z.string(),
		z.array(
			z.object({
				state: z.string().max(64),
				active: z.boolean().optional(),
				login: z.string().max(200).optional(),
			}),
		),
	),
});

/**
 * Whether gh knows the host (`listed`) and is logged in there (`loggedIn`): `gh auth status
 * --hostname H --json hosts`, which exits 0 and lists nothing for a host it does not know.
 */
export async function ghAuthStatus(
	host: string,
	signal?: AbortSignal,
): Promise<{ listed: boolean; loggedIn: boolean }> {
	if (!isGhHost(host)) throw new GhError("invalid", "Not a host name");
	const result = await runGh(["auth", "status", `--hostname=${host}`, "--json", "hosts"], {
		timeout: PROBE_TIMEOUT_MS,
		maxOutputBytes: SMALL_BYTES,
		okExitCodes: [1],
		signal,
	});
	const parsed = parseJson(authSchema, result.stdout, "auth status");
	const accounts = parsed.hosts[host] ?? [];
	return {
		listed: accounts.length > 0,
		loggedIn: accounts.some((account) => account.state === "success"),
	};
}

const permissionSchema = z
	.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"])
	.nullable()
	.catch(null);
const methodSchema = z.enum(["MERGE", "SQUASH", "REBASE"]).nullable().catch(null);

const repoSchema = z.object({
	viewerPermission: permissionSchema.optional(),
	mergeCommitAllowed: z.boolean().optional(),
	squashMergeAllowed: z.boolean().optional(),
	rebaseMergeAllowed: z.boolean().optional(),
	viewerDefaultMergeMethod: methodSchema.optional(),
	isArchived: z.boolean().optional(),
});

export interface GhRepoFacts {
	permission: "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ" | null;
	archived: boolean;
	/** Allowed methods, the viewer's default first when allowed, else merge, squash, rebase. */
	methods: TeamPrMergeMethod[];
}

/** `gh repo view host/owner/repo --json …`: permission, archived, the allowed merge methods. */
export async function ghRepoView(target: GhRepo, signal?: AbortSignal): Promise<GhRepoFacts> {
	const result = await runGh(
		[
			"repo",
			"view",
			repoArg(target),
			"--json",
			"viewerPermission,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod,isArchived",
		],
		{ timeout: PROBE_TIMEOUT_MS, maxOutputBytes: SMALL_BYTES, signal },
	);
	const facts = parseJson(repoSchema, result.stdout, "repo view");
	const allowed = new Set<TeamPrMergeMethod>();
	if (facts.mergeCommitAllowed) allowed.add("merge");
	if (facts.squashMergeAllowed) allowed.add("squash");
	if (facts.rebaseMergeAllowed) allowed.add("rebase");
	const preferred = facts.viewerDefaultMergeMethod?.toLowerCase() as TeamPrMergeMethod | undefined;
	const methods = (["merge", "squash", "rebase"] as const).filter((method) => allowed.has(method));
	if (preferred && allowed.has(preferred))
		methods.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
	return {
		permission: facts.viewerPermission ?? null,
		archived: facts.isArchived === true,
		methods,
	};
}

// ── Pull requests ───────────────────────────────────────────────────────────

const PR_LIST_TIMEOUT_MS = 30_000;
const PR_CREATE_TIMEOUT_MS = 60_000;
const PR_MERGE_TIMEOUT_MS = 90_000;
const PR_VIEW_BYTES = 64 * 1024;
const PR_CHECKS_BYTES = 256 * 1024;

const stateSchema = z.enum(["OPEN", "CLOSED", "MERGED"]);
const shaSchema = z.string().regex(SHA);
const urlSchema = z.string().max(2048).url();

const listSchema = z.array(
	z.object({
		number: z.number().int().positive(),
		url: urlSchema,
		state: stateSchema,
		headRefOid: shaSchema.nullable().catch(null),
		headRefName: z.string().max(BRANCH_MAX),
		baseRefName: z.string().max(BRANCH_MAX),
		isCrossRepository: z.boolean().optional(),
	}),
);

export type GhPrListEntry = z.infer<typeof listSchema>[number];

/**
 * The pull requests whose head is `branch` of this very repository (not a fork's branch of the
 * same name), any state, newest first, at most 5.
 */
export async function ghPrList(
	target: GhRepo,
	branch: string,
	signal?: AbortSignal,
): Promise<GhPrListEntry[]> {
	const result = await runGh(
		[
			"pr",
			"list",
			"-R",
			repoArg(target),
			`--head=${branchArg(branch)}`,
			"--state=all",
			"--limit=5",
			"--json",
			"number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository",
		],
		{ timeout: PR_LIST_TIMEOUT_MS, maxOutputBytes: PR_VIEW_BYTES, signal },
	);
	return parseJson(listSchema, result.stdout, "pr list").filter(
		(entry) => entry.headRefName === branch && entry.isCrossRepository !== true,
	);
}

/** The number in a pull request URL of this repository, or null. */
export function prNumberOfUrl(target: GhRepo, url: string): number | null {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	if (parsed.hostname.toLowerCase() !== target.host) return null;
	const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})\/?$/.exec(parsed.pathname);
	if (!match) return null;
	if (
		match[1]?.toLowerCase() !== target.owner.toLowerCase() ||
		match[2]?.toLowerCase() !== target.repo.toLowerCase()
	)
		return null;
	const number = Number(match[3]);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * `gh pr create -R … --head <branch> --base <base> --title=<title> --body-file -` (never a draft,
 * never without `--head`): the new pull request's number and URL.
 */
export async function ghPrCreate(
	target: GhRepo,
	input: { head: string; base: string; title: string; body: string },
	signal?: AbortSignal,
): Promise<{ number: number; url: string }> {
	const title =
		[...input.title]
			.map((c) => (hasControl(c) ? " " : c))
			.join("")
			.trim() || "NarraFork work item";
	const result = await runGh(
		[
			"pr",
			"create",
			"-R",
			repoArg(target),
			`--head=${branchArg(input.head)}`,
			`--base=${branchArg(input.base)}`,
			`--title=${title.slice(0, 256)}`,
			"--body-file=-",
		],
		{
			timeout: PR_CREATE_TIMEOUT_MS,
			maxOutputBytes: PR_VIEW_BYTES,
			stdin: new TextEncoder().encode(input.body),
			signal,
		},
	);
	// gh prints the new pull request's URL (warnings go to stderr).
	const url = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.reverse()
		.find((line) => prNumberOfUrl(target, line) !== null);
	const number = url ? prNumberOfUrl(target, url) : null;
	if (!url || number === null)
		throw new GhError("invalid", "gh pr create did not name the pull request it opened");
	return { number, url };
}

const viewSchema = z.object({
	number: z.number().int().positive().optional(),
	url: urlSchema,
	state: stateSchema,
	isDraft: z.boolean().catch(false),
	headRefOid: shaSchema.nullable().catch(null),
	mergeable: z.string().max(32).nullable().catch(null),
	mergeStateStatus: z
		.enum(["CLEAN", "HAS_HOOKS", "UNSTABLE", "BLOCKED", "BEHIND", "DIRTY", "DRAFT", "UNKNOWN"])
		.nullable()
		.catch("UNKNOWN"),
	reviewDecision: z
		.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
		.nullable()
		.catch(null),
	mergedAt: z.string().max(64).nullable().catch(null),
	mergeCommit: z.object({ oid: shaSchema }).nullable().catch(null),
	autoMergeRequest: z.unknown().optional(),
	baseRefName: z.string().max(BRANCH_MAX).optional(),
});

export type GhPrView = Omit<z.infer<typeof viewSchema>, "autoMergeRequest"> & {
	autoMerge: boolean;
};

/** `gh pr view N -R … --json …` (64 KB). */
export async function ghPrView(
	target: GhRepo,
	pr: number,
	signal?: AbortSignal,
): Promise<GhPrView> {
	const result = await runGh(
		[
			"pr",
			"view",
			numberArg(pr),
			"-R",
			repoArg(target),
			"--json",
			"number,url,state,isDraft,headRefOid,mergeable,mergeStateStatus,reviewDecision,mergedAt,mergeCommit,autoMergeRequest,baseRefName",
		],
		{ timeout: PR_LIST_TIMEOUT_MS, maxOutputBytes: PR_VIEW_BYTES, signal },
	);
	const { autoMergeRequest, ...view } = parseJson(viewSchema, result.stdout, "pr view");
	return { ...view, autoMerge: autoMergeRequest !== null && autoMergeRequest !== undefined };
}

const checksSchema = z.array(
	z.object({
		name: z.string().max(500).catch(""),
		bucket: z.string().max(32).catch(""),
		state: z.string().max(64).optional(),
		link: z.string().max(2048).nullable().optional(),
		workflow: z.string().max(500).nullable().optional(),
	}),
);

export type GhCheck = z.infer<typeof checksSchema>[number];

/**
 * `gh pr checks N -R … --json …` (256 KB). Exit 1 (some failed) and 8 (some pending) still carry
 * the list; a pull request without checks is an empty list.
 */
export async function ghPrChecks(
	target: GhRepo,
	pr: number,
	signal?: AbortSignal,
): Promise<GhCheck[]> {
	let result: GhResult;
	try {
		result = await runGh(
			[
				"pr",
				"checks",
				numberArg(pr),
				"-R",
				repoArg(target),
				"--json",
				"name,bucket,state,link,workflow",
			],
			{
				timeout: PR_LIST_TIMEOUT_MS,
				maxOutputBytes: PR_CHECKS_BYTES,
				okExitCodes: [1, 8],
				signal,
			},
		);
	} catch (error) {
		if (error instanceof GhError && /no checks reported/i.test(error.message)) return [];
		throw error;
	}
	if (!result.stdout.trim()) {
		if (/no checks reported/i.test(result.stderr) || result.exitCode === 0) return [];
		throw new GhError("failed", firstLine(result.stderr) ?? "gh pr checks failed");
	}
	return parseJson(checksSchema, result.stdout, "pr checks");
}

/**
 * `gh pr merge N -R … --<method> --match-head-commit <head>`: no `--delete-branch` (it deletes
 * local branches), no `--admin`, no `--auto`. A merge queue may queue it instead of merging:
 * the caller reads the pull request again.
 */
export async function ghPrMerge(
	target: GhRepo,
	input: { pr: number; method: TeamPrMergeMethod; head: string },
	signal?: AbortSignal,
): Promise<void> {
	if (!SHA.test(input.head)) throw new GhError("invalid", "Expected a full commit SHA");
	if (!(["merge", "squash", "rebase"] as const).includes(input.method))
		throw new GhError("invalid", "Not a merge method");
	await runGh(
		[
			"pr",
			"merge",
			numberArg(input.pr),
			"-R",
			repoArg(target),
			`--${input.method}`,
			`--match-head-commit=${input.head}`,
		],
		{ timeout: PR_MERGE_TIMEOUT_MS, maxOutputBytes: PR_VIEW_BYTES, signal },
	);
}
