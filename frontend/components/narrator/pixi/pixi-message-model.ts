import { collectSegmentTargetIds, segmentMessages } from "../message-segments";
import type { MessagesPage, NarratorMsg } from "../narrator-panel-types";

export type PixiMessageItemKind = "message" | "tool-run" | "divider" | "action";

export interface PixiMessageBlockModel {
	type: string;
	text: string;
	label?: string;
	color?: "gray" | "green" | "yellow" | "red" | "blue" | "teal" | "indigo";
}

export interface PixiMessageItem {
	key: string;
	kind: PixiMessageItemKind;
	targetIds: string[];
	role?: string;
	title: string;
	subtitle?: string;
	blocks: PixiMessageBlockModel[];
	createdAt?: string | null;
	tokenUsage?: string | null;
}

export interface BuildPixiMessageItemsOptions {
	pages: MessagesPage[];
	pageParams?: unknown[];
	orderedMessages: NarratorMsg[];
	narratorId: string;
	streamingMsg?: NarratorMsg | null;
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	showManualLoadOlder?: boolean;
	showConclusionButton?: boolean;
	showTokenUsage?: boolean;
}

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageNumberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPromptTokenFootprint(turnUsageJson: NarratorMsg["turnUsageJson"]): number | null {
	const tu = turnUsageJson as Record<string, unknown> | null | undefined;
	if (!tu) return null;
	const promptTokens = usageNumberOrNull(tu.prompt_tokens);
	if (promptTokens != null) return promptTokens;
	const inputTokens = usageNumberOrNull(tu.input_tokens);
	if (inputTokens == null) return null;
	return (
		inputTokens + usageNumber(tu.cached_input_tokens) + usageNumber(tu.cache_creation_input_tokens)
	);
}

function formatTurnUsage(msg: NarratorMsg): string | null {
	const tu = msg.turnUsageJson as Record<string, unknown> | null | undefined;
	if (!tu) {
		if (typeof msg.meterUsage === "number") return `${msg.meterUsage.toFixed(2)} credits`;
		return null;
	}
	const inputTokens = usageNumber(tu.input_tokens);
	const outputTokens = usageNumber(tu.output_tokens);
	const promptTokens = getPromptTokenFootprint(msg.turnUsageJson) ?? inputTokens;
	const parts = [
		`Σ ${promptTokens.toLocaleString()} ctx`,
		`${inputTokens.toLocaleString()} in`,
		`${outputTokens.toLocaleString()} out`,
	];
	const cachedTokens = usageNumber(tu.cached_input_tokens);
	const reasoningTokens = usageNumber(tu.reasoning_tokens);
	if (cachedTokens > 0) parts.push(`${cachedTokens.toLocaleString()} cache hit`);
	if (reasoningTokens > 0) parts.push(`${reasoningTokens.toLocaleString()} reasoning`);
	if (typeof msg.costUsd === "number" && msg.costUsd > 0) parts.push(`$${msg.costUsd.toFixed(4)}`);
	return parts.join(" · ");
}

function safeJsonSummary(value: unknown, max = 360): string {
	if (value == null) return "";
	if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
	try {
		const text = JSON.stringify(value, null, 2);
		return text.length > max ? `${text.slice(0, max)}…` : text;
	} catch {
		return String(value);
	}
}

