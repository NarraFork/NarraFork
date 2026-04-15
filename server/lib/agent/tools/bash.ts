import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getHome } from "../../platform";
import { loadSettings } from "../../settings";
import { buildMinimalEnv, detectShell, killTree } from "../shell";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 86_400_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const LONG_RUNNING_THRESHOLD_MS = 60_000;

/** Tool name: "Bash" when using bash (including Git Bash on Windows), "Shell" for PowerShell/cmd. */
export const SHELL_TOOL_NAME = detectShell().type === "bash" ? "Bash" : "Shell";

export const bashTool: ToolDefinition = {
	name: SHELL_TOOL_NAME,
	description: `Executes a given bash command and returns its output.\n\nThe working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).\n\nIMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\n\n - File search: Use Glob (NOT find or ls)\n - Content search: Use Grep (NOT grep or rg)\n - Read files: Use Read (NOT cat/head/tail)\n - Edit files: Use Edit (NOT sed/awk)\n - Write files: Use Write (NOT echo >/cat <<EOF)\n - Communication: Output text directly (NOT echo/printf)\nWhile the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.\n\n# Instructions\n - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.\n - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")\n - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.\n - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).\n - You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.\n - Write a clear, concise description of what your command does. For simple commands, keep it brief (5-10 words). For complex commands (piped commands, obscure flags, or anything hard to understand at a glance), include enough context so that the user can understand what your command will do.\n - When issuing multiple commands:\n  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel.\n  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.\n  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.\n  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).\n - For git commands:\n  - Prefer to create a new commit rather than amending an existing commit.\n  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.\n  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.\n - Avoid unnecessary \`sleep\` commands:\n  - Do not sleep between commands that can run immediately — just run them.\n  - If your command is long running and you would like to be notified when it finishes – simply run your command using \`run_in_background\`. There is no need to sleep in this case.\n  - Do not retry failing commands in a sleep loop — diagnose the root cause or consider an alternative approach.\n  - If waiting for a background task you started with \`run_in_background\`, you will be notified when it completes — do not poll.\n  - If you must poll an external process, use a check command (e.g. \`gh run view\`) rather than sleeping first.\n  - If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.\n\n\n# Committing changes with git\n\nOnly create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:\n\nGit Safety Protocol:\n- NEVER update the git config\n- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions \n- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it\n- NEVER run force push to main/master, warn the user if they request it\n- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit\n- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries\n- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive\n\n1. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following bash commands in parallel, each using the Bash tool:\n  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.\n  - Run a git diff command to see both staged and unstaged changes that will be committed.\n  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:\n  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).\n  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files\n  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"\n  - Ensure it accurately reflects the changes and their purpose\n3. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following commands:\n   - Add relevant untracked files to the staging area.\n   - Create the commit with the drafted message.\n   - Run git status after the commit completes to verify success.\n   Note: git status depends on the commit completing, so run it sequentially after the commit.\n4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit\n\nImportant notes:\n- NEVER run additional commands to read or explore code, besides git bash commands\n- NEVER use the TodoWrite or Agent tools\n- DO NOT push to the remote repository unless the user explicitly asks you to do so\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:\n<example>\ngit commit -m "$(cat <<'EOF'\n   Commit message here.\n   EOF\n   )"\n</example>\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:\n   - Run a git status command to see all untracked files (never use -uall flag)\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and \`git diff [base-branch]...HEAD\` to understand the full commit history for the current branch (from the time it diverged from the base branch)\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:\n   - Keep the PR title short (under 70 characters)\n   - Use the description/body for details, not the title\n3. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following commands in parallel:\n   - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title "the pr title" --body "$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\n\n## Test plan\n[Bulleted markdown checklist of TODOs for testing the pull request...]\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nEOF\n)"\n</example>\n\nImportant:\n- DO NOT use the TodoWrite or Agent tools\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`,
	rawJsonSchema: {
		type: "object",
		properties: {
			command: {
				description: "The command to execute",
				type: "string",
			},
			timeout: {
				description: "Optional timeout in milliseconds (max 600000)",
				type: "number",
			},
			description: {
				description:
					'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → "List files in current directory"\n- git status → "Show working tree status"\n- npm install → "Install package dependencies"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"\n- git reset --hard origin/main → "Discard all local changes and match remote main"\n- curl -s url | jq \'.data[]\' → "Fetch JSON from URL and extract data array elements"',
				type: "string",
			},
			run_in_background: {
				description:
					"Set to true to run this command in the background. Use TaskOutput to read the output later.",
				type: "boolean",
			},
			dangerouslyDisableSandbox: {
				description:
					"Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
				type: "boolean",
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
	parameters: z.object({
		command: z.string().describe("The command to execute"),
		timeout: z.number().optional().describe("Optional timeout in milliseconds (max 600000)"),
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
				"Set to true to run this command in the background. Use TaskOutput to read the output later.",
			),
		dangerouslyDisableSandbox: z
			.boolean()
			.optional()
			.describe(
				"Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { command, timeout, workdir, description } = args as {
			command: string;
			timeout?: number;
			workdir?: string;
			description?: string;
		};
		const timeoutMs = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT_MS, 0), MAX_TIMEOUT_MS);
		const cwd = workdir ? path.resolve(ctx.cwd, workdir) : ctx.cwd;
		const title = description || command.slice(0, 80);

		if (!existsSync(cwd)) {
			return {
				output: `Working directory does not exist: ${cwd}\nPlease check your project path and try again.`,
				isError: true,
				fatal: true,
				title,
			};
		}

		try {
			const shellInfo = detectShell();
			const isWin = process.platform === "win32";
			const freshEnv = loadSettings().agent.freshShellEnv;

			// Build env: in fresh mode use a minimal set so login shell profile
			// populates the rest; otherwise inherit the server process env.
			let env: Record<string, string | undefined>;
			if (freshEnv) {
				env = buildMinimalEnv(shellInfo.extraEnv);
			} else {
				// Spread process.env then apply overrides.
				// On Windows, the PATH variable is typically named "Path" (title-case).
				// When we spread process.env into a plain object the case-insensitive
				// proxy is lost, so bash (which expects uppercase "PATH") won't see it.
				// Fix: always set an uppercase PATH from the original process.env.PATH
				// (the proxy handles case-insensitive lookup).
				env = {
					...process.env,
					HOME: getHome(),
					...shellInfo.extraEnv,
				};
				if (isWin && !env.PATH && process.env.PATH) {
					env.PATH = process.env.PATH;
				}
			}

			// On Windows with Git Bash we must use login-shell mode so that
			// /etc/profile is sourced and PATH is properly converted from
			// Windows format to POSIX format.  Without this, tools like node,
			// npm, git etc. are invisible to the spawned bash process.
			//
			// `detached` is only useful on Unix (creates a new process group for
			// clean tree-kill via negative PID).  On Windows it creates a new
			// console window and can break stdio pipes, so we skip it.
			//
			// When freshShellEnv is enabled on Unix, always use login-shell
			// wrapping (`-l -c`) so the shell sources its profile files.
			let spawnArgs: [string, string[], object];
			if (shellInfo.loginWrap) {
				spawnArgs = [
					shellInfo.path,
					["--login", "-c", command],
					{ cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false },
				];
			} else if (shellInfo.type === "powershell") {
				// PowerShell: in fresh mode, allow $PROFILE to load;
				// otherwise use -NoProfile for clean, predictable execution.
				const psArgs = freshEnv
					? ["-NonInteractive", "-Command", command]
					: ["-NoProfile", "-NonInteractive", "-Command", command];
				spawnArgs = [
					shellInfo.path,
					psArgs,
					{ cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false },
				];
			} else if (freshEnv) {
				// Unix fresh mode: wrap as login shell to source profile
				spawnArgs = [
					shellInfo.path,
					["-l", "-c", command],
					{ cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
				];
			} else {
				spawnArgs = [
					command,
					[],
					{
						shell: shellInfo.path,
						cwd,
						env,
						stdio: ["ignore", "pipe", "pipe"],
						detached: !isWin,
					},
				];
			}

			const proc = spawn(...spawnArgs);

			let output = "";
			let timedOut = false;
			let aborted = false;
			let exited = false;

			const exitedFn = () => exited;
			const kill = () => killTree(proc, { exited: exitedFn });

			// Collect stdout + stderr into a single buffer
			const append = (chunk: Buffer) => {
				output += chunk.toString();
				ctx.emitOutput?.(output);
			};
			proc.stdout?.on("data", append);
			proc.stderr?.on("data", append);

			// Set up the exit promise FIRST, before any kill calls,
			// so we never miss the exit event.
			const exitPromise = new Promise<void>((resolve, reject) => {
				if (proc.exitCode !== null) {
					exited = true;
					resolve();
					return;
				}
				proc.once("exit", () => {
					exited = true;
					resolve();
				});
				proc.once("error", (err) => {
					exited = true;
					reject(err);
				});
			});

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

				// Check if PID is still alive
				let pidAlive = false;
				if (proc.pid) {
					try {
						process.kill(proc.pid, 0);
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
				if (!longRunningFired && elapsed >= LONG_RUNNING_THRESHOLD_MS) {
					longRunningFired = true;
					const toolUseId = ctx.currentToolUseId;
					if (toolUseId) {
						ctx.emitLongRunning?.(toolUseId, elapsed);
					}
				}
			}, WATCHDOG_INTERVAL_MS);

			// Wait for process to finish
			try {
				await exitPromise;
			} finally {
				clearTimeout(timer);
				clearInterval(watchdogTimer);
				ctx.signal.removeEventListener("abort", abortHandler);
			}

			// Append metadata about abnormal termination so the LLM knows what happened
			const meta: string[] = [];
			if (timedOut) meta.push(`Command timed out after ${timeoutMs}ms`);
			if (watchdogKilled)
				meta.push("Process was terminated by watchdog (process exited unexpectedly)");
			if (aborted) meta.push("Command was aborted by user");
			if (meta.length > 0) {
				output += `\n\n<bash_metadata>\n${meta.join("\n")}\n</bash_metadata>`;
			}

			const exitCode = proc.exitCode ?? (timedOut || aborted || watchdogKilled ? 1 : 0);
			if (exitCode !== 0) output += `\n[exit code: ${exitCode}]`;

			const truncated = truncateOutput(output || "(no output)");

			return {
				output: truncated.content,
				isError: exitCode !== 0,
				title,
				truncated: truncated.truncated,
			};
		} catch (err) {
			return {
				output: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
