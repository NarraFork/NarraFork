import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getHome } from "../../platform";
import { detectShell, killTree } from "../shell";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export const bashTool: ToolDefinition = {
	name: "Bash",
	description:
		"Execute a bash command. Use for git, npm, system commands. " +
		"Commands run in the Current Working Directory by default — do NOT prepend `cd <cwd> &&` as it is redundant. " +
		"Output exceeding 2000 lines or 50KB is truncated; full output is saved to a file for retrieval via Read (offset/limit or force_full=true) or Grep. " +
		"IMPORTANT: Prefer dedicated tools over Bash when possible — use Read instead of cat/head/tail, " +
		"Write instead of echo/cat heredoc, Edit instead of sed/awk, Glob instead of find/ls, " +
		"Grep instead of grep/rg. Only use Bash for operations that genuinely require shell execution. " +
		"AVOID using `cd <directory> && <command>` — use the `workdir` parameter instead.",
	parameters: z.object({
		command: z.string().describe("Bash command to execute"),
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
			const shell = detectShell();
			const proc = spawn(command, {
				shell,
				cwd,
				env: { ...process.env, HOME: getHome() },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});

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
