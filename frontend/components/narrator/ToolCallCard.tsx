import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
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
import { hasUsablePlanBody } from "@shared/plan-reference";
import {
	collectTruncatedLeaves,
	hasTruncatedLeaf,
	readLeafText,
	stringifyForDisplay,
} from "@shared/pretext-layout/tool-io-projection";
import {
	CARD_SHIMMER_CLASS,
	resolveToolShimmerFlash,
	resolveToolShimmerOutcome,
	resolveToolShimmerPhase,
	type ToolShimmerFlash,
} from "@shared/tool-shimmer";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconBan,
	IconBook,
	IconBookUpload,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconClock,
	IconCode,
	IconCopy,
	IconDatabaseEdit,
	IconDatabaseSearch,
	IconDevices,
	IconDownload,
	IconEye,
	IconFileCode,
	IconFileText,
	IconFilter,
	IconGavel,
	IconGitFork,
	IconHistory,
	IconInfoCircle,
	IconListCheck,
	IconLoader2,
	IconLock,
	IconMap,
	IconMessageQuestion,
	IconPencil,
	IconPlayerPlay,
	IconPlayerStop,
	IconRobot,
	IconSearch,
	IconShare,
	IconShield,
	IconShieldLock,
	IconTerminal2,
	IconTrash,
	IconUsers,
	IconWand,
	IconWorldSearch,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
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
import {
	ApiError,
	api,
	authorizedFetch,
	readFetchError,
	type SubagentActivitySummary,
} from "../../lib/api";
import type { ExecutionTargetIdentity } from "../../lib/api/types";
import {
	formatDurationText,
	formatFullLocaleDateTime,
	formatTimelineDateTime,
} from "../../lib/format";
import { formatLocaleDateTime, formatLocaleNumber } from "../../lib/intl-format";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { getShikiLang } from "../../lib/shiki-lang";
import { Z } from "../../lib/z-index";
import { useImageViewer } from "../common/ImageViewerProvider";
import { AskUserQuestionBanner, coerceQuestions } from "./AskUserQuestionBanner";
import { AutoFollowScroll } from "./AutoFollowScroll";
import { CompactMenuSub } from "./CompactMenuSub";
import { ContentViewer } from "./ContentViewer";
import { DiffView } from "./DiffView";
import { FilePreviewModal, MAX_FILE_PREVIEW_BLOB_BYTES } from "./FilePreviewModal";
import { KnowledgeDetail } from "./KnowledgeToolDetail";
import { LazyCollapse } from "./LazyCollapse";
import { useMessageContextMenu } from "./MessageContextMenuCtx";
import {
	BLOCK_ID_ATTR,
	MESSAGE_SELECTION_IGNORE_ATTR,
	NestedBlockCtx,
	shouldIgnoreMessageBlockSelection,
	TOOL_HEADER_SELECT_ATTR,
	useMessageSelection,
} from "./MessageSelectionCtx";
import {
	getPermissionReflectionSuggestion,
	normalizeReflectionAfterToolStatus,
	type ReflectionSuggestion,
} from "./narrator-message-helpers";
import { reflectionProgressLabel } from "./progress-label";
import { useRenderInteractive, useRenderLod } from "./RenderLodCtx";
import { useReflectionProgress } from "./reflection-progress-store";
import toolCardClasses from "./ToolCallCard.module.css";
import { ToolCallInspector } from "./ToolCallInspector";
import { isSpecTasksToolUse, knowledgeSummary } from "./tool-display";
import { buildToolTimingRows } from "./tool-timing-rows";
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
 * Context carrying whether the narrator is currently thinking, plus the
 * tool-use id of the latest spec://tasks.json write. SpecTasksDetail uses these
 * to decide whether a doing task should animate — spinning only makes sense
 * while the narrator is actively working AND this card is the most recent tasks
 * snapshot (so historical task cards stay static rather than showing a false
 * "active" spinner). A null latest id means "unknown" → fall back to isThinking
 * alone so the live/streaming case still animates.
 */
export const LatestTodosToolUseIdCtx = createContext<{
	isThinking: boolean;
	latestSpecTasksToolUseId?: string | null;
}>({ isThinking: false, latestSpecTasksToolUseId: null });

/** Context for opening the file modifications drawer from within tool call cards */
export const FileModDrawerCtx = createContext<{
	openForApproval: () => void;
}>({ openForApproval: () => {} });

/**
 * Context that lets a denied tool call in the latest assistant turn offer an
 * "allow and execute" action. Only enabled when the narrator is idle/interrupted
 * (no live loop running) so re-execution does not race the agent loop.
 */
export const AllowRetryCtx = createContext<{
	/** True when the narrator is idle/interrupted and re-execution is permitted. */
	enabled: boolean;
	/** The latest top-level assistant message ID — only its tool calls may retry. */
	latestAssistantMessageId: string | null;
	/** Trigger re-execution of a denied tool call by its toolUseId. */
	onAllowRetry: (toolUseId: string) => void;
}>({
	enabled: false,
	latestAssistantMessageId: null,
	onAllowRetry: () => {},
});

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
	streamStartedAt?: string | number | null;
	permissionStartedAt?: string | number | null;
	executionStartedAt?: string | number | null;
	completedAt?: string | number | null;
	createdAt?: string | number | null;
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	executionTarget?: ExecutionTargetIdentity | null;
	executionTargets?: ExecutionTargetIdentity[];
	deviceSelectionSource?: "explicit" | "session_default" | "local_default" | null;
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
	/** Current timeout in ms (set from inputJson.timeout or updated via WS timeout_updated) */
	_timeoutMs?: number;
	/** Subagent assistant message ID that produced the result (for scroll-to navigation) */
	resultMessageId?: string;
	/** Lightweight latest activity for Agent/Task/Send subagent cards. */
	_subagentActivity?: SubagentActivitySummary;
}

export type { PendingPermission } from "@frontend/types/narrator";

interface ExecutionTargetDisplay {
	deviceId?: string | null;
	cwd?: string | null;
	resolvedFilePath?: string | null;
}

