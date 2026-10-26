/**
 * Route-level project access checks.
 *
 * A thin bridge between Hono's request context and `project-acl`, so handlers
 * express intent ("this needs project write") instead of re-deriving the principal.
 * Mirrors `narrator-access.ts`, and for the same reason: the check has to be short
 * enough that adding it to a new endpoint is easier than forgetting it.
 */

import type { Context } from "hono";
import {
	assertProjectAccess,
	loadProjectForAccess,
	type ProjectAccessNeed,
	type ProjectAclRow,
	type ProjectPrincipal,
} from "../services/project-acl";
import type { SessionPayload } from "./auth";

/**
 * The requesting principal, taken from the verified session/OAuth payload.
 *
 * Never reads a user id out of the body or query — those are attacker-controlled.
 * A missing principal (a route reached without the auth middleware) resolves to an
 * id that matches nothing, so the mistake fails closed instead of throwing a 500
 * that hides the real problem.
 */
export function projectPrincipalOf(c: Context): ProjectPrincipal {
	const user = c.get("user") as SessionPayload | undefined;
	if (!user?.sub) return { userId: "", isAdmin: false };
	return { userId: user.sub, isAdmin: user.role === "admin" };
}

/**
 * Load the project and confirm the caller may use it.
 *
 * Throws NotFoundError both when it does not exist and when it is not theirs, so a
 * caller cannot probe for ids. Use `"read"` for inspection, `"write"` for anything
 * that changes the project, and `"manage"` for membership,
 * visibility, ownership and deletion.
 */
export async function requireProjectAccess(c: Context, projectId: string, need: ProjectAccessNeed) {
	return await loadProjectForAccess(projectId, projectPrincipalOf(c), need);
}

/** Same, for a project row the handler already loaded. */
export async function requireAccessToProjectRow(
	c: Context,
	row: ProjectAclRow,
	need: ProjectAccessNeed,
): Promise<void> {
	await assertProjectAccess(row, projectPrincipalOf(c), need);
}
