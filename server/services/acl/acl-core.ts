/**
 * The shared authorization kernel.
 *
 * It answers one question — "what does this principal hold, here?" — and answers
 * it identically for projects, chapters, narrators and knowledge. Domain rules
 * (the knowledge base's clearance ranks and compartment tags) are NOT decided
 * here; the kernel carries their credentials through untouched and lets the domain
 * layer compare them. That separation is what lets the knowledge base move onto
 * shared infrastructure without its fail-closed clearance semantics being rewritten.
 *
 * The type of {@link ScopeCaps} encodes the one rule that is easiest to get wrong:
 * an ancestor gate is a NECESSARY condition, never a sufficient one. `gate` and
 * `own` are separate fields, `manage` exists only in `own`, and the only exported
 * way to reach a verdict is a conjunction of both. A project read member therefore
 * cannot acquire read on a private narrator inside that project, because the gate
 * never contributes to `own`.
 *
 * Everything ambiguous resolves to "no access": an anonymous caller, a missing
 * row, an unknown capability value.
 */

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants } from "../../db/schema";
import { logger } from "../../lib/logger";
import { type AclScope, GLOBAL_SCOPE, resolveAncestorChain, scopeKey } from "./acl-scope";

/** The three capabilities every domain understands. */
export const ACL_CAPABILITIES = ["read", "write", "manage"] as const;
export type AclCapability = (typeof ACL_CAPABILITIES)[number];

/** Domain credential kinds. The kernel stores and unions these; it never compares them. */
export const ACL_DOMAIN_KINDS = ["clearance", "tag", "review"] as const;
export type AclDomainKind = (typeof ACL_DOMAIN_KINDS)[number];

export interface AclPrincipal {
	userId: string;
	role: "admin" | "user";
}

/** Credentials carried verbatim for the domain layer to interpret. */
export interface AclDomainCredentials {
	clearance: Set<string>;
	tags: Set<string>;
	review: Set<string>;
}

/**
 * What a principal holds at one scope.
 *
 * Split in two on purpose so the type system makes gate/authorization confusion
 * hard to write:
 *  - `gate` — every ancestor was passed. Necessary, never sufficient.
 *  - `own`  — grants/ownership on THIS scope. The actual authorization.
 */
export interface ScopeCaps {
	principal: AclPrincipal;
	isAdmin: boolean;
	gate: { read: boolean; write: boolean };
	own: { read: boolean; write: boolean; manage: boolean };
	/** Unioned across this scope and its ancestors. Uninterpreted by the kernel. */
	domain: AclDomainCredentials;
}

function emptyDomain(): AclDomainCredentials {
	return { clearance: new Set(), tags: new Set(), review: new Set() };
}

/** An anonymous caller holds nothing and passes no gate. */
export function anonymousCaps(): ScopeCaps {
	return {
		principal: { userId: "", role: "user" },
		isAdmin: false,
		gate: { read: false, write: false },
		own: { read: false, write: false, manage: false },
		domain: emptyDomain(),
	};
}

/**
 * Admins short-circuit every axis, exactly as they did in both predecessors.
 * Operations, storage cleanup and troubleshooting all need one entry point that
 * cannot be locked out by a user's own sharing choices.
 */
function adminCaps(principal: AclPrincipal): ScopeCaps {
	return {
		principal,
		isAdmin: true,
		gate: { read: true, write: true },
		own: { read: true, write: true, manage: true },
		domain: emptyDomain(),
	};
}

type GrantRow = {
	scopeType: string;
	scopeId: string | null;
	capability: string;
	domainKind: string | null;
	domainValue: string | null;
};

/**
 * Every grant this principal holds anywhere in a set of scopes, in one query.
 *
 * User grants and role grants are a plain union with no precedence and no deny
 * rules — the same semantics both predecessors had. Deny rules are deliberately
 * not introduced: they make "why can't I see this?" unanswerable without a solver.
 */
