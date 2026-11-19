/**
 * The one nested level of a team: each subagent's own helpers.
 *
 * Read by TeamStatus (the tree it prints), by the card activity snapshot (a first-level
 * subagent's card lists its helpers) and by the live `subagent_nested_changed` frame.
 * Every read is bounded per subagent and goes through the `parent_narrator_id` index;
 * only short columns are selected.
 */
import {
	SUBAGENT_NESTED_CARD_LIMIT,
	type SubagentNestedAgent,
	type SubagentNestedSummary,
} from "@shared/subagent-nested";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls } from "../db/schema";
import { getSubagentType, parseSubstatus } from "../lib/narrator-utils";

/**
 * Subagents whose helpers one query covers. Longer lists are read in pages of this size
 * (one query each), never cut: a page of history can hold more cards than this.
 */
const NESTED_PARENT_PAGE = 100;

export interface NestedSubagentRow {
	id: string;
	title: string | null;
	traits: string[];
	variant: string;
	status: string;
	createdAt: string;
	substatus: string;
	lastStopReason: string | null;
}

/**
 * The helpers of each subagent in `parentIds`: the rows it controls (its own team, see
 * `teamMembersWhere`), at most `perParent` each, active ones first and then newest, with
 * each subagent's total so a caller can say what it left out.
 */
export async function listNestedSubagents(
	parentIds: readonly string[],
	perParent: number,
): Promise<Map<string, { subagents: NestedSubagentRow[]; total: number }>> {
	const result = new Map<string, { subagents: NestedSubagentRow[]; total: number }>();
	const unique = [...new Set(parentIds)];
	const limit = Math.max(1, Math.trunc(perParent));
	for (let start = 0; start < unique.length; start += NESTED_PARENT_PAGE)
		await readNestedPage(unique.slice(start, start + NESTED_PARENT_PAGE), limit, result);
	return result;
}

async function readNestedPage(
	ids: string[],
	limit: number,
	result: Map<string, { subagents: NestedSubagentRow[]; total: number }>,
): Promise<void> {
	const activeFirst = sql`CASE WHEN ${narrators.status} IN ('working','waiting') THEN 0 ELSE 1 END`;
	const ranked = db
		.select({
			id: narrators.id,
			title: narrators.title,
			traits: narrators.traits,
			variant: narrators.variant,
			status: narrators.status,
			createdAt: narrators.createdAt,
			substatus: narrators.substatus,
			lastStopReason: narrators.lastStopReason,
			parentNarratorId: narrators.parentNarratorId,
			rank: sql<number>`row_number() over (partition by ${narrators.parentNarratorId} order by ${activeFirst}, ${narrators.createdAt} desc, ${narrators.id} desc)`.as(
				"rank",
			),
			total: sql<number>`count(*) over (partition by ${narrators.parentNarratorId})`.as("total"),
		})
		.from(narrators)
		.where(
			and(
				inArray(narrators.parentNarratorId, ids),
				sql`coalesce(json_extract(${narrators.runtimeRegistrationJson}, '$.controller.narratorId'), json_extract(${narrators.runtimeRegistrationJson}, '$.run.deliverTo.narratorId')) = ${narrators.parentNarratorId}`,
			),
		)
		.as("ranked");
	const rows = await db
		.select()
		.from(ranked)
		.where(sql`${ranked.rank} <= ${limit}`)
		.orderBy(ranked.parentNarratorId, sql`${ranked.rank}`)
		.limit(ids.length * limit)
		.all();
	for (const row of rows) {
		const parentId = row.parentNarratorId;
		if (!parentId) continue;
		const entry = result.get(parentId) ?? { subagents: [], total: Number(row.total) };
		entry.subagents.push({
			id: row.id,
			title: row.title,
			traits: row.traits,
			variant: row.variant,
			status: row.status,
			createdAt: row.createdAt,
			substatus: row.substatus,
			lastStopReason: row.lastStopReason,
		});
		result.set(parentId, entry);
	}
}

/**
 * How a helper that no longer runs ended, when not normally: `failed` (its last turn
 * ended with an error) or `stopped` (a person or its parent stopped it, or it ran out of
 * time). Undefined for a running helper or one that finished normally.
 */
export function nestedAgentEnding(row: {
	status: string;
	substatus: string;
	lastStopReason: string | null;
}): SubagentNestedAgent["ended"] {
	if (row.status === "working" || row.status === "waiting") return undefined;
	const tags = parseSubstatus(row.substatus);
	if (tags.includes("error") || row.lastStopReason === "error") return "failed";
	if (
		tags.includes("interrupted") ||
		tags.includes("timeout") ||
		row.lastStopReason === "user_interrupt"
	)
		return "stopped";
	return undefined;
}

/**
 * Card summaries of the helpers of each subagent in `parentIds`: who they are, their
 * status and whether one waits for a person's approval. Subagents without helpers are
 * absent, so an ordinary card carries nothing extra. Two indexed queries in all.
 */
export async function loadNestedSubagentSummaries(
	parentIds: readonly string[],
): Promise<Map<string, SubagentNestedSummary>> {
	const summaries = new Map<string, SubagentNestedSummary>();
	const nested = await listNestedSubagents(parentIds, SUBAGENT_NESTED_CARD_LIMIT);
	if (nested.size === 0) return summaries;
	const helperIds = [...nested.values()].flatMap((entry) => entry.subagents.map((row) => row.id));
	const waiting = new Set(
		(
			await db
				.selectDistinct({ narratorId: narratorToolCalls.narratorId })
				.from(narratorToolCalls)
				.where(
					and(
						inArray(narratorToolCalls.narratorId, helperIds),
						eq(narratorToolCalls.status, "pending"),
					),
				)
				.limit(helperIds.length)
				.all()
		).map((row) => row.narratorId),
	);
	for (const [parentId, entry] of nested) {
		summaries.set(parentId, {
			total: entry.total,
			agents: entry.subagents.map((row) => ({
				subagentNarratorId: row.id,
				title: row.title,
				subagentType: getSubagentType(row.variant) ?? "subagent",
				status: row.status,
				...(waiting.has(row.id) ? { awaitingPermission: true as const } : {}),
				...(nestedAgentEnding(row) ? { ended: nestedAgentEnding(row) } : {}),
			})),
		});
	}
	return summaries;
}
