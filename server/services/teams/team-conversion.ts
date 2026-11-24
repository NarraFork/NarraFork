/**
 * Turning an existing session into a team coordinator, and disbanding a team while keeping its
 * session. A session is a coordinator because of two stored facts — the `team` trait and its
 * `project_teams` row — and everything else (the lead protocol, the `Team` tool, the team status
 * row, soft limits, permissions, members) reads those live. So both directions change exactly
 * those two facts in one transaction, under `narratorTraitsLock` like every other read-modify-write
 * of `traits`, and then drop the few in-memory answers that assumed the session never changes kind.
 *
 * Upgrade (`POST /api/projects/:projectId/teams` with `fromNarratorId`):
 * - who: project write (the route) plus the session's owner or an admin (`canManageNarratorAcl`);
 * - what: an idle, non-archived ordinary primary session of this project whose working directory
 *   is a local Git checkout (any checkout of the project, linked worktrees included), and whose
 *   capability ceiling lets it start subagents;
 * - keeps: id, messages, audiences and grants; the name defaults to the title;
 * - pins `contextProjectId` to the project so a later directory switch cannot move the team;
 * - after commit: tells the session (a `team_upgrade` note, no wake), and on a `replace_tools`
 *   epoch writes the rebaseline notice that declares `Team` on the next request.
 *
 * Disband (`POST /api/projects/:projectId/teams/:teamId/disband`):
 * - who: the same as upgrade; the coordinator must be idle and not archived, and no work item may
 *   be unfinished or still hold a worktree (`TEAM_HAS_LIVE_WORK`);
 * - deletes the team row (work items and events cascade) and removes the trait; the session, its
 *   title, audiences, messages and pinned project stay;
 * - after commit: forgets the team's in-memory state and saved outputs and tells the session
 *   (a `team_disband` note). `Team` leaves the request through the runtime's ordinary unload
 *   reconciliation, which every strategy can express, so no rebaseline is needed.
 *
 * SQLite only, like every team route (the router refuses PostgreSQL first).
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { TeamDetail, TeamSettings } from "@shared/project-teams";
import { TEAM_NAME_MAX_LENGTH } from "@shared/project-teams";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { narratorProjectLinks, narrators, projects, projectTeams, users } from "../../db/schema";
import { SETUP_KIND_TRAIT } from "../../lib/agent/tools/setup-kind";
import { TEAM_TOOL_NAME } from "../../lib/agent/tools/team";
import { narratorTraitsLock } from "../../lib/async-mutex";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { getUserLanguage } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import { buildCustomTraitsResponse } from "../../lib/narrator-custom-traits";
import {
	BOT_TRAIT,
	KNOWLEDGE_KIND_TRAIT,
	parseTraits,
	redactDraftTraits,
	TEAM_TRAIT,
} from "../../lib/narrator-utils";
import type { Locale } from "../../lib/prompt-i18n";
import { teamDisbandNote, teamUpgradeNote } from "../../lib/prompts/team-lead";
import { broadcastToNarrator } from "../../websocket/narrator-ws";
import { getExecutionOwner } from "../agent-runtime/ownership";
import { isRuntimeToolAllowed } from "../agent-runtime/policy";
import {
	canManageNarratorAcl,
	canReadNarrator,
	NARRATOR_ACL_COLUMNS,
	type NarratorPrincipal,
} from "../narrator-acl";
import { announceTeamChange } from "../narrator-sharing";
import { forgetCoordinatorRun } from "./coordinator-limits";
import { removeCoordinatorOutputs } from "./coordinator-outputs";
import { assertTeamRemovable, deleteTeamOfNarratorInTransaction } from "./team-records";
import { getTeam, loadTeamForAccess, recordTeamEvent } from "./team-service";
import { forgetTeamSessions } from "./team-session-memo";
import { forgetTeamStatus } from "./team-status";
import { cancelCheckin } from "./work-items";

/** Injection sources of the two notes (labelled in `segment-adapter.ts`). */
export const TEAM_UPGRADE_NOTE_SOURCE = "team_upgrade";
export const TEAM_DISBAND_NOTE_SOURCE = "team_disband";

/** Traits of sessions that are never turned into a coordinator (each its own kind of session). */
const EXCLUDED_KIND_TRAITS = [
	BOT_TRAIT,
	KNOWLEDGE_KIND_TRAIT,
	SETUP_KIND_TRAIT,
	"modeltrace",
	"ask-in-passing",
	"scheduled",
] as const;

