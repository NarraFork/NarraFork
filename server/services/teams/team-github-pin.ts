/**
 * The GitHub repository a project's pull requests go to (G), confirmed by a person.
 *
 * Origin's URL lives in the repository's own configuration, which agents can write: whatever it
 * names is only a proposal. The first time a project uses the PR flow, a person with project
 * manage permission confirms the `host/owner/repo` it resolves to (「将推送到 … 并在那里开 PR」);
 * it is kept in the project's `chapter_settings.teams.github` with who confirmed it and when.
 * From then on every push and every gh call refuses (`TEAM_PR_REMOTE_CHANGED`) while origin
 * resolves anywhere else, until a manager confirms the new one or clears it (project settings,
 * 工作区与容器 → 团队默认设置). The general project PATCH never writes this key.
 */
import type { TeamGithubTarget } from "@shared/project-teams";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { projects } from "../../db/schema";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { type GhRepo, isGhRepo } from "./team-gh";

const parseSettings = (value: unknown): Record<string, unknown> => {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

/** `host/owner/repo` of a target. */
export const githubTargetName = (target: GhRepo) => `${target.host}/${target.owner}/${target.repo}`;

/** Whether two targets name the same repository (owner and repo case-insensitively). */
export const sameGithubTarget = (a: GhRepo, b: GhRepo) =>
	a.host.toLowerCase() === b.host.toLowerCase() &&
	a.owner.toLowerCase() === b.owner.toLowerCase() &&
	a.repo.toLowerCase() === b.repo.toLowerCase();

/** Parse `host/owner/repo` (as gh names it); null for anything else. */
export function parseGithubTarget(value: string): GhRepo | null {
	const parts = value.trim().split("/");
	if (parts.length !== 3) return null;
	const [host = "", owner = "", repo = ""] = parts;
	const target = { host: host.toLowerCase(), owner, repo };
	return isGhRepo(target) ? target : null;
}

/** The pinned target in a project's `chapter_settings`, or null. */
export function githubTargetOfSettings(chapterSettings: unknown): TeamGithubTarget | null {
	const teams = parseSettings(chapterSettings).teams as { github?: unknown } | undefined;
	const pinned = teams?.github as Partial<TeamGithubTarget> | undefined;
	if (!pinned || typeof pinned !== "object") return null;
	const { host, owner, repo } = pinned;
	if (typeof host !== "string" || typeof owner !== "string" || typeof repo !== "string")
		return null;
	if (!isGhRepo({ host, owner, repo })) return null;
	return {
		host,
		owner,
		repo,
		confirmedBy: typeof pinned.confirmedBy === "string" ? pinned.confirmedBy : null,
		confirmedAt: typeof pinned.confirmedAt === "string" ? pinned.confirmedAt : null,
	};
}

/** The project's pinned GitHub target (one primary-key read), or null. */
export function pinnedGithubTarget(projectId: string): TeamGithubTarget | null {
	const row = db
		.select({ settings: projects.chapterSettings })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1)
		.get();
	return row ? githubTargetOfSettings(row.settings) : null;
}

/**
 * Pin (or, with null, clear) a project's GitHub target. The caller checked project manage
 * permission. Read and written in one transaction, so a concurrent settings change is kept.
 */
export function setPinnedGithubTarget(
	projectId: string,
	target: GhRepo | null,
	confirmedBy: string | null,
): TeamGithubTarget | null {
	if (target && !isGhRepo(target)) throw new ValidationError("Not a GitHub repository");
	return db.transaction((tx) => {
		const row = tx
			.select({ settings: projects.chapterSettings })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1)
			.get();
		if (!row) throw new NotFoundError("Project", projectId);
		const settings = parseSettings(row.settings);
		const teams = { ...((settings.teams as Record<string, unknown> | undefined) ?? {}) };
		const pinned: TeamGithubTarget | null = target
			? {
					host: target.host.toLowerCase(),
					owner: target.owner,
					repo: target.repo,
					confirmedBy,
					confirmedAt: new Date().toISOString(),
				}
			: null;
		if (pinned) teams.github = pinned;
		else delete teams.github;
		tx.update(projects)
			.set({ chapterSettings: { ...settings, teams }, updatedAt: new Date().toISOString() })
			.where(eq(projects.id, projectId))
			.run();
		return pinned;
	});
}

/**
 * A project PATCH never writes the pinned target: whatever `teams.github` it sends is replaced by
 * the stored one (or dropped when none is stored); its merge is shallow, so `teams` it sends
 * would otherwise drop the stored one.
 */
export function keepPinnedGithubTarget(
	current: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const pinned = (current.teams as { github?: unknown } | undefined)?.github;
	const teams = incoming.teams as Record<string, unknown> | undefined;
	if (!teams || typeof teams !== "object") return incoming;
	const { github: _sent, ...rest } = teams;
	return { ...incoming, teams: pinned ? { ...rest, github: pinned } : rest };
}
