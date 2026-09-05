/**
 * narrator-dual-broadcast.ts — the ONE way a subagent's row/event reaches both pages.
 *
 * A subagent's output has two audiences with incompatible needs:
 *
 *   - the PARENT's page, where the subagent is one tool card. It needs the linking
 *     fields (`parentToolUseId`, `subagentNarratorId`) to attach the update to the
 *     right card.
 *   - the SUBAGENT's own page, which renders the subagent as an ordinary narrator.
 *     It needs those same fields GONE, or the row is treated as a child of some
 *     tool_use that page knows nothing about and is never drawn.
 *
 * That transform is the whole content of this module. It lived as a private function
 * inside `narrator-event-handler`, reachable only through an `EventHandlerContext` —
 * so a producer outside the agent event loop (structured injection, notably) had no
 * way to use it and would have had to keep a second copy of the stripping rules. Two
 * copies of "which fields make a row look like a child" is exactly the drift that
 * makes a subagent page silently miss rows, so the rules live here once and both
 * callers pass their own targeting.
 *
 * This is deliberately in the websocket layer rather than in a service: it is the
 * lowest layer both callers already depend on, so neither import can close a cycle.
 */

import { broadcastToNarrator, type NarratorServerMessage } from "./narrator-ws";

/** Who a dual broadcast is addressed to. */
export interface DualBroadcastTarget {
	/** The row's owner — a subagent's own narrator id. */
	narratorId: string;
	/** Where the primary copy goes: the parent narrator for a subagent, else itself. */
	broadcastTargetId: string;
	/**
	 * The tool_use that owns this subagent. Its presence is what makes the delivery
	 * dual; absent (a primary narrator) this degrades to a single broadcast.
	 */
	parentToolUseId?: string | null;
}

/**
 * Send `message` to the primary target and, for a subagent, a stripped self copy.
 *
 * `parentMessage` lets a caller give the parent a deliberately REDUCED payload while
 * the self copy stays complete — the parent renders a one-line row, and CLAUDE.md
 * forbids putting large tool payloads on this high-frequency path.
 */
export function dualBroadcastToNarrator(
	target: DualBroadcastTarget,
	message: NarratorServerMessage,
	parentMessage: NarratorServerMessage = message,
): void {
	broadcastToNarrator(target.broadcastTargetId, parentMessage);

	if (!target.parentToolUseId || target.narratorId === target.broadcastTargetId) return;

	// biome-ignore lint/suspicious/noExplicitAny: shallow clone with dynamic field overrides
	const selfMsg: any = { ...message, narratorId: target.narratorId };
	// Strip subagent linking fields from the nested event (if present)
	if (selfMsg.event && typeof selfMsg.event === "object") {
		const { subagentToolUseId, subagentNarratorId, ...cleanEvent } = selfMsg.event;
		selfMsg.event = cleanEvent;
	}
	// Strip parentToolUseId from tool_use_chunk self-copy
	if (selfMsg.parentToolUseId) {
		delete selfMsg.parentToolUseId;
	}
	// Strip isSubagent flag from context_usage / metering self-copy
	if (selfMsg.isSubagent) {
		delete selfMsg.isSubagent;
	}
	// Strip parentToolUseId from the message payload so the subagent page treats it
	// as a top-level message (not a child of some tool_use).
	if (selfMsg.message?.parentToolUseId) {
		selfMsg.message = { ...selfMsg.message, parentToolUseId: null };
	}
	broadcastToNarrator(target.narratorId, selfMsg);
}
