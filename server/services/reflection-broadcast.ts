/**
 * reflection-broadcast.ts — Fan-out for reflection-gate lifecycle frames.
 *
 * WHY THIS EXISTS
 *
 * A reflection gate (danger / plan / task / question) is owned by ONE narrator
 * but can be watched from TWO pages at the same time: when the gate belongs to a
 * subagent, the parent narrator's page renders it inside the owning Agent/Task
 * card, while the subagent's own page renders it as a top-level tool card. Every
 * lifecycle broadcast used to go to a single `broadcastTargetId` (the parent for
 * a subagent gate), so a client sitting on the subagent's own page never
 * received `*_reflection_stopped` / `_resolved` and kept rendering a running
 * notice — indefinitely, because these frames do not bump `messageVersion` and
 * therefore never trigger the frontend's structural reload either.
 *
 * The precedent for the correct behaviour already existed in
 * `abortPersistedDangerReflectionWithoutRuntime`, which fans out to both the
 * owner and its parent. This module generalizes that so every gate family shares
 * one implementation instead of each call site picking a single target.
 *
 * PER-TARGET ROUTING FIELDS
 *
 * `subagentNarratorId` / `parentToolUseId` mean "this frame describes a CHILD of
 * the narrator you are watching" — the frontend uses them to route the update
 * into a parent card's activity area instead of a top-level row (see
 * `useVListLivePatches`'s `routeParent`). They are therefore correct for the
 * PARENT target and wrong for the OWNER target, so the identity is recomputed per
 * target rather than shared. `ownerNarratorId` is absolute and always included.
 */

import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { NarratorServerMessage } from "../websocket/narrator-ws-types";

/** Who owns a reflection gate and where it can be watched from. */
export interface ReflectionBroadcastRoute {
	/** Narrator that actually owns the gated tool call. */
	narratorId: string;
	/** Page the gate was originally addressed to (parent for a subagent gate). */
	broadcastTargetId: string;
	/** Parent Agent/Task/Send tool_use that owns the subagent, when applicable. */
	parentToolUseId?: string;
}

/**
 * Every narrator page that must observe this gate: the owner plus the original
 * broadcast target. Deduplicated, and ordered owner-first so a single-target gate
 * (owner === target) is indistinguishable from the pre-fan-out behaviour.
 */
export function reflectionBroadcastTargets(route: ReflectionBroadcastRoute): string[] {
	const targets = [route.narratorId, route.broadcastTargetId].filter(
		(id): id is string => typeof id === "string" && id.length > 0,
	);
	return [...new Set(targets)];
}

/**
 * Routing identity for ONE target. Only a target that is not the owner gets the
 * child-pointing fields; the owner's own page must see the gate as top-level.
 */
export function reflectionRoutingIdentityFor(
	route: ReflectionBroadcastRoute,
	targetId: string,
): { ownerNarratorId: string; subagentNarratorId?: string; parentToolUseId?: string } {
	const isOwnerView = targetId === route.narratorId;
	return {
		ownerNarratorId: route.narratorId,
		...(isOwnerView ? {} : { subagentNarratorId: route.narratorId }),
		...(isOwnerView || !route.parentToolUseId ? {} : { parentToolUseId: route.parentToolUseId }),
	};
}

/** Frame types this module owns: every reflection lifecycle + progress event. */
type ReflectionFrame = Extract<
	NarratorServerMessage,
	{ type: `${string}reflection${string}` | "reflection_progress" }
>;

/**
 * A reflection frame minus the fields derived per target.
 *
 * Written as a DISTRIBUTIVE conditional so the Omit applies to each union member
 * separately. A plain `Omit<Union, K>` collapses the union to its common keys,
 * which would reject every frame-specific field (`danger`, `mutations`, `phase`…).
 */
type ReflectionFrameBody<T = ReflectionFrame> = T extends ReflectionFrame
	? Omit<T, "narratorId" | "ownerNarratorId" | "subagentNarratorId" | "parentToolUseId">
	: never;

/**
 * Send one reflection lifecycle frame to every page that can be watching the
 * gate, stamping each copy with that target's own `narratorId` + routing
 * identity.
 *
 * Failures are contained per target: a dead socket for one page must not stop the
 * other page from learning that the gate resolved.
 */
export function broadcastReflectionFrame(
	route: ReflectionBroadcastRoute,
	frame: ReflectionFrameBody,
): void {
	for (const targetId of reflectionBroadcastTargets(route)) {
		broadcastToNarrator(targetId, {
			...frame,
			narratorId: targetId,
			...reflectionRoutingIdentityFor(route, targetId),
		} as NarratorServerMessage);
	}
}
