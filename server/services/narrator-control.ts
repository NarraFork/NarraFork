/**
 * Authorization for control actions one narrator takes on another (Stop, a Send
 * interrupt, archive/unarchive).
 *
 * Control is a separate grant from reachability: being able to message, subscribe to
 * or share a fork source with a session confers no control. The only source of
 * control is the target's registered `controller` grant (see `lib/runtime-source.ts`),
 * narrowed by the caller's current capability ceiling and the current human ACL.
 *
 * Human requests over HTTP never come through here; they keep the plain write ACL.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { ForbiddenError } from "../lib/errors";
import { controllerOf } from "../lib/runtime-source";
import type { ControllerAction } from "../lib/validators/runtime-registration";
import { getRunHold } from "./agent-runtime/ownership";
import {
	DELEGATION_DEPTH_LIMIT_MESSAGE,
	delegationDepthOf,
	MAX_DELEGATION_DEPTH,
} from "./delegation-depth";
import { canWriteNarrator } from "./narrator-acl";
import { narratorService } from "./narrator-service";
import { resolveNarratorRuntimePolicy } from "./trait-layer-service";

export type AgentControlTarget = Awaited<ReturnType<typeof narratorService.getById>>;

export interface AgentControlRequest {
	/** Narrator issuing the control action. */
	callerNarratorId: string;
	targetNarratorId: string;
	action: ControllerAction;
	/** Execution principal of the caller's current run; null = no human authority. */
	userId?: string | null;
}

/** The caller may not control this target. Message is model-facing. */
export class AgentControlDeniedError extends ForbiddenError {}

/**
 * Throws {@link AgentControlDeniedError} unless the caller holds `action` on the target:
 *
 * 1. the target registers the caller as its controller for that action (direct only);
 * 2. the caller's current capability ceiling still allows orchestration, and the caller
 *    is not at the deepest delegation level;
 * 3. the caller's execution principal, if any, may currently write the target;
 * 4. while the user has taken the target over, the controller may not cut into the
 *    user's work: `stop` and `archive` are refused. A Send `doInterrupt` (`steer`) is
 *    still authorized, but its caller delivers the message normally without
 *    interrupting, so the instruction is not lost.
 *
 * Returns the target row so callers act on exactly what was authorized.
 */
export async function authorizeAgentControl(
	request: AgentControlRequest,
): Promise<AgentControlTarget> {
	const deny = (reason: string): never => {
		throw new AgentControlDeniedError(reason);
	};
	// A missing target and an uncontrolled one are reported alike: control checks never
	// reveal whether some other session exists.
	const notControlled = () =>
		deny(`Agent ${request.targetNarratorId} is not a direct child subagent of this narrator.`);
	const target = await narratorService.getById(request.targetNarratorId).catch(notControlled);
	const grant = controllerOf(target);
	if (grant?.narratorId !== request.callerNarratorId || !grant.actions.includes(request.action))
		notControlled();
	const ceiling = await resolveNarratorRuntimePolicy(request.callerNarratorId, request.userId);
	// Control backstop for nesting: a narrator at the deepest level controls nobody, whether
	// its ceiling was stamped with its level or not (the parent chain is the second source).
	if (
		Math.max(ceiling.delegationDepth, await delegationDepthOf(request.callerNarratorId)) >=
		MAX_DELEGATION_DEPTH
	)
		deny(DELEGATION_DEPTH_LIMIT_MESSAGE);
	if (!ceiling.capabilities.spawnAgent)
		deny("This narrator's capability ceiling does not allow controlling other agents.");
	if (request.userId) {
		const user = await db.query.users.findFirst({
			where: eq(users.id, request.userId),
			columns: { id: true, role: true },
		});
		if (
			!user ||
			!(await canWriteNarrator(target, { userId: user.id, isAdmin: user.role === "admin" }))
		)
			deny(`The current user may not control agent ${target.id}.`);
	}
	if ((request.action === "stop" || request.action === "archive") && getRunHold(target.id))
		deny(`Agent ${target.id} is taken over by the user; it cannot be interrupted now.`);
	return target;
}
