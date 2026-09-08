import type {
	PublicLiveBlock,
	PublicSharedMessage,
	PublicSharedTool,
	PublicSharedToolDetail,
} from "@shared/public-narrator-share";
import { PUBLIC_SHARE_LIMITS as L } from "./public-narrator-share-limits";

/** Unknown tools are private by default (including permissions, team and plugins). */
const TOOL_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = {
	Bash: ["command", "description"],
	Read: ["file_path", "offset", "limit", "pages"],
	Write: ["file_path", "content"],
	Edit: ["file_path", "old_string", "new_string", "replace_all"],
	Glob: ["path", "pattern"],
	Grep: ["path", "pattern", "glob", "output_mode", "type", "context"],
	WebSearch: ["query", "q"],
	WebFetch: ["url", "prompt", "purpose"],
	Agent: ["description"],
	Task: ["description"],
};
export function isPublicToolName(name: string): boolean {
	return Object.hasOwn(TOOL_INPUT_KEYS, name);
}

export function publicToolSummary(row: {
	toolUseId: string;
	toolName: string;
	status: string;
}): PublicSharedTool {
	return {
		id: row.toolUseId,
		name: row.toolName,
		status: ["running", "success", "fail"].includes(row.status) ? row.status : "waiting",
	};
}

export function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parse(json: string | null): unknown {
	if (json === null) return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

export interface PublicMessageRow {
	id: string;
	seq: number;
	role: "user" | "assistant";
	createdAt: string;
	json: string | null;
}

/** Input JSON is already SQL-budgeted. No replay, file contexts, or nested metadata. */
export function projectPublicMessage(
	row: PublicMessageRow,
	tools: PublicSharedTool[] = [],
	toolsTruncated = false,
): PublicSharedMessage {
	const blocks = parse(row.json);
	const result: PublicSharedMessage = {
		id: row.id,
		seq: row.seq,
		role: row.role,
		createdAt: row.createdAt,
		text: "",
		reasoning: "",
		tools,
		truncated: toolsTruncated || !Array.isArray(blocks),
		mediaOmitted: false,
	};
	if (!Array.isArray(blocks)) return result;
	let budget: number = L.messageTextChars;
	for (const raw of blocks) {
		const block = record(raw);
		if (!block) continue;
		const kind =
			block.type === "text"
				? "text"
				: block.type === "thinking" || block.type === "reasoning"
					? "reasoning"
					: null;
		if (kind) {
			const value =
				kind === "reasoning" && typeof block.thinking === "string" ? block.thinking : block.text;
			if (typeof value !== "string") continue;
			const prefix = result[kind] ? "\n\n" : "";
			const text = `${prefix}${value}`;
			result[kind] += text.slice(0, budget);
			if (text.length > budget) result.truncated = true;
			budget = Math.max(0, budget - text.length);
		} else if (
			["image", "image_generation", "document", "file", "audio", "video", "attachment"].includes(
				String(block.type),
			)
		) {
			result.mediaOmitted = true;
		}
	}
	return result;
}

/** Only text leaves of the documented tool result envelope; never arbitrary JSON. */
function toolOutputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value
			.map((item) => {
				const block = record(item);
				return block?.type === "text" && typeof block.text === "string" ? block.text : "";
			})
			.filter(Boolean)
			.join("\n");
	const object = record(value);
	if (!object) return "";
	if (typeof object.text === "string") return object.text;
	if (typeof object.output === "string") return object.output;
	if (typeof object.stdout === "string" || typeof object.stderr === "string") {
		return [object.stdout, object.stderr].filter((item) => typeof item === "string").join("\n");
	}
	if (Array.isArray(object.content)) return toolOutputText(object.content);
	if (typeof object.result === "string") return object.result;
	return "";
}

export function projectPublicToolDetail(row: {
	toolUseId: string;
	toolName: string;
	status: string;
	input: string | null;
	output: string | null;
	inputOmitted: boolean;
	outputOmitted: boolean;
}): PublicSharedToolDetail {
	const parsedInput = record(parse(row.input));
	const safeInput: Record<string, unknown> = {};
	if (parsedInput) {
		for (const key of TOOL_INPUT_KEYS[row.toolName] ?? []) {
			const value = parsedInput[key];
			if (["string", "number", "boolean"].includes(typeof value)) safeInput[key] = value;
		}
	}
	const input = Object.keys(safeInput).length ? JSON.stringify(safeInput, null, 2) : "";
	const parsedOutput = parse(row.output);
	const output = toolOutputText(parsedOutput);
	return {
		...publicToolSummary(row),
		input: input.slice(0, L.toolTextChars),
		output: output.slice(0, L.toolTextChars),
		truncated:
			row.inputOmitted ||
			row.outputOmitted ||
			(row.input !== null && parsedInput === null && row.input !== "null") ||
			(row.output !== null && row.output !== "null" && parsedOutput !== "" && output === "") ||
			input.length > L.toolTextChars ||
			output.length > L.toolTextChars,
	};
}

/** IDs are routing labels, not arbitrary metadata or escape-heavy frame payloads. */
export function publicLiveId(value: unknown, fallback: string): string {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : fallback;
}

/** The snapshot API returns live objects; copy only text/reasoning under a shared budget. */
export function projectPublicLiveBlocks(raw: readonly unknown[]): {
	blocks: PublicLiveBlock[];
	truncated: boolean;
} {
	const blocks: PublicLiveBlock[] = [];
	let remaining: number = L.liveTextChars;
	let truncated = raw.length > L.liveScanBlocks;
	for (let i = 0; i < Math.min(raw.length, L.liveScanBlocks); i++) {
		const block = record(raw[i]);
		if (
			!block ||
			(block.type !== "text" && block.type !== "reasoning") ||
			typeof block.text !== "string"
		)
			continue;
		if (blocks.length >= L.liveBlocks || remaining === 0) {
			truncated = true;
			break;
		}
		const text = block.text.slice(0, remaining);
		remaining -= text.length;
		truncated ||= text.length < block.text.length;
		blocks.push({
			id: publicLiveId(block.id, `live-${block.type}-${i}`),
			kind: block.type,
			text,
		});
	}
	return { blocks, truncated };
}
