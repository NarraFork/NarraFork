import {
	type MessageOriginOptions,
	parseStewardOriginLabel,
	type StewardMessageProvenance,
} from "@shared/message-origin";
import { ValidationError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { type HostCallContext, hostCallContextSchema } from "./plugin-capability-broker";

const authorization = hotSafe("steward-message-admission", () => ({
	authorize: undefined as
		| ((
				provenance: StewardMessageProvenance,
				context: HostCallContext,
				signal?: AbortSignal,
		  ) => Promise<void>)
		| undefined,
}));

/** Host-only verifier; reconstructs current binding and ACL rather than trusting metadata. */
export function setStewardMessageAuthorizer(authorize: typeof authorization.authorize): () => void {
	authorization.authorize = authorize;
	return () => {
		if (authorization.authorize === authorize) authorization.authorize = undefined;
	};
}

export function isStewardMessage(origin?: MessageOriginOptions): boolean {
	return origin?.originLabel?.startsWith("stewardDelegation:") === true;
}

/** Synchronous transaction guard: no cancellation/expiry gap before SQLite commit. */
export function guardStewardMessageCommit(
	origin?: MessageOriginOptions,
	signal?: AbortSignal,
): void {
	signal?.throwIfAborted();
	if (!isStewardMessage(origin)) return;
	const deadline = Date.parse(origin?.delegationDeadlineAt ?? "");
	if (!Number.isFinite(deadline) || deadline <= Date.now())
		throw new ValidationError("Steward invocation deadline has expired");
}

export async function authorizeStewardMessage(
	narratorId: string,
	userId: string | null | undefined,
	origin?: MessageOriginOptions,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	if (!isStewardMessage(origin)) return;
	const provenance = parseStewardOriginLabel(origin?.originLabel);
	if (
		!provenance ||
		provenance.pluginId !== "steward-narrator" ||
		origin?.origin !== "assistant" ||
		provenance.userId !== userId ||
		provenance.targetNarratorId !== narratorId
	)
		throw new ValidationError("Invalid steward message attribution");
	const parsed = hostCallContextSchema.safeParse(origin?.delegationHostContext);
	if (!parsed.success) throw new ValidationError("Steward host identity snapshot is unavailable");
	const context = parsed.data;
	if (
		context.plugin.pluginId !== provenance.pluginId ||
		context.invocation.kind !== "user" ||
		context.invocation.userId !== provenance.userId ||
		context.invocation.narratorId !== provenance.stewardNarratorId ||
		context.scope.narratorId !== provenance.stewardNarratorId ||
		context.plugin.contributionId !== provenance.contributionId ||
		context.requestId !== provenance.requestId ||
		context.correlationId !== provenance.correlationId ||
		context.deadlineAt !== origin?.delegationDeadlineAt
	)
		throw new ValidationError("Steward host identity does not match provenance");
	const deadline = Date.parse(context.deadlineAt);
	if (!Number.isFinite(deadline) || deadline <= Date.now())
		throw new ValidationError("Steward invocation deadline has expired");
	if (!authorization.authorize)
		throw new ValidationError("Steward message authorizer is unavailable");
	await authorization.authorize({ ...provenance }, context, signal);
	signal?.throwIfAborted();
	if (deadline <= Date.now()) throw new ValidationError("Steward invocation deadline has expired");
}
