import {
	Badge,
	Box,
	Button,
	Code,
	Divider,
	Group,
	List,
	Menu,
	Paper,
	Stack,
	Text,
	Textarea,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import {
	IconArrowsMinimize,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCode,
	IconFile,
	IconGitFork,
	IconListCheck,
	IconLoader2,
	IconMap,
	IconPlayerPlay,
	IconPlayerStop,
	IconRobot,
	IconSearch,
	IconTerminal2,
	IconTrash,
	IconWorldSearch,
	IconX,
} from "@tabler/icons-react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInterruptNarrator, useToolCallDetail } from "../../hooks/useNarrator";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { getShikiLang } from "../../lib/shiki-lang";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { ContentViewer } from "./ContentViewer";
import { DiffView } from "./DiffView";
import { LazyCollapse } from "./LazyCollapse";
import { useMessageContextMenu } from "./MessageContextMenuCtx";
import { useNearestScrollContainerHeight } from "./useNearestScrollContainerHeight";

/**
 * Context carrying the toolUseId of the narrator's latest TodoWrite call.
 * TodoDetail uses this to decide whether in_progress items should animate.
 */
export const LatestTodosToolUseIdCtx = createContext<string | null>(null);

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
	permissionDecisionReason?: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	permissionSuggestions?: any[] | null;
	/** Timestamp (Date.now()) when the tool started running — used for live elapsed timer */
	startedAt?: number;
	/** Optional metadata from the tool (e.g. line numbers for Edit) */
	_metadata?: Record<string, unknown>;
	/** Set by watchdog when process has been running ≥60s — shows terminate button */
	_longRunning?: boolean;
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

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const BASH_TOOLS = new Set(["Bash", "Shell", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch"]);
const TODO_TOOLS = new Set(["TodoWrite"]);
const TASK_OUTPUT_TOOLS = new Set(["TaskOutput", "TaskStop"]);
const ASK_TOOLS = new Set(["AskUserQuestion"]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);

export type ToolCategory =
	| "file"
	| "bash"
	| "search"
	| "webSearch"
	| "todo"
	| "taskOutput"
	| "ask"
	| "plan"
	| "generic";

export function isEditTool(name: string): boolean {
	return EDIT_TOOLS.has(name);
}

export function getCategory(name: string): ToolCategory {
	if (FILE_TOOLS.has(name)) return "file";
	if (BASH_TOOLS.has(name)) return "bash";
	if (SEARCH_TOOLS.has(name)) return "search";
	if (WEB_SEARCH_TOOLS.has(name)) return "webSearch";
	if (TODO_TOOLS.has(name)) return "todo";
	if (TASK_OUTPUT_TOOLS.has(name)) return "taskOutput";
	if (ASK_TOOLS.has(name)) return "ask";
	if (PLAN_TOOLS.has(name)) return "plan";
	return "generic";
}

export function getCategoryIcon(cat: ToolCategory) {
	switch (cat) {
		case "file":
			return IconFile;
		case "bash":
			return IconTerminal2;
		case "search":
			return IconSearch;
		case "webSearch":
			return IconWorldSearch;
		case "todo":
			return IconListCheck;
		case "taskOutput":
			return IconRobot;
		case "ask":
			return IconPlayerPlay;
		case "plan":
			return IconMap;
		default:
			return IconCode;
	}
}

export function getCategoryColor(cat: ToolCategory) {
	switch (cat) {
		case "file":
			return "violet";
		case "bash":
			return "orange";
		case "search":
			return "cyan";
		case "webSearch":
			return "teal";
		case "todo":
			return "teal";
		case "taskOutput":
			return "indigo";
		case "ask":
			return "blue";
		case "plan":
			return "grape";
		default:
			return "gray";
	}
}

// --- Truncation helpers ---

/** Check whether a value is a truncated placeholder produced by the backend */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function isTruncated(val: any): val is { _truncated: true; preview: string; fullLength: number } {
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
	return JSON.stringify(val, null, 2);
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Try to extract a top-level string property from a possibly-truncated JSON object.
 * For truncated objects, attempts a regex match on the preview string.
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
	// Try to extract from the JSON preview string via regex
	for (const k of keys) {
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
		const m = val.preview.match(re);
		if (m) {
			try {
				return JSON.parse(`"${m[1]}"`);
			} catch {
				return m[1];
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
	for (const k of keys) {
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*(\\d+)`);
		const m = val.preview?.match(re);
		if (m) return Number(m[1]);
	}
	return undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function extractBoolField(val: any, ...keys: string[]): boolean {
	if (!val) return false;
	if (!isTruncated(val)) {
		for (const k of keys) {
			if (val[k] === true) return true;
		}
		return false;
	}
	for (const k of keys) {
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*true`);
		if (val.preview?.match(re)) return true;
	}
	return false;
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
function getSummary(toolName: string, input: any): string {
	// Synthetic streaming tool call — show file path + content chars
	if (input?._streamingChars != null) {
		const chars = input._streamingChars as number;
		const filePath = input._streamingFilePath as string | undefined;
		const contentChars = input._streamingContentChars as number | undefined;
		if (filePath) {
			const base = basename(filePath);
			const displayChars = contentChars ?? chars;
			return displayChars > 0 ? `${base} (${displayChars} chars)` : base;
		}
		return chars > 0 ? `${chars} chars` : "";
	}
	const cat = getCategory(toolName);
	switch (cat) {
		case "file": {
			const fp = getFilePath(input);
			if (!fp) return toolName;
			const base = basename(fp);
			if (toolName === "Read") {
				const offset = extractNumericField(input, "offset");
				const limit = extractNumericField(input, "limit");
				const forceFull = extractBoolField(input, "force_full", "forceFull");
				if (forceFull) return `${base} (full)`;
				if (offset != null && limit != null) return `${base} (${offset}~${offset + limit - 1})`;
				if (offset != null) return `${base} (${offset}~)`;
				if (limit != null) return `${base} (1~${limit})`;
				return base;
			}
			return base;
		}
		case "bash": {
			const cmd = extractField(input, "command");
			if (!cmd) return toolName;
			return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
		}
		case "search": {
			const pat = extractField(input, "pattern", "glob");
			if (!pat) return toolName;
			return pat.length > 60 ? `${pat.slice(0, 57)}...` : pat;
		}
		case "webSearch": {
			const q = extractField(input, "query");
			if (!q) return "Web Search";
			return q.length > 60 ? `${q.slice(0, 57)}...` : q;
		}
		case "todo":
			return "Update todos";
		case "taskOutput": {
			const taskId = extractField(input, "task_id");
			if (toolName === "TaskStop") return taskId ? `Stop ${taskId}` : "Stop task";
			return taskId ? `Check ${taskId}` : "Check task output";
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
			return "Question";
		}
		case "plan":
			return toolName === "ExitPlanMode" ? "Plan ready" : "Enter plan mode";
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
		<Text size="xs" c="dimmed" ff="monospace">
			{formatElapsed(elapsed)}
		</Text>
	);
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

function ToolHeader({
	toolCall,
	opened,
	onToggle,
}: {
	toolCall: ToolCallData;
	opened: boolean;
	onToggle?: () => void;
}) {
	const cat = getCategory(toolCall.toolName);
	const Icon = getCategoryIcon(cat);
	const color = getCategoryColor(cat);
	const summary = useMemo(
		() => getSummary(toolCall.toolName, toolCall.inputJson),
		[toolCall.toolName, toolCall.inputJson],
	);
	const statusColor = STATUS_COLORS[toolCall.status] ?? "gray";

	const content = (
		<Group gap={5} wrap="nowrap" align="center" style={{ flex: 1, minWidth: 0 }}>
			<ThemeIcon size={16} variant="light" color={color} radius="sm">
				<Icon size={10} />
			</ThemeIcon>
			<Text size="xs" fw={600} c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
				{toolCall.toolName}
			</Text>
			<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }} title={summary}>
				{summary}
			</Text>
			<Group gap={4} wrap="nowrap" align="center" style={{ flexShrink: 0 }}>
				<Box c={statusColor} style={{ display: "flex", alignItems: "center" }}>
					<StatusIcon status={toolCall.status} />
				</Box>
				{toolCall.startedAt != null &&
				(toolCall.status === "running" ||
					toolCall.status === "pending" ||
					toolCall.status === "initializing") ? (
					<ElapsedTimer startedAt={toolCall.startedAt} />
				) : (
					toolCall.durationMs != null && (
						<Text size="xs" c="dimmed" ff="monospace">
							{(toolCall.durationMs / 1000).toFixed(1)}s
						</Text>
					)
				)}
				<Box style={{ display: "flex", alignItems: "center" }}>
					{opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
				</Box>
			</Group>
		</Group>
	);

	return (
		<UnstyledButton
			onClick={onToggle}
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

/** Small indicator shown when tool call content is truncated (loading full data) */
function TruncatedBadge({ fullLength }: { fullLength?: number }) {
	const { t } = useTranslation("narrator");
	return (
		<Text size="xs" c="dimmed" fs="italic" mt={2}>
			{t("truncatedPreview", {
				size: fullLength ? `${Math.round(fullLength / 1024)}KB` : "",
			})}
		</Text>
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
 * Terminate button for long-running bash/shell commands.
 * Rendered outside LazyCollapse so it's always visible without expanding the card.
 * Uses a local timer to detect ≥60s elapsed — no dependency on WS push.
 */
function BashTerminateButton({
	toolCall,
	narratorId,
}: {
	toolCall: ToolCallData;
	narratorId?: string;
}) {
	const { t: tNarrator } = useTranslation("narrator");
	const interruptMutation = useInterruptNarrator();

	const isBash = BASH_TOOLS.has(toolCall.toolName);
	const isRunning = toolCall.status === "running" && !!narratorId;

	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		if (!isBash || !isRunning || toolCall.startedAt == null) {
			if (isBash && toolCall.status === "running") {
				console.log("[BashTerminate] skipped:", {
					isBash,
					isRunning,
					status: toolCall.status,
					startedAt: toolCall.startedAt,
					narratorId,
					toolName: toolCall.toolName,
				});
			}
			setElapsed(0);
			return;
		}
		const update = () => {
			const e = Date.now() - (toolCall.startedAt ?? Date.now());
			console.log("[BashTerminate] tick:", { elapsed: e, startedAt: toolCall.startedAt });
			setElapsed(e);
		};
		update();
		const timer = setInterval(update, 5_000);
		return () => clearInterval(timer);
	}, [isBash, isRunning, toolCall.startedAt]);

	if (!isBash || !isRunning || elapsed < 60_000) return null;

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
}

function BashDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const cmd = extractField(toolCall.inputJson, "command");
	const outputText = resolveDisplayText(toolCall.outputJson);
	const outputIsTruncated = isTruncated(toolCall.outputJson);

	return (
		<Box mt="xs">
			{cmd && (
				<ContentViewer
					content={`$ ${cmd}`}
					style={{ ...termStyle, maxHeight: 60 }}
					title="Command"
				/>
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
	const latestToolUseId = useContext(LatestTodosToolUseIdCtx);
	const isLatest = !!toolCall.toolUseId && toolCall.toolUseId === latestToolUseId;
	const todos: { content?: string; status?: string }[] = isTruncated(toolCall.inputJson)
		? isTruncated(toolCall.outputJson)
			? []
			: (toolCall.outputJson?.todos ?? [])
		: (toolCall.inputJson?.todos ?? toolCall.outputJson?.todos ?? []);

	if (!todos.length) {
		return <GenericDetail toolCall={toolCall} />;
	}

	return (
		<Box mt="xs">
			<List spacing={4} size="xs" center>
				{todos.map((todo, i) => {
					const entry = TODO_STATUS_ICON[todo.status ?? "pending"] ?? TODO_STATUS_ICON.pending;
					const spinning = isLatest && todo.status === "in_progress";
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
	// User feedback is stored in errorMessage when the plan is denied
	const denyFeedback = isDenied ? toolCall.errorMessage : undefined;
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
				<UnstyledButton onClick={() => setPlanExpanded((o) => !o)} w="100%">
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
		case "todo":
			return <TodoDetail toolCall={toolCall} />;
		case "taskOutput":
			return <TaskOutputDetail toolCall={toolCall} />;
		case "ask":
			return <AskDetail toolCall={toolCall} />;
		case "plan":
			return <PlanDetail toolCall={toolCall} />;
		default:
			return <GenericDetail toolCall={toolCall} />;
	}
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
	const [feedback, setFeedback] = useState("");
	const [editing, setEditing] = useState(false);
	const [editedPlan, setEditedPlan] = useState<string | null>(null);

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
			<Textarea
				size="xs"
				placeholder={t("feedbackPlaceholder")}
				value={feedback}
				onChange={(e) => setFeedback(e.currentTarget.value)}
				autosize
				minRows={1}
				maxRows={3}
				mb="xs"
			/>
			<Group gap="sm">
				<Button size="sm" color="green" onClick={() => handleAllow()}>
					{tc("allow")}
				</Button>
				{isExitPlan && (
					<Button size="sm" color="teal" variant="light" onClick={() => handleAllow(true)}>
						{t("acceptAndResetContext")}
					</Button>
				)}
				{isExitPlan && planText && (
					<Button
						size="sm"
						color="indigo"
						variant="light"
						onClick={() => {
							if (editing) {
								setEditing(false);
							} else {
								handleStartEdit();
							}
						}}
					>
						{editing ? t("planEditDone") : t("planEdit")}
					</Button>
				)}
				{planEdited && (
					<Button
						size="sm"
						color="gray"
						variant="subtle"
						onClick={() => {
							setEditedPlan(null);
							setEditing(false);
						}}
					>
						{t("planEditReset")}
					</Button>
				)}
				<Button
					size="sm"
					color="red"
					variant="light"
					onClick={() => onDecision?.(permission.id, "deny", feedback || undefined)}
				>
					{tc("deny")}
				</Button>
			</Group>
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
	const { data: fullTc } = useToolCallDetail(
		narratorId ?? "",
		toolCall.toolUseId ?? "",
		needsFetch,
	);

	const resolvedToolCall = useMemo(() => {
		if (!fullTc) return toolCall;
		return {
			...toolCall,
			inputJson: fullTc.inputJson ?? toolCall.inputJson,
			outputJson: fullTc.outputJson ?? toolCall.outputJson,
		};
	}, [toolCall, fullTc]);

	return <DetailRenderer toolCall={resolvedToolCall} />;
}

// --- Swipe / context-menu constants ---

const SWIPE_REVEAL_WIDTH = 180;

// --- Main single card ---

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
	// Auto-expand: permission pending, todo tools, or edit tools.
	// Failed Edit (not Write) defaults to collapsed (usually just a "read first" error).
	// Denied ExitPlanMode defaults to collapsed — plan content is folded inside PlanDetail.
	const isFailed = toolCall.status === "fail";
	const isFailedEdit = isFailed && toolCall.toolName === "Edit";
	const isDeniedPlan = isFailed && toolCall.toolName === "ExitPlanMode";
	const defaultOpen =
		!isStreaming &&
		(!!pendingPermission ||
			toolCall.status === "pending" ||
			cat === "todo" ||
			(cat === "plan" && !isDeniedPlan) ||
			(isEdit && !isFailedEdit) ||
			(isFailed && !isEdit && !isDeniedPlan));
	const [opened, setOpened] = useState(defaultOpen);

	// Clamp plan card height to 85% of the nearest scroll container.
	const cardRef = useRef<HTMLDivElement>(null);
	const vpHeight = useNearestScrollContainerHeight(cardRef, 0.85, isPlan);

	// Auto-expand when a permission request arrives or tool call enters pending state
	useEffect(() => {
		if (pendingPermission || toolCall.status === "pending") setOpened(true);
	}, [pendingPermission, toolCall.status]);

	// Auto-expand todo/plan cards once streaming finishes
	useEffect(() => {
		if (!isStreaming && (cat === "todo" || cat === "plan")) setOpened(true);
	}, [isStreaming, cat]);

	// Force expand from outside (e.g. navigating to this card)
	useEffect(() => {
		if (forceExpand) setOpened(true);
	}, [forceExpand]);

	// Respond to global edit expand/collapse override
	useEffect(() => {
		if (isEdit && editExpandOverride != null) setOpened(editExpandOverride);
	}, [isEdit, editExpandOverride]);

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

	// --- Message-level context menu actions (branch / fork / compact / delete) ---
	const msgCtx = useMessageContextMenu();
	const { t: tNarrator } = useTranslation("narrator");
	const hasActions = !!(
		msgCtx.onForkFromMessage ||
		msgCtx.onCompactBeforeMessage ||
		(msgCtx.onDeleteBlock && blockIndex != null)
	);

	// --- Swipe & context-menu state ---
	const swipe = useSwipeMenu({ enabled: hasActions });

	const menuItemsNode = hasActions ? (
		<>
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
		</>
	) : null;

	// --- Render helpers ---

	const planStyle =
		isPlan && vpHeight ? { maxHeight: vpHeight, overflow: "hidden auto" as const } : undefined;

	const cardContent = (
		<>
			<ToolHeader toolCall={toolCall} opened={opened} onToggle={handleToggle} />
			{!isStreaming && (
				<>
					<BashTerminateButton toolCall={toolCall} narratorId={narratorId} />
					<LazyCollapse in={opened}>
						<Box style={planStyle}>
							<LazyDetailRenderer toolCall={toolCall} narratorId={narratorId} opened={opened} />
						</Box>
						{permissionUI}
					</LazyCollapse>
				</>
			)}
		</>
	);

	const swipeMenu =
		hasActions &&
		(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
		(() => {
			const menuEl = swipe.swipeMenuRef.current;
			const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight);
			return (
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
				</Box>
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

	// Inside a run: no Paper wrapper, just content + divider
	if (inRun) {
		return (
			<>
				<Box
					ref={swipe.swipeBoxRef}
					onContextMenu={swipe.handleContextMenu}
					style={swipe.swipeStyle}
				>
					<Box ref={isPlan ? cardRef : undefined}>
						<Box p="xs">{cardContent}</Box>
						{!isLast && <Divider color="var(--mantine-color-default-border)" size={1} />}
					</Box>
				</Box>
				{swipeMenu}
				{ctxMenu}
			</>
		);
	}

	return (
		<>
			<Box ref={swipe.swipeBoxRef} onContextMenu={swipe.handleContextMenu} style={swipe.swipeStyle}>
				<Paper
					ref={isPlan ? cardRef : undefined}
					withBorder={!inRun}
					radius={inRun ? 0 : "sm"}
					p="xs"
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
		</>
	);
});

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
			<UnstyledButton onClick={() => setExpanded((o) => !o)} w="100%">
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

// CSS keyframe for spinner — inject once
if (typeof document !== "undefined") {
	const id = "tool-call-spin";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = "@keyframes spin { to { transform: rotate(360deg) } }";
		document.head.appendChild(style);
	}
}
