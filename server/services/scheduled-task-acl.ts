import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { projects, scheduledTasks, users } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { ForbiddenError, NotFoundError } from "../lib/errors";
import {
	canManageProject,
	canReadProject,
	canWriteProject,
	projectReadableWhereForColumn,
} from "./project-acl";

export interface ScheduledTaskPrincipal {
	userId: string;
	isAdmin: boolean;
}
export type TaskAclRow = Pick<
	typeof scheduledTasks.$inferSelect,
	"id" | "ownerUserId" | "createdBy" | "runContext" | "projectId" | "schedule"
>;

/** Only genuinely unmigrated rows use the old identity. Never resurrect a transferred owner. */
export function taskOwnerId(
	task: Pick<TaskAclRow, "ownerUserId" | "createdBy" | "schedule">,
): string | null {
	return task.ownerUserId ?? (task.schedule == null ? task.createdBy : null);
}

export async function resolveTaskPrincipal(
	userId: string | null | undefined,
): Promise<ScheduledTaskPrincipal> {
	if (!userId) throw new ForbiddenError();
	const user = await readQuery(
		db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { id: true, role: true },
		}),
		{ executionPolicy: "worker-required" },
	);
	if (!user) throw new ForbiddenError();
	return { userId: user.id, isAdmin: user.role === "admin" };
}

export function taskOwnerWhere(userId: string) {
	return or(
		eq(scheduledTasks.ownerUserId, userId),
		and(
			isNull(scheduledTasks.ownerUserId),
			isNull(scheduledTasks.schedule),
			eq(scheduledTasks.createdBy, userId),
		),
	);
}

export function taskReadableWhere(principal: ScheduledTaskPrincipal) {
	if (!principal.userId) return sql`1 = 0`;
	if (principal.isAdmin) return undefined;
	return or(
		taskOwnerWhere(principal.userId),
		and(
			sql`${scheduledTasks.runContext} in ('project', 'chapter')`,
			projectReadableWhereForColumn(principal, scheduledTasks.projectId),
		),
	);
}

async function taskProject(task: TaskAclRow) {
	if (task.runContext === "standalone" || !task.projectId) return undefined;
	return readQuery(
		db.query.projects.findFirst({
			where: eq(projects.id, task.projectId),
			columns: { id: true, ownerUserId: true, visibility: true },
		}),
		{ executionPolicy: "worker-required" },
	);
}

export function canEditTask(task: TaskAclRow, principal: ScheduledTaskPrincipal): boolean {
	return !!principal.userId && (principal.isAdmin || taskOwnerId(task) === principal.userId);
}

export async function canReadTask(
	task: TaskAclRow,
	principal: ScheduledTaskPrincipal,
): Promise<boolean> {
	if (canEditTask(task, principal)) return true;
	if (!principal.userId) return false;
	const project = await taskProject(task);
	return !!project && canReadProject(project, principal);
}

export async function canPauseTask(
	task: TaskAclRow,
	principal: ScheduledTaskPrincipal,
): Promise<boolean> {
	if (canEditTask(task, principal)) return true;
	if (!principal.userId) return false;
	const project = await taskProject(task);
	return !!project && canManageProject(project, principal);
}

export async function assertTaskAccess(
	task: TaskAclRow | undefined,
	principal: ScheduledTaskPrincipal | undefined,
	need: "read" | "edit" | "pause" = "read",
): Promise<void> {
	if (!principal?.userId) throw new ForbiddenError();
	if (!task || !(await canReadTask(task, principal)))
		throw new NotFoundError("ScheduledTask", task?.id ?? "unknown");
	if (need === "edit" && !canEditTask(task, principal)) throw new ForbiddenError();
	if (need === "pause" && !(await canPauseTask(task, principal))) throw new ForbiddenError();
}

export async function assertTaskProjectWrite(
	projectId: string | null | undefined,
	principal: ScheduledTaskPrincipal,
) {
	if (!projectId) throw new NotFoundError("Project", "unknown");
	const project = await readQuery(
		db.query.projects.findFirst({
			where: eq(projects.id, projectId),
			columns: { id: true, ownerUserId: true, visibility: true, gitPath: true },
		}),
		{ executionPolicy: "worker-required" },
	);
	if (!project || !(await canWriteProject(project, principal)))
		throw new NotFoundError("Project", projectId);
	return project;
}
