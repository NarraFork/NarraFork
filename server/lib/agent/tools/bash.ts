import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getHome, IS_WINDOWS } from "../../platform";
import { detectShell, killTree } from "../shell";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Platform-aware tool name: "Shell" on Windows, "Bash" elsewhere. */
export const SHELL_TOOL_NAME = IS_WINDOWS ? "Shell" : "Bash";

const shellLower = IS_WINDOWS ? "shell" : "bash";
const shellExamples = IS_WINDOWS
	? "Use Read instead of type/Get-Content, Write instead of echo/Set-Content, Edit instead of (Get-Content).Replace, Glob instead of dir/Get-ChildItem, Grep instead of Select-String."
	: "Use Read instead of cat/head/tail, Write instead of echo/cat heredoc, Edit instead of sed/awk, Glob instead of find/ls, Grep instead of grep/rg.";

export const bashTool: ToolDefinition = {
	name: SHELL_TOOL_NAME,
	description:
		`Execute a ${shellLower} command. Use for git, npm, system commands. ` +
		"Commands run in the Current Working Directory by default — do NOT prepend `cd <cwd> &&` as it is redundant. " +
		"Output exceeding 2000 lines or 50KB is truncated; full output is saved to a file for retrieval via Read (offset/limit or force_full=true) or Grep. " +
		`IMPORTANT: Prefer dedicated tools over ${SHELL_TOOL_NAME} when possible — ${shellExamples} ` +
		`Only use ${SHELL_TOOL_NAME} for operations that genuinely require shell execution. ` +
		"AVOID using `cd <directory> && <command>` — use the `workdir` parameter instead.",
	parameters: z.object({
		command: z.string().describe(`${SHELL_TOOL_NAME} command to execute`),
		timeout: z
			.number()
			.optional()
			.describe("Timeout in milliseconds (default: 120000, max: 600000)"),
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
				"Clear, concise description of what this command does (5-10 words). " +
					"Examples: 'Lists files in current directory', 'Installs package dependencies', 'Shows git status'",
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

			// Build env: spread process.env then apply overrides.
			// On Windows, the PATH variable is typically named "Path" (title-case).
			// When we spread process.env into a plain object the case-insensitive
			// proxy is lost, so bash (which expects uppercase "PATH") won't see it.
			// Fix: always set an uppercase PATH from the original process.env.PATH
			// (the proxy handles case-insensitive lookup).
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: getHome(),
				...shellInfo.extraEnv,
			};
			if (isWin && !env.PATH && process.env.PATH) {
				env.PATH = process.env.PATH;
			}

			// On Windows with Git Bash we must use login-shell mode so that
			// /etc/profile is sourced and PATH is properly converted from
			// Windows format to POSIX format.  Without this, tools like node,
			// npm, git etc. are invisible to the spawned bash process.
			//
			// `detached` is only useful on Unix (creates a new process group for
			// clean tree-kill via negative PID).  On Windows it creates a new
			// console window and can break stdio pipes, so we skip it.
			let spawnArgs: [string, string[], object];
			if (shellInfo.loginWrap) {
				spawnArgs = [
					shellInfo.path,
					["--login", "-c", command],
					{ cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false },
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

			// Wait for process to finish
			try {
				await exitPromise;
			} finally {
				clearTimeout(timer);
				ctx.signal.removeEventListener("abort", abortHandler);
			}

			// Append metadata about abnormal termination so the LLM knows what happened
			const meta: string[] = [];
			if (timedOut) meta.push(`Command timed out after ${timeoutMs}ms`);
			if (aborted) meta.push("Command was aborted by user");
			if (meta.length > 0) {
				output += `\n\n<bash_metadata>\n${meta.join("\n")}\n</bash_metadata>`;
			}

			const exitCode = proc.exitCode ?? (timedOut || aborted ? 1 : 0);
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
