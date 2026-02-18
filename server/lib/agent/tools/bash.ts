import { z } from "zod/v4";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";

const TIMEOUT_MS = 120_000;

export const bashTool: ToolDefinition = {
	name: "Bash",
	description:
		"Execute a bash command. Use for git, npm, system commands. Output is truncated at 30000 chars.",
	parameters: z.object({
		command: z.string(),
		timeout: z.number().optional(),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { command, timeout } = args as { command: string; timeout?: number };
		const timeoutMs = Math.min(timeout ?? TIMEOUT_MS, 600_000);

		try {
			const proc = Bun.spawn(["bash", "-c", command], {
				cwd: ctx.cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: process.env.HOME ?? "/root" },
			});

			const timer = setTimeout(() => proc.kill(), timeoutMs);
			const onAbort = () => proc.kill();
			ctx.signal.addEventListener("abort", onAbort, { once: true });
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			clearTimeout(timer);
			ctx.signal.removeEventListener("abort", onAbort);

			const exitCode = await proc.exited;
			let output = stdout;
			if (stderr) output += (output ? "\n" : "") + stderr;
			if (exitCode !== 0) output += `\n[exit code: ${exitCode}]`;

			return {
				output: truncateOutput(output || "(no output)"),
				isError: exitCode !== 0,
				title: command.slice(0, 80),
			};
		} catch (err) {
			return {
				output: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
