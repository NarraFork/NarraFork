import { formatDurationText } from "@frontend/lib/format";
import i18n from "@frontend/lib/i18n";
import { getShikiLang } from "@frontend/lib/shiki-lang";
import { collectSegmentTargetIds, segmentMessages, type ToolRunItem } from "../message-segments";
import type { MessagesPage, NarratorMsg, PendingPermission } from "../narrator-panel-types";
import {
	basename,
	extractField,
	getCategory,
	getCategoryColor,
	getFilePath,
	getSummary,
	resolveDisplayText,
	type ToolCategory,
	type ToolDisplayColor,
} from "../tool-display";

export type PixiMessageItemKind = "message" | "tool-run" | "divider" | "action";

export interface PixiToolDetailLineModel {
	label?: string;
	text: string;
	kind?: "code" | "text" | "error" | "muted";
}

export interface PixiToolBadgeModel {
	text: string;
	color?: ToolDisplayColor;
	variant?: "light" | "outline" | "dot";
}

export type PixiPermissionAction = "allow" | "deny" | "allow_compact";

export interface PixiPermissionActionModel {
	action: PixiPermissionAction;
	label: string;
	color: ToolDisplayColor;
	variant?: "filled" | "light";
}

export type PixiToolDetailBlockModel =
	| { kind: "badge-row"; badges: PixiToolBadgeModel[] }
	| { kind: "section-title"; text: string }
	| { kind: "text-line"; text: string; color?: ToolDisplayColor; muted?: boolean; mono?: boolean }
	| {
			kind: "permission-panel";
			permissionId: string;
			toolName: string;
			decisionReason?: string;
			summary?: string;
			planPreview?: string;
			actions: PixiPermissionActionModel[];
	  }
	| {
			kind: "code-panel" | "terminal-panel";
			text: string;
			maxLines?: number;
			lang?: string;
	  }
	| {
			kind: "diff-panel";
			oldText: string;
			newText: string;
			maxLines?: number;
			lang?: string;
			startLine?: number;
			lineNumberPrefix?: string;
	  }
	| { kind: "todo-row"; text: string; status?: string }
	| {
			kind: "result-card";
			title?: string;
			subtitle?: string;
			text?: string;
			color?: ToolDisplayColor;
			badges?: PixiToolBadgeModel[];
	  }
	| { kind: "share-card"; filename: string; badges: PixiToolBadgeModel[]; note?: string };

export interface PixiMessageBlockModel {
	type: string;
	text: string;
	label?: string;
	color?: ToolDisplayColor;
	messageId?: string;
	messageUuid?: string | null;
	blockIndex?: number;
	copyText?: string;
	imageSrc?: string;
	imageId?: string;
	imageUploadNarratorId?: string;
	imageFilename?: string;
	imageMediaType?: string;
	imageSavedPath?: string;
	imageAlt?: string;
	imageStatus?: string;
	toolName?: string;
	toolKey?: string;
	toolCallId?: string;
	toolUseId?: string;
	pendingPermissionId?: string;
	pendingPermissionToolName?: string;
	pendingPermissionReason?: string;
	toolCategory?: ToolCategory;
	toolSummary?: string;
	toolStatus?: string;
	toolDuration?: string;
	toolStatusColor?: ToolDisplayColor;
	toolCategoryColor?: ToolDisplayColor;
	toolDetailLines?: PixiToolDetailLineModel[];
	toolDetailBlocks?: PixiToolDetailBlockModel[];
	toolChildCount?: number;
	toolIsSubagent?: boolean;
	toolSubagentType?: string;
	toolSubagentModel?: string;
	toolSubagentDescription?: string;
	toolInRun?: boolean;
	toolIsLast?: boolean;
	toolDefaultOpen?: boolean;
	toolExpanded?: boolean;
	reasoningKey?: string;
	reasoningExpanded?: boolean;
	reasoningToggleKey?: string;
	reasoningCharCount?: number;
	reasoningEncrypted?: boolean;
	reasoningStreaming?: boolean;
	reasoningLabel?: string;
	reasoningCharsLabel?: string;
	reasoningThinkingLabel?: string;
}

