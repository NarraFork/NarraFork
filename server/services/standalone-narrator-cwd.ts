/**
 * standalone-narrator-cwd.ts — where a STANDALONE narrator starts when the client
 * sent no directory.
 *
 * The instance setting `paths.defaultProjectDir` is documented as the default parent
 * directory for new work, and the create modal shows it as the field placeholder —
 * but an empty submit used to land in the home directory instead, so the setting
 * appeared to do nothing. This resolves it for real.
 *
 * Chapter-bound narrators are deliberately excluded: an unset cwd there resolves to
 * the chapter worktree at session start (`resolveNarratorSessionCwd`), which is the
 * correct answer and must not be pre-empted.
 *
 * Filesystem effects are INJECTED rather than imported so the decision can be tested
 * without touching a real disk — including the branches that matter most (a
 * configured directory that cannot be created, a `~` that must expand), which are
 * awkward to provoke against a live filesystem and easy to get silently wrong.
 */

export interface StandaloneNarratorCwdDeps {
	/** Absolute home directory of the server process. */
	home: string;
	/** `settings.paths.defaultProjectDir`, possibly empty/undefined. */
	configuredDir: string | undefined;
	/** `mkdir -p`. Throws to signal "unusable". */
	ensureDir: (path: string) => void;
	/** Resolve to an absolute path (node:path `resolve`). */
	toAbsolute: (path: string) => string;
	/** Reports a configured directory that could not be used. */
	onEnsureFailed?: (path: string, error: unknown) => void;
}

/**
 * The cwd to persist on a new narrator, or `undefined` to leave it unset.
 *
 * `undefined` is meaningful: it hands the decision to session start, which is what a
 * chapter-bound narrator needs.
 */
export function resolveStandaloneNarratorCwd(
	input: { cwd?: string; chapterId?: string | null },
	deps: StandaloneNarratorCwdDeps,
): string | undefined {
	const explicit = input.cwd?.trim();
	if (explicit) return explicit;
	// Chapter-bound: leave unset so the session binds it to the worktree.
	if (input.chapterId) return undefined;

	const configured = deps.configuredDir?.trim();
	if (!configured) return deps.home;

	let expanded = configured;
	// Only a bare `~` or a `~/` prefix expands. `~user/x` is deliberately NOT treated
	// as another user's home: this process cannot resolve that reliably, and guessing
	// would create a directory named after the guess.
	if (expanded === "~") {
		expanded = deps.home;
	} else if (expanded.startsWith("~/")) {
		expanded = `${deps.home}${expanded.slice(1)}`;
	} else if (expanded.startsWith("~")) {
		// A `~other` form is unresolvable here; fall back rather than materialise a
		// literal directory called "~other".
		return deps.home;
	}

	const absolute = deps.toAbsolute(expanded);
	try {
		deps.ensureDir(absolute);
	} catch (err) {
		// A missing or forbidden default must not fail narrator creation outright:
		// degrade to home, which always exists, and report it.
		deps.onEnsureFailed?.(absolute, err);
		return deps.home;
	}
	return absolute;
}
