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
import { useMediaQuery } from "@mantine/hooks";
import {
	IconArrowsMinimize,
	IconCheck,
	IconChevronDown,
	IconCopy,
	IconChevronRight,
	IconClock,
	IconCode,
	IconDownload,
	IconEye,
	IconFileCode,
	IconGitFork,
	IconHistory,
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
	IconTerminal2,
	IconTrash,
	IconWand,
	IconWorldSearch,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import {
	createContext,
	memo,
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
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { getToken } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { getShikiLang } from "../../lib/shiki-lang";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { ContentViewer } from "./ContentViewer";
import { DiffView } from "./DiffView";
import { LazyCollapse } from "./LazyCollapse";
import { useMessageContextMenu } from "./MessageContextMenuCtx";
import { BLOCK_ID_ATTR, NestedBlockCtx, useMessageSelection } from "./MessageSelectionCtx";
import { useNearestScrollContainerHeight } from "./useNearestScrollContainerHeight";

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
	errorMessage?: string;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
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
	/** Resolved model name for subagent tool calls (set via WS subagent_started event) */
	_resolvedModel?: string;
	/** Current timeout in ms (set from inputJson.timeout or updated via WS timeout_updated) */
	_timeoutMs?: number;
}

export interface PendingPermission {
	id: string;
	toolName: string;
	toolUseId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	inputJson: any;
	decisionReason?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	suggestions?: any[];
	overseerStatus?: "reviewing" | "queued";
}

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
	/** Callback when user skips/denies AskUserQuestion */
	onQuestionDeny?: (requestId: string) => void;
	/** Force expand this card from outside (e.g. when navigating to it) */
	forceExpand?: boolean;
	/** Override expand state for edit tools (true=expand all, false=collapse all, undefined=default) */
	editExpandOverride?: boolean | null;
	/** Block index within the parent message's contentJson array */
	blockIndex?: number;
}

// --- Constants ---

export const TOOL_CARD_BG = "color-mix(in srgb, var(--mantine-color-body) 50%, transparent)";

import { TOOL_CALL_STATUS_COLORS as STATUS_COLORS } from "@frontend/lib/status-registry";

export { STATUS_COLORS };