const SESSION_COLUMNS = {
	...NARRATOR_ACL_COLUMNS,
	title: true,
	status: true,
	traits: true,
	variant: true,
	scheduledTaskId: true,
	hiddenFromLists: true,
	modeltraceKey: true,
	oauthPolicySnapshotJson: true,
	workspaceRevision: true,
	ownerUserId: true,
} as const;

type SessionRow = {
	id: string;
	type: string;
	title: string | null;
	status: string;
	traits: unknown;
	variant: string;
	scheduledTaskId: string | null;
	hiddenFromLists: boolean;
	modeltraceKey: string | null;
	oauthPolicySnapshotJson: unknown;
	workspaceRevision: number;
	contextProjectId: string | null;
	ownerUserId: string | null;
};

type Tx = Pick<typeof db, "select">;

function kindUnsupported(reason: string): AppError {
	return new AppError(
		`This session cannot become a team coordinator: ${reason}`,
		409,
		"TEAM_SESSION_KIND_UNSUPPORTED",
		undefined,
		{ reason },
	);
}

function busyError(): AppError {
	return new AppError(
		"The session is running or waiting; try again once it is idle",
		409,
		"NARRATOR_EXECUTION_BUSY",
	);
}

function archivedTeamError(): AppError {
	return new AppError(
		"An archived team cannot be changed; unarchive it first",
		409,
		"TEAM_ARCHIVED",
	);
}

function isBusy(row: { id: string; status: string }): boolean {
	return row.status === "working" || row.status === "waiting" || !!getExecutionOwner(row.id);
}

/**
 * Why this session cannot become a coordinator, checked again inside the transaction. Order:
 * already a team, then its kind, then archived, then busy.
 */
function upgradeRefusal(row: SessionRow, hasTeamRow: boolean): AppError | null {
	const traits = parseTraits(row.traits);
	if (hasTeamRow || traits.includes(TEAM_TRAIT))
		return new AppError("This session is already a team coordinator", 409, "TEAM_ALREADY");
	if (row.type !== "primary" || row.variant !== "primary") return kindUnsupported("subagent");
	for (const trait of EXCLUDED_KIND_TRAITS)
		if (traits.includes(trait)) return kindUnsupported(trait);
	if (row.scheduledTaskId) return kindUnsupported("scheduled");
	if (row.modeltraceKey || row.hiddenFromLists) return kindUnsupported("modeltrace");
	if (row.oauthPolicySnapshotJson !== null && row.oauthPolicySnapshotJson !== undefined)
		return kindUnsupported("oauth");
	if (row.status === "archived")
		return new AppError(
			"An archived session cannot become a team coordinator; unarchive it first",
			409,
			"TEAM_SESSION_ARCHIVED",
		);
	if (isBusy(row)) return busyError();
	return null;
}

/** The session's primary project, read inside the transaction (`resolveNarratorProjectId`). */
function resolvedProjectIn(tx: Tx, row: { id: string; contextProjectId: string | null }) {
	if (row.contextProjectId) return row.contextProjectId;
	return (
		tx
			.select({ projectId: narratorProjectLinks.projectId })
			.from(narratorProjectLinks)
			.where(
				and(eq(narratorProjectLinks.narratorId, row.id), eq(narratorProjectLinks.role, "primary")),
			)
			.limit(1)
			.get()?.projectId ?? null
	);
}

/**
 * Whether the session's working directory is a checkout of another project than the one it is
 * pinned to: the index then links that directory to the other project (`source: "cwd"`).
 */
function workingDirectoryElsewhere(tx: Tx, narratorId: string, projectId: string): boolean {
	return !!tx
		.select({ projectId: narratorProjectLinks.projectId })
		.from(narratorProjectLinks)
		.where(
			and(eq(narratorProjectLinks.narratorId, narratorId), eq(narratorProjectLinks.source, "cwd")),
		)
		.limit(8)
		.all()
		.some((link) => link.projectId !== projectId);
}

function otherProjectError(): AppError {
	return new AppError("The session belongs to another project", 409, "TEAM_SESSION_OTHER_PROJECT");
}

