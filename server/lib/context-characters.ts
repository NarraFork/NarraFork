import type {
	ContextCategory,
	ContextCharStats,
	ContextSegment,
} from "@shared/context-composition";

/** Character counts use UTF-16 string.length, never token or byte estimates. */
export function measureSummaryCharacters(text?: string | null): number {
	return typeof text === "string" ? text.length : 0;
}

const BINARY_KEYS = new Set([
	"base64",
	"imageBase64",
	"audioBase64",
	"bytes",
	"binary",
	"thoughtSignature",
	"signature",
	"b64_json",
	"inlineData",
	"inline_data",
]);

/** Fixed compact JSON representation, with binary payloads removed before serialization. */
export function measureSerializedCharacters(value: unknown): number {
	if (value == null) return 0;
	const serialized = JSON.stringify(value, (key, entry: unknown) => {
		if (BINARY_KEYS.has(key)) return undefined;
		if (typeof entry === "string" && /^data:[^,]*;base64,/i.test(entry)) return undefined;
		if (entry instanceof ArrayBuffer || ArrayBuffer.isView(entry)) return undefined;
		if (entry && typeof entry === "object") {
			const record = entry as Record<string, unknown>;
			if (
				record.type === "Buffer" ||
				record.type === "image" ||
				record.type === "redacted_thinking"
			)
				return undefined;
			if (record.encoding === "base64" || record.type === "base64") return undefined;
		}
		return entry;
	});
	return serialized?.length ?? 0;
}

/** Tool bodies belong exclusively to narrator_tool_calls, not their duplicate message blocks. */
export function measureMessageCharacters(
	role: string,
	contentJson: unknown,
	contentText?: string | null,
): ContextCharStats {
	if (role === "disp") return { segments: [] };
	const segments: ContextSegment[] = [];
	const userTextParts: string[] = [];
	const addChars = (category: ContextCategory, chars: number) => {
		if (!Number.isSafeInteger(chars) || chars <= 0) return;
		const previous = segments.at(-1);
		if (previous?.category === category && !previous.toolUseId) previous.chars += chars;
		else segments.push({ category, chars });
	};
	const add = (category: ContextCategory, text: unknown) => {
		if (typeof text !== "string") return;
		if (category === "user") userTextParts.push(text);
		addChars(category, text.length);
	};
	const category: ContextCategory =
		role === "user"
			? "user"
			: role === "assistant"
				? "assistant"
				: role === "sys" || role === "system"
					? "system"
					: "other";
	if (!Array.isArray(contentJson) || contentJson.length === 0) {
		add(category, contentText);
	} else {
		for (const value of contentJson) {
			if (!value || typeof value !== "object") continue;
			const block = value as Record<string, unknown>;
			switch (block.type) {
				case "tool_use": {
					const toolUseId = typeof block.id === "string" ? block.id : block.toolUseId;
					if (typeof toolUseId === "string")
						segments.push({ category: "toolCall", chars: 0, toolUseId });
					break;
				}
				case "tool_result":
				case "image":
				case "redacted_thinking":
				case "info":
				case "error":
					break;
				case "compact":
					// The active global summary is counted once on the narrator row.
					break;
				case "segment_compact":
					if (block.status !== "compacting" && block.status !== "failed")
						add("summary", block.summary);
					break;
				case "file_reference":
					add("attachment", block.snapshotText);
					break;
				case "text_file": {
					const text = block.text ?? block.content;
					const persistedChars = block.contentChars ?? block.chars;
					if (typeof text === "string") add("attachment", text);
					else if (typeof persistedChars === "number") addChars("attachment", persistedChars);
					// A disk reference/byte size alone does not establish a character count.
					break;
				}
				case "attachment":
				case "document":
					add(
						"attachment",
						block.text ??
							block.content ??
							(block.source as Record<string, unknown> | undefined)?.text,
					);
					break;
				case "thinking":
					add(category, block.thinking ?? block.text);
					break;
				default:
					add(category, block.modelText ?? block.text);
			}
		}
	}
	if (
		role === "user" &&
		typeof contentText === "string" &&
		Array.isArray(contentJson) &&
		contentJson.some((block) => block?.type === "text_file")
	) {
		const body = userTextParts.join("\n");
		// Accepted uploads append their model-facing path hint outside the text blocks.
		// Count only that exact persisted suffix, never the referenced file's old bytes.
		if (contentText.startsWith(body)) addChars("attachment", contentText.length - body.length);
	}
	return { segments };
}