async function loadGrants(principal: AclPrincipal, scopes: AclScope[]): Promise<GrantRow[]> {
	const scopedIds = scopes.filter((s) => s.id !== null);
	const includesGlobal = scopes.some((s) => s.type === "global");
	if (scopedIds.length === 0 && !includesGlobal) return [];

	const scopeMatch = or(
		...(includesGlobal ? [eq(aclGrants.scopeType, "global")] : []),
		...scopedIds.map((s) =>
			and(eq(aclGrants.scopeType, s.type), eq(aclGrants.scopeId, s.id as string)),
		),
	);

	return await db
		.select({
			scopeType: aclGrants.scopeType,
			scopeId: aclGrants.scopeId,
			capability: aclGrants.capability,
			domainKind: aclGrants.domainKind,
			domainValue: aclGrants.domainValue,
		})
		.from(aclGrants)
		.where(
			and(
				or(
					and(eq(aclGrants.principalType, "user"), eq(aclGrants.principalId, principal.userId)),
					and(eq(aclGrants.principalType, "role"), eq(aclGrants.principalId, principal.role)),
				),
				scopeMatch,
			),
		);
}

/** Fold one grant row into an accumulator, honouring the two row shapes. */
function applyGrant(
	target: { read: boolean; write: boolean; manage: boolean },
	domain: AclDomainCredentials,
	grant: GrantRow,
): void {
	// Shape B — a domain credential. Its `capability` column is a placeholder that
	// keeps the unique index single-valued; it must NOT be read as "therefore
	// readable". Treating it as read would promote someone holding only a low
	// clearance into "can read everything", which is escalation.
	if (grant.domainKind && grant.domainValue) {
		if (grant.domainKind === "clearance") domain.clearance.add(grant.domainValue);
		else if (grant.domainKind === "tag") domain.tags.add(grant.domainValue);
		else if (grant.domainKind === "review") domain.review.add(grant.domainValue);
		return;
	}
	// Shape A — a plain capability. Unknown values are ignored (fail closed).
	if (grant.capability === "read") target.read = true;
	else if (grant.capability === "write") target.write = true;
	else if (grant.capability === "manage") target.manage = true;
}

/**
 * Resolve what a principal holds at `scope`.
 *
 * Grants on the scope itself land in `own`. Grants on any ancestor contribute only
 * to `gate` — and `manage` is never taken from an ancestor, so managing a project
 * does not confer the right to re-share a private session inside it.
 *
 * Domain credentials are unioned across the whole chain (a clearance granted at
 * the project level is still a clearance), because they are credentials the domain
 * layer compares, not access decisions.
 *
 * One query regardless of chain length.
 */
export async function resolveCaps(
	principal: AclPrincipal | null | undefined,
	scope: AclScope,
): Promise<ScopeCaps> {
	if (!principal?.userId) return anonymousCaps();
	if (principal.role === "admin") return adminCaps(principal);

	const ancestors = await resolveAncestorChain(scope);
	const chain = scope.type === "global" ? [GLOBAL_SCOPE] : [scope, ...ancestors];
	const grants = await loadGrants(principal, chain);

	const own = { read: false, write: false, manage: false };
	const domain = emptyDomain();
	// Per-ancestor accumulators: the gate passes only if EVERY ancestor level is
	// passed, so they cannot be OR-ed into one bucket.
	const perAncestor = new Map<string, { read: boolean; write: boolean; manage: boolean }>();
	for (const ancestor of ancestors) {
		perAncestor.set(scopeKey(ancestor), { read: false, write: false, manage: false });
	}

	const ownKey = scopeKey(scope);
	for (const grant of grants) {
		const key = grant.scopeId === null ? "global" : `${grant.scopeType}:${grant.scopeId}`;
		if (key === ownKey) {
			applyGrant(own, domain, grant);
			continue;
		}
		const bucket = perAncestor.get(key);
		if (bucket) applyGrant(bucket, domain, grant);
	}

	return {
		principal,
		isAdmin: false,
		gate: resolveGate(ancestors, perAncestor),
		own,
		domain,
	};
}

/**
 * Whether every ancestor level is passed.
 *
 * `global` is not a gate: a grant there is instance-wide authorization, and
 * requiring one would mean nobody could read anything without a global grant.
 * Ancestors that carry no access rules of their own (a chapter, which deliberately
 * has no ACL of its own — see the plan) are likewise not gates; they are only
 * present in the chain so a grant can be attached to them.
 *
 * The gates that actually exist today are project-level. Their verdict is supplied
 * by the domain adapter through {@link withResolvedGate}, because "is this user a
 * member of that project" depends on the project's own visibility/owner columns,
 * not only on grant rows.
 */