const READ_TOOLS = new Set(["Read"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const BASH_TOOLS = new Set(["Bash", "Shell", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch"]);
const WEB_FETCH_TOOLS = new Set(["WebFetch"]);
const TODO_TOOLS = new Set(["TaskCreate"]);
const TASK_OUTPUT_TOOLS = new Set(["TaskOutput", "TaskStop"]);
const AGENT_TOOLS = new Set(["Agent", "Task", "ContinueTask"]);
const ASK_TOOLS = new Set(["AskUserQuestion"]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
const TERMINAL_TOOLS = new Set(["Terminal"]);
const SHARE_TOOLS = new Set(["ShareFile"]);
const RECALL_TOOLS = new Set(["Recall"]);
const SKILL_TOOLS = new Set(["Skill"]);
const BROWSER_TOOLS = new Set(["Browser"]);
const OVERSEER_TOOLS = new Set([
	"ApprovePermission",
	"DenyPermission",
	"ListManagedNarrators",
	"GetNarratorContext",
]);

export type ToolCategory =
	| "read"
	| "file"
	| "bash"
	| "search"
	| "webSearch"
	| "webFetch"
	| "todo"
	| "taskOutput"
	| "agent"
	| "ask"
	| "plan"
	| "terminal"
	| "share"
	| "recall"
	| "skill"
	| "overseer"
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
	if (TASK_OUTPUT_TOOLS.has(name)) return "taskOutput";
	if (AGENT_TOOLS.has(name)) return "agent";
	if (ASK_TOOLS.has(name)) return "ask";
	if (PLAN_TOOLS.has(name)) return "plan";
	if (TERMINAL_TOOLS.has(name)) return "terminal";
	if (SHARE_TOOLS.has(name)) return "share";
	if (RECALL_TOOLS.has(name)) return "recall";
	if (SKILL_TOOLS.has(name)) return "skill";
	if (OVERSEER_TOOLS.has(name)) return "overseer";
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
		case "taskOutput":
			return IconRobot;
		case "agent":
			return IconGitFork;
		case "ask":
			return IconPlayerPlay;
		case "plan":
			return IconMap;
		case "terminal":
			return IconTerminal2;
		case "share":
			return IconShare;
		case "recall":
			return IconHistory;
		case "skill":
			return IconWand;
		case "overseer":
			return IconEye;
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
		case "taskOutput":
			return "indigo";
		case "agent":
			return "pink";
		case "ask":
			return "blue";
		case "plan":
			return "grape";
		case "terminal":
			return "yellow";
		case "share":
			return "green";
		case "recall":
			return "cyan";
		case "skill":
			return "grape";
		case "overseer":
			return "indigo";
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

/**
 * Resolve a possibly-truncated JSON value to a displayable string.
 * For truncated objects, returns the `preview` field (raw JSON prefix).
 * For normal values, returns JSON.stringify or the string itself.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function resolveDisplayText(val: any): string {
	if (val === null || val === undefined) return "";
	if (isTruncated(val)) return val.preview;
	if (typeof val === "string") return val;
	// Structured output from tools like Read/Edit: { _text, _metadata }
	if (typeof val._text === "string") return val._text;
	return JSON.stringify(val, null, 2);
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

// --- Helper: extract a human-readable summary for the header ---

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function getFilePath(input: any): string {
	return extractField(input, "file_path", "filePath", "path");
}

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
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
		if (fields && (toolName === "Agent" || toolName === "Task" || toolName === "ContinueTask")) {
			const parts: string[] = [];
			if (fields.subagent_type) parts.push(fields.subagent_type);
			if (fields.description) parts.push(fields.description);
			if (parts.length > 0) return parts.join(": ");
		}
		if (filePath) {
			const base = basename(filePath);
			const displayChars = contentChars ?? chars;
			// Don't show tiny char counts during the initial streaming phase —
			// the API may be validating output completeness and only a few bytes
			// (JSON delimiters) have arrived. The ToolHeader renders a dedicated
			// streaming indicator instead.
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
		case "taskOutput": {
			const taskId = extractField(input, "task_id");
			if (toolName === "TaskStop") return taskId ? `Stop ${taskId}` : "Stop task";
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
		case "ask": {
			const questions = isTruncated(input) ? undefined : input?.questions;
			const answers = isTruncated(input)
				? undefined
				: (input?.answers as Record<string, string> | undefined);
			if (Array.isArray(questions) && questions.length > 0) {
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
		case "overseer": {
			const reqId = extractField(input, "requestId");
			const short = reqId ? reqId.slice(0, 8) : "";
			if (toolName === "ApprovePermission") return short ? `✓ Approve ${short}…` : "Approve";
			if (toolName === "DenyPermission") return short ? `✗ Deny ${short}…` : "Deny";
			if (toolName === "ListManagedNarrators") return "List managed narrators";
			if (toolName === "GetNarratorContext") {
				const nid = extractField(input, "narratorId");
				return nid ? `Context: ${nid.slice(0, 8)}…` : "Get context";
			}
			return toolName;
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

function formatElapsed(s: number): string {
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const sec = s % 60;
	return `${m}m${sec.toString().padStart(2, "0")}s`;
}

function formatTimeoutShort(ms: number): string {
	if (ms >= 60_000) {
		const m = Math.round(ms / 60_000);
		return `${m}m`;
	}
	return `${Math.round(ms / 1000)}s`;
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
	const timeoutStr = showTimeout ? formatTimeoutShort(effectiveTimeout) : null;

	const timerContent = (
		<Text size="xs" c="dimmed" ff="monospace">
			{formatElapsed(elapsed)}
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

		// For Terminal tool, show "Terminal Read" / "Terminal Write" / "Terminal List" as the label
		const displayName = useMemo(() => {
			if (cat === "terminal") {
				const action = extractField(toolCall.inputJson, "action");
				if (action) return `Terminal ${action.charAt(0).toUpperCase()}${action.slice(1)}`;
			}
			return toolCall.toolName;
		}, [cat, toolCall.toolName, toolCall.inputJson]);

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
					<Tooltip
						label={startedAtLabel}
						disabled={!startedAtLabel}
						position="top"
						withArrow
						fz="xs"
					>
						<Group gap={4} wrap="nowrap" align="center">
							<Box c={statusColor} style={{ display: "flex", alignItems: "center" }}>
								<StatusIcon status={toolCall.status} />
							</Box>
							{toolCall.startedAt != null &&
							(toolCall.status === "running" ||
								toolCall.status === "pending" ||
								toolCall.status === "initializing") ? (
								<ElapsedTimer
									startedAt={toolCall.startedAt}
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
											{(displayDurationMs / 1000).toFixed(1)}s
											<span style={{ opacity: 0.5 }}>
												{" "}
												/ {formatTimeoutShort(effectiveTimeoutMs)}
											</span>
										</Text>
									</TimeoutPopover>
								) : (
									<Text size="xs" c="dimmed" ff="monospace">
										{(displayDurationMs / 1000).toFixed(1)}s
									</Text>
								))
							)}
						</Group>
					</Tooltip>
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
	const previewType = getFilePreviewType(filePath);
	const [error, setError] = useState(false);
	const [loading, setLoading] = useState(false);
	const [textContent, setTextContent] = useState<string | null>(null);
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const lang = getShikiLang(filePath);
	const fileName = filePath.split("/").pop() || filePath;

	// Reset state when modal opens with a new file
	useEffect(() => {
		if (opened) {
			setError(false);
			setTextContent(null);
			setBlobUrl(null);
		}
	}, [opened]);

	// Cleanup blob URL on unmount
	useEffect(() => {
		return () => {
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		};
	}, [blobUrl]);

	// Fetch file content when modal opens
	useEffect(() => {
		if (!opened) return;
		let cancelled = false;
		setLoading(true);
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;
		const url = `/api/fs/preview?path=${encodeURIComponent(filePath)}`;

		if (previewType === "text") {
			fetch(url, { headers })
				.then((r) => {
					if (!r.ok) throw new Error(r.statusText);
					return r.text();
				})
				.then((text) => {
					if (!cancelled) setTextContent(text);
				})
				.catch(() => {
					if (!cancelled) setError(true);
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		} else {
			// Image or PDF: fetch as blob and create object URL
			fetch(url, { headers })
				.then((r) => {
					if (!r.ok) throw new Error(r.statusText);
					return r.blob();
				})
				.then((blob) => {
					if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
				})
				.catch(() => {
					if (!cancelled) setError(true);
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}
		return () => {
			cancelled = true;
		};
	}, [opened, previewType, filePath]);

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
			{error && (
				<Box p="md">
					<Text c="red" size="sm">
						{t("filePreview_loadError")}
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
						content={textContent}
						style={{ fontSize: 12, maxHeight: "75vh", overflow: "auto" }}
						title={fileName}
						language={lang}
					/>
				</Box>
			)}
		</Modal>
	);
}

function FileDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const fp = getFilePath(toolCall.inputJson);
	const isEdit = toolCall.toolName === "Edit" || toolCall.toolName === "MultiEdit";
	const isWrite = toolCall.toolName === "Write";
	const inputIsTruncated = isTruncated(toolCall.inputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);

	const outputText = resolveDisplayText(toolCall.outputJson);
	const lang = fp ? getShikiLang(fp) : undefined;

	// For Write tool, display the written content from input instead of the result prompt
	const writeContent = isWrite
		? inputIsTruncated
			? extractField(toolCall.inputJson, "content") || toolCall.inputJson.preview
			: (toolCall.inputJson?.content ?? "")
		: "";

	const oldString = inputIsTruncated ? undefined : toolCall.inputJson?.old_string;
	const newString = inputIsTruncated ? undefined : toolCall.inputJson?.new_string;

	// Extract startLine from metadata (set by Edit tool on completion)
	const startLine =
		typeof toolCall._metadata?.startLine === "number"
			? (toolCall._metadata.startLine as number)
			: undefined;

	return (
		<Box mt="xs">
			{fp && (
				<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={fp}>
					{fp}
				</Text>
			)}
			{isEdit && oldString != null && (
				<ContentViewer
					content={`--- old\n${oldString}\n+++ new\n${newString ?? ""}`}
					title={fp ? basename(fp) : "Diff"}
					contentType="diff"
					language={lang}
					diff={{
						oldStr: oldString,
						newStr: newString ?? "",
					}}
					renderContent={(wordWrap) => (
						<DiffView
							oldStr={oldString}
							newStr={newString ?? ""}
							maxHeight={200}
							wordWrap={wordWrap}
							language={lang}
							startLine={startLine}
						/>
					)}
				/>
			)}
			{isEdit && inputIsTruncated && !oldString && (
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
			{isWrite && writeContent && (
				<>
					<ContentViewer
						content={writeContent}
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
						style={codeStyle}
						title={fp ? basename(fp) : "Output"}
						language={lang}
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
			{isEdit && !inputIsTruncated && !toolCall.inputJson?.old_string && (
				<ContentViewer
					content={JSON.stringify(toolCall.inputJson, null, 2)}
					style={codeStyle}
					title={fp ? basename(fp) : "Edit"}
					language="json"
				/>
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
	const cmd = extractField(toolCall.inputJson, "command");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);
	const isRunning = toolCall.status === "running" && !toolCall.outputJson;
	const streamingOutput = toolCall._streamingOutput;

	// Auto-scroll streaming output to bottom.
	// The scrollable container is Mantine's <pre class="mantine-Code-root"> inside ContentViewer.
	useEffect(() => {
		if (!streamingOutput || !toolCall.toolUseId) return;
		const raf = requestAnimationFrame(() => {
			const card = document.getElementById(`tool-use-${toolCall.toolUseId}`);
			if (!card) return;
			// Find all Code-root <pre> elements; the last one is the streaming output
			const pres = card.querySelectorAll<HTMLElement>("pre.mantine-Code-root");
			const scrollable = pres.length > 1 ? pres[pres.length - 1] : pres[0];
			if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) {
				scrollable.scrollTop = scrollable.scrollHeight;
			}
		});
		return () => cancelAnimationFrame(raf);
	}, [streamingOutput, toolCall.toolUseId]);

	return (
		<Box mt="xs">
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
					<ContentViewer content={outputText} style={codeStyle} title={pattern || "Search"} />
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
						<ContentViewer content={outputText} style={termStyle} title="Terminal Buffer" />
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
				<ContentViewer content={outputText} style={codeStyle} title="Terminals" />
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
							{preview && previewType && (
								<Badge size="xs" variant="light" color="teal">
									{t("shareFile.preview")}
								</Badge>
							)}
							{expiresLabel && (
								<Tooltip label={`Expires: ${expiresLabel}`} withArrow>
									<Badge size="xs" variant="light" color="yellow">
										{expiryHours}h
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
				</Group>
				{preview && previewUrl && previewType && (
					<ShareFilePreview previewUrl={previewUrl} previewType={previewType} filename={filename} />
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
		const queries = Array.isArray(meta.queries) ? meta.queries : meta.query ? [meta.query] : [];

		if (allResults.length === 0) {
			return (
				<Box mt="xs">
					<Text size="xs" c="dimmed">
						No results found
						{queries.length > 0 && ` for ${queries.map((q: string) => `"${q}"`).join(", ")}`}.
					</Text>
				</Box>
			);
		}

		return (
			<Box mt="xs">
				{queries.length > 0 && (
					<Group gap={4} mb={6} wrap="wrap">
						{queries.map((q: string, i: number) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static badge list, no reordering
							<Badge key={`${i}:${q}`} size="xs" variant="light" color="cyan">
								{q}
							</Badge>
						))}
					</Group>
				)}
				<Stack gap={4}>
					{allResults.map((r: RecallResult) => (
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
								{r.snippet.replace(/>>>/g, "").replace(/<<</g, "").trim()}
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
				</Stack>
			</Box>
		);
	}

	// action === "read_conversation"
	const messages = Array.isArray(meta.messages) ? meta.messages : [];
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
				{messages.map(
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
								{msg.text || "—"}
							</Text>
						</Box>
					),
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

// --- Overseer tool detail ---

function OverseerDetail({ toolCall }: { toolCall: ToolCallData }) {
	const input = toolCall.inputJson as Record<string, unknown> | undefined;
	const output =
		typeof toolCall.outputJson === "string"
			? toolCall.outputJson
			: typeof (toolCall.outputJson as { output?: string })?.output === "string"
				? (toolCall.outputJson as { output: string }).output
				: resolveDisplayText(toolCall.outputJson);

	if (toolCall.toolName === "ApprovePermission" || toolCall.toolName === "DenyPermission") {
		const isApprove = toolCall.toolName === "ApprovePermission";
		const reqId = (input?.requestId as string) ?? "";
		const feedback = (input?.feedbackText as string) ?? (input?.denyMessage as string) ?? "";

		return (
			<Box mt="xs">
				<Group gap="xs" mb="xs">
					<Badge color={isApprove ? "green" : "red"} variant="filled" size="sm">
						{isApprove ? "Approved" : "Denied"}
					</Badge>
					{reqId && <Code style={{ fontSize: 11 }}>{reqId}</Code>}
				</Group>
				{feedback && (
					<Text size="xs" c="dimmed" mb="xs">
						{feedback}
					</Text>
				)}
				{output && (
					<Code block style={{ fontSize: 11, maxHeight: 120, overflow: "auto" }}>
						{output}
					</Code>
				)}
			</Box>
		);
	}

	if (toolCall.toolName === "GetNarratorContext") {
		const nid = (input?.narratorId as string) ?? "";
		return (
			<Box mt="xs">
				{nid && (
					<Text size="xs" c="dimmed" mb="xs">
						Narrator: <Code style={{ fontSize: 11 }}>{nid}</Code>
					</Text>
				)}
				{output && (
					<Code
						block
						style={{ fontSize: 11, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap" }}
					>
						{output}
					</Code>
				)}
			</Box>
		);
	}

	// ListManagedNarrators and fallback
	return (
		<Box mt="xs">
			{output && (
				<Code
					block
					style={{ fontSize: 11, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap" }}
				>
					{output}
				</Code>
			)}
		</Box>
	);
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
						{files.map((f) => (
							<Badge key={f} size="xs" variant="dot" color="gray">
								{basename(f)}
							</Badge>
						))}
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
						style={codeStyle}
						title={selector || "DOM"}
						language="html"
					/>
					{outputIsTruncated && <TruncatedBadge fullLength={toolCall.outputJson.fullLength} />}
				</>
			)}
			{!isScreenshot && action !== "dom" && outputText && (
				<>
					<ContentViewer content={outputText} style={codeStyle} title={action || "Browser"} />
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

function GenericDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const inputText = resolveDisplayText(toolCall.inputJson);
	const outputText = resolveDisplayText(toolCall.outputJson);
	const inputIsTruncated = isTruncated(toolCall.inputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);

	return (
		<Box mt="xs">
			<Text size="xs" fw={500} mb={2}>
				{t("input")}
			</Text>
			<ContentViewer content={inputText} style={codeStyle} title={`${toolCall.toolName} Input`} />
			{inputIsTruncated && <TruncatedBadge fullLength={toolCall.inputJson.fullLength} />}
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt="xs" mb={2}>
						{t("output")}
					</Text>
					<ContentViewer
						content={outputText}
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
		const raw =
			typeof out === "string"
				? out
				: Array.isArray(out)
					? // biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
						out.map((b: any) => b.text ?? "").join("")
					: "";
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
	// Plan content lives in inputJson.plan (populated by handlePermission).
	// outputJson is just a short confirmation message after approval.
	const planText =
		toolCall.status === "success" || toolCall.status === "fail"
			? typeof toolCall.inputJson?.plan === "string"
				? toolCall.inputJson.plan
				: ""
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
	const raw = isTruncated(toolCall.inputJson) ? [] : (toolCall.inputJson?.questions ?? []);
	const questions = Array.isArray(raw) ? raw : [];
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
			<AskUserQuestionBanner
				requestId=""
				narratorId=""
				questions={questions}
				answers={answers}
				readOnly
			/>
		</Box>
	);
}

function DetailRenderer({ toolCall }: { toolCall: ToolCallData }) {
	const cat = getCategory(toolCall.toolName);
	switch (cat) {
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
		case "taskOutput":
			return <TaskOutputDetail toolCall={toolCall} />;
		case "agent":
			return <GenericDetail toolCall={toolCall} />;
		case "ask":
			return <AskDetail toolCall={toolCall} />;
		case "plan":
			return <PlanDetail toolCall={toolCall} />;
		case "terminal":
			return <TerminalDetail toolCall={toolCall} />;
		case "share":
			return <ShareFileDetail toolCall={toolCall} />;
		case "skill":
			return <SkillDetail toolCall={toolCall} />;
		case "recall":
			return <RecallDetail toolCall={toolCall} />;
		case "overseer":
			return <OverseerDetail toolCall={toolCall} />;
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

export function InlinePermission({
	permission,
	narratorId,
	onDecision,
	onQuestionSubmit,
	onQuestionDeny,
	planMaxHeight,
}: {
	permission: PendingPermission;
	narratorId?: string;
	onDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onQuestionDeny?: (requestId: string) => void;
	planMaxHeight?: number;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { focusIndex, setButtonCount, setHasFeedback, registerActions, activePermissionId } =
		useContext(PermEnterHintCtx);
	const isActivePermission = permission.id === activePermissionId;
	const draftKey = `narrafork_perm_draft_${permission.id}`;
	const [feedback, setFeedback] = useState(() => {
		try {
			const raw = sessionStorage.getItem(draftKey);
			if (raw) return JSON.parse(raw).feedback ?? "";
		} catch {}
		return "";
	});
	const [editing, setEditing] = useState(() => {
		try {
			const raw = sessionStorage.getItem(draftKey);
			if (raw) {
				const parsed = JSON.parse(raw);
				const pt =
					permission.toolName === "ExitPlanMode" && typeof permission.inputJson?.plan === "string"
						? permission.inputJson.plan
						: null;
				return parsed.editedPlan != null && parsed.editedPlan !== pt;
			}
		} catch {}
		return false;
	});
	const [editedPlan, setEditedPlan] = useState<string | null>(() => {
		try {
			const raw = sessionStorage.getItem(draftKey);
			if (raw) {
				const parsed = JSON.parse(raw);
				return parsed.editedPlan !== undefined ? parsed.editedPlan : null;
			}
		} catch {}
		return null;
	});

	// Persist draft to sessionStorage
	useEffect(() => {
		const hasContent = feedback || editedPlan !== null;
		if (hasContent) {
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

	// AskUserQuestion: render the full question form inline
	if (permission.toolName === "AskUserQuestion" && Array.isArray(permission.inputJson?.questions)) {
		return (
			<Box mt="xs">
				<AskUserQuestionBanner
					requestId={permission.id}
					narratorId={narratorId ?? ""}
					questions={permission.inputJson.questions}
					onSubmit={(reqId, answers) => onQuestionSubmit?.(reqId, answers)}
					onDeny={(reqId) => onQuestionDeny?.(reqId)}
				/>
			</Box>
		);
	}

	// ExitPlanMode: show plan content above the allow/deny buttons
	const planText =
		permission.toolName === "ExitPlanMode" && typeof permission.inputJson?.plan === "string"
			? permission.inputJson.plan
			: null;

	const isExitPlan = permission.toolName === "ExitPlanMode";
	const planEdited = editedPlan !== null && editedPlan !== planText;

	const handleAllow = (compactAfter?: boolean) => {
		sessionStorage.removeItem(draftKey);
		onDecision?.(
			permission.id,
			"allow",
			feedback || undefined,
			compactAfter,
			planEdited ? (editedPlan ?? undefined) : undefined,
		);
	};

	const handleStartEdit = () => {
		if (planText && editedPlan === null) {
			setEditedPlan(planText);
		}
		setEditing(true);
	};

	// Regular permission: feedback textarea + Allow/Deny buttons
	return (
		<Box mt="xs">
			{planText && !editing && (
				<Box mb="xs" style={{ minHeight: 0, maxHeight: planMaxHeight, overflow: "auto" }}>
					{planEdited && (
						<Badge size="xs" color="indigo" variant="light" mb={4}>
							{t("planEdited")}
						</Badge>
					)}
					<ContentViewer
						content={editedPlan ?? planText}
						markdown
						contentType="markdown"
						title="Plan"
					/>
				</Box>
			)}
			{planText && editing && (
				<Textarea
					mb="xs"
					value={editedPlan ?? planText}
					onChange={(e) => setEditedPlan(e.currentTarget.value)}
					autosize
					minRows={8}
					maxRows={30}
					styles={{ input: { fontFamily: "monospace", fontSize: "var(--mantine-font-size-xs)" } }}
				/>
			)}
			{permission.decisionReason && (
				<Text size="xs" c="dimmed" mb={4}>
					{permission.decisionReason}
				</Text>
			)}
			{permission.overseerStatus && (
				<Badge
					size="xs"
					variant="light"
					color={permission.overseerStatus === "reviewing" ? "blue" : "gray"}
					leftSection={
						permission.overseerStatus === "reviewing" ? (
							<IconEye size={10} />
						) : (
							<IconClock size={10} />
						)
					}
					mb={4}
				>
					{permission.overseerStatus === "reviewing" ? t("overseerReviewing") : t("overseerQueued")}
				</Badge>
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
			/>
			<PermButtonBar
				focusIndex={isActivePermission ? focusIndex : null}
				buttons={(() => {
					const btns: PermButton[] = [];
					if (!editing) {
						btns.push({
							label: tc("allow"),
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
					if (isExitPlan && planText) {
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
					if (planEdited || editing) {
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
							label: tc("deny"),
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
}: {
	toolCall: ToolCallData;
	narratorId?: string;
	opened: boolean;
}) {
	const needsFetch = hasTruncatedData(toolCall) && opened && !!narratorId;
	const {
		data: fullTc,
		isLoading,
		isError,
		refetch,
	} = useToolCallDetail(narratorId ?? "", toolCall.toolUseId ?? "", needsFetch);

	const resolvedToolCall = useMemo(() => {
		if (!fullTc) return toolCall;
		return {
			...toolCall,
			inputJson: fullTc.inputJson ?? toolCall.inputJson,
			outputJson: fullTc.outputJson ?? toolCall.outputJson,
		};
	}, [toolCall, fullTc]);

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
		prev.editExpandOverride !== next.editExpandOverride ||
		prev.blockIndex !== next.blockIndex ||
		prev.pendingPermission !== next.pendingPermission ||
		prev.onPermissionDecision !== next.onPermissionDecision ||
		prev.onQuestionSubmit !== next.onQuestionSubmit ||
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
	onQuestionDeny,
	forceExpand,
	editExpandOverride,
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
	// Failed Edit (not Write) defaults to collapsed (usually just a "read first" error).
	// Denied ExitPlanMode defaults to collapsed — plan content is folded inside PlanDetail.
	const isFailed = toolCall.status === "fail";
	const isFailedEdit = isFailed && toolCall.toolName === "Edit";
	const isDeniedPlan = isFailed && toolCall.toolName === "ExitPlanMode";
	// When data is truncated (loaded from history), default to collapsed to avoid
	// triggering expensive detail-fetch API calls. The card will expand if the user
	// clicks it or if it was just streamed in (streaming cards go through
	// _streamingChars → completed, so they never hit this path on first render).
	const defaultOpen =
		!isStreaming &&
		(!!pendingPermission ||
			toolCall.status === "pending" ||
			cat === "todo" ||
			cat === "share" ||
			cat === "recall" ||
			(cat === "bash" && toolCall.outputJson != null) ||
			(cat === "plan" && !isDeniedPlan) ||
			(isEdit && !isFailedEdit && !isTruncated) ||
			(isFailed && !isEdit && !isDeniedPlan && !isTruncated));
	const [opened, setOpened] = useState(defaultOpen);

	// Clamp plan card height to 85% of the nearest scroll container.
	const cardRef = useRef<HTMLDivElement>(null);
	const vpHeight = useNearestScrollContainerHeight(cardRef, 0.85, isPlan);

	// Auto-expand when a permission request arrives or tool call enters pending state
	useEffect(() => {
		if (pendingPermission || toolCall.status === "pending") setOpened(true);
	}, [pendingPermission, toolCall.status]);

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

	// Auto-expand todo/plan cards once streaming finishes (skip truncated history data)
	useEffect(() => {
		if (!isStreaming && !isTruncated && (cat === "todo" || cat === "plan")) setOpened(true);
	}, [isStreaming, isTruncated, cat]);

	// Force expand from outside (e.g. navigating to this card)
	useEffect(() => {
		if (forceExpand) setOpened(true);
	}, [forceExpand]);

	// Respond to global edit expand/collapse override
	useEffect(() => {
		if (isEdit && editExpandOverride != null) setOpened(editExpandOverride);
	}, [isEdit, editExpandOverride]);

	const isRunning =
		toolCall.status === "running" ||
		toolCall.status === "pending" ||
		toolCall.status === "initializing";

	const borderColor = pendingPermission
		? "var(--mantine-color-yellow-6)"
		: toolCall.status === "fail"
			? "var(--mantine-color-red-7)"
			: toolCall.status === "running"
				? "var(--mantine-color-blue-7)"
				: undefined;

	const permissionUI = pendingPermission ? (
		<InlinePermission
			permission={pendingPermission}
			narratorId={narratorId}
			onDecision={onPermissionDecision}
			onQuestionSubmit={onQuestionSubmit}
			onQuestionDeny={onQuestionDeny}
			planMaxHeight={vpHeight}
		/>
	) : null;

	const handleToggle = isStreaming ? undefined : () => setOpened((o) => !o);

	// --- File preview modal state ---
	const readFilePath = toolCall.toolName === "Read" ? getFilePath(toolCall.inputJson) : "";
	const [previewOpened, setPreviewOpened] = useState(false);

	// --- Message-level context menu actions (branch / fork / compact / delete) ---
	const msgCtx = useMessageContextMenu();
	const { t: tNarrator } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const hasActions = !!(
		readFilePath ||
		msgCtx.onForkFromMessage ||
		msgCtx.onAskInPassing ||
		msgCtx.onCompactBeforeMessage ||
		(msgCtx.onDeleteBlock && blockIndex != null)
	);

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
	const swipe = useSwipeMenu({
		enabled: hasActions,
		blockId: tcBlockId,
		onSwipeRight: isTcSelected ? handleDeselectTc : undefined,
	});

	// Desktop: Ctrl/Cmd+Click toggles block, Shift+Click range-selects
	const isMobileTc = useMediaQuery("(max-width: 768px)") ?? false;
	const handleTcBlockClick = useCallback(
		(e: React.MouseEvent) => {
			if (isMobileTc || !tcBlockId) return;
			const isModKey = e.metaKey || e.ctrlKey;
			const isShift = e.shiftKey;
			if (!isModKey && !isShift) return;
			e.preventDefault();
			if (isShift) {
				window.getSelection()?.removeAllRanges();
				selection.rangeSelectTo(tcBlockId);
			} else {
				selection.toggleBlock(tcBlockId);
			}
		},
		[isMobileTc, tcBlockId, selection.toggleBlock, selection.rangeSelectTo],
	);

	const menuItemsNode = hasActions ? (
		<>
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
			{readFilePath &&
				(msgCtx.onForkFromMessage ||
					msgCtx.onAskInPassing ||
					msgCtx.onCompactBeforeMessage ||
					(msgCtx.onDeleteBlock && blockIndex != null)) && <Menu.Divider />}
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
				<Menu.Item
					leftSection={<IconArrowsMinimize size={14} />}
					onClick={() => {
						msgCtx.onCompactBeforeMessage?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_compactBefore")}
				</Menu.Item>
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

	const shimmerClass = isStreaming
		? "tool-card-shimmer"
		: doneShimmer
			? "tool-done-shimmer"
			: isRunning && !pendingPermission
				? "tool-running-shimmer"
				: undefined;

	const cardContent = (
		<NestedBlockCtx.Provider value={tcBlockId ?? null}>
			<ToolHeader
				toolCall={toolCall}
				opened={opened}
				onToggle={handleToggle}
				narratorId={narratorId}
			/>
			{!isStreaming && (
				<>
					<LongRunningTerminateButton toolCall={toolCall} narratorId={narratorId} />
					<LazyCollapse in={opened}>
						<Box style={planStyle}>
							<LazyDetailRenderer toolCall={toolCall} narratorId={narratorId} opened={opened} />
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
						zIndex: 1000,
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

	const ctxMenu = hasActions && (
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
					onContextMenu={swipe.handleContextMenu}
					onClick={handleTcBlockClick}
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
			</>
		);
	}

	return (
		<>
			<Box
				ref={swipe.swipeBoxRef}
				onContextMenu={swipe.handleContextMenu}
				onClick={handleTcBlockClick}
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
								{(totalMs / 1000).toFixed(1)}s
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
