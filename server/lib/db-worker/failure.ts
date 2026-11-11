import { RUNTIME_BUILD_ID } from "../runtime-target";

/** No driver text or arbitrary user-controlled code crosses the SQLite error boundary. */
export function safeSqliteCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^SQLITE_[A-Z_]{1,64}$/.test(code) ? code : undefined;
}

export function isSqliteLockError(error: unknown): boolean {
	const code = safeSqliteCode(error);
	return code !== undefined && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code);
}

/** Source mode accepts older fixtures; frozen processes never dispatch to an unproven build. */
export function assertWorkerBuildId(buildId: unknown): void {
	if (RUNTIME_BUILD_ID !== null && buildId !== RUNTIME_BUILD_ID) {
		throw Object.assign(new Error("Database worker build identity mismatch"), {
			code: "DB_WORKER_BUILD_MISMATCH",
		});
	}
}

function redact(value: string): string {
	return value
		.slice(0, 8192)
		.replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s)]+/gi, "[redacted-url]")
		.replace(
			/\b(?:password|passwd|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
			"[credential-redacted]",
		)
		.replace(/(["'`])[^\n]*?\1/g, "[quoted]")
		.slice(0, 2048);
}

/** Startup has no request yet. Runtime diagnostics omit driver messages and stack headers. */
export function workerFailureDetails(error: unknown, startup: boolean) {
	const value = error as {
		name?: unknown;
		message?: unknown;
		stack?: unknown;
		filename?: unknown;
		lineno?: unknown;
		colno?: unknown;
		error?: unknown;
	} | null;
	const nested = value?.error;
	const stack = nested instanceof Error ? nested.stack : value?.stack;
	return {
		errorType:
			nested instanceof Error
				? redact(nested.name)
				: typeof value?.name === "string"
					? redact(value.name)
					: "WorkerError",
		code: safeSqliteCode(error),
		...(startup
			? { message: redact(typeof value?.message === "string" ? value.message : String(error)) }
			: {}),
		file: typeof value?.filename === "string" ? redact(value.filename) : undefined,
		line: typeof value?.lineno === "number" ? value.lineno : undefined,
		column: typeof value?.colno === "number" ? value.colno : undefined,
		stack:
			typeof stack === "string"
				? redact(
						stack
							.slice(0, 8192)
							.split("\n")
							.filter((line) => /^\s*at /.test(line))
							.slice(0, 8)
							.join("\n"),
					)
				: undefined,
	};
}
