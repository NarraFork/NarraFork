import type { StartupProblem } from "./protocol";

/**
 * A known reason NarraFork cannot start, phrased for the person who has to fix it.
 *
 * Thrown from startup code; `server/serve.ts` shows it on the status page, prints it and exits.
 * Anything else that escapes startup is reported as an unexpected error with its message.
 */
export class StartupError extends Error {
	constructor(readonly problem: StartupProblem) {
		super(problem.message.en);
		this.name = "StartupError";
	}
}

/** Describe any startup failure as a problem the status page can show. */
export function toStartupProblem(error: unknown): StartupProblem {
	if (error instanceof StartupError) return error.problem;
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	return {
		message: {
			en: "NarraFork hit an unexpected error while starting.",
			zh: "NarraFork 启动时遇到意外错误。",
		},
		detail,
	};
}

/** The same problem as plain text, for the terminal and the log. */
export function formatStartupProblem(problem: StartupProblem): string {
	return [problem.message.en, problem.command && `\n  ${problem.command}\n`, problem.detail]
		.filter(Boolean)
		.join("\n");
}
