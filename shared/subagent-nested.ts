/**
 * subagent-nested.ts — the one nested level of a subagent card.
 *
 * A first-level subagent (a `worker`) may launch helpers of its own. On the page that
 * shows the first-level subagent as a card (the primary's page), the card lists those
 * helpers as short rows: who they are, whether they still run, and whether one is
 * waiting for a person's approval. The server sends this summary with the card's
 * activity snapshot and re-sends it (`subagent_nested_changed`) when a helper starts,
 * changes status or asks for permission. Helpers never have helpers of their own, so
 * this is the only nesting a card renders.
 */

/** Rows a card shows; the rest is counted in `total`. Same bound on server and client. */
export const SUBAGENT_NESTED_CARD_LIMIT = 5;

export interface SubagentNestedAgent {
	/** The helper's own narrator id (opens its session). */
	subagentNarratorId: string;
	title: string | null;
	/** Template it was created from (`explore`, `general`, ...). */
	subagentType: string;
	/** Narrator status: working / waiting / idle / archived. */
	status: string;
	/** A permission request of this helper waits for a person. */
	awaitingPermission?: true;
	/**
	 * How a helper that no longer runs ended, when not normally: `failed` (error) or
	 * `stopped` (stopped by a person or its parent, or timed out). Absent otherwise.
	 */
	ended?: "failed" | "stopped";
}

export interface SubagentNestedSummary {
	/** At most {@link SUBAGENT_NESTED_CARD_LIMIT}, active ones first. */
	agents: SubagentNestedAgent[];
	/** Every helper the subagent launched, shown or not. */
	total: number;
}

/** Defensive parse of a wire value; anything malformed is dropped, never thrown. */
export function normalizeSubagentNestedSummary(value: unknown): SubagentNestedSummary | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as { agents?: unknown; total?: unknown };
	if (!Array.isArray(record.agents)) return null;
	const agents: SubagentNestedAgent[] = [];
	for (const raw of record.agents.slice(0, SUBAGENT_NESTED_CARD_LIMIT)) {
		if (!raw || typeof raw !== "object") continue;
		const agent = raw as Record<string, unknown>;
		if (typeof agent.subagentNarratorId !== "string" || !agent.subagentNarratorId) continue;
		agents.push({
			subagentNarratorId: agent.subagentNarratorId,
			title: typeof agent.title === "string" ? agent.title : null,
			subagentType: typeof agent.subagentType === "string" ? agent.subagentType : "",
			status: typeof agent.status === "string" ? agent.status : "idle",
			...(agent.awaitingPermission === true ? { awaitingPermission: true as const } : {}),
			...(agent.ended === "failed" || agent.ended === "stopped" ? { ended: agent.ended } : {}),
		});
	}
	const total =
		typeof record.total === "number" && Number.isFinite(record.total)
			? Math.max(agents.length, Math.trunc(record.total))
			: agents.length;
	return { agents, total };
}

/** Whether a helper row reads as still running (a spinner rather than a status mark). */
export function isNestedAgentActive(agent: Pick<SubagentNestedAgent, "status">): boolean {
	return agent.status === "working" || agent.status === "waiting";
}
