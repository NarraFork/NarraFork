/**
 * Delegations written before runtime registrations existed store none of their relations:
 * the old code derived their controller, policy source, model pool, capability ceiling,
 * transcript mount and base prompt from the creating parent at runtime. This writes those
 * facts into storage once, so runtime reads explicit storage only.
 *
 * Old databases and old project archives both carry such rows, so it runs at startup and
 * after a project import. A materialized row no longer matches, so a second run is a no-op.
 */
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	like,
	notLike,
	or,
	type SQL,
} from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import { logger } from "../lib/logger";
import { getSubagentType } from "../lib/narrator-utils";
import {
	hasRuntimePolicyTrait,
	RUNTIME_POLICY_TRAIT_PREFIX,
	withRuntimePolicyTrait,
} from "../lib/runtime-policy-trait";
import {
	CONTROLLER_ACTIONS,
	parseRuntimeRegistration,
} from "../lib/validators/runtime-registration";
import { compileDelegationCeiling } from "./custom-subagent-service";
import { ensureLegacyCommunicationNodeTx } from "./narrator-communication/initialize";
import { publishCommunicationChanged } from "./narrator-communication/service";

const BATCH = 200;

/** Sections the old code appended to a delegated row's stored prompt; runtime adds them now. */
const LEGACY_PROMPT_SECTIONS = [
	"\n\n## Conversation Context\n\n",
	"\n\n## Message Senders\n\n",
	"\n\nCommunicating with the parent narrator:\n",
	"\n\n与父叙述者通信：\n",
];

/** Delegated rows missing a registration or their compiled capability ceiling. */
function legacyDelegationWhere(): SQL | undefined {
	return and(
		or(
			eq(narrators.type, "subagent"),
			eq(narrators.variant, "subagent"),
			like(narrators.variant, "subagent:%"),
		),
		or(
			isNull(narrators.runtimeRegistrationJson),
			notLike(narrators.traits, `%${RUNTIME_POLICY_TRAIT_PREFIX}%`),
		),
	);
}

/** The tool call an old delegation's transcript hangs under: its latest linked turn, else its origin. */
async function latestPlacement(
	narratorId: string,
	originToolCallId: string | null,
): Promise<string | undefined> {
	const latest = await db.query.narratorMessages.findFirst({
		where: and(
			eq(narratorMessages.narratorId, narratorId),
			eq(narratorMessages.role, "user"),
			isNotNull(narratorMessages.parentToolUseId),
		),
		columns: { parentToolUseId: true },
		orderBy: [desc(narratorMessages.createdAt)],
	});
	if (latest?.parentToolUseId) return latest.parentToolUseId;
	if (!originToolCallId) return undefined;
	const origin = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, originToolCallId),
		columns: { toolUseId: true },
	});
	return origin?.toolUseId ?? undefined;
}

function basePrompt(prompt: string | null): string | null {
	if (!prompt) return prompt;
	const cut = LEGACY_PROMPT_SECTIONS.map((marker) => prompt.indexOf(marker)).filter((i) => i >= 0);
	return cut.length ? prompt.slice(0, Math.min(...cut)) : prompt;
}

type LegacyRow = {
	id: string;
	type: string;
	variant: string;
	subagentType: string | null;
	parentNarratorId: string | null;
	policySourceNarratorId: string | null;
	originToolCallId: string | null;
	runtimeRegistrationJson: unknown;
	traits: unknown;
	systemPrompt: string | null;
};

async function materialize(row: LegacyRow): Promise<void> {
	const template = getSubagentType(row.variant) || row.subagentType || "general";
	const set: Partial<typeof narrators.$inferInsert> = {};
	if (row.runtimeRegistrationJson == null) {
		const parent = row.parentNarratorId;
		const placement = parent ? await latestPlacement(row.id, row.originToolCallId) : undefined;
		set.runtimeRegistrationJson = parseRuntimeRegistration({
			version: 1,
			modelPool: template,
			...(parent ? { controller: { narratorId: parent, actions: [...CONTROLLER_ACTIONS] } } : {}),
			...(placement ? { historyPlacement: { toolUseId: placement } } : {}),
		});
		if (!row.policySourceNarratorId && parent) set.policySourceNarratorId = parent;
	}
	set.systemPrompt = basePrompt(row.systemPrompt);
	if (!hasRuntimePolicyTrait(row.traits))
		set.traits = withRuntimePolicyTrait(row.traits, await compileDelegationCeiling(template));
	db.transaction((tx) => {
		tx.update(narrators).set(set).where(eq(narrators.id, row.id)).run();
		ensureLegacyCommunicationNodeTx(tx, {
			...row,
			runtimeRegistrationJson: set.runtimeRegistrationJson ?? row.runtimeRegistrationJson,
		});
	});
	publishCommunicationChanged([row.id]);
}

/** Materialize every legacy delegation, or only those among `ids`. Returns the rows written. */
export async function materializeLegacyDelegations(ids?: readonly string[]): Promise<number> {
	const scopes = ids
		? chunk([...new Set(ids)], 400).map((c) => inArray(narrators.id, c))
		: [undefined];
	let written = 0;
	for (const scope of scopes) {
		let after = "";
		for (;;) {
			const rows = await db.query.narrators.findMany({
				where: and(legacyDelegationWhere(), scope, gt(narrators.id, after)),
				orderBy: [asc(narrators.id)],
				columns: {
					id: true,
					type: true,
					variant: true,
					subagentType: true,
					parentNarratorId: true,
					policySourceNarratorId: true,
					originToolCallId: true,
					runtimeRegistrationJson: true,
					traits: true,
					systemPrompt: true,
				},
				limit: BATCH,
			});
			for (const row of rows) {
				try {
					await materialize(row);
					written++;
				} catch (error) {
					logger.warn("Failed to materialize legacy delegation", {
						narratorId: row.id,
						error: String(error),
					});
				}
			}
			if (rows.length < BATCH) break;
			after = rows[rows.length - 1].id;
		}
	}
	if (written > 0) logger.info("Materialized legacy delegation registrations", { written });
	return written;
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
