import type { PendingPermission } from "@frontend/types/narrator";
import {
	Badge,
	Box,
	Button,
	Code,
	Divider,
	Group,
	List,
	Menu,
	Modal,
	NumberInput,
	Paper,
	Popover,
	Stack,
	Text,
	Textarea,
	ThemeIcon,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useClipboard, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowBackUp,
	IconBan,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconClock,
	IconCode,
	IconCopy,
	IconDownload,
	IconEye,
	IconFileCode,
	IconFilter,
	IconGitFork,
	IconHistory,
	IconInfoCircle,
	IconListCheck,
	IconLoader2,
	IconMap,
	IconMessageQuestion,
	IconPencil,
	IconPlayerPlay,
	IconPlayerStop,
	IconRobot,
	IconSearch,
	IconShare,
	IconShield,
	IconTargetArrow,
	IconTerminal2,
	IconTrash,
	IconUsers,
	IconWand,
	IconWorldSearch,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import {
	type CSSProperties,
	createContext,
	lazy,
	memo,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useInterruptNarrator, useToolCallDetail } from "../../hooks/useNarrator";
import {
	useFileSystemCapability,
	useNarratorPermissionsCapability,
	usePlatform,
	useShareCapability,
} from "../../hooks/usePlatform";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { ApiError, api, getToken, readFetchError, type SideCarRecord } from "../../lib/api";
import { formatDurationText } from "../../lib/format";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { getShikiLang } from "../../lib/shiki-lang";
import { Z } from "../../lib/z-index";
import { AskUserQuestionBanner, coerceQuestions } from "./AskUserQuestionBanner";
import { AutoFollowScroll } from "./AutoFollowScroll";
import { CompactMenuSub } from "./CompactMenuSub";
import { ContentViewer } from "./ContentViewer";
import { DiffView } from "./DiffView";
import { LazyCollapse } from "./LazyCollapse";
import { useMessageContextMenu } from "./MessageContextMenuCtx";
import {
	BLOCK_ID_ATTR,
	MESSAGE_SELECTION_IGNORE_ATTR,
	NestedBlockCtx,
	shouldIgnoreMessageBlockSelection,
	useMessageSelection,
} from "./MessageSelectionCtx";
import {
	getPermissionReflectionSuggestion,
	type ReflectionSuggestion,
} from "./narrator-message-helpers";
import { useRenderLod } from "./RenderLodCtx";
import { SideCarNotice } from "./SideCarNotice";
import { ToolCallInspector } from "./ToolCallInspector";
import { useNearestScrollContainerHeight } from "./useNearestScrollContainerHeight";

const LazyStreamingCode = lazy(() =>
	import("./StreamingCode").then((module) => ({ default: module.StreamingCode })),
);

interface StreamingCodeLazyProps {
	code: string;
	lang?: string;
	style?: CSSProperties;
}

const streamingCodeFallbackRootStyle: CSSProperties = {
	borderRadius: "var(--mantine-radius-sm)",
	backgroundColor: "var(--mantine-color-body)",
	border: "1px solid var(--mantine-color-default-border)",
	overflow: "hidden",
};

const streamingCodeFallbackPreStyle: CSSProperties = {
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	overflowWrap: "break-word",
	fontFamily:
		"var(--mantine-font-family-monospace), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
	fontSize: "inherit",
	lineHeight: 1.55,
	margin: 0,
	padding: "var(--mantine-spacing-xs)",
	tabSize: 4,
	background: "transparent",
};

const streamingCodeFallbackCodeStyle: CSSProperties = {
	fontFamily: "inherit",
	fontSize: "inherit",
	background: "none",
};

const STREAMING_CODE_FALLBACK_DISPLAY_MAX_CHARS = 80_000;

function StreamingCodeFallback({ code, style }: Pick<StreamingCodeLazyProps, "code" | "style">) {
	const isDisplayTruncated = code.length > STREAMING_CODE_FALLBACK_DISPLAY_MAX_CHARS;
	const displayCode = isDisplayTruncated
		? code.slice(-STREAMING_CODE_FALLBACK_DISPLAY_MAX_CHARS)
		: code;

	return (
		<AutoFollowScroll asChild deps={[displayCode]}>
			<div style={{ ...streamingCodeFallbackRootStyle, ...style }}>
				<pre style={streamingCodeFallbackPreStyle}>
					<code style={streamingCodeFallbackCodeStyle}>
						{isDisplayTruncated ? `…\n${displayCode}` : displayCode}
					</code>
				</pre>
			</div>
		</AutoFollowScroll>
	);
}

function StreamingCodeLazy({ code, lang, style }: StreamingCodeLazyProps) {
	return (
		<Suspense fallback={<StreamingCodeFallback code={code} style={style} />}>
			<LazyStreamingCode code={code} lang={lang} style={style} />
		</Suspense>
	);
}

/**
 * Context carrying the toolUseId of the narrator's latest TaskCreate call
 * and whether the narrator is currently thinking.
 * TodoDetail uses this to decide whether in_progress items should animate —
 * spinning only makes sense while the narrator is actively working.
 */
export const LatestTodosToolUseIdCtx = createContext<{
	toolUseId: string | null;
	isThinking: boolean;
}>({ toolUseId: null, isThinking: false });

/** Context for opening the file modifications drawer from within tool call cards */
export const FileModDrawerCtx = createContext<{
	openForApproval: () => void;
}>({ openForApproval: () => {} });

const noop = () => {};

/**
 * Context for keyboard-driven permission button navigation.
 * `focusIndex` is the 0-based index of the currently focused button (null = inactive).
 * `setFocusIndex` lets the parent shift focus via arrow keys.
 *
 * `setButtonCount` lets the child report how many navigable buttons it has.
 * `setHasFeedback` lets the child report whether feedback text is present.
 * `registerActions` lets the child register onClick handlers so the parent can invoke them.
 */
export const PermEnterHintCtx = createContext<{
	focusIndex: number | null;
	setFocusIndex: (i: number | null) => void;
	setButtonCount: (n: number) => void;
	setHasFeedback: (has: boolean) => void;
	registerActions: (actions: (() => void)[]) => void;
	/** The permission ID that Enter key should bind to (earliest pending). */
	activePermissionId: string | null;
}>({
	focusIndex: null,
	setFocusIndex: () => {},
	setButtonCount: () => {},
	setHasFeedback: () => {},
	registerActions: () => {},
	activePermissionId: null,
});

// --- Types ---

export interface ToolCallData {
	id?: string;
	toolName: string;
	toolUseId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	inputJson: any;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	outputJson?: any;
	status: string;
	durationMs?: number;
	streamStartedAt?: string | null;
	permissionStartedAt?: string | null;
	executionStartedAt?: string | null;
	completedAt?: string | null;
	errorMessage?: string;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
	/** Who decided this permission. `narrator:<id>` marks a proxy approval by a controlling named narrator. */
	permissionDecidedBy?: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	permissionSuggestions?: any[] | null;
	/** Timestamp (Date.now()) when the tool started running — used for live elapsed timer */
	startedAt?: number;
	/** Optional metadata from the tool (e.g. line numbers for Edit) */
	_metadata?: Record<string, unknown>;
	/** Set by watchdog when process has been running ≥60s — shows terminate button */
	_longRunning?: boolean;
	/** Real-time streaming output from bash tool (updated via WS tool_output events) */
	_streamingOutput?: string;
	/** Frontend promoted a complete streaming output into outputJson on completion */
	_streamedFullOutput?: boolean;
	/** Resolved model name for subagent tool calls (set via WS subagent_started event) */
	_resolvedModel?: string;
	/** Current timeout in ms (set from inputJson.timeout or updated via WS timeout_updated) */
	_timeoutMs?: number;
	/** Sidecar system injections attached to this tool result */
	sideCars?: SideCarRecord[];
	/** Subagent assistant message ID that produced the result (for scroll-to navigation) */
	resultMessageId?: string;
}

export type { PendingPermission } from "@frontend/types/narrator";

interface ToolCallCardProps {
	toolCall: ToolCallData;
	/** Narrator ID for lazy-loading truncated tool call data */
	narratorId?: string;
	/** When true, card is inside a tool_run wrapper — no own border/radius */
	inRun?: boolean;
	/** When true, this is the last item in a run — no bottom divider */
	isLast?: boolean;
	/** Pending permission request matching this tool call */
	pendingPermission?: PendingPermission | null;
	/** Callback when user makes a permission decision */
	onPermissionDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	/** Callback when user submits answers to AskUserQuestion */
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	/** Callback when user asks reflection to answer AskUserQuestion */
	onQuestionReflect?: (requestId: string) => Promise<void> | void;
	/** Callback when user skips/denies AskUserQuestion */
	onQuestionDeny?: (requestId: string) => void;
	/** Force expand this card from outside (e.g. when navigating to it) */
	forceExpand?: boolean;
	/** Block index within the parent message's contentJson array */
	blockIndex?: number;
}

// --- Constants ---

export const TOOL_CARD_BG = "color-mix(in srgb, var(--mantine-color-body) 50%, transparent)";

import { TOOL_CALL_STATUS_COLORS as STATUS_COLORS } from "@frontend/lib/status-registry";

export { STATUS_COLORS };

const READ_TOOLS = new Set(["Read"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
const EDIT_TOOLS = new Set(["Edit", "Write"]);
const BASH_TOOLS = new Set(["Bash", "Shell", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch"]);
const WEB_FETCH_TOOLS = new Set(["WebFetch"]);
const TODO_TOOLS = new Set(["TaskCreate"]);
const GOAL_TOOLS = new Set(["GetGoals", "AddGoal", "UpdateGoal"]);
const TASK_OUTPUT_TOOLS = new Set(["TaskOutput"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const AWAIT_TOOLS = new Set(["Await"]);
const SEND_TOOLS = new Set(["Send"]);
const ASK_TOOLS = new Set(["AskUserQuestion"]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
const PIPELINE_TOOLS = new Set(["StartPipeline", "EndPipeline"]);
const TERMINAL_TOOLS = new Set(["Terminal"]);
const SHARE_TOOLS = new Set(["ShareFile"]);
const RECALL_TOOLS = new Set(["Recall"]);
const SKILL_TOOLS = new Set(["Skill"]);
const BROWSER_TOOLS = new Set(["Browser"]);

export type ToolCategory =
	| "read"
	| "file"
	| "bash"
	| "search"
	| "webSearch"
	| "webFetch"
	| "todo"
	| "goal"
	| "taskOutput"
	| "agent"
	| "await"
	| "send"
	| "ask"
	| "plan"
	| "pipeline"
	| "terminal"
	| "share"
	| "recall"
	| "skill"
	| "browser"
	| "generic";

export function isEditTool(name: string): boolean {
	return EDIT_TOOLS.has(name);
}

export function getCategory(name: string): ToolCategory {
	if (READ_TOOLS.has(name)) return "read";
	if (FILE_TOOLS.has(name)) return "file";
	if (BASH_TOOLS.has(name)) return "bash";
	if (SEARCH_TOOLS.has(name)) return "search";
	if (WEB_SEARCH_TOOLS.has(name)) return "webSearch";
	if (WEB_FETCH_TOOLS.has(name)) return "webFetch";
	if (TODO_TOOLS.has(name)) return "todo";
	if (GOAL_TOOLS.has(name)) return "goal";
	if (TASK_OUTPUT_TOOLS.has(name)) return "taskOutput";
	if (AGENT_TOOLS.has(name)) return "agent";
	if (AWAIT_TOOLS.has(name)) return "await";
	if (SEND_TOOLS.has(name)) return "send";
	if (ASK_TOOLS.has(name)) return "ask";
	if (PLAN_TOOLS.has(name)) return "plan";
	if (PIPELINE_TOOLS.has(name)) return "pipeline";
	if (TERMINAL_TOOLS.has(name)) return "terminal";
	if (SHARE_TOOLS.has(name)) return "share";
	if (RECALL_TOOLS.has(name)) return "recall";
	if (SKILL_TOOLS.has(name)) return "skill";
	if (BROWSER_TOOLS.has(name)) return "browser";
	return "generic";
}

export function getCategoryIcon(cat: ToolCategory, _toolName?: string) {
	switch (cat) {
		case "read":
			return IconEye;
		case "file":
			return IconPencil;
		case "bash":
			return IconTerminal2;
		case "search":
			return IconSearch;
		case "webSearch":
			return IconWorldSearch;
		case "webFetch":
			return IconWorldWww;
		case "todo":
			return IconListCheck;
		case "goal":
			return IconTargetArrow;
		case "taskOutput":
			return IconRobot;
		case "agent":
			return IconGitFork;
		case "await":
			return IconClock;
		case "send":
			return IconMessageQuestion;
		case "ask":
			return IconPlayerPlay;
		case "plan":
			return IconMap;
		case "pipeline":
			return IconFilter;
		case "terminal":
			return IconTerminal2;
		case "share":
			return IconShare;
		case "recall":
			return IconHistory;
		case "skill":
			return IconWand;
		case "browser":
			return IconWorldWww;
		default:
			return IconCode;
	}
}

export function getCategoryColor(cat: ToolCategory) {
	switch (cat) {
		case "read":
			return "lime";
		case "file":
			return "violet";
		case "bash":
			return "orange";
		case "search":
			return "cyan";
		case "webSearch":
			return "teal";
		case "webFetch":
			return "teal";
		case "todo":
			return "teal";
		case "goal":
			return "green";
		case "taskOutput":
			return "indigo";
		case "agent":
			return "pink";
		case "await":
			return "indigo";
		case "send":
			return "blue";
		case "ask":
			return "blue";
		case "plan":
			return "grape";
		case "pipeline":
			return "indigo";
		case "terminal":
			return "yellow";
		case "share":
			return "green";
		case "recall":
			return "cyan";
		case "skill":
			return "grape";
		case "browser":
			return "teal";
		default:
			return "gray";
	}
}

// --- Truncation helpers ---

/** Check whether a value is a truncated placeholder produced by the backend */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function isTruncated(val: any): val is {
	_truncated: true;
	preview: string;
	fullLength: number;
	_hints?: Record<string, unknown>;
} {
	return val?._truncated === true && typeof val?.preview === "string";
}

const TOOLCARD_DISPLAY_TEXT_MAX_CHARS = 120_000;
const TOOLCARD_RECALL_MAX_RESULTS = 50;
const TOOLCARD_RECALL_MAX_MESSAGES = 100;
const TOOLCARD_RECALL_MAX_QUERY_BADGES = 12;
const TOOLCARD_RECALL_MESSAGE_TEXT_CHARS = 4_000;
const TOOLCARD_SKILL_MAX_FILES = 50;

function capToolCardDisplayText(text: string, maxChars = TOOLCARD_DISPLAY_TEXT_MAX_CHARS): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}

function appendToolCardPreview(parts: string[], value: string, budget: { remaining: number }) {
	if (budget.remaining <= 0 || value.length === 0) return;
	const chunk = value.length > budget.remaining ? value.slice(0, budget.remaining) : value;
	parts.push(chunk);
	budget.remaining -= chunk.length;
}

function appendToolCardJsonPreview(
	parts: string[],
	value: unknown,
	budget: { remaining: number },
	seen: WeakSet<object>,
	depth = 0,
) {
	if (budget.remaining <= 0) return;
	if (
		value === null ||
		value === undefined ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		appendToolCardPreview(parts, value === undefined ? "undefined" : JSON.stringify(value), budget);
		return;
	}
	if (typeof value === "string") {
		appendToolCardPreview(
			parts,
			JSON.stringify(capToolCardDisplayText(value, budget.remaining)),
			budget,
		);
		return;
	}
	if (typeof value !== "object") {
		appendToolCardPreview(parts, JSON.stringify(String(value)), budget);
		return;
	}
	if (seen.has(value)) {
		appendToolCardPreview(parts, '"[Circular]"', budget);
		return;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		appendToolCardPreview(parts, "[", budget);
		for (let i = 0; i < value.length && budget.remaining > 0; i++) {
			if (i > 0) appendToolCardPreview(parts, ", ", budget);
			appendToolCardJsonPreview(parts, value[i], budget, seen, depth + 1);
		}
		appendToolCardPreview(parts, "]", budget);
		return;
	}
	appendToolCardPreview(parts, "{", budget);
	let index = 0;
	for (const [key, child] of Object.entries(value)) {
		if (budget.remaining <= 0) break;
		appendToolCardPreview(
			parts,
			`${index > 0 ? "," : ""}\n${"\t".repeat(depth + 1)}${JSON.stringify(key)}: `,
			budget,
		);
		appendToolCardJsonPreview(parts, child, budget, seen, depth + 1);
		index++;
	}
	if (index > 0) appendToolCardPreview(parts, `\n${"\t".repeat(depth)}}`, budget);
	else appendToolCardPreview(parts, "}", budget);
}

function stringifyToolCardJsonPreview(value: unknown): string {
	const parts: string[] = [];
	appendToolCardJsonPreview(
		parts,
		value,
		{ remaining: TOOLCARD_DISPLAY_TEXT_MAX_CHARS },
		new WeakSet(),
	);
	return parts.join("");
}

/**
 * Resolve a possibly-truncated JSON value to a displayable string.
 * For truncated objects, returns a bounded `preview` field (raw JSON prefix).
 * For normal values, returns a bounded JSON/text preview.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function resolveDisplayText(val: any): string {
	if (val === null || val === undefined) return "";
	if (isTruncated(val)) return capToolCardDisplayText(val.preview);
	if (typeof val === "string") return capToolCardDisplayText(val);
	// Structured output from tools like Read/Edit: { _text, _metadata }
	if (typeof val._text === "string") return capToolCardDisplayText(val._text);
	return stringifyToolCardJsonPreview(val);
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function resolveFullDisplayText(val: any): string | undefined {
	if (val === null || val === undefined || isTruncated(val)) return undefined;
	if (typeof val === "string") return val;
	if (typeof val._text === "string") return val._text;
	try {
		return JSON.stringify(val, null, 2);
	} catch {
		return String(val);
	}
}

function collectToolCardTextPreview(value: unknown): string {
	if (!value) return "";
	if (typeof value === "string") return capToolCardDisplayText(value);
	if (Array.isArray(value)) {
		const parts: string[] = [];
		const budget = { remaining: TOOLCARD_DISPLAY_TEXT_MAX_CHARS };
		for (const block of value) {
			if (budget.remaining <= 0) break;
			const text =
				typeof block === "object" && block && "text" in block
					? String((block as { text?: unknown }).text ?? "")
					: "";
			if (!text) continue;
			if (parts.length > 0) appendToolCardPreview(parts, "\n", budget);
			appendToolCardPreview(parts, text, budget);
		}
		return parts.join("");
	}
	if (typeof value === "object" && "_text" in value) {
		return capToolCardDisplayText(String((value as { _text?: unknown })._text ?? ""));
	}
	return "";
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Try to extract a top-level string property from a possibly-truncated JSON object.
 * For truncated objects with `_hints`, reads directly from the hints map first.
 * For truncated objects without hints, attempts a regex match on the preview string.
 * Supports both complete and truncated (unclosed) string values in the preview.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function extractField(val: any, ...keys: string[]): string {
	if (!val) return "";
	if (!isTruncated(val)) {
		for (const k of keys) {
			if (typeof val[k] === "string") return val[k];
		}
		return "";
	}
	// Fast path: read from pre-extracted hints
	const hints = val._hints;
	if (hints && typeof hints === "object") {
		for (const k of keys) {
			if (typeof hints[k] === "string") return hints[k];
		}
	}
	// Try to extract from the JSON preview string via regex
	for (const k of keys) {
		// First try: complete string value (with closing quote)
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
		const m = val.preview.match(re);
		if (m) {
			try {
				return JSON.parse(`"${m[1]}"`);
			} catch {
				return m[1];
			}
		}
		// Second try: truncated string value (no closing quote — preview was cut mid-value)
		const reTrunc = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`);
		const mt = val.preview.match(reTrunc);
		if (mt) {
			try {
				// Attempt to parse; may fail if cut mid-escape — fall back to raw
				return JSON.parse(`"${mt[1]}"`);
			} catch {
				return mt[1];
			}
		}
	}
	return "";
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function extractNumericField(val: any, ...keys: string[]): number | undefined {
	if (!val) return undefined;
	if (!isTruncated(val)) {
		for (const k of keys) {
			if (typeof val[k] === "number") return val[k];
		}
		return undefined;
	}
	// Fast path: read from pre-extracted hints
	const hints = val._hints;
	if (hints && typeof hints === "object") {
		for (const k of keys) {
			if (typeof hints[k] === "number") return hints[k];
		}
	}
	for (const k of keys) {
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*(\\d+)`);
		const m = val.preview?.match(re);
		if (m) return Number(m[1]);
	}
	return undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function extractStringArrayField(val: any, key: string): string[] {
	if (!val || isTruncated(val)) return [];
	const raw = val[key];
	return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

// --- Helper: extract a human-readable summary for the header ---

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function getFilePath(input: any): string {
	return extractField(input, "file_path", "filePath", "path");
}

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

function formatClipboardFilePath(p: string, platform: "windows" | "macos" | "linux"): string {
	return platform === "windows" ? p.replace(/\//g, "\\") : p;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function getSendTargetLabels(input: any): string[] {
	if (isTruncated(input)) return [];
	const labels: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value.trim()) labels.push(value.trim());
	};
	push(input?.id);
	push(input?.name);
	if (Array.isArray(input?.ids)) input.ids.forEach(push);
	if (Array.isArray(input?.names)) input.names.forEach(push);
	return [...new Set(labels)];
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function getSummary(toolName: string, input: any, metadata?: Record<string, unknown>): string {
	// Synthetic streaming tool call — show file path + content chars
	if (input?._streamingChars != null) {
		const chars = input._streamingChars as number;
		const filePath = input._streamingFilePath as string | undefined;
		const contentChars = input._streamingContentChars as number | undefined;
		const fields = input._streamingFields as Record<string, string> | undefined;
		// Agent tool: show subagent_type + description while prompt is still streaming
		if (fields && (toolName === "Agent" || toolName === "Task")) {
			const parts: string[] = [];
			if (fields.subagent_type) parts.push(fields.subagent_type);
			if (fields.description) parts.push(fields.description);
			if (parts.length > 0) return parts.join(": ");
		}
		if (fields && toolName === "Send") {
			const target = fields.id ?? fields.name ?? fields.ids ?? fields.names ?? "subagent";
			return `to ${target}`;
		}
		if (toolName === "Edit") {
			const phase =
				input._streamingFieldName === "new_string" || fields?.new_string ? "replacing" : "matching";
			const target = filePath ? basename(filePath) : "Edit";
			return `${phase} ${target}`;
		}
		// Search tools: show pattern + path from extracted fields
		if (fields && SEARCH_TOOLS.has(toolName)) {
			const pat = fields.pattern ?? fields.glob;
			const searchPath = fields.path;
			if (pat || searchPath) {
				const pathLabel = searchPath ? ` in ${basename(searchPath) || searchPath}` : "";
				const raw = `${pat || toolName}${pathLabel}`;
				return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
			}
		}
		// WebSearch: show query
		if (fields && WEB_SEARCH_TOOLS.has(toolName)) {
			const q = fields.query;
			if (q) return q.length > 60 ? `${q.slice(0, 57)}...` : q;
		}
		// WebFetch: show url + mode
		if (fields && WEB_FETCH_TOOLS.has(toolName)) {
			const fetchUrl = fields.url;
			const fetchMode = fields.mode;
			if (fetchUrl) {
				const short = fetchUrl.length > 50 ? `${fetchUrl.slice(0, 47)}...` : fetchUrl;
				return fetchMode ? `${fetchMode}: ${short}` : short;
			}
			if (fetchMode) return fetchMode;
		}
		if (filePath) {
			const base = basename(filePath);
			const displayChars = contentChars ?? chars;
			return displayChars > 10 ? `${base} (${displayChars} chars)` : base;
		}
		return chars > 0 ? `${chars} chars` : "";
	}
	const cat = getCategory(toolName);
	switch (cat) {
		case "read": {
			const fp = getFilePath(input);
			if (!fp) return "";
			const base = basename(fp);
			const offset = extractNumericField(input, "offset");
			const limit = extractNumericField(input, "limit");
			const totalLines = typeof metadata?.totalLines === "number" ? metadata.totalLines : undefined;
			if (limit === -1) return `${base} (read_all)`;
			if (offset != null && limit != null) return `${base} (${offset}~${offset + limit - 1})`;
			if (offset != null) return `${base} (${offset}~)`;
			if (limit != null) return `${base} (1~${limit})`;
			// No paging params — file was short enough to read in full
			if (totalLines != null) return `${base} (${totalLines}L)`;
			return base;
		}
		case "file": {
			const fp = getFilePath(input);
			if (!fp) return "";
			return basename(fp);
		}
		case "bash": {
			// Await mode: Bash(await: {task_id: "xxx"})
			const awaitParam = !isTruncated(input) ? input?.await : undefined;
			if (awaitParam && typeof awaitParam === "object") {
				const awaitTaskId = awaitParam.task_id ?? awaitParam.taskId;
				return awaitTaskId ? `Await ${awaitTaskId}` : "Await background task";
			}
			const desc = extractField(input, "description");
			if (desc) return desc.length > 80 ? `${desc.slice(0, 77)}...` : desc;
			const cmd = extractField(input, "command");
			if (!cmd) return toolName;
			return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
		}
		case "search": {
			const pat = extractField(input, "pattern", "glob");
			const searchPath = extractField(input, "path");
			if (!pat && !searchPath) return toolName;
			const pathLabel = searchPath ? ` in ${basename(searchPath) || searchPath}` : "";
			const raw = `${pat || toolName}${pathLabel}`;
			return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
		}
		case "webSearch": {
			const q = extractField(input, "query");
			if (!q) return "Web Search";
			return q.length > 60 ? `${q.slice(0, 57)}...` : q;
		}
		case "webFetch": {
			const fetchUrl = extractField(input, "url");
			const fetchMode = extractField(input, "mode");
			if (!fetchUrl) return fetchMode || "WebFetch";
			const short = fetchUrl.length > 50 ? `${fetchUrl.slice(0, 47)}...` : fetchUrl;
			return fetchMode ? `${fetchMode}: ${short}` : short;
		}
		case "todo":
			return "Update todos";
		case "goal": {
			if (toolName === "GetGoals") return "List goals";
			if (toolName === "UpdateGoal") return "Complete active goal";
			const objective = extractField(input, "objective");
			if (objective) return objective.length > 80 ? `${objective.slice(0, 77)}...` : objective;
			return toolName;
		}
		case "taskOutput": {
			const taskId = extractField(input, "task_id");
			return taskId ? `Check ${taskId}` : "Check task output";
		}
		case "agent": {
			const agentType = extractField(input, "subagent_type");
			const desc = extractField(input, "description");
			const parts: string[] = [];
			if (agentType) parts.push(agentType);
			if (desc) parts.push(desc);
			if (parts.length > 0) return parts.join(": ");
			return toolName;
		}
		case "await": {
			const awaitType = extractField(input, "type") || "task";
			const id = extractField(input, "id") || "unknown";
			const waitForText = extractField(input, "wait_for_text");
			const base = `${awaitType}: ${id}`;
			return waitForText ? `${base} · wait "${waitForText.slice(0, 24)}"` : base;
		}
		case "send": {
			const targets = getSendTargetLabels(input);
			const targetLabel = targets.length === 1 ? targets[0] : `${targets.length} targets`;
			const flags = [];
			if (!isTruncated(input) && input?.doInterrupt) flags.push("interrupt");
			if (!isTruncated(input) && input?.await) flags.push("await");
			const base = `to ${targetLabel || "subagent"}`;
			return flags.length > 0 ? `${base} · ${flags.join(" · ")}` : base;
		}
		case "ask": {
			const questions = isTruncated(input) ? undefined : coerceQuestions(input?.questions);
			const answers = isTruncated(input)
				? undefined
				: (input?.answers as Record<string, string> | undefined);
			if (questions && questions.length > 0) {
				const header = questions[0].header ?? "Question";
				if (answers && Object.keys(answers).length > 0) {
					const vals = Object.values(answers);
					const joined = vals.join(", ");
					const label = joined.length > 60 ? `${joined.slice(0, 57)}...` : joined;
					return `${header} → ${label}`;
				}
				return header || "Question";
			}
			// Truncated input: try to read header from _hints
			if (isTruncated(input) && typeof input._hints?._firstHeader === "string") {
				return input._hints._firstHeader;
			}
			return "Question";
		}
		case "plan":
			return toolName === "ExitPlanMode" ? "Plan ready" : "Enter plan mode";
		case "pipeline": {
			if (toolName === "StartPipeline") {
				const label = extractField(input, "label");
				const maxPreview = extractNumericField(input, "maxPreviewChars");
				const suffix = maxPreview != null ? ` · preview≤${maxPreview}` : "";
				return label
					? `start: ${label.length > 60 ? `${label.slice(0, 57)}...` : label}${suffix}`
					: `start capture${suffix}`;
			}
			const rule = extractField(input, "rule");
			if (rule) return rule.length > 80 ? `${rule.slice(0, 77)}...` : rule;
			const aliases = extractStringArrayField(input, "aliases");
			return aliases.length > 0 ? `aliases ${aliases.join(", ")}` : "finish pipeline";
		}
		case "terminal": {
			const action = extractField(input, "action");
			const tid = extractField(input, "terminal_id");
			const short = tid ? tid.slice(0, 8) : "";
			if (action === "list") return "List terminals";
			if (action === "read") return short ? `Read ${short}…` : "Read";
			if (action === "write") {
				const inp = extractField(input, "input");
				if (inp) {
					const preview = inp.length > 50 ? `${inp.slice(0, 47)}...` : inp;
					return preview;
				}
				return short ? `Write ${short}…` : "Write";
			}
			return action || "Terminal";
		}
		case "share": {
			const fp = getFilePath(input);
			if (!fp) return "Share";
			return basename(fp);
		}
		case "skill": {
			const skillName = extractField(input, "skill", "name");
			const skillArgs = extractField(input, "args");
			if (!skillName) return "Skill";
			if (skillArgs) {
				const label = `${skillName}: ${skillArgs}`;
				return label.length > 60 ? `${label.slice(0, 57)}...` : label;
			}
			return skillName;
		}
		case "recall": {
			const action = extractField(input, "action");
			if (action === "search") {
				// query can be string or string[] — extractField only handles string
				const raw = isTruncated(input) ? undefined : input?.query;
				const q = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(", ") : "";
				if (q) return q.length > 60 ? `${q.slice(0, 57)}...` : q;
				return "Search";
			}
			if (action === "read_conversation") {
				const nid = extractField(input, "narrator_id");
				return nid ? `Read ${nid.slice(0, 8)}…` : "Read conversation";
			}
			if (action === "read_tool_call") {
				const tcId = extractField(input, "tool_call_id");
				return tcId ? `Tool call ${tcId.slice(0, 8)}…` : "Read tool call";
			}
			return "Recall";
		}
		case "browser": {
			const action = extractField(input, "action");
			const bUrl = extractField(input, "url");
			const bSelector = extractField(input, "selector");
			const bSessionId = extractField(input, "session_id");
			const shortSess = bSessionId ? bSessionId.slice(0, 6) : "";
			switch (action) {
				case "launch": {
					if (bUrl) {
						const s = bUrl.length > 50 ? `${bUrl.slice(0, 47)}...` : bUrl;
						return `Launch: ${s}`;
					}
					return "Launch";
				}
				case "screenshot":
					return shortSess ? `Screenshot [${shortSess}…]` : "Screenshot";
				case "click": {
					if (bSelector)
						return `Click: ${bSelector.length > 40 ? `${bSelector.slice(0, 37)}...` : bSelector}`;
					return "Click";
				}
				case "fill": {
					if (bSelector)
						return `Fill: ${bSelector.length > 40 ? `${bSelector.slice(0, 37)}...` : bSelector}`;
					return "Fill";
				}
				case "navigate": {
					if (bUrl) {
						const s = bUrl.length > 45 ? `${bUrl.slice(0, 42)}...` : bUrl;
						return `Navigate: ${s}`;
					}
					const dir = extractField(input, "direction");
					if (dir) return `Navigate ${dir}`;
					return "Navigate";
				}
				case "dom":
					return bSelector
						? `DOM: ${bSelector.length > 40 ? `${bSelector.slice(0, 37)}...` : bSelector}`
						: "DOM";
				case "get_text":
					return bSelector
						? `Text: ${bSelector.length > 40 ? `${bSelector.slice(0, 37)}...` : bSelector}`
						: "Get text";
				case "evaluate":
					return "Evaluate JS";
				case "close":
					return shortSess ? `Close [${shortSess}…]` : "Close";
				case "list_sessions":
					return "List sessions";
				default:
					return action || "Browser";
			}
		}
		default:
			return toolName;
	}
}

// --- Helper: live elapsed timer for running tools ---

function parseIsoTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const time = new Date(value).getTime();
	return Number.isFinite(time) ? time : null;
}

function formatTimeOnly(time: number): string {
	return new Date(time).toLocaleTimeString();
}

function ToolTimingTooltipLabel({
	toolCall,
	displayDurationMs,
}: {
	toolCall: ToolCallData;
	displayDurationMs: number | null;
}) {
	const { t } = useTranslation("narrator");
	const streamStarted = parseIsoTime(toolCall.streamStartedAt) ?? toolCall.startedAt ?? null;
	const permissionStarted = parseIsoTime(toolCall.permissionStartedAt);
	const executionStarted = parseIsoTime(toolCall.executionStartedAt);
	const completed =
		parseIsoTime(toolCall.completedAt) ??
		(executionStarted != null && displayDurationMs != null
			? executionStarted + displayDurationMs
			: null);
	const steps = [
		{ key: "stream", label: t("toolCallInspector.timing.streamStarted"), time: streamStarted },
		{
			key: "permission",
			label: t("toolCallInspector.timing.permissionStarted"),
			time: permissionStarted,
		},
		{
			key: "execution",
			label: t("toolCallInspector.timing.executionStarted"),
			time: executionStarted,
		},
		{ key: "completed", label: t("toolCallInspector.timing.completed"), time: completed },
	].filter((step) => step.time != null) as Array<{ key: string; label: string; time: number }>;

	if (steps.length === 0) return null;

	return (
		<Stack gap={4} maw={320}>
			<Text size="xs" fw={600}>
				{t("toolCallInspector.timing.title")}
			</Text>
			{steps.map((step, index) => {
				const previous = steps[index - 1]?.time;
				const delta = previous == null ? null : Math.max(0, step.time - previous);
				return (
					<Group key={step.key} gap={6} wrap="nowrap" justify="space-between">
						<Text size="xs" style={{ flex: 1 }}>
							{step.label}
						</Text>
						<Text size="xs" ff="monospace" c="dimmed">
							{formatTimeOnly(step.time)}
						</Text>
						{delta != null && (
							<Text size="xs" ff="monospace" c="dimmed" style={{ width: 54, textAlign: "right" }}>
								+{formatDurationText(delta, { style: "precise" })}
							</Text>
						)}
					</Group>
				);
			})}
			{streamStarted != null && completed != null && (
				<Text size="xs" c="dimmed">
					{t("toolCallInspector.timing.total", {
						duration: formatDurationText(completed - streamStarted, { style: "precise" }),
					})}
				</Text>
			)}
			{permissionStarted != null && executionStarted != null && (
				<Text size="xs" c="dimmed">
					{t("toolCallInspector.timing.permissionWait", {
						duration: formatDurationText(executionStarted - permissionStarted, {
							style: "precise",
						}),
					})}
				</Text>
			)}
			{executionStarted != null && completed != null && (
				<Text size="xs" c="dimmed">
					{t("toolCallInspector.timing.execution", {
						duration: formatDurationText(completed - executionStarted, { style: "precise" }),
					})}
				</Text>
			)}
		</Stack>
	);
}

const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/**
 * Popover for viewing/editing timeout on a running tool call.
 * Clicking the elapsed/timeout text opens it.
 */
function TimeoutPopover({
	timeoutMs,
	narratorId,
	toolUseId,
	isRunning,
	children,
}: {
	timeoutMs: number;
	narratorId?: string;
	toolUseId?: string;
	isRunning: boolean;
	children: React.ReactNode;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const [value, setValue] = useState<number | string>(Math.round(timeoutMs / 1000));

	// Sync value when timeoutMs changes externally
	useEffect(() => {
		if (!opened) setValue(Math.round(timeoutMs / 1000));
	}, [timeoutMs, opened]);

	const handleUpdate = useCallback(() => {
		const seconds = typeof value === "string" ? Number.parseFloat(value) : value;
		if (!seconds || seconds <= 0 || !narratorId || !toolUseId) return;
		narratorWSManager.send({
			type: "update_timeout",
			narratorId,
			toolUseId,
			timeoutMs: Math.round(seconds * 1000),
		});
		setOpened(false);
	}, [value, narratorId, toolUseId]);

	return (
		<Popover opened={opened} onChange={setOpened} position="top" withArrow shadow="md" trapFocus>
			<Popover.Target>
				<UnstyledButton
					onClick={(e: React.MouseEvent) => {
						e.stopPropagation();
						setOpened((o) => !o);
					}}
					style={{ cursor: "pointer" }}
				>
					{children}
				</UnstyledButton>
			</Popover.Target>
			<Popover.Dropdown p="xs" style={{ minWidth: 180 }}>
				<Stack gap={6}>
					<Text size="xs" fw={600}>
						{t("timeoutSeconds")}
					</Text>
					<Group gap={4} wrap="nowrap">
						<NumberInput
							size="xs"
							value={value}
							onChange={setValue}
							min={1}
							max={86400}
							step={10}
							style={{ flex: 1 }}
							disabled={!isRunning}
							onKeyDown={(e: React.KeyboardEvent) => {
								if (e.key === "Enter") {
									e.preventDefault();
									handleUpdate();
								}
							}}
						/>
						<Button size="xs" variant="light" onClick={handleUpdate} disabled={!isRunning}>
							{t("timeoutUpdate")}
						</Button>
					</Group>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}

export function ElapsedTimer({
	startedAt,
	timeoutMs,
	narratorId,
	toolUseId,
}: {
	startedAt: number;
	timeoutMs?: number;
	narratorId?: string;
	toolUseId?: string;
}) {
	const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startedAt) / 1000));
	const rafRef = useRef(0);

	useEffect(() => {
		let last = performance.now();
		const tick = (now: number) => {
			if (now - last >= 1000) {
				last = now;
				setElapsed(Math.floor((Date.now() - startedAt) / 1000));
			}
			rafRef.current = requestAnimationFrame(tick);
		};
		rafRef.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafRef.current);
	}, [startedAt]);

	const showTimeout = timeoutMs != null;
	const effectiveTimeout = timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
	const timeoutStr = showTimeout
		? formatDurationText(effectiveTimeout, { style: "timeout" })
		: null;

	const timerContent = (
		<Text size="xs" c="dimmed" ff="monospace">
			{formatDurationText(elapsed * 1000)}
			{timeoutStr && <span style={{ opacity: 0.5 }}> / {timeoutStr}</span>}
		</Text>
	);

	if (narratorId && toolUseId && showTimeout) {
		return (
			<TimeoutPopover
				timeoutMs={effectiveTimeout}
				narratorId={narratorId}
				toolUseId={toolUseId}
				isRunning
			>
				{timerContent}
			</TimeoutPopover>
		);
	}

	return timerContent;
}

// --- Helper: status indicator icon ---

function getToolCallReflection(
	toolCall: ToolCallData,
	pendingPermission?: PendingPermission | null,
) {
	const reflection = getPermissionReflectionSuggestion({
		permissionSuggestions: toolCall.permissionSuggestions,
		suggestions: pendingPermission?.suggestions,
	});
	if (
		reflection &&
		!pendingPermission &&
		(reflection.status === "running" || reflection.status === "awaiting_user") &&
		toolCall.status !== "pending"
	) {
		return {
			...reflection,
			status: "aborted" as const,
			reason: toolCall.errorMessage || toolCall.permissionDecisionReason || reflection.reason,
		};
	}
	return reflection;
}

function ReflectionNotice({
	toolCall,
	pendingPermission,
	reflection,
}: {
	toolCall: ToolCallData;
	pendingPermission?: PendingPermission | null;
	reflection: ReflectionSuggestion;
}) {
	const { t } = useTranslation("narrator");
	const { setButtonCount, setHasFeedback, registerActions, activePermissionId } =
		useContext(PermEnterHintCtx);
	const [takingOver, setTakingOver] = useState(false);
	const reflectionRequestId = reflection.requestId ?? pendingPermission?.id ?? toolCall.id;
	const activeKeyboardPermissionId = pendingPermission?.id ?? toolCall.id;
	const running = reflection.status === "running";
	const isDanger = reflection.kind === "danger_reflection";
	const isPlan = reflection.kind === "plan_reflection";
	const isQuestion = reflection.kind === "question_reflection";
	const summary =
		reflection.reason || reflection.danger?.summary || toolCall.permissionDecisionReason;
	const titleKeyPrefix = isDanger ? "danger" : isPlan ? "plan" : isQuestion ? "question" : "goal";
	const title = (() => {
		if (running) return t(`${titleKeyPrefix}ReflectionRunning`);
		if (reflection.status === "awaiting_user") return t(`${titleKeyPrefix}ReflectionAwaitingUser`);
		if (reflection.status === "confirmed") return t(`${titleKeyPrefix}ReflectionConfirmed`);
		if (reflection.status === "cancelled") return t(`${titleKeyPrefix}ReflectionCancelled`);
		if (reflection.status === "aborted") return t(`${titleKeyPrefix}ReflectionAborted`);
		return t(`${titleKeyPrefix}ReflectionResolved`);
	})();

	useEffect(() => {
		if (activeKeyboardPermissionId && activeKeyboardPermissionId === activePermissionId) {
			setButtonCount(0);
			setHasFeedback(false);
			registerActions([]);
		}
	}, [
		activeKeyboardPermissionId,
		activePermissionId,
		registerActions,
		setButtonCount,
		setHasFeedback,
	]);

	const handleTakeOver = async (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!reflectionRequestId || takingOver) return;
		setTakingOver(true);
		try {
			if (isDanger) await api.stopDangerReflection(reflectionRequestId);
			else if (isPlan) await api.stopPlanReflection(reflectionRequestId);
		} finally {
			setTakingOver(false);
		}
	};

	const noticeStyle: React.CSSProperties = {
		marginTop: "var(--mantine-spacing-xs)",
		background: running
			? "light-dark(color-mix(in srgb, var(--mantine-color-yellow-0) 88%, white), color-mix(in srgb, var(--mantine-color-yellow-9) 34%, transparent))"
			: "light-dark(color-mix(in srgb, var(--mantine-color-gray-0) 88%, white), color-mix(in srgb, var(--mantine-color-dark-5) 52%, transparent))",
		borderColor: running
			? "light-dark(var(--mantine-color-yellow-3), color-mix(in srgb, var(--mantine-color-yellow-6) 45%, transparent))"
			: "var(--mantine-color-default-border)",
	};
	const titleColor = running
		? "light-dark(var(--mantine-color-yellow-9), var(--mantine-color-yellow-2))"
		: "var(--mantine-color-text)";
	const summaryColor = running
		? "light-dark(var(--mantine-color-yellow-9), var(--mantine-color-yellow-1))"
		: "var(--mantine-color-dimmed)";
	const iconColor = running
		? "yellow"
		: reflection.status === "confirmed"
			? "green"
			: reflection.status === "cancelled"
				? "red"
				: reflection.status === "aborted"
					? "orange"
					: "gray";
	const icon = running ? (
		<IconLoader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
	) : reflection.status === "confirmed" ? (
		<IconCheck size={14} />
	) : reflection.status === "cancelled" ? (
		<IconX size={14} />
	) : reflection.status === "aborted" ? (
		<IconBan size={14} />
	) : (
		<IconShield size={14} />
	);

	return (
		<Paper
			withBorder
			radius="sm"
			p="sm"
			style={noticeStyle}
			{...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}
		>
			<Group gap="sm" wrap="nowrap" align="flex-start">
				<ThemeIcon size="sm" radius="sm" color={iconColor} variant="light" mt={1}>
					{icon}
				</ThemeIcon>
				<Box style={{ minWidth: 0, flex: 1 }}>
					<Text size="xs" fw={700} lh={1.35} style={{ color: titleColor }}>
						{title}
					</Text>
					{summary && (
						<Text size="xs" lh={1.45} mt={3} style={{ color: summaryColor }}>
							{summary}
						</Text>
					)}
					{reflection.nextSteps && (
						<Text size="xs" lh={1.45} mt={3} style={{ color: summaryColor }}>
							{t("reflectionNextSteps", { nextSteps: reflection.nextSteps })}
						</Text>
					)}
					{running && reflectionRequestId && (isDanger || isPlan) && (
						<Group gap="xs" mt="xs">
							<Button
								size="xs"
								variant="light"
								color="yellow"
								leftSection={<IconPlayerStop size={12} />}
								loading={takingOver}
								onClick={handleTakeOver}
							>
								{t("manualTakeoverReflection")}
							</Button>
						</Group>
					)}
				</Box>
			</Group>
		</Paper>
	);
}

export function StatusIcon({ status }: { status: string }) {
	if (status === "running" || status === "pending" || status === "initializing") {
		return <IconLoader2 size={12} style={{ animation: "spin 1s linear infinite" }} />;
	}
	if (status === "success") {
		return <IconCheck size={12} />;
	}
	if (status === "fail") {
		return <IconX size={12} />;
	}
	if (status === "cancelled") {
		return <IconBan size={12} />;
	}
	return null;
}

// --- Shared card header ---

const ToolHeader = memo(
	function ToolHeader({
		toolCall,
		opened,
		onToggle,
		narratorId,
	}: {
		toolCall: ToolCallData;
		opened: boolean;
		onToggle?: () => void;
		narratorId?: string;
	}) {
		const cat = getCategory(toolCall.toolName);
		const Icon = getCategoryIcon(cat);
		const color = getCategoryColor(cat);
		const summary = useMemo(
			() => getSummary(toolCall.toolName, toolCall.inputJson, toolCall._metadata),
			[toolCall.toolName, toolCall.inputJson, toolCall._metadata],
		);
		const searchPathSuffix = useMemo(() => {
			if (cat !== "search") return null;
			const p = extractField(toolCall.inputJson, "path");
			if (!p) return null;
			return basename(p) || p;
		}, [cat, toolCall.inputJson]);
		const statusColor = STATUS_COLORS[toolCall.status] ?? "gray";
		const { t } = useTranslation("narrator");

		const startedAtLabel = useMemo(() => {
			if (toolCall.startedAt == null) return null;
			return t("toolStartedAt", {
				time: new Date(toolCall.startedAt).toLocaleTimeString(),
			});
		}, [toolCall.startedAt, t]);

		// Use concise labels for tool families with action-like names.
		const displayName = useMemo(() => {
			if (cat === "terminal") {
				const action = extractField(toolCall.inputJson, "action");
				if (action) return `Terminal ${action.charAt(0).toUpperCase()}${action.slice(1)}`;
			}
			if (cat === "pipeline") {
				return toolCall.toolName === "StartPipeline" ? t("pipelineStart") : t("pipelineEnd");
			}
			return toolCall.toolName;
		}, [cat, toolCall.toolName, toolCall.inputJson, t]);

		// For Bash tools, resolve the effective timeout (from _timeoutMs, inputJson, or default)
		const effectiveTimeoutMs = useMemo(() => {
			if (cat !== "bash") return null;
			if (toolCall._timeoutMs != null) return toolCall._timeoutMs;
			const ms = extractNumericField(toolCall.inputJson, "timeout");
			return ms ?? DEFAULT_BASH_TIMEOUT_MS;
		}, [cat, toolCall._timeoutMs, toolCall.inputJson]);

		// For Bash tools, prefer pure execution time (excludes streaming parse + permission wait)
		const displayDurationMs = useMemo(() => {
			if (toolCall.durationMs == null) return null;
			if (cat === "bash") {
				const exec =
					typeof toolCall._metadata?.execDurationMs === "number"
						? toolCall._metadata.execDurationMs
						: undefined;
				if (exec != null) return exec;
			}
			return toolCall.durationMs;
		}, [cat, toolCall.durationMs, toolCall._metadata]);
		const timingTooltipLabel =
			toolCall.streamStartedAt ||
			toolCall.permissionStartedAt ||
			toolCall.executionStartedAt ||
			toolCall.completedAt ? (
				<ToolTimingTooltipLabel toolCall={toolCall} displayDurationMs={displayDurationMs} />
			) : (
				startedAtLabel
			);
		const startedAt = toolCall.startedAt;
		const showElapsedTimer =
			startedAt != null &&
			(toolCall.status === "running" ||
				toolCall.status === "pending" ||
				toolCall.status === "initializing");

		const statusNode = (
			<Group gap={4} wrap="nowrap" align="center">
				<Box c={statusColor} style={{ display: "flex", alignItems: "center" }}>
					<StatusIcon status={toolCall.status} />
				</Box>
				{showElapsedTimer ? (
					<ElapsedTimer
						startedAt={startedAt}
						timeoutMs={effectiveTimeoutMs ?? undefined}
						narratorId={narratorId}
						toolUseId={toolCall.toolUseId}
					/>
				) : (
					displayDurationMs != null &&
					(effectiveTimeoutMs != null ? (
						<TimeoutPopover
							timeoutMs={effectiveTimeoutMs}
							narratorId={narratorId}
							toolUseId={toolCall.toolUseId}
							isRunning={false}
						>
							<Text size="xs" c="dimmed" ff="monospace">
								{formatDurationText(displayDurationMs, { style: "precise" })}
								<span style={{ opacity: 0.5 }}>
									/ {formatDurationText(effectiveTimeoutMs, { style: "timeout" })}
								</span>
							</Text>
						</TimeoutPopover>
					) : (
						<Text size="xs" c="dimmed" ff="monospace">
							{formatDurationText(displayDurationMs, { style: "precise" })}
						</Text>
					))
				)}
				{toolCall.permissionDecidedBy?.startsWith("narrator:") && (
					<Tooltip label={t("proxyApprovedTooltip")}>
						<Badge size="xs" variant="light" color="grape" leftSection={<IconUsers size={10} />}>
							{t("proxyApprovedBadge")}
						</Badge>
					</Tooltip>
				)}
			</Group>
		);

		const content = (
			<Group gap={5} wrap="nowrap" align="center" style={{ flex: 1, minWidth: 0 }}>
				<ThemeIcon size={16} variant="light" color={color} radius="sm">
					<Icon size={10} />
				</ThemeIcon>
				<Text size="xs" fw={600} c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
					{displayName}
				</Text>
				{searchPathSuffix ? (
					<Box
						component="span"
						ff="monospace"
						style={{
							flex: 1,
							minWidth: 0,
							fontSize: 12,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
						title={summary}
					>
						<span>{extractField(toolCall.inputJson, "pattern", "glob")}</span>
						<span style={{ color: "var(--mantine-color-dimmed)", marginLeft: 4 }}>
							in {searchPathSuffix}
						</span>
					</Box>
				) : (
					<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }} title={summary}>
						{summary}
					</Text>
				)}
				<Group gap={4} wrap="nowrap" align="center" style={{ flexShrink: 0 }}>
					{timingTooltipLabel ? (
						<Tooltip label={timingTooltipLabel} position="top" withArrow fz="xs">
							{statusNode}
						</Tooltip>
					) : (
						statusNode
					)}
					<Box style={{ display: "flex", alignItems: "center" }}>
						{opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
					</Box>
				</Group>
			</Group>
		);

		const handleClick = useCallback(
			(e: React.MouseEvent) => {
				// When Ctrl/Cmd or Shift is held, skip toggle — let the event bubble
				// up to the outer selection handler so the card is only selected.
				if (e.metaKey || e.ctrlKey || e.shiftKey) return;
				onToggle?.();
			},
			[onToggle],
		);

		return (
			<UnstyledButton
				onClick={handleClick}
				w="100%"
				style={{
					...(onToggle ? {} : { cursor: "default", pointerEvents: "none" as const }),
					display: "flex",
					alignItems: "center",
				}}
			>
				{content}
			</UnstyledButton>
		);
	},
	(prev, next) => {
		const p = prev.toolCall;
		const n = next.toolCall;
		return (
			p.toolName === n.toolName &&
			p.toolUseId === n.toolUseId &&
			p.status === n.status &&
			p.durationMs === n.durationMs &&
			p.inputJson === n.inputJson &&
			p._metadata === n._metadata &&
			p.startedAt === n.startedAt &&
			p._timeoutMs === n._timeoutMs &&
			prev.opened === next.opened &&
			prev.onToggle === next.onToggle &&
			prev.narratorId === next.narratorId
		);
	},
);

/**
 * Localize known tool error messages (e.g. Chrome not installed).
 * Returns the localized string, or the original message if no match.
 */
function useLocalizedToolError(errorMessage: string | undefined): string | undefined {
	const { t } = useTranslation("narrator");
	if (!errorMessage) return undefined;
	// Flatpak Chrome detected but can't be launched
	if (errorMessage.includes("Flatpak")) {
		return t("chromeFlatpakUnsupported");
	}
	// Chrome not found or launch failed
	if (
		errorMessage.includes("Chrome/Chromium") ||
		errorMessage.includes("puppeteer browsers install chrome")
	) {
		return t("chromeNotInstalled");
	}
	return errorMessage;
}

// --- Detail renderers per category ---

const codeStyle = { fontSize: 11, maxHeight: 200, overflow: "auto" } as const;
const termStyle = {
	fontSize: 11,
	maxHeight: 200,
	overflow: "auto",
	backgroundColor: "var(--mantine-color-dark-8)",
	color: "var(--mantine-color-gray-3)",
} as const;

/**
 * Context carrying the truncation-fetch state from LazyDetailRenderer.
 * When the full data is being fetched, detail renderers can show a loading indicator
 * instead of the misleading "expand to load" text.
 */
const TruncationFetchCtx = createContext<{
	isLoading: boolean;
	isError: boolean;
	refetch: () => void;
}>({ isLoading: false, isError: false, refetch: () => {} });

/** Small indicator shown when tool call content is truncated */
function TruncatedBadge({ fullLength }: { fullLength?: number }) {
	const { t } = useTranslation("narrator");
	const { isLoading, isError, refetch } = useContext(TruncationFetchCtx);

	if (isLoading) {
		return (
			<Group gap={4} mt={2}>
				<IconLoader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
				<Text size="xs" c="dimmed" fs="italic">
					{t("truncatedLoading", {
						size: fullLength ? `${Math.round(fullLength / 1024)}KB` : "",
					})}
				</Text>
			</Group>
		);
	}

	if (isError) {
		return (
			<UnstyledButton onClick={() => refetch()} mt={2}>
				<Text size="xs" c="red" fs="italic" td="underline">
					{t("truncatedError")}
				</Text>
			</UnstyledButton>
		);
	}

	return (
		<Text size="xs" c="dimmed" fs="italic" mt={2}>
			{t("truncatedPreview", {
				size: fullLength ? `${Math.round(fullLength / 1024)}KB` : "",
			})}
		</Text>
	);
}

// --- File preview types ---

const IMAGE_EXTS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".svg",
	".avif",
	".bmp",
	".ico",
]);
const PDF_EXTS = new Set([".pdf"]);
const MAX_FILE_PREVIEW_TEXT_CHARS = 120_000;
const MAX_FILE_PREVIEW_BLOB_BYTES = 25 * 1024 * 1024;

async function readTextPreview(
	response: Response,
	maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) {
		const text = await response.text();
		return text.length > maxChars
			? { text: text.slice(0, maxChars), truncated: true }
			: { text, truncated: false };
	}

	const decoder = new TextDecoder();
	let text = "";
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		if (text.length + chunk.length > maxChars) {
			text += chunk.slice(0, maxChars - text.length);
			truncated = true;
			await reader.cancel().catch(() => {});
			break;
		}
		text += chunk;
	}
	if (!truncated) text += decoder.decode();
	return { text, truncated };
}

function getFilePreviewType(filePath: string): "image" | "pdf" | "text" {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "text";
	const ext = filePath.slice(dot).toLowerCase();
	if (IMAGE_EXTS.has(ext)) return "image";
	if (PDF_EXTS.has(ext)) return "pdf";
	return "text";
}

function FilePreviewModal({
	filePath,
	opened,
	onClose,
}: {
	filePath: string;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	const fsCapability = useFileSystemCapability();
	const previewCapability = fsCapability.preview;
	const previewType = getFilePreviewType(filePath);
	const [error, setError] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [textContent, setTextContent] = useState<string | null>(null);
	const [textPreviewTruncated, setTextPreviewTruncated] = useState(false);
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const lang = getShikiLang(filePath);
	const fileName = filePath.split("/").pop() || filePath;

	// Reset state when modal opens, closes, or switches files.
	// biome-ignore lint/correctness/useExhaustiveDependencies: filePath changes must clear stale preview state before the next fetch completes
	useEffect(() => {
		setError(false);
		setErrorMessage(null);
		setTextContent(null);
		setTextPreviewTruncated(false);
		setBlobUrl(null);
		if (!opened) setLoading(false);
	}, [opened, filePath]);

	// Cleanup blob URL on unmount
	useEffect(() => {
		return () => {
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		};
	}, [blobUrl]);

	// Fetch file content when modal opens
	useEffect(() => {
		if (!opened || !previewCapability.supported) return;
		let cancelled = false;
		const controller = new AbortController();
		setLoading(true);
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;
		const url = `/api/fs/preview?path=${encodeURIComponent(filePath)}`;

		if (previewType === "text") {
			fetch(url, { headers, signal: controller.signal })
				.then(async (r) => {
					if (!r.ok) {
						const error = await readFetchError(r, "Request failed");
						throw new ApiError(error.message, r.status, error.data);
					}
					return readTextPreview(r, MAX_FILE_PREVIEW_TEXT_CHARS);
				})
				.then((preview) => {
					if (cancelled) return;
					setTextContent(preview.text);
					setTextPreviewTruncated(preview.truncated);
				})
				.catch((err) => {
					if (!cancelled) {
						setError(true);
						setErrorMessage(err instanceof Error ? err.message : null);
					}
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		} else {
			// Image or PDF: fetch as blob and create object URL
			fetch(url, { headers, signal: controller.signal })
				.then(async (r) => {
					if (!r.ok) {
						const error = await readFetchError(r, "Request failed");
						throw new ApiError(error.message, r.status, error.data);
					}
					return r.blob();
				})
				.then((blob) => {
					if (blob.size > MAX_FILE_PREVIEW_BLOB_BYTES) throw new Error("Preview too large");
					const nextUrl = URL.createObjectURL(blob);
					if (cancelled) {
						URL.revokeObjectURL(nextUrl);
						return;
					}
					setBlobUrl(nextUrl);
				})
				.catch((err) => {
					if (!cancelled) {
						setError(true);
						setErrorMessage(err instanceof Error ? err.message : null);
					}
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [opened, previewCapability.supported, previewType, filePath]);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={fileName}
			size="xl"
			styles={{
				body: { padding: 0 },
				header: { paddingBottom: 4 },
			}}
		>
			{loading && (
				<Group gap={4} p="md">
					<IconLoader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
					<Text size="sm" c="dimmed">
						{t("filePreview_loading")}
					</Text>
				</Group>
			)}
			{!previewCapability.supported && (
				<Box p="md">
					<Text c="dimmed" size="sm">
						{previewCapability.reason ?? t("filePreview_unsupported")}
					</Text>
				</Box>
			)}
			{error && (
				<Box p="md">
					<Text c="red" size="sm">
						{errorMessage ?? t("filePreview_loadError")}
					</Text>
				</Box>
			)}
			{!error && !loading && previewType === "image" && blobUrl && (
				<Box p="xs" style={{ textAlign: "center" }}>
					<img
						src={blobUrl}
						alt={fileName}
						onError={() => setError(true)}
						style={{
							maxWidth: "100%",
							maxHeight: "80vh",
							objectFit: "contain",
							borderRadius: "var(--mantine-radius-sm)",
						}}
					/>
				</Box>
			)}
			{!error && !loading && previewType === "pdf" && blobUrl && (
				<iframe
					src={blobUrl}
					title={fileName}
					onError={() => setError(true)}
					sandbox="allow-same-origin allow-scripts"
					style={{
						width: "100%",
						height: "80vh",
						border: "none",
					}}
				/>
			)}
			{!error && !loading && previewType === "text" && textContent != null && (
				<Box p="xs">
					<ContentViewer
						content={
							textPreviewTruncated ? `${textContent}\n\n${t("filePreview_truncated")}` : textContent
						}
						style={{ fontSize: 12, maxHeight: "75vh", overflow: "auto" }}
						title={fileName}
						language={lang}
					/>
				</Box>
			)}
		</Modal>
	);
}

type EditStreamingPhase = "matching" | "replacing";

function getStreamingEditPreview(input: unknown): {
	phase: EditStreamingPhase;
	oldString: string;
	newString: string;
	chars: number;
} | null {
	if (!input || typeof input !== "object" || isTruncated(input)) return null;
	const obj = input as Record<string, unknown>;
	if (obj._streamingChars == null) return null;
	const fields =
		obj._streamingFields && typeof obj._streamingFields === "object"
			? (obj._streamingFields as Record<string, unknown>)
			: {};
	const fieldName = typeof obj._streamingFieldName === "string" ? obj._streamingFieldName : "";
	const fieldValue = typeof obj._streamingFieldValue === "string" ? obj._streamingFieldValue : "";
	const oldString =
		(typeof fields.old_string === "string" ? fields.old_string : "") ||
		(fieldName === "old_string" ? fieldValue : "");
	const newString =
		(typeof fields.new_string === "string" ? fields.new_string : "") ||
		(fieldName === "new_string" ? fieldValue : "");
	const phase: EditStreamingPhase =
		fieldName === "new_string" || newString ? "replacing" : "matching";
	return {
		phase,
		oldString,
		newString,
		chars: typeof obj._streamingChars === "number" ? obj._streamingChars : 0,
	};
}

function EditDiffBlock({
	filePath,
	oldString,
	newString,
	language,
	startLine,
	phase,
	chars,
	streaming,
}: {
	filePath: string;
	oldString: string;
	newString: string;
	language?: string;
	startLine?: number;
	phase?: EditStreamingPhase;
	chars?: number;
	streaming?: boolean;
}) {
	const hasReplacement = phase ? phase === "replacing" : true;
	const displayOldString = oldString || " ";
	const displayNewString = hasReplacement ? newString : displayOldString;
	const content = `--- old\n${oldString}\n+++ new\n${hasReplacement ? newString : oldString}`;
	const title = filePath ? basename(filePath) : "Diff";
	const displayStartLine = startLine ?? (streaming ? 1 : undefined);
	const lineNumberPrefix = streaming && !hasReplacement ? "xx" : undefined;
	const autoFollowTarget = streaming && phase === "replacing" ? "latest-added" : "bottom";

	return (
		<Box>
			{filePath && (
				<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={filePath}>
					{filePath}
				</Text>
			)}
			<Box pos="relative" style={{ isolation: "isolate" }}>
				<ContentViewer
					content={content}
					title={title}
					contentType="diff"
					language={language}
					diff={{
						oldStr: oldString,
						newStr: hasReplacement ? newString : oldString,
					}}
					renderContent={(wordWrap) => (
						<DiffView
							oldStr={displayOldString}
							newStr={displayNewString}
							maxHeight={200}
							wordWrap={wordWrap}
							language={language}
							startLine={displayStartLine}
							lineNumberPrefix={lineNumberPrefix}
							autoFollowKey={streaming ? filePath : null}
							autoFollowTarget={autoFollowTarget}
						/>
					)}
				/>
				{streaming && phase && (
					<Box
						style={{
							position: "absolute",
							top: 6,
							right: 6,
							zIndex: 3,
							display: "flex",
							alignItems: "center",
							gap: 4,
							padding: "2px 7px",
							borderRadius: "999px",
							border:
								"1px solid color-mix(in srgb, var(--mantine-color-default-border) 80%, transparent)",
							background: "color-mix(in srgb, var(--mantine-color-body) 88%, transparent)",
							boxShadow: "var(--mantine-shadow-xs)",
							pointerEvents: "none",
							backdropFilter: "blur(4px)",
						}}
					>
						<IconLoader2
							size={12}
							style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}
						/>
						<Text size="xs" c="dimmed" ff="monospace" lh={1.2}>
							{phase}
							{chars ? ` · ${chars} chars` : ""}
						</Text>
					</Box>
				)}
			</Box>
		</Box>
	);
}

function FileDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const fp = getFilePath(toolCall.inputJson);
	const isEdit = toolCall.toolName === "Edit";
	const isWrite = toolCall.toolName === "Write";
	const inputIsTruncated = isTruncated(toolCall.inputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);

	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const lang = fp ? getShikiLang(fp) : undefined;

	// For Write tool, display the written content from input instead of the result prompt
	const writeFullContent =
		isWrite && !inputIsTruncated ? String(toolCall.inputJson?.content ?? "") : undefined;
	const writeContent = isWrite
		? inputIsTruncated
			? extractField(toolCall.inputJson, "content") || toolCall.inputJson.preview
			: capToolCardDisplayText(writeFullContent ?? "")
		: "";

	const editStreamingPreview = isEdit ? getStreamingEditPreview(toolCall.inputJson) : null;
	const oldString = inputIsTruncated ? undefined : toolCall.inputJson?.old_string;
	const newString = inputIsTruncated ? undefined : toolCall.inputJson?.new_string;

	// Extract startLine from metadata (set by Edit tool on completion)
	const streamingMetadata =
		!inputIsTruncated &&
		toolCall.inputJson?._streamingMetadata &&
		typeof toolCall.inputJson._streamingMetadata === "object"
			? (toolCall.inputJson._streamingMetadata as Record<string, unknown>)
			: undefined;
	const startLine =
		typeof toolCall._metadata?.startLine === "number"
			? (toolCall._metadata.startLine as number)
			: typeof streamingMetadata?.startLine === "number"
				? streamingMetadata.startLine
				: undefined;

	const isFailed = toolCall.status === "fail";
	const localizedError = useLocalizedToolError(toolCall.errorMessage);

	return (
		<Box mt="xs">
			{isEdit && editStreamingPreview && (
				<EditDiffBlock
					filePath={fp || "Edit"}
					oldString={editStreamingPreview.oldString}
					newString={editStreamingPreview.newString}
					language={lang}
					startLine={startLine}
					phase={editStreamingPreview.phase}
					chars={editStreamingPreview.chars}
					streaming
				/>
			)}
			{isEdit && !editStreamingPreview && oldString != null && (
				<EditDiffBlock
					filePath={fp}
					oldString={oldString}
					newString={newString ?? ""}
					language={lang}
					startLine={startLine}
				/>
			)}
			{isEdit && !editStreamingPreview && inputIsTruncated && !oldString && (
				<>
					<ContentViewer
						content={toolCall.inputJson.preview}
						style={codeStyle}
						title={fp ? basename(fp) : "Edit"}
						language={lang}
					/>
					<TruncatedBadge fullLength={toolCall.inputJson.fullLength} />
				</>
			)}
			{isWrite && (
				<>
					{fp && (
						<Text size="xs" c="dimmed" ff="monospace" mb={4} style={{ wordBreak: "break-all" }}>
							{fp}
						</Text>
					)}
					<ContentViewer
						content={writeContent}
						fullContent={writeFullContent}
						style={codeStyle}
						title={fp ? basename(fp) : "Write"}
						language={lang}
					/>
					{inputIsTruncated && <TruncatedBadge fullLength={toolCall.inputJson.fullLength} />}
				</>
			)}
			{!isEdit && !isWrite && toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mb={2}>
						{t("output")}
					</Text>
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={codeStyle}
						title={fp ? basename(fp) : "Output"}
						language={lang}
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
			{isEdit && !editStreamingPreview && !inputIsTruncated && !toolCall.inputJson?.old_string && (
				<ContentViewer
					content={resolveDisplayText(toolCall.inputJson)}
					style={codeStyle}
					title={fp ? basename(fp) : "Edit"}
					language="json"
				/>
			)}
			{isFailed && localizedError && (
				<Text size="xs" c="red" mt={4} style={{ whiteSpace: "pre-wrap" }}>
					{localizedError}
				</Text>
			)}
		</Box>
	);
}

/**
 * Terminate button for long-running tool calls (bash commands and MCP tools).
 * Rendered outside LazyCollapse so it's always visible without expanding the card.
 * Uses a local timer to detect ≥60s elapsed — no dependency on WS push.
 */
const LongRunningTerminateButton = memo(
	function LongRunningTerminateButton({
		toolCall,
		narratorId,
	}: {
		toolCall: ToolCallData;
		narratorId?: string;
	}) {
		const { t: tNarrator } = useTranslation("narrator");
		const interruptMutation = useInterruptNarrator();

		const isBash = BASH_TOOLS.has(toolCall.toolName);
		const isMcp = toolCall.toolName.startsWith("mcp__");
		const isLongRunnable = isBash || isMcp;
		const isRunning = toolCall.status === "running" && !!narratorId;

		// 本地 5s 轮询计算已运行时长。startedAt 来自 tool_started WS 事件，
		// 由 MessageBubble 从 message.toolCalls 传入。不依赖 WS 的 _longRunning 推送，
		// 因为 WS 可能因心跳超时断开。
		const [elapsed, setElapsed] = useState(0);
		useEffect(() => {
			if (!isLongRunnable || !isRunning || toolCall.startedAt == null) {
				setElapsed(0);
				return;
			}
			const update = () => setElapsed(Date.now() - (toolCall.startedAt ?? Date.now()));
			update();
			const timer = setInterval(update, 5_000);
			return () => clearInterval(timer);
		}, [isLongRunnable, isRunning, toolCall.startedAt]);

		// 60_000 与后端 LONG_RUNNING_THRESHOLD_MS 保持一致
		if (!isLongRunnable || !isRunning || elapsed < 60_000) return null;

		return (
			<Box mt={4} mb={2}>
				<Button
					size="xs"
					variant="light"
					color="red"
					leftSection={<IconPlayerStop size={14} />}
					loading={interruptMutation.isPending}
					onClick={() => narratorId && interruptMutation.mutate(narratorId)}
				>
					{tNarrator("terminateProcess")}
				</Button>
			</Box>
		);
	},
	(prev, next) => {
		return (
			prev.toolCall.toolName === next.toolCall.toolName &&
			prev.toolCall.status === next.toolCall.status &&
			prev.toolCall.startedAt === next.toolCall.startedAt &&
			prev.narratorId === next.narratorId
		);
	},
);

function BashDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const awaitParam = !isTruncated(toolCall.inputJson) ? toolCall.inputJson?.await : undefined;
	const isAwaitMode = awaitParam && typeof awaitParam === "object";
	const cmd = isAwaitMode ? null : extractField(toolCall.inputJson, "command");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);
	const isRunning = toolCall.status === "running" && !toolCall.outputJson;
	const streamingOutput = toolCall._streamingOutput;

	// Await mode metadata
	const awaitTaskId = isAwaitMode ? (awaitParam.task_id ?? awaitParam.taskId) : null;
	const awaitTimeout = isAwaitMode ? awaitParam.timeout : null;
	const awaitWaitForText = isAwaitMode ? awaitParam.wait_for_text : null;

	return (
		<Box mt="xs">
			{isAwaitMode && (
				<Group gap={6} mb={4}>
					<Badge size="xs" variant="light" color="blue">
						await
					</Badge>
					{awaitTaskId && <Code style={{ fontSize: 11 }}>{awaitTaskId}</Code>}
					{isRunning && <IconLoader2 size={12} style={{ animation: "spin 1s linear infinite" }} />}
					{awaitTimeout != null && (
						<Text size="xs" c="dimmed">
							timeout: {formatDurationText(awaitTimeout, { style: "timeout" })}
						</Text>
					)}
					{awaitWaitForText && (
						<Text size="xs" c="dimmed" truncate>
							wait_for: &quot;{awaitWaitForText}&quot;
						</Text>
					)}
				</Group>
			)}
			{cmd && (
				<ContentViewer
					content={cmd}
					style={{ ...termStyle, maxHeight: 60 }}
					title="Command"
					renderContent={(wordWrap) => (
						<Code
							block
							style={{
								...termStyle,
								maxHeight: 60,
								...(wordWrap
									? { whiteSpace: "pre-wrap", wordBreak: "break-all", overflowX: "hidden" }
									: { whiteSpace: "pre", overflowX: "auto" }),
								maxWidth: "100%",
							}}
						>
							{`$ ${cmd}`}
						</Code>
					)}
				/>
			)}
			{isRunning && streamingOutput && (
				<>
					<Text size="xs" fw={500} mt={4} mb={2}>
						{t("output")}
					</Text>
					<ContentViewer
						content={streamingOutput}
						style={termStyle}
						title={cmd ? `$ ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}` : "Shell"}
						autoFollow
						autoFollowKey={toolCall.toolUseId ?? "bash-output"}
					/>
				</>
			)}
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt={4} mb={2}>
						{t("output")}
					</Text>
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={termStyle}
						title={cmd ? `$ ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}` : "Shell"}
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
			{toolCall.errorMessage && !toolCall.outputJson && (
				<Text size="xs" c="red" mt={4}>
					{toolCall.errorMessage}
				</Text>
			)}
		</Box>
	);
}

function SearchDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const pattern = extractField(toolCall.inputJson, "pattern", "glob");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);
	const searchPath = extractField(toolCall.inputJson, "path");

	return (
		<Box mt="xs">
			{pattern && <Code style={{ fontSize: 11 }}>{pattern}</Code>}
			{searchPath && (
				<Text size="xs" c="dimmed">
					in {searchPath}
				</Text>
			)}
			{toolCall.status === "fail" && toolCall.errorMessage && (
				<Text size="xs" c="red" mt={4} style={{ whiteSpace: "pre-wrap" }}>
					{toolCall.errorMessage}
				</Text>
			)}
			{toolCall.status !== "fail" && toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt={4} mb={2}>
						{t("output")}
					</Text>
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={codeStyle}
						title={pattern || "Search"}
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
		</Box>
	);
}

function WebSearchDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const query = extractField(toolCall.inputJson, "query");
	const outputIsTruncated = isTruncated(toolCall.outputJson);
	const raw = resolveDisplayText(toolCall.outputJson);
	const rawFull = resolveFullDisplayText(toolCall.outputJson);

	// Try to parse structured search results from the output
	const results = useMemo(() => {
		if (!raw || outputIsTruncated) return null;
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed?.results)) return parsed.results;
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// not JSON — fall through
		}
		return null;
	}, [raw, outputIsTruncated]);

	return (
		<Box mt="xs">
			{query && <Code style={{ fontSize: 11 }}>{query}</Code>}
			{results ? (
				<Stack gap={6} mt={4}>
					{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
					{results.slice(0, 10).map((r: any, i: number) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: search results lack stable IDs
						<Box key={i}>
							<Text
								size="xs"
								fw={600}
								component="a"
								href={r.url}
								target="_blank"
								rel="noopener noreferrer"
								c="indigo"
								style={{ textDecoration: "none" }}
							>
								{r.title || r.url}
							</Text>
							{r.domain && (
								<Text size="xs" c="dimmed" ff="monospace">
									{r.domain}
								</Text>
							)}
							{r.snippet && (
								<Text size="xs" c="dimmed" lineClamp={2}>
									{r.snippet}
								</Text>
							)}
						</Box>
					))}
				</Stack>
			) : (
				raw && (
					<>
						<Text size="xs" fw={500} mt={4} mb={2}>
							{t("output")}
						</Text>
						<ContentViewer
							content={raw}
							fullContent={rawFull}
							style={codeStyle}
							title={query || "Web Search"}
							markdown
							contentType="markdown"
						/>
						{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
					</>
				)
			)}
			{toolCall.errorMessage && !toolCall.outputJson && (
				<Text size="xs" c="red" mt={4}>
					{toolCall.errorMessage}
				</Text>
			)}
		</Box>
	);
}

function WebFetchDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const fetchUrl = extractField(toolCall.inputJson, "url");
	const mode = extractField(toolCall.inputJson, "mode");
	const selector = extractField(toolCall.inputJson, "selector");
	const outputIsTruncated = isTruncated(toolCall.outputJson);
	const raw = resolveDisplayText(toolCall.outputJson);
	const rawFull = resolveFullDisplayText(toolCall.outputJson);

	// Localize known error messages
	const localizedError = useLocalizedToolError(toolCall.errorMessage);

	// For screenshot mode, check if there are images in the output metadata
	const isScreenshot = mode === "screenshot";
	const meta = toolCall.outputJson?._metadata ?? toolCall._metadata;
	const screenshotPreviewUrl = isScreenshot ? (meta?.previewUrl as string) : undefined;

	return (
		<Box mt="xs">
			{fetchUrl && (
				<Text
					size="xs"
					component="a"
					href={fetchUrl}
					target="_blank"
					rel="noopener noreferrer"
					c="teal"
					ff="monospace"
					style={{ textDecoration: "none" }}
				>
					{fetchUrl}
				</Text>
			)}
			{mode && (
				<Badge size="xs" variant="light" color="teal" mt={4}>
					{mode}
				</Badge>
			)}
			{selector && (
				<Text size="xs" c="dimmed" mt={2}>
					selector: <Code style={{ fontSize: 11 }}>{selector}</Code>
				</Text>
			)}
			{!isScreenshot && raw && (
				<>
					<Text size="xs" fw={500} mt={4} mb={2}>
						{t("output")}
					</Text>
					<ContentViewer
						content={raw}
						fullContent={rawFull}
						style={codeStyle}
						title={fetchUrl || "WebFetch"}
						markdown={mode === "smart" || mode === "readability"}
						contentType={mode === "smart" || mode === "readability" ? "markdown" : undefined}
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
			{isScreenshot && screenshotPreviewUrl && (
				<Box mt="xs">
					<img
						src={screenshotPreviewUrl}
						alt={fetchUrl || "screenshot"}
						style={{
							maxWidth: "100%",
							maxHeight: 400,
							borderRadius: "var(--mantine-radius-sm)",
							objectFit: "contain",
							display: "block",
						}}
					/>
					{raw && (
						<Text size="xs" c="dimmed" mt={4}>
							{raw}
						</Text>
					)}
				</Box>
			)}
			{isScreenshot && !screenshotPreviewUrl && raw && (
				<Text size="xs" c="dimmed" mt={4}>
					{raw}
				</Text>
			)}
			{localizedError && !toolCall.outputJson && (
				<Text size="xs" c="red" mt={4}>
					{localizedError}
				</Text>
			)}
		</Box>
	);
}

function TerminalDetail({ toolCall }: { toolCall: ToolCallData }) {
	const action = extractField(toolCall.inputJson, "action");
	const terminalId = extractField(toolCall.inputJson, "terminal_id");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);

	if (action === "write") {
		const input = extractField(toolCall.inputJson, "input");
		return (
			<Box mt="xs">
				{terminalId && (
					<Text size="xs" c="dimmed" mb={2}>
						Terminal: <Code style={{ fontSize: 11 }}>{terminalId}</Code>
					</Text>
				)}
				{input && (
					<ContentViewer
						content={input}
						style={{ ...termStyle, maxHeight: 60 }}
						title="Terminal Input"
					/>
				)}
				{toolCall.outputJson && (
					<Text size="xs" c="dimmed" mt={4}>
						{outputText}
					</Text>
				)}
				{toolCall.errorMessage && !toolCall.outputJson && (
					<Text size="xs" c="red" mt={4}>
						{toolCall.errorMessage}
					</Text>
				)}
			</Box>
		);
	}

	if (action === "read") {
		return (
			<Box mt="xs">
				{terminalId && (
					<Text size="xs" c="dimmed" mb={2}>
						Terminal: <Code style={{ fontSize: 11 }}>{terminalId}</Code>
					</Text>
				)}
				{toolCall.outputJson && (
					<>
						<ContentViewer
							content={outputText}
							fullContent={outputFullText}
							style={termStyle}
							title="Terminal Buffer"
						/>
						{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
					</>
				)}
				{toolCall.errorMessage && !toolCall.outputJson && (
					<Text size="xs" c="red" mt={4}>
						{toolCall.errorMessage}
					</Text>
				)}
			</Box>
		);
	}

	// action === "list" or fallback
	return (
		<Box mt="xs">
			{toolCall.outputJson && (
				<ContentViewer
					content={outputText}
					fullContent={outputFullText}
					style={codeStyle}
					title="Terminals"
				/>
			)}
			{toolCall.errorMessage && !toolCall.outputJson && (
				<Text size="xs" c="red" mt={4}>
					{toolCall.errorMessage}
				</Text>
			)}
		</Box>
	);
}

function ShareFilePreview({
	previewUrl,
	previewType,
	filename,
}: {
	previewUrl: string;
	previewType: string;
	filename: string;
}) {
	const { t } = useTranslation("narrator");
	const [error, setError] = useState(false);

	if (error) {
		return (
			<Text size="xs" c="dimmed" mt="xs">
				{t("shareFile.previewFailed")}
			</Text>
		);
	}

	if (previewType === "image") {
		return (
			<Box mt="xs">
				<img
					src={previewUrl}
					alt={filename}
					onError={() => setError(true)}
					style={{
						maxWidth: "100%",
						maxHeight: 400,
						borderRadius: "var(--mantine-radius-sm)",
						objectFit: "contain",
						display: "block",
					}}
				/>
			</Box>
		);
	}

	if (previewType === "video") {
		return (
			<Box mt="xs">
				{/* biome-ignore lint/a11y/useMediaCaption: user-shared file, no captions available */}
				<video
					src={previewUrl}
					controls
					onError={() => setError(true)}
					style={{
						maxWidth: "100%",
						maxHeight: 400,
						borderRadius: "var(--mantine-radius-sm)",
						display: "block",
					}}
				/>
			</Box>
		);
	}

	if (previewType === "pdf" || previewType === "html") {
		return (
			<Box mt="xs">
				<iframe
					src={previewUrl}
					title={filename}
					onError={() => setError(true)}
					// HTML: allow-same-origin only (no allow-scripts) — sanitized HTML
					// doesn't need JS execution, and omitting scripts prevents XSS.
					// PDF: allow-same-origin + allow-scripts — the browser's built-in
					// PDF viewer (pdf.js) requires script execution to render.
					sandbox={previewType === "html" ? "allow-same-origin" : "allow-same-origin allow-scripts"}
					style={{
						width: "100%",
						height: 400,
						border: "1px solid var(--mantine-color-default-border)",
						borderRadius: "var(--mantine-radius-sm)",
						background: "var(--mantine-color-body)",
					}}
				/>
			</Box>
		);
	}

	return null;
}

function ShareFileDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const clipboard = useClipboard({ timeout: 2000 });
	const shareCapability = useShareCapability();
	const meta = toolCall.outputJson?._metadata ?? toolCall._metadata;

	const filename = (meta?.filename as string) ?? "file";
	const sizeFormatted = (meta?.sizeFormatted as string) ?? "";
	const downloadUrl = meta?.downloadUrl as string | undefined;
	const expiresAt = meta?.expiresAt as string | undefined;
	const expiryHours = meta?.expiryHours as number | undefined;
	const isDirectory = meta?.isDirectory as boolean | undefined;
	const compressed = meta?.compressed as boolean | undefined;
	const format = meta?.format as string | undefined;
	const fileCount = meta?.fileCount as number | undefined;
	const preview = meta?.preview as boolean | undefined;
	const previewType = meta?.previewType as string | undefined;
	const previewUrl = meta?.previewUrl as string | undefined;
	const previewSupported = shareCapability.previewSupported;
	const usesEscapedHtmlPreview =
		previewType === "html" && shareCapability.previewHtmlMode === "escaped-pre";
	const htmlPreviewWarning = shareCapability.previewReason ?? t("shareFile.escapedHtmlPreviewDesc");
	const showSharePersistenceWarning =
		!shareCapability.ephemeralOnlySupported || shareCapability.ephemeralOnlyFallback;
	const sharePersistenceWarning =
		shareCapability.ephemeralOnlyReason ?? t("shareFile.persistenceWarning");

	const expiresLabel = useMemo(() => {
		if (!expiresAt) return null;
		try {
			return new Date(expiresAt).toLocaleString();
		} catch {
			return expiresAt;
		}
	}, [expiresAt]);

	// Fallback to generic if no structured metadata
	if (!downloadUrl) {
		return <GenericDetail toolCall={toolCall} />;
	}

	return (
		<Box mt="xs">
			<Paper
				p="sm"
				radius="md"
				withBorder
				style={{
					borderColor: "var(--mantine-color-green-light)",
					backgroundColor: "var(--mantine-color-green-light)",
				}}
			>
				<Group gap="sm" wrap="nowrap" align="flex-start">
					<ThemeIcon size={36} radius="md" variant="light" color="green">
						<IconShare size={20} />
					</ThemeIcon>
					<Box style={{ flex: 1, minWidth: 0 }}>
						<Text size="sm" fw={600} truncate="end">
							{filename}
						</Text>
						<Group gap="xs" mt={2}>
							{sizeFormatted && (
								<Badge size="xs" variant="light" color="gray">
									{sizeFormatted}
								</Badge>
							)}
							{isDirectory && (
								<Badge size="xs" variant="light" color="blue">
									{t("shareFile.directory")}
								</Badge>
							)}
							{format === "zip" ? (
								<Badge size="xs" variant="light" color="violet">
									{t("shareFile.zip")}
								</Badge>
							) : (
								compressed && (
									<Badge size="xs" variant="light" color="violet">
										{t("shareFile.compressed")}
									</Badge>
								)
							)}
							{fileCount != null && fileCount > 0 && (
								<Badge size="xs" variant="light" color="cyan">
									{t("shareFile.fileCount", { count: fileCount })}
								</Badge>
							)}
							{preview && previewType && previewSupported && (
								<Badge size="xs" variant="light" color="teal">
									{t("shareFile.preview")}
								</Badge>
							)}
							{usesEscapedHtmlPreview && (
								<Tooltip label={htmlPreviewWarning} withArrow multiline maw={360}>
									<Badge size="xs" variant="light" color="gray">
										{t("shareFile.escapedHtmlPreview")}
									</Badge>
								</Tooltip>
							)}
							{preview && previewType && !previewSupported && (
								<Badge size="xs" variant="light" color="orange">
									{t("shareFile.previewUnavailable")}
								</Badge>
							)}

							{expiresLabel && (
								<Tooltip label={`Expires: ${expiresLabel}`} withArrow>
									<Badge size="xs" variant="light" color="yellow">
										{expiryHours}h
									</Badge>
								</Tooltip>
							)}
							{showSharePersistenceWarning && (
								<Tooltip label={sharePersistenceWarning} withArrow multiline maw={360}>
									<Badge size="xs" variant="light" color="orange">
										{t("shareFile.diskFallback")}
									</Badge>
								</Tooltip>
							)}
						</Group>
					</Box>
					<Button
						component="a"
						href={downloadUrl}
						target="_blank"
						rel="noopener noreferrer"
						size="compact-sm"
						variant="light"
						color="green"
						leftSection={<IconDownload size={14} />}
					>
						{t("shareFile.download")}
					</Button>
					<Tooltip
						label={clipboard.copied ? t("shareFile.linkCopied") : t("shareFile.copyLink")}
						withArrow
					>
						<Button
							size="compact-sm"
							variant="light"
							color={clipboard.copied ? "teal" : "gray"}
							leftSection={clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
							onClick={() => clipboard.copy(`${window.location.origin}${downloadUrl}`)}
						>
							{clipboard.copied ? t("shareFile.linkCopied") : t("shareFile.copyLink")}
						</Button>
					</Tooltip>
				</Group>
				{preview && previewUrl && previewType && previewSupported && (
					<ShareFilePreview previewUrl={previewUrl} previewType={previewType} filename={filename} />
				)}
				{preview && previewUrl && previewType && !previewSupported && (
					<Text size="xs" c="dimmed" mt="xs">
						{t("shareFile.previewUnavailableDesc")}
					</Text>
				)}
			</Paper>
		</Box>
	);
}

interface RecallResult {
	id: string;
	narratorId: string;
	narratorTitle: string | null;
	chapterId: string | null;
	role: string;
	createdAt: string;
	snippet: string;
}

function RecallDetail({ toolCall }: { toolCall: ToolCallData }) {
	const meta = toolCall.outputJson?._metadata ?? toolCall._metadata;
	const action = meta?.action as string | undefined;

	if (!meta || (action !== "search" && action !== "read_conversation")) {
		return <GenericDetail toolCall={toolCall} />;
	}

	if (action === "search") {
		// For batch queries, results are merged from all sub-queries
		const allResults = (Array.isArray(meta.results) ? meta.results : []) as Array<RecallResult>;
		const visibleResults = allResults.slice(0, TOOLCARD_RECALL_MAX_RESULTS);
		const hiddenResultCount = Math.max(0, allResults.length - visibleResults.length);
		const queries = Array.isArray(meta.queries) ? meta.queries : meta.query ? [meta.query] : [];
		const visibleQueries = queries.slice(0, TOOLCARD_RECALL_MAX_QUERY_BADGES);
		const hiddenQueryCount = Math.max(0, queries.length - visibleQueries.length);

		if (allResults.length === 0) {
			const queryLabel = visibleQueries
				.map((q: string) => `"${capToolCardDisplayText(q, 80)}"`)
				.join(", ");
			return (
				<Box mt="xs">
					<Text size="xs" c="dimmed">
						No results found
						{queryLabel && ` for ${queryLabel}${hiddenQueryCount > 0 ? ", …" : ""}`}.
					</Text>
				</Box>
			);
		}

		return (
			<Box mt="xs">
				{queries.length > 0 && (
					<Group gap={4} mb={6} wrap="wrap">
						{visibleQueries.map((q: string, i: number) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static badge list, no reordering
							<Badge key={`${i}:${q}`} size="xs" variant="light" color="cyan">
								{capToolCardDisplayText(q, 80)}
							</Badge>
						))}
						{hiddenQueryCount > 0 && (
							<Badge size="xs" variant="outline" color="gray">
								+{hiddenQueryCount}
							</Badge>
						)}
					</Group>
				)}
				<Stack gap={4}>
					{visibleResults.map((r: RecallResult) => (
						<Paper
							key={r.id}
							p={6}
							radius="sm"
							style={{
								backgroundColor: "var(--mantine-color-dark-7)",
								border: "1px solid var(--mantine-color-dark-5)",
							}}
						>
							<Group gap={6} mb={2} wrap="nowrap">
								<Badge
									size="xs"
									variant="light"
									color={r.role === "user" ? "blue" : r.role === "assistant" ? "green" : "gray"}
								>
									{r.role}
								</Badge>
								{r.narratorTitle && (
									<Text size="xs" fw={500} truncate style={{ flex: 1, minWidth: 0 }}>
										{r.narratorTitle}
									</Text>
								)}
								<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
									{formatRecallTime(r.createdAt)}
								</Text>
							</Group>
							<Text size="xs" c="dimmed" lineClamp={2} style={{ whiteSpace: "pre-wrap" }}>
								{capToolCardDisplayText(
									r.snippet.replace(/>>>/g, "").replace(/<<</g, "").trim(),
									1_000,
								)}
							</Text>

							<Group gap={4} mt={2}>
								<Code style={{ fontSize: 10 }}>{r.id.slice(0, 8)}</Code>
								{r.chapterId && (
									<Text size="xs" c="dimmed">
										ch:{r.chapterId.slice(0, 8)}
									</Text>
								)}
							</Group>
						</Paper>
					))}
					{hiddenResultCount > 0 && (
						<Text size="xs" c="dimmed" ta="center">
							Showing first {visibleResults.length} results; {hiddenResultCount} more hidden.
						</Text>
					)}
				</Stack>
			</Box>
		);
	}

	// action === "read_conversation"
	const messages = Array.isArray(meta.messages) ? meta.messages : [];
	const visibleMessages = messages.slice(0, TOOLCARD_RECALL_MAX_MESSAGES);
	const hiddenMessageCount = Math.max(0, messages.length - visibleMessages.length);
	const narratorTitle = meta.narratorTitle as string | undefined;
	const model = meta.model as string | undefined;

	return (
		<Box mt="xs">
			<Group gap={6} mb={6}>
				{narratorTitle && (
					<Text size="xs" fw={600}>
						{narratorTitle}
					</Text>
				)}
				{model && (
					<Badge size="xs" variant="outline" color="gray">
						{model}
					</Badge>
				)}
			</Group>
			<Stack gap={2}>
				{visibleMessages.map(
					(msg: { id: string; seq: number; role: string; text: string; createdAt: string }) => (
						<Box
							key={msg.id}
							p={6}
							style={{
								backgroundColor:
									msg.role === "user" ? "var(--mantine-color-indigo-light)" : undefined,
								borderRadius: "var(--mantine-radius-sm)",
							}}
						>
							<Group gap={6} mb={2}>
								<Badge
									size="xs"
									variant="light"
									color={msg.role === "user" ? "blue" : msg.role === "assistant" ? "green" : "gray"}
								>
									{msg.role}
								</Badge>
								<Text size="xs" c="dimmed">
									seq {msg.seq}
								</Text>
								<Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
									{formatRecallTime(msg.createdAt)}
								</Text>
							</Group>
							<Text
								size="xs"
								lineClamp={4}
								style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
							>
								{msg.text
									? capToolCardDisplayText(msg.text, TOOLCARD_RECALL_MESSAGE_TEXT_CHARS)
									: "—"}
							</Text>
						</Box>
					),
				)}
				{hiddenMessageCount > 0 && (
					<Text size="xs" c="dimmed" ta="center">
						Showing first {visibleMessages.length} messages; {hiddenMessageCount} more hidden.
					</Text>
				)}
			</Stack>
		</Box>
	);
}