function resolveGate(
	ancestors: AclScope[],
	perAncestor: Map<string, { read: boolean; write: boolean; manage: boolean }>,
): { read: boolean; write: boolean } {
	let read = true;
	let write = true;
	for (const ancestor of ancestors) {
		if (!isGateScope(ancestor.type)) continue;
		const bucket = perAncestor.get(scopeKey(ancestor));
		read = read && bucket?.read === true;
		write = write && bucket?.write === true;
	}
	return { read, write };
}

/**
 * Scope types that act as gates for their descendants.
 *
 * Only projects. Chapters intentionally have no ACL of their own (a chapter's
 * worktree shares the project's git repository, so chapter-level isolation would
 * be fiction), and knowledge collections gate their entries through the knowledge
 * layer's existing two-axis check rather than through plain capabilities.
 */
function isGateScope(type: AclScope["type"]): boolean {
	return type === "project";
}

/**
 * Recompute `gate` from an externally supplied verdict.
 *
 * Project membership is not purely grant-driven: `projects.visibility="public"`
 * and project ownership also open the door. The kernel cannot know that without
 * reaching into project columns, which would make it depend on a domain, so the
 * project adapter supplies the verdict and this merges it in.
 */
export function withResolvedGate(
	caps: ScopeCaps,
	gate: { read: boolean; write: boolean },
): ScopeCaps {
	if (caps.isAdmin) return caps;
	return { ...caps, gate: { read: gate.read, write: gate.write } };
}

// ── Verdicts ────────────────────────────────────────────────────────────────
//
// The only exported way to turn caps into a decision. Each is a conjunction, so
// there is no code path that reads `gate` as an authorization.

export function capsCanRead(caps: ScopeCaps): boolean {
	return caps.isAdmin || (caps.gate.read && caps.own.read);
}

export function capsCanWrite(caps: ScopeCaps): boolean {
	return caps.isAdmin || (caps.gate.write && caps.own.write);
}

/**
 * Managing (changing who else may access) requires the gate too — you cannot
 * re-share something you cannot reach — but `own.manage` is never inherited, so an
 * ancestor's manage grant does not reach down here.
 */
export function capsCanManage(caps: ScopeCaps): boolean {
	return caps.isAdmin || (caps.gate.read && caps.own.manage);
}

// ── SQL push-down ───────────────────────────────────────────────────────────

/**
 * A Drizzle condition selecting rows the principal holds `capability` on, by way
 * of an `acl_grants` row for the given scope type.
 *
 * `EXISTS` rather than a join: several grants on one resource would otherwise
 * duplicate rows and corrupt pagination (`LIMIT n + 1` stops deciding `hasMore`,
 * and `COUNT(*)` over-reports). Column names inside the subquery are literal
 * because Drizzle rewrites embedded column references to the outer query's alias
 * inside relational-query `where` callbacks — that bug cost a broken story graph
 * once already.
 *
 * Returns undefined for admins, which composes with `and(...)` as "no extra
 * restriction". Callers must not read that as "deny".
 */
export function grantedScopeIdsWhere(
	principal: AclPrincipal,
	scopeType: AclScope["type"],
	capability: AclCapability,
	resourceIdColumn: unknown,
) {
	if (principal.role === "admin") return undefined;
	return sql`exists (
		select 1 from acl_grants
		where acl_grants.scope_type = ${scopeType}
			and acl_grants.scope_id = ${resourceIdColumn}
			and acl_grants.capability = ${capability}
			and acl_grants.domain_kind is null
			and (
				(acl_grants.principal_type = 'user' and acl_grants.principal_id = ${principal.userId})
				or (acl_grants.principal_type = 'role' and acl_grants.principal_id = ${principal.role})
			)
	)`;
}

