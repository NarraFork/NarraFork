import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs } from "../db/schema";
import { ForbiddenError, NotFoundError } from "../lib/errors";
import type { ContextMemoryScope } from "../lib/validators/context-memory";
import { loadNarratorForAccess, type NarratorPrincipal } from "./narrator-acl";
import { loadProjectForAccess } from "./project-acl";

/** Constructed at the trusted route/tool boundary, never taken from request JSON. */
export interface ContextMemoryActor extends NarratorPrincipal {
	kind: "user" | "agent";
}

export function requireMemoryActor(actor: ContextMemoryActor, humanOnly = false): void {
	if (!actor.userId || (actor.kind !== "user" && actor.kind !== "agent")) {
		throw new ForbiddenError("A verified memory user is required");
	}
	if (humanOnly && actor.kind !== "user") {
		throw new ForbiddenError("A human user must confirm or change saved memory");
	}
}

export function memoryScopeKey(scope: ContextMemoryScope): string {
	return scope.kind === "user" ? "user" : `${scope.kind}:${scope.id}`;
}

export function memoryScopeOf(row: {
	scope: string;
	projectId: string | null;
	narratorId: string | null;
}): ContextMemoryScope {
	if (row.scope === "user") return { kind: "user" };
	if (row.scope === "project" && row.projectId) return { kind: "project", id: row.projectId };
	if (row.scope === "session" && row.narratorId) return { kind: "session", id: row.narratorId };
	throw new ForbiddenError("Invalid memory scope");
}

export async function assertMemoryScope(
	scope: ContextMemoryScope,
	actor: ContextMemoryActor,
): Promise<void> {
	requireMemoryActor(actor);
	if (scope.kind === "project") await loadProjectForAccess(scope.id, actor, "read");
	if (scope.kind === "session") await loadNarratorForAccess(scope.id, actor, "read");
}

export async function assertMemorySource(
	source: { sourceNarratorId: string | null; sourceMessageId: string | null },
	actor: ContextMemoryActor,
): Promise<void> {
	if (!source.sourceNarratorId) {
		if (source.sourceMessageId) throw new NotFoundError("Memory source", "unknown");
		return;
	}
	await loadNarratorForAccess(source.sourceNarratorId, actor, "read");
	if (source.sourceMessageId) {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, source.sourceNarratorId),
				eq(narratorMessageRefs.messageId, source.sourceMessageId),
			),
			columns: { id: true },
		});
		if (!ref) throw new NotFoundError("Memory source", source.sourceMessageId);
	}
}