function formatRecallTime(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

function SkillDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const output = resolveDisplayText(toolCall.outputJson);

	if (!output || toolCall.status === "fail") {
		return <GenericDetail toolCall={toolCall} />;
	}

	// Extract skill name from <skill_content name="...">
	const nameMatch = output.match(/<skill_content\s+name="([^"]+)">/);
	const skillName = nameMatch?.[1] ?? extractField(toolCall.inputJson, "skill", "name");

	// Extract file list from <skill_files>
	const filesMatch = output.match(/<skill_files>([\s\S]*?)<\/skill_files>/);
	const files: string[] = [];
	if (filesMatch) {
		for (const m of filesMatch[1].matchAll(/<file>([^<]+)<\/file>/g)) {
			files.push(m[1]);
		}
	}
	const visibleFiles = files.slice(0, TOOLCARD_SKILL_MAX_FILES);
	const hiddenFileCount = Math.max(0, files.length - visibleFiles.length);

	// Extract content between header and base directory / skill_files
	let content = "";
	const skillTagIdx = output.indexOf("<skill_content");
	if (skillTagIdx !== -1) {
		const contentStart = output.indexOf("\n\n", skillTagIdx);
		const contentEnd = output.indexOf("\nBase directory for this skill:");
		if (contentStart !== -1 && contentEnd !== -1 && contentEnd > contentStart) {
			content = output.slice(contentStart + 2, contentEnd).trim();
			// Remove the "# Skill: ..." header line if present
			content = content.replace(/^#\s+Skill:\s+.+\n*/, "").trim();
		}
	}

	// Fallback to GenericDetail when we couldn't extract anything useful
	if (!skillName && !content && files.length === 0) {
		return <GenericDetail toolCall={toolCall} />;
	}

	return (
		<Box mt="xs">
			{skillName && (
				<Group gap={6} mb={6}>
					<Badge size="xs" variant="light" color="grape">
						{skillName}
					</Badge>
					<Text size="xs" c="dimmed">
						{t("toolSkillLoaded")}
					</Text>
				</Group>
			)}
			{content && (
				<ContentViewer
					content={content}
					style={{ ...codeStyle, maxHeight: 400 }}
					title={`Skill: ${skillName || "content"}`}
				/>
			)}
			{files.length > 0 && (
				<Box mt={6}>
					<Text size="xs" fw={500} mb={4}>
						{t("toolSkillFiles")}
					</Text>
					<Group gap={4} wrap="wrap">
						{visibleFiles.map((f) => (
							<Badge key={f} size="xs" variant="dot" color="gray">
								{basename(f)}
							</Badge>
						))}
						{hiddenFileCount > 0 && (
							<Badge size="xs" variant="outline" color="gray">
								+{hiddenFileCount}
							</Badge>
						)}
					</Group>
				</Box>
			)}
		</Box>
	);
}

function BrowserDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const action = extractField(toolCall.inputJson, "action");
	const url = extractField(toolCall.inputJson, "url");
	const selector = extractField(toolCall.inputJson, "selector");
	const sessionId = extractField(toolCall.inputJson, "session_id");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);
	const meta = toolCall.outputJson?._metadata ?? toolCall._metadata;
	const previewUrl = meta?.previewUrl as string | undefined;
	const isScreenshot = action === "screenshot";
	const localizedError = useLocalizedToolError(toolCall.errorMessage);

	return (
		<Box mt="xs">
			<Group gap={6} mb={4}>
				{action && (
					<Badge size="xs" variant="light" color="teal">
						{action}
					</Badge>
				)}
				{sessionId && (
					<Tooltip label={sessionId} fz="xs">
						<Badge size="xs" variant="outline" color="dimmed">
							{sessionId.slice(0, 8)}
						</Badge>
					</Tooltip>
				)}
			</Group>
			{url && (
				<Text
					size="xs"
					component="a"
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					c="teal"
					ff="monospace"
					style={{ textDecoration: "none" }}
				>
					{url}
				</Text>
			)}
			{isScreenshot && previewUrl && (
				<Box mt="xs">
					<img
						src={previewUrl}
						alt={t("browser.screenshotAlt")}
						style={{
							maxWidth: "100%",
							maxHeight: 400,
							borderRadius: "var(--mantine-radius-sm)",
							objectFit: "contain",
							display: "block",
						}}
					/>
					{typeof meta?.width === "number" && typeof meta?.height === "number" && (
						<Text size="xs" c="dimmed" mt={2}>
							{meta.width}×{meta.height}
						</Text>
					)}
				</Box>
			)}
			{isScreenshot && !previewUrl && outputText && (
				<Text size="xs" c="dimmed" mt={4}>
					{outputText}
				</Text>
			)}
			{action === "dom" && outputText && (
				<>
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={codeStyle}
						title={selector || "DOM"}
						language="html"
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
			{!isScreenshot && action !== "dom" && outputText && (
				<>
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={codeStyle}
						title={action || "Browser"}
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
			{localizedError && !toolCall.outputJson && (
				<Text size="xs" c="red" mt={4}>
					{localizedError}
				</Text>
			)}
		</Box>
	);
}

const SUBAGENT_ID_TAG_RE = /<subagent_id>([^<]+)<\/subagent_id>/;

function stripSubagentIdTag(text: string): { subagentId?: string; text: string } {
	const match = text.match(SUBAGENT_ID_TAG_RE);
	return {
		subagentId: match?.[1],
		text: text.replace(SUBAGENT_ID_TAG_RE, "").trim(),
	};
}

function AwaitDetail({ toolCall }: { toolCall: ToolCallData }) {
	const input = toolCall.inputJson;
	const metadata = (toolCall.outputJson?._metadata ?? toolCall._metadata) as
		| Record<string, unknown>
		| undefined;
	const awaitType =
		extractField(input, "type") || (metadata?.awaitType as string | undefined) || "task";
	const targetId = extractField(input, "id") || (metadata?.targetId as string | undefined) || "";
	const resolvedId = metadata?.resolvedId as string | undefined;
	const status = (metadata?.status as string | undefined) ?? toolCall.status;
	const waitForText =
		extractField(input, "wait_for_text") || (metadata?.waitForText as string | undefined);
	const timeout = !isTruncated(input) ? input?.timeout : undefined;
	const rawOutput = resolveDisplayText(toolCall.outputJson);
	const rawFullOutput = resolveFullDisplayText(toolCall.outputJson);
	const { subagentId, text: strippedOutput } = stripSubagentIdTag(rawOutput);
	const strippedFullOutput = rawFullOutput ? stripSubagentIdTag(rawFullOutput).text : undefined;
	const effectiveSubagentId = (metadata?.subagentId as string | undefined) ?? subagentId;

	return (
		<Box mt="xs">
			<Group gap={6} mb={6} wrap="wrap">
				<Badge size="xs" color={awaitType === "bash" ? "orange" : "indigo"} variant="light">
					{awaitType}
				</Badge>
				{targetId && (
					<Badge size="xs" color="gray" variant="outline">
						{targetId}
					</Badge>
				)}
				{resolvedId && resolvedId !== targetId && (
					<Badge size="xs" color="gray" variant="outline">
						→ {resolvedId}
					</Badge>
				)}
				<Badge size="xs" color={STATUS_COLORS[status] ?? "gray"} variant="light">
					{status}
				</Badge>
				{typeof timeout === "number" && (
					<Badge size="xs" color="gray" variant="light">
						{formatDurationText(timeout, { style: "timeout" })}
					</Badge>
				)}
			</Group>
			{waitForText && (
				<Text size="xs" c="dimmed" mb={4}>
					Waiting for text: <Code>{waitForText}</Code>
				</Text>
			)}
			{effectiveSubagentId && awaitType === "agent" && (
				<Text size="xs" c="dimmed" mb={4} ff="monospace">
					Subagent: {effectiveSubagentId}
				</Text>
			)}
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt={4} mb={2}>
						{awaitType === "bash" ? "Output" : "Result"}
					</Text>
					{awaitType === "bash" ? (
						<ContentViewer
							content={strippedOutput}
							fullContent={strippedFullOutput}
							style={termStyle}
							title="Await output"
						/>
					) : (
						<ContentViewer
							content={strippedOutput}
							fullContent={strippedFullOutput}
							style={codeStyle}
							title="Await result"
							markdown
						/>
					)}
				</>
			)}
		</Box>
	);
}

interface SendTargetMeta {
	id?: string;
	title?: string | null;
	status?: string;
	interrupted?: boolean;
	awaited?: boolean;
	error?: string;
}

function SendDetail({ toolCall }: { toolCall: ToolCallData }) {
	const input = toolCall.inputJson;
	const metadata = (toolCall.outputJson?._metadata ?? toolCall._metadata) as
		| { targets?: SendTargetMeta[]; doInterrupt?: boolean; await?: boolean }
		| undefined;
	const targets = getSendTargetLabels(input);
	const message = isTruncated(input) ? input.preview : (input?.message ?? "");
	const rawOutput = resolveDisplayText(toolCall.outputJson);
	const rawFullOutput = resolveFullDisplayText(toolCall.outputJson);
	const isAwait = !isTruncated(input) ? !!input?.await : !!metadata?.await;
	const doInterrupt = !isTruncated(input) ? !!input?.doInterrupt : !!metadata?.doInterrupt;
	const targetMeta = Array.isArray(metadata?.targets) ? metadata.targets : [];

	return (
		<Box mt="xs">
			<Group gap={6} mb={6} wrap="wrap">
				{targets.length > 0 ? (
					targets.map((target) => (
						<Badge key={target} size="xs" color="blue" variant="light">
							→ {target}
						</Badge>
					))
				) : (
					<Badge size="xs" color="blue" variant="light">
						Subagent message
					</Badge>
				)}
				<Badge size="xs" color={isAwait ? "indigo" : "gray"} variant="light">
					{isAwait ? "await" : "async"}
				</Badge>
				{doInterrupt && (
					<Badge size="xs" color="orange" variant="light">
						interrupt
					</Badge>
				)}
			</Group>
			{message && (
				<>
					<Text size="xs" fw={500} mb={2}>
						Message
					</Text>
					<ContentViewer content={message} style={codeStyle} title="Send message" markdown />
				</>
			)}
			{targetMeta.length > 0 && (
				<Stack gap={4} mt="xs">
					<Text size="xs" fw={500}>
						Delivery
					</Text>
					{targetMeta.map((target) => (
						<Group key={target.id ?? target.title ?? target.error} gap={6} wrap="nowrap">
							<Badge size="xs" color={STATUS_COLORS[target.status ?? ""] ?? "gray"} variant="light">
								{target.status ?? "sent"}
							</Badge>
							<Text size="xs" truncate title={target.error ?? target.id ?? target.title ?? ""}>
								{target.title || target.id || "target"}
								{target.interrupted ? " · interrupted" : ""}
								{target.error ? ` · ${target.error}` : ""}
							</Text>
						</Group>
					))}
				</Stack>
			)}
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt="xs" mb={2}>
						{isAwait ? "Reply" : "Result"}
					</Text>
					<ContentViewer
						content={rawOutput}
						fullContent={rawFullOutput}
						style={codeStyle}
						title="Send result"
						markdown
					/>
				</>
			)}
		</Box>
	);
}

