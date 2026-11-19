/**
 * Project teams (docs/PROJECT_TEAMS-PLAN.md, P1): a team is one coordinator narrator with the
 * `team` trait plus its `project_teams` row.
 *
 * - Identity: the team id is the coordinator's narrator id; the team name is its title.
 * - Access: the coordinator's narrator ACL, nothing else. Read on the coordinator reads the team;
 *   write makes a member. A caller who cannot read gets 404 (no existence oracle), a reader who
 *   cannot write gets 403 on changes.
 * - Lifecycle: created atomically with the narrator; archiving the narrator archives the team.
 *   The status people see is the coordinator's alone; the stored `project_teams.status` mirrors
 *   it (`startTeamStatusSync` follows archive/unarchive from any path, attributed to the person
 *   when one caused it). Deleting the narrator deletes the team only when no work is live
 *   (`team-records.ts`).
 *
 * SQLite only, like the narrator surface it rides on: the routes refuse PostgreSQL with 503.
 * Every query here is a primary-key or `(project_id, …)` index lookup bounded
 * by a LIMIT; the brief and settings are read only on the detail path.
 */

import {
	TEAM_EVENT_DETAIL_MAX_BYTES,
	type TeamAccess,
	type TeamDetail,
	type TeamEventKind,
	type TeamSettings,
	type TeamStatus,
	type TeamSummary,
} from "@shared/project-teams";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { narrators, projects, projectTeams, teamWorkEvents } from "../../db/schema";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { resolveNarratorAudiences } from "../../lib/narrator-audiences";
import { TEAM_TRAIT } from "../../lib/narrator-utils";
import { settings } from "../../lib/settings";
import {
	canReadNarrator,
	canWriteNarrator,
	NARRATOR_ACL_COLUMNS,
	type NarratorPrincipal,
	narratorReadableWhere,
} from "../narrator-acl";
import { type NarratorCreationTransaction, narratorService } from "../narrator-service";
import {
	currentTeamStatusActor,
	personActor,
	runAsTeamStatusActor,
	type TeamStatusActor,
} from "./team-records";

type TeamRow = typeof projectTeams.$inferSelect;
type CoordinatorRow = {
	id: string;
	title: string | null;
	status: string;
	traits: unknown;
	ownerUserId: string | null;
	visibility: string;
	writeAudience: string;
	type: string;
	aclRootNarratorId: string | null;
	contextProjectId: string | null;
};

const COORDINATOR_COLUMNS = {
	...NARRATOR_ACL_COLUMNS,
	title: true,
	status: true,
	traits: true,
} as const;

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * The team's status, taken from the coordinator alone: an archived coordinator is an archived
 * team, any other is an active one. The stored `project_teams.status` is a mirror (kept by the
 * archive routes and `startTeamStatusSync`) and never decides what people see.
 */
function effectiveStatus(coordinator: { status: string }): TeamStatus {
	return coordinator.status === "archived" ? "archived" : "active";
}

function toSummary(
	team: Omit<TeamRow, "brief" | "settingsJson">,
	coordinator: { title: string | null; status: string },
	briefBytes: number,
	access: TeamAccess,
): TeamSummary {
	return {
		id: team.narratorId,
		projectId: team.projectId,
		name: coordinator.title ?? "",
		baseBranch: team.baseBranch,
		status: effectiveStatus(coordinator),
		coordinatorStatus: coordinator.status,
		createdBy: team.createdBy,
		createdAt: team.createdAt,
		updatedAt: team.updatedAt,
		access,
		briefBytes,
	};
}

function toDetail(team: TeamRow, coordinator: CoordinatorRow, access: TeamAccess): TeamDetail {
	return {
		...toSummary(team, coordinator, utf8Bytes(team.brief), access),
		brief: team.brief,
		settings: team.settingsJson ?? {},
	};
}

type EventExecutor = Pick<typeof db, "insert">;

/** Append one team-level event. Synchronous so it can share a caller's transaction. */
function recordTeamEvent(
	executor: EventExecutor,
	teamId: string,
	kind: TeamEventKind,
	actor: { kind: "person" | "agent" | "system"; id: string | null },
	detail: Record<string, unknown> | null,
	at: string,
): void {
	const detailJson =
		detail && utf8Bytes(JSON.stringify(detail)) <= TEAM_EVENT_DETAIL_MAX_BYTES ? detail : null;
	executor
		.insert(teamWorkEvents)
		.values({
			id: generateId(),
			teamId,
			workItemId: null,
			kind,
			actorKind: actor.kind,
			actorId: actor.id,
			detailJson,
			createdAt: at,
		})
		.run();
}