function getExecutionTargetDisplay(toolCall: ToolCallData): ExecutionTargetDisplay {
	const metadataTarget = toolCall._metadata?.executionTarget;
	const target =
		metadataTarget && typeof metadataTarget === "object"
			? (metadataTarget as Record<string, unknown>)
			: undefined;
	return {
		deviceId:
			toolCall.executionDeviceId ??
			(typeof target?.deviceId === "string" ? target.deviceId : undefined),
		cwd: toolCall.executionCwd ?? (typeof target?.cwd === "string" ? target.cwd : undefined),
		resolvedFilePath:
			toolCall.resolvedFilePath ??
			(typeof target?.resolvedFilePath === "string" ? target.resolvedFilePath : undefined),
	};
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
	/** Callback when user asks reflection to answer AskUserQuestion */
	onQuestionReflect?: (requestId: string) => Promise<void> | void;
	/** Callback when user skips/denies AskUserQuestion */
	onQuestionDeny?: (requestId: string) => void;
	/** Open an awaited child-agent session in the host's side panel. */
	onViewSubagentSession?: (narratorId: string) => void;
	/**
	 * Open this tool's file path in a read-only dock panel (Read / Write / Edit).
	 * Supplied only by hosts that own a dockview surface; absent → item hidden.
	 */
	onOpenFilePanel?: (filePath: string) => void;
	/** Block index within the parent message's contentJson array */
	blockIndex?: number;
	/**
	 * Whether this card belongs to one of the most recent assistant run
	 * segments. Used by L5: recent cards expand, older cards collapse to
	 * headers. Defaults to true (no recency collapse).
	 */
	isRecent?: boolean;
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
const TASK_OUTPUT_TOOLS = new Set(["TaskOutput"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const AWAIT_TOOLS = new Set(["Await"]);
const SEND_TOOLS = new Set(["Send"]);
const ASK_TOOLS = new Set(["AskUserQuestion"]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
const PIPELINE_TOOLS = new Set(["StartPipeline", "ExtractPipeline", "EndPipeline"]);
const TERMINAL_TOOLS = new Set(["Terminal"]);
const SHARE_TOOLS = new Set(["ShareFile"]);
const RECALL_TOOLS = new Set(["Recall"]);
const SKILL_TOOLS = new Set(["Skill"]);
const BROWSER_TOOLS = new Set(["Browser"]);
const KNOWLEDGE_TOOLS = new Set([
	"KnowledgeSearch",
	"KnowledgeRead",
	"KnowledgeLibrary",
	"KnowledgeCreate",
	"KnowledgeEdit",
	"KnowledgeReview",
	"KnowledgeAdmin",
]);

/**
 * Tools that cannot be re-executed via "allow and execute" (control / UI tools
 * with no replayable side effects). Must mirror the backend
 * NON_RERUNNABLE_TOOL_NAMES set in narrator-session.ts.
 */
const NON_RERUNNABLE_TOOL_NAMES = new Set([
	"ExitPlanMode",
	"EnterPlanMode",
	"AskUserQuestion",
	"StartPipeline",
	"ExtractPipeline",
	"EndPipeline",
]);

/** permissionDecidedBy values that mark a tool call as re-runnable (stopped at the gate). */
const RERUNNABLE_DECIDED_BY = new Set(["user", "aborted"]);

/** Whether a failed tool call can offer an "allow and execute" action. */
export function canAllowRetryToolCall(toolCall: ToolCallData): boolean {
	return (
		toolCall.status === "fail" &&
		!!toolCall.toolUseId &&
		!NON_RERUNNABLE_TOOL_NAMES.has(toolCall.toolName) &&
		!!toolCall.permissionDecidedBy &&
		RERUNNABLE_DECIDED_BY.has(toolCall.permissionDecidedBy)
	);
}

export type ToolCategory =
	| "read"
	| "file"
	| "bash"
	| "search"
	| "webSearch"
	| "webFetch"
	| "tasks"
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
	| "knowledge"
	| "generic";

export function isEditTool(name: string): boolean {
	return EDIT_TOOLS.has(name);
}

export function getCategory(name: string, input?: unknown): ToolCategory {
	// Spec task-queue file operations render as a task list, not a raw file diff.
	if (input !== undefined && isSpecTasksToolUse(name, input)) return "tasks";
	if (READ_TOOLS.has(name)) return "read";
	if (FILE_TOOLS.has(name)) return "file";
	if (BASH_TOOLS.has(name)) return "bash";
	if (SEARCH_TOOLS.has(name)) return "search";
	if (WEB_SEARCH_TOOLS.has(name)) return "webSearch";
	if (WEB_FETCH_TOOLS.has(name)) return "webFetch";
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
	if (KNOWLEDGE_TOOLS.has(name)) return "knowledge";
	return "generic";
}

export function getCategoryIcon(cat: ToolCategory, toolName?: string) {
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
		case "tasks":
			return IconListCheck;
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
		case "knowledge":
			return getKnowledgeIcon(toolName);
		default:
			return IconCode;
	}
}

/** Per-tool icon for the knowledge family (same category, distinct glyphs). */
function getKnowledgeIcon(toolName?: string) {
	switch (toolName) {
		case "KnowledgeSearch":
			return IconDatabaseSearch;
		case "KnowledgeRead":
			return IconBook;
		case "KnowledgeLibrary":
			return IconDatabaseSearch;
		case "KnowledgeCreate":
			return IconBookUpload;
		case "KnowledgeEdit":
			return IconDatabaseEdit;
		case "KnowledgeReview":
			return IconGavel;
		case "KnowledgeAdmin":
			return IconShieldLock;
		default:
			return IconBook;
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
		case "tasks":
			return "teal";
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
		case "knowledge":
			return "grape";
		default:
			return "gray";
	}
}

/**
 * The leading category chip of a tool call — a 16×16 rounded tile carrying the
 * category colour as a tinted background plus a 10px glyph.
 *
 * Extracted so it has ONE definition. The tool-card header and the subagent
 * card's "recent calls" rows both show the same glyph for the same tool, and
 * they used to build it independently: the header wrapped it in the tinted
 * `.headerCategoryIcon` tile, the activity row rendered a bare `<Icon>` that
 * inherited the row's dimmed text colour. Same tool, two different-looking
 * marks. A shared component means a change to the chip cannot reach one call
 * site and miss the other.
 *
 * A plain `<span>` + CSS module rather than Mantine's `ThemeIcon` because the
 * header row is built from native spans (see `measure-tool-call.ts`, which
 * derives the vlist row geometry from this exact 16px lane).
 *
 * Colours come from Mantine's `-light` / `-light-color` pair, which already
 * carry a light/dark variant each, with a numeric shade as the fallback for a
 * palette entry that has no `-light` token.
 */
export function ToolCategoryChip({
	category,
	toolName,
	className,
	"data-testid": testId,
}: {
	category: ToolCategory;
	toolName?: string;
	className?: string;
	"data-testid"?: string;
}) {
	const Icon = getCategoryIcon(category, toolName);
	const color = getCategoryColor(category);
	return (
		<span
			data-testid={testId}
			data-tool-category-chip={category}
			className={
				className
					? `${toolCardClasses.headerCategoryIcon} ${className}`
					: toolCardClasses.headerCategoryIcon
			}
			style={
				{
					"--tool-header-icon-bg": `var(--mantine-color-${color}-light, var(--mantine-color-${color}-1))`,
					"--tool-header-icon-color": `var(--mantine-color-${color}-light-color, var(--mantine-color-${color}-6))`,
				} as CSSProperties
			}
		>
			<Icon size={TOOL_CATEGORY_CHIP_GLYPH_SIZE} />
		</span>
	);
}

/**
 * Glyph size inside {@link ToolCategoryChip}. 10px inside the 16px tile leaves a
 * 3px inset on each side, which is what keeps the tinted tile reading as a chip
 * rather than as a box drawn tight around the icon.
 */
export const TOOL_CATEGORY_CHIP_GLYPH_SIZE = 10;

// --- Truncation helpers ---

/**
 * Whether a value is a truncated LEAF.
 *
 * Truncation is field-level, so this answers "is THIS value a preview", not "does
 * this payload contain truncated data" — for the latter use `hasTruncatedLeaf`.
 * A local wrapper (rather than a direct re-export) keeps the `any`-friendly
 * signature the surrounding dynamic-JSON code relies on.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function isTruncated(val: any): val is { _truncated: true; preview: string; fullLength: number } {
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
	// A truncated LEAF renders as the string it stands for. Recursing into it would
	// print `{"_truncated":true,"preview":"…","fullLength":N}` in the middle of an
	// otherwise readable dump — strictly worse than the old root-wrapper behaviour.
	const leafText = readLeafText(value);
	if (leafText !== undefined) {
		appendToolCardPreview(
			parts,
			JSON.stringify(`${capToolCardDisplayText(leafText, budget.remaining)}…`),
			budget,
		);
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
	if (typeof val === "string") return capToolCardDisplayText(val);
	// Structured output from tools like Read/Edit: { _text, _metadata }. Checked
	// BEFORE the wrapper so a truncated `_text` unwraps to its text instead of
	// rendering as literal `{"_text":"…` — and `_text` may itself be a leaf.
	const textField = readLeafText(val._text);
	if (textField !== undefined) return capToolCardDisplayText(textField);
	const leaf = readLeafText(val);
	if (leaf !== undefined) return capToolCardDisplayText(leaf);
	return stringifyToolCardJsonPreview(val);
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function resolveFullDisplayText(val: any): string | undefined {
	// `hasTruncatedLeaf` rather than a root probe: after field-level projection the
	// root of an object payload is a plain object, so a root check would claim a
	// partially truncated payload is complete.
	if (val === null || val === undefined || hasTruncatedLeaf(val)) return undefined;
	if (typeof val === "string") return val;
	if (typeof val._text === "string") return val._text;
	return stringifyForDisplay(val);
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

/**
 * First string field among `keys`.
 *
 * Field-level truncation keeps every key in place, so this is a plain field read.
 * The `_hints` whitelist and the preview regex scraping it used to need are gone:
 * they only existed because the old ROOT wrapper had destroyed the object. A field
 * whose OWN value was truncated resolves to its preview.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function extractField(val: any, ...keys: string[]): string {
	if (!val || typeof val !== "object") return "";
	for (const k of keys) {
		const text = readLeafText(val[k]);
		if (text !== undefined) return text;
	}
	return "";
}

/** First numeric field among `keys`. Numbers are never truncated. */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function extractNumericField(val: any, ...keys: string[]): number | undefined {
	if (!val || typeof val !== "object") return undefined;
	for (const k of keys) {
		if (typeof val[k] === "number") return val[k];
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

export function getSummary(
	toolName: string,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	input: any,
	metadata?: Record<string, unknown>,
): string {
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
	const cat = getCategory(toolName, input);
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
		case "tasks":
			return toolName === "Read" ? "Read tasks" : "Update tasks";
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
			// Field-level projection keeps the `questions` array intact (the schema caps
			// it at 4), so the header is a direct read and the old
			// `_hints._firstHeader` projection is no longer needed.
			const questions = coerceQuestions(input?.questions);
			const answers = input?.answers as Record<string, string> | undefined;
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
			if (aliases.length > 0) return `aliases ${aliases.join(", ")}`;
			return toolName === "ExtractPipeline" ? "extract pipeline" : "finish pipeline";
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
		case "knowledge":
			return knowledgeSummary(toolName, input, metadata);
		default:
			return toolName;
	}
}

// --- Helper: live elapsed timer for running tools ---

function parseToolTime(value: string | number | null | undefined): number | null {
	if (value == null) return null;
	const time = typeof value === "number" ? value : new Date(value).getTime();
	return Number.isFinite(time) && time >= 0 ? time : null;
}

export function getEarliestToolStartMs(
	toolCall: Pick<
		ToolCallData,
		"startedAt" | "createdAt" | "streamStartedAt" | "permissionStartedAt" | "executionStartedAt"
	>,
): number | null {
	const candidates = [
		parseToolTime(toolCall.startedAt),
		parseToolTime(toolCall.createdAt),
		parseToolTime(toolCall.streamStartedAt),
		parseToolTime(toolCall.permissionStartedAt),
		parseToolTime(toolCall.executionStartedAt),
	].filter((time): time is number => time != null);
	return candidates.length > 0 ? Math.min(...candidates) : null;
}

function resolveToolTimingStart(toolCall: ToolCallData): number | null {
	return getEarliestToolStartMs(toolCall);
}

function resolveToolFinalDurationMs(toolCall: ToolCallData): number | null {
	if (typeof toolCall.durationMs === "number" && Number.isFinite(toolCall.durationMs)) {
		return Math.max(0, toolCall.durationMs);
	}
	const startedAt = resolveToolTimingStart(toolCall);
	const completedAt = parseToolTime(toolCall.completedAt);
	return startedAt != null && completedAt != null ? Math.max(0, completedAt - startedAt) : null;
}

function getBashExecDurationMs(toolCall: ToolCallData): number | null {
	return typeof toolCall._metadata?.execDurationMs === "number"
		? toolCall._metadata.execDurationMs
		: null;
}

/**
 * Timeline rows are a grid, not per-row flex, so the two right-hand columns are sized once
 * from the widest cell in the whole table.
 *
 * The earlier version reserved fixed `min-width`s (172px / 76px) computed from the widest
 * string each column *could* hold — a zero-padded datetime with an AM/PM suffix and
 * `+1h02m03s`. Locales that render neither (zh-CN produces `2026/07/29 11:03:47`, no
 * meridiem) paid for that headroom as dead space between the label and the timestamp.
 *
 * `max-content` measures what is actually there. Every row still lines up, because grid
 * column widths are a property of the grid rather than of each row, which is the same
 * guarantee the reservations were buying — without the slack.
 */
const TIMELINE_GRID_TEMPLATE = "minmax(0, 1fr) max-content max-content";
/** Keeps the three columns readable without overflowing a phone-width viewport. */
const TIMELINE_POPOVER_MAX_WIDTH = "min(440px, calc(100vw - 48px))";

function ToolTimingPopoverLabel({
	toolCall,
	displayDurationMs,
}: {
	toolCall: ToolCallData;
	displayDurationMs?: number | null;
}) {
	const { t } = useTranslation("narrator");
	const resolvedStart = resolveToolTimingStart(toolCall);
	const explicitStartedCandidates = [
		parseToolTime(toolCall.startedAt),
		parseToolTime(toolCall.createdAt),
	].filter((time): time is number => time != null);
	const explicitStarted =
		explicitStartedCandidates.length > 0 ? Math.min(...explicitStartedCandidates) : null;
	const streamStarted = parseToolTime(toolCall.streamStartedAt);
	const permissionStarted = parseToolTime(toolCall.permissionStartedAt);
	const executionStarted = parseToolTime(toolCall.executionStartedAt);
	const persistedCompleted = parseToolTime(toolCall.completedAt);
	const finalDurationMs = resolveToolFinalDurationMs(toolCall) ?? displayDurationMs ?? null;
	const completed =
		persistedCompleted ??
		(executionStarted != null && displayDurationMs != null
			? executionStarted + displayDurationMs
			: resolvedStart != null && finalDurationMs != null
				? resolvedStart + finalDurationMs
				: null);
	const genericStarted =
		explicitStarted != null &&
		explicitStarted !== streamStarted &&
		explicitStarted !== permissionStarted &&
		explicitStarted !== executionStarted
			? explicitStarted
			: null;
	const rows = buildToolTimingRows([
		{
			key: "started",
			label: t("toolCallInspector.timing.started"),
			time: genericStarted,
		},
		{
			key: "stream",
			label: t("toolCallInspector.timing.streamStarted"),
			time: streamStarted,
		},
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
	]);

	if (rows.length === 0) return null;

	return (
		<Stack gap={4} maw={TIMELINE_POPOVER_MAX_WIDTH}>
			<Text size="xs" fw={600}>
				{t("toolCallInspector.timing.title")}
			</Text>
			{/* One grid for the whole table rather than a grid per row: `display: contents`
			    lifts each row's three cells into the parent grid, so all rows share one set
			    of column widths and stay aligned. */}
			<Box
				data-tool-timing-grid
				style={{
					display: "grid",
					gridTemplateColumns: TIMELINE_GRID_TEMPLATE,
					columnGap: 12,
					rowGap: 4,
					alignItems: "baseline",
				}}
			>
				{rows.map((row) => (
					<Box key={row.key} data-tool-timing-row style={{ display: "contents" }}>
						<Text size="xs" truncate>
							{row.label}
						</Text>
						<Text size="xs" ff="monospace" c="dimmed" ta="right">
							{formatTimelineDateTime(row.time)}
						</Text>
						{/* The first row has no delta. The cell still has to exist so the grid
						    keeps three columns on every row, but it is hidden from screen
						    readers: it carries no information and would be announced as empty. */}
						<Text
							size="xs"
							ff="monospace"
							c="dimmed"
							ta="right"
							aria-hidden={row.deltaMs == null || undefined}
						>
							{row.deltaMs == null
								? ""
								: `+${formatDurationText(row.deltaMs, { style: "precise" })}`}
						</Text>
					</Box>
				))}
			</Box>
			{/* Per-phase durations are already visible as the "+delta" column above; only the
			    end-to-end total adds information here. */}
			{resolvedStart != null && completed != null && (
				<Text size="xs" c="dimmed">
					{t("toolCallInspector.timing.total", {
						duration: formatDurationText(Math.max(0, completed - resolvedStart), {
							style: "precise",
						}),
					})}
				</Text>
			)}
		</Stack>
	);
}

const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const DEFAULT_AWAIT_TIMEOUT_MS = 600_000;
/** Grace period on pointer-leave so the cursor can cross into the timeline dropdown. */
const TIMING_HOVER_CLOSE_DELAY_MS = 120;

/** Shared hover/touch timing area used by regular tools and subagent cards. */
export function ToolTimingArea({
	toolCall,
	isActive,
	displayDurationMs,
	timeout,
	opened: controlledOpened,
	onOpenedChange,
	onMouseActivate,
}: {
	toolCall: ToolCallData;
	isActive: boolean;
	displayDurationMs?: number | null;
	timeout?: React.ReactNode;
	opened?: boolean;
	onOpenedChange?: (opened: boolean) => void;
	onMouseActivate?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [internalOpened, setInternalOpened] = useState(false);
	const opened = controlledOpened ?? internalOpened;
	const activationPointerTypeRef = useRef<string | null>(null);
	const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const startedAt = resolveToolTimingStart(toolCall);
	const finalDurationMs = displayDurationMs ?? resolveToolFinalDurationMs(toolCall);
	const timing =
		isActive && startedAt != null ? (
			<ElapsedTimer startedAt={startedAt} />
		) : finalDurationMs != null ? (
			<span
				className={`${toolCardClasses.headerText} ${toolCardClasses.mono} ${toolCardClasses.dimmed}`}
			>
				{formatDurationText(finalDurationMs, { style: "precise" })}
			</span>
		) : null;
	const hasTimingDetails =
		startedAt != null ||
		parseToolTime(toolCall.permissionStartedAt) != null ||
		parseToolTime(toolCall.executionStartedAt) != null ||
		parseToolTime(toolCall.completedAt) != null;
	const label = (
		<ToolTimingPopoverLabel toolCall={toolCall} displayDurationMs={displayDurationMs} />
	);
	const ariaLabel =
		startedAt != null
			? t("toolStartedAt", { time: formatFullLocaleDateTime(startedAt) })
			: t("toolCallInspector.timing.title");

	const setOpened = useCallback(
		(nextOpened: boolean) => {
			if (controlledOpened == null) setInternalOpened(nextOpened);
			onOpenedChange?.(nextOpened);
		},
		[controlledOpened, onOpenedChange],
	);
	const cancelHoverClose = useCallback(() => {
		if (hoverCloseTimerRef.current) {
			clearTimeout(hoverCloseTimerRef.current);
			hoverCloseTimerRef.current = null;
		}
	}, []);
	// Delay the close so the pointer can travel the gap between trigger and dropdown, letting
	// the user land inside the popover to select/copy the timestamps.
	const scheduleHoverClose = useCallback(() => {
		cancelHoverClose();
		hoverCloseTimerRef.current = setTimeout(() => {
			hoverCloseTimerRef.current = null;
			setOpened(false);
		}, TIMING_HOVER_CLOSE_DELAY_MS);
	}, [cancelHoverClose, setOpened]);
	useEffect(() => cancelHoverClose, [cancelHoverClose]);

	// Set once a mouse click handed the area over to onMouseActivate (the timeout editor), and
	// cleared when the pointer leaves. Without it, any re-entry inside the area would hover the
	// timeline back open and close the editor while the user is still typing in it.
	const mouseHandedOffRef = useRef(false);
	const handleMouseActivate = useCallback(() => {
		if (!onMouseActivate) return;
		cancelHoverClose();
		mouseHandedOffRef.current = true;
		setOpened(false);
		onMouseActivate();
	}, [cancelHoverClose, onMouseActivate, setOpened]);

	// Mouse hover opens the timeline; mouse click is reserved for onMouseActivate (the timeout
	// editor) so the two popovers never fight. Touch/pen get no hover — they open on tap.
	const handlePointerEnter = useCallback(
		(event: React.PointerEvent) => {
			if (event.pointerType !== "mouse" || !hasTimingDetails) return;
			if (mouseHandedOffRef.current) return;
			cancelHoverClose();
			setOpened(true);
		},
		[cancelHoverClose, hasTimingDetails, setOpened],
	);
	const handlePointerLeave = useCallback(
		(event: React.PointerEvent) => {
			if (event.pointerType !== "mouse") return;
			mouseHandedOffRef.current = false;
			if (!hasTimingDetails) return;
			scheduleHoverClose();
		},
		[hasTimingDetails, scheduleHoverClose],
	);

	const timerGroup = (
		<Box
			component="span"
			className={toolCardClasses.headerTimerGroup}
			onPointerEnter={handlePointerEnter}
			onPointerLeave={handlePointerLeave}
			onPointerDown={(event) => {
				event.stopPropagation();
				activationPointerTypeRef.current = event.pointerType;
			}}
			onPointerCancel={(event) => {
				event.stopPropagation();
				activationPointerTypeRef.current = null;
			}}
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
		>
			{timing && (
				<UnstyledButton
					type="button"
					aria-label={ariaLabel}
					className={toolCardClasses.headerTiming}
					onClick={(event) => {
						event.stopPropagation();
						const pointerType = activationPointerTypeRef.current;
						activationPointerTypeRef.current = null;
						if (pointerType === "mouse" && onMouseActivate) {
							handleMouseActivate();
							return;
						}
						if (!hasTimingDetails) return;
						// A mouse click with nothing else bound would toggle off a popover the
						// pointer is still hovering, which cannot reopen until the pointer leaves.
						// Keep it open instead; leaving closes it. Touch/pen/keyboard still toggle.
						if (pointerType === "mouse") {
							cancelHoverClose();
							setOpened(true);
							return;
						}
						setOpened(!opened);
					}}
				>
					{timing}
				</UnstyledButton>
			)}
			{timeout}
		</Box>
	);

	if (!hasTimingDetails) return timerGroup;
	return (
		<Popover opened={opened} onChange={setOpened} position="top" withArrow withinPortal shadow="md">
			<Popover.Target>{timerGroup}</Popover.Target>
			<Popover.Dropdown
				onPointerEnter={handlePointerEnter}
				onPointerLeave={handlePointerLeave}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => event.stopPropagation()}
			>
				{label}
			</Popover.Dropdown>
		</Popover>
	);
}

/** Timeout editor for an active tool call. Completed calls only render static timeout text. */
function TimeoutEditorPopover({
	timeoutMs,
	narratorId,
	toolUseId,
	opened,
	onChange,
	children,
}: {
	timeoutMs: number;
	narratorId: string;
	toolUseId: string;
	opened: boolean;
	onChange: (opened: boolean) => void;
	children: React.ReactNode;
}) {
	const { t } = useTranslation("narrator");
	const [value, setValue] = useState<number | string>(Math.round(timeoutMs / 1000));

	useEffect(() => {
		if (!opened) setValue(Math.round(timeoutMs / 1000));
	}, [timeoutMs, opened]);

	const handleUpdate = useCallback(() => {
		const seconds = typeof value === "string" ? Number.parseFloat(value) : value;
		if (!seconds || seconds <= 0) return;
		narratorWSManager.send({
			type: "update_timeout",
			narratorId,
			toolUseId,
			timeoutMs: Math.round(seconds * 1000),
		});
		onChange(false);
	}, [value, narratorId, toolUseId, onChange]);

	return (
		<Popover
			opened={opened}
			onChange={onChange}
			position="top"
			withArrow
			withinPortal
			shadow="md"
			trapFocus
		>
			<Popover.Target>
				<UnstyledButton
					type="button"
					aria-label={t("timeoutLabel")}
					className={toolCardClasses.headerTimeout}
					{...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						onChange(!opened);
					}}
				>
					{children}
				</UnstyledButton>
			</Popover.Target>
			<Popover.Dropdown
				p="xs"
				style={{ minWidth: 180 }}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => event.stopPropagation()}
			>
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
							onKeyDown={(event: React.KeyboardEvent) => {
								if (event.key === "Enter") {
									event.preventDefault();
									handleUpdate();
								}
							}}
						/>
						<Button size="xs" variant="light" onClick={handleUpdate}>
							{t("timeoutUpdate")}
						</Button>
					</Group>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}

export function ElapsedTimer({ startedAt }: { startedAt: number }) {
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

	return (
		<span
			className={`${toolCardClasses.headerText} ${toolCardClasses.mono} ${toolCardClasses.dimmed}`}
		>
			{formatDurationText(elapsed * 1000)}
		</span>
	);
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
	const normalized = normalizeReflectionAfterToolStatus(
		reflection,
		toolCall.status,
		!!pendingPermission,
	);
	if (normalized?.status === "aborted" && normalized !== reflection) {
		return {
			...normalized,
			reason: toolCall.errorMessage || toolCall.permissionDecisionReason || reflection?.reason,
		};
	}
	return normalized;
}

export function ReflectionNotice({
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
	// Live progress comes from the render-only store, never from message state: it
	// ticks several times a second. See reflection-progress-store.ts.
	const reflectionProgress = useReflectionProgress(reflectionRequestId);
	const activeKeyboardPermissionId = pendingPermission?.id ?? toolCall.id;
	const running = reflection.status === "running";
	const isDanger = reflection.kind === "danger_reflection";
	const isPlan = reflection.kind === "plan_reflection";
	const isQuestion = reflection.kind === "question_reflection";
	const isTask = reflection.kind === "task_reflection";
	const summary =
		reflection.reason || reflection.danger?.summary || toolCall.permissionDecisionReason;
	const titleKeyPrefix = isDanger ? "danger" : isPlan ? "plan" : isQuestion ? "question" : "task";
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
			else if (isTask) await api.stopTaskReflection(reflectionRequestId);
			else if (isQuestion) await api.stopQuestionReflection(reflectionRequestId);
		} finally {
			setTakingOver(false);
		}
	};

	// A RUNNING gate is TEAL throughout — notice, title, icon and takeover button.
	//
	// It used to be yellow, which said the wrong thing twice: yellow is this app's
	// "awaiting a human" colour (the `pending` status, the permission border), and a
	// running gate is the opposite — the machine is deliberating and the user has
	// nothing to do yet. It also disagreed with the card's own shimmer. Teal is the one
	// hue no other tool state claims (grape = reasoning, blue = executing, green/red =
	// outcomes, orange = cancelled), so the whole reflecting state now speaks with one
	// voice. Resolved states keep their outcome colours below.
	const noticeStyle: React.CSSProperties = {
		marginTop: "var(--mantine-spacing-xs)",
		background: running
			? "light-dark(color-mix(in srgb, var(--mantine-color-orange-0) 88%, white), color-mix(in srgb, var(--mantine-color-orange-9) 34%, transparent))"
			: "light-dark(color-mix(in srgb, var(--mantine-color-gray-0) 88%, white), color-mix(in srgb, var(--mantine-color-dark-5) 52%, transparent))",
		borderColor: running
			? "light-dark(var(--mantine-color-orange-3), color-mix(in srgb, var(--mantine-color-orange-6) 45%, transparent))"
			: "var(--mantine-color-default-border)",
	};
	const titleColor = running
		? "light-dark(var(--mantine-color-orange-9), var(--mantine-color-orange-2))"
		: "var(--mantine-color-text)";
	const summaryColor = running
		? "light-dark(var(--mantine-color-orange-9), var(--mantine-color-orange-1))"
		: "var(--mantine-color-dimmed)";
	const iconColor = running
		? "orange"
		: reflection.status === "confirmed"
			? "green"
			: reflection.status === "cancelled"
				? "red"
				: reflection.status === "aborted"
					? "orange"
					: // `failed` is yellow, not red: red is the "judged unsafe" colour and this
						// gate never reached a judgement.
						reflection.status === "failed"
						? "yellow"
						: "gray";
	// A running gate shows a SHIELD, not a spinner. The gate's defining property is that
	// the user may step in (approve, reject, take over manually), and a spinner says the
	// opposite — "wait, nothing for you here". The shield is also the shape this state
	// carries in the sidebar, so the two surfaces agree (see `StatusShape`).
	const icon = running ? (
		<IconShield size={14} />
	) : reflection.status === "confirmed" ? (
		<IconCheck size={14} />
	) : reflection.status === "cancelled" ? (
		<IconX size={14} />
	) : reflection.status === "aborted" ? (
		<IconBan size={14} />
	) : reflection.status === "failed" ? (
		<IconAlertTriangle size={14} />
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
					{running && reflectionRequestId && (isDanger || isPlan || isTask || isQuestion) && (
						<Group gap="xs" mt="xs" wrap="nowrap">
							<Button
								size="xs"
								variant="light"
								color="orange"
								leftSection={<IconPlayerStop size={12} />}
								loading={takingOver}
								onClick={handleTakeOver}
							>
								{t("manualTakeoverReflection")}
							</Button>
							{/* Live two-phase progress beside the button (parity with the exact
							    vlist, which paints it in the same reserved row). */}
							{reflectionProgress && (
								<Text size="xs" c="dimmed" truncate>
									{reflectionProgressLabel(t, reflectionProgress)}
								</Text>
							)}
						</Group>
					)}
				</Box>
			</Group>
		</Paper>
	);
}

/**
 * The 12px status glyph shared by the tool card header and the subagent card's
 * header / "recent calls" rows.
 *
 * `streaming` belongs in the in-flight branch, not the fallback: it is the FIRST
 * status a call ever has. `tool_use_chunk` fires while the model is still writing
 * the tool's arguments and reaches the subagent activity row as `"streaming"`
 * (useNarratorChunksWS.ts — the live chunk path and the reconnect snapshot both
 * label a not-yet-started call that way); `tool_started` only promotes it to
 * `"running"` once execution actually begins. Falling through to `null` meant a
 * brand-new row rendered an EMPTY status slot and the spinner appeared seconds
 * late — the row looked idle during the one phase it is most obviously working.
 *
 * So this is not a dead branch: it is the branch that runs first. Every in-flight
 * status shares one arm because a spinner is the only honest glyph for "not
 * finished"; only terminal states get a distinct mark.
 */
export function StatusIcon({ status }: { status: string }) {
	if (
		status === "streaming" ||
		status === "running" ||
		status === "pending" ||
		status === "initializing"
	) {
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
		const cat = getCategory(toolCall.toolName, toolCall.inputJson);
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
		const executionTarget = useMemo(() => getExecutionTargetDisplay(toolCall), [toolCall]);
		const isRemoteTarget = !!executionTarget.deviceId && executionTarget.deviceId !== "local";
		// Resolve a human-readable device name from the narrator's execution-device
		// list (already cached by NarratorPanel). Falls back to the raw id.
		const remoteDeviceName = useQuery({
			queryKey: ["narratorExecutionDevices", narratorId],
			queryFn: () => api.getNarratorExecutionDevices(narratorId as string),
			enabled: isRemoteTarget && !!narratorId,
			staleTime: 30_000,
			select: (data) => data.devices.find((d) => d.id === executionTarget.deviceId)?.name ?? null,
		}).data;
		const remoteDeviceLabel = remoteDeviceName ?? executionTarget.deviceId ?? "";
		const executionTargetTooltip = useMemo(() => {
			if (!executionTarget.deviceId) return null;
			const lines = [
				t("executionTargetDevice", {
					device:
						executionTarget.deviceId === "local" ? t("executionTargetLocal") : remoteDeviceLabel,
				}),
			];
			if (executionTarget.cwd) {
				lines.push(t("executionTargetCwd", { cwd: executionTarget.cwd }));
			}
			if (executionTarget.resolvedFilePath) {
				lines.push(t("executionTargetPath", { path: executionTarget.resolvedFilePath }));
			}
			return lines.join("\n");
		}, [executionTarget, remoteDeviceLabel, t]);

		const [startTimeOpened, setStartTimeOpened] = useState(false);
		const [timeoutEditorOpened, setTimeoutEditorOpened] = useState(false);
		const handleStartTimeOpenedChange = useCallback((nextOpened: boolean) => {
			setStartTimeOpened(nextOpened);
			if (nextOpened) setTimeoutEditorOpened(false);
		}, []);
		const handleTimeoutEditorOpenedChange = useCallback((nextOpened: boolean) => {
			setTimeoutEditorOpened(nextOpened);
			if (nextOpened) setStartTimeOpened(false);
		}, []);
		// Use concise labels for tool families with action-like names.
		const displayName = useMemo(() => {
			if (cat === "terminal") {
				const action = extractField(toolCall.inputJson, "action");
				if (action) return `Terminal ${action.charAt(0).toUpperCase()}${action.slice(1)}`;
			}
			if (cat === "pipeline") {
				if (toolCall.toolName === "StartPipeline") return t("pipelineStart");
				if (toolCall.toolName === "ExtractPipeline") return t("pipelineExtract");
				return t("pipelineEnd");
			}
			return toolCall.toolName;
		}, [cat, toolCall.toolName, toolCall.inputJson, t]);

		// For Bash and Await tools, resolve the effective timeout (from _timeoutMs,
		// inputJson, or a per-tool default). Background Bash without an explicit
		// timeout has no wall-clock deadline and therefore no countdown to display.
		const effectiveTimeoutMs = useMemo(() => {
			if (cat !== "bash" && cat !== "await") return null;
			const input =
				toolCall.inputJson && typeof toolCall.inputJson === "object"
					? (toolCall.inputJson as Record<string, unknown>)
					: null;
			const backgroundBash = cat === "bash" && input?.run_in_background === true;
			if (toolCall._timeoutMs != null) return toolCall._timeoutMs;
			const ms = extractNumericField(toolCall.inputJson, "timeout");
			if (ms != null) return ms;
			if (backgroundBash) return null;
			return cat === "await" ? DEFAULT_AWAIT_TIMEOUT_MS : DEFAULT_BASH_TIMEOUT_MS;
		}, [cat, toolCall._timeoutMs, toolCall.inputJson]);

		// For Bash tools, prefer pure execution time (excludes streaming parse + permission wait)
		const finalDurationMs = resolveToolFinalDurationMs(toolCall);
		const displayDurationMs =
			cat === "bash" ? (getBashExecDurationMs(toolCall) ?? finalDurationMs) : finalDurationMs;
		const isActive =
			toolCall.status === "running" ||
			toolCall.status === "pending" ||
			toolCall.status === "initializing";
		const canEditTimeout =
			isActive && effectiveTimeoutMs != null && !!narratorId && !!toolCall.toolUseId;
		const openTimeoutEditor = useCallback(() => {
			if (canEditTimeout) handleTimeoutEditorOpenedChange(true);
		}, [canEditTimeout, handleTimeoutEditorOpenedChange]);

		useEffect(() => {
			if (!canEditTimeout) handleTimeoutEditorOpenedChange(false);
		}, [canEditTimeout, handleTimeoutEditorOpenedChange]);

		const timeoutText =
			effectiveTimeoutMs != null ? (
				<span
					className={`${toolCardClasses.headerText} ${toolCardClasses.mono} ${toolCardClasses.dimmed}${canEditTimeout ? "" : ` ${toolCardClasses.headerTimeoutStatic}`}`}
				>
					/ {formatDurationText(effectiveTimeoutMs, { style: "timeout" })}
				</span>
			) : null;
		const timeoutNode =
			timeoutText && canEditTimeout && narratorId && toolCall.toolUseId ? (
				<TimeoutEditorPopover
					timeoutMs={effectiveTimeoutMs}
					narratorId={narratorId}
					toolUseId={toolCall.toolUseId}
					opened={timeoutEditorOpened}
					onChange={handleTimeoutEditorOpenedChange}
				>
					{timeoutText}
				</TimeoutEditorPopover>
			) : (
				timeoutText
			);
		const timeAreaNode = (
			<ToolTimingArea
				toolCall={toolCall}
				isActive={isActive}
				displayDurationMs={displayDurationMs}
				timeout={timeoutNode}
				opened={startTimeOpened}
				onOpenedChange={handleStartTimeOpenedChange}
				onMouseActivate={canEditTimeout ? openTimeoutEditor : undefined}
			/>
		);

		// ContextAsk streams a cumulative character count via the tool_output
		// channel (stored in _streamingOutput). While running, surface it in the
		// header as a live counter, mirroring the compact progress indicator.
		const contextAskLiveChars =
			toolCall.toolName === "ContextAsk" && isActive
				? Number.parseInt(toolCall._streamingOutput ?? "", 10)
				: Number.NaN;
		const showContextAskChars = Number.isFinite(contextAskLiveChars) && contextAskLiveChars > 0;

		const statusNode = (
			<span className={toolCardClasses.headerStatusRow}>
				<span
					className={toolCardClasses.headerStatusIcon}
					style={{
						color: `var(--mantine-color-${statusColor}-text, var(--mantine-color-${statusColor}-6))`,
					}}
				>
					<StatusIcon status={toolCall.status} />
				</span>
				{timeAreaNode}
				{showContextAskChars && (
					<span
						className={`${toolCardClasses.headerText} ${toolCardClasses.mono} ${toolCardClasses.dimmed}`}
					>
						{t("contextAskOutputChars", { count: contextAskLiveChars })}
					</span>
				)}
				{toolCall.permissionDecidedBy?.startsWith("narrator:") && (
					<Tooltip label={t("proxyApprovedTooltip")}>
						<Badge size="xs" variant="light" color="grape" leftSection={<IconUsers size={10} />}>
							{t("proxyApprovedBadge")}
						</Badge>
					</Tooltip>
				)}
			</span>
		);

		const content = (
			<span className={toolCardClasses.headerMainRow}>
				<ToolCategoryChip category={cat} toolName={toolCall.toolName} />
				<span
					className={`${toolCardClasses.headerText} ${toolCardClasses.mono} ${toolCardClasses.dimmed} ${toolCardClasses.fw600} ${toolCardClasses.noShrink}`}
				>
					{displayName}
				</span>
				{searchPathSuffix ? (
					<span className={toolCardClasses.headerSearchSummary} title={summary}>
						<span>{extractField(toolCall.inputJson, "pattern", "glob")}</span>
						<span style={{ color: "var(--mantine-color-dimmed)", marginLeft: 4 }}>
							in {searchPathSuffix}
						</span>
					</span>
				) : (
					<span
						className={`${toolCardClasses.headerText} ${toolCardClasses.mono} ${toolCardClasses.truncate}`}
						title={summary}
					>
						{summary}
					</span>
				)}
				{isRemoteTarget && (
					<Tooltip label={executionTargetTooltip} multiline>
						<Badge
							size="xs"
							variant="light"
							color="indigo"
							leftSection={<IconDevices size={11} />}
							styles={{ root: { paddingLeft: 4, paddingRight: 4 } }}
						>
							{remoteDeviceLabel}
						</Badge>
					</Tooltip>
				)}
			</span>
		);

		const handleClick = useCallback(
			(event: React.MouseEvent) => {
				// When Ctrl/Cmd or Shift is held, skip toggle — let the event bubble
				// up to the outer selection handler so the card is only selected.
				if (event.metaKey || event.ctrlKey || event.shiftKey) return;
				onToggle?.();
			},
			[onToggle],
		);

		return (
			<div className={toolCardClasses.headerButton} {...{ [TOOL_HEADER_SELECT_ATTR]: "" }}>
				<button
					type="button"
					onClick={handleClick}
					aria-expanded={onToggle ? opened : undefined}
					className={`${toolCardClasses.headerToggle}${onToggle ? "" : ` ${toolCardClasses.headerButtonStatic}`}`}
				>
					{content}
				</button>
				<span className={toolCardClasses.headerTrailingRow}>
					{statusNode}
					<InlineTerminateControl toolCall={toolCall} narratorId={narratorId} />
					{onToggle ? (
						<UnstyledButton
							type="button"
							onClick={handleClick}
							aria-expanded={opened}
							aria-label={displayName}
							className={toolCardClasses.headerChevron}
						>
							{opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
						</UnstyledButton>
					) : (
						<span className={toolCardClasses.headerChevron}>
							{opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
						</span>
					)}
				</span>
			</div>
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
			p.streamStartedAt === n.streamStartedAt &&
			p.permissionStartedAt === n.permissionStartedAt &&
			p.executionStartedAt === n.executionStartedAt &&
			p.completedAt === n.completedAt &&
			p.createdAt === n.createdAt &&
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

/** Total KB label for a set of truncated leaves ("" when unknown). */
function truncatedSizeLabel(totalBytes: number): string {
	return totalBytes > 0 ? `${Math.max(1, Math.round(totalBytes / 1024))}KB` : "";
}

/**
 * ONE truncation notice per card, covering every truncated field in its payload.
 *
 * Truncation is field-level now, so a card can legitimately have several
 * independently cut fields (an Edit's old_string AND new_string, an output body
 * next to a large metadata blob). Sixteen per-field badges would stack up as
 * duplicate chips saying the same thing, so the notice is rendered once at the end
 * of the detail region and reports the COUNT plus the total size.
 */
function ToolIOTruncationSummary({ toolCall }: { toolCall: ToolCallData }) {
	const leaves = useMemo(
		() => [
			...collectTruncatedLeaves(toolCall.inputJson),
			...collectTruncatedLeaves(toolCall.outputJson),
		],
		[toolCall.inputJson, toolCall.outputJson],
	);
	if (leaves.length === 0) return null;
	let totalBytes = 0;
	for (const leaf of leaves) totalBytes += leaf.fullLength;
	// The COMBINED size of every cut field is what the notice reports; the field
	// count itself only decides that the notice exists at all.
	return <TruncatedBadge fullLength={totalBytes} />;
}

/** Indicator shown when tool call content is truncated. */
function TruncatedBadge({ fullLength }: { fullLength?: number }) {
	const { t } = useTranslation("narrator");
	const { isLoading, isError, refetch } = useContext(TruncationFetchCtx);

	if (isLoading) {
		return (
			<Group gap={4} mt={2}>
				<IconLoader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
				<Text size="xs" c="dimmed" fs="italic">
					{t("truncatedLoading", { size: truncatedSizeLabel(fullLength ?? 0) })}
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
			{t("truncatedPreview", { size: truncatedSizeLabel(fullLength ?? 0) })}
		</Text>
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

	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const lang = fp ? getShikiLang(fp) : undefined;
	// Recursive probe: after field-level projection the input's ROOT is a plain
	// object, so a root check would claim a cut `content`/`old_string` is complete.
	const inputIsTruncated = hasTruncatedLeaf(toolCall.inputJson);

	// For Write tool, display the written content from input instead of the result prompt
	const writeFullContent =
		isWrite && !inputIsTruncated ? String(toolCall.inputJson?.content ?? "") : undefined;
	const writeContent = isWrite
		? inputIsTruncated
			? // `extractField` resolves a truncated `content` leaf to its preview; the
				// old `inputJson.preview` fallback belonged to the root-wrapper era.
				extractField(toolCall.inputJson, "content")
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
				<ContentViewer
					content={extractField(toolCall.inputJson, "new_string", "old_string", "content")}
					style={codeStyle}
					title={fp ? basename(fp) : "Edit"}
					language={lang}
				/>
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
 * Inline terminate control for long-running tool calls (bash commands and MCP
 * tools). Rendered as a tiny stop icon inside the tool header's trailing row
 * (next to the elapsed time / status), so it stays visually grouped with the
 * header instead of occupying a full-width button row. Shown for the entire
 * duration the tool is running — no time threshold.
 */
const InlineTerminateControl = memo(
	function InlineTerminateControl({
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

		if (!isLongRunnable || !isRunning) return null;

		return (
			<Tooltip label={tNarrator("terminateProcess")} position="top" withArrow fz="xs">
				<UnstyledButton
					aria-label={tNarrator("terminateProcess")}
					className={toolCardClasses.headerTerminate}
					{...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}
					onClick={(e: React.MouseEvent) => {
						// Prevent the header toggle from firing.
						e.stopPropagation();
						if (narratorId && !interruptMutation.isPending) {
							interruptMutation.mutate(narratorId);
						}
					}}
				>
					{interruptMutation.isPending ? (
						<IconLoader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
					) : (
						<IconPlayerStop size={11} />
					)}
				</UnstyledButton>
			</Tooltip>
		);
	},
	(prev, next) => {
		return (
			prev.toolCall.toolName === next.toolCall.toolName &&
			prev.toolCall.status === next.toolCall.status &&
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
				</>
			)}
		</Box>
	);
}

function WebSearchDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const query = extractField(toolCall.inputJson, "query");
	const raw = resolveDisplayText(toolCall.outputJson);
	const rawFull = resolveFullDisplayText(toolCall.outputJson);
	// A partial body cannot be parsed as JSON, so the structured view is skipped.
	const outputIsTruncated = hasTruncatedLeaf(toolCall.outputJson);

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
	const openImageViewer = useImageViewer();
	const fetchUrl = extractField(toolCall.inputJson, "url");
	const mode = extractField(toolCall.inputJson, "mode");
	const selector = extractField(toolCall.inputJson, "selector");
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
				<Badge size="xs" variant="light" color="orange" mt={4}>
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
				</>
			)}
			{isScreenshot && screenshotPreviewUrl && (
				<Box mt="xs">
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: opens fullscreen viewer; Escape/keys handled there */}
					<img
						src={screenshotPreviewUrl}
						alt={fetchUrl || "screenshot"}
						onClick={() =>
							openImageViewer({ src: screenshotPreviewUrl, filename: fetchUrl || "screenshot" })
						}
						style={{
							maxWidth: "100%",
							maxHeight: 400,
							borderRadius: "var(--mantine-radius-sm)",
							objectFit: "contain",
							display: "block",
							cursor: "pointer",
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
					<ContentViewer
						content={outputText}
						fullContent={outputFullText}
						style={termStyle}
						title="Terminal Buffer"
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
	const openImageViewer = useImageViewer();
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
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: opens fullscreen viewer; Escape/keys handled there */}
				<img
					src={previewUrl}
					alt={filename}
					onError={() => setError(true)}
					onClick={() => openImageViewer({ src: previewUrl, filename, alt: filename })}
					style={{
						maxWidth: "100%",
						maxHeight: 400,
						borderRadius: "var(--mantine-radius-sm)",
						objectFit: "contain",
						display: "block",
						cursor: "pointer",
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
		return formatLocaleDateTime(expiresAt) || expiresAt;
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
								<Badge size="xs" variant="light" color="orange">
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
	return (
		formatLocaleDateTime(iso, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}) || iso
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
	const openImageViewer = useImageViewer();
	const action = extractField(toolCall.inputJson, "action");
	const url = extractField(toolCall.inputJson, "url");
	const selector = extractField(toolCall.inputJson, "selector");
	const sessionId = extractField(toolCall.inputJson, "session_id");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
	const meta = toolCall.outputJson?._metadata ?? toolCall._metadata;
	const previewUrl = meta?.previewUrl as string | undefined;
	const isScreenshot = action === "screenshot";
	const localizedError = useLocalizedToolError(toolCall.errorMessage);

	return (
		<Box mt="xs">
			<Group gap={6} mb={4}>
				{action && (
					<Badge size="xs" variant="light" color="orange">
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
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: opens fullscreen viewer; Escape/keys handled there */}
					<img
						src={previewUrl}
						alt={t("browser.screenshotAlt")}
						onClick={() =>
							openImageViewer({
								src: previewUrl,
								filename: url || "screenshot",
								alt: t("browser.screenshotAlt"),
							})
						}
						style={{
							maxWidth: "100%",
							maxHeight: 400,
							borderRadius: "var(--mantine-radius-sm)",
							objectFit: "contain",
							display: "block",
							cursor: "pointer",
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
				<ContentViewer
					content={outputText}
					fullContent={outputFullText}
					style={codeStyle}
					title={selector || "DOM"}
					language="html"
				/>
			)}
			{!isScreenshot && action !== "dom" && outputText && (
				<ContentViewer
					content={outputText}
					fullContent={outputFullText}
					style={codeStyle}
					title={action || "Browser"}
				/>
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

function getAwaitAgentTargetId(toolCall: ToolCallData): string | null {
	if (toolCall.toolName !== "Await") return null;
	const input = toolCall.inputJson;
	const metadata = (toolCall.outputJson?._metadata ?? toolCall._metadata) as
		| Record<string, unknown>
		| undefined;
	const awaitType = extractField(input, "type") || (metadata?.awaitType as string | undefined);
	if (awaitType !== "agent") return null;
	const targetId = extractField(input, "id") || (metadata?.targetId as string | undefined);
	return targetId?.trim() || null;
}

function getAwaitAgentNarratorId(toolCall: ToolCallData): string | null {
	if (!getAwaitAgentTargetId(toolCall)) return null;
	const metadata = (toolCall.outputJson?._metadata ?? toolCall._metadata) as
		| Record<string, unknown>
		| undefined;
	const metadataId = metadata?.subagentId ?? metadata?.resolvedId;
	if (typeof metadataId === "string" && metadataId.trim()) return metadataId;
	const output = resolveDisplayText(toolCall.outputJson);
	const outputId = stripSubagentIdTag(output).subagentId;
	return outputId?.trim() || null;
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
	const isExtract = toolCall.toolName === "ExtractPipeline";
	const stageLabel = isStart
		? t("pipelineStageStart")
		: isExtract
			? t("pipelineStageExtract")
			: t("pipelineStageEnd");
	const label = extractField(toolCall.inputJson, "label");
	const maxPreviewChars = extractNumericField(toolCall.inputJson, "maxPreviewChars") ?? 100;
	const aliases = extractStringArrayField(toolCall.inputJson, "aliases");
	const inputRule = extractField(toolCall.inputJson, "rule");
	const format = extractField(toolCall.inputJson, "format") || "sections";
	const maxChars = extractNumericField(toolCall.inputJson, "maxChars");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);
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
				<Badge size="xs" variant="light" color={isStart ? "blue" : isExtract ? "teal" : "indigo"}>
					{stageLabel}
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
						{t("pipelinePreviewChars", { value: formatLocaleNumber(maxPreviewChars) })}
					</Badge>
				)}
				{maxChars != null && (
					<Badge size="xs" variant="outline" color="gray">
						{t("pipelineMaxChars", { value: formatLocaleNumber(maxChars) })}
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
		</Box>
	);
}

function GenericDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const inputText = resolveDisplayText(toolCall.inputJson);
	const inputFullText = resolveFullDisplayText(toolCall.inputJson);
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);

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
				</>
			)}
		</Box>
	);
}

// Dynamic Spec task statuses (spec://tasks.json): todo/doing/done/blocked.
const SPEC_TASK_STATUS_ICON: Record<string, { icon: typeof IconCheck; color: string }> = {
	done: { icon: IconCheck, color: "green" },
	doing: { icon: IconPlayerPlay, color: "blue" },
	blocked: { icon: IconBan, color: "orange" },
	todo: { icon: IconChevronRight, color: "yellow" },
};

interface SpecTaskEntry {
	text?: string;
	status?: string;
	protected?: boolean;
}

/** Best-effort extraction of the spec task list from a tool call's input/output. */
function extractSpecTasks(toolCall: ToolCallData): SpecTaskEntry[] | null {
	// Try parsing tasks from metadata first (populated for Read & Edit tools on spec://tasks.json)
	const meta = toolCall.outputJson?._metadata ?? toolCall._metadata;
	if (meta?.tasks && Array.isArray(meta.tasks)) {
		return meta.tasks as SpecTaskEntry[];
	}

	const tryParse = (raw: unknown): SpecTaskEntry[] | null => {
		if (typeof raw !== "string") return null;
		try {
			const doc = JSON.parse(raw);
			return Array.isArray(doc?.tasks) ? (doc.tasks as SpecTaskEntry[]) : null;
		} catch {
			return null;
		}
	};
	if (!isTruncated(toolCall.inputJson)) {
		// Write: full document in input.content.
		const fromInput = tryParse(toolCall.inputJson?.content);
		if (fromInput) return fromInput;
		// Edit: a full-document rewrite carries the whole doc in new_string
		// (creation writes it via old_string === "").
		const fromEdit = tryParse(toolCall.inputJson?.new_string);
		if (fromEdit) return fromEdit;
	}
	if (!isTruncated(toolCall.outputJson)) {
		const out = toolCall.outputJson;
		const fromOutput = tryParse(typeof out === "string" ? out : out?.content);
		if (fromOutput) return fromOutput;
	}
	return null;
}

function SpecTasksDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const { isThinking, latestSpecTasksToolUseId } = useContext(LatestTodosToolUseIdCtx);
	const tasks = extractSpecTasks(toolCall);

	// Only the most recent tasks snapshot reflects the live task state; older
	// snapshots must not spin. When the latest id is unknown (null), fall back to
	// isThinking alone so the streaming/live card still animates.
	const isLatestTasksCard =
		latestSpecTasksToolUseId == null || toolCall.toolUseId === latestSpecTasksToolUseId;

	// Partial Edits (and the pending window before the resolved task list is
	// available) may not carry the full document — fall back to the file diff/
	// content view rather than a raw JSON dump of the tool input.
	if (tasks === null) {
		return <FileDetail toolCall={toolCall} />;
	}

	// Valid empty task document ({ tasks: [] }) — show a compact empty state
	// instead of dumping the raw JSON.
	if (tasks.length === 0) {
		return (
			<Box mt="xs">
				<Paper withBorder radius="sm" px="sm" py={6}>
					<Group gap={6} wrap="nowrap">
						<ThemeIcon size={16} variant="light" color="gray" radius="xl">
							<IconListCheck size={10} />
						</ThemeIcon>
						<Text size="xs" c="dimmed" fs="italic">
							{t("spec.tasksEmpty")}
						</Text>
					</Group>
				</Paper>
			</Box>
		);
	}

	return (
		<Box mt="xs">
			<List spacing={4} size="xs" center>
				{tasks.map((task, i) => {
					const entry = SPEC_TASK_STATUS_ICON[task.status ?? "todo"] ?? SPEC_TASK_STATUS_ICON.todo;
					const spinning = isThinking && isLatestTasksCard && task.status === "doing";
					const StatusIconComp = spinning ? IconLoader2 : entry.icon;
					return (
						<List.Item
							// biome-ignore lint/suspicious/noArrayIndexKey: spec tasks lack unique IDs
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
							<Group gap={4} wrap="nowrap">
								{task.protected && <IconLock size={11} color="var(--mantine-color-yellow-6)" />}
								<Text size="xs" c={task.status === "done" ? "dimmed" : undefined}>
									{task.text ?? "—"}
								</Text>
							</Group>
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
				<ContentViewer
					content={toolCall.outputJson.preview}
					style={codeStyle}
					title={`TaskOutput ${taskId}`}
				/>
			)}
		</Box>
	);
}

function PlanDetail({ toolCall, maxHeight }: { toolCall: ToolCallData; maxHeight?: number }) {
	const { t } = useTranslation("narrator");
	// Plan content lives in inputJson.plan. It may be resolved before user approval
	// (for plan reflection), so render it independently from the final tool status.
	//
	// `hasUsablePlanBody` filters out our own model-facing plan reference: a model
	// can echo that sentence back as this call's `plan`, and rendering it would show
	// the user "the plan is saved in <path>" in place of the plan. Treated as no
	// plan so the caller's pending-permission override supplies the real body.
	const planText =
		toolCall.toolName === "ExitPlanMode" && hasUsablePlanBody(toolCall.inputJson?.plan)
			? (toolCall.inputJson?.plan as string)
			: "";

	// `_planFile` marks a file-based plan; show its provenance so the user can see
	// which plan file the body came from (the model only gets a path reference).
	const planFile =
		toolCall.toolName === "ExitPlanMode" && typeof toolCall.inputJson?._planFile === "string"
			? toolCall.inputJson._planFile
			: "";

	const isDenied = toolCall.status === "fail" && toolCall.toolName === "ExitPlanMode";
	// User feedback is stored in permissionDenyMessage (raw user input, not the full system prompt)
	const denyFeedback = isDenied ? (toolCall.permissionDenyMessage ?? undefined) : undefined;
	const [planExpanded, setPlanExpanded] = useState(!isDenied);

	const planSourceNotice = planFile ? (
		<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={planFile}>
			{t("planSourceFile", { file: planFile })}
		</Text>
	) : null;

	if (!planText) {
		// A filtered-out reference still knows which file holds the real plan. Show
		// that provenance alone rather than nothing: it is the only thing the row
		// can still say truthfully, and it points the user at the actual plan.
		return planSourceNotice ? <Box mt="xs">{planSourceNotice}</Box> : null;
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
						{planSourceNotice}
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
			{planSourceNotice}
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
	const cat = getCategory(toolCall.toolName, toolCall.inputJson);
	// The real `file_path` is the last resort, not an afterthought: a live chunk
	// MERGES into an already-persisted input (mergeToolFields), so a re-streamed
	// call can carry the settled path on the input itself while the stream markers
	// only describe the field in flight.
	const filePath =
		(toolCall.inputJson?._streamingFilePath as string | undefined) ||
		fields?.file_path ||
		getFilePath(toolCall.inputJson);
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

		const isContentField = sfName === "content" || sfName === "new_string";
		if (!isContentField || !sfValue) return null;
		// A missing path only costs the path row and the syntax language — the
		// streamed body is still the most useful thing on the card. Write emits
		// `content` before `file_path` often enough that gating the whole preview on
		// the path left the card blank for the entire write.
		return (
			<Box mt="xs">
				{filePath && (
					<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={filePath}>
						{filePath}
					</Text>
				)}
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
	const openImageViewer = useImageViewer();
	const fsCapability = useFileSystemCapability();
	const previewCapability = fsCapability.preview;
	const fp = getFilePath(toolCall.inputJson);
	const meta = toolCall.outputJson?._metadata ?? toolCall._metadata;
	const isImage = meta?.isImage === true;
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputFullText = resolveFullDisplayText(toolCall.outputJson);

	// Image preview: fetch via /api/fs/preview (same pattern as Codex image generation)
	const filePath = isImage ? ((meta?.filePath as string) ?? fp) : undefined;
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
	const previewUnsupported = !!filePath && !previewCapability.supported;

	useEffect(() => {
		if (!filePath || !previewCapability.supported) return;
		let cancelled = false;
		setLoadError(false);
		setLoadErrorMessage(null);
		authorizedFetch(`/api/fs/preview?path=${encodeURIComponent(filePath)}`)
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
					// biome-ignore lint/a11y/useKeyWithClickEvents: opens fullscreen viewer; Escape/keys handled there
					<img
						src={blobUrl}
						alt={fp || "image"}
						onClick={() =>
							openImageViewer({
								src: blobUrl,
								savedPath: filePath,
								filename: (filePath || fp || "image").split(/[\\/]/).pop(),
								alt: fp || "image",
							})
						}
						style={{
							maxWidth: "100%",
							maxHeight: 400,
							borderRadius: "var(--mantine-radius-sm)",
							objectFit: "contain",
							display: "block",
							cursor: "pointer",
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
				<ContentViewer
					content={outputText}
					fullContent={outputFullText}
					style={codeStyle}
					title={fp || "Read"}
					language={fp ? getShikiLang(fp) : undefined}
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

/**
 * The card's expanded detail region: the per-category body plus ONE truncation
 * notice covering every truncated field in the payload.
 *
 * The notice lives here rather than inside each category renderer because
 * field-level truncation can cut several fields of one call; sixteen per-field
 * badges (the previous design, one per body) would stack duplicates.
 */
function DetailRenderer({ toolCall }: { toolCall: ToolCallData }) {
	return (
		<>
			<DetailBody toolCall={toolCall} />
			<ToolIOTruncationSummary toolCall={toolCall} />
		</>
	);
}

function DetailBody({ toolCall }: { toolCall: ToolCallData }) {
	const cat = getCategory(toolCall.toolName, toolCall.inputJson);
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
		case "tasks":
			return <SpecTasksDetail toolCall={toolCall} />;
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
		case "knowledge":
			return <KnowledgeDetail toolCall={toolCall} />;
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

// --- Inline allow-and-retry UI for denied tool calls ---

/**
 * Renders an "allow and execute" button for a tool call that was denied (or
 * whose pending permission was cancelled by an interrupt) in the latest
 * assistant turn. Clicking re-executes the tool and auto-continues the loop.
 */
function InlineAllowRetry({
	toolUseId,
	onAllowRetry,
}: {
	toolUseId: string;
	onAllowRetry: (toolUseId: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const [submitting, setSubmitting] = useState(false);
	return (
		<Box mt="xs" {...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}>
			<Text size="xs" c="dimmed" mb={4}>
				{t("allowRetryHint")}
			</Text>
			<Button
				size="xs"
				color="green"
				variant="light"
				leftSection={<IconPlayerPlay size={12} />}
				loading={submitting}
				onClick={() => {
					setSubmitting(true);
					onAllowRetry(toolUseId);
				}}
			>
				{t("allowAndExecute")}
			</Button>
		</Box>
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
	const permissionTarget = permission.executionTarget ?? permission.executionTargets?.[0];
	const permissionTargetDeviceId = permissionTarget?.deviceId ?? permission.executionDeviceId;
	const permissionTargetCwd = permissionTarget?.cwd ?? permission.executionCwd;
	const permissionLexicalPath = permissionTarget?.lexicalPath ?? permission.resolvedFilePath;
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
					reflectionDeadline={permission.reflectionDeadline}
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
			{/* ExitPlanMode is a plan-approval gate, not a filesystem/command action:
			    its routed "target" is just the plan file the platform already read.
			    Showing device/cwd/lexical/canonical paths there is noise, and the
			    block's variable height fought the plan card's measured geometry. */}
			{permissionTargetDeviceId && !isExitPlan && (
				<Paper withBorder p="xs" mb="xs" radius="sm">
					<Group gap="xs" mb={permissionTargetCwd || permissionLexicalPath ? 4 : 0} wrap="wrap">
						<Text size="xs" fw={600}>
							{t("executionTarget")}
						</Text>
						<Badge
							size="xs"
							variant="light"
							color={permissionTargetDeviceId === "local" ? "gray" : "indigo"}
						>
							{permissionTargetDeviceId === "local"
								? t("executionTargetLocal")
								: permissionTargetDeviceId}
						</Badge>
						{permissionTarget?.pathFlavor && (
							<Badge size="xs" variant="outline" color="blue">
								{t("executionTargetPathFlavor", { flavor: permissionTarget.pathFlavor })}
							</Badge>
						)}
						{permissionTarget?.runtimeGeneration != null && (
							<Badge size="xs" variant="outline" color="grape">
								{t("executionTargetRuntimeGeneration", {
									generation: permissionTarget.runtimeGeneration,
								})}
							</Badge>
						)}
					</Group>
					{permissionTargetCwd && (
						<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
							{t("executionTargetCwd", { cwd: permissionTargetCwd })}
						</Text>
					)}
					{permissionLexicalPath && (
						<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
							{t("executionTargetLexicalPath", { path: permissionLexicalPath })}
						</Text>
					)}
					{permissionTarget?.canonicalPath && (
						<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
							{t("executionTargetCanonicalPath", { path: permissionTarget.canonicalPath })}
						</Text>
					)}
				</Paper>
			)}
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

/**
 * Whether a tool call still carries truncated data in its input or output.
 *
 * Recursive (`hasTruncatedLeaf`), NOT a root-level `_truncated` probe: truncation
 * is field-level, so an object payload's ROOT is a plain object and a root probe
 * always reports "complete". That silently disabled this whole fetch — the card
 * offered to load the full content and nothing happened. `{_text, _metadata}`
 * outputs (every tool that reports metadata) hit exactly that path.
 */
function hasTruncatedData(toolCall: ToolCallData): boolean {
	return hasTruncatedLeaf(toolCall.inputJson) || hasTruncatedLeaf(toolCall.outputJson);
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
		p.executionDeviceId !== n.executionDeviceId ||
		p.executionCwd !== n.executionCwd ||
		p.resolvedFilePath !== n.resolvedFilePath ||
		p.deviceSelectionSource !== n.deviceSelectionSource ||
		p.startedAt !== n.startedAt ||
		p.streamStartedAt !== n.streamStartedAt ||
		p.permissionStartedAt !== n.permissionStartedAt ||
		p.executionStartedAt !== n.executionStartedAt ||
		p.completedAt !== n.completedAt ||
		p.createdAt !== n.createdAt ||
		p.errorMessage !== n.errorMessage
	) {
		return false;
	}
	// Compare other props
	if (
		prev.narratorId !== next.narratorId ||
		prev.inRun !== next.inRun ||
		prev.isLast !== next.isLast ||
		prev.isRecent !== next.isRecent ||
		prev.blockIndex !== next.blockIndex ||
		prev.pendingPermission !== next.pendingPermission ||
		prev.onPermissionDecision !== next.onPermissionDecision ||
		prev.onQuestionSubmit !== next.onQuestionSubmit ||
		prev.onQuestionReflect !== next.onQuestionReflect ||
		prev.onQuestionDeny !== next.onQuestionDeny ||
		prev.onViewSubagentSession !== next.onViewSubagentSession ||
		prev.onOpenFilePanel !== next.onOpenFilePanel
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
	onViewSubagentSession,
	onOpenFilePanel,
	blockIndex,
	isRecent = true,
}: ToolCallCardProps) {
	const cat = getCategory(toolCall.toolName, toolCall.inputJson);
	const isEdit = isEditTool(toolCall.toolName);
	const isPlan = cat === "plan";
	// Streaming tool chunks (still being generated) — not expandable
	const isStreaming = toolCall.inputJson?._streamingChars != null;

	// --- One-shot outcome sweep on in-flight → settled (green success / red failure) ---
	// The colour mapping and the transition rule come from `@shared/tool-shimmer`, so
	// this card cannot disagree with the vlist card or either folded-row path.
	//
	// What stays LOCAL is the fresh-mount allowance, which the shared rule
	// deliberately refuses: prevStatusRef starts as null so we can detect the *mount*
	// case: when the streaming synthetic message is replaced by the real assistant
	// message the outer container key changes, React mounts a fresh ToolCallCard whose
	// initial status is already "success".  For non-truncated data this means the tool
	// just finished, so we should still play the sweep.
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
	const [outcomeFlash, setOutcomeFlash] = useState<ToolShimmerFlash | null>(null);
	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = toolCall.status;
		let freshMount = prev === null && !isTruncated;
		if (freshMount) {
			if (toolCall.startedAt == null) {
				// No startedAt → loaded from history or real-message replacement,
				// the sweep was already played on the streaming card (if any).
				freshMount = false;
			} else if (toolCall.durationMs != null) {
				// Has timing info — only sweep if finished within the last 2 s.
				const finishedAt = toolCall.startedAt + toolCall.durationMs;
				if (Date.now() - finishedAt > 2000) {
					freshMount = false;
				}
			}
		}
		// A real transition, or a mount this card has independent evidence for.
		const next = freshMount
			? resolveToolShimmerOutcome(toolCall.status)
			: resolveToolShimmerFlash(prev, toolCall.status);
		// ⚠️ A transition with no flash CLEARS the stored one; it must not just bail.
		// The 650ms timer is torn down by this effect's own cleanup, so a flash that
		// `shimmerPhase` outranked (a retry inside the window: running → fail →
		// running) survived and replayed on the NEXT quiet status — a red sweep on
		// `cancelled`, which must never flash, or a green one while awaiting approval.
		if (!next) {
			setOutcomeFlash(null);
			return;
		}
		setOutcomeFlash(next);
		const timer = setTimeout(() => setOutcomeFlash(null), 650);
		return () => clearTimeout(timer);
	}, [toolCall.status, toolCall.startedAt, toolCall.durationMs, isTruncated]);
	// Auto-expand: permission pending, todo tools, or edit tools.
	// Failed Edit cards auto-expand so the user can see the failure reason.
	// Denied ExitPlanMode defaults to collapsed — plan content is folded inside PlanDetail.
	const isFailed = toolCall.status === "fail";
	const isDeniedPlan = isFailed && toolCall.toolName === "ExitPlanMode";
	// Read-only knowledge lookups carry the most useful payload (results / entry body),
	// so auto-expand them like recall; knowledge writes stay collapsed.
	const isKnowledgeLookup =
		toolCall.toolName === "KnowledgeSearch" || toolCall.toolName === "KnowledgeRead";
	const shouldAutoOpenNonTruncated =
		cat === "tasks" ||
		cat === "share" ||
		cat === "recall" ||
		cat === "send" ||
		cat === "pipeline" ||
		(cat === "await" && (toolCall.outputJson != null || toolCall.startedAt != null)) ||
		(cat === "bash" && (toolCall.outputJson != null || toolCall.startedAt != null)) ||
		(isKnowledgeLookup && toolCall.outputJson != null) ||
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
				cat === "tasks" ||
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

	const interactionEnabled = useRenderInteractive();
	const renderLod = useRenderLod();
	// Effective expanded state, layering the render LOD over the user's own
	// toggle preference (`opened`). Rules:
	//   L6      → always expanded.
	//   L5      → recent cards follow `opened`; older cards collapse to headers.
	//   L4      → all collapse to headers.
	//   L3-L1   → handled upstream by the tool-run gate (this card is not shown).
	// In-progress / streaming / permission cards are exempt — always expanded so
	// actionable content stays visible at every level.
	const lodExempt = isRunning || isStreaming || !!pendingPermission;
	const [lodUserOverride, setLodUserOverride] = useState(false);
	// Reset the manual override whenever the level changes so a new level applies
	// cleanly (the user can re-expand under the new level). Compare-during-render
	// (not an effect) so the reset is synchronous and lint-clean.
	const [prevRenderLod, setPrevRenderLod] = useState(renderLod);
	if (prevRenderLod !== renderLod) {
		setPrevRenderLod(renderLod);
		setLodUserOverride(false);
	}
	const lodBaseOpened =
		lodExempt || lodUserOverride
			? true
			: renderLod >= 6
				? true
				: renderLod === 5
					? isRecent
						? opened
						: false
					: renderLod === 4
						? false
						: opened;
	const effectiveOpened = lodBaseOpened;
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
	const allowRetryCtx = useContext(AllowRetryCtx);
	const msgCtx = useMessageContextMenu();
	const canOfferAllowRetry =
		!pendingPermission &&
		permissionDecisionsSupported &&
		allowRetryCtx.enabled &&
		canAllowRetryToolCall(toolCall) &&
		!!msgCtx.messageId &&
		msgCtx.messageId === allowRetryCtx.latestAssistantMessageId;
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
		) : canOfferAllowRetry && toolCall.toolUseId ? (
			<InlineAllowRetry toolUseId={toolCall.toolUseId} onAllowRetry={allowRetryCtx.onAllowRetry} />
		) : null;

	// Toggling at a level that collapses this card goes through the LOD override
	// so the user's explicit expand survives the level; toggling inside the
	// level's normal expanded window flips the underlying preference instead.
	const collapsesByLod = !lodExempt && (renderLod === 4 || (renderLod === 5 && !isRecent));
	const handleToggle =
		isStreaming || !interactionEnabled
			? undefined
			: () => {
					if (collapsesByLod) {
						setLodUserOverride((v) => !v);
					} else {
						setOpened((o) => !o);
					}
				};

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
	const { t: tNarrator } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const awaitAgentTargetId = getAwaitAgentTargetId(toolCall);
	const embeddedAwaitAgentNarratorId = getAwaitAgentNarratorId(toolCall);
	const { data: queriedAwaitAgentNarratorId } = useQuery({
		queryKey: ["background-tasks", narratorId],
		queryFn: () => api.listBackgroundTasks(narratorId as string),
		enabled: !!(
			narratorId &&
			onViewSubagentSession &&
			awaitAgentTargetId &&
			!embeddedAwaitAgentNarratorId
		),
		staleTime: 2_000,
		refetchInterval: isRunning ? 3_000 : false,
		select: (data) => {
			if (!awaitAgentTargetId) return undefined;
			const task = data.tasks.find(
				(candidate) =>
					candidate.type === "agent" &&
					(candidate.id === awaitAgentTargetId ||
						candidate.alias === awaitAgentTargetId ||
						candidate.subagentNarratorId === awaitAgentTargetId),
			);
			if (task?.subagentNarratorId) return task.subagentNarratorId;
			return data.legacySubagentTasks.find((candidate) => candidate.id === awaitAgentTargetId)?.id;
		},
	});
	const awaitAgentNarratorId = embeddedAwaitAgentNarratorId ?? queriedAwaitAgentNarratorId ?? null;
	const canShowAwaitAgent = !!(awaitAgentTargetId && onViewSubagentSession);
	const hasMessageActions = !!(
		msgCtx.onForkFromMessage ||
		msgCtx.onAskInPassing ||
		msgCtx.onCompactBeforeMessage ||
		(msgCtx.onRollbackToBlock && blockIndex != null) ||
		(msgCtx.onDeleteBlock && blockIndex != null)
	);
	const hasActions =
		interactionEnabled &&
		!!(toolCall.toolUseId || fileMenuPath || hasMessageActions || canShowAwaitAgent);

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
	const isMobileTc = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const swipe = useSwipeMenu({
		enabled: hasActions,
		// Touch swipe works on any pointer type (matches SubagentCard / MessageBubble),
		// so wide-screen tablets get the same left-swipe gesture as narrow viewports.
		touchEnabled: interactionEnabled,
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
			{canShowAwaitAgent && (
				<Menu.Item
					leftSection={<IconEye size={14} />}
					disabled={!awaitAgentNarratorId}
					onClick={() => {
						if (awaitAgentNarratorId) onViewSubagentSession?.(awaitAgentNarratorId);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("viewSubagentSession")}
				</Menu.Item>
			)}
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
			{fileMenuPath && onOpenFilePanel && (
				<Menu.Item
					leftSection={<IconFileText size={14} />}
					onClick={() => {
						onOpenFilePanel(fileMenuPath);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_openFilePanel")}
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
	// Edit-mode preview takes priority. Otherwise, for a live ExitPlanMode prompt,
	// fall back to the plan carried by the pending permission: file-based plans are
	// resolved server-side into the permission payload but never make it into the
	// streamed tool_use input, so toolCall.inputJson.plan is empty until a reload
	// re-hydrates it from the DB. Without this fallback the plan body renders blank
	// while the approval buttons (which read the permission directly) show normally.
	const editPlanPreviewOverride =
		planPreviewOverride && pendingPermission?.id === planPreviewOverride.requestId
			? planPreviewOverride.plan
			: null;
	// `hasUsablePlanBody` is why a reference-holding `plan` counts as absent here:
	// it is a path reference the model echoed back from its stripped history, not a
	// plan body, so the permission's server-resolved plan must take precedence.
	const pendingPlanFallback =
		isPlan &&
		pendingPermission?.toolName === "ExitPlanMode" &&
		typeof pendingPermission.inputJson?.plan === "string" &&
		pendingPermission.inputJson.plan.trim() &&
		!hasUsablePlanBody(toolCall.inputJson?.plan)
			? (pendingPermission.inputJson.plan as string)
			: null;
	const effectivePlanPreviewOverride = editPlanPreviewOverride ?? pendingPlanFallback;

	// Five states, one shared rule (`@shared/tool-shimmer`). `reflection?.status` is
	// what turns a deliberating gate PURPLE: a gate parks its tool at `pending`, so
	// the old status-first chain painted it blue — claiming execution that had not
	// begun. A live phase outranks the closing flash, so a retry resuming inside the
	// flash window shows its current activity rather than the previous outcome.
	const shimmerPhase = resolveToolShimmerPhase({
		isStreaming,
		status: toolCall.status,
		reflectionStatus: reflection?.status ?? null,
		hasPendingPermission: !!pendingPermission,
	});
	const shimmerClass = shimmerPhase
		? CARD_SHIMMER_CLASS[shimmerPhase]
		: outcomeFlash
			? CARD_SHIMMER_CLASS[outcomeFlash]
			: undefined;

	const hasStreamingDetail =
		isStreaming &&
		!!(toolCall.inputJson?._streamingFieldValue || toolCall.inputJson?._streamingFields);

	const cardContent = (
		<NestedBlockCtx.Provider value={tcBlockId ?? null}>
			<ToolHeader
				toolCall={toolCall}
				opened={effectiveOpened}
				onToggle={handleToggle}
				narratorId={narratorId}
			/>
				<Tooltip
					multiline
					w={260}
					label={tNarrator("leakedToolCaptureTooltip")}
					events={{ hover: true, focus: true, touch: true }}
				>
					<Badge
						size="xs"
						variant="light"
						color="grape"
						leftSection={<IconInfoCircle size={11} />}
						style={{ marginInlineStart: 4, marginTop: 2, cursor: "help" }}
					>
						{tNarrator("leakedToolCaptureBadge")}
					</Badge>
				</Tooltip>
			)}
			{isStreaming ? (
				hasStreamingDetail && <StreamingInputDetail toolCall={toolCall} maxHeight={vpHeight} />
			) : (
				<LazyCollapse in={effectiveOpened}>
					<Box style={planStyle}>
						<LazyDetailRenderer
							toolCall={toolCall}
							narratorId={narratorId}
							opened={effectiveOpened}
							planPreviewOverride={effectivePlanPreviewOverride}
						/>
					</Box>
					{permissionUI}
				</LazyCollapse>
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
	const { t } = useTranslation("narrator");
	const cat = getCategory(toolCalls[0].toolName, toolCalls[0].inputJson);
	const Icon = getCategoryIcon(cat, toolCalls[0].toolName);
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

	const earliestGroupStart = toolCalls.reduce<number | null>((earliest, toolCall) => {
		const startedAt = getEarliestToolStartMs(toolCall);
		if (startedAt == null) return earliest;
		return earliest == null ? startedAt : Math.min(earliest, startedAt);
	}, null);
	const earliestInProgressStart = toolCalls.reduce<number | null>((earliest, toolCall) => {
		if (
			toolCall.status !== "running" &&
			toolCall.status !== "pending" &&
			toolCall.status !== "initializing"
		) {
			return earliest;
		}
		const startedAt = getEarliestToolStartMs(toolCall);
		if (startedAt == null) return earliest;
		return earliest == null ? startedAt : Math.min(earliest, startedAt);
	}, null);
	const groupStartedAtLabel = useMemo(() => {
		if (earliestGroupStart == null) return null;
		const formatted = formatFullLocaleDateTime(earliestGroupStart);
		return formatted ? t("toolStartedAt", { time: formatted }) : null;
	}, [earliestGroupStart, t]);
	const durationNode = anyInProgress ? (
		earliestInProgressStart != null ? (
			<ElapsedTimer startedAt={earliestInProgressStart} />
		) : null
	) : totalMs > 0 ? (
		<Text size="xs" c="dimmed" ff="monospace">
			{formatDurationText(totalMs, { style: "precise" })}
		</Text>
	) : null;

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
					{durationNode &&
						(groupStartedAtLabel ? (
							<Tooltip label={groupStartedAtLabel} position="top" withArrow>
								{durationNode}
							</Tooltip>
						) : (
							durationNode
						))}
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

// CSS keyframes — inject once.
//
// ⚠️ The card SHIMMER rules used to live here too (`tool-card-shimmer` /
// `tool-running-shimmer` / `tool-done-shimmer`). They now live in
// `frontend/styles/card-shimmer.css` (loaded by main.tsx) as five states resolved
// through CARD_SHIMMER_CLASS, because the vlist card path needs the same rules and
// cannot import this module — two private copies is exactly how both paths ended up
// missing the purple and red states. Only `spin` remains: it is a plain rotation
// used by this path's status glyphs, not part of the shimmer family.
if (typeof document !== "undefined") {
	const id = "tool-call-spin";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `@keyframes spin { to { transform: rotate(360deg) } }`;
		document.head.appendChild(style);
	}
}
