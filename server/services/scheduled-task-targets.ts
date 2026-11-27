import type { ScheduledTaskTarget, ScheduledTaskTargetsPage } from "@shared/scheduled-task-targets";
import { and, asc, eq, gt, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { canWriteNarrator, narratorReadableWhere } from "./narrator-acl";
import { narratorProjectIdColumn } from "./narrator-project";
import { resolveTaskPrincipal, type ScheduledTaskPrincipal } from "./scheduled-task-acl";

const SCAN_LIMIT = 500;
const PAGE_MAX = 100;

export interface ScheduledTaskPageOptions {
	limit?: number;
	cursor?: string;
}

export function scheduledTaskPageLimit(limit = 30): number {
	if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)
		throw new ValidationError("limit must be between 1 and 100");
	return limit;
}

/** A cursor is only a position, never proof of access. Bind it to its query to avoid omissions. */
export function decodeScheduledTaskCursor(
	cursor: string | undefined,
	scope: string,
): string | null {
	if (!cursor) return null;
	try {
		if (cursor.length > 2048) throw new Error("oversized cursor");
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			parsed.scope !== scope ||
			typeof parsed.id !== "string" ||
			!parsed.id ||
			parsed.id.length > 100
		)
			throw new Error("invalid cursor");
		return parsed.id;
	} catch {
		throw new ValidationError("Invalid scheduled task cursor");
	}
}

export function encodeScheduledTaskCursor(id: string, scope: string): string {
	return Buffer.from(JSON.stringify({ id, scope })).toString("base64url");
}

/** Read small batches, applying the same row ACL as writes without loading histories or prompts. */
export async function listScheduledTaskTargets(
	principal: ScheduledTaskPrincipal,
	options: ScheduledTaskPageOptions & { q?: string } = {},
): Promise<ScheduledTaskTargetsPage> {
	const live = await resolveTaskPrincipal(principal.userId);
	const limit = scheduledTaskPageLimit(options.limit);
	const q = options.q?.trim() ?? "";
	if (q.length > 200) throw new ValidationError("Search is limited to 200 characters");
	const scope = `targets:${q}`;
	let position = decodeScheduledTaskCursor(options.cursor, scope);
	const items: ScheduledTaskTarget[] = [];
	let scanned = 0;
	while (scanned < SCAN_LIMIT) {
		const batchSize = Math.min(100, SCAN_LIMIT - scanned);
		const rows = await db
			.select({
				id: narrators.id,
				title: narrators.title,
				status: narrators.status,
				cwd: narrators.cwd,
				model: narrators.model,
				projectId: narratorProjectIdColumn,
				ownerUserId: narrators.ownerUserId,
				visibility: narrators.visibility,
				writeAudience: narrators.writeAudience,
				type: narrators.type,
				aclRootNarratorId: narrators.aclRootNarratorId,
				contextProjectId: narrators.contextProjectId,
			})
			.from(narrators)
			.where(
				and(
					narratorReadableWhere(live),
					ne(narrators.status, "archived"),
					or(eq(narrators.hiddenFromLists, false), q ? eq(narrators.id, q) : undefined),
					position ? gt(narrators.id, position) : undefined,
					q
						? or(
								eq(narrators.id, q),
								sql`${narrators.title} LIKE ${`%${q.replace(/[\\%_]/g, "\\$&")}%`} ESCAPE '\\'`,
							)
						: undefined,
				),
			)
			.orderBy(asc(narrators.id))
			.limit(batchSize + 1);
		for (const row of rows.slice(0, batchSize)) {
			if (await canWriteNarrator(row, live)) {
				if (items.length === limit) {
					return { items, nextCursor: encodeScheduledTaskCursor(position as string, scope) };
				}
				items.push({
					id: row.id,
					title: row.title?.slice(0, 500) ?? null,
					status: row.status,
					cwd: row.cwd,
					projectId: row.projectId,
					model: row.model,
				});
			}
			position = row.id;
			scanned++;
		}
		if (rows.length <= batchSize) return { items, nextCursor: null };
	}
	return { items, nextCursor: position ? encodeScheduledTaskCursor(position, scope) : null };
}