/**
 * The scope ids of one type the principal holds `capability` on.
 *
 * For the handful of callers that need an id list rather than a predicate (raw
 * prepared statements, in-memory filters over already-loaded rows).
 *
 * A hard LIMIT is enforced in the SQL query to prevent unbounded result sets
 * from violating the main-thread SQLite performance rule. When the limit is
 * hit the caller receives a `truncated` flag — the same discipline used by
 * {@link resolveHoldersBatch} — so it can decide whether to degrade gracefully
 * or request a narrower scope.
 */
export const ACL_SCOPE_IDS_DEFAULT_LIMIT = 1000;

export async function listGrantedScopeIds(
	principal: AclPrincipal,
	scopeType: AclScope["type"],
	capability: AclCapability,
	limit = ACL_SCOPE_IDS_DEFAULT_LIMIT,
): Promise<{ ids: Set<string>; truncated: boolean }> {
	const rows = await db
		.select({ scopeId: aclGrants.scopeId })
		.from(aclGrants)
		.where(
			and(
				eq(aclGrants.scopeType, scopeType),
				eq(aclGrants.capability, capability),
				sql`${aclGrants.domainKind} is null`,
				or(
					and(eq(aclGrants.principalType, "user"), eq(aclGrants.principalId, principal.userId)),
					and(eq(aclGrants.principalType, "role"), eq(aclGrants.principalId, principal.role)),
				),
			),
		)
		.limit(limit + 1);

	const truncated = rows.length > limit;
	if (truncated) {
		logger.warn("listGrantedScopeIds hit limit — result is incomplete", {
			principal: principal.userId,
			scopeType,
			capability,
			limit,
		});
	}
	const ids = new Set(
		rows
			.slice(0, limit)
			.map((row) => row.scopeId)
			.filter((id): id is string => id !== null),
	);
	return { ids, truncated };
}

/**
 * Which of `principals` hold `capability` on one scope, resolved in a fixed number
 * of queries.
 *
 * For fan-out decisions ("who should be notified about this?"). Beyond
 * {@link ACL_BATCH_PRINCIPAL_LIMIT} the answer degrades to admins only and reports
 * `truncated`, rather than guessing or silently dropping people — the same
 * discipline the knowledge base applied to its batch caps.
 */
export const ACL_BATCH_PRINCIPAL_LIMIT = 200;

export async function resolveHoldersBatch(
	principals: AclPrincipal[],
	scope: AclScope,
	capability: AclCapability,
): Promise<{ holders: Set<string>; truncated: boolean }> {
	const admins = principals.filter((p) => p.role === "admin").map((p) => p.userId);
	if (principals.length > ACL_BATCH_PRINCIPAL_LIMIT) {
		return { holders: new Set(admins), truncated: true };
	}
	if (scope.id === null && scope.type !== "global") {
		return { holders: new Set(admins), truncated: false };
	}

	const chain =
		scope.type === "global" ? [GLOBAL_SCOPE] : [scope, ...(await resolveAncestorChain(scope))];
	const userIds = principals.map((p) => p.userId);
	const rows = await db
		.select({
			principalType: aclGrants.principalType,
			principalId: aclGrants.principalId,
			scopeType: aclGrants.scopeType,
			scopeId: aclGrants.scopeId,
			capability: aclGrants.capability,
			domainKind: aclGrants.domainKind,
		})
		.from(aclGrants)
		.where(
			and(
				eq(aclGrants.capability, capability),
				sql`${aclGrants.domainKind} is null`,
				or(
					and(eq(aclGrants.principalType, "user"), inArray(aclGrants.principalId, userIds)),
					eq(aclGrants.principalType, "role"),
				),
				or(
					...chain.map((s) =>
						s.id === null
							? eq(aclGrants.scopeType, "global")
							: and(eq(aclGrants.scopeType, s.type), eq(aclGrants.scopeId, s.id)),
					),
				),
			),
		);

	const ownKey = scopeKey(scope);
	const holders = new Set(admins);
	for (const principal of principals) {
		if (principal.role === "admin") continue;
		const holdsOwn = rows.some(
			(row) =>
				(row.scopeId === null ? "global" : `${row.scopeType}:${row.scopeId}`) === ownKey &&
				((row.principalType === "user" && row.principalId === principal.userId) ||
					(row.principalType === "role" && row.principalId === principal.role)),
		);
		if (holdsOwn) holders.add(principal.userId);
	}
	return { holders, truncated: false };
}