function readSession(executor: Pick<typeof db, "select">, narratorId: string) {
	return executor
		.select({
			id: narrators.id,
			type: narrators.type,
			title: narrators.title,
			status: narrators.status,
			traits: narrators.traits,
			variant: narrators.variant,
			scheduledTaskId: narrators.scheduledTaskId,
			hiddenFromLists: narrators.hiddenFromLists,
			modeltraceKey: narrators.modeltraceKey,
			oauthPolicySnapshotJson: narrators.oauthPolicySnapshotJson,
			workspaceRevision: narrators.workspaceRevision,
			contextProjectId: narrators.contextProjectId,
			ownerUserId: narrators.ownerUserId,
		})
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get() as SessionRow | undefined;
}

function hasTeamRow(executor: Pick<typeof db, "select">, narratorId: string): boolean {
	return !!executor
		.select({ id: projectTeams.narratorId })
		.from(projectTeams)
		.where(eq(projectTeams.narratorId, narratorId))
		.limit(1)
		.get();
}

/** A person's name for the notes (their username), or null. */
function personName(userId: string | null | undefined): string | null {
	if (!userId) return null;
	const row = db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get();
	return row?.username ? row.username.slice(0, 120) : null;
}

/** The id of a note: one per (session, kind, the team row's creation time), written once. */
export function teamConversionNoteId(
	narratorId: string,
	kind: "upgrade" | "disband",
	teamCreatedAt: string,
): string {
	return createHash("sha256")
		.update(["team-conversion-note", narratorId, kind, teamCreatedAt].join("\u0000"))
		.digest("base64url")
		.slice(0, 21);
}

async function noteLocale(ownerUserId: string | null): Promise<Locale> {
	return ownerUserId ? await getUserLanguage(ownerUserId).catch(() => "en" as const) : "en";
}

/**
 * Write a note unless its row already exists. Never rejects: the conversion is committed, and a
 * missing note only means the session learns it from its system prompt alone.
 */
async function deliverNote(
	narratorId: string,
	messageId: string,
	source: string,
	content: string,
	locale: Locale,
	createdBy: string | null,
): Promise<boolean> {
	try {
		const { narratorMessages } = await import("../../db/schema");
		const existing = db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
			.limit(1)
			.get();
		if (existing) return false;
		const { deliverInjection } = await import("../narrator-injection");
		await deliverInjection(narratorId, {
			messageId,
			content,
			source,
			body: { kind: "prose", text: content },
			// A plain row: the person's next message starts the run that reads it.
			schedule: "none",
			locale,
			createdBy,
		});
		return true;
	} catch (error) {
		logger.warn("Could not tell a session about its team change", {
			narratorId,
			source,
			error: String(error),
		});
		return false;
	}
}

function broadcastTraits(narratorId: string, traits: string[]): void {
	broadcastToNarrator(narratorId, {
		type: "custom_traits_changed",
		narratorId,
		traits: redactDraftTraits(traits),
		customTraits: buildCustomTraitsResponse(traits),
	});
}

export interface UpgradeSessionInput {
	projectId: string;
	fromNarratorId: string;
	name?: string;
	baseBranch?: string;
	brief?: string;
	settings?: TeamSettings;
}

/** The checks that need I/O outside the transaction: OAuth binding, ceiling, workspace. */
async function prepareUpgrade(
	narratorId: string,
	actingUserId: string | null,
): Promise<{ revision: number; cwd: string; rootPath: string }> {
	const { resolveOAuthNarratorRuntimePolicy } = await import("../oauth-narrator-runtime-policy");
	let oauth: unknown = null;
	try {
		oauth = await resolveOAuthNarratorRuntimePolicy(narratorId);
	} catch {
		// A session with a broken OAuth binding is still an OAuth session: refused, never treated
		// as an ordinary one.
		throw kindUnsupported("oauth");
	}
	if (oauth) throw kindUnsupported("oauth");
	const { resolveNarratorRuntimePolicy } = await import("../trait-layer-service");
	const policy = await resolveNarratorRuntimePolicy(narratorId, actingUserId);
	// A coordinator that cannot delegate is no coordinator: its whole protocol is subagents.
	if (!isRuntimeToolAllowed(policy, "Agent")) throw kindUnsupported("cannot-start-subagents");
	const { workspaceContextService } = await import("../workspace-context-service");
	const unavailable = () =>
		new AppError(
			"The session's working directory is not a local Git checkout",
			409,
			"TEAM_WORKSPACE_UNAVAILABLE",
		);
	let workspace: Awaited<ReturnType<typeof workspaceContextService.get>>;
	try {
		workspace = await workspaceContextService.get(narratorId);
	} catch (error) {
		if (error instanceof AppError && error.statusCode < 500) throw unavailable();
		throw error;
	}
	if (workspace.deviceId !== "local" || !workspace.git?.workspaceKey) throw unavailable();
	return { revision: workspace.revision, cwd: workspace.cwd, rootPath: workspace.git.rootPath };
}

