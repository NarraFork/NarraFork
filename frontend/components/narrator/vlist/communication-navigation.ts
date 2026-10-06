/**
 * Open a Send recipient: prefer jumping to the receipt when it exists, otherwise
 * still open the target session without message tracking.
 *
 * A 404 from `locate` means the reserved receipt has not materialized yet (sent
 * but not received) — or the receipt is gone. Hiding the dock behind that was
 * wrong: the reader already knows who they addressed, and opening the session
 * without a `messageId` is honest (no jump, no invented location).
 */
export async function openCommunicationRecipient(
	recipient: {
		id: string;
		deliveryMessageId?: string;
		receiptDisposition?: "active" | "superseded" | "recipient_deleted";
	},
	options: {
		locate: (narratorId: string, messageId: string) => Promise<{ messageId: string }>;
		open: (narratorId: string, messageId?: string) => void;
		notify: (reason: "legacy" | "unavailable" | "error") => void;
	},
): Promise<void> {
	if (recipient.receiptDisposition === "recipient_deleted") {
		options.notify("unavailable");
		return;
	}
	if (!recipient.deliveryMessageId) {
		// Old Send results only recorded a narrator id. Never guess from message text.
		options.open(recipient.id);
		options.notify("legacy");
		return;
	}
	try {
		const location = await options.locate(recipient.id, recipient.deliveryMessageId);
		options.open(recipient.id, location.messageId);
	} catch (error) {
		const status = error && typeof error === "object" && "status" in error ? error.status : null;
		if (status === 404) {
			// Sent-but-not-received (or receipt cleaned up): open the session, skip tracking.
			options.open(recipient.id);
			options.notify("unavailable");
			return;
		}
		options.notify("error");
	}
}