async function loadTeamWithCoordinator(
	teamId: string,
): Promise<{ team: TeamRow; coordinator: CoordinatorRow } | null> {
	const team = db.select().from(projectTeams).where(eq(projectTeams.narratorId, teamId)).get();
	if (!team) return null;
	const coordinator = await db.query.narrators.findFirst({
		where: eq(narrators.id, teamId),
		columns: COORDINATOR_COLUMNS,
	});
	if (!coordinator) return null;
	return { team, coordinator: coordinator as CoordinatorRow };
}

/**
 * Load a team and check the caller against its coordinator's ACL.
 *
 * Not readable (or missing, or in another project than the route names) → 404. Readable but
 * `need: "write"` and not writable → 403: the caller already sees the team, so a 403 discloses
 * nothing, and it tells an onlooker why the change was refused.
 */
export async function loadTeamForAccess(
	teamId: string,
	principal: NarratorPrincipal,
	need: TeamAccess,
	projectId?: string,
): Promise<{ team: TeamRow; coordinator: CoordinatorRow; access: TeamAccess }> {
	const loaded = await loadTeamWithCoordinator(teamId);
	if (!loaded || (projectId !== undefined && loaded.team.projectId !== projectId))
		throw new NotFoundError("Team", teamId);
	const { coordinator } = loaded;
	if (!(await canReadNarrator(coordinator, principal))) throw new NotFoundError("Team", teamId);
	const writable = await canWriteNarrator(coordinator, principal);
	if (need === "write" && !writable)
		throw new ForbiddenError(
			"Only team members (people who may write to the coordinator) can change the team",
		);
	return { ...loaded, access: writable ? "write" : "read" };
}

export async function getTeam(
	teamId: string,
	principal: NarratorPrincipal,
	projectId?: string,
): Promise<TeamDetail> {
	const { team, coordinator, access } = await loadTeamForAccess(
		teamId,
		principal,
		"read",
		projectId,
	);
	return toDetail(team, coordinator, access);
}

export interface CreateTeamInput {
	projectId: string;
	name: string;
	baseBranch?: string;
	brief?: string;
	settings?: TeamSettings;
	visibility?: "private" | "project" | "public";
	writeAudience?: "owner" | "project" | "public";
}

/**
 * Create the coordinator narrator and the team row in ONE transaction: either both exist or
 * neither does. The caller has already checked project write access.
 */
export async function createTeam(
	input: CreateTeamInput,
	principal: NarratorPrincipal,
): Promise<TeamDetail> {
	const project = db
		.select({
			id: projects.id,
			gitPath: projects.gitPath,
			defaultBranch: projects.defaultBranch,
			status: projects.status,
		})
		.from(projects)
		.where(eq(projects.id, input.projectId))
		.get();
	if (!project) throw new NotFoundError("Project", input.projectId);
	if (project.status === "archived")
		throw new AppError("An archived project cannot get a new team", 409, "PROJECT_ARCHIVED");
	if (!project.gitPath)
		throw new ValidationError("A team needs a project with a git repository directory");

	const audiences = resolveNarratorAudiences(
		input.visibility,
		input.writeAudience,
		project.id,
		settings.agent.defaultNarratorVisibility,
		settings.agent.defaultNarratorWriteAudience,
	);
	const baseBranch = input.baseBranch ?? project.defaultBranch ?? "main";
	const brief = input.brief ?? "";
	const teamSettings = input.settings ?? {};

	const narrator = await narratorService.create(
		{
			title: input.name,
			cwd: project.gitPath,
			contextProjectId: project.id,
			ownerUserId: principal.userId || null,
			...audiences,
			extraTraits: [TEAM_TRAIT],
		},
		{
			inTransaction: (tx: NarratorCreationTransaction, created) => {
				tx.insert(projectTeams)
					.values({
						narratorId: created.id,
						projectId: project.id,
						baseBranch,
						brief,
						settingsJson: teamSettings,
						status: "active",
						createdBy: principal.userId || null,
						createdAt: created.createdAt,
						updatedAt: created.createdAt,
					})
					.run();
				recordTeamEvent(
					tx,
					created.id,
					"team.created",
					{ kind: "person", id: principal.userId || null },
					{ baseBranch },
					created.createdAt,
				);
			},
		},
	);
	logger.info("Team created", { teamId: narrator.id, projectId: project.id });
	return getTeam(narrator.id, principal);
}

