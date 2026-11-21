import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { withDbRetry } from "../lib/db-resilience";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundOccupancyStore } from "./background-occupancy-store";
import { loadNarratorForAccess, type NarratorPrincipal } from "./narrator-acl";
import { withNarratorMutationAdmission } from "./narrator-session-state";
import { rememberArchivedTabPlacement, restoreArchivedTabPlacement } from "./recent-tabs-service";
import { prepareNarratorArchive, repairArchivedNarrator } from "./subagent-lifecycle";
import { closeSubagentResources } from "./subagent-resources";
import { personActor, runAsTeamStatusActor } from "./teams/team-records";

const MAX_CASCADE_CHILDREN = 200;

function cascadeChildWhere(parentId: string, target: "archived" | "idle") {
	return and(
		eq(narrators.isAskInPassing, true),
		target === "archived"
			? and(
					ne(narrators.status, "archived"),
					or(
						eq(narrators.askInPassingGroupId, parentId),
						and(isNull(narrators.askInPassingGroupId), eq(narrators.parentNarratorId, parentId)),
					),
				)
			: and(eq(narrators.status, "archived"), eq(narrators.archivedWithNarratorId, parentId)),
	);
}

async function writableChild(id: string, principal: NarratorPrincipal) {
	try {
		return await loadNarratorForAccess(id, principal, "write");
	} catch (error) {
		if (!(error instanceof NotFoundError)) throw error;
		return null;
	}
}

export async function transitionNarratorArchiveGroup(
	principal: NarratorPrincipal,
	parentId: string,
	target: "archived" | "idle",
) {
	const archiving = target === "archived";
	return withNarratorMutationAdmission(parentId, async () => {
		const parent = await loadNarratorForAccess(parentId, principal, "write");
		if ((parent.status === "archived") === archiving) {
			if (archiving) {
				try {
					await prepareNarratorArchive(parent);
					await repairArchivedNarrator(parent);
				} finally {
					await closeSubagentResources(parentId);
				}
			}
			return [];
		}
		const childWhere = and(ne(narrators.id, parentId), cascadeChildWhere(parentId, target));
		const candidates = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(childWhere)
			.limit(MAX_CASCADE_CHILDREN + 1);
		if (candidates.length > MAX_CASCADE_CHILDREN) {
			throw new ValidationError("Too many linked sessions to update at once");
		}
		const childIds: string[] = [];
		for (const { id } of candidates) {
			if (await writableChild(id, principal)) childIds.push(id);
		}
		const transition = () => transitionAdmittedGroup(principal, parent, target, childIds);
		// Never wait on a child admission while holding the parent's.
		return childIds.reduceRight<() => Promise<string[]>>(
			(next, id) => () => withNarratorMutationAdmission(id, next, { failIfBusy: true }),
			transition,
		)();
	});
}

async function transitionAdmittedGroup(
	principal: NarratorPrincipal,
	parent: typeof narrators.$inferSelect,
	target: "archived" | "idle",
	childIds: string[],
) {
	const archiving = target === "archived";
	const parentId = parent.id;
	const childWhere = cascadeChildWhere(parentId, target);
	const userId = principal.userId;
	const prepared = new Map<string, typeof narrators.$inferSelect>();
	async function prepare(row: typeof narrators.$inferSelect) {
		await prepareNarratorArchive(row);
		prepared.set(row.id, row);
		await rememberArchivedTabPlacement(userId, row.id).catch((error) =>
			logger.warn("Could not remember archived tab placement", { narratorId: row.id, error }),
		);
	}

	// Runtime cancellation may await or fail. Do it before committing any archived status.
	if (archiving) await prepare(parent);
	const eligibleChildIds: string[] = [];
	for (const id of childIds) {
		const child = await writableChild(id, principal);
		if (!child) continue;
		if (archiving) {
			if (child.status === "archived") continue;
			await prepare(child);
		}
		eligibleChildIds.push(child.id);
	}
	const now = new Date().toISOString();
	const changes = await withDbRetry(
		async () => {
			const [children] = await Promise.all([
				Promise.all(eligibleChildIds.map((id) => writableChild(id, principal))),
				loadNarratorForAccess(parentId, principal, "write"),
			]);
			return db.transaction((tx) => {
				const current = tx
					.select({ status: narrators.status })
					.from(narrators)
					.where(eq(narrators.id, parentId))
					.get();
				if (!current) throw new NotFoundError("Narrator", parentId);
				if ((current.status === "archived") === archiving) return [];
				const updated = (id: string, child: boolean) =>
					tx
						.update(narrators)
						.set({
							status: target,
							errorMessage: null,
							errorRetryable: null,
							updatedAt: now,
							archivedWithNarratorId: archiving && child ? parentId : null,
						})
						.where(and(eq(narrators.id, id), child ? childWhere : undefined))
						.returning({ id: narrators.id, title: narrators.title })
						.get();
				const updatedParent = updated(parentId, false);
				if (!updatedParent) throw new ValidationError("Parent session could not be updated");
				const updatedChildren = children
					.flatMap((child) => (child ? [updated(child.id, true)] : []))
					.filter((row) => row !== undefined);
				return [updatedParent, ...updatedChildren];
			});
		},
		{ label: "transitionNarratorArchiveGroup", maxRetries: 5 },
	);

	// Only committed changes are observable by clients and status listeners.
	await runAsTeamStatusActor(personActor(userId), async () => {
		for (const { id } of changes) {
			backgroundOccupancyStore.refreshNarrator(id);
			eventBus.emit({ type: "narrator:status_changed", narratorId: id, status: target });
			broadcastToNarrator(id, { type: "status_change", narratorId: id, status: target });
		}
	});
	for (const { id, title } of changes) {
		if (archiving) {
			try {
				const row = prepared.get(id);
				if (row) await repairArchivedNarrator(row);
			} finally {
				await closeSubagentResources(id);
			}
		} else {
			await restoreArchivedTabPlacement(userId, id, title ?? id).catch((error) =>
				logger.warn("Could not restore archived tab placement", { narratorId: id, error }),
			);
		}
	}
	return changes.filter(({ id }) => id !== parentId).map(({ id }) => id);
}
