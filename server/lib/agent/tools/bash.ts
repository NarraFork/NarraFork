import { backgroundTaskService } from "@server/services/background-task-service";
import { registerLocalBashActivity } from "@server/services/file-change-runtime";
import { beginBashCaptureWindow } from "@server/services/narrator-tree-snapshot-hooks";
import { z } from "zod/v4";
import { AppError } from "../../errors";
import { resolveNarratorGitIdentityEnv } from "../../git-identity";
import { hotSafe } from "../../hot-safe";
import { generateShortId } from "../../id";
import { logger } from "../../logger";
import { getHome } from "../../platform";
import type { ExecHandle, ExecutionBackend } from "../execution/backend";
import { withDeviceParam } from "../execution/device-schema";
import { resolveBackendPath, toolBaseCwd } from "../execution/path-resolve";
import { getToolBackend } from "../execution/tool-backend";
import {
	createOptionalExecutionTimeout,
	resolveOptionalExecutionTimeout,
} from "../execution-timeout";
import { BASH_TOOL_NAME } from "../tool-name";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";
import { createStreamDecoder } from "./encoding";
import {
	createInvalidWorkdirArgumentResult,
	createMissingWorkingDirectoryResult,
} from "./working-directory-recovery";
import { resolveBashSerializationInput, withBashWriteLock } from "./write-serialization";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BACKGROUND_TIMEOUT_MS = 5 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 86_400_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB max in-memory output (foreground & background)
const LIVE_OUTPUT_INTERVAL_MS = 250;
const LIVE_OUTPUT_MAX_CHARS = 100_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const LONG_RUNNING_THRESHOLD_MS = 60_000;

async function isExistingDirectory(
	backend: ExecutionBackend,
	candidate: string | null | undefined,
): Promise<boolean> {
	if (!candidate) return false;
	return (await backend.statFile(candidate))?.isDirectory === true;
}

async function firstExistingRecoveryCwd(
	backend: ExecutionBackend,
	candidates: Array<string | null | undefined>,
): Promise<string> {
	for (const candidate of candidates) {
		if (candidate && (await isExistingDirectory(backend, candidate))) return candidate;
	}
	return getHome();
}

export type { MissingWorkingDirectoryRecovery } from "./working-directory-recovery";
export {
	getMissingWorkingDirectoryRecovery,
	MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
} from "./working-directory-recovery";
export { DEFAULT_BACKGROUND_TIMEOUT_MS, DEFAULT_TIMEOUT_MS };

/** Resolve the execution deadline for foreground/background Bash modes. */
export function resolveBashTimeoutMs(
	runInBackground: boolean | undefined,
	timeout?: number,
): number | undefined {
	if (runInBackground) {
		return resolveOptionalExecutionTimeout(timeout, DEFAULT_BACKGROUND_TIMEOUT_MS);
	}
	return Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT_MS, 0), MAX_TIMEOUT_MS);
}

// --- Live timeout management ---
// Tracks running bash processes so the UI can update their timeout mid-execution.
// Pinned to globalThis via hotSafe so hot reloads don't lose references to
// running child processes (which would leave them as unkillable ghosts).

interface RunningBashEntry {
	timer: ReturnType<typeof setTimeout>;
	startedAt: number;
	timeoutMs: number;
	kill: () => void;
	setTimedOut: () => void;
	narratorId: string;
	detach?: () => Promise<DetachedBashProcess>;
}

export interface DetachedBashProcess {
	taskId: string;
	alias: string;
}

/** Adopt the existing execution; never dispatch the command a second time. */
export async function detachBashProcess(
	toolUseId: string,
	narratorId: string,
): Promise<DetachedBashProcess | null> {
	const entry = runningBashProcesses.get(toolUseId);
	if (!entry || entry.narratorId !== narratorId || !entry.detach) return null;
	return entry.detach();
}

let preexistingBashRegistry = true;
const runningBashProcesses = hotSafe("narrafork:runningBashProcesses", () => {
	preexistingBashRegistry = false;
	return new Map<string, RunningBashEntry>();
});
// A hot upgrade cannot prove that older loops discarded their old tool closures,
// even when their process registry is momentarily empty. This one-time data flag
// is false on a clean boot and survives later hot reloads without storing old code.
const bashActivityMigration = hotSafe("narrafork:bashActivityMigration:v1", () =>
	Object.freeze({ requiresColdStart: preexistingBashRegistry }),
);

export function assertBashActivityProtectionReady(): void {
	if (bashActivityMigration.requiresColdStart)
		throw new AppError(
			"File rollback protection was enabled by a hot upgrade. Finish current work and restart the service before reverting files.",
			409,
			"REVERT_RUNTIME_RELOAD_REQUIRED",
		);
}

/**
 * Kill all running bash processes spawned by the Bash tool.
 * Called during graceful shutdown to prevent ghost processes holding ports
 * (especially on Windows where child processes can outlive the parent).
 */
export async function killAllBashProcesses(): Promise<void> {
	// Kill foreground bash processes
	const entries = [...runningBashProcesses.entries()];
	for (const [id, entry] of entries) {
		try {
			clearTimeout(entry.timer);
			entry.setTimedOut();
			entry.kill();
		} catch {
			// best effort — process may already be gone
		}
		runningBashProcesses.delete(id);
	}
	// Kill background bash tasks via the service
	await backgroundTaskService.killAll();
}

/**
 * Update the timeout of a running bash process.
 * Returns the new effective timeoutMs, or null if the toolUseId is not found.
 */
