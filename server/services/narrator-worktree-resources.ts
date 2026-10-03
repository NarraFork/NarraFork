import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorWorktreeResources } from "../db/schema";
import { AppError } from "../lib/errors";

export interface WorktreeResourceRegistration {
	ownerNarratorId: string;
	deviceId: string;
	repositoryKey: string;
	worktreePath: string;
	createRequestId: string;
}
export interface WorktreeResourceRegistry {
	/** Must complete durably while holding the repository write lock, BEFORE Git add. */
	register(resource: WorktreeResourceRegistration): Promise<void>;
	setState(resource: WorktreeResourceRegistration, state: "ready" | "unknown"): Promise<void>;
}

/** Resources outlive sessions, owners and request receipts. No implicit deletion API. */
export const narratorWorktreeResourceRegistry: WorktreeResourceRegistry = {
	async register(resource) {
		const id = createHash("sha256")
			.update(JSON.stringify([resource.deviceId, resource.worktreePath]))
			.digest("hex");
		const now = new Date().toISOString();
		await db
			.insert(narratorWorktreeResources)
			.values({
				id,
				...resource,
				state: "preparing",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
		const existing = db
			.select({
				repositoryKey: narratorWorktreeResources.repositoryKey,
				createRequestId: narratorWorktreeResources.createRequestId,
				ownerNarratorId: narratorWorktreeResources.ownerNarratorId,
			})
			.from(narratorWorktreeResources)
			.where(eq(narratorWorktreeResources.id, id))
			.get();
		if (
			!existing ||
			existing.repositoryKey !== resource.repositoryKey ||
			existing.createRequestId !== resource.createRequestId ||
			existing.ownerNarratorId !== resource.ownerNarratorId
		)
			throw new AppError(
				"Destination already has a durable resource owner",
				409,
				"WORKTREE_RESOURCE_CONFLICT",
			);
	},
	async setState(resource, state) {
		await db
			.update(narratorWorktreeResources)
			.set({ state, updatedAt: new Date().toISOString() })
			.where(
				and(
					eq(narratorWorktreeResources.deviceId, resource.deviceId),
					eq(narratorWorktreeResources.worktreePath, resource.worktreePath),
					eq(narratorWorktreeResources.createRequestId, resource.createRequestId),
				),
			);
	},
};

/** Bounded cursor inventory, with small projections only. A cap/read failure is NOT a
 * complete ownership set. Backend path comparison (in the caller) handles Windows case,
 * separator variants and nested cwds; SQL's case-sensitive string equality cannot do that.
 */
export async function readLegacyNarratorWorktreeProtection(deadline: number): Promise<{
	complete: boolean;
	owners: Array<{ narratorId: string; path: string }>;
}> {
	const owners: Array<{ narratorId: string; path: string }> = [];
	let cursor: string | undefined;
	try {
		for (let page = 0; page < 16; page++) {
			if (performance.now() > deadline) return { complete: false, owners };
			const rows = db
				.select({
					id: narrators.id,
					cwd: narrators.cwd,
					contextCwd: sql<string | null>`json_extract(${narrators.workspaceContext}, '$.cwd')`,
				})
				.from(narrators)
				.where(cursor ? gt(narrators.id, cursor) : undefined)
				.orderBy(narrators.id)
				.limit(129)
				.all();
			for (const row of rows.slice(0, 128)) {
				for (const path of [row.cwd, row.contextCwd]) {
					if (path === null) continue;
					if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path))
						return { complete: false, owners };
					owners.push({ narratorId: row.id, path });
				}
			}
			if (rows.length <= 128) return { complete: true, owners };
			cursor = rows[127]?.id;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	} catch {
		// An unreadable or malformed old context cannot become evidence of no owner.
	}
	return { complete: false, owners };
}

/** Indexed existence lookup: LIMIT never makes an owned path look orphaned. All states protect. */
export function isRegisteredNarratorWorktree(worktreePath: string): boolean {
	return !!db
		.select({ id: narratorWorktreeResources.id })
		.from(narratorWorktreeResources)
		.where(
			and(
				eq(narratorWorktreeResources.deviceId, "local"),
				eq(narratorWorktreeResources.worktreePath, worktreePath),
			),
		)
		.limit(1)
		.get();
}
