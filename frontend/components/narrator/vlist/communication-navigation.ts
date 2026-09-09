/** A reserved delivery id becomes a navigation target only after the receipt exists. */
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
		options.notify(status === 404 ? "unavailable" : "error");
	}
}
