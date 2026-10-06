/** Shared utility for running commands with timeout in evaluators. */

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Run a command with a timeout. Returns stdout/stderr as strings.
 * Never throws — check exitCode and timedOut instead.
 */
export async function runCommand(
	cmd: string[],
	cwd: string,
	timeoutMs = 60_000,
): Promise<CommandResult> {
	try {
		const proc = Bun.spawn(cmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				// ignore
			}
		}, timeoutMs);

		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		clearTimeout(timer);

		return { exitCode, stdout, stderr, timedOut };
	} catch (err) {
		return {
			exitCode: -1,
			stdout: "",
			stderr: String(err).slice(0, 3000),
			timedOut: String(err).includes("kill"),
		};
	}
}

/**
 * Run a bash command string with timeout.
 */
export async function runBash(
	script: string,
	cwd: string,
	timeoutMs = 60_000,
): Promise<CommandResult> {
	return runCommand(["bash", "-c", script], cwd, timeoutMs);
}
