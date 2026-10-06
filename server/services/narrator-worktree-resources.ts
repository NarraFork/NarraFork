import { createWorktreeResourceRegistry } from "./narrator-worktree-resource-store";

export type {
	VerifiedWorktreeScope,
	WorktreeResourceRegistration,
	WorktreeResourceRegistry,
} from "./narrator-worktree-resource-store";

import { and, eq, gt, sql } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import { narrators, narratorWorktreeResources } from "../db/schema";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";

/** Resources outlive sessions, owners and receipts. PostgreSQL has no adapter yet: closed. */
export const narratorWorktreeResourceRegistry = createWorktreeResourceRegistry(
	db,
	(resource, commit) => {
		if (activeDatabaseBackend !== "sqlite")
			throw new AppError(
				"Worktree resource registry is unavailable for PostgreSQL",
				503,
				"WORKTREE_RESOURCE_BACKEND_UNAVAILABLE",
			);
		const target = {
			deviceId: resource.deviceId,
			path: resource.worktreePath,
			repositoryKey: resource.repositoryKey,
			scopeProjectId: resource.scopeProjectId ?? undefined,
		};
		return withWorkspaceAdmission(target, commit);
	},
);

/** Bounded cursor inventory, with small projections only. A cap/read failure is NOT a
 * complete ownership set. Backend path comparison (in the caller) handles Windows case,
 * separator variants and nested cwds; SQL's case-sensitive string equality cannot do that.
 */
export async function readLegacyNarratorWorktreeProtection(
	deadline: number,
	signal?: AbortSignal,
): Promise<{
	complete: boolean;
	owners: Array<{ narratorId: string; path: string; deviceId: string }>;
}> {
	const owners: Array<{ narratorId: string; path: string; deviceId: string }> = [];
	if (!Number.isFinite(deadline)) return { complete: false, owners };
	const readDeadline = Math.min(deadline, performance.now() + 5000);
	const trustedCwd = process.cwd();
	let bytes = 0;
	let cursor: string | undefined;
	try {
		for (let page = 0; page < 16; page++) {
			if (performance.now() > readDeadline || signal?.aborted) return { complete: false, owners };
			const rows = db
				.select({
					id: narrators.id,
					cwd: narrators.cwd,
					defaultDeviceId: narrators.defaultDeviceId,
					contextCwd: sql<string | null>`json_extract(${narrators.workspaceContext}, '$.cwd')`,
					contextDevice: sql<
						string | null
					>`json_extract(${narrators.workspaceContext}, '$.deviceId')`,
					contextCwdType: sql<string | null>`json_type(${narrators.workspaceContext}, '$.cwd')`,
					contextDeviceType: sql<
						string | null
					>`json_type(${narrators.workspaceContext}, '$.deviceId')`,
				})
				.from(narrators)
				.where(cursor ? gt(narrators.id, cursor) : undefined)
				.orderBy(narrators.id)
				.limit(129)
				.all();
			for (const row of rows.slice(0, 128)) {
				const validDevice = (device: unknown) =>
					device === null ||
					(typeof device === "string" &&
						device.length > 0 &&
						device.length <= 256 &&
						!device.includes("\0"));
				if (
					!validDevice(row.defaultDeviceId) ||
					!validDevice(row.contextDevice) ||
					(row.contextDeviceType !== null &&
						row.contextDeviceType !== "null" &&
						row.contextDeviceType !== "text") ||
					(row.contextCwd !== null && row.contextCwdType !== "text")
				)
					return { complete: false, owners };
				// Match the actual creator: an absolute legacy cwd remains the host claim even
				// when SwitchDevice later changes the default; context is a separate device claim.
				const rawDevice =
					row.cwd !== null && localPathSemantics.isAbsolute(row.cwd)
						? "local"
						: (row.defaultDeviceId ?? row.contextDevice ?? "local");
				// A malformed old remote context without device evidence may still hide a local
				// claim. Do not guess its namespace or declare it ownerless.
				if (
					row.contextCwd !== null &&
					row.contextDevice === null &&
					row.defaultDeviceId !== null &&
					row.defaultDeviceId !== "local"
				)
					return { complete: false, owners };
				for (const entry of [
					{ path: row.cwd, deviceId: rawDevice },
					{ path: row.contextCwd, deviceId: row.contextDevice ?? "local" },
				]) {
					if (entry.path === null) continue;
					if (
						typeof entry.path !== "string" ||
						entry.path.length === 0 ||
						entry.path.length > 4096 ||
						entry.path.includes("\0")
					)
						return { complete: false, owners };
					const path =
						entry.deviceId === "local"
							? localPathSemantics.resolve(trustedCwd, entry.path)
							: entry.path;
					if (path.length > 4096) return { complete: false, owners };
					const owner = { narratorId: row.id, path, deviceId: entry.deviceId };
					bytes += Buffer.byteLength(JSON.stringify(owner));
					if (bytes > 256 * 1024 || performance.now() > readDeadline || signal?.aborted)
						return { complete: false, owners };
					owners.push(owner);
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
