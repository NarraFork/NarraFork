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

const pendingRefreshes = new Map<string, Set<string>>();
let refreshScheduled = false;

/** Defer database imports and merge bursts. A failed notification cannot fail a committed write. */
export function queueContextCharacterRefresh(narratorId: string, messageId?: string): void {
	const messages = pendingRefreshes.get(narratorId) ?? new Set<string>();
	if (messageId) messages.add(messageId);
	pendingRefreshes.set(narratorId, messages);
	if (refreshScheduled) return;
	refreshScheduled = true;
	setTimeout(() => {
		refreshScheduled = false;
		const ids = [...pendingRefreshes];
		pendingRefreshes.clear();
		void import("../services/narrator-context-composition")
			.then(async ({ invalidateContextCharacterCache }) => {
				for (const [id, messages] of ids) {
					try {
						if (!messages.size) await invalidateContextCharacterCache(id);
						else
							for (const messageId of messages)
								await invalidateContextCharacterCache(id, messageId);
					} catch (error) {
						console.warn("Context character refresh failed", id, error);
					}
				}
			})
			.catch((error: unknown) => console.warn("Context character refresh failed", error));
	}, 0);
}