interface PendingCharacterRefresh {
	messages: Set<string>;
	full: boolean;
}
const pendingRefreshes = new Map<string, PendingCharacterRefresh>();
const MAX_PENDING_CHARACTER_ACTORS = 256;
const MAX_PENDING_CHARACTER_MESSAGES = 8192;
let pendingMessages = 0;
let overflowPending = false;
let overflowFlushing = false;
let overflowRetries = 0;
let overflowBlocked = false;
const flushingNarrators = new Map<string, PendingCharacterRefresh>();
const writeObservers = new Set<(narratorId: string, messageId?: string) => void>();
/** Bounded request observers receive IDs only, including writes owned by a shared-message holder. */
export function observeContextCharacterWrites(
	changed: (narratorId: string, messageId?: string) => void,
): () => void {
	writeObservers.add(changed);
	return () => {
		writeObservers.delete(changed);
	};
}
/** References to the bounded notification queue; no history/body reads or copies. */
export function* pendingContextCharacterWrites(): Iterable<{
	narratorId: string;
	messageIds: Iterable<string>;
}> {
	for (const [narratorId, entry] of pendingRefreshes)
		yield { narratorId, messageIds: entry.messages };
	for (const [narratorId, entry] of flushingNarrators)
		yield { narratorId, messageIds: entry.messages };
}
let refreshScheduled = false;
let refreshRunning = false;

/** A pending notification is not a fresh cache, even before its database revision advances. */
export function hasPendingContextCharacterRefresh(narratorId?: string): boolean {
	return (
		overflowPending ||
		overflowFlushing ||
		(narratorId
			? pendingRefreshes.has(narratorId) || flushingNarrators.has(narratorId)
			: pendingRefreshes.size > 0 || flushingNarrators.size > 0)
	);
}

function scheduleContextCharacterRefresh(): void {
	if (
		refreshScheduled ||
		refreshRunning ||
		overflowBlocked ||
		(!overflowPending && pendingRefreshes.size === 0)
	)
		return;
	refreshScheduled = true;
	setTimeout(
		() => {
			refreshScheduled = false;
			refreshRunning = true;
			const ids = [...pendingRefreshes];
			pendingRefreshes.clear();
			pendingMessages = 0;
			const overflow = overflowPending;
			overflowPending = false;
			overflowFlushing = overflow;
			for (const [id, entry] of ids) flushingNarrators.set(id, entry);
			void import("../services/narrator-context-composition")
				.then(async (service) => {
					if (overflow) {
						// Unknown shared holders must also lose freshness; never silently discard IDs.
						await service.invalidateContextCharacterOverflow();
						overflowRetries = 0;
					}
					for (const [id, entry] of ids) {
						try {
							// One epoch per affected holder, not one epoch for every message in the burst.
							if (typeof service.invalidateContextCharacterBatch === "function") {
								await service.invalidateContextCharacterBatch(
									id,
									entry.messages.size ? [...entry.messages] : undefined,
									{ full: entry.full },
								);
							} else {
								// Compatibility with older integrations and isolated module fixtures.
								if (entry.full || !entry.messages.size)
									await service.invalidateContextCharacterCache(id);
								for (const messageId of entry.messages)
									await service.invalidateContextCharacterCache(id, messageId);
							}
						} catch (error) {
							console.warn("Context character refresh failed", id, error);
						} finally {
							flushingNarrators.delete(id);
						}
					}
				})
				.catch((error: unknown) => {
					if (overflow) {
						overflowPending = true;
						overflowRetries++;
						overflowBlocked = overflowRetries >= 3;
					}
					console.warn("Context character refresh failed", error);
				})
				.finally(() => {
					for (const [id] of ids) flushingNarrators.delete(id);
					overflowFlushing = false;
					refreshRunning = false;
					scheduleContextCharacterRefresh();
				});
		},
		overflowRetries ? 200 : 0,
	);
}

/** Coalesce numeric changes before the asynchronous service invalidation; never read a body. */
export function queueContextCharacterRefresh(narratorId: string, messageId?: string): void {
	for (const changed of writeObservers) changed(narratorId, messageId);
	if (overflowBlocked) {
		// A later actual write can retry an unavailable service; no endless hot retry loop.
		overflowBlocked = false;
		overflowRetries = 0;
	}
	if (overflowPending) {
		scheduleContextCharacterRefresh();
		return;
	}
	const known = pendingRefreshes.get(narratorId);
	const newMessage = !!messageId && !known?.messages.has(messageId);
	if (
		(!known && pendingRefreshes.size >= MAX_PENDING_CHARACTER_ACTORS) ||
		(newMessage && pendingMessages >= MAX_PENDING_CHARACTER_MESSAGES)
	) {
		// Fold the burst to a bounded mark sweep. Shared fork holders cannot be dropped.
		pendingRefreshes.clear();
		pendingMessages = 0;
		overflowPending = true;
		scheduleContextCharacterRefresh();
		return;
	}
	const entry = known ?? { messages: new Set<string>(), full: false };
	if (messageId) {
		if (newMessage) pendingMessages++;
		entry.messages.add(messageId);
	} else entry.full = true;
	pendingRefreshes.set(narratorId, entry);
	scheduleContextCharacterRefresh();
}
