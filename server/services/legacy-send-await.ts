/**
 * Retired Send reply waits (`Send({ await: true })`).
 *
 * Send no longer waits: a recipient answers with its own Send, which arrives as an
 * ordinary message and wakes the requester when idle. A process from before that
 * change may still have checkpointed a running reply wait (`send_await`
 * continuation) for a planned update. Its message was already delivered, so recovery
 * never re-sends it; it only closes the call with the outcome the checkpoint recorded.
 */

type LegacyReplyWaitResult =
	| { status: "replied"; message: string; receivedAt?: string }
	| { status: "timeout" | "aborted" | "cancelled" }
	| { status: "failed"; error: string };

interface LegacyDeliveryCoordinates {
	deliveryId?: string;
	recipientRefId?: string;
	revision?: number;
}

interface LegacySendTarget extends LegacyDeliveryCoordinates {
	id: string;
	label?: string;
	title?: string | null;
	status: string;
	deliveryMessageId?: string;
	interrupted?: boolean;
	error?: string;
}

interface LegacyReplyWaiter extends LegacyDeliveryCoordinates {
	responderId: string;
	label?: string;
	title?: string | null;
	deliveryNote: string;
	deliveryMessageId?: string;
	interrupted?: boolean;
	result?: LegacyReplyWaitResult;
}

export interface LegacySendAwaitSnapshot {
	toolUseId: string;
	requesterId: string;
	doInterrupt: boolean;
	waiters: LegacyReplyWaiter[];
	prefixSections: string[];
	prefixTargets: LegacySendTarget[];
}

export function sendAwaitSnapshotFromPayload(
	payload: Record<string, unknown> | null,
): LegacySendAwaitSnapshot | null {
	const value = payload?.sendAwait;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const snapshot = value as Partial<LegacySendAwaitSnapshot>;
	if (
		typeof snapshot.toolUseId !== "string" ||
		typeof snapshot.requesterId !== "string" ||
		!Array.isArray(snapshot.waiters) ||
		!Array.isArray(snapshot.prefixSections) ||
		!Array.isArray(snapshot.prefixTargets)
	) {
		return null;
	}
	for (const target of [...snapshot.waiters, ...snapshot.prefixTargets]) {
		if (!target || typeof target !== "object" || Array.isArray(target)) return null;
	}
	return snapshot as LegacySendAwaitSnapshot;
}

const RETIRED_WAIT_NOTE =
	"The reply wait ended: Send no longer waits for replies. The message was delivered; " +
	"a reply arrives as an ordinary message.";

/** The terminal ToolResult for a retired wait. Recorded replies are kept, nothing is re-sent. */
export function buildRetiredSendAwaitToolOutput(snapshot: LegacySendAwaitSnapshot): {
	_text: string;
	_metadata: Record<string, unknown>;
} {
	const sections = [...snapshot.prefixSections];
	const targets: LegacySendTarget[] = [...snapshot.prefixTargets];
	for (const waiter of snapshot.waiters) {
		const label = waiter.label ?? waiter.responderId;
		const result = waiter.result;
		const replied = result?.status === "replied";
		sections.push(
			replied
				? `${waiter.deliveryNote}\nReceived Send reply from ${label}:\n` +
						`<subagent_id>${label}</subagent_id>\n\n${result.message}`
				: result?.status === "failed"
					? `${waiter.deliveryNote}\nFailed while waiting for ${label} to reply: ${result.error}`
					: `${waiter.deliveryNote}\n${RETIRED_WAIT_NOTE}`,
		);
		targets.push({
			id: waiter.responderId,
			label,
			title: waiter.title,
			status: replied ? "completed" : result?.status === "failed" ? "failed" : "queued",
			...(waiter.deliveryMessageId ? { deliveryMessageId: waiter.deliveryMessageId } : {}),
			...(waiter.interrupted !== undefined ? { interrupted: waiter.interrupted } : {}),
			...(waiter.deliveryId !== undefined ? { deliveryId: waiter.deliveryId } : {}),
			...(waiter.recipientRefId !== undefined ? { recipientRefId: waiter.recipientRefId } : {}),
			...(waiter.revision !== undefined ? { revision: waiter.revision } : {}),
			...(result?.status === "failed" ? { error: result.error } : {}),
		});
	}
	return {
		_text: sections.join("\n\n"),
		_metadata: { kind: "send", targets, doInterrupt: snapshot.doInterrupt },
	};
}
