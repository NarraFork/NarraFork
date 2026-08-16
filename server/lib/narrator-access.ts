/**
 * Route-level narrator access checks.
 *
 * A thin bridge between Hono's request context and `narrator-acl`, so handlers
 * express intent ("this needs write") instead of re-deriving the principal.
 *
 * Lives in `lib/` rather than in a route file because several routers mounted
 * under `/api/narrators` need it — `routes/narrators.ts`, `routes/spec.ts` — plus
 * anything else keyed by narrator id (terminals, plugin surfaces).
 */

import type { Context } from "hono";
import {
	assertNarratorAccess,
	loadNarratorForAccess,
	type NarratorAccessNeed,
	type NarratorAclRow,
	type NarratorPrincipal,
} from "../services/narrator-acl";
import type { JwtPayload } from "./auth";
import { NotFoundError } from "./errors";

/**
 * The requesting principal, taken from the verified session/OAuth payload.
 *
 * Never reads a user id out of the body or query: those are attacker-controlled,
 * and one such slip would make the entire mechanism decorative.
 */
export function narratorPrincipalOf(c: Context): NarratorPrincipal {
	const user = c.get("user") as JwtPayload | undefined;
	// A missing principal means this route was reached without the auth middleware.
	// Resolving to an id that matches nothing (and no admin flag) makes that mistake
	// fail closed — the predicates then hide everything private — instead of throwing
	// a 500 that says nothing about the real problem, or worse, granting access.
	if (!user?.sub) return { userId: "", isAdmin: false };
	return { userId: user.sub, isAdmin: user.role === "admin" };
}

/**
 * Load the narrator named by `:id` and confirm the caller may use it.
 *
 * Throws NotFoundError both when it does not exist and when it is not theirs, so
 * a caller cannot probe for ids. Use `"write"` for anything that drives the
 * session (sending, interrupting, rolling back, changing settings, opening a
 * terminal) and `"read"` for pure inspection.
 */
export async function requireNarratorAccess(
	c: Context,
	narratorId: string,
	need: NarratorAccessNeed,
) {
	return await loadNarratorForAccess(narratorId, narratorPrincipalOf(c), need);
}

/** Same as requireNarratorAccess but for a row the handler already loaded. */
export async function requireAccessToNarratorRow(
	c: Context,
	row: NarratorAclRow,
	need: NarratorAccessNeed,
): Promise<void> {
	await assertNarratorAccess(row, narratorPrincipalOf(c), need);
}

/** Read `:id` from the route and assert access in one step. */
export async function requireNarratorParamAccess(c: Context, need: NarratorAccessNeed) {
	return await requireNarratorAccess(c, c.req.param("id") ?? "", need);
}

/**
 * Authorize a route keyed by something other than a narrator id — a permission
 * request, a tool call, a whitelist entry — by resolving which narrator owns it.
 *
 * These routes are the easy ones to miss: their path carries no narrator id, so
 * the router-level gate cannot see them, yet approving a permission request or
 * editing a command whitelist affects a session just as directly as posting a
 * message.
 *
 * An unresolvable owner is refused: a request id that matches nothing is reported
 * the same way as one belonging to someone else.
 */
export async function requireOwningNarratorAccess(
	c: Context,
	resolveNarratorId: () => Promise<string | null | undefined>,
	need: NarratorAccessNeed,
): Promise<void> {
	const narratorId = await resolveNarratorId();
	if (!narratorId) throw new NotFoundError("Narrator", "unknown");
	await requireNarratorAccess(c, narratorId, need);
}
