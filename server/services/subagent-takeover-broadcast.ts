/**
 * subagent-takeover-broadcast.ts — Tell the PARENT's message layer that a
 * subagent was taken over (or released).
 *
 * WHY A SEPARATE FRAME FROM `subagent_status_changed`
 * The takeover fact already rides that frame's substatus, but it is consumed by
 * the PANEL subscription, whose product is the narrator row's status chip. The
 * card that is actually stuck lives in the MESSAGE layer:
 *
 *   - a foreground Agent/Task call stays suspended in `waitForManualOverride`
 *   - an `Await({type:"agent"})` already in flight when the takeover began never
 *     returns (the takeover short-circuit only applies to a NEW wait)
 *
 * Neither shows anything unusual, so a user who forgets "Stop takeover" stalls
 * the whole session with no visible cause. This frame is what lets the card say
 * so, and `useNarratorPanelWS` excludes it for the same reason it excludes
 * `await_agent_resolved`: the panel has no card to patch.
 *
 * Lives in its own module (rather than beside the other subagent broadcasts in
 * `subagent-runner.ts`) because all three producers — the takeover routes, the
 * background-takeover transition, and the session-engine release path — would
 * otherwise have to reach into a module that imports half the subagent stack.
 * Its only dependencies are the DB and the socket.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages } from "../db/schema";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";

/**
 * The `tool_use` that spawned this subagent, i.e. the card to patch.
 *
 * Same single-row indexed lookup the stop-takeover route already performs: a
 * subagent's first user message carries its parent tool use id.
 */
export async function resolveSpawningToolUseId(subagentId: string): Promise<string | undefined> {
	try {
		const first = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.narratorId, subagentId),
				eq(narratorMessages.role, "user"),
				isNotNull(narratorMessages.parentToolUseId),
			),
			columns: { parentToolUseId: true },
			orderBy: narratorMessages.createdAt,
		});
		return first?.parentToolUseId ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Broadcast a takeover transition to the parent's message subscribers.
 *
 * `toolUseId` is optional and resolved here when not supplied by the caller. A
 * frame WITHOUT one is still sent: the client then matches the card by
 * `subagentNarratorId` (every Agent/Task card carries it in its activity
 * summary, and a running Await carries the server-resolved id). Dropping the
 * frame would lose the indicator precisely in the cases that are hardest to
 * diagnose.
 *
 * Never throws — a missing badge must not fail a takeover.
 */
export async function broadcastSubagentTakeoverChanged(opts: {
	parentNarratorId: string;
	subagentNarratorId: string;
	takenOver: boolean;
	toolUseId?: string;
}): Promise<void> {
	try {
		const toolUseId = opts.toolUseId ?? (await resolveSpawningToolUseId(opts.subagentNarratorId));
		broadcastToNarrator(opts.parentNarratorId, {
			type: "subagent_takeover_changed",
			narratorId: opts.parentNarratorId,
			subagentNarratorId: opts.subagentNarratorId,
			...(toolUseId ? { toolUseId } : {}),
			takenOver: opts.takenOver,
		});
	} catch (err) {
		logger.warn("Failed to broadcast subagent takeover change", {
			subagentId: opts.subagentNarratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