export interface UpdateTeamInput {
	baseBranch?: string;
	brief?: string;
	settings?: TeamSettings;
}

export async function updateTeam(
	teamId: string,
	principal: NarratorPrincipal,
	patch: UpdateTeamInput,
	projectId?: string,
): Promise<TeamDetail> {
	const { team, coordinator } = await loadTeamForAccess(teamId, principal, "write", projectId);
	if (effectiveStatus(coordinator) === "archived")
		throw new AppError(
			"An archived team cannot be changed; unarchive it first",
			409,
			"TEAM_ARCHIVED",
		);
	const now = new Date().toISOString();
	const actor = { kind: "person" as const, id: principal.userId || null };
	db.transaction((tx) => {
		tx.update(projectTeams)
			.set({
				...(patch.baseBranch !== undefined ? { baseBranch: patch.baseBranch } : {}),
				...(patch.brief !== undefined ? { brief: patch.brief } : {}),
				...(patch.settings !== undefined ? { settingsJson: patch.settings } : {}),
				updatedAt: now,
			})
			.where(eq(projectTeams.narratorId, teamId))
			.run();
		if (patch.brief !== undefined && patch.brief !== team.brief)
			recordTeamEvent(tx, teamId, "team.brief", actor, { bytes: utf8Bytes(patch.brief) }, now);
		if (
			(patch.settings !== undefined &&
				JSON.stringify(patch.settings) !== JSON.stringify(team.settingsJson ?? {})) ||
			(patch.baseBranch !== undefined && patch.baseBranch !== team.baseBranch)
		)
			recordTeamEvent(
				tx,
				teamId,
				"team.settings",
				actor,
				{
					...(patch.baseBranch !== undefined ? { baseBranch: patch.baseBranch } : {}),
					...(patch.settings !== undefined ? { settings: patch.settings } : {}),
				},
				now,
			);
	});
	return getTeam(teamId, principal, projectId);
}

/**
 * The team brief for the coordinator and (P3) every subagent. Null when the id is no team.
 * No access check: callers are server-side injections for a session that already belongs to
 * the team. Bounded by the 4 KB column check.
 */
export function readTeamBrief(teamId: string): string | null {
	const row = db
		.select({ brief: projectTeams.brief })
		.from(projectTeams)
		.where(eq(projectTeams.narratorId, teamId))
		.get();
	return row ? row.brief : null;
}

/** Bring the stored team status in line with the coordinator's archived state. */
function syncTeamStatus(teamId: string, archived: boolean, actor: TeamStatusActor | null): boolean {
	const target: TeamStatus = archived ? "archived" : "active";
	const row = db
		.select({ status: projectTeams.status })
		.from(projectTeams)
		.where(eq(projectTeams.narratorId, teamId))
		.get();
	if (!row || row.status === target) return false;
	const now = new Date().toISOString();
	db.transaction((tx) => {
		tx.update(projectTeams)
			.set({ status: target, updatedAt: now })
			.where(eq(projectTeams.narratorId, teamId))
			.run();
		recordTeamEvent(
			tx,
			teamId,
			archived ? "team.archived" : "team.unarchived",
			actor ?? { kind: "system", id: null },
			null,
			now,
		);
	});
	return true;
}

/** Archive the team = archive its coordinator (ending its run first, like the narrator route). */
export async function archiveTeam(
	teamId: string,
	principal: NarratorPrincipal,
	projectId?: string,
): Promise<TeamDetail> {
	const { coordinator } = await loadTeamForAccess(teamId, principal, "write", projectId);
	const actorId = principal.userId || null;
	if (coordinator.status !== "archived") {
		// Like the narrator archive route: remember the sidebar placement for unarchive.
		if (actorId) {
			const { rememberArchivedTabPlacement } = await import("../recent-tabs-service");
			await rememberArchivedTabPlacement(actorId, teamId);
		}
		const { interruptAndArchiveSubagent } = await import("../subagent-lifecycle");
		// The status event fires inside; the sync listener attributes it to this person.
		const result = await runAsTeamStatusActor(personActor(actorId), () =>
			interruptAndArchiveSubagent(teamId),
		);
		if (!result.ok && result.error === "not_found") throw new NotFoundError("Team", teamId);
		if (!result.ok) throw new ValidationError(result.error ?? "Failed to archive the team");
	}
	syncTeamStatus(teamId, true, personActor(actorId));
	return getTeam(teamId, principal, projectId);
}

