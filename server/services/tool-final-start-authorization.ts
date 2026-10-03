import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { aclGrants, chapters, narrators, narratorToolCalls, projects, users } from "../db/schema";
import type { AgentConfig, ToolCallBinding } from "../lib/agent/types";
import { loadNarratorForAccess, NARRATOR_ACL_COLUMNS } from "./narrator-acl";

/** Trusted permission-time canonicalization belongs to the exact unstarted receipt.
 *  Never rewrite an approval from the final-start gate itself. */
export async function persistPermissionResolvedInput(
	narratorId: string,
	toolUseId: string,
	binding: ToolCallBinding,
	input: Record<string, unknown>,
): Promise<void> {
	const changed = await db
		.update(narratorToolCalls)
		.set({ inputJson: input })
		.where(
			and(
				eq(narratorToolCalls.id, binding.toolCallId),
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
				eq(narratorToolCalls.executionAttempt, binding.attempt),
				isNull(narratorToolCalls.executionStartedAt),
				inArray(narratorToolCalls.status, ["initializing", "pending", "running"]),
			),
		)
		.returning({ id: narratorToolCalls.id });
	if (changed.length !== 1)
		throw new Error(
			"Permission canonicalization cannot change an expired/started execution receipt",
		);
}

import { assertOAuthNarratorRuntimeActive } from "./oauth-narrator-runtime-policy";

