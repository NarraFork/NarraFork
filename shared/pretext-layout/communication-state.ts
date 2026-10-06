/** Pure Send presentation: queueing, injection consumption and matched replies are distinct. */
import { knownSendDeliveryTargets, type SendDeliveryTarget } from "../communication-tool";
import { readLeafText } from "./tool-io-projection";

export interface CommunicationTarget extends Partial<SendDeliveryTarget> {
	label?: string;
	status?: string;
	awaited?: boolean;
	error?: string;
	interrupted?: boolean;
}

export interface CommunicationState {
	targetCount: number;
	sentCount: number;
	receivedCount: number;
	replyCount: number;
	awaitReply: boolean;
	noRecipients?: boolean;
	outcome?: "error" | "timeout" | "cancelled";
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function communicationSelectors(input: unknown): string[] {
	const obj = object(input);
	const values = [obj.id, obj.name, obj.target_id];
	for (const key of ["ids", "names"]) if (Array.isArray(obj[key])) values.push(...obj[key]);
	return [
		...new Set(
			values.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()),
		),
	];
}

export function communicationTargetLabel(target: CommunicationTarget): string {
	return target.title?.trim() || target.label?.trim() || target.id?.slice(0, 8) || "?";
}

function readTarget(value: unknown): CommunicationTarget {
	const raw = object(value);
	const result: CommunicationTarget = {};
	for (const key of ["id", "title", "label", "deliveryMessageId", "status", "error"] as const) {
		const text = readLeafText(raw[key]);
		if (text !== undefined) result[key] = text;
	}
	if (raw.title === null) result.title = null;
	for (const key of ["deliveryId", "recipientRefId"] as const) {
		if (typeof raw[key] === "string") result[key] = raw[key];
	}
	if (typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision > 0)
		result.revision = raw.revision;
	if (
		raw.receiptDisposition === "active" ||
		raw.receiptDisposition === "superseded" ||
		raw.receiptDisposition === "recipient_deleted"
	)
		result.receiptDisposition = raw.receiptDisposition;
	// Consumption is a protocol field, never a projected preview or inferred message property.
	if (typeof raw.injectionConsumedAt === "string")
		result.injectionConsumedAt = raw.injectionConsumedAt;
	if (typeof raw.awaited === "boolean") result.awaited = raw.awaited;
	if (typeof raw.interrupted === "boolean") result.interrupted = raw.interrupted;
	return result;
}

/** Final targets define the set. Live receipt overlays never replace final reply/error results. */
export function resolveCommunicationTargets(
	metadata: Record<string, unknown> | null | undefined,
	runtimeTargets?: unknown,
): CommunicationTarget[] {
	const live = Array.isArray(runtimeTargets) ? runtimeTargets.map(readTarget) : [];
	if (!Array.isArray(metadata?.targets)) return live;
	const final = metadata.targets.map(readTarget);
	// Share receipt identity/revision rules with the runtime store: COW changes the
	// address, not the delivery. Final metadata still owns the set and reply result.
	const byId = new Map(
		knownSendDeliveryTargets({
			_metadata: { targets: final },
			_sendDeliveryTargets: live,
		}).map((target) => [target.id, target]),
	);
	return final.map((target) => {
		const receipt = target.id ? byId.get(target.id) : undefined;
		if (!receipt) return target;
		return {
			...target,
			...receipt,
			// Explicitly clear old facts when a newer revision has no consumption.
			deliveryId: receipt.deliveryId,
			recipientRefId: receipt.recipientRefId,
			revision: receipt.revision,
			receiptDisposition: receipt.receiptDisposition,
			injectionConsumedAt: receipt.injectionConsumedAt,
		};
	});
}

export function deriveCommunicationState(input: {
	targets?: CommunicationTarget[];
	targetCount?: unknown;
	selectorCount?: number;
	awaitReply?: boolean;
	status?: string | null;
}): CommunicationState {
	const targets = input.targets ?? [];
	const explicitCount =
		typeof input.targetCount === "number" && Number.isFinite(input.targetCount)
			? Math.max(0, Math.floor(input.targetCount))
			: undefined;
	// The server count is post-resolution: several selectors may name one agent.
	// Only fall back to selector count before that authoritative count is known.
	const targetCount = Math.max(explicitCount ?? input.selectorCount ?? 0, targets.length);
	let receivedCount = 0;
	let sentCount = 0;
	let replyCount = 0;
	for (const target of targets) {
		const consumed =
			typeof target.injectionConsumedAt === "string" && !!target.injectionConsumedAt.trim();
		if (consumed) receivedCount++;
		if (
			consumed ||
			target.deliveryMessageId ||
			["queued", "started", "completed", "sent"].includes(target.status ?? "")
		)
			sentCount++;
		// completed also describes an outgoing asynchronous reply. awaited:true is
		// authored only by the Send reply-wait result, not ordinary tool completion.
		if (input.awaitReply && target.status === "completed" && target.awaited === true) replyCount++;
	}
	const statuses = [input.status, ...targets.map((target) => target.status)];
	const outcome = statuses.some((s) => s === "failed" || s === "fail" || s === "error")
		? "error"
		: statuses.includes("timeout")
			? "timeout"
			: statuses.some((s) => s === "aborted" || s === "cancelled" || s === "taken_over")
				? "cancelled"
				: targets.some((t) => t.error)
					? "error"
					: undefined;
	// A successful tool result proves enqueueing only; never consumption or a reply.
	const succeeded = !outcome && (input.status === "success" || input.status === "completed");
	if (succeeded) sentCount = targetCount;
	return {
		targetCount,
		sentCount,
		receivedCount,
		replyCount,
		awaitReply: input.awaitReply === true,
		...(succeeded && input.targetCount === 0 && targetCount === 0 ? { noRecipients: true } : {}),
		...(outcome ? { outcome } : {}),
	};
}

export function formatCommunicationState(
	state: CommunicationState,
	labels?: Record<string, string>,
): string {
	const { targetCount: total, sentCount, receivedCount, replyCount, awaitReply, outcome } = state;
	if (state.noRecipients && !outcome) return labels?.communicationNoRecipients ?? "No recipients";
	const counted = (text: string, count: number) =>
		total > 0 && count < total ? `${text} ${count}/${total}` : text;
	const parts: string[] = [];
	if (receivedCount > 0)
		parts.push(counted(labels?.communicationReceived ?? "Received", receivedCount));
	else if (sentCount > 0) parts.push(counted(labels?.communicationSuccess ?? "Sent", sentCount));
	else if (!outcome) parts.push(labels?.communicationRunning ?? "Sending");
	if (awaitReply && sentCount > 0) {
		if (replyCount > 0)
			parts.push(counted(labels?.communicationReplyReceived ?? "Reply received", replyCount));
		else if (!outcome) parts.push(labels?.communicationWaiting ?? "Waiting");
	}
	if (outcome)
		parts.push(
			outcome === "error"
				? (labels?.communicationError ?? "Send failed")
				: outcome === "timeout"
					? (labels?.communicationTimeout ?? "Timed out")
					: (labels?.communicationCancelled ?? "Cancelled"),
		);
	return parts.join(" · ");
}
