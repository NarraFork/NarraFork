import { mergeExtraHeaders } from "../user-agent";

export const ANTHROPIC_PUBLIC_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_PUBLIC_VERSION = "2026-10-21";
const LEGACY_VERSION = "2023-06-01";

function defaultVersion(config: { baseUrl?: string; officialApi?: boolean }): string {
	// In NF this switch selects the Claude Code dialect, including on relays. Its
	// bundled SDK is not the public SDK v1. Never infer a gateway's API version.
	if (!config.officialApi) {
		try {
			const url = new URL(config.baseUrl || ANTHROPIC_PUBLIC_BASE_URL);
			const path = url.pathname.replace(/\/+$/, "");
			if (url.origin === "https://api.anthropic.com" && (path === "" || path === "/v1")) {
				return ANTHROPIC_PUBLIC_VERSION;
			}
		} catch {
			// Leave invalid URLs to the existing transport error path.
		}
	}
	return LEGACY_VERSION;
}

/** Finish both Messages and Models headers; a blank override must not erase a real pin. */
export function finishAnthropicHeaders(
	headers: Record<string, string>,
	config: { baseUrl?: string; officialApi?: boolean; extraHeaders?: Record<string, string> },
	uaKey: "user-agent" | "User-Agent",
): Record<string, string> {
	let explicitVersion: string | undefined;
	const other: Record<string, string> = Object.create(null);
	for (const [name, value] of Object.entries(config.extraHeaders ?? {})) {
		if (name.toLowerCase() !== "anthropic-version") other[name] = value;
		else if (value?.trim()) explicitVersion = value.trim();
	}
	mergeExtraHeaders(headers, other, uaKey);
	headers["anthropic-version"] = explicitVersion ?? defaultVersion(config);
	return headers;
}

// Native history can also come from a delegate, not just NF's narrower projection.
interface WireBlock {
	type: string;
	content?: unknown;
	source?: unknown;
	citations?: unknown;
}

function isBlock(value: unknown): value is WireBlock {
	return (
		typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
	);
}

/** Visit only documented content arrays. Never descend into arbitrary tool input or JSON data. */
function mapContent<T extends WireBlock>(block: T, project: (part: WireBlock) => WireBlock): T {
	if (!Array.isArray(block.content)) return block;
	const parts = block.content;
	let copy: unknown[] | undefined;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!isBlock(part)) continue;
		const next = project(part);
		if (next !== part) {
			copy ??= parts.slice();
			copy[i] = next;
		}
	}
	return copy ? { ...block, content: copy } : block;
}

function userText<T extends WireBlock>(block: T): T {
	if (block.type !== "text" || !Array.isArray(block.citations) || !block.citations.length)
		return block;
	const copy = { ...block };
	delete copy.citations;
	return copy;
}

function userContent<T extends WireBlock>(block: T): T {
	if (block.type === "search_result") return mapContent(block, userText);
	if (block.type === "document" && isBlock(block.source) && block.source.type === "content") {
		const source = mapContent(block.source, userText);
		if (source !== block.source) return { ...block, source };
	}
	return userText(block);
}

/** The 2026-10-21 rules apply to the effective wire role, not the stored author. */
export function projectAnthropicPublicBlock<T extends WireBlock>(role: string, block: T): T {
	if (role === "assistant" && block.type === "document") {
		throw new Error(
			`Anthropic ${ANTHROPIC_PUBLIC_VERSION}: a document cannot appear directly in an assistant message. Send it in a user message instead.`,
		);
	}
	if (role !== "user") return block;
	return block.type === "tool_result" ? mapContent(block, userContent) : userContent(block);
}
