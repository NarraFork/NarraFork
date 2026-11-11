/** Only build subprocesses: hard deadline, cancellation, bounded diagnostics, no execution fallback. */
export async function runRuntimeBuildCommand(
	command: string[],
	options: {
		cwd: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		maxOutputBytes?: number;
		env?: NodeJS.ProcessEnv;
	},
): Promise<void> {
	options.signal?.throwIfAborted();
	const child = Bun.spawn(command, {
		cwd: options.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...options.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" },
	});
	let failure: Error | undefined;
	let diagnostic = Buffer.alloc(0);
	let bytes = 0;
	const stop = (error: Error) => {
		failure ??= error;
		child.kill("SIGKILL");
	};
	const abort = () => stop(new Error("Runtime build cancelled", { cause: options.signal?.reason }));
	const timer = setTimeout(
		() => stop(new Error("Runtime build timed out")),
		options.timeoutMs ?? 180_000,
	);
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				diagnostic = Buffer.concat([diagnostic, value.subarray(-32_768)]).subarray(-32_768);
				if (bytes > (options.maxOutputBytes ?? 1024 * 1024)) {
					stop(new Error("Runtime build diagnostic output exceeded its byte budget"));
					break;
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	};
	try {
		const [code] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]);
		options.signal?.throwIfAborted();
		if (failure || code !== 0) {
			throw new Error(
				`${failure?.message ?? `Runtime build failed (${code})`}\n${diagnostic.toString("utf8")}`,
				{ cause: failure },
			);
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
}