function displayTime(iso?: string | null): string | undefined {
	if (!iso) return undefined;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return undefined;
	return d.toLocaleString([], {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function blockText(block: Record<string, unknown>): string {
	if (typeof block.text === "string") return block.text;
	if (typeof block.message === "string") return block.message;
	if (typeof block.summary === "string") return block.summary;
	if (typeof block.error === "string") return block.error;
	if (typeof block.objective === "string") return block.objective;
	if (typeof block.query === "string") return block.query;
	if (Array.isArray(block.queries)) return block.queries.join("\n");
	return safeJsonSummary(block, 500);
}

function specialLabel(type: string): string {
	switch (type) {
		case "reasoning":
		case "thinking":
			return "Reasoning";
		case "web_search":
			return "Web search";
		case "image_generation":
			return "Image generation";
		case "compact":
			return "Compact";
		case "segment_compact":
			return "Segment compact";
		case "merge_summary":
			return "Merge summary";
		case "review_feedback":
			return "Review feedback";
		case "ask_in_passing":
			return "Ask in passing";
		case "goal_continuation":
			return "Goal";
		case "bash_command":
			return "Bash";
		case "tool_loaded":
			return "Tool loaded";
		case "text_file":
			return "Text file";
		case "image":
			return "Image";
		case "error":
			return "Error";
		case "info":
			return "Info";
		default:
			return type.replaceAll("_", " ");
	}
}

function colorForBlock(type: string): PixiMessageBlockModel["color"] {
	if (type === "error") return "red";
	if (type === "compact" || type === "segment_compact" || type === "goal_continuation")
		return "teal";
	if (type === "merge_summary") return "indigo";
	if (type === "review_feedback") return "green";
	if (type === "web_search") return "blue";
	if (type === "reasoning" || type === "thinking") return "yellow";
	return "gray";
}

function messageBlocks(msg: NarratorMsg, visibleBlockIndices?: number[]): PixiMessageBlockModel[] {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const chosen = visibleBlockIndices
		? visibleBlockIndices.map((i) => blocks[i]).filter(Boolean)
		: blocks;
	const result: PixiMessageBlockModel[] = [];
	for (const raw of chosen) {
		const block = raw as Record<string, unknown>;
		const type = String(block.type ?? "unknown");
		if (type === "text") {
			const text = typeof block.text === "string" ? block.text : "";
			if (text.trim()) result.push({ type, text });
			continue;
		}
		if (type === "image") {
			result.push({
				type,
				label: "Image",
				text: String(block.filename ?? block.mediaType ?? "Attached image"),
				color: "blue",
			});
			continue;
		}
		if (type === "text_file") {
			const size = typeof block.size === "number" ? ` · ${block.size.toLocaleString()} bytes` : "";
			result.push({
				type,
				label: "Text file",
				text: `${String(block.filename ?? "file")}${size}`,
				color: "gray",
			});
			continue;
		}
		if (type === "bash_command") {
			result.push({ type, label: "Bash", text: `$ ${String(block.command ?? "")}`, color: "gray" });
			continue;
		}
		const text = blockText(block);
		if (text.trim() || type !== "unknown") {
			result.push({ type, label: specialLabel(type), text, color: colorForBlock(type) });
		}
	}
	if (result.length === 0 && msg.contentText) result.push({ type: "text", text: msg.contentText });
	return result;
}

function titleForMessage(msg: NarratorMsg): string {
	if (msg.role === "user") return msg.creator?.username ?? "You";
	if (msg.role === "assistant") return "Narrator";
	if (msg.role === "system" || msg.role === "sys" || msg.role === "disp") return "System";
	return msg.role ?? "Message";
}

function messageItem(
	msg: NarratorMsg,
	key: string,
	visibleBlockIndices: number[] | undefined,
	showTokenUsage: boolean | undefined,
): PixiMessageItem {
	return {
		key,
		kind: "message",
		targetIds: msg.id ? [msg.id] : [],
		role: msg.role,
		title: titleForMessage(msg),
		subtitle: displayTime(msg.createdAt),
		blocks: messageBlocks(msg, visibleBlockIndices),
		createdAt: msg.createdAt,
		tokenUsage: showTokenUsage && msg.role === "assistant" ? formatTurnUsage(msg) : null,
	};
}

export function buildPixiMessageItems(opts: BuildPixiMessageItemsOptions): PixiMessageItem[] {
	const items: PixiMessageItem[] = [];
	if (opts.showManualLoadOlder) {
		items.push({
			key: "__load-older-btn__",
			kind: "action",
			targetIds: [],
			title: "Load older messages",
			blocks: [{ type: "action", text: "Load older messages" }],
		});
	}

	const segments = segmentMessages(opts.orderedMessages, {
		pruneBoundaryMessageId: opts.pruneBoundaryMessageId,
		pruneDividerLabel: opts.pruneDividerLabel,
		streamingMsg: opts.streamingMsg,
	});
	const used = new Map<string, number>();
	const uniqueKey = (base: string) => {
		const count = used.get(base) ?? 0;
		used.set(base, count + 1);
		return count === 0 ? base : `${base}#${count}`;
	};

	for (const seg of segments) {
		if (seg.kind === "prune-divider") {
			items.push({
				key: uniqueKey("prune-boundary"),
				kind: "divider",
				targetIds: [],
				title: seg.label ?? "Pruned",
				blocks: [],
			});
			continue;
		}
		if (seg.kind === "message") {
			const key = uniqueKey(seg.visibleBlockIndices ? `${seg.msg.id}-leading` : seg.msg.id);
			items.push(messageItem(seg.msg, key, seg.visibleBlockIndices, opts.showTokenUsage));
			continue;
		}
		const first = seg.sourceMessages[0];
		const title =
			seg.items.length === 1
				? `Tool · ${seg.items[0].tc.toolName}`
				: `Tool run · ${seg.items.length} tools`;
		items.push({
			key: uniqueKey(`tool-run-${first?.id ?? items.length}`),
			kind: "tool-run",
			targetIds: collectSegmentTargetIds(seg),
			role: "assistant",
			title,
			blocks: seg.items.map((item) => {
				const status = item.tc.status ?? "running";
				const duration = item.tc.durationMs != null ? ` · ${Math.round(item.tc.durationMs)}ms` : "";
				const childInfo =
					item.children.length > 0 ? ` · ${item.children.length} child message(s)` : "";
				const error = item.tc.errorMessage ? `\n${item.tc.errorMessage}` : "";
				const output = item.tc.outputJson ? `\n${safeJsonSummary(item.tc.outputJson, 220)}` : "";
				return {
					type: "tool_use",
					label: item.isSubagent ? "Agent" : item.tc.toolName,
					text: `${status}${duration}${childInfo}${error}${output}`,
					color: status === "error" ? "red" : status === "completed" ? "green" : "yellow",
				};
			}),
		});
	}
	if (opts.showConclusionButton) {
		items.push({
			key: "__update-conclusion-btn__",
			kind: "action",
			targetIds: [],
			title: "Update conclusion",
			blocks: [{ type: "action", text: "Update conclusion" }],
		});
	}
	return items;
}