interface GoalView {
	id?: string;
	objective?: string;
	status?: string;
	tokensUsed?: number;
	timeUsedSeconds?: number;
}

function parseGoalToolPayload(value: unknown): Record<string, unknown> | null {
	if (!value) return null;
	const raw = collectToolCardTextPreview(value);
	if (!raw && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (!raw.trim()) return null;
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function coerceGoal(value: unknown): GoalView | null {
	if (!value || typeof value !== "object") return null;
	const goal = value as Record<string, unknown>;
	return {
		id: typeof goal.id === "string" ? goal.id : undefined,
		objective: typeof goal.objective === "string" ? goal.objective : undefined,
		status: typeof goal.status === "string" ? goal.status : undefined,
		tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : undefined,
		timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : undefined,
	};
}

function goalStatusColor(status?: string): string {
	switch (status) {
		case "active":
			return "green";
		case "pending":
			return "yellow";
		case "paused":
			return "orange";
		case "complete":
			return "blue";
		case "cancelled":
			return "gray";
		default:
			return "gray";
	}
}

function GoalRow({ goal, index }: { goal: GoalView; index?: number }) {
	return (
		<Group gap="xs" wrap="nowrap" align="flex-start">
			{index != null && (
				<Text size="xs" c="dimmed" ff="monospace" style={{ width: 18, flexShrink: 0 }}>
					{index + 1}.
				</Text>
			)}
			<Badge
				size="xs"
				variant="light"
				color={goalStatusColor(goal.status)}
				style={{ flexShrink: 0 }}
			>
				{goal.status ?? "goal"}
			</Badge>
			<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
				<Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
					{goal.objective ?? "—"}
				</Text>
				{(goal.timeUsedSeconds != null || goal.tokensUsed != null) && (
					<Text size="xs" c="dimmed">
						{goal.timeUsedSeconds ?? 0}s · {goal.tokensUsed ?? 0} tokens
					</Text>
				)}
			</Stack>
		</Group>
	);
}

function GoalDetail({ toolCall }: { toolCall: ToolCallData }) {
	const payload = parseGoalToolPayload(toolCall.outputJson);
	const goals = Array.isArray(payload?.goals)
		? payload.goals.map(coerceGoal).filter((goal): goal is GoalView => Boolean(goal))
		: [];
	const active = coerceGoal(payload?.active);
	const added = coerceGoal(payload?.added);
	const completed = coerceGoal(payload?.completed);

	if (!payload && goals.length === 0 && !active && !added && !completed) {
		return <GenericDetail toolCall={toolCall} />;
	}

	return (
		<Box mt="xs">
			<Stack gap="xs">
				{toolCall.toolName === "AddGoal" && (
					<GoalRow goal={added ?? { objective: extractField(toolCall.inputJson, "objective") }} />
				)}
				{toolCall.toolName === "UpdateGoal" && completed && (
					<>
						<Text size="xs" fw={600} c="dimmed">
							Completed
						</Text>
						<GoalRow goal={completed} />
					</>
				)}
				{toolCall.toolName === "GetGoals" && active && (
					<>
						<Text size="xs" fw={600} c="dimmed">
							Active
						</Text>
						<GoalRow goal={active} />
					</>
				)}
				{goals.length > 0 ? (
					<>
						<Text size="xs" fw={600} c="dimmed">
							Goal list
						</Text>
						<Stack gap={6}>
							{goals.map((goal, index) => (
								<GoalRow key={goal.id ?? index} goal={goal} index={index} />
							))}
						</Stack>
					</>
				) : (
					toolCall.toolName === "GetGoals" && (
						<Text size="xs" c="dimmed">
							No open goals.
						</Text>
					)
				)}
			</Stack>
		</Box>
	);
}

interface ParsedPipelineResult {
	aliases: string;
	captured: string;
	rule: string;
	body: string;
}

interface ParsedPipelineCapture {
	alias: string;
	toolName: string;
	bytes: string;
}

function parsePipelineResultOutput(text: string): ParsedPipelineResult | null {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[0]?.trim() !== "Pipeline result") return null;
	const blankIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "");
	const headerLines = blankIndex === -1 ? lines.slice(1) : lines.slice(1, blankIndex);
	const body = blankIndex === -1 ? "" : lines.slice(blankIndex + 1).join("\n");
	const pick = (prefix: string) =>
		headerLines
			.find((line) => line.startsWith(prefix))
			?.slice(prefix.length)
			.trim() ?? "";
	return {
		aliases: pick("Aliases used:"),
		captured: pick("Captured:"),
		rule: pick("Rule:"),
		body,
	};
}

