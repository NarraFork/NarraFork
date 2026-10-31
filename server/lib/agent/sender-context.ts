import { resolveMessageSender, type SenderMessage } from "./sender-projection";

function parseSenderContext(text: string | undefined): Map<string, string> {
	if (!text) return new Map();
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
		return new Map(
			Object.entries(value).flatMap(([id, name]) =>
				id.trim() && typeof name === "string" ? [[id, name.trim() ? name : ""]] : [],
			),
		);
	} catch {
		return new Map();
	}
}

/** Capture first-seen human display names; an empty name freezes an unknown name too. */
export function collectSenderContext(
	messages: readonly SenderMessage[],
	previousText?: string,
): string {
	const names = parseSenderContext(previousText);
	for (const message of messages) {
		const sender = resolveMessageSender(message);
		if (sender.kind === "human" && sender.id && !names.has(sender.id)) {
			names.set(sender.id, sender.name ?? "");
		}
	}
	return JSON.stringify(
		Object.fromEntries([...names].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
	);
}

/** Only display metadata changes: source rows, identity, role and origin remain untouched. */
export function projectFrozenSenders<T extends SenderMessage>(
	messages: readonly T[],
	senderContext: string | undefined,
): T[] {
	const names = parseSenderContext(senderContext);
	return messages.map((message) => {
		const sender = resolveMessageSender(message);
		if (sender.kind !== "human" || !sender.id) return message;
		const name = names.get(sender.id);
		if (name === undefined || name === (sender.name ?? "")) return message;
		return { ...message, creator: { ...message.creator, username: name } };
	});
}