export async function unarchiveTeam(
	teamId: string,
	principal: NarratorPrincipal,
	projectId?: string,
): Promise<TeamDetail> {
	const { coordinator } = await loadTeamForAccess(teamId, principal, "write", projectId);
	const actorId = principal.userId || null;
	if (coordinator.status === "archived") {
		await runAsTeamStatusActor(personActor(actorId), () =>
			narratorService.updateStatus(teamId, "idle"),
		);
		// Like the narrator unarchive route: put the sidebar row back where it was.
		if (actorId) {
			const { restoreArchivedTabPlacement } = await import("../recent-tabs-service");
			await restoreArchivedTabPlacement(actorId, teamId, coordinator.title ?? teamId);
		}
	}
	syncTeamStatus(teamId, false, personActor(actorId));
	return getTeam(teamId, principal, projectId);
}

export interface ListTeamsOptions {
	status: TeamStatus | "all";
	limit: number;
	cursor?: string;
}

/**
 * The teams of a project the caller can read, by team id, one page (`LIMIT n + 1` decides
 * "more"). The caller has already checked project read access. The ACL predicate is the same
 * SQL the narrator list uses, so a team listed here never 404s on open.
 */
export async function listProjectTeams(
	projectId: string,
	principal: NarratorPrincipal,
	options: ListTeamsOptions,
): Promise<{ teams: TeamSummary[]; nextCursor: string | null }> {
	// By the coordinator's status, the one source of truth (see `effectiveStatus`).
	const statusFilter =
		options.status === "active"
			? ne(narrators.status, "archived")
			: options.status === "archived"
				? eq(narrators.status, "archived")
				: undefined;
	const rows = db
		.select({
			narratorId: projectTeams.narratorId,
			projectId: projectTeams.projectId,
			baseBranch: projectTeams.baseBranch,
			status: projectTeams.status,
			createdBy: projectTeams.createdBy,
			createdAt: projectTeams.createdAt,
			updatedAt: projectTeams.updatedAt,
			briefBytes: sql<number>`length(cast(${projectTeams.brief} as blob))`,
			coordinator: {
				id: narrators.id,
				title: narrators.title,
				status: narrators.status,
				traits: narrators.traits,
				ownerUserId: narrators.ownerUserId,
				visibility: narrators.visibility,
				writeAudience: narrators.writeAudience,
				type: narrators.type,
				aclRootNarratorId: narrators.aclRootNarratorId,
				contextProjectId: narrators.contextProjectId,
			},
		})
		.from(projectTeams)
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(
			and(
				eq(projectTeams.projectId, projectId),
				statusFilter,
				options.cursor ? gt(projectTeams.narratorId, options.cursor) : undefined,
				narratorReadableWhere(principal),
			),
		)
		.orderBy(asc(projectTeams.narratorId))
		.limit(options.limit + 1)
		.all();
	const page = rows.slice(0, options.limit);
	const teams: TeamSummary[] = [];
	for (const row of page) {
		const { coordinator, briefBytes, ...team } = row;
		const access: TeamAccess = (await canWriteNarrator(coordinator, principal)) ? "write" : "read";
		teams.push(toSummary(team, coordinator, Number(briefBytes), access));
	}
	return {
		teams,
		nextCursor: rows.length > options.limit ? (page.at(-1)?.narratorId ?? null) : null,
	};
}

/**
 * Follow the coordinator's archive state from every path (narrator archive route, auto-unarchive
 * on a new message, Agent control). A primary-key read per status event; it writes only when the
 * stored team status disagrees. The event names the person or agent when the change runs
 * inside `runAsTeamStatusActor` (team routes, the narrator archive / unarchive / auto-unarchive
 * sites, Agent control); any other change is the system's. Returns the stop function.
 */
export function startTeamStatusSync(): () => void {
	const onStatus = (event: { narratorId: string; status: string }) => {
		try {
			syncTeamStatus(event.narratorId, event.status === "archived", currentTeamStatusActor());
		} catch (error) {
			logger.warn("Team status sync failed", {
				teamId: event.narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	eventBus.on("narrator:status_changed", onStatus);
	return () => eventBus.off("narrator:status_changed", onStatus);
}