function parsePipelineCaptures(captured: string): ParsedPipelineCapture[] {
	if (!captured || captured === "(none)") return [];
	return captured.split(/,\s*/).map((entry) => {
		const match = entry.match(/^([^=]+)=([^()]+)\(([^)]*)\)$/);
		return match
			? { alias: match[1], toolName: match[2], bytes: match[3] }
			: { alias: entry, toolName: "capture", bytes: "" };
	});
}

function formatPipelineBytes(value: string): string {
	const normalized = value.trim().replace(/B$/i, "");
	const bytes = Number(normalized);
	if (!Number.isFinite(bytes)) return value;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function PipelineDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const isStart = toolCall.toolName === "StartPipeline";
	const label = extractField(toolCall.inputJson, "label");
	const maxPreviewChars = extractNumericField(toolCall.inputJson, "maxPreviewChars") ?? 100;
	const aliases = extractStringArrayField(toolCall.inputJson, "aliases");
	const inputRule = extractField(toolCall.inputJson, "rule");
	const format = extractField(toolCall.inputJson, "format") || "sections";
	const maxChars = extractNumericField(toolCall.inputJson, "maxChars");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);
	const parsed = !isStart && outputText ? parsePipelineResultOutput(outputText) : null;
	const parsedFull = !isStart && outputFullText ? parsePipelineResultOutput(outputFullText) : null;
	const capturedEntries = parsePipelineCaptures(parsed?.captured ?? "");
	const parsedAliases = parsed?.aliases && parsed.aliases !== "(none)" ? parsed.aliases : "";
	const aliasList = parsedAliases
		? parsedAliases
				.split(/,\s*/)
				.map((alias) => alias.trim())
				.filter(Boolean)
		: aliases;
	const rule = inputRule || parsed?.rule || (aliases.length > 0 ? `from ${aliases.join(" ")}` : "");
	const isFailed = toolCall.status === "fail";

	return (
		<Box mt="xs">
			<Group gap={6} wrap="wrap" mb={rule || capturedEntries.length > 0 || outputText ? 4 : 0}>
				<Badge size="xs" variant="light" color={isStart ? "blue" : "indigo"}>
					{isStart ? t("pipelineStageStart") : t("pipelineStageEnd")}
				</Badge>
				{label && (
					<Badge size="xs" variant="outline" color="gray">
						{label}
					</Badge>
				)}
				{format && !isStart && (
					<Badge size="xs" variant="outline" color="gray">
						{format}
					</Badge>
				)}
				{isStart && (
					<Badge size="xs" variant="outline" color="gray">
						{t("pipelinePreviewChars", { value: maxPreviewChars.toLocaleString() })}
					</Badge>
				)}
				{maxChars != null && (
					<Badge size="xs" variant="outline" color="gray">
						{t("pipelineMaxChars", { value: maxChars.toLocaleString() })}
					</Badge>
				)}
				{aliasList.map((alias) => (
					<Badge key={alias} size="xs" variant="dot" color="indigo">
						{alias}
					</Badge>
				))}
			</Group>

			{rule && (
				<Box mt={4}>
					<Text size="xs" fw={500} mb={2}>
						{t("pipelineRule")}
					</Text>
					<Code
						block
						style={{
							fontSize: 11,
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
						}}
					>
						{rule}
					</Code>
				</Box>
			)}

			{capturedEntries.length > 0 && (
				<Stack gap={4} mt="xs">
					<Text size="xs" fw={500}>
						{t("pipelineCapturedAliases")}
					</Text>
					{capturedEntries.map((entry) => (
						<Group key={`${entry.alias}-${entry.toolName}`} gap={6} wrap="nowrap">
							<Badge size="xs" variant="light" color="indigo" miw={34}>
								{entry.alias}
							</Badge>
							<Text size="xs" ff="monospace" style={{ flex: 1, minWidth: 0 }} truncate>
								{entry.toolName}
							</Text>
							{entry.bytes && (
								<Text size="xs" c="dimmed" ff="monospace">
									{formatPipelineBytes(entry.bytes)}
								</Text>
							)}
						</Group>
					))}
				</Stack>
			)}

			{isFailed && outputText && (
				<Text size="xs" c="red" mt="xs" style={{ whiteSpace: "pre-wrap" }}>
					{outputText}
				</Text>
			)}
			{!isFailed && parsed?.body && (
				<Box mt="xs">
					<Text size="xs" fw={500} mb={2}>
						{t("pipelineOutput")}
					</Text>
					<ContentViewer
						content={parsed.body}
						fullContent={parsedFull?.body}
						style={termStyle}
						title={t("pipelineResult")}
					/>
				</Box>
			)}
			{!isFailed && !parsed && outputText && isStart && (
				<Text size="xs" c="dimmed" mt="xs" style={{ whiteSpace: "pre-wrap" }}>
					{outputText}
				</Text>
			)}
			{!isFailed && !parsed && outputText && !isStart && (
				<Box mt="xs">
					<Text size="xs" fw={500} mb={2}>
						{t("pipelineOutput")}
					</Text>
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={termStyle}
						title={t("pipelineOutput")}
					/>
				</Box>
			)}
			{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
		</Box>
	);
}

function GenericDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const inputText = resolveDisplayText(toolCall.inputJson);
	const inputFullText = resolveFullDisplayText(toolCall.inputJson);
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const inputIsTruncated = isTruncated(toolCall.inputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);

	return (
		<Box mt="xs">
			<Text size="xs" fw={500} mb={2}>
				{t("input")}
			</Text>
			<ContentViewer
				content={inputText}
				fullContent={inputFullText}
				style={codeStyle}
				title={`${toolCall.toolName} Input`}
			/>
			{inputIsTruncated && <TruncatedBadge fullLength={toolCall.inputJson.fullLength} />}
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt="xs" mb={2}>
						{t("output")}
					</Text>
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={codeStyle}
						title={`${toolCall.toolName} Output`}
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
		</Box>
	);
}

const TODO_STATUS_ICON: Record<string, { icon: typeof IconCheck; color: string }> = {
	completed: { icon: IconCheck, color: "green" },
	in_progress: { icon: IconPlayerPlay, color: "blue" },
	pending: { icon: IconChevronRight, color: "yellow" },
};

function TodoDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { toolUseId: latestToolUseId, isThinking } = useContext(LatestTodosToolUseIdCtx);
	const isLatest = !!toolCall.toolUseId && toolCall.toolUseId === latestToolUseId;
	const raw = isTruncated(toolCall.inputJson)
		? isTruncated(toolCall.outputJson)
			? []
			: toolCall.outputJson?.todos
		: (toolCall.inputJson?.todos ?? toolCall.outputJson?.todos);
	const todos: { content?: string; status?: string }[] = Array.isArray(raw) ? raw : [];

	if (!todos.length) {
		return <GenericDetail toolCall={toolCall} />;
	}

	return (
		<Box mt="xs">
			<List spacing={4} size="xs" center>
				{todos.map((todo, i) => {
					const entry = TODO_STATUS_ICON[todo.status ?? "pending"] ?? TODO_STATUS_ICON.pending;
					const spinning = isLatest && isThinking && todo.status === "in_progress";
					const StatusIconComp = spinning ? IconLoader2 : entry.icon;
					return (
						<List.Item
							// biome-ignore lint/suspicious/noArrayIndexKey: todo items lack unique IDs
							key={i}
							icon={
								<ThemeIcon size={16} variant="light" color={entry.color} radius="xl">
									<StatusIconComp
										size={10}
										style={spinning ? { animation: "spin 1s linear infinite" } : undefined}
									/>
								</ThemeIcon>
							}
						>
							<Text size="xs" c={todo.status === "completed" ? "dimmed" : undefined}>
								{todo.content ?? "—"}
							</Text>
						</List.Item>
					);
				})}
			</List>
		</Box>
	);
}

function parseTaskOutputXml(raw: string): Record<string, string> {
	const result: Record<string, string> = {};
	const tagRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
	while ((match = tagRegex.exec(raw)) !== null) {
		result[match[1]] = match[2].trim();
	}
	// <output> may be unclosed (truncated content) — capture everything after <output>
	if (!result.output) {
		const outputMatch = raw.match(/<output>([\s\S]*)$/);
		if (outputMatch) {
			result.output = outputMatch[1].trim();
		}
	}
	return result;
}

function TaskOutputDetail({ toolCall }: { toolCall: ToolCallData }) {
	const taskId = extractField(toolCall.inputJson, "task_id");
	const block = isTruncated(toolCall.inputJson) ? undefined : toolCall.inputJson?.block;
	const timeout = isTruncated(toolCall.inputJson) ? undefined : toolCall.inputJson?.timeout;

	// Parse the XML-style output
	const parsed = useMemo(() => {
		const out = toolCall.outputJson;
		if (!out) return null;
		if (isTruncated(out)) return null;
		const raw = collectToolCardTextPreview(out);
		if (!raw) return null;
		return parseTaskOutputXml(raw);
	}, [toolCall.outputJson]);

	const statusColor =
		parsed?.status === "completed" ? "green" : parsed?.status === "failed" ? "red" : "blue";

	return (
		<Box mt="xs">
			<Group gap="xs" mb={4}>
				{taskId && (
					<Badge size="xs" variant="light" color="indigo">
						{taskId}
					</Badge>
				)}
				{parsed?.status && (
					<Badge size="xs" variant="light" color={statusColor}>
						{parsed.status}
					</Badge>
				)}
				{parsed?.task_type && (
					<Badge size="xs" variant="outline" color="gray">
						{parsed.task_type}
					</Badge>
				)}
				{block != null && (
					<Text size="xs" c="dimmed">
						block={String(block)}
					</Text>
				)}
				{timeout != null && (
					<Text size="xs" c="dimmed">
						timeout={timeout}ms
					</Text>
				)}
			</Group>
			{parsed?.retrieval_status && parsed.retrieval_status !== "success" && (
				<Text size="xs" c="red" mb={4}>
					retrieval: {parsed.retrieval_status}
				</Text>
			)}
			{parsed?.output && (
				<ContentViewer content={parsed.output} style={codeStyle} title={`TaskOutput ${taskId}`} />
			)}
			{!parsed && isTruncated(toolCall.outputJson) && (
				<>
					<ContentViewer
						content={toolCall.outputJson.preview}
						style={codeStyle}
						title={`TaskOutput ${taskId}`}
					/>
					<TruncatedBadge fullLength={toolCall.outputJson.fullLength} />
				</>
			)}
		</Box>
	);
}

