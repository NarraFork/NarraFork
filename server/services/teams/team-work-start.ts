/**
 * Where a team's new work items start, and what `work.sync` brings in (W): `origin/<base>` or the
 * local `<base>`.
 *
 * The mode is the team's `settings.workStart`, else the project's `chapter_settings.teams
 * .workStart`, else `remote` when origin is on GitHub and `local` otherwise (`team-hosting.ts`).
 * The base branch itself is the team's `base_branch`, which starts from the project's
 * `default_branch` (`createTeam`).
 *
 * `remote` fetches `+refs/heads/<base>:refs/remotes/origin/<base>` into the remote-tracking ref
 * only — never the local branch, never a working tree — and starts from the fetched commit. When
 * the fetch fails (offline, no credentials), the remote-tracking ref as it is still serves and the
 * event says it was not fetched; without one the start is refused (409
 * `TEAM_WORK_START_UNAVAILABLE`), never silently moved to the local base. An item's `base_ref`
 * stays the branch name either way: it is what the item merges back into.
 */
import {
	TEAM_WORK_START_MODES,
	type TeamSettings,
	type TeamWorkStart,
} from "@shared/project-teams";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { projects } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { teamRepoGit } from "./team-git-write";
import { defaultWorkStart, hostingOf, peekHosting } from "./team-hosting";

const isMode = (value: unknown): value is TeamWorkStart =>
	typeof value === "string" && (TEAM_WORK_START_MODES as readonly string[]).includes(value);

/** The project's default work start from its `chapter_settings`, if it sets one. */
export function projectWorkStartOf(chapterSettings: unknown): TeamWorkStart | null {
	let value = chapterSettings;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const mode = (value as { teams?: { workStart?: unknown } } | null)?.teams?.workStart;
	return isMode(mode) ? mode : null;
}

/** A project's repository directory and its default work start (primary key). */
export function projectStartFacts(projectId: string): {
	repo: string | null;
	projectDefault: TeamWorkStart | null;
} {
	const row = db
		.select({ gitPath: projects.gitPath, settings: projects.chapterSettings })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1)
		.get();
	return { repo: row?.gitPath ?? null, projectDefault: projectWorkStartOf(row?.settings) };
}

/**
 * The work start a team gets when it sets nothing: the project's default, else by hosting from
 * the cache. Null while the hosting is still being read.
 */
export function peekWorkStartDefault(projectId: string): TeamWorkStart | null {
	const facts = projectStartFacts(projectId);
	if (facts.projectDefault) return facts.projectDefault;
	if (!facts.repo) return "local";
	const hosting = peekHosting(facts.repo);
	return hosting ? defaultWorkStart(hosting) : null;
}

/** The team's effective work start (reads the hosting when nothing is configured). */
export async function resolveWorkStart(input: {
	projectId: string;
	settings: TeamSettings | null | undefined;
}): Promise<TeamWorkStart> {
	const own = input.settings?.workStart;
	if (isMode(own)) return own;
	const facts = projectStartFacts(input.projectId);
	if (facts.projectDefault) return facts.projectDefault;
	if (!facts.repo) return "local";
	return defaultWorkStart(await hostingOf(facts.repo));
}

/** Where one item starts or syncs from. */
export interface WorkStartPoint {
	mode: TeamWorkStart;
	/** What to name: `origin/<base>` or `<base>`. */
	label: string;
	/** The ref to resolve: `refs/remotes/origin/<base>` or the base as configured. */
	ref: string;
	/** The commit it named when read (null when the caller resolves it). */
	commit: string | null;
	/** `remote`: whether this read fetched it (false: the ref as it was). Null for `local`. */
	fetched: boolean | null;
}

/**
 * The start point for a team's base now. `remote` fetches the base from origin into its
 * remote-tracking ref first (best effort), then reads that ref.
 */
export async function workStartPoint(input: {
	projectId: string;
	baseBranch: string;
	settings: TeamSettings | null | undefined;
}): Promise<WorkStartPoint> {
	const mode = await resolveWorkStart(input);
	if (mode === "local")
		return { mode, label: input.baseBranch, ref: input.baseBranch, commit: null, fetched: null };
	const { repo } = projectStartFacts(input.projectId);
	if (!repo)
		throw new AppError(
			"The team's project has no repository directory",
			409,
			"TEAM_PROJECT_NOT_GIT",
		);
	const git = teamRepoGit(repo);
	const label = `origin/${input.baseBranch}`;
	const ref = `refs/remotes/origin/${input.baseBranch}`;
	const fetch = await git.fetchBaseFromOrigin(input.baseBranch).catch((error: unknown) => ({
		ok: false as const,
		message: error instanceof Error ? error.message : String(error),
	}));
	if (!fetch.ok)
		logger.warn("Team base could not be fetched from origin", {
			projectId: input.projectId,
			base: input.baseBranch,
			error: fetch.message,
		});
	const commit = await git.resolve(ref).catch(() => null);
	if (!commit)
		throw new AppError(
			`New work starts from ${label} (team settings), but it could not be fetched${
				fetch.ok ? "" : ` (${fetch.message})`
			} and there is no ${ref} to start from. Fetch it, or set the team to start from the local ${input.baseBranch}.`,
			409,
			"TEAM_WORK_START_UNAVAILABLE",
		);
	return { mode, label, ref, commit, fetched: fetch.ok };
}