export function updateBashTimeout(toolUseId: string, newTimeoutMs: number): number | null {
	const entry = runningBashProcesses.get(toolUseId);
	if (!entry) return null;

	const clamped = Math.min(Math.max(newTimeoutMs, 1000), MAX_TIMEOUT_MS);
	clearTimeout(entry.timer);

	const elapsed = Date.now() - entry.startedAt;
	const remaining = Math.max(clamped - elapsed, 0);

	entry.timeoutMs = clamped;
	entry.timer = setTimeout(() => {
		entry.setTimedOut();
		entry.kill();
	}, remaining);

	return clamped;
}

/**
 * Tool name for shell execution — always "Bash", on every platform and shell
 * flavour. See `BASH_TOOL_NAME` in `../tool-name` for why the old
 * bash-vs-Shell rename was removed.
 *
 * Kept as a named export because most call sites read as shell-permission /
 * shell-analysis code; it is an alias of `BASH_TOOL_NAME`, not a second name.
 */
export const SHELL_TOOL_NAME = BASH_TOOL_NAME;

const REVIEW_READ_ONLY_BASH_DESCRIPTION =
	"Review-only Bash: use synchronous commands only for local Git inspection. " +
	"The command must be a single local read-only git invocation (for example git status, git log, " +
	"git diff, git show, or git ls-files) — exactly one git command per call; chaining multiple " +
	"commands with &&, ;, or || is not allowed. You may pipe that git command's output through a " +
	"bounded read-only formatter such as head, tail, grep, rg, cat, wc, cut, sort, uniq, tr, " +
	"column, or nl. " +
	"Do not write files, change Git state, access remotes, use redirection, prefix the command " +
	"with environment variable assignments, run background/control operations, or invoke other " +
	"commands.";

interface BashExecution {
	start(signal: AbortSignal): Promise<ExecHandle>;
	cancelUndispatched(): void;
}

/** Admission and lifetime are independent of the legacy attribution mutex and
 * tool/HTTP return. Even an unrecognized/read-only-looking command participates. */
async function prepareBashExecution(
	backend: ExecutionBackend,
	command: string,
	cwd: string,
	ctx: ToolContext,
	env?: Record<string, string> | null,
): Promise<BashExecution> {
	const activity = await registerLocalBashActivity({
		backend,
		cwd,
		target: ctx.executionTarget,
		signal: ctx.signal,
	});
	let started = false;
	let ended = false;
	let bashWindow: { end(): void } | undefined;
	const end = (outcome: "finished" | "unknown") => {
		if (ended) return;
		ended = true;
		bashWindow?.end();
		bashWindow = undefined;
		if (!activity) return;
		try {
			activity.end(outcome);
		} catch (error) {
			// The coordinator retains its recovery hold on persistence failure.
			// Never retry an uncertain outcome as "finished" or let a detached
			// callback's rejection discard the only lifecycle observer.
			logger.warn("Bash workspace activity settlement requires recovery", {
				scopeId: activity.scope.id,
				outcome,
				error: String(error),
			});
		}
	};
	return {
		async start(signal) {
			if (started) throw new Error("Bash execution was already dispatched");
			started = true;
			let handle: ExecHandle;
			try {
				signal.throwIfAborted();
				if (backend.kind === "local")
					bashWindow = beginBashCaptureWindow(cwd, ctx.currentToolUseId ?? "__anonymous__");
				handle = await backend.execCommand({
					command,
					cwd: activity?.cwd ?? cwd,
					signal,
					env: env ?? undefined,
				});
			} catch (error) {
				// LocalBackend rejects dispatch only before spawning. Asynchronous
				// spawn/process errors always come with a handle and its real barrier.
				end("finished");
				throw error;
			}
			void (handle.whenSettled ?? handle.exited).then(
				() => end("finished"),
				() => end("unknown"),
			);
			return handle;
		},
		cancelUndispatched() {
			if (!started) end("finished");
		},
	};
}