function PlanDetail({ toolCall, maxHeight }: { toolCall: ToolCallData; maxHeight?: number }) {
	const { t } = useTranslation("narrator");
	// Plan content lives in inputJson.plan. It may be resolved before user approval
	// (for plan reflection), so render it independently from the final tool status.
	const planText =
		toolCall.toolName === "ExitPlanMode" && typeof toolCall.inputJson?.plan === "string"
			? toolCall.inputJson.plan
			: "";

	const isDenied = toolCall.status === "fail" && toolCall.toolName === "ExitPlanMode";
	// User feedback is stored in permissionDenyMessage (raw user input, not the full system prompt)
	const denyFeedback = isDenied ? (toolCall.permissionDenyMessage ?? undefined) : undefined;
	const [planExpanded, setPlanExpanded] = useState(!isDenied);

	if (!planText) {
		return null;
	}

	// Denied plan: show feedback + collapsed plan content
	if (isDenied) {
		return (
			<Box mt="xs">
				{denyFeedback && denyFeedback !== "Permission denied by user" && (
					<Text size="xs" c="yellow" mb={4}>
						{denyFeedback}
					</Text>
				)}
				<UnstyledButton
					onClick={(e: React.MouseEvent) => {
						if (e.metaKey || e.ctrlKey || e.shiftKey) return;
						setPlanExpanded((o) => !o);
					}}
					w="100%"
				>
					<Group gap={4} mb={4}>
						{planExpanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
						<Text size="xs" c="dimmed">
							{t("planDeniedToggle")}
						</Text>
					</Group>
				</UnstyledButton>
				<LazyCollapse in={planExpanded}>
					<Box style={{ flex: 1, minHeight: 0, maxHeight: maxHeight ?? 400, overflow: "auto" }}>
						<ContentViewer
							content={planText}
							markdown
							contentType="markdown"
							title={`Plan — ${toolCall.toolName}`}
						/>
					</Box>
				</LazyCollapse>
			</Box>
		);
	}

	return (
		<Box mt="xs" style={{ flex: 1, minHeight: 0, maxHeight: maxHeight ?? 400, overflow: "auto" }}>
			<ContentViewer
				content={planText}
				markdown
				contentType="markdown"
				title={`Plan — ${toolCall.toolName}`}
			/>
		</Box>
	);
}

function AskDetail({ toolCall }: { toolCall: ToolCallData }) {
	const questions = isTruncated(toolCall.inputJson)
		? []
		: coerceQuestions(toolCall.inputJson?.questions);
	const answers: Record<string, string> = isTruncated(toolCall.inputJson)
		? {}
		: (toolCall.inputJson?.answers ?? {});

	// Don't show the read-only summary while the permission is still pending —
	// the interactive AskUserQuestionBanner (rendered via InlinePermission) handles that.
	if (!questions.length || toolCall.status === "running" || toolCall.status === "pending") {
		return null;
	}

	return (
		<Box mt="xs">
			<AskUserQuestionBanner requestId="" questions={questions} answers={answers} readOnly />
		</Box>
	);
}

// --- Streaming input detail: renders live content from structured fields ---

/**
 * Renders a live preview of tool input as it streams in.
 * Uses structured fields extracted by the backend — no raw JSON parsing.
 */
const StreamingInputDetail = memo(function StreamingInputDetail({
	toolCall,
	maxHeight,
}: {
	toolCall: ToolCallData;
	maxHeight?: number;
}) {
	const fields = toolCall.inputJson?._streamingFields as Record<string, string> | undefined;
	const sfName = toolCall.inputJson?._streamingFieldName as string | undefined;
	const sfValue = toolCall.inputJson?._streamingFieldValue as string | undefined;
	const cat = getCategory(toolCall.toolName);
	const filePath =
		(toolCall.inputJson?._streamingFilePath as string | undefined) ?? fields?.file_path;
	const lang = filePath ? getShikiLang(filePath) : undefined;

	// Write/Edit tools: show content/new_string with syntax highlighting.
	// Edit streams old_string first (matching) and new_string later (replacing), so render
	// the same provisional diff preview used by the full detail view instead of hiding
	// the matching phase while only old_string is available.
	if (cat === "file") {
		if (toolCall.toolName === "Edit") {
			const preview = getStreamingEditPreview(toolCall.inputJson);
			if (preview) {
				const previewFilePath = filePath || "Edit";
				const streamingMetadata =
					toolCall.inputJson?._streamingMetadata &&
					typeof toolCall.inputJson._streamingMetadata === "object"
						? (toolCall.inputJson._streamingMetadata as Record<string, unknown>)
						: undefined;
				const startLine =
					typeof toolCall._metadata?.startLine === "number"
						? (toolCall._metadata.startLine as number)
						: typeof streamingMetadata?.startLine === "number"
							? streamingMetadata.startLine
							: undefined;
				return (
					<Box mt="xs">
						<EditDiffBlock
							filePath={previewFilePath}
							oldString={preview.oldString}
							newString={preview.newString}
							language={previewFilePath ? getShikiLang(previewFilePath) : undefined}
							startLine={startLine}
							phase={preview.phase}
							chars={preview.chars}
							streaming
						/>
					</Box>
				);
			}
		}

		if (!filePath) return null;
		const isContentField = sfName === "content" || sfName === "new_string";
		if (!isContentField || !sfValue) return null;
		return (
			<Box mt="xs">
				<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={filePath}>
					{filePath}
				</Text>
				<StreamingCodeLazy code={sfValue} lang={lang} style={codeStyle} />
			</Box>
		);
	}

	// Bash tools: show command with terminal styling
	if (cat === "bash") {
		const cmd = sfName === "command" ? sfValue : fields?.command;
		if (!cmd) return null;
		return (
			<Box mt="xs">
				<Code
					block
					style={{
						...termStyle,
						maxHeight: 120,
						whiteSpace: "pre-wrap",
						wordBreak: "break-all",
						overflowX: "hidden",
					}}
				>
					{`$ ${cmd}`}
				</Code>
			</Box>
		);
	}

	// Search tools: header already shows pattern + path — no extra streaming detail needed.
	if (cat === "search") {
		return null;
	}

	// Agent/Task tools: show prompt
	if (cat === "agent") {
		if (!fields?.description) return null;
		const prompt = sfName === "prompt" ? sfValue : null;
		if (!prompt) return null;
		return (
			<Box mt="xs">
				<ContentViewer
					content={prompt}
					style={codeStyle}
					title={toolCall.toolName}
					markdown
					streaming
					autoFollow
					autoFollowKey={toolCall.toolUseId ?? toolCall.toolName}
				/>
			</Box>
		);
	}

	// Send tool: show message as it streams in.
	if (cat === "send") {
		const message = sfName === "message" ? sfValue : null;
		if (!message) return null;
		return (
			<Box mt="xs">
				<ContentViewer
					content={message}
					style={codeStyle}
					title="Send message"
					markdown
					streaming
					autoFollow
					autoFollowKey={toolCall.toolUseId ?? "send-message"}
				/>
			</Box>
		);
	}

	// Read tools: header already shows basename — no extra streaming detail needed.
	// Showing the full path here caused a brief flash (visible during streaming,
	// then hidden when the card collapses after streaming ends).
	if (cat === "read") {
		return null;
	}

	// Plan mode: show plan content
	if (cat === "plan") {
		const plan = sfName === "plan" ? sfValue : null;
		if (!plan) return null;
		return (
			<Box mt="xs" style={{ flex: 1, minHeight: 0 }}>
				<ContentViewer
					content={plan}
					title="Plan"
					style={{ maxHeight: maxHeight ?? 400, overflow: "auto" }}
					markdown
					streaming
					autoFollow
					autoFollowKey={toolCall.toolUseId ?? "plan"}
				/>
			</Box>
		);
	}

	return null;
});

function ReadDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const fsCapability = useFileSystemCapability();
	const previewCapability = fsCapability.preview;
	const fp = getFilePath(toolCall.inputJson);
	const meta = toolCall.outputJson?._metadata ?? toolCall._metadata;
	const isImage = meta?.isImage === true;
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);

	// Image preview: fetch via /api/fs/preview (same pattern as Codex image generation)
	const filePath = isImage ? ((meta?.filePath as string) ?? fp) : undefined;
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
	const previewUnsupported = !!filePath && !previewCapability.supported;

	useEffect(() => {
		if (!filePath || !previewCapability.supported) return;
		let cancelled = false;
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;
		setLoadError(false);
		setLoadErrorMessage(null);
		fetch(`/api/fs/preview?path=${encodeURIComponent(filePath)}`, { headers })
			.then(async (r) => {
				if (!r.ok) {
					const error = await readFetchError(r, "Request failed");
					throw new ApiError(error.message, r.status, error.data);
				}
				return r.blob();
			})
			.then((blob) => {
				if (!cancelled) {
					if (blob.size > MAX_FILE_PREVIEW_BLOB_BYTES) throw new Error("Preview too large");
					setBlobUrl(URL.createObjectURL(blob));
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setLoadError(true);
					setLoadErrorMessage(err instanceof Error ? err.message : null);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [filePath, previewCapability.supported]);

	// Cleanup blob URL on unmount
	useEffect(() => {
		return () => {
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		};
	}, [blobUrl]);

	if (isImage) {
		const sizeKB = meta?.sizeKB as number | undefined;
		const imageFormat = meta?.imageFormat as string | undefined;
		return (
			<Box mt="xs">
				{fp && (
					<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={fp}>
						{fp}
						{sizeKB != null && imageFormat && (
							<Text span c="dimmed" ml={4}>
								({sizeKB} KB, {imageFormat})
							</Text>
						)}
					</Text>
				)}
				{blobUrl && !loadError && (
					<img
						src={blobUrl}
						alt={fp || "image"}
						style={{
							maxWidth: "100%",
							maxHeight: 400,
							borderRadius: "var(--mantine-radius-sm)",
							objectFit: "contain",
							display: "block",
						}}
					/>
				)}
				{(loadError || previewUnsupported) && (
					<Text size="xs" c="dimmed">
						{previewUnsupported
							? (previewCapability.reason ?? t("filePreview_unsupported"))
							: (loadErrorMessage ?? outputText)}
					</Text>
				)}
			</Box>
		);
	}

	// Non-image Read: show file content
	return (
		<Box mt="xs">
			{fp && (
				<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={fp}>
					{fp}
				</Text>
			)}
			{toolCall.outputJson && (
				<>
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={codeStyle}
						title={fp || "Read"}
						language={fp ? getShikiLang(fp) : undefined}
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
			{toolCall.errorMessage && !toolCall.outputJson && (
				<Text size="xs" c="red" mt={4}>
					{toolCall.errorMessage}
				</Text>
			)}
		</Box>
	);
}

function DetailRenderer({ toolCall }: { toolCall: ToolCallData }) {
	const cat = getCategory(toolCall.toolName);
	switch (cat) {
		case "read":
			return <ReadDetail toolCall={toolCall} />;
		case "file":
			return <FileDetail toolCall={toolCall} />;
		case "bash":
			return <BashDetail toolCall={toolCall} />;
		case "search":
			return <SearchDetail toolCall={toolCall} />;
		case "webSearch":
			return <WebSearchDetail toolCall={toolCall} />;
		case "webFetch":
			return <WebFetchDetail toolCall={toolCall} />;
		case "todo":
			return <TodoDetail toolCall={toolCall} />;
		case "goal":
			return <GoalDetail toolCall={toolCall} />;
		case "taskOutput":
			return <TaskOutputDetail toolCall={toolCall} />;
		case "agent":
			return <GenericDetail toolCall={toolCall} />;
		case "await":
			return <AwaitDetail toolCall={toolCall} />;
		case "send":
			return <SendDetail toolCall={toolCall} />;
		case "ask":
			return <AskDetail toolCall={toolCall} />;
		case "plan":
			return <PlanDetail toolCall={toolCall} />;
		case "pipeline":
			return <PipelineDetail toolCall={toolCall} />;
		case "terminal":
			return <TerminalDetail toolCall={toolCall} />;
		case "share":
			return <ShareFileDetail toolCall={toolCall} />;
		case "skill":
			return <SkillDetail toolCall={toolCall} />;
		case "recall":
			return <RecallDetail toolCall={toolCall} />;
		case "browser":
			return <BrowserDetail toolCall={toolCall} />;
		default:
			return <GenericDetail toolCall={toolCall} />;
	}
}

// --- "Review in panel" button for Write/Edit permissions ---

function ReviewInPanelButton() {
	const { t } = useTranslation("narrator");
	const { openForApproval } = useContext(FileModDrawerCtx);
	return (
		<Button
			size="sm"
			color="indigo"
			variant="subtle"
			leftSection={<IconFileCode size={14} />}
			onClick={openForApproval}
		>
			{t("fileMod_viewInPanel")}
		</Button>
	);
}

// --- Permission button bar with keyboard navigation ---

interface PermButton {
	label: string;
	color: string;
	variant?: string;
	onClick: () => void;
}

/**
 * Renders a row of permission buttons with keyboard-driven focus highlight.
 * Reports button count to the parent via setButtonCount so the global
 * keydown handler knows the navigation range.
 */
function PermButtonBar({
	buttons,
	focusIndex,
	setButtonCount,
	registerActions,
	suffix,
}: {
	buttons: PermButton[];
	focusIndex: number | null;
	setButtonCount: (n: number) => void;
	registerActions: (actions: (() => void)[]) => void;
	suffix?: React.ReactNode;
}) {
	useEffect(() => {
		setButtonCount(buttons.length);
		registerActions(buttons.map((b) => b.onClick));
	}, [buttons, setButtonCount, registerActions]);

	return (
		<Group gap="sm">
			{buttons.map((btn, i) => {
				const focused = focusIndex === i;
				return (
					<Button
						key={`${btn.label}-${btn.color}`}
						size="sm"
						color={btn.color}
						variant={btn.variant as "light" | "subtle" | undefined}
						onClick={btn.onClick}
						className={focused ? "perm-btn-pulse" : undefined}
						style={
							focused
								? ({
										"--perm-pulse-color": `var(--mantine-color-${btn.color}-filled)`,
									} as React.CSSProperties)
								: undefined
						}
					>
						{btn.label}
						{focused && (
							<Text span size="xs" ml={4} opacity={0.7}>
								⏎
							</Text>
						)}
					</Button>
				);
			})}
			{suffix}
		</Group>
	);
}

// --- Inline permission UI rendered inside the tool call card ---

const PERMISSION_DRAFT_STORAGE_MAX_CHARS = 256_000;
const PERMISSION_DRAFT_FIELD_MAX_CHARS = 120_000;

interface StoredPermissionDraft {
	feedback: string;
	editedPlan: string | null;
}

function readStoredPermissionDraft(draftKey: string): StoredPermissionDraft | null {
	try {
		const raw = sessionStorage.getItem(draftKey);
		if (!raw) return null;
		if (raw.length > PERMISSION_DRAFT_STORAGE_MAX_CHARS) {
			sessionStorage.removeItem(draftKey);
			return null;
		}
		const parsed = JSON.parse(raw) as { feedback?: unknown; editedPlan?: unknown };
		const feedback =
			typeof parsed.feedback === "string" &&
			parsed.feedback.length <= PERMISSION_DRAFT_FIELD_MAX_CHARS
				? parsed.feedback
				: "";
		const editedPlan =
			typeof parsed.editedPlan === "string" &&
			parsed.editedPlan.length <= PERMISSION_DRAFT_FIELD_MAX_CHARS
				? parsed.editedPlan
				: null;
		return { feedback, editedPlan };
	} catch {
		return null;
	}
}

function canPersistPermissionDraft(feedback: string, editedPlan: string | null): boolean {
	if (feedback.length > PERMISSION_DRAFT_FIELD_MAX_CHARS) return false;
	if (editedPlan && editedPlan.length > PERMISSION_DRAFT_FIELD_MAX_CHARS) return false;
	return JSON.stringify({ feedback, editedPlan }).length <= PERMISSION_DRAFT_STORAGE_MAX_CHARS;
}

export function InlinePermission({
	permission,
	readOnly,
	onDecision,
	onQuestionSubmit,
	onQuestionReflect,
	onQuestionDeny,
	onPlanPreviewChange,
}: {
	permission: PendingPermission;
	readOnly?: boolean;
	onDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onQuestionReflect?: (requestId: string) => Promise<void> | void;
	onQuestionDeny?: (requestId: string) => void;
	onPlanPreviewChange?: (requestId: string, previewPlan: string | null) => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const permissionCapability = useNarratorPermissionsCapability();
	const permissionDecisionsSupported =
		permissionCapability.supported && permissionCapability.approveDeny;
	const permissionInputSupported =
		permissionCapability.supported && permissionCapability.updatedInput;
	const effectiveReadOnly = readOnly === true || !permissionDecisionsSupported;
	const { focusIndex, setButtonCount, setHasFeedback, registerActions, activePermissionId } =
		useContext(PermEnterHintCtx);
	const isActivePermission = permission.id === activePermissionId;
	const draftKey = `narrafork_perm_draft_${permission.id}`;
	const storedDraftRef = useRef<StoredPermissionDraft | null | undefined>(undefined);
	const getStoredDraft = () => {
		if (storedDraftRef.current === undefined) {
			storedDraftRef.current = readStoredPermissionDraft(draftKey) ?? null;
		}
		return storedDraftRef.current;
	};
	const [feedback, setFeedback] = useState(() => getStoredDraft()?.feedback ?? "");
	const [editing, setEditing] = useState(() => {
		const storedDraft = getStoredDraft();
		if (storedDraft?.editedPlan != null) {
			const pt =
				permission.toolName === "ExitPlanMode" && typeof permission.inputJson?.plan === "string"
					? permission.inputJson.plan
					: null;
			return storedDraft.editedPlan !== pt;
		}
		return false;
	});
	const [editedPlan, setEditedPlan] = useState<string | null>(
		() => getStoredDraft()?.editedPlan ?? null,
	);

	// Persist draft to sessionStorage
	useEffect(() => {
		const hasContent = feedback || editedPlan !== null;
		if (hasContent && canPersistPermissionDraft(feedback, editedPlan)) {
			sessionStorage.setItem(draftKey, JSON.stringify({ feedback, editedPlan }));
		} else {
			sessionStorage.removeItem(draftKey);
		}
	}, [draftKey, feedback, editedPlan]);

	// Notify parent when feedback presence changes so the Enter hint can auto-switch
	// Only the active (earliest) permission should drive the global Enter key behavior.
	useEffect(() => {
		if (isActivePermission) setHasFeedback(!!feedback);
	}, [feedback, setHasFeedback, isActivePermission]);
	useEffect(() => {
		if (!isActivePermission || !effectiveReadOnly) return;
		setButtonCount(0);
		registerActions([]);
	}, [effectiveReadOnly, isActivePermission, registerActions, setButtonCount]);

	// Feedback confirmation dialog state (must be before early returns)
	const [feedbackConfirmOpen, setFeedbackConfirmOpen] = useState(false);
	const [pendingCompactAfter, setPendingCompactAfter] = useState<boolean | undefined>();

	// ExitPlanMode plan content is rendered by the tool card itself. The permission
	// area only exposes approval controls and an explicit edit mode.
	const planText =
		permission.toolName === "ExitPlanMode" && typeof permission.inputJson?.plan === "string"
			? permission.inputJson.plan
			: null;
	const isExitPlan = permission.toolName === "ExitPlanMode";
	const planEdited = editedPlan !== null && editedPlan !== planText;
	const previewPlan =
		isExitPlan && planText && (editing || planEdited) ? (editedPlan ?? planText) : null;

	useEffect(() => {
		onPlanPreviewChange?.(permission.id, previewPlan);
	}, [onPlanPreviewChange, permission.id, previewPlan]);
	useEffect(() => {
		return () => onPlanPreviewChange?.(permission.id, null);
	}, [onPlanPreviewChange, permission.id]);

	// AskUserQuestion: render the full question form inline
	const askQuestions =
		permission.toolName === "AskUserQuestion"
			? coerceQuestions(permission.inputJson?.questions)
			: [];
	if (permission.toolName === "AskUserQuestion" && askQuestions.length > 0) {
		return (
			<Box mt="xs" {...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}>
				<AskUserQuestionBanner
					requestId={permission.id}
					questions={askQuestions}
					readOnly={effectiveReadOnly || !permissionInputSupported}
					onSubmit={(reqId, answers) => onQuestionSubmit?.(reqId, answers)}
					onReflect={(reqId) => onQuestionReflect?.(reqId)}
					onDeny={(reqId) => onQuestionDeny?.(reqId)}
				/>
			</Box>
		);
	}

	const localizedDecisionReason = permission.decisionReason ?? null;

	const handleAllow = (compactAfter?: boolean) => {
		// If ExitPlanMode and user has feedback text, show confirmation dialog
		if (isExitPlan && feedback.trim()) {
			setPendingCompactAfter(compactAfter);
			setFeedbackConfirmOpen(true);
			return;
		}
		sessionStorage.removeItem(draftKey);
		onDecision?.(
			permission.id,
			"allow",
			feedback || undefined,
			compactAfter,
			planEdited ? (editedPlan ?? undefined) : undefined,
		);
	};

	const handleConfirmExecute = () => {
		setFeedbackConfirmOpen(false);
		sessionStorage.removeItem(draftKey);
		onDecision?.(
			permission.id,
			"allow",
			feedback || undefined,
			pendingCompactAfter,
			planEdited ? (editedPlan ?? undefined) : undefined,
		);
	};

	const handleConfirmRevise = () => {
		setFeedbackConfirmOpen(false);
		sessionStorage.removeItem(draftKey);
		onDecision?.(permission.id, "deny", feedback || undefined);
	};

	const handleStartEdit = () => {
		if (planText && editedPlan === null) {
			setEditedPlan(planText);
		}
		setEditing(true);
	};

	// Regular permission: feedback textarea + Allow/Deny buttons
	return (
		<Box mt="xs" {...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}>
			{planEdited && !editing && (
				<Badge size="xs" color="indigo" variant="light" mb={4}>
					{t("planEdited")}
				</Badge>
			)}
			{planText && editing && (
				<Textarea
					mb="xs"
					value={editedPlan ?? planText}
					onChange={(e) => setEditedPlan(e.currentTarget.value)}
					autosize
					minRows={8}
					maxRows={30}
					disabled={effectiveReadOnly || !permissionInputSupported}
					styles={{ input: { fontFamily: "monospace", fontSize: "var(--mantine-font-size-xs)" } }}
				/>
			)}
			{localizedDecisionReason && (
				<Text size="xs" c="dimmed" mb={4}>
					{localizedDecisionReason}
				</Text>
			)}
			<Textarea
				size="xs"
				placeholder={t("feedbackPlaceholder")}
				value={feedback}
				onChange={(e) => setFeedback(e.currentTarget.value)}
				onKeyDown={(e) => {
					// Enter in feedback textarea → deny with feedback
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && feedback.trim()) {
						e.preventDefault();
						sessionStorage.removeItem(draftKey);
						onDecision?.(permission.id, "deny", feedback);
					}
				}}
				autosize
				minRows={1}
				maxRows={3}
				mb="xs"
				disabled={effectiveReadOnly}
			/>
			{effectiveReadOnly ? (
				<Text size="xs" c="dimmed">
					{t("permissionActionsUnavailable")}
				</Text>
			) : (
				<PermButtonBar
					focusIndex={isActivePermission ? focusIndex : null}
					buttons={(() => {
						const btns: PermButton[] = [];
						if (!editing) {
							btns.push({
								label: isExitPlan ? t("planExecute") : tc("allow"),
								color: "green",
								onClick: () => handleAllow(),
							});
						}
						if (!editing && isExitPlan) {
							btns.push({
								label: t("acceptAndResetContext"),
								color: "teal",
								variant: "light",
								onClick: () => handleAllow(true),
							});
						}
						if (isExitPlan && planText && permissionInputSupported) {
							btns.push({
								label: editing ? t("planEditDone") : t("planEdit"),
								color: "indigo",
								variant: "light",
								onClick: () => {
									if (editing) setEditing(false);
									else handleStartEdit();
								},
							});
						}
						if ((planEdited || editing) && permissionInputSupported) {
							btns.push({
								label: t("planEditReset"),
								color: "gray",
								variant: "subtle",
								onClick: () => {
									setEditedPlan(null);
									setEditing(false);
								},
							});
						}
						if (!editing) {
							btns.push({
								label: isExitPlan && feedback.trim() ? t("planRevise") : tc("deny"),
								color: "red",
								variant: "light",
								onClick: () => {
									sessionStorage.removeItem(draftKey);
									onDecision?.(permission.id, "deny", feedback || undefined);
								},
							});
						}
						return btns;
					})()}
					setButtonCount={isActivePermission ? setButtonCount : noop}
					registerActions={isActivePermission ? registerActions : noop}
					suffix={!editing && EDIT_TOOLS.has(permission.toolName) ? <ReviewInPanelButton /> : null}
				/>
			)}
			{isExitPlan && (
				<Modal
					opened={feedbackConfirmOpen}
					onClose={() => setFeedbackConfirmOpen(false)}
					title={t("planFeedbackConfirmTitle")}
					centered
					size="sm"
				>
					<Text size="sm" mb="lg">
						{t("planFeedbackConfirmMessage")}
					</Text>
					<Group justify="flex-end" gap="sm">
						<Button variant="light" color="red" onClick={handleConfirmRevise}>
							{t("planRevise")}
						</Button>
						<Button color="green" onClick={handleConfirmExecute}>
							{t("planExecuteWithoutRevision")}
						</Button>
					</Group>
				</Modal>
			)}
		</Box>
	);
}

/** Check if a tool call has any truncated inputJson or outputJson */
function hasTruncatedData(toolCall: ToolCallData): boolean {
	return toolCall.inputJson?._truncated === true || toolCall.outputJson?._truncated === true;
}

/** Wrapper that lazy-loads full tool call data when truncated fields are detected */
function LazyDetailRenderer({
	toolCall,
	narratorId,
	opened,
	planPreviewOverride,
}: {
	toolCall: ToolCallData;
	narratorId?: string;
	opened: boolean;
	planPreviewOverride?: string | null;
}) {
	const needsFetch = hasTruncatedData(toolCall) && opened && !!narratorId;
	const {
		data: fullTc,
		isLoading,
		isError,
		refetch,
	} = useToolCallDetail(narratorId ?? "", toolCall.toolUseId ?? "", needsFetch);

	const resolvedToolCall = useMemo(() => {
		const base = fullTc
			? {
					...toolCall,
					inputJson: fullTc.inputJson ?? toolCall.inputJson,
					outputJson: fullTc.outputJson ?? toolCall.outputJson,
				}
			: toolCall;
		if (base.toolName !== "ExitPlanMode" || typeof planPreviewOverride !== "string") {
			return base;
		}
		const inputJson =
			base.inputJson && typeof base.inputJson === "object" && !Array.isArray(base.inputJson)
				? { ...base.inputJson, plan: planPreviewOverride }
				: { plan: planPreviewOverride };
		return { ...base, inputJson };
	}, [toolCall, fullTc, planPreviewOverride]);

	const fetchCtx = useMemo(
		() => ({ isLoading: needsFetch && isLoading, isError, refetch }),
		[needsFetch, isLoading, isError, refetch],
	);

	return (
		<TruncationFetchCtx.Provider value={fetchCtx}>
			<DetailRenderer toolCall={resolvedToolCall} />
		</TruncationFetchCtx.Provider>
	);
}

// --- Swipe / context-menu constants ---

const SWIPE_REVEAL_WIDTH = 180;

// --- Main single card ---

/** Custom areEqual for ToolCallCard — compares toolCall by value fields instead of reference */
function toolCallCardAreEqual(prev: ToolCallCardProps, next: ToolCallCardProps): boolean {
	// Compare toolCall by key fields (avoids inline object reference mismatch)
	const p = prev.toolCall;
	const n = next.toolCall;
	if (
		p.toolUseId !== n.toolUseId ||
		p.status !== n.status ||
		p.durationMs !== n.durationMs ||
		p.inputJson !== n.inputJson ||
		p.outputJson !== n.outputJson ||
		p._longRunning !== n._longRunning ||
		p._streamingOutput !== n._streamingOutput ||
		p._streamedFullOutput !== n._streamedFullOutput ||
		p._timeoutMs !== n._timeoutMs ||
		p._metadata !== n._metadata ||
		p.sideCars !== n.sideCars ||
		p._resolvedModel !== n._resolvedModel ||
		p.startedAt !== n.startedAt ||
		p.errorMessage !== n.errorMessage
	) {
		return false;
	}
	// Compare other props
	if (
		prev.narratorId !== next.narratorId ||
		prev.inRun !== next.inRun ||
		prev.isLast !== next.isLast ||
		prev.forceExpand !== next.forceExpand ||
		prev.blockIndex !== next.blockIndex ||
		prev.pendingPermission !== next.pendingPermission ||
		prev.onPermissionDecision !== next.onPermissionDecision ||
		prev.onQuestionSubmit !== next.onQuestionSubmit ||
		prev.onQuestionReflect !== next.onQuestionReflect ||
		prev.onQuestionDeny !== next.onQuestionDeny
	) {
		return false;
	}
	return true;
}

export const ToolCallCard = memo(function ToolCallCard({
	toolCall,
	narratorId,
	inRun,
	isLast,
	pendingPermission,
	onPermissionDecision,
	onQuestionSubmit,
	onQuestionReflect,
	onQuestionDeny,
	forceExpand,
	blockIndex,
}: ToolCallCardProps) {
	const cat = getCategory(toolCall.toolName);
	const isEdit = isEditTool(toolCall.toolName);
	const isPlan = cat === "plan";
	// Streaming tool chunks (still being generated) — not expandable
	const isStreaming = toolCall.inputJson?._streamingChars != null;

	// --- Green shimmer on running → success transition ---
	// prevStatusRef starts as null so we can detect the *mount* case: when the
	// streaming synthetic message is replaced by the real assistant message the
	// outer container key changes, React mounts a fresh ToolCallCard whose
	// initial status is already "success".  For non-truncated data this means
	// the tool just finished, so we should still play the shimmer.
	//
	// Guard against narrator-switch remounts: when the user switches narrators
	// all cards remount with prev=null.  We distinguish "just finished in the
	// live stream" from "loaded from history / real-message replacement" by
	// checking startedAt — only the live WS path sets it (via onToolStarted →
	// mergeFieldsByIndex).  History loads and real-message replacements go
	// through message-segments which leaves startedAt undefined for completed
	// tools.  When startedAt IS present we additionally verify the tool
	// finished less than 2 s ago to cover edge cases.
	const isTruncated = hasTruncatedData(toolCall);
	const prevStatusRef = useRef<string | null>(null);
	const [doneShimmer, setDoneShimmer] = useState(false);
	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = toolCall.status;
		const wasRunning = prev === "running" || prev === "pending" || prev === "initializing";
		let freshMount = prev === null && !isTruncated;
		if (freshMount) {
			if (toolCall.startedAt == null) {
				// No startedAt → loaded from history or real-message replacement,
				// the shimmer was already played on the streaming card (if any).
				freshMount = false;
			} else if (toolCall.durationMs != null) {
				// Has timing info — only shimmer if finished within the last 2 s.
				const finishedAt = toolCall.startedAt + toolCall.durationMs;
				if (Date.now() - finishedAt > 2000) {
					freshMount = false;
				}
			}
		}
		if (toolCall.status === "success" && (wasRunning || freshMount)) {
			setDoneShimmer(true);
			const timer = setTimeout(() => setDoneShimmer(false), 650);
			return () => clearTimeout(timer);
		}
	}, [toolCall.status, toolCall.startedAt, toolCall.durationMs, isTruncated]);
	// Auto-expand: permission pending, todo tools, or edit tools.
	// Failed Edit cards auto-expand so the user can see the failure reason.
	// Denied ExitPlanMode defaults to collapsed — plan content is folded inside PlanDetail.
	const isFailed = toolCall.status === "fail";
	const isDeniedPlan = isFailed && toolCall.toolName === "ExitPlanMode";
	const shouldAutoOpenNonTruncated =
		cat === "todo" ||
		cat === "share" ||
		cat === "recall" ||
		cat === "send" ||
		cat === "pipeline" ||
		(cat === "await" && (toolCall.outputJson != null || toolCall.startedAt != null)) ||
		(cat === "bash" && (toolCall.outputJson != null || toolCall.startedAt != null)) ||
		(cat === "plan" && !isDeniedPlan) ||
		isEdit ||
		(isFailed && !isEdit && !isDeniedPlan);
	// Truncated history/live-completed cards default to collapsed so mounting a message page
	// does not fan out into one detail API request per long tool call. Permission prompts
	// still open automatically because the user must act on them.
	const defaultOpen =
		(isStreaming && isEdit) ||
		(!isStreaming &&
			(!!pendingPermission ||
				toolCall.status === "pending" ||
				toolCall._streamedFullOutput === true ||
				(!isTruncated && shouldAutoOpenNonTruncated)));
	const [opened, setOpened] = useState(defaultOpen);

	// Clamp plan card height to 85% of the nearest scroll container.
	const cardRef = useRef<HTMLDivElement>(null);
	const vpHeight = useNearestScrollContainerHeight(cardRef, 0.85, isPlan);

	// Auto-expand when a permission request arrives or tool call enters pending state
	useEffect(() => {
		if (pendingPermission || toolCall.status === "pending") setOpened(true);
	}, [pendingPermission, toolCall.status]);

	// If the final 2KB completion payload was replaced with complete live output,
	// keep the already-open streaming card open across the completed-state transition.
	useEffect(() => {
		if (toolCall._streamedFullOutput) setOpened(true);
	}, [toolCall._streamedFullOutput]);

	// Auto-expand bash card when streaming output arrives.
	// Uses a ref guard: only setOpened once per streaming-output lifecycle.
	// Reset when _streamingOutput clears so next streaming session can re-expand.
	// Intentionally no `opened` in deps — user can collapse during streaming without
	// the effect fighting back.
	const bashExpandedRef = useRef(false);
	useEffect(() => {
		if (cat === "bash" && toolCall._streamingOutput) {
			if (!bashExpandedRef.current) {
				bashExpandedRef.current = true;
				setOpened(true);
			}
		} else {
			bashExpandedRef.current = false;
		}
	}, [cat, toolCall._streamingOutput]);

	// Auto-expand cards once streaming finishes — keeps the card open continuously
	// instead of collapsing briefly between the streaming and running/completed phases.
	// Covers edit tools (show diff), bash (show command/output), todo, plan, share, etc.
	const wasStreamingRef = useRef(isStreaming);
	useEffect(() => {
		const wasStreaming = wasStreamingRef.current;
		wasStreamingRef.current = isStreaming;
		if (wasStreaming && !isStreaming && !isTruncated) {
			// Re-evaluate defaultOpen criteria now that isStreaming is false
			const shouldOpen =
				!!pendingPermission ||
				toolCall.status === "pending" ||
				cat === "todo" ||
				cat === "share" ||
				cat === "recall" ||
				cat === "send" ||
				cat === "pipeline" ||
				cat === "await" ||
				cat === "plan" ||
				cat === "bash" ||
				isEdit ||
				(isFailed && !isDeniedPlan);
			if (shouldOpen) setOpened(true);
		}
	}, [
		isStreaming,
		isTruncated,
		pendingPermission,
		toolCall.status,
		cat,
		isEdit,
		isFailed,
		isDeniedPlan,
	]);

	// Force expand from outside (e.g. navigating to this card)
	useEffect(() => {
		if (forceExpand) setOpened(true);
	}, [forceExpand]);

	const isRunning =
		toolCall.status === "running" ||
		toolCall.status === "pending" ||
		toolCall.status === "initializing";

	const borderColor = pendingPermission
		? "var(--mantine-color-yellow-6)"
		: toolCall.status === "fail"
			? "var(--mantine-color-red-7)"
			: toolCall.status === "cancelled"
				? "var(--mantine-color-orange-7)"
				: toolCall.status === "running"
					? "var(--mantine-color-blue-7)"
					: undefined;

	const lod = useRenderLod();
	const isPreviewLod = lod === "preview";
	const interactionEnabled = !isPreviewLod;
	const [planPreviewOverride, setPlanPreviewOverride] = useState<{
		requestId: string;
		plan: string;
	} | null>(null);
	const handlePlanPreviewChange = useCallback((requestId: string, previewPlan: string | null) => {
		setPlanPreviewOverride((current) => {
			if (!previewPlan) return current?.requestId === requestId ? null : current;
			if (current?.requestId === requestId && current.plan === previewPlan) return current;
			return { requestId, plan: previewPlan };
		});
	}, []);
	useEffect(() => {
		if (!pendingPermission && planPreviewOverride) setPlanPreviewOverride(null);
	}, [pendingPermission, planPreviewOverride]);

	const permissionCapability = useNarratorPermissionsCapability();
	const permissionDecisionsSupported =
		permissionCapability.supported && permissionCapability.approveDeny;
	const reflection = getToolCallReflection(toolCall, pendingPermission);
	const permissionUI =
		reflection && reflection.status !== "awaiting_user" ? (
			<ReflectionNotice
				toolCall={toolCall}
				pendingPermission={pendingPermission}
				reflection={reflection}
			/>
		) : pendingPermission ? (
			<InlinePermission
				permission={pendingPermission}
				readOnly={!permissionDecisionsSupported}
				onDecision={onPermissionDecision}
				onQuestionSubmit={onQuestionSubmit}
				onQuestionReflect={onQuestionReflect}
				onQuestionDeny={onQuestionDeny}
				onPlanPreviewChange={handlePlanPreviewChange}
			/>
		) : null;

	const handleToggle = isStreaming || !interactionEnabled ? undefined : () => setOpened((o) => !o);

	// --- File preview modal state ---
	const inputFilePath = getFilePath(toolCall.inputJson);
	const streamingFilePath =
		typeof toolCall.inputJson?._streamingFilePath === "string"
			? toolCall.inputJson._streamingFilePath
			: "";
	const fileMenuPath = FILE_TOOLS.has(toolCall.toolName) ? inputFilePath || streamingFilePath : "";
	const readFilePath = toolCall.toolName === "Read" ? fileMenuPath : "";
	const platform = usePlatform();
	const clipboardFilePath = formatClipboardFilePath(fileMenuPath, platform);
	const filePathClipboard = useClipboard({ timeout: 1500 });
	const [previewOpened, setPreviewOpened] = useState(false);
	const [inspectorOpened, setInspectorOpened] = useState(false);

	// --- Message-level context menu actions (branch / fork / compact / delete) ---
	const msgCtx = useMessageContextMenu();
	const { t: tNarrator } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const hasMessageActions = !!(
		msgCtx.onForkFromMessage ||
		msgCtx.onAskInPassing ||
		msgCtx.onCompactBeforeMessage ||
		(msgCtx.onRollbackToBlock && blockIndex != null) ||
		(msgCtx.onDeleteBlock && blockIndex != null)
	);
	const hasActions =
		interactionEnabled && !!(toolCall.toolUseId || fileMenuPath || hasMessageActions);

	// --- Swipe & context-menu state ---
	const tcBlockId = toolCall.toolUseId ? `tc-${toolCall.toolUseId}` : undefined;
	const selection = useMessageSelection();
	const isTcSelected = !!(
		tcBlockId &&
		selection.selectionMode &&
		selection.selectedBlockIds.has(tcBlockId)
	);
	const handleDeselectTc = useCallback(() => {
		if (tcBlockId) selection.deselectBlock(tcBlockId);
	}, [selection.deselectBlock, tcBlockId]);
	// Desktop: Ctrl/Cmd+Click toggles block, Shift+Click range-selects
	const isMobileTc = useMediaQuery("(max-width: 768px)") ?? false;
	const swipe = useSwipeMenu({
		enabled: hasActions,
		touchEnabled: interactionEnabled && isMobileTc,
		blockId: tcBlockId,
		onSwipeRight: isTcSelected ? handleDeselectTc : undefined,
	});

	const handleTcBlockClick = useCallback(
		(e: React.MouseEvent) => {
			if (!interactionEnabled || isMobileTc || !tcBlockId) return;
			const isModKey = e.metaKey || e.ctrlKey;
			const isShift = e.shiftKey;
			if (!isModKey && !isShift) return;
			if (shouldIgnoreMessageBlockSelection(e.target)) return;
			e.preventDefault();
			if (isShift) {
				window.getSelection()?.removeAllRanges();
				selection.rangeSelectTo(tcBlockId);
			} else {
				selection.toggleBlock(tcBlockId);
			}
		},
		[interactionEnabled, isMobileTc, tcBlockId, selection.toggleBlock, selection.rangeSelectTo],
	);

	const menuItemsNode = hasActions ? (
		<>
			{toolCall.toolUseId && (
				<Menu.Item
					leftSection={<IconInfoCircle size={14} />}
					onClick={() => {
						setInspectorOpened(true);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("toolCallInspector.inspect")}
				</Menu.Item>
			)}
			{toolCall.toolUseId && fileMenuPath && <Menu.Divider />}
			{fileMenuPath && (
				<Menu.Item
					leftSection={filePathClipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
					onClick={() => {
						filePathClipboard.copy(clipboardFilePath);
						swipe.closeSwipe();
					}}
				>
					{filePathClipboard.copied ? tc("copied") : tNarrator("contextMenu_copyFilePath")}
				</Menu.Item>
			)}
			{readFilePath && (
				<Menu.Item
					leftSection={<IconEye size={14} />}
					onClick={() => {
						setPreviewOpened(true);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_viewFile")}
				</Menu.Item>
			)}
			{fileMenuPath && hasMessageActions && <Menu.Divider />}
			{msgCtx.onRollbackToBlock && blockIndex != null && (
				<Menu.Item
					leftSection={<IconArrowBackUp size={14} />}
					onClick={() => {
						msgCtx.onRollbackToBlock?.(blockIndex);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_rollback")}
				</Menu.Item>
			)}
			{msgCtx.onForkFromMessage && (
				<Menu.Item
					leftSection={<IconGitFork size={14} />}
					onClick={() => {
						msgCtx.onForkFromMessage?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_fork")}
				</Menu.Item>
			)}
			{msgCtx.onAskInPassing && (
				<Menu.Item
					leftSection={<IconMessageQuestion size={14} />}
					onClick={() => {
						msgCtx.onAskInPassing?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_askInPassing")}
				</Menu.Item>
			)}
			{msgCtx.onCompactBeforeMessage && (
				<CompactMenuSub
					onCompact={msgCtx.onCompactBeforeMessage}
					onClearContext={msgCtx.onClearContextBefore}
					onManualSummarize={msgCtx.onManualSummarize}
					onClose={() => swipe.closeSwipe()}
				/>
			)}
			{msgCtx.onDeleteBlock && blockIndex != null && (
				<Menu.Item
					color="red"
					leftSection={<IconTrash size={14} />}
					onClick={() => {
						msgCtx.onDeleteBlock?.(blockIndex);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_delete")}
				</Menu.Item>
			)}
			<Menu.Divider />
			<Menu.Item leftSection={<IconX size={14} />} onClick={() => swipe.closeSwipe()}>
				{tc("cancel")}
			</Menu.Item>
		</>
	) : null;

	// --- Render helpers ---

	const planStyle =
		isPlan && vpHeight ? { maxHeight: vpHeight, overflow: "hidden auto" as const } : undefined;
	const effectivePlanPreviewOverride =
		planPreviewOverride && pendingPermission?.id === planPreviewOverride.requestId
			? planPreviewOverride.plan
			: null;

	const shimmerClass = isStreaming
		? "tool-card-shimmer"
		: doneShimmer
			? "tool-done-shimmer"
			: isRunning && !pendingPermission
				? "tool-running-shimmer"
				: undefined;

	const hasStreamingDetail =
		isStreaming &&
		!!(toolCall.inputJson?._streamingFieldValue || toolCall.inputJson?._streamingFields);

	const cardContent = (
		<NestedBlockCtx.Provider value={tcBlockId ?? null}>
			<ToolHeader
				toolCall={toolCall}
				opened={opened}
				onToggle={handleToggle}
				narratorId={narratorId}
			/>
			<SideCarNotice sideCars={toolCall.sideCars} />
			{isStreaming ? (
				hasStreamingDetail && <StreamingInputDetail toolCall={toolCall} maxHeight={vpHeight} />
			) : (
				<>
					<LongRunningTerminateButton toolCall={toolCall} narratorId={narratorId} />
					<LazyCollapse in={opened}>
						<Box style={planStyle}>
							<LazyDetailRenderer
								toolCall={toolCall}
								narratorId={narratorId}
								opened={opened}
								planPreviewOverride={effectivePlanPreviewOverride}
							/>
						</Box>
						{permissionUI}
					</LazyCollapse>
				</>
			)}
		</NestedBlockCtx.Provider>
	);

	const swipeMenu =
		hasActions &&
		(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
		(() => {
			const menuEl = swipe.swipeMenuRef.current;
			const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight);
			return createPortal(
				<Box
					ref={swipe.swipeMenuRef}
					style={{
						position: "fixed",
						left: pos.left,
						top: pos.top,
						transform: "translateY(-50%)",
						zIndex: Z.popover,
						transition: swipe.swipeMenuTransition,
						pointerEvents: swipe.swipeClosing ? "none" : "auto",
					}}
				>
					<Menu opened withinPortal={false} position="bottom-start">
						<Menu.Dropdown style={{ position: "relative", width: SWIPE_REVEAL_WIDTH }}>
							{menuItemsNode}
						</Menu.Dropdown>
					</Menu>
				</Box>,
				document.body,
			);
		})();

	const ctxMenu = hasActions && swipe.ctxMenuOpened && (
		<Menu
			opened={swipe.ctxMenuOpened}
			onChange={swipe.setCtxMenuOpened}
			position="bottom-start"
			withinPortal
			styles={{
				dropdown: {
					position: "fixed",
					left: swipe.ctxMenuPos.x,
					...(swipe.ctxMenuPos.flipY
						? { bottom: window.innerHeight - swipe.ctxMenuPos.y, top: "auto" }
						: { top: swipe.ctxMenuPos.y }),
				},
			}}
		>
			<Menu.Target>
				<div
					style={{
						position: "fixed",
						left: swipe.ctxMenuPos.x,
						top: swipe.ctxMenuPos.y,
						pointerEvents: "none",
					}}
				/>
			</Menu.Target>
			<Menu.Dropdown>{menuItemsNode}</Menu.Dropdown>
		</Menu>
	);

	const previewModal =
		readFilePath && previewOpened ? (
			<FilePreviewModal
				filePath={readFilePath}
				opened={previewOpened}
				onClose={() => setPreviewOpened(false)}
			/>
		) : null;
	const inspectorModal =
		toolCall.toolUseId && inspectorOpened ? (
			<ToolCallInspector
				narratorId={narratorId ?? ""}
				toolUseId={toolCall.toolUseId}
				opened={inspectorOpened}
				onClose={() => setInspectorOpened(false)}
				initialToolCall={toolCall}
			/>
		) : null;

	// Shared selection-aware style computation for both inRun and standalone layouts
	const buildSelectionStyle = (): React.CSSProperties => {
		const selOffset = isMobileTc && isTcSelected && !swipe.swipeRevealed ? 180 : 0;
		const effTransform =
			swipe.swipeOffset > 0 ? undefined : selOffset > 0 ? `translateX(-${selOffset}px)` : undefined;
		return {
			...swipe.swipeStyle,
			...(effTransform ? { transform: effTransform } : {}),
			...(isTcSelected
				? { outline: "2px solid var(--mantine-color-indigo-6)", outlineOffset: -2, borderRadius: 4 }
				: {}),
		};
	};

	// Inside a run: no Paper wrapper, just content + divider
	if (inRun) {
		return (
			<>
				<Box
					ref={swipe.swipeBoxRef}
					onContextMenu={interactionEnabled ? swipe.handleContextMenu : undefined}
					onClick={interactionEnabled ? handleTcBlockClick : undefined}
					style={buildSelectionStyle()}
					{...(tcBlockId ? { [BLOCK_ID_ATTR]: tcBlockId } : {})}
					{...(msgCtx.messageId ? { "data-message-id": msgCtx.messageId } : {})}
					{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
				>
					<Box ref={isPlan ? cardRef : undefined}>
						<Box p="xs" className={shimmerClass}>
							{cardContent}
						</Box>
						{!isLast && <Divider color="var(--mantine-color-default-border)" size={1} />}
					</Box>
				</Box>
				{swipeMenu}
				{ctxMenu}
				{previewModal}
				{inspectorModal}
			</>
		);
	}

	return (
		<>
			<Box
				ref={swipe.swipeBoxRef}
				onContextMenu={interactionEnabled ? swipe.handleContextMenu : undefined}
				onClick={interactionEnabled ? handleTcBlockClick : undefined}
				style={buildSelectionStyle()}
				{...(tcBlockId ? { [BLOCK_ID_ATTR]: tcBlockId } : {})}
				{...(msgCtx.messageId ? { "data-message-id": msgCtx.messageId } : {})}
				{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
			>
				<Paper
					ref={isPlan ? cardRef : undefined}
					withBorder={!inRun}
					radius={inRun ? 0 : "sm"}
					p="xs"
					className={shimmerClass}
					style={{
						backgroundColor: TOOL_CARD_BG,
						...(borderColor ? { borderColor } : {}),
					}}
				>
					{cardContent}
				</Paper>
			</Box>
			{swipeMenu}
			{ctxMenu}
			{previewModal}
			{inspectorModal}
		</>
	);
}, toolCallCardAreEqual);

// --- Grouped card for consecutive same-category tools ---

interface ToolCallGroupProps {
	toolCalls: ToolCallData[];
}

export const ToolCallGroup = memo(function ToolCallGroup({ toolCalls }: ToolCallGroupProps) {
	const [expanded, setExpanded] = useState(false);
	const cat = getCategory(toolCalls[0].toolName);
	const Icon = getCategoryIcon(cat);
	const color = getCategoryColor(cat);
	const allDone = toolCalls.every((tc) => tc.status === "success");
	const anyFailed = toolCalls.some((tc) => tc.status === "fail");
	const anyRunning = toolCalls.some((tc) => tc.status === "running");

	const statusColor = anyFailed ? "red" : anyRunning ? "blue" : allDone ? "green" : "yellow";
	const statusLabel = anyFailed ? "fail" : anyRunning ? "running" : allDone ? "success" : "pending";

	const anyInProgress = toolCalls.some(
		(tc) => tc.status === "running" || tc.status === "pending" || tc.status === "initializing",
	);

	// Collect unique tool names for the label
	const names = [...new Set(toolCalls.map((tc) => tc.toolName))];
	const label = names.length === 1 ? names[0] : names.join(", ");
	const totalMs = toolCalls.reduce((sum, tc) => sum + (tc.durationMs ?? 0), 0);

	// Find the earliest startedAt among in-progress tools for the group elapsed timer
	const earliestRunningStart = anyInProgress
		? toolCalls.reduce<number | undefined>((earliest, tc) => {
				if (
					(tc.status === "running" || tc.status === "pending" || tc.status === "initializing") &&
					tc.startedAt != null
				) {
					return earliest == null ? tc.startedAt : Math.min(earliest, tc.startedAt);
				}
				return earliest;
			}, undefined)
		: undefined;

	return (
		<Paper withBorder radius="sm" p="xs" style={{ backgroundColor: TOOL_CARD_BG }}>
			<UnstyledButton
				onClick={(e: React.MouseEvent) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey) return;
					setExpanded((o) => !o);
				}}
				w="100%"
			>
				<Group gap={5} wrap="nowrap">
					<ThemeIcon size={16} variant="light" color={color} radius="sm">
						<Icon size={10} />
					</ThemeIcon>
					<Text size="xs" fw={600} c="dimmed">
						{label}
					</Text>
					<Badge size="xs" variant="filled" color={color}>
						×{toolCalls.length}
					</Badge>
					<Box style={{ flex: 1 }} />
					<Badge size="xs" variant="dot" color={statusColor}>
						{statusLabel}
					</Badge>
					{earliestRunningStart != null ? (
						<ElapsedTimer startedAt={earliestRunningStart} />
					) : (
						totalMs > 0 && (
							<Text size="xs" c="dimmed" ff="monospace">
								{formatDurationText(totalMs, { style: "precise" })}
							</Text>
						)
					)}
					{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
				</Group>
			</UnstyledButton>
			<LazyCollapse in={expanded}>
				<Box mt={4} pl={4} style={{ borderLeft: `2px solid var(--mantine-color-${color}-4)` }}>
					{toolCalls.map((tc, i) => (
						<ToolCallCard key={tc.inputJson?.file_path ?? i} toolCall={tc} />
					))}
				</Box>
			</LazyCollapse>
		</Paper>
	);
});

// CSS keyframes — inject once
if (typeof document !== "undefined") {
	const id = "tool-call-spin";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes tool-shimmer { to { transform: translateX(100%) } }
@keyframes tool-running-shimmer { from { transform: translateX(-100%) } to { transform: translateX(100%) } }
@keyframes tool-done-shimmer { from { transform: translateX(100%) } to { transform: translateX(-100%) } }
.tool-card-shimmer {
  position: relative;
  overflow: hidden;
}
.tool-card-shimmer::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent 0%,
    light-dark(rgba(0,0,0,.04), rgba(255,255,255,.04)) 40%,
    light-dark(rgba(0,0,0,.07), rgba(255,255,255,.07)) 50%,
    light-dark(rgba(0,0,0,.04), rgba(255,255,255,.04)) 60%,
    transparent 100%
  );
  animation: tool-shimmer 2s ease-in-out infinite;
  pointer-events: none;
}
.tool-running-shimmer {
  position: relative;
  overflow: hidden;
}
.tool-running-shimmer::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(77,171,247,.06) 30%,
    rgba(77,171,247,.13) 50%,
    rgba(77,171,247,.06) 70%,
    transparent 100%
  );
  animation: tool-running-shimmer 2s ease-in-out infinite;
  pointer-events: none;
}
.tool-done-shimmer {
  position: relative;
  overflow: hidden;
}
.tool-done-shimmer::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(100%);
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(64,192,87,.06) 30%,
    rgba(64,192,87,.13) 50%,
    rgba(64,192,87,.06) 70%,
    transparent 100%
  );
  animation: tool-done-shimmer 600ms ease-out forwards;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .tool-running-shimmer::after { animation: none; }
  .tool-done-shimmer::after { animation: none; }
}`;
		document.head.appendChild(style);
	}
}