export interface PixiMessageCreatorModel {
	id: string;
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

export interface PixiMessageItem {
	key: string;
	kind: PixiMessageItemKind;
	targetIds: string[];
	role?: string;
	title: string;
	subtitle?: string;
	creator?: PixiMessageCreatorModel | null;
	messageId?: string;
	messageUuid?: string | null;
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
	expandReasoning?: boolean;
	resolvePermission?: (toolCall: {
		id?: string;
		toolName: string;
		toolUseId?: string;
		inputJson: unknown;
		status?: string;
		permissionDecisionReason?: string | null;
		permissionSuggestions?: unknown[] | null;
	}) => PendingPermission | null;
	resolveToolExpanded?: (tool: {
		toolKey: string;
		defaultOpen: boolean;
		pendingPermission?: PendingPermission | null;
		toolCallId?: string;
		toolUseId?: string;
		toolName: string;
		status?: string;
		isSubagent: boolean;
	}) => boolean | undefined;
	resolveReasoningExpanded?: (reasoning: {
		reasoningKey: string;
		reasoningAliasKeys?: string[];
		reasoningSlotKey: string;
		defaultExpanded: boolean;
		messageId?: string;
		blockIndex: number;
		type: string;
	}) => boolean | undefined;
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
	const now = new Date();
	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	return isToday
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleString([], {
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

function webSearchAction(block: Record<string, unknown>): Record<string, unknown> | null {
	const action = block.action;
	return typeof action === "object" && action && !Array.isArray(action)
		? (action as Record<string, unknown>)
		: null;
}

function webSearchSubject(block: Record<string, unknown>): string {
	const action = webSearchAction(block);
	const query =
		typeof block.query === "string"
			? block.query
			: typeof action?.query === "string"
				? action.query
				: undefined;
	if (query) return query;

	const queries = Array.isArray(block.queries)
		? block.queries
		: Array.isArray(action?.queries)
			? action.queries
			: undefined;
	if (queries?.length) return queries.map(String).join(", ");

	const url = typeof action?.url === "string" ? action.url : undefined;
	const pattern = typeof action?.pattern === "string" ? action.pattern : undefined;
	if (action?.type === "open_page" && url) return url;
	if (action?.type === "find_in_page")
		return [pattern ? `'${pattern}'` : null, url].filter(Boolean).join(" in ");
	return "";
}

function webSearchDisplayText(block: Record<string, unknown>): string {
	const action = webSearchAction(block);
	const subject = webSearchSubject(block);
	if (action?.type === "open_page" && subject) return `Opened ${subject}`;
	if (action?.type === "find_in_page" && subject) return `Find ${subject}`;

	const status = typeof block.status === "string" ? block.status : "completed";
	if (status === "searching") {
		const prefix = tNarrator("webSearching", "Searching the web…");
		return subject ? `${prefix} ${subject}` : prefix;
	}
	if (status && status !== "completed") {
		const prefix = tNarrator("webSearchPreparing", "Preparing web search…");
		return subject ? `${prefix} ${subject}` : prefix;
	}

	const prefix = tNarrator("webSearched", "Searched the web:");
	return subject ? `${prefix} ${subject}` : prefix;
}

function tNarrator(key: string, fallback: string, options?: Record<string, unknown>): string {
	const value = i18n.t(key, { ns: "narrator", ...options });
	return typeof value === "string" && value !== key ? value : fallback;
}

function tCommon(key: string, fallback: string, options?: Record<string, unknown>): string {
	const value = i18n.t(key, { ns: "common", ...options });
	return typeof value === "string" && value !== key ? value : fallback;
}

function hasEncryptedReasoningMetadata(block: Record<string, unknown>): boolean {
	const providerMetadata = block.providerMetadata;
	if (!providerMetadata || typeof providerMetadata !== "object") return false;
	return Object.values(providerMetadata as Record<string, unknown>).some((metadata) => {
		if (!metadata || typeof metadata !== "object") return false;
		const encrypted = (metadata as Record<string, unknown>).reasoningEncryptedContent;
		return typeof encrypted === "string" && encrypted.length > 0;
	});
}

function reasoningDisplayText(block: Record<string, unknown>): string {
	const rawText =
		typeof block.text === "string"
			? block.text
			: typeof block.thinking === "string"
				? block.thinking
				: "";
	const translatedText =
		typeof block.translatedText === "string" ? block.translatedText : undefined;
	if (translatedText) return translatedText;
	if (rawText) return rawText;
	return hasEncryptedReasoningMetadata(block)
		? tNarrator("reasoningEncryptedPlaceholder", "Reasoning content is encrypted")
		: "";
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
		case "tool_unloaded":
			return "Tool unloaded";
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
	if (type === "reasoning" || type === "thinking") return "grape";
	return "gray";
}

function reasoningBlockIdentity(block: Record<string, unknown>, index: number): string {
	const outputIndex = block.outputIndex;
	if (typeof outputIndex === "number" && Number.isFinite(outputIndex)) {
		return `output:${outputIndex}`;
	}
	const id = block.id;
	if (typeof id === "string" && id.trim()) return `id:${id}`;
	return `index:${index}`;
}

function streamingReasoningKey(narratorId: string, identity: string): string {
	return `${narratorId}:__streaming__:reasoning:${identity}`;
}

function persistedReasoningKey(
	narratorId: string,
	msg: NarratorMsg,
	identity: string,
	index: number,
): string {
	const messagePart = msg.messageUuid ?? msg.id ?? `index:${index}`;
	return `${narratorId}:message:${messagePart}:reasoning:${identity}`;
}

function reasoningSlotKey(narratorId: string, index: number): string {
	return `${narratorId}:${index}`;
}

function streamingReasoningAliases(
	narratorId: string,
	block: Record<string, unknown>,
	index: number,
): string[] {
	const aliases = new Set<string>();
	const id = block.id;
	if (typeof id === "string" && id.trim())
		aliases.add(streamingReasoningKey(narratorId, `id:${id}`));
	const outputIndex = block.outputIndex;
	if (typeof outputIndex === "number" && Number.isFinite(outputIndex)) {
		aliases.add(streamingReasoningKey(narratorId, `output:${outputIndex}`));
		aliases.add(streamingReasoningKey(narratorId, `id:streaming:reasoning:${outputIndex}`));
	}
	aliases.add(streamingReasoningKey(narratorId, `index:${index}`));
	return [...aliases];
}

function messageBlocks(
	msg: NarratorMsg,
	narratorId: string,
	visibleBlockIndices?: number[],
	expandReasoning?: boolean,
	resolveReasoningExpanded?: BuildPixiMessageItemsOptions["resolveReasoningExpanded"],
): PixiMessageBlockModel[] {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const chosen = visibleBlockIndices
		? visibleBlockIndices.map((i) => ({ raw: blocks[i], index: i })).filter((entry) => entry.raw)
		: blocks.map((raw, index) => ({ raw, index }));
	const result: PixiMessageBlockModel[] = [];
	const isStreaming = msg.id === "__streaming__";
	for (const { raw, index } of chosen) {
		const block = raw as Record<string, unknown>;
		const type = String(block.type ?? "unknown");
		if (type === "text") {
			const text = typeof block.text === "string" ? block.text : "";
			if (text.trim()) {
				result.push({
					type,
					text,
					messageId: msg.id,
					messageUuid: msg.messageUuid,
					blockIndex: index,
					copyText: text,
				});
			}
			continue;
		}
		if (type === "image") {
			result.push({
				type,
				label: "Image",
				text: String(block.filename ?? block.mediaType ?? "Attached image"),
				color: "blue",
				imageSrc: typeof block.previewUrl === "string" ? block.previewUrl : undefined,
				imageId: typeof block.imageId === "string" ? block.imageId : undefined,
				imageUploadNarratorId:
					typeof block.uploadNarratorId === "string" ? block.uploadNarratorId : msg.narratorId,
				imageFilename: typeof block.filename === "string" ? block.filename : undefined,
				imageMediaType: typeof block.mediaType === "string" ? block.mediaType : undefined,
				imageAlt: typeof block.filename === "string" ? block.filename : "image",
			});
			continue;
		}
		if (type === "image_generation") {
			const revisedPrompt =
				typeof block.revisedPrompt === "string" ? block.revisedPrompt : undefined;
			const status = typeof block.status === "string" ? block.status : undefined;
			const savedPath = typeof block.savedPath === "string" ? block.savedPath : undefined;
			const resultBase64 = typeof block.result === "string" ? block.result : undefined;
			result.push({
				type,
				label: "Image generation",
				text: revisedPrompt ?? status ?? "Generated image",
				color: "grape",
				imageSrc: resultBase64,
				imageSavedPath: savedPath,
				imageAlt: revisedPrompt ?? "Generated image",
				imageStatus: status,
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
		if (type === "reasoning" || type === "thinking") {
			const text = reasoningDisplayText(block);
			const isEncrypted = hasEncryptedReasoningMetadata(block) && !block.text && !block.thinking;
			if (!text && !isStreaming) continue;
			const formatted = text.length.toLocaleString();
			const identity = reasoningBlockIdentity(block, index);
			const reasoningKey = isStreaming
				? streamingReasoningKey(narratorId, identity)
				: persistedReasoningKey(narratorId, msg, identity, index);
			const reasoningAliasKeys = isStreaming
				? undefined
				: streamingReasoningAliases(narratorId, block, index).filter((key) => key !== reasoningKey);
			const slotKey = reasoningSlotKey(narratorId, index);
			const defaultExpanded = expandReasoning === true && !!text;
			const reasoningExpanded =
				resolveReasoningExpanded?.({
					reasoningKey,
					reasoningAliasKeys,
					reasoningSlotKey: slotKey,
					defaultExpanded,
					messageId: msg.id,
					blockIndex: index,
					type,
				}) ?? defaultExpanded;
			result.push({
				type,
				label: tNarrator("reasoning", "Reasoning"),
				text,
				color: "grape",
				messageId: msg.id,
				messageUuid: msg.messageUuid,
				blockIndex: index,
				copyText: text,
				reasoningKey,
				reasoningExpanded: reasoningExpanded && !!text,
				reasoningCharCount: text.length,
				reasoningEncrypted: isEncrypted,
				reasoningStreaming: isStreaming,
				reasoningLabel: tNarrator("reasoning", "Reasoning"),
				reasoningCharsLabel: tNarrator("reasoningChars", `${formatted} chars`, { formatted }),
				reasoningThinkingLabel: tNarrator("thinking", "Thinking"),
			});
			continue;
		}
		if (type === "web_search") {
			result.push({
				type,
				label: specialLabel(type),
				text: webSearchDisplayText(block),
				color: "blue",
			});
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

function truncateLine(text: string, max = 180): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function firstLines(text: string, maxLines = 3, maxChars = 240): PixiToolDetailLineModel[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(0, maxLines)
		.map((line) => ({ text: truncateLine(line, maxChars), kind: "code" as const }));
}

function objectValue(input: unknown, key: string): unknown {
	return typeof input === "object" && input && !Array.isArray(input)
		? (input as Record<string, unknown>)[key]
		: undefined;
}

function statusColor(status: string): ToolDisplayColor {
	if (status === "completed" || status === "success") return "green";
	if (status === "fail" || status === "failed" || status === "error") return "red";
	if (status === "cancelled") return "gray";
	if (status === "running" || status === "initializing" || status === "pending") return "yellow";
	return "blue";
}

function isToolOutputEnvelope(value: unknown): boolean {
	const record = asRecord(value);
	return !!(
		record &&
		(typeof record._text === "string" ||
			typeof record._metadata === "object" ||
			record._truncated === true)
	);
}

function extractJsonObjectAt(text: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function parseEmbeddedToolOutputEnvelope(text: string): unknown {
	const trimmed = text.trim();
	const candidates = [trimmed, ...trimmed.split(/\r?\n/).map((line) => line.trim())];
	for (const candidate of candidates) {
		const start = candidate.search(/\{\s*"_(text|metadata|truncated)"/);
		if (start < 0) continue;
		const jsonText = extractJsonObjectAt(candidate, start);
		if (!jsonText) continue;
		try {
			const parsed = JSON.parse(jsonText);
			if (isToolOutputEnvelope(parsed)) return parsed;
		} catch {
			// Try the next physical line/candidate.
		}
	}
	return text;
}

function parsePossiblyStringifiedJson(value: unknown, onlyEnvelope = false): unknown {
	let current = value;
	for (let i = 0; i < 3; i++) {
		if (typeof current !== "string") break;
		const trimmed = current.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) {
			break;
		}
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") {
				current = parsed;
				continue;
			}
			if (onlyEnvelope && !isToolOutputEnvelope(parsed)) break;
			current = parsed;
		} catch {
			break;
		}
	}
	return onlyEnvelope && typeof current === "string"
		? parseEmbeddedToolOutputEnvelope(current)
		: current;
}

function pixiResolveDisplayText(value: unknown): string {
	const truncatedText = extractField(value, "_text");
	if (truncatedText) return truncatedText;
	return resolveDisplayText(parsePossiblyStringifiedJson(value, true));
}

function relativeSearchPath(filePath: string, searchPath: string): string {
	const normalizedPath = filePath.replace(/\\/g, "/");
	const normalizedSearchPath = searchPath.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalizedSearchPath) return normalizedPath;
	if (normalizedPath === normalizedSearchPath) return basename(normalizedPath);
	const prefix = `${normalizedSearchPath}/`;
	return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

function formatPixiGrepOutput(output: string, searchPath: string): string {
	return output
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => {
			if (!line || line === "--") return line;
			const match = line.match(/^(.*?)([:-])(\d+)([:-])(.*)$/);
			if (!match) return line;
			const [, filePath, firstSep, lineNo, secondSep, content] = match;
			return `${relativeSearchPath(filePath, searchPath)}${firstSep}${lineNo}${secondSep}${content}`;
		})
		.join("\n");
}

function addOutputLines(lines: PixiToolDetailLineModel[], outputJson: unknown): void {
	const output = pixiResolveDisplayText(outputJson);
	if (!output.trim()) return;
	lines.push(...firstLines(output, Math.max(1, 4 - lines.length)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isEditTool(toolName: string): boolean {
	return toolName === "Edit" || toolName === "Write";
}

function hasTruncatedToolData(inputJson: unknown, outputJson: unknown): boolean {
	return asRecord(inputJson)?._truncated === true || asRecord(outputJson)?._truncated === true;
}

function isStreamingToolInput(inputJson: unknown): boolean {
	return asRecord(inputJson)?._streamingChars != null;
}

function metadataFrom(
	outputJson: unknown,
	metadata?: Record<string, unknown>,
): Record<string, unknown> {
	const normalizedOutput = parsePossiblyStringifiedJson(outputJson, true);
	return (
		(asRecord(normalizedOutput)?._metadata as Record<string, unknown> | undefined) ?? metadata ?? {}
	);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
	const normalized = parsePossiblyStringifiedJson(value);
	const record = asRecord(normalized);
	if (record) return record;
	const raw = pixiResolveDisplayText(normalized).trim();
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return asRecord(parsed);
	} catch {
		return null;
	}
}

function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
	const normalized = parsePossiblyStringifiedJson(value);
	if (Array.isArray(normalized)) {
		return normalized.filter((v): v is Record<string, unknown> => Boolean(asRecord(v)));
	}
	const normalizedRecord = asRecord(normalized);
	if (Array.isArray(normalizedRecord?.results)) {
		return normalizedRecord.results.filter((v: unknown): v is Record<string, unknown> =>
			Boolean(asRecord(v)),
		);
	}
	const raw = pixiResolveDisplayText(normalized).trim();
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed))
			return parsed.filter((v): v is Record<string, unknown> => Boolean(asRecord(v)));
		if (Array.isArray(parsed?.results)) {
			return parsed.results.filter((v: unknown): v is Record<string, unknown> =>
				Boolean(asRecord(v)),
			);
		}
	} catch {
		// ignore non-JSON output
	}
	return [];
}

function outputPanel(
	blocks: PixiToolDetailBlockModel[],
	outputJson: unknown,
	kind: "code-panel" | "terminal-panel" = "code-panel",
	_title = "Output",
	maxLines = 8,
): void {
	const output = pixiResolveDisplayText(outputJson);
	if (!output.trim()) return;
	blocks.push({
		kind,
		text: output,
		maxLines,
	});
}

function inputPanel(
	blocks: PixiToolDetailBlockModel[],
	inputJson: unknown,
	_title = "Input",
	maxLines = 8,
): void {
	const input = pixiResolveDisplayText(inputJson);
	if (!input.trim()) return;
	blocks.push({ kind: "code-panel", text: input, maxLines, lang: "json" });
}

function parseTaskOutputXml(raw: string): Record<string, string> {
	const result: Record<string, string> = {};
	const tagRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
	let match = tagRegex.exec(raw);
	while (match !== null) {
		result[match[1]] = match[2].trim();
		match = tagRegex.exec(raw);
	}
	if (!result.output) {
		const outputMatch = raw.match(/<output>([\s\S]*)$/);
		if (outputMatch) result.output = outputMatch[1].trim();
	}
	return result;
}

function coerceQuestionSummary(
	value: unknown,
): Array<{ header: string; question: string; answer?: string }> {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 4).map((question, index) => {
		const record = asRecord(question) ?? {};
		const header = String(record.header ?? `Question ${index + 1}`);
		return {
			header,
			question: String(record.question ?? ""),
			answer: undefined,
		};
	});
}

function badge(
	text: string,
	color: ToolDisplayColor = "gray",
	variant: "light" | "outline" | "dot" = "light",
) {
	return { text, color, variant } satisfies PixiToolBadgeModel;
}

function metadataLine(
	blocks: PixiToolDetailBlockModel[],
	parts: Array<string | null | undefined>,
): void {
	const text = parts.filter((part): part is string => Boolean(part)).join(" · ");
	if (text) blocks.push({ kind: "text-line", text, muted: true });
}

function permissionPanel(
	permission: PendingPermission,
	toolName: string,
	summary: string,
): PixiToolDetailBlockModel {
	const isExitPlan = toolName === "ExitPlanMode";
	const planPreview =
		isExitPlan && typeof permission.inputJson?.plan === "string"
			? permission.inputJson.plan
			: undefined;
	const actions: PixiPermissionActionModel[] =
		permission.toolName === "AskUserQuestion"
			? []
			: isExitPlan
				? [
						{
							action: "allow",
							label: tNarrator("planExecute", "Execute"),
							color: "green",
						},
						{
							action: "allow_compact",
							label: tNarrator("acceptAndResetContext", "Accept and reset context"),
							color: "teal",
							variant: "light",
						},
						{
							action: "deny",
							label: tNarrator("planRevise", "Revise"),
							color: "red",
							variant: "light",
						},
					]
				: [
						{ action: "allow", label: tCommon("allow", "Allow"), color: "green" },
						{
							action: "deny",
							label: tCommon("deny", "Deny"),
							color: "red",
							variant: "light",
						},
					];
	return {
		kind: "permission-panel",
		permissionId: permission.id,
		toolName,
		decisionReason: permission.decisionReason,
		summary,
		planPreview,
		actions,
	};
}

function getStreamingFileInput(
	inputJson: unknown,
): { filePath: string; fieldName: string; value: string } | null {
	const input = asRecord(inputJson);
	if (!input) return null;
	const fields = asRecord(input._streamingFields);
	const filePath =
		(typeof input._streamingFilePath === "string" ? input._streamingFilePath : undefined) ??
		(typeof fields?.file_path === "string" ? fields.file_path : undefined) ??
		getFilePath(inputJson);
	const fieldName =
		typeof input._streamingFieldName === "string" ? input._streamingFieldName : undefined;
	const value =
		typeof input._streamingFieldValue === "string" ? input._streamingFieldValue : undefined;
	if (!filePath || !fieldName || !value) return null;
	if (fieldName !== "content" && fieldName !== "new_string") return null;
	return { filePath, fieldName, value };
}

function getStreamingEditInput(
	inputJson: unknown,
	metadata?: Record<string, unknown>,
): {
	filePath: string;
	phase: "matching" | "replacing";
	oldString: string;
	newString: string;
	startLine?: number;
} | null {
	const input = asRecord(inputJson);
	if (!input || input._streamingChars == null) return null;
	const fields = asRecord(input._streamingFields) ?? {};
	const fieldName = typeof input._streamingFieldName === "string" ? input._streamingFieldName : "";
	const fieldValue =
		typeof input._streamingFieldValue === "string" ? input._streamingFieldValue : "";
	const filePath =
		(typeof input._streamingFilePath === "string" ? input._streamingFilePath : undefined) ??
		(typeof fields.file_path === "string" ? fields.file_path : undefined) ??
		getFilePath(inputJson);
	const oldString =
		(typeof fields.old_string === "string" ? fields.old_string : "") ||
		(fieldName === "old_string" ? fieldValue : "");
	const newString =
		(typeof fields.new_string === "string" ? fields.new_string : "") ||
		(fieldName === "new_string" ? fieldValue : "");
	const streamingMetadata = asRecord(input._streamingMetadata);
	const startLine =
		typeof metadata?.startLine === "number"
			? metadata.startLine
			: typeof streamingMetadata?.startLine === "number"
				? streamingMetadata.startLine
				: undefined;
	const phase = fieldName === "new_string" || newString ? "replacing" : "matching";
	return { filePath: filePath || "Edit", phase, oldString, newString, startLine };
}

function buildToolDetailBlocks(
	toolName: string,
	inputJson: unknown,
	outputJson: unknown,
	metadata?: Record<string, unknown>,
	errorMessage?: string,
): PixiToolDetailBlockModel[] {
	const category = getCategory(toolName);
	const blocks: PixiToolDetailBlockModel[] = [];
	const streamingFile = category === "file" ? getStreamingFileInput(inputJson) : null;
	const filePath = streamingFile?.filePath ?? getFilePath(inputJson);
	const meta = metadataFrom(outputJson, metadata);
	const output = pixiResolveDisplayText(outputJson);
	switch (category) {
		case "bash": {
			const command = extractField(inputJson, "command");
			if (command)
				blocks.push({
					kind: "terminal-panel",
					text: `$ ${command}`,
					maxLines: 3,
				});
			outputPanel(blocks, outputJson, "terminal-panel", "Output");
			break;
		}
		case "read": {
			if (filePath) blocks.push({ kind: "text-line", text: filePath, muted: true, mono: true });
			if (meta.isImage === true) {
				const info = [meta.sizeKB != null ? `${meta.sizeKB} KB` : null, meta.imageFormat]
					.filter(Boolean)
					.join(" · ");
				blocks.push({
					kind: "result-card",
					title: filePath ? filePath.split("/").pop() : "Image",
					subtitle: info || "image preview",
					text: "Image preview is available in the React renderer.",
					color: "teal",
				});
			} else if (output.trim()) {
				blocks.push({
					kind: "code-panel",
					text: output,
					maxLines: 8,
					lang: filePath ? getShikiLang(filePath) : "text",
				});
			}
			break;
		}
		case "file": {
			const streamingEdit = toolName === "Edit" ? getStreamingEditInput(inputJson, metadata) : null;
			if (filePath) blocks.push({ kind: "text-line", text: filePath, muted: true, mono: true });
			if (streamingEdit) {
				metadataLine(blocks, [`streaming ${streamingEdit.phase}`]);
				blocks.push({
					kind: "diff-panel",
					oldText: streamingEdit.oldString || " ",
					newText:
						streamingEdit.phase === "replacing"
							? streamingEdit.newString
							: streamingEdit.oldString || " ",
					maxLines: 8,
					lang: streamingEdit.filePath ? getShikiLang(streamingEdit.filePath) : "diff",
					startLine: streamingEdit.startLine,
					lineNumberPrefix:
						streamingEdit.phase === "matching" && streamingEdit.startLine == null
							? "xx"
							: undefined,
				});
			} else if (streamingFile) {
				metadataLine(blocks, ["streaming"]);
				blocks.push({
					kind: "code-panel",
					text: streamingFile.value,
					maxLines: 10,
					lang: filePath ? getShikiLang(filePath) : "text",
				});
			} else if (toolName === "Edit") {
				const oldString = extractField(inputJson, "old_string");
				const newString = extractField(inputJson, "new_string");
				const startLine = typeof meta.startLine === "number" ? meta.startLine : undefined;
				if (oldString || newString) {
					blocks.push({
						kind: "diff-panel",
						oldText: oldString,
						newText: newString,
						maxLines: 8,
						lang: filePath ? getShikiLang(filePath) : "diff",
						startLine,
					});
				} else if (Object.keys(asRecord(inputJson) ?? {}).length > 0) {
					blocks.push({
						kind: "code-panel",
						text: pixiResolveDisplayText(inputJson),
						maxLines: 8,
						lang: "json",
					});
				}
			} else if (toolName === "Write") {
				const content = extractField(inputJson, "content");
				if (content)
					blocks.push({
						kind: "code-panel",
						text: content,
						maxLines: 8,
						lang: filePath ? getShikiLang(filePath) : "text",
					});
			}
			outputPanel(blocks, outputJson, "code-panel", "Output");
			break;
		}
		case "search": {
			const pattern = extractField(inputJson, "pattern", "glob");
			const path = extractField(inputJson, "path");
			if (pattern) blocks.push({ kind: "text-line", text: pattern, muted: true, mono: true });
			if (path) blocks.push({ kind: "text-line", text: `in ${path}`, muted: true, mono: true });
			if (output.trim()) {
				const isGrep = toolName === "Grep";
				blocks.push({
					kind: "code-panel",
					text: isGrep ? formatPixiGrepOutput(output, path) : output,
					maxLines: 12,
					lang: isGrep ? "grep-output" : "text",
				});
			}
			break;
		}
		case "webSearch": {
			const query = extractField(inputJson, "query");
			if (query) blocks.push({ kind: "text-line", text: query, muted: true, mono: true });
			const results = parseJsonArray(outputJson).slice(0, 5);
			if (results.length > 0) {
				for (const r of results) {
					blocks.push({
						kind: "result-card",
						title: String(r.title ?? r.url ?? "Result"),
						subtitle: String(r.domain ?? r.url ?? ""),
						text: String(r.snippet ?? ""),
						color: "indigo",
					});
				}
			} else outputPanel(blocks, outputJson, "code-panel", "Output");
			break;
		}
		case "webFetch":
		case "browser": {
			const url = extractField(inputJson, "url");
			const mode = extractField(inputJson, "mode", "action");
			const selector = extractField(inputJson, "selector");
			metadataLine(blocks, [
				mode,
				extractField(inputJson, "session_id")
					? `session ${String(extractField(inputJson, "session_id")).slice(0, 8)}`
					: null,
			]);
			if (url) blocks.push({ kind: "text-line", text: url, color: "teal", mono: true });
			if (selector) blocks.push({ kind: "text-line", text: `selector: ${selector}`, muted: true });
			if (mode === "screenshot" || mode === "dom") {
				blocks.push({
					kind: "result-card",
					title: mode === "dom" ? "DOM" : "Screenshot",
					subtitle: url,
					text: output || "Preview available in React renderer.",
					color: "teal",
				});
			} else outputPanel(blocks, outputJson, "code-panel", "Output");
			break;
		}
		case "terminal": {
			const action = extractField(inputJson, "action");
			const terminalId = extractField(inputJson, "terminal_id");
			if (terminalId)
				blocks.push({
					kind: "text-line",
					text: `Terminal: ${terminalId}`,
					muted: true,
					mono: true,
				});
			const input = extractField(inputJson, "input");
			if (action === "write" && input)
				blocks.push({ kind: "terminal-panel", text: input, maxLines: 3 });
			outputPanel(
				blocks,
				outputJson,
				action === "read" ? "terminal-panel" : "code-panel",
				action === "read" ? "Terminal Buffer" : "Output",
			);
			break;
		}
		case "share": {
			const filename = String(meta.filename ?? "file");
			const badges = [
				meta.sizeFormatted ? badge(String(meta.sizeFormatted), "gray") : null,
				meta.isDirectory
					? badge("directory", "blue")
					: meta.format === "zip"
						? badge("zip", "violet")
						: null,
			].filter(Boolean) as PixiToolBadgeModel[];
			if (meta.downloadUrl)
				blocks.push({ kind: "share-card", filename, badges, note: String(meta.downloadUrl) });
			else outputPanel(blocks, outputJson, "code-panel", "Output");
			break;
		}
		case "todo": {
			const todos = objectValue(inputJson, "todos") ?? objectValue(outputJson, "todos");
			if (Array.isArray(todos)) {
				for (const todo of todos.slice(0, 8)) {
					const record = asRecord(todo) ?? {};
					blocks.push({
						kind: "todo-row",
						text: String(record.content ?? "—"),
						status: String(record.status ?? "pending"),
					});
				}
				if (todos.length > 8)
					blocks.push({ kind: "text-line", text: `+ ${todos.length - 8} more…`, muted: true });
			}
			break;
		}
		case "goal": {
			const payload = parseJsonRecord(outputJson);
			const goals = Array.isArray(payload?.goals) ? payload.goals : [];
			const objective =
				extractField(inputJson, "objective") ||
				String(asRecord(payload?.active)?.objective ?? asRecord(payload?.added)?.objective ?? "");
			if (objective)
				blocks.push({
					kind: "result-card",
					title: "Goal",
					subtitle: String(
						asRecord(payload?.active)?.status ?? asRecord(payload?.added)?.status ?? "",
					),
					text: objective,
					color: "teal",
				});
			for (const goal of goals.slice(0, 6)) {
				const g = asRecord(goal) ?? {};
				blocks.push({
					kind: "result-card",
					title: String(g.status ?? "goal"),
					text: String(g.objective ?? "—"),
					color: "gray",
				});
			}
			break;
		}
		case "await": {
			const awaitType = extractField(inputJson, "type") || String(meta.awaitType ?? "task");
			const target = extractField(inputJson, "id") || String(meta.targetId ?? "");
			metadataLine(blocks, [awaitType, target, String(meta.status ?? "result")]);
			const wait = extractField(inputJson, "wait_for_text") || String(meta.waitForText ?? "");
			if (wait) blocks.push({ kind: "text-line", text: `Waiting for text: ${wait}`, muted: true });
			outputPanel(
				blocks,
				outputJson,
				awaitType === "bash" ? "terminal-panel" : "code-panel",
				awaitType === "bash" ? "Output" : "Result",
			);
			break;
		}
		case "send": {
			const targets = [extractField(inputJson, "id"), extractField(inputJson, "name")].filter(
				Boolean,
			);
			metadataLine(blocks, [
				targets[0] ? `to ${targets[0]}` : "subagent message",
				objectValue(inputJson, "await") ? "await" : "async",
				objectValue(inputJson, "doInterrupt") ? "interrupt" : null,
			]);
			const message = extractField(inputJson, "message");
			if (message) {
				blocks.push({ kind: "code-panel", text: message, maxLines: 6 });
			}
			outputPanel(
				blocks,
				outputJson,
				"code-panel",
				objectValue(inputJson, "await") ? "Reply" : "Result",
			);
			break;
		}
		case "skill": {
			const name =
				extractField(inputJson, "skill", "name") ||
				output.match(/<skill_content\s+name="([^"]+)">/)?.[1];
			if (name)
				blocks.push({
					kind: "badge-row",
					badges: [badge(name, "grape")],
				});
			const contentStart = output.indexOf("\n\n");
			const contentEnd = output.indexOf("\nBase directory for this skill:");
			const skillContent =
				contentStart >= 0 && contentEnd > contentStart
					? output
							.slice(contentStart + 2, contentEnd)
							.replace(/^#\s+Skill:\s+.+\n*/, "")
							.trim()
					: output;
			if (skillContent.trim()) {
				blocks.push({
					kind: "code-panel",
					text: skillContent,
					maxLines: 10,
				});
			}
			const files = [...output.matchAll(/<file>([^<]+)<\/file>/g)].map((m) => m[1]);
			if (files.length) {
				metadataLine(blocks, [
					`files ${files
						.slice(0, 4)
						.map((file) => file.split("/").pop() || file)
						.join(", ")}${files.length > 4 ? ` +${files.length - 4}` : ""}`,
				]);
			}
			break;
		}
		case "recall": {
			const action = String(meta.action ?? "");
			if (Array.isArray(meta.queries))
				metadataLine(blocks, [`queries ${meta.queries.slice(0, 3).map(String).join(", ")}`]);
			const results = Array.isArray(meta.results) ? meta.results : [];
			for (const result of results.slice(0, 5)) {
				const r = asRecord(result) ?? {};
				blocks.push({
					kind: "result-card",
					title: String(r.narratorTitle ?? r.role ?? action),
					subtitle: String(r.createdAt ?? ""),
					text: String(r.snippet ?? "")
						.replace(/>>>|<<</g, "")
						.trim(),
					color: r.role === "user" ? "blue" : "green",
				});
			}
			if (results.length === 0) outputPanel(blocks, outputJson, "code-panel", "Output");
			break;
		}
		case "taskOutput": {
			const taskId = extractField(inputJson, "task_id");
			const parsed = parseTaskOutputXml(output);
			metadataLine(blocks, [taskId, parsed.status, parsed.task_type]);
			if (parsed.retrieval_status && parsed.retrieval_status !== "success") {
				blocks.push({
					kind: "text-line",
					text: `retrieval: ${parsed.retrieval_status}`,
					color: "red",
				});
			}
			if (parsed.output)
				blocks.push({
					kind: "code-panel",
					text: parsed.output,
					maxLines: 10,
				});
			else outputPanel(blocks, outputJson, "code-panel", "Output");
			break;
		}
		case "agent": {
			const type = extractField(inputJson, "subagent_type");
			const description = extractField(inputJson, "description");
			const model = extractField(inputJson, "model");
			const prompt = extractField(inputJson, "prompt");
			metadataLine(blocks, [type, model ? `model ${model}` : null]);
			if (description)
				blocks.push({ kind: "result-card", title: "Task", text: description, color: "indigo" });
			if (prompt) blocks.push({ kind: "code-panel", text: prompt, maxLines: 8 });
			outputPanel(blocks, outputJson, "code-panel", "Result");
			break;
		}
		case "plan": {
			const plan = extractField(inputJson, "plan");
			const denied = String(meta.permissionDenyMessage ?? "");
			if (denied) blocks.push({ kind: "text-line", text: denied, color: "yellow" });
			if (plan) blocks.push({ kind: "code-panel", text: plan, maxLines: 14 });
			else outputPanel(blocks, outputJson, "code-panel", "Output");
			break;
		}
		case "ask": {
			const summaries = coerceQuestionSummary(objectValue(inputJson, "questions"));
			const answers = asRecord(objectValue(inputJson, "answers")) ?? {};
			for (const question of summaries) {
				blocks.push({
					kind: "result-card",
					title: question.header,
					subtitle: String(answers[question.header] ?? ""),
					text: question.question,
					color: "blue",
				});
			}
			if (summaries.length === 0) inputPanel(blocks, inputJson, "Questions", 8);
			break;
		}
		default:
			inputPanel(blocks, inputJson, `${toolName} Input`, 6);
			outputPanel(blocks, outputJson, "code-panel", `${toolName} Output`, 8);
	}
	if (errorMessage) blocks.unshift({ kind: "text-line", text: errorMessage, color: "red" });
	return blocks.slice(0, 14);
}

function buildToolDetailLines(
	toolName: string,
	inputJson: unknown,
	outputJson: unknown,
): PixiToolDetailLineModel[] {
	const category = getCategory(toolName);
	const lines: PixiToolDetailLineModel[] = [];
	const filePath = getFilePath(inputJson);
	switch (category) {
		case "bash": {
			const command = extractField(inputJson, "command");
			if (command) lines.push({ label: "cmd", text: command, kind: "code" });
			addOutputLines(lines, outputJson);
			break;
		}
		case "read":
		case "file": {
			if (filePath) lines.push({ label: "file", text: filePath, kind: "muted" });
			if (toolName === "Edit") {
				const streamingEdit = getStreamingEditInput(inputJson, metadataFrom(outputJson));
				if (streamingEdit) {
					lines.push({ label: "phase", text: streamingEdit.phase, kind: "muted" });
					if (streamingEdit.oldString)
						lines.push({
							label: "match",
							text: truncateLine(streamingEdit.oldString, 120),
							kind: "code",
						});
					if (streamingEdit.newString)
						lines.push({
							label: "replace",
							text: truncateLine(streamingEdit.newString, 120),
							kind: "code",
						});
				} else {
					const oldString = extractField(inputJson, "old_string");
					const newString = extractField(inputJson, "new_string");
					if (oldString)
						lines.push({ label: "old", text: truncateLine(oldString, 120), kind: "code" });
					if (newString)
						lines.push({ label: "new", text: truncateLine(newString, 120), kind: "code" });
				}
			} else if (toolName === "Write") {
				const content = extractField(inputJson, "content");
				if (content)
					lines.push({
						label: "content",
						text: `${content.length.toLocaleString()} chars`,
						kind: "muted",
					});
			}
			addOutputLines(lines, outputJson);
			break;
		}
		case "search": {
			const pattern = extractField(inputJson, "pattern", "glob");
			const path = extractField(inputJson, "path");
			if (pattern) lines.push({ label: "pattern", text: pattern, kind: "code" });
			if (path) lines.push({ label: "path", text: path, kind: "muted" });
			addOutputLines(lines, outputJson);
			break;
		}
		case "webSearch":
		case "webFetch":
		case "browser": {
			const query = extractField(inputJson, "query");
			const url = extractField(inputJson, "url");
			const mode = extractField(inputJson, "mode", "action");
			if (query) lines.push({ label: "query", text: query, kind: "text" });
			if (url) lines.push({ label: "url", text: url, kind: "muted" });
			if (mode) lines.push({ label: "mode", text: mode, kind: "muted" });
			addOutputLines(lines, outputJson);
			break;
		}
		case "agent": {
			const type = extractField(inputJson, "subagent_type");
			const desc = extractField(inputJson, "description");
			const model = extractField(inputJson, "model");
			if (type) lines.push({ label: "type", text: type, kind: "muted" });
			if (desc) lines.push({ label: "task", text: desc, kind: "text" });
			if (model) lines.push({ label: "model", text: model, kind: "muted" });
			addOutputLines(lines, outputJson);
			break;
		}
		case "todo": {
			const todos = objectValue(inputJson, "todos");
			if (Array.isArray(todos)) lines.push({ text: `${todos.length} todo item(s)`, kind: "muted" });
			break;
		}
		case "goal": {
			const objective = extractField(inputJson, "objective");
			if (objective) lines.push({ label: "goal", text: objective, kind: "text" });
			addOutputLines(lines, outputJson);
			break;
		}
		case "await":
		case "send":
		case "ask":
		case "terminal":
		case "share":
		case "skill":
		case "recall": {
			const summary = getSummary(toolName, inputJson);
			if (summary) lines.push({ text: summary, kind: "text" });
			addOutputLines(lines, outputJson);
			break;
		}
		default:
			addOutputLines(lines, outputJson);
	}
	return lines.slice(0, 5);
}

function buildToolUseBlock(
	item: ToolRunItem,
	inRun: boolean,
	isLast: boolean,
	isSoleInRun: boolean,
	resolvePermission?: BuildPixiMessageItemsOptions["resolvePermission"],
	resolveToolExpanded?: BuildPixiMessageItemsOptions["resolveToolExpanded"],
): PixiMessageBlockModel {
	const status = item.tc.status ?? "running";
	const category = getCategory(item.tc.toolName);
	const pendingPermission = resolvePermission?.({
		id: item.tc.id,
		toolName: item.tc.toolName,
		toolUseId: item.tc.toolUseId,
		inputJson: item.tc.inputJson,
		status: item.tc.status,
		permissionDecisionReason: item.tc.permissionDecisionReason,
		permissionSuggestions: item.tc.permissionSuggestions,
	});
	const isStreaming = isStreamingToolInput(item.tc.inputJson);
	const isFailed = item.tc.status === "fail";
	const isDeniedPlan = isFailed && item.tc.toolName === "ExitPlanMode";
	const isTruncated = hasTruncatedToolData(item.tc.inputJson, item.tc.outputJson);
	const isEdit = isEditTool(item.tc.toolName);
	const subagentDefaultOpen = isSoleInRun;
	const toolDefaultOpen = item.isSubagent
		? subagentDefaultOpen
		: !isStreaming &&
			(!!pendingPermission ||
				item.tc.status === "pending" ||
				category === "todo" ||
				category === "share" ||
				category === "recall" ||
				category === "send" ||
				(category === "await" && (item.tc.outputJson != null || item.tc.startedAt != null)) ||
				(category === "bash" && (item.tc.outputJson != null || item.tc.startedAt != null)) ||
				(category === "plan" && !isDeniedPlan) ||
				(isEdit && !isTruncated) ||
				(isFailed && !isEdit && !isDeniedPlan && !isTruncated));
	const toolKey =
		item.tc.toolUseId ?? item.tc.id ?? `${item.msg.id || "message"}:tool:${item.blockIndex}`;
	const toolExpanded =
		resolveToolExpanded?.({
			toolKey,
			defaultOpen: toolDefaultOpen,
			pendingPermission,
			toolCallId: item.tc.id,
			toolUseId: item.tc.toolUseId,
			toolName: item.tc.toolName,
			status: item.tc.status,
			isSubagent: item.isSubagent,
		}) ?? toolDefaultOpen;
	const detailBlocks = buildToolDetailBlocks(
		item.tc.toolName,
		item.tc.inputJson,
		item.tc.outputJson,
		item.tc._metadata,
		item.tc.errorMessage,
	);
	const detailLines = buildToolDetailLines(item.tc.toolName, item.tc.inputJson, item.tc.outputJson);
	if (item.tc.errorMessage) {
		detailLines.unshift({ text: item.tc.errorMessage, kind: "error" });
	}
	if (item.children.length > 0) {
		detailLines.push({ text: `${item.children.length} child message(s)`, kind: "muted" });
		detailBlocks.push({
			text: `${item.children.length} child message(s)`,
			kind: "text-line",
			muted: true,
		});
	}
	const summary = getSummary(item.tc.toolName, item.tc.inputJson, item.tc._metadata);
	if (pendingPermission) {
		detailBlocks.push(permissionPanel(pendingPermission, item.tc.toolName, summary || status));
	}
	// Extract subagent-specific fields
	const subagentType = item.isSubagent
		? extractField(item.tc.inputJson, "subagent_type") || "agent"
		: undefined;
	const subagentModel = item.isSubagent
		? extractField(item.tc.inputJson, "model") || undefined
		: undefined;
	const subagentDescription = item.isSubagent
		? extractField(item.tc.inputJson, "description") ||
			extractField(item.tc.inputJson, "prompt")?.slice(0, 100) ||
			undefined
		: undefined;
	return {
		type: "tool_use",
		label: item.isSubagent ? "Agent" : item.tc.toolName,
		text: summary || status,
		color: pendingPermission ? "yellow" : statusColor(status),
		messageId: item.msg.id,
		messageUuid: item.msg.messageUuid,
		blockIndex: item.blockIndex,
		copyText: [item.tc.toolName, summary, ...detailLines.map((line) => line.text)]
			.filter(Boolean)
			.join("\n"),
		toolName: item.tc.toolName,
		toolCallId: item.tc.id,
		toolUseId: item.tc.toolUseId,
		pendingPermissionId: pendingPermission?.id,
		pendingPermissionToolName: pendingPermission?.toolName,
		pendingPermissionReason: pendingPermission?.decisionReason,
		toolCategory: item.isSubagent ? "agent" : category,
		toolSummary: summary,
		toolStatus: status,
		toolDuration:
			item.tc.durationMs != null
				? formatDurationText(item.tc.durationMs, { style: "precise" })
				: undefined,
		toolStatusColor: statusColor(status),
		toolCategoryColor: getCategoryColor(item.isSubagent ? "agent" : category),
		toolDetailLines: detailLines,
		toolDetailBlocks: detailBlocks,
		toolChildCount: item.children.length,
		toolIsSubagent: item.isSubagent,
		toolSubagentType: subagentType,
		toolSubagentModel: subagentModel,
		toolSubagentDescription: subagentDescription,
		toolInRun: inRun,
		toolIsLast: isLast,
		toolKey,
		toolExpanded,
		toolDefaultOpen,
	};
}

function messageItem(
	msg: NarratorMsg,
	key: string,
	narratorId: string,
	visibleBlockIndices: number[] | undefined,
	showTokenUsage: boolean | undefined,
	expandReasoning: boolean | undefined,
	resolveReasoningExpanded?: BuildPixiMessageItemsOptions["resolveReasoningExpanded"],
): PixiMessageItem {
	return {
		key,
		kind: "message",
		targetIds: msg.id ? [msg.id] : [],
		role: msg.role,
		title: titleForMessage(msg),
		subtitle: displayTime(msg.createdAt),
		creator: msg.creator ?? null,
		messageId: msg.id,
		messageUuid: msg.messageUuid,
		blocks: messageBlocks(
			msg,
			narratorId,
			visibleBlockIndices,
			expandReasoning,
			resolveReasoningExpanded,
		),
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
		nativeWebSearchAsTool: true,
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
			items.push(
				messageItem(
					seg.msg,
					key,
					opts.narratorId,
					seg.visibleBlockIndices,
					opts.showTokenUsage,
					opts.expandReasoning,
					opts.resolveReasoningExpanded,
				),
			);
			continue;
		}
		const first = seg.sourceMessages[0];
		const inRun = seg.items.length >= 2;
		const subagentCount = seg.items.filter((item) => item.isSubagent).length;
		items.push({
			key: uniqueKey(`tool-run-${first?.id ?? items.length}`),
			kind: "tool-run",
			targetIds: collectSegmentTargetIds(seg),
			role: "assistant",
			title: "",
			blocks: seg.items.map((item, index) =>
				buildToolUseBlock(
					item,
					inRun,
					index === seg.items.length - 1,
					item.isSubagent && subagentCount === 1,
					opts.resolvePermission,
					opts.resolveToolExpanded,
				),
			),
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
