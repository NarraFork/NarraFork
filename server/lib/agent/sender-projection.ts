import { parseOriginLabel } from "@shared/message-origin";
import { isNativeModelContextBlock, modelTextFromContentBlocks } from "@shared/native-injection";
import type { DbMessage } from "./provider";

export interface MessageSender {
	kind: "human" | "agent" | "system";
	id?: string;
	name?: string;
}

/** Structural input only: this module never resolves identities through a database. */
export interface SenderMessage extends DbMessage {
	createdBy?: string | null;
	origin?: string | null;
	originLabel?: string | null;
	creator?: { username: string } | null;
	narrator?: { title?: string | null } | null;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: undefined;
}
function known(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
function sender(kind: MessageSender["kind"], id?: unknown, name?: unknown): MessageSender {
	return {
		kind,
		...(known(id) ? { id: known(id) } : {}),
		...(known(name) ? { name: known(name) } : {}),
	};
}
function blocksOf(message: SenderMessage): unknown[] {
	return Array.isArray(message.contentJson) ? message.contentJson : [];
}
function inboundItems(message: SenderMessage): RecordValue[] {
	// Only native envelopes in machine-authored rows are authoritative. A human's
	// text (or even a supplied structured block) cannot assert a machine identity.
	if (message.role !== "sys" && !(message.role === "user" && message.origin === "assistant"))
		return [];
	return blocksOf(message).flatMap((value) => {
		const block = record(value);
		const body = record(block?.body);
		if (block?.type !== "system_injection" || body?.kind !== "messages") return [];
		return Array.isArray(body.items)
			? body.items.flatMap((item) => (record(item) ? [record(item) as RecordValue] : []))
			: [];
	});
}
function itemSender(item: RecordValue): MessageSender {
	return sender("agent", item.fromId, known(item.fromTitle) ?? item.fromLabel);
}
function systemSender(message: SenderMessage): MessageSender {
	const source = blocksOf(message)
		.map((value) => record(value))
		.find((block) => block?.type === "system_injection" && known(block.source))?.source;
	const key = known(source) ?? parseOriginLabel(message.originLabel)?.source;
	return sender("system", key, key);
}

/** Ownership and role/origin outrank createdBy (which can be an initiating human). */
export function resolveMessageSender(message: SenderMessage): MessageSender {
	if (message.role === "assistant")
		return sender("agent", message.narratorId, message.narrator?.title);
	const items = inboundItems(message);
	if (items.length) {
		const identities = items.map(itemSender);
		const first = identities[0];
		return identities.every((value) => value.id === first.id && value.name === first.name)
			? first
			: { kind: "agent" };
	}
	if (message.role === "user" && message.origin === "assistant") {
		const label = parseOriginLabel(message.originLabel);
		return sender("agent", undefined, label?.source === "agentMessage" ? label.detail : undefined);
	}
	if (message.role === "user" && (message.origin == null || message.origin === "user"))
		return sender("human", message.createdBy, message.creator?.username);
	return systemSender(message);
}

/** Bound raw attribute length before escaping; controls and invalid XML units are data. */
function attribute(value: string): string {
	return Array.from(value.slice(0, 256), (char) => {
		const code = char.codePointAt(0) as number;
		return code < 32 ||
			(code >= 127 && code <= 159) ||
			code === 65534 ||
			code === 65535 ||
			(code >= 55296 && code <= 57343)
			? "�"
			: char;
	})
		.join("")
		.replace(/[&<>"']/g, (char) => {
			const escapes: Record<string, string> = {
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&apos;",
			};
			return escapes[char];
		});
}
function marker(value: MessageSender): string {
	return `<sender kind="${value.kind}"${known(value.id) ? ` id="${attribute(value.id as string)}"` : ""}${known(value.name) ? ` name="${attribute(value.name as string)}"` : ""} />`;
}

/** Deliberately no content sniffing: a user-written marker remains ordinary input. */
export function projectSenderText(text: string, value: MessageSender): string {
	return text.trim() ? `${marker(value)}\n${text}` : text;
}

/** Share attribution with live/custom input while retaining every original byte. */
export function projectMessageSenderText(message: SenderMessage, text: string): string {
	if (!text || message.role === "assistant" || message.role === "disp" || message.role === "system")
		return text;
	const items = inboundItems(message);
	if (items.length <= 1) return projectSenderText(text, resolveMessageSender(message));
	// Match only exact structured item payloads, never parse a sender-like string.
	// Sequential matching handles identical bodies from different agents. If the
	// renderer omitted/transformed any item, emit an attribution roster instead of
	// pretending the entire grouped projection was written by its first sender.
	let cursor = 0;
	let result = "";
	for (const item of items) {
		const itemText = known(item.text);
		const index = itemText ? text.indexOf(itemText, cursor) : -1;
		if (index === -1)
			return `${items.map((entry) => marker(itemSender(entry))).join("\n")}\n${text}`;
		result += `${text.slice(cursor, index)}${marker(itemSender(item))}\n${itemText}`;
		cursor = index + (itemText as string).length;
	}
	return result + text.slice(cursor);
}

/** Native live injections use exactly the same attribution as their history copy. */
export function projectInjectionSenderText(text: string, source: string, body?: unknown): string {
	return projectMessageSenderText(
		{
			id: "",
			role: "sys",
			contentJson: [{ type: "system_injection", source, body }],
			contentText: text,
			parentToolUseId: null,
			messageUuid: null,
		},
		text,
	);
}
// Explicit process-local metadata: symbol keys survive object spread but are
// ignored by JSON serialization, so this never changes persisted message schemas.
const projected = Symbol("senderProjection");
type ProjectedMessage = SenderMessage & { [projected]?: true };

/** Immutable model projection; preserve blocks, body metadata and all non-text payloads. */
export function projectMessageSenderForModel<T extends SenderMessage>(message: T): T {
	if (
		(message as ProjectedMessage)[projected] ||
		message.role === "assistant" ||
		message.role === "disp" ||
		message.role === "system"
	)
		return message;
	const blocks = blocksOf(message);
	const originalText = modelTextFromContentBlocks(blocks) || message.contentText || "";
	// Joining several empty blocks produces separators, not authored model text.
	if (!originalText.trim()) return message;
	const text = projectMessageSenderText(message, originalText);
	let consumed = 0;
	const contentJson = blocks.map((value) => {
		const block = record(value);
		const key =
			block?.type === "text" && typeof block.text === "string"
				? "text"
				: isNativeModelContextBlock(value)
					? "modelText"
					: undefined;
		if (!block || !key) return value;
		const original = block[key] as string;
		// Each physical projection retains its own source grouping. A single global
		// prefix belongs to the first nonempty block; native inbound groups use their
		// own structured items rather than flattening/rewriting reader-facing bodies.
		const local =
			block.type === "system_injection"
				? projectMessageSenderText({ ...message, contentJson: [block] }, original)
				: consumed === 0
					? projectMessageSenderText(message, original)
					: original;
		if (original) consumed++;
		return { ...block, [key]: local };
	});
	const blockText = modelTextFromContentBlocks(contentJson);
	// With no model text blocks, contentText is the sole existing representation;
	// do not fabricate a block beside images, tools, reasoning or file references.
	const output = {
		...message,
		contentJson: Array.isArray(message.contentJson) ? contentJson : message.contentJson,
		contentText: blockText || text,
		[projected]: true as const,
	};
	return output;
}

/** Last top-level user across invisible tails, without crossing an assistant turn. */
export function findCurrentSenderMessage<T extends SenderMessage>(
	messages: readonly T[],
): T | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message.parentToolUseId ||
			message.role === "sys" ||
			message.role === "disp" ||
			message.role === "system"
		)
			continue;
		return message.role === "user" ? message : undefined;
	}
	return undefined;
}