/** Whether two local paths name the same directory (real paths; spelled paths when unreadable). */
async function samePath(a: string, b: string): Promise<boolean> {
	const canonical = (value: string) =>
		realpath(value).catch(() => value.replace(/[\\/]+$/, "") || value);
	return (await canonical(a)) === (await canonical(b));
}

/**
 * Turn an existing session into the coordinator of a new team of `projectId` (see the module
 * header). The caller has already checked project write access.
 */
export async function upgradeSessionToTeam(
	input: UpgradeSessionInput,
	principal: NarratorPrincipal,
): Promise<TeamDetail> {
	const narratorId = input.fromNarratorId;
	const actingUserId = principal.userId || null;
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

	const session = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: SESSION_COLUMNS,
	});
	if (!session || !(await canReadNarrator(session, principal)))
		throw new NotFoundError("Narrator", narratorId);
	if (!(await canManageNarratorAcl(session, principal)))
		throw new ForbiddenError("Only the session's owner or an admin can turn it into a team");
	if (project.status === "archived")
		throw new AppError("An archived project cannot get a new team", 409, "PROJECT_ARCHIVED");
	const gitPath = project.gitPath;
	if (!gitPath) throw new ValidationError("A team needs a project with a git repository directory");

	// The index answers "which project" from the working directory; bring it up to date first.
	const { syncNarratorProjectLinksSafely } = await import("../project-index");
	await syncNarratorProjectLinksSafely(narratorId);
	const checkProject = (row: SessionRow) => {
		if (resolvedProjectIn(db, row) !== project.id) throw otherProjectError();
	};
	checkProject(session as SessionRow);
	const refusal = upgradeRefusal(session as SessionRow, hasTeamRow(db, narratorId));
	if (refusal) throw refusal;

	const name = (input.name ?? session.title ?? "").trim();
	if (!name || name.length > TEAM_NAME_MAX_LENGTH)
		throw new ValidationError(
			`The team needs a name of 1 to ${TEAM_NAME_MAX_LENGTH} characters; the session's title cannot be used`,
			"TEAM_NAME_INVALID",
		);

	const workspace = await prepareUpgrade(narratorId, actingUserId);
	const baseBranch = input.baseBranch ?? project.defaultBranch ?? "main";
	const brief = input.brief ?? "";
	const teamSettings = input.settings ?? {};

	const committed = await narratorTraitsLock.acquire(narratorId, async () =>
		db.transaction((tx) => {
			const fresh = readSession(tx, narratorId);
			if (!fresh) throw new NotFoundError("Narrator", narratorId);
			const currentProject = tx
				.select({ status: projects.status })
				.from(projects)
				.where(eq(projects.id, project.id))
				.get();
			if (!currentProject) throw new NotFoundError("Project", project.id);
			if (currentProject.status === "archived")
				throw new AppError("An archived project cannot get a new team", 409, "PROJECT_ARCHIVED");
			if (resolvedProjectIn(tx, fresh) !== project.id) throw otherProjectError();
			if (workingDirectoryElsewhere(tx, narratorId, project.id)) throw otherProjectError();
			const again = upgradeRefusal(fresh, hasTeamRow(tx, narratorId));
			if (again) throw again;
			if (fresh.workspaceRevision !== workspace.revision)
				throw new AppError(
					"The session's working directory changed while it was being turned into a team; try again",
					409,
					"TEAM_WORKSPACE_UNAVAILABLE",
				);
			const now = new Date().toISOString();
			const traits = [...parseTraits(fresh.traits), TEAM_TRAIT];
			const renamed = name !== fresh.title;
			tx.update(narrators)
				.set({
					traits,
					contextProjectId: project.id,
					...(renamed ? { title: name } : {}),
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			tx.insert(projectTeams)
				.values({
					narratorId,
					projectId: project.id,
					baseBranch,
					brief,
					settingsJson: teamSettings,
					status: "active",
					createdBy: actingUserId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			recordTeamEvent(
				tx,
				narratorId,
				"team.created",
				{ kind: "person", id: actingUserId },
				{ baseBranch, fromSession: true },
				now,
			);
			return { traits, renamed, createdAt: now, ownerUserId: fresh.ownerUserId };
		}),
	);
	logger.info("Session turned into a team", { teamId: narratorId, projectId: project.id });

	// The IM gateway's memo cached "not a team" for this tree.
	forgetTeamSessions();
	broadcastTraits(narratorId, committed.traits);
	if (committed.renamed) {
		broadcastToNarrator(narratorId, { type: "title_updated", narratorId, title: name });
		eventBus.emit({ type: "narrator:title_updated", narratorId, title: name });
	}
	// The pinned project is now the explicit primary link.
	void syncNarratorProjectLinksSafely(narratorId);
	await announceTeamChange(narratorId, actingUserId);

	const locale = await noteLocale(committed.ownerUserId);
	await deliverNote(
		narratorId,
		teamConversionNoteId(narratorId, "upgrade", committed.createdAt),
		TEAM_UPGRADE_NOTE_SOURCE,
		teamUpgradeNote(locale, {
			name,
			convertedBy: personName(actingUserId),
			cwd: workspace.cwd,
			mainCheckout: await samePath(workspace.rootPath, gitPath),
			mainCheckoutPath: gitPath,
		}),
		locale,
		actingUserId,
	);
	try {
		const { requestToolDeclarationRebaseline } = await import("../tool-loading-service");
		await requestToolDeclarationRebaseline(narratorId, TEAM_TOOL_NAME, locale);
	} catch (error) {
		// Without it `Team` is declared at the next compaction instead.
		logger.warn("Could not ask for the Team tool to be declared", {
			narratorId,
			error: String(error),
		});
	}
	return getTeam(narratorId, principal, project.id);
}

/**
 * Disband a team and keep its coordinator as an ordinary session (see the module header).
 * Returns the session's id. Archived teams are refused: unarchive first.
 */
export async function disbandTeam(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
): Promise<{ narratorId: string }> {
	const actingUserId = principal.userId || null;
	const { team, coordinator } = await loadTeamForAccess(teamId, principal, "write", projectId);
	if (!(await canManageNarratorAcl(coordinator, principal)))
		throw new ForbiddenError("Only the session's owner or an admin can disband its team");
	if (coordinator.status === "archived") throw archivedTeamError();
	if (isBusy(coordinator)) throw busyError();
	assertTeamRemovable(teamId);

	const traits = await narratorTraitsLock.acquire(teamId, async () =>
		db.transaction((tx) => {
			const fresh = readSession(tx, teamId);
			if (!fresh || !hasTeamRow(tx, teamId)) throw new NotFoundError("Team", teamId);
			if (fresh.status === "archived") throw archivedTeamError();
			if (isBusy(fresh)) throw busyError();
			// Re-checks live work against the same rows; work items and events cascade.
			deleteTeamOfNarratorInTransaction(tx, teamId);
			const next = parseTraits(fresh.traits).filter((trait) => trait !== TEAM_TRAIT);
			tx.update(narrators)
				.set({ traits: next, updatedAt: new Date().toISOString() })
				.where(eq(narrators.id, teamId))
				.run();
			return next;
		}),
	);
	logger.info("Team disbanded; its session kept", { teamId, projectId });

	forgetTeamSessions();
	forgetTeamStatus(teamId);
	forgetCoordinatorRun(teamId);
	cancelCheckin(teamId);
	// One directory under the NarraFork home, at most the 200 MB budget; never awaited by the
	// request, never throws.
	void removeCoordinatorOutputs(teamId);
	broadcastTraits(teamId, traits);
	await announceTeamChange(teamId, actingUserId);

	const locale = await noteLocale(coordinator.ownerUserId);
	await deliverNote(
		teamId,
		teamConversionNoteId(teamId, "disband", team.createdAt),
		TEAM_DISBAND_NOTE_SOURCE,
		teamDisbandNote(locale, {
			name: coordinator.title ?? "",
			disbandedBy: personName(actingUserId),
		}),
		locale,
		actingUserId,
	);
	return { narratorId: teamId };
}