export const bashTool: ToolDefinition = {
	name: SHELL_TOOL_NAME,
	executionRouting: {
		kind: "single",
		resolve(input) {
			return {
				key: "primary",
				operation: typeof input.command === "string" ? "execute" : "control",
				...(typeof input.device === "string" ? { deviceId: input.device } : {}),
				...(typeof input.workdir === "string" ? { workdir: input.workdir } : {}),
			};
		},
	},
	description: (config) =>
		config.reviewReadOnlyBash
			? REVIEW_READ_ONLY_BASH_DESCRIPTION
			: `Executes a given bash command and returns its output.\n\nThe working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).\n\nIMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\n\n - File search: Use Glob (NOT find or ls)\n - Content search: Use Grep (NOT grep or rg)\n - Read files: Use Read (NOT cat/head/tail)\n - Edit files: Use Edit (NOT sed/awk)\n - Write files: Use Write (NOT echo >/cat <<EOF)\n - Communication: Output text directly (NOT echo/printf)\n - Locate a symbol's definition: Use StructView mode=find (NOT grepping for \`function name\`, which also matches call sites, comments and strings)\n - Understand or read part of a LARGE file: Use StructView mode=report/outline, then mode=extract for the one symbol you need (NOT reading the whole file, and NOT sed/awk line slicing)\n - Rewrite a whole function/class or a line range: Use StructSed (NOT sed/awk, and NOT a Read-then-Write round trip)\nWhile the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.\n\n# Instructions\n - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.\n - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")\n - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.\n - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).\n - Write a clear, concise description of what your command does. For simple commands, keep it brief (5-10 words). For complex commands (piped commands, obscure flags, or anything hard to understand at a glance), include enough context so that the user can understand what your command will do.\n - When issuing multiple commands:\n  - Bash calls in the same turn run **sequentially by default**. Dependent commands (build → push → verify) must stay sequential: wait for the previous Bash result in a later turn, or chain them in one call with '&&'.\n  - Only when commands are truly independent may you set \`parallel: true\` on each Bash call so they can run in the same turn concurrently. Example: independent \`git status\` and \`git log\` may both set parallel:true. Never mark dependent commands parallel.\n  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.\n  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).\n - For git commands:\n  - Prefer to create a new commit rather than amending an existing commit.\n  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.\n  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.\n - Avoid unnecessary \`sleep\` commands:\n  - Do not sleep between commands that can run immediately — just run them.\n  - Do not retry failing commands in a sleep loop — diagnose the root cause or consider an alternative approach.\n  - If you must poll an external process, use a check command (e.g. \`gh run view\`) rather than sleeping first.\n  - If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.\n\n\n# Committing changes with git\n\nOnly create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:\n\nGit Safety Protocol:\n- NEVER update the git config\n- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions \n- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it\n- NEVER run force push to main/master, warn the user if they request it\n- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit\n- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries\n- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive\n\n1. Gather context before drafting a message. The following checks are independent read-only git commands. Bash defaults to serial — run them in separate sequential calls, or set \`parallel: true\` on each only if you issue them in the same turn:\n  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.\n  - Run a git diff command to see both staged and unstaged changes that will be committed.\n  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:\n  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).\n  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files\n  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"\n  - Ensure it accurately reflects the changes and their purpose\n3. Run the following dependent steps sequentially, proceeding only after the previous step succeeds:\n   - Stage only the relevant files, including intended modifications and untracked files.\n   - Create the commit with the drafted message.\n   - Run git status after the commit completes to verify success.\n   Note: git status depends on the commit completing, so run it sequentially after the commit.\n4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit\n\nImportant notes:\n- You may use tools and subagents to understand, review, or edit code and run relevant tests before committing. Subagents may modify files; coordinate their editing scopes to avoid conflicting edits.\n- When agents share a working directory, reserve Git state-changing operations (including staging, committing, switching branches, stash, reset, rebase, merge, restore, and checkout) for the primary agent to execute serially with the required user authorization. Subagents must not perform these operations in the shared working directory; this does not prohibit them from editing code or running tests. Confirm relevant editing tasks have finished before staging and committing.\n- DO NOT push to the remote repository unless the user explicitly asks you to do so\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:\n<example>\ngit commit -m "$(cat <<'EOF'\n   Commit message here.\n   EOF\n   )"\n</example>\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. Understand the current state of the branch since it diverged from the main branch. The following checks are independent read-only git commands. Bash defaults to serial — run them in separate sequential calls, or set \`parallel: true\` on each only if you issue them in the same turn:\n   - Run a git status command to see all untracked files (never use -uall flag)\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and \`git diff [base-branch]...HEAD\` to understand the full commit history for the current branch (from the time it diverged from the base branch)\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:\n   - Keep the PR title short (under 70 characters)\n   - Use the description/body for details, not the title\n3. Run the following dependent steps sequentially, proceeding only after the previous step succeeds:\n - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title "the pr title" --body "$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\n\n## Test plan\n[Bulleted markdown checklist of TODOs for testing the pull request...]\nEOF\n)"\n</example>\n\nImportant:\n- You may use tools and subagents to understand, review, or edit the pull request changes and run relevant tests. Subagents may edit code in coordinated, non-conflicting scopes. Follow the shared-working-directory Git state coordination rules above; independent checks and non-conflicting editing tasks may run in parallel, but dependent Git and pull request steps must run sequentially.\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`,
	rawJsonSchema: {
		type: "object",
		properties: {
			command: {
				description:
					"The command to execute. Mutually exclusive with `stop`: provide exactly one of them.",
				type: "string",
			},
			stop: {
				description:
					"Stop a running background bash task by its ID or alias (must belong to this narrator). When provided, no new command is launched. Mutually exclusive with `command`.",
				type: "string",
			},
			timeout: {
				description:
					"Optional timeout in milliseconds. Foreground commands default to 120000ms and retain their foreground safety cap; background commands default to 5 hours when omitted, use 0 for no wall-clock limit, or accept any positive safe integer.",
				type: "number",
			},
			workdir: {
				description:
					"Working directory for the command. Defaults to the Current Working Directory from the system prompt — " +
					"do NOT cd to it manually. Use this parameter only when you need a *different* directory.",
				type: "string",
			},
			description: {
				description:
					'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → "List files in current directory"\n- git status → "Show working tree status"\n- npm install → "Install package dependencies"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"\n- git reset --hard origin/main → "Discard all local changes and match remote main"\n- curl -s url | jq \'.data[]\' → "Fetch JSON from URL and extract data array elements"',
				type: "string",
			},
			run_in_background: {
				description:
					'Set to true to run this command in the background. Returns immediately with a task ID. Use Await({ type: "bash", id }) to check status or get results.',
				type: "boolean",
			},
			strict_serial: {
				description:
					"Force this command to wait for every previous tool in the turn, even if parallel:true is set. Bash is already serial by default; prefer omitting parallel over setting this.",
				type: "boolean",
			},
			parallel: {
				description:
					"Opt in to parallel execution for this command. Default is false — consecutive Bash calls run sequentially. Set true only when this command is independent of every other tool call in the same turn (e.g. independent git status/log checks). Dependent commands must not set this; chain them with && or wait across turns instead.",
				type: "boolean",
			},
		},
		required: [] as string[],
		additionalProperties: false,
	},
	getRawJsonSchema(config) {
		const schema = withDeviceParam(bashTool.rawJsonSchema as Record<string, unknown>, config);
		if (!config.reviewReadOnlyBash) return schema;
		const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		return {
			...schema,
			properties: {
				...properties,
				command: {
					...properties.command,
					description: REVIEW_READ_ONLY_BASH_DESCRIPTION,
				},
				run_in_background: {
					...properties.run_in_background,
					description: "Forbidden for review Bash; run synchronously only.",
				},
				stop: {
					...properties.stop,
					description: "Forbidden for review Bash; control operations are not allowed.",
				},
			},
		};
	},
	parameters: z.object({
		command: z
			.string()
			.optional()
			.describe(
				"The command to execute. Mutually exclusive with `stop`: provide exactly one of them.",
			),
		stop: z
			.string()
			.optional()
			.describe(
				"Stop a running background bash task by its ID or alias (must belong to this narrator). When provided, no new command is launched. Mutually exclusive with `command`.",
			),
		timeout: z
			.number()
			.optional()
			.describe(
				"Optional timeout in milliseconds. Foreground commands default to 120000ms; background commands default to 5 hours when omitted, use 0 for no wall-clock limit, or accept any positive safe integer.",
			),
		workdir: z
			.string()
			.optional()
			.describe(
				"Working directory for the command. Defaults to the Current Working Directory from the system prompt — " +
					"do NOT cd to it manually. Use this parameter only when you need a *different* directory.",
			),
		description: z
			.string()
			.optional()
			.describe(
				'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.',
			),
		run_in_background: z
			.boolean()
			.optional()
			.describe(
				'Set to true to run this command in the background. Returns immediately with a task ID. Use Await({ type: "bash", id }) to check status or get results.',
			),
		strict_serial: z
			.boolean()
			.optional()
			.describe(
				"Force this command to wait for every previous tool in the turn, even if parallel:true is set. Bash is already serial by default; prefer omitting parallel over setting this.",
			),
		parallel: z
			.boolean()
			.optional()
			.describe(
				"Opt in to parallel execution for this command. Default is false — consecutive Bash calls run sequentially. Set true only when this command is independent of every other tool call in the same turn.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		ctx = {
			...ctx,
			executionTarget: ctx.executionTarget && Object.freeze({ ...ctx.executionTarget }),
		};
		const { command, stop, timeout, workdir, description, run_in_background, device } = args as {
			command?: string;
			stop?: string;
			timeout?: number;
			workdir?: string;
			description?: string;
			run_in_background?: boolean;
			strict_serial?: boolean;
			parallel?: boolean;
			device?: string;
		};

		// --- Stop mode: cancel a running background bash task ---
		if (stop) {
			if (command) {
				return {
					output: "Use either `command` or `stop`, not both.",
					isError: true,
				};
			}
			try {
				const { resolveTaskAlias } = await import("@server/services/subagent-alias");
				let taskId = resolveTaskAlias(ctx.narratorId, stop);
				let task = await backgroundTaskService.getById(taskId);
				if (!task && taskId === stop) {
					task = await backgroundTaskService.getByAlias(stop, ctx.narratorId);
					if (task) taskId = task.id;
				}
				if (!task) {
					return {
						output: `Background bash task ${stop} does not exist.`,
						isError: true,
					};
				}
				if (task.type !== "bash") {
					return {
						output: `Background task ${stop} is an agent task, not bash. Use Agent({ stop }) to cancel it.`,
						isError: true,
					};
				}
				if (task.parentNarratorId !== ctx.narratorId) {
					return {
						output: `Background bash task ${stop} does not belong to this narrator.`,
						isError: true,
					};
				}
				const cancelled = await backgroundTaskService.cancel(taskId);
				if (cancelled) {
					return { output: `Background bash task ${stop} has been cancelled.` };
				}
				return {
					output: `Background bash task ${stop} is not running (may have already completed, failed, or been cancelled).`,
					isError: true,
				};
			} catch (err) {
				return {
					output: `Bash stop error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		if (!command) {
			return {
				output: "Provide either `command` (to run) or `stop` (to cancel a background task).",
				isError: true,
			};
		}

		let timeoutMs: number | undefined;
		try {
			timeoutMs = resolveBashTimeoutMs(run_in_background, timeout);
		} catch (error) {
			return {
				output: `Invalid timeout: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
		const backend = getToolBackend(ctx, device);
		// Resolve the working directory against the backend's base cwd (device
		// default cwd for remote, narrator cwd for local) using the backend's
		// path grammar.
		const base = toolBaseCwd(backend, ctx.cwd);
		const cwd = workdir ? resolveBackendPath(backend, base, workdir) : base;
		const title = description || command.slice(0, 80);

		// Only the local backend's cwd lives on this server's filesystem; a remote
		// device's cwd cannot be checked with the local fs (the executor validates
		// it and surfaces a clear error instead).
		if (backend.kind === "local" && !(await isExistingDirectory(backend, cwd))) {
			// A bad `workdir` argument only invalidates this one call. Report a plain
			// retryable error so the loop keeps running and the model can fix the path;
			// killing the narrator over the model's own typo (or a leaked-XML parse
			// artifact) loses the whole session for no reason.
			if (workdir && (await isExistingDirectory(backend, base))) {
				return createInvalidWorkdirArgumentResult({ missingCwd: cwd, baseCwd: base, title });
			}
			// The session's own working directory is gone (deleted worktree, unmounted
			// drive). Stop the loop rather than letting the model continue from an unknown
			// filesystem state; the structured metadata lets the session layer offer a
			// user-only recovery action afterward.
			return createMissingWorkingDirectoryResult({
				missingCwd: cwd,
				suggestedCwd: await firstExistingRecoveryCwd(backend, [
					base,
					ctx.worktreePath,
					ctx.projectGitPath,
					getHome(),
				]),
				title,
			});
		}

		// Attribute any commit this command makes to the person driving the turn
		// rather than to the host machine's global git config. Applied to EVERY
		// command, not just ones that look like `git commit`: the commit may happen
		// inside a shell pipeline, a build script or a `gh` invocation, and `GIT_*`
		// is inert for anything that is not git. A user's own inline assignment
		// (`GIT_AUTHOR_NAME=x git commit`) still wins, since shell assignments are
		// applied after the spawn environment.
		const gitIdentityEnv = await resolveNarratorGitIdentityEnv({
			turnUserId: ctx.userId,
			narratorId: ctx.narratorId,
		});

		let execution: BashExecution;
		try {
			execution = await prepareBashExecution(backend, command, cwd, ctx, gitIdentityEnv);
		} catch (error) {
			if (run_in_background) throw error;
			return {
				output: `Bash admission error: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}

		// Preserve background pre-spawn failures as rejected tool executions, while
		// releasing only activity that was never handed to a process.
		if (run_in_background) {
			try {
				return await _runInBackground(command, timeoutMs, title, ctx, execution);
			} finally {
				execution.cancelUndispatched();
			}
		}

		try {
			// Legacy attribution remains bounded/heuristic. Its timeout fallback does
			// NOT bypass the separately registered coordinator activity above.
			const serializationInput = await resolveBashSerializationInput({
				command,
				cwd,
				isBackground: false,
				isChapter: !!ctx.chapterId,
			});
			let releaseDetachedLease: (() => Promise<void>) | undefined;
			let resolveDetached!: (result: ToolResult) => void;
			const detachedResult = new Promise<ToolResult>((resolve) => {
				resolveDetached = resolve;
			});
			const runForeground = async (): Promise<ToolResult> => {
				// Backends may retain start(signal) until actual process settlement.
				// Give them an execution-owned signal and only forward foreground aborts
				// while this execution still belongs to the foreground tool.
				const processAbort = new AbortController();
				const forwardAbort = () => processAbort.abort(ctx.signal.reason);
				ctx.signal.addEventListener("abort", forwardAbort, { once: true });
				if (ctx.signal.aborted) forwardAbort();
				let handle: ExecHandle;
				try {
					handle = await execution.start(processAbort.signal);
				} catch (error) {
					ctx.signal.removeEventListener("abort", forwardAbort);
					throw error;
				}
				let detached: DetachedBashProcess | undefined;
				let detachPending: Promise<DetachedBashProcess> | undefined;
				let output = "";
				let timedOut = false;
				let aborted = false;
				let exited = false;

				const kill = () => handle.kill();

				// Collect stdout + stderr into a single buffer with size limit.
				// Use StringDecoder to handle multi-byte UTF-8 characters split across chunks.
				let outputBytes = 0;
				let outputTruncated = false;
				let lastLiveEmitAt = 0;
				let pendingLiveEmit = false;
				let liveEmitTimer: ReturnType<typeof setTimeout> | null = null;
				const decoder = createStreamDecoder();
				const getLiveOutputPreview = () =>
					output.length > LIVE_OUTPUT_MAX_CHARS
						? `...${output.length - LIVE_OUTPUT_MAX_CHARS} chars omitted...\n${output.slice(-LIVE_OUTPUT_MAX_CHARS)}`
						: output;
				const flushLiveOutput = () => {
					if (liveEmitTimer) {
						clearTimeout(liveEmitTimer);
						liveEmitTimer = null;
					}
					pendingLiveEmit = false;
					lastLiveEmitAt = Date.now();
					ctx.emitOutput?.(getLiveOutputPreview());
				};
				const scheduleLiveOutput = (force = false) => {
					if (detached || !ctx.emitOutput) return;
					if (force || Date.now() - lastLiveEmitAt >= LIVE_OUTPUT_INTERVAL_MS) {
						flushLiveOutput();
						return;
					}
					if (pendingLiveEmit) return;
					pendingLiveEmit = true;
					liveEmitTimer = setTimeout(flushLiveOutput, LIVE_OUTPUT_INTERVAL_MS);
				};
				const appendText = (text: string) => {
					output += text;
					if (detached && text && !processAbort.signal.aborted)
						backgroundTaskService.appendOutput(detached.taskId, text);
				};
				const append = (raw: Uint8Array) => {
					if (outputTruncated) return;
					const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
					outputBytes += chunk.byteLength;
					if (outputBytes > MAX_OUTPUT_BYTES) {
						appendText(
							decoder.write(chunk).slice(0, 200) +
								"\n\n<bash_metadata>\nOutput truncated at 10MB in-memory limit\n</bash_metadata>",
						);
						outputTruncated = true;
						scheduleLiveOutput(true);
						return;
					}
					appendText(decoder.write(chunk));
					scheduleLiveOutput();
				};
				handle.onData(append);

				// Set up the exit promise FIRST, before any kill calls,
				// so we never miss the exit event.
				// Mark `exited` as a side-effect for the watchdog; the exit code itself
				// is captured by awaiting handle.exited at the wait point below.
				handle.exited.then(
					() => {
						exited = true;
					},
					() => {
						exited = true;
					},
				);

				// Abort: if already aborted, kill immediately
				if (ctx.signal.aborted) {
					aborted = true;
					await kill();
				}

				const abortHandler = () => {
					aborted = true;
					void kill();
				};
				ctx.signal.addEventListener("abort", abortHandler, { once: true });

				// Timeout
				const timer = setTimeout(() => {
					timedOut = true;
					void kill();
				}, timeoutMs);

				// Serialize concurrent detach requests. Output stays in this collector
				// during durable task creation, including a process exit in that window.
				const detach = (): Promise<DetachedBashProcess> => {
					if (detachPending) return detachPending;
					if (exited || handle.isExited() || timedOut || aborted || ctx.signal.aborted)
						return Promise.reject(new AppError("Bash is no longer running in foreground", 409));
					detachPending = (async () => {
						const { registerTaskAlias, unregisterTaskAlias } = await import(
							"@server/services/subagent-alias"
						);
						if (exited || handle.isExited() || timedOut || aborted || ctx.signal.aborted)
							throw new AppError("Bash is no longer running in foreground", 409);
						const taskId = `bash_${generateShortId()}`;
						const { alias } = registerTaskAlias(ctx.narratorId, taskId, title);
						try {
							await backgroundTaskService.createBashTask({
								id: taskId,
								parentNarratorId: ctx.narratorId,
								command,
								toolUseId: ctx.currentToolUseId ?? undefined,
								toolCallBinding: ctx.toolCallBinding,
								executionTarget: ctx.executionTarget,
								alias,
								title,
							});
						} catch (error) {
							unregisterTaskAlias(ctx.narratorId, taskId);
							throw error;
						}
						if (timedOut || aborted || ctx.signal.aborted) {
							await backgroundTaskService.markFailed(
								taskId,
								"Foreground Bash stopped during detach",
							);
							unregisterTaskAlias(ctx.narratorId, taskId);
							throw new AppError("Bash is no longer running in foreground", 409);
						}
						const updateLeaseTransferred = ctx.updateExecutionLease?.transfer() ?? false;
						if (ctx.updateExecutionLease && !updateLeaseTransferred) {
							await backgroundTaskService.markFailed(taskId, "Could not transfer execution lease");
							unregisterTaskAlias(ctx.narratorId, taskId);
							throw new Error("Background Bash could not transfer its update execution lease");
						}
						if (updateLeaseTransferred) {
							releaseDetachedLease = async () => {
								try {
									await (handle.whenSettled ?? handle.exited);
								} catch {
									// Coordinator independently retains unknown-outcome holds.
								} finally {
									ctx.updateExecutionLease?.release();
								}
							};
						}
						detached = { taskId, alias };
						ctx.signal.removeEventListener("abort", forwardAbort);
						ctx.signal.removeEventListener("abort", abortHandler);
						if (liveEmitTimer) clearTimeout(liveEmitTimer);
						liveEmitTimer = null;
						pendingLiveEmit = false;
						backgroundTaskService.registerAbortController(taskId, processAbort);
						backgroundTaskService.registerKillHandler(taskId, () => void kill());
						if (output) backgroundTaskService.appendOutput(taskId, output);
						resolveDetached({
							output:
								`<background_task_id>${alias}</background_task_id>\n\n` +
								`Bash moved to background: ${title}\nAwait({ type: "bash", id: "${alias}" })`,
							title,
							metadata: {
								background_task_id: taskId,
								background_task_alias: alias,
								detached: true,
							},
						});
						return detached;
					})();
					void detachPending.catch(() => {
						detachPending = undefined;
					});
					return detachPending;
				};

				// Register in the running map so the UI can update timeout mid-execution
				const toolUseId = ctx.currentToolUseId;
				if (toolUseId) {
					runningBashProcesses.set(toolUseId, {
						timer,
						startedAt: Date.now(),
						timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
						narratorId: ctx.narratorId,
						detach,
						kill: () => void kill(),
						setTimedOut: () => {
							timedOut = true;
						},
					});
				}

				// Watchdog: periodically check process health (Redisson-style renew/kill).
				// If the process has been running ≥60s, emit a long-running notification
				// so the UI can show a terminate button.
				// 看门狗状态：输出增量检测、长时间运行通知去重、异常终止标记
				let lastOutputLen = 0;
				let longRunningFired = false;
				let watchdogKilled = false;
				const watchdogStart = Date.now();
				const watchdogTimer = setInterval(() => {
					if (exited) return;

					const elapsed = Date.now() - watchdogStart;
					const currentLen = output.length;
					const hadOutput = currentLen > lastOutputLen;
					lastOutputLen = currentLen;

					// Check if PID is still alive. Only the local backend exposes a pid;
					// remote backends report liveness solely via handle.isExited().
					let pidAlive = true;
					const pid = handle.pid;
					if (pid) {
						try {
							process.kill(pid, 0);
							pidAlive = true;
						} catch {
							pidAlive = false;
						}
					}

					// Kill if process is dead and no recent output (zombie/leaked)
					if (!pidAlive && !hadOutput && !exited) {
						watchdogKilled = true;
						void kill();
						return;
					}

					// Notify UI once when process exceeds long-running threshold.
					// ctx.emitLongRunning 由 loop.ts 注入，触发链路：
					// tool_long_running AgentEvent → narrator-event-handler → WS → 前端终止按钮
					if (!detached && !longRunningFired && elapsed >= LONG_RUNNING_THRESHOLD_MS) {
						longRunningFired = true;
						const toolUseId = ctx.currentToolUseId;
						if (toolUseId) {
							ctx.emitLongRunning?.(toolUseId, elapsed);
						}
					}
				}, WATCHDOG_INTERVAL_MS);

				// Wait for process to finish
				let exitCodeValue: number | null = null;
				try {
					exitCodeValue = await handle.exited;
					await detachPending?.catch(() => undefined);
				} catch (error) {
					await detachPending?.catch(() => undefined);
					if (toolUseId) {
						clearTimeout(runningBashProcesses.get(toolUseId)?.timer);
						runningBashProcesses.delete(toolUseId);
					}
					if (liveEmitTimer) clearTimeout(liveEmitTimer);
					if (detached) {
						await backgroundTaskService.markFailed(
							detached.taskId,
							`${output}\nError: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					throw error;
				} finally {
					clearTimeout(timer);
					if (toolUseId) clearTimeout(runningBashProcesses.get(toolUseId)?.timer);
					clearInterval(watchdogTimer);
					ctx.signal.removeEventListener("abort", abortHandler);
					ctx.signal.removeEventListener("abort", forwardAbort);
					if (detached) {
						// Tool return is not process settlement: retain the legacy write
						// lock and transferred lease until the backend's real barrier.
						try {
							await (handle.whenSettled ?? handle.exited);
						} catch {
							// Coordinator retains its unknown-outcome recovery hold.
						}
					}
				}

				// Flush any bytes buffered inside the decoder (the legacy-encoding decoder
				// holds back the first chunks until it can detect the charset, so short
				// outputs may still be fully buffered at this point).
				if (!outputTruncated) {
					const tail = decoder.end();
					if (tail) output += tail;
				}

				// Flush any pending live output before sending the final tool result.
				if (!detached && (pendingLiveEmit || output)) flushLiveOutput();

				// Capture the effective timeout (may have been updated mid-execution)
				const effectiveTimeout = toolUseId
					? (runningBashProcesses.get(toolUseId)?.timeoutMs ?? timeoutMs)
					: timeoutMs;
				if (toolUseId) runningBashProcesses.delete(toolUseId);

				// Append metadata about abnormal termination so the LLM knows what happened
				const meta: string[] = [];
				if (timedOut) meta.push(`Command timed out after ${effectiveTimeout}ms`);
				if (watchdogKilled)
					meta.push("Process was terminated by watchdog (process exited unexpectedly)");
				if (aborted) meta.push("Command was aborted by user");
				if (!timedOut && !aborted && handle.outputIncomplete?.()) {
					meta.push(
						"Output is incomplete: the device reached its output limit or a background " +
							"process kept the output pipes open after the command exited",
					);
				}
				if (meta.length > 0) {
					output += `\n\n<bash_metadata>\n${meta.join("\n")}\n</bash_metadata>`;
				}

				const exitCode = exitCodeValue ?? (timedOut || aborted || watchdogKilled ? 1 : 0);
				if (exitCode !== 0) output += `\n[exit code: ${exitCode}]`;

				if (detached) {
					if (timedOut) {
						await backgroundTaskService.markTimedOut(detached.taskId, output, exitCode);
					} else if (exitCode === 0) {
						await backgroundTaskService.markCompleted(detached.taskId, output, exitCode);
					} else {
						await backgroundTaskService.markFailed(detached.taskId, output, exitCode);
					}
					// The foreground already received its adoption result. The service
					// owns output spillage now; do not create a second foreground dump.
					return { output: "", title };
				}

				const truncated = truncateOutput(output || "(no output)");

				return {
					output: truncated.content,
					isError: exitCode !== 0,
					title,
					metadata: truncated.outputPath ? { fullOutputPath: truncated.outputPath } : undefined,
					truncated: truncated.truncated,
				};
			};

			// Race only the HTTP/tool result, not the write-lock callback or process
			// collector. They continue until the original execution really settles.
			const lifecycle = withBashWriteLock(backend, serializationInput, runForeground)
				.then((outcome) => outcome.value)
				// Release after terminal output/status publication, just like Bash
				// started in background mode, not immediately upon process exit.
				.finally(() => releaseDetachedLease?.());
			return await Promise.race([lifecycle, detachedResult]);
		} catch (err) {
			return {
				output: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		} finally {
			// Background start() owns lifetime before returning; only pre-spawn
			// admission/task/serialization failures are cleaned up here.
			execution.cancelUndispatched();
		}
	},
};

// --- Background execution helper ---

import type { ToolContext } from "../types";

async function _runInBackground(
	command: string,
	timeoutMs: number | undefined,
	title: string,
	ctx: ToolContext,
	execution: BashExecution,
): Promise<ToolResult> {
	const taskId = `bash_${generateShortId()}`;
	const bgAbort = new AbortController();

	// Register a human-readable alias for this background task
	const { registerTaskAlias } = await import("@server/services/narrator-subagent");
	const { alias, conflicted } = registerTaskAlias(ctx.narratorId, taskId, title);

	// Create the task record in the service (DB-backed)
	await backgroundTaskService.createBashTask({
		id: taskId,
		parentNarratorId: ctx.narratorId,
		command,
		toolUseId: ctx.currentToolUseId ?? undefined,
		toolCallBinding: ctx.toolCallBinding,
		executionTarget: ctx.executionTarget,
		alias,
		title,
	});
	backgroundTaskService.registerAbortController(taskId, bgAbort);

	// The executor owns the lease until the durable task record exists. Transfer it only
	// when the fire-and-forget lifecycle is ready to assume release responsibility.
	const updateLeaseTransferred = ctx.updateExecutionLease?.transfer() ?? false;
	if (ctx.updateExecutionLease && !updateLeaseTransferred) {
		throw new Error("Background Bash could not transfer its update execution lease");
	}

	// Fire-and-forget: spawn the process and collect output asynchronously
	(async () => {
		let timedOut = false;
		try {
			// Frozen backend/cwd/env and activity were captured before task creation.
			// Do not resolve a second backend after the tool/HTTP request has returned.
			ctx.signal.throwIfAborted();
			const handle = await execution.start(bgAbort.signal);
			let outputBytes = 0;
			let outputTruncated = false;
			const killFn = () => handle.kill();
			backgroundTaskService.registerKillHandler(taskId, () => void killFn());

			const bgDecoder = createStreamDecoder();
			const appendOutput = (raw: Uint8Array) => {
				if (outputTruncated) return;
				const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
				const str = bgDecoder.write(chunk);
				outputBytes += chunk.byteLength;
				if (outputBytes > MAX_OUTPUT_BYTES) {
					backgroundTaskService.appendOutput(
						taskId,
						`${str.slice(0, 200)}\n\n<bash_metadata>\nOutput truncated at ${(MAX_OUTPUT_BYTES / 1024 / 1024).toFixed(0)}MB limit\n</bash_metadata>`,
					);
					outputTruncated = true;
					return;
				}
				if (str) backgroundTaskService.appendOutput(taskId, str);
			};
			handle.onData(appendOutput);

			let watchdogKilled = false;
			let exited = false;
			void handle.exited.then(
				() => {
					exited = true;
				},
				() => {
					exited = true;
				},
			);

			const executionTimeout = createOptionalExecutionTimeout(
				timeoutMs,
				"Background command timeout",
			);
			const onTimeout = () => {
				if (timedOut) return;
				timedOut = true;
				backgroundTaskService.appendOutput(
					taskId,
					"\n\n<bash_metadata>\nBackground command timed out\n</bash_metadata>",
				);
				void killFn();
			};
			executionTimeout?.signal.addEventListener("abort", onTimeout, { once: true });
			if (executionTimeout?.signal.aborted) onTimeout();

			// Health watchdog: do not kill a quiet but healthy long-running command.
			// Only terminate a local process whose PID disappeared while the handle
			// still claims it has not exited. Remote handles rely on RPC liveness.
			const watchdogTimer = setInterval(() => {
				if (exited || handle.isExited()) return;
				const pid = handle.pid;
				if (pid == null) return;
				try {
					process.kill(pid, 0);
				} catch (error) {
					const code =
						error && typeof error === "object" && "code" in error ? error.code : undefined;
					if (code !== "ESRCH") return;
					watchdogKilled = true;
					void killFn();
				}
			}, WATCHDOG_INTERVAL_MS);

			let resolvedExitCode: number | null;
			try {
				resolvedExitCode = await handle.exited;
			} finally {
				clearInterval(watchdogTimer);
				executionTimeout?.signal.removeEventListener("abort", onTimeout);
				executionTimeout?.dispose();
			}

			// Flush bytes buffered inside the decoder (see foreground path).
			if (!outputTruncated) {
				const tail = bgDecoder.end();
				if (tail) backgroundTaskService.appendOutput(taskId, tail);
			}

			const exitCode = resolvedExitCode ?? 1;
			if (watchdogKilled) {
				backgroundTaskService.appendOutput(
					taskId,
					"\n\n<bash_metadata>\nBackground command terminated by health watchdog\n</bash_metadata>",
				);
			} else if (!timedOut && handle.outputIncomplete?.()) {
				backgroundTaskService.appendOutput(
					taskId,
					"\n\n<bash_metadata>\nOutput is incomplete: the device reached its output limit or a " +
						"background process kept the output pipes open after the command exited\n</bash_metadata>",
				);
			}
			const output = backgroundTaskService.getOutputBuffer(taskId) ?? "";
			const finalOutput = exitCode !== 0 ? `${output}\n[exit code: ${exitCode}]` : output;

			if (timedOut) {
				await backgroundTaskService.markTimedOut(taskId, finalOutput, exitCode);
			} else if (exitCode === 0) {
				await backgroundTaskService.markCompleted(taskId, finalOutput, exitCode);
			} else {
				await backgroundTaskService.markFailed(taskId, finalOutput, exitCode);
			}
		} catch (err) {
			const output = backgroundTaskService.getOutputBuffer(taskId) ?? "";
			const error = `${output}\nError: ${err instanceof Error ? err.message : String(err)}`;
			if (timedOut) {
				await backgroundTaskService.markTimedOut(taskId, error);
			} else {
				await backgroundTaskService.markFailed(taskId, error);
			}
		} finally {
			if (updateLeaseTransferred) ctx.updateExecutionLease?.release();
		}
	})();

	let output =
		`<background_task_id>${alias}</background_task_id>\n\n` +
		`Background bash task started: ${title}\n` +
		`Await({ type: "bash", id: "${alias}" })`;

	if (conflicted) {
		output +=
			`\n\nNote: A similar alias was already taken. ` +
			`This task was assigned "${alias}" instead.`;
	}

	return { output, title };
}
