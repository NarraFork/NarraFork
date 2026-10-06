import { and, asc, desc, eq, gt, inArray, lt, or, type SQL } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { projects, type remoteDevices } from "../db/schema";
import { ValidationError } from "../lib/errors";

export interface IntegrationProjectSummary {
	id: string;
	name: string;
	description: string | null;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
}

export interface IntegrationDeviceSummary {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	status: "online" | "offline";
	lastSeenAt: string | null;
	platformOs: string | null;
	platformArch: string | null;
	agentVersion: string | null;
	capabilities: Record<string, unknown> | null;
	scope: "global" | "project";
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface IntegrationProjectCursor {
	primary: string;
	id: string;
}

export interface ListIntegrationProjectsInput {
	limit: number;
	order: "name_asc" | "updated_desc";
	after?: IntegrationProjectCursor;
	allowedProjectIds?: readonly string[];
	projectId?: string;
	statuses?: readonly ("active" | "archived")[];
}

function normalizeLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
		throw new ValidationError("Integration project limit must be between 1 and 101");
	}
	return limit;
}

export function toIntegrationProjectSummary(
	row: Pick<
		typeof projects.$inferSelect,
		"id" | "name" | "description" | "status" | "createdAt" | "updatedAt"
	>,
): IntegrationProjectSummary {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function toIntegrationDeviceSummary(
	row: Pick<
		typeof remoteDevices.$inferSelect,
		| "id"
		| "name"
		| "slug"
		| "description"
		| "status"
		| "lastSeenAt"
		| "platformOs"
		| "platformArch"
		| "agentVersion"
		| "capabilitiesJson"
		| "scope"
		| "projectId"
		| "createdAt"
		| "updatedAt"
	>,
): IntegrationDeviceSummary {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		status: row.status,
		lastSeenAt: row.lastSeenAt,
		platformOs: row.platformOs,
		platformArch: row.platformArch,
		agentVersion: row.agentVersion,
		capabilities: (row.capabilitiesJson as Record<string, unknown> | null) ?? null,
		scope: row.scope,
		projectId: row.projectId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function listIntegrationProjects(
	input: ListIntegrationProjectsInput,
	database: typeof defaultDb = defaultDb,
): Promise<IntegrationProjectSummary[]> {
	const limit = normalizeLimit(input.limit);
	if (input.allowedProjectIds?.length === 0) return [];
	const predicates: SQL[] = [];
	if (input.allowedProjectIds) {
		predicates.push(inArray(projects.id, [...new Set(input.allowedProjectIds)]));
	}
	if (input.projectId) predicates.push(eq(projects.id, input.projectId));
	if (input.statuses?.length) predicates.push(inArray(projects.status, [...input.statuses]));
	if (input.after) {
		const afterPredicate =
			input.order === "name_asc"
				? or(
						gt(projects.name, input.after.primary),
						and(eq(projects.name, input.after.primary), gt(projects.id, input.after.id)),
					)
				: or(
						lt(projects.updatedAt, input.after.primary),
						and(eq(projects.updatedAt, input.after.primary), lt(projects.id, input.after.id)),
					);
		if (afterPredicate) predicates.push(afterPredicate);
	}

	const rows = await database
		.select({
			id: projects.id,
			name: projects.name,
			description: projects.description,
			status: projects.status,
			createdAt: projects.createdAt,
			updatedAt: projects.updatedAt,
		})
		.from(projects)
		.where(and(...predicates))
		.orderBy(
			...(input.order === "name_asc"
				? [asc(projects.name), asc(projects.id)]
				: [desc(projects.updatedAt), desc(projects.id)]),
		)
		.limit(limit);
	return rows.map(toIntegrationProjectSummary);
}