function actorAuthorizationSnapshot(narratorId: string, userId: string) {
	const user = db
		.select({ id: users.id, role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user) throw new Error("Final authorization actor no longer exists");
	const row = db.query.narrators
		.findFirst({ where: eq(narrators.id, narratorId), columns: NARRATOR_ACL_COLUMNS })
		.sync();
	if (!row) throw new Error("Final authorization narrator no longer exists");
	const judged =
		row.aclRootNarratorId && row.aclRootNarratorId !== row.id
			? db.query.narrators
					.findFirst({
						where: eq(narrators.id, row.aclRootNarratorId),
						columns: NARRATOR_ACL_COLUMNS,
					})
					.sync()
			: row;
	if (!judged) throw new Error("Final authorization ACL root no longer exists");
	const rows = row.id === judged.id ? [row] : [row, judged];
	const chapterIds = rows.flatMap((entry) => (entry.chapterId ? [entry.chapterId] : []));
	const chapterRows = chapterIds.length
		? db
				.select({ id: chapters.id, projectId: chapters.projectId, role: chapters.role })
				.from(chapters)
				.where(inArray(chapters.id, chapterIds))
				.orderBy(asc(chapters.id))
				.limit(3)
				.all()
		: [];
	const projectIds = [
		...new Set(
			rows.flatMap((entry) =>
				entry.chapterId
					? chapterRows
							.filter((chapter) => chapter.id === entry.chapterId)
							.map((chapter) => chapter.projectId)
					: entry.contextProjectId
						? [entry.contextProjectId]
						: [],
			),
		),
	];
	const projectRows = projectIds.length
		? db
				.select({
					id: projects.id,
					ownerUserId: projects.ownerUserId,
					visibility: projects.visibility,
				})
				.from(projects)
				.where(inArray(projects.id, projectIds))
				.orderBy(asc(projects.id))
				.limit(3)
				.all()
		: [];
	// Two narrator/chapter/project scopes plus global, two principals and three
	// capabilities are bounded by the ACL unique indexes (at most 42 rows).
	const grants = db
		.select({
			id: aclGrants.id,
			scopeType: aclGrants.scopeType,
			scopeId: aclGrants.scopeId,
			principalType: aclGrants.principalType,
			principalId: aclGrants.principalId,
			capability: aclGrants.capability,
		})
		.from(aclGrants)
		.where(
			and(
				isNull(aclGrants.domainKind),
				or(
					and(eq(aclGrants.principalType, "user"), eq(aclGrants.principalId, userId)),
					and(eq(aclGrants.principalType, "role"), eq(aclGrants.principalId, user.role)),
				),
				or(
					eq(aclGrants.scopeType, "global"),
					and(
						eq(aclGrants.scopeType, "narrator"),
						inArray(
							aclGrants.scopeId,
							rows.map((entry) => entry.id),
						),
					),
					chapterIds.length
						? and(eq(aclGrants.scopeType, "chapter"), inArray(aclGrants.scopeId, chapterIds))
						: undefined,
					projectIds.length
						? and(eq(aclGrants.scopeType, "project"), inArray(aclGrants.scopeId, projectIds))
						: undefined,
				),
			),
		)
		.orderBy(asc(aclGrants.id))
		.limit(65)
		.all();
	if (grants.length > 64)
		throw new Error("Final ACL authorization scope exceeds its bounded budget");
	return {
		isAdmin: user.role === "admin",
		revision: JSON.stringify({ user, rows, chapterRows, projectRows, grants }),
	};
}

/** One real final-start gate shared by primary/child loops and persisted recovery runners. */
export function buildFinalToolStartAuthorization(
	config: Pick<AgentConfig, "narratorId" | "cwd" | "signal" | "userId" | "reviewReadOnlyBash">,
): NonNullable<AgentConfig["onToolExecutionFinalAuthorization"]> {
	return async (context) => {
		config.signal.throwIfAborted();
		if (!context.binding)
			throw new Error("Final policy authorization requires a durable execution binding");
		const runtime = await assertOAuthNarratorRuntimeActive(config.narratorId, config.userId);
		if (runtime && !runtime.allowedTools.has(context.toolUse.name))
			throw new Error("OAuth tool capability was revoked");
		const actorId = config.userId ?? runtime?.userId;
		const actorBefore = actorId
			? actorAuthorizationSnapshot(config.narratorId, actorId)
			: undefined;
		if (actorId && actorBefore)
			await loadNarratorForAccess(
				config.narratorId,
				{ userId: actorId, isAdmin: actorBefore.isAdmin },
				"write",
			);
		const { recheckFinalToolExecutionPermission } = await import("./narrator-permission");
		const policyFence = await recheckFinalToolExecutionPermission({
			narratorId: config.narratorId,
			toolName: context.toolUse.name,
			input: context.effectiveInput,
			toolUseId: context.toolUse.toolUseId,
			binding: context.binding,
			executionBackend: context.executionBackend,
			executionTarget: context.executionTarget,
			executionPlan: context.executionPlan,
			cwd: context.executionTarget?.cwd ?? config.cwd,
			runtimeConstraint: runtime
				? {
						permissionMode: runtime.permissionMode,
						allowKnowledgeWrite: runtime.allowKnowledgeWrite,
						dangerReflectionPrompt: runtime.dangerReflectionPrompt,
						useRobotDiagnosticPreset: runtime.useRobotDiagnosticPreset,
						deviceAccess: runtime.policy.deviceAccess,
						oauthClientId: runtime.clientId,
						grantId: runtime.grantId,
					}
				: undefined,
			reviewReadOnlyBash: config.reviewReadOnlyBash,
			signal: config.signal,
		});
		const runtimeAfter = await assertOAuthNarratorRuntimeActive(config.narratorId, config.userId);
		const runtimeSignature = (value: typeof runtime) =>
			JSON.stringify(value ? { ...value, allowedTools: [...value.allowedTools].sort() } : null);
		if (runtimeSignature(runtimeAfter) !== runtimeSignature(runtime))
			throw new Error("OAuth authorization changed during final policy preparation");
		if (
			actorId &&
			actorBefore &&
			actorAuthorizationSnapshot(config.narratorId, actorId).revision !== actorBefore.revision
		)
			throw new Error("Actor ACL changed during final policy preparation");
		return {
			assertStillCurrent() {
				config.signal.throwIfAborted();
				policyFence.assertStillCurrent();
				if (
					actorId &&
					actorBefore &&
					actorAuthorizationSnapshot(config.narratorId, actorId).revision !== actorBefore.revision
				)
					throw new Error("Actor ACL changed before the tool body started");
			},
		};
	};
}
