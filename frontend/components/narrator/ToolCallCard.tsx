import {
	Badge,
	Box,
	Button,
	Code,
	Divider,
	Group,
	List,
	Paper,
	Stack,
	Text,
	Textarea,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCode,
	IconFile,
	IconListCheck,
	IconLoader2,
	IconMap,
	IconPlayerPlay,
	IconRobot,
	IconSearch,
	IconTerminal2,
	IconWorldSearch,
	IconX,
} from "@tabler/icons-react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToolCallDetail } from "../../hooks/useNarrator";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { ContentViewer } from "./ContentViewer";
import { DiffView } from "./DiffView";
import { LazyCollapse } from "./LazyCollapse";

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
	) => void;
	/** Callback when user submits answers to AskUserQuestion */
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	/** Callback when user skips/denies AskUserQuestion */
	onQuestionDeny?: (requestId: string) => void;
	/** Force expand this card from outside (e.g. when navigating to it) */
	forceExpand?: boolean;
	/** Override expand state for edit tools (true=expand all, false=collapse all, undefined=default) */
	editExpandOverride?: boolean | null;
}

// --- Constants ---

export const STATUS_COLORS: Record<string, string> = {
	initializing: "gray",
	pending: "yellow",
	running: "blue",
	success: "green",
	fail: "red",
};

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const BASH_TOOLS = new Set(["Bash", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch"]);
const TODO_TOOLS = new Set(["TodoWrite"]);
const TASK_OUTPUT_TOOLS = new Set(["TaskOutput", "TaskStop"]);
const ASK_TOOLS = new Set(["AskUserQuestion"]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);

type ToolCategory =
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

function getCategory(name: string): ToolCategory {
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

function getCategoryIcon(cat: ToolCategory) {
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

function getCategoryColor(cat: ToolCategory) {
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

// --- Helper: extract a human-readable summary for the header ---

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function getFilePath(input: any): string {
	return input?.file_path ?? input?.filePath ?? input?.path ?? "";
}

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function getSummary(toolName: string, input: any): string {
	const cat = getCategory(toolName);
	switch (cat) {
		case "file": {
			const fp = getFilePath(input);
			if (!fp) return toolName;
			const base = basename(fp);
			if (toolName === "Edit" || toolName === "MultiEdit") return base;
			if (toolName === "Write") return base;
			return base;
		}
		case "bash": {
			const cmd = input?.command ?? "";
			if (!cmd) return toolName;
			return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
		}
		case "search": {
			const pat = input?.pattern ?? input?.glob ?? "";
			if (!pat) return toolName;
			return pat.length > 60 ? `${pat.slice(0, 57)}...` : pat;
		}
		case "webSearch": {
			const q = input?.query ?? "";
			if (!q) return "Web Search";
			return q.length > 60 ? `${q.slice(0, 57)}...` : q;
		}
		case "todo":
			return "Update todos";
		case "taskOutput": {
			const taskId = input?.task_id ?? "";
			if (toolName === "TaskStop") return taskId ? `Stop ${taskId}` : "Stop task";
			return taskId ? `Check ${taskId}` : "Check task output";
		}
		case "ask": {
			const questions = input?.questions;
			const answers = input?.answers as Record<string, string> | undefined;
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

function ElapsedTimer({ startedAt }: { startedAt: number }) {
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
	onToggle: () => void;
}) {
	const cat = getCategory(toolCall.toolName);
	const Icon = getCategoryIcon(cat);
	const color = getCategoryColor(cat);
	const summary = useMemo(
		() => getSummary(toolCall.toolName, toolCall.inputJson),
		[toolCall.toolName, toolCall.inputJson],
	);
	const statusColor = STATUS_COLORS[toolCall.status] ?? "gray";

	return (
		<UnstyledButton onClick={onToggle} w="100%">
			<Group gap={6} wrap="nowrap">
				<ThemeIcon size={18} variant="light" color={color} radius="sm">
					<Icon size={12} />
				</ThemeIcon>
				<Text size="xs" fw={600} c="dimmed" style={{ flexShrink: 0 }}>
					{toolCall.toolName}
				</Text>
				<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }} title={summary}>
					{summary}
				</Text>
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					<Box c={statusColor}>
						<StatusIcon status={toolCall.status} />
					</Box>
					{toolCall.startedAt != null &&
					(toolCall.status === "running" ||
						toolCall.status === "pending" ||
						toolCall.status === "initializing") ? (
						<ElapsedTimer startedAt={toolCall.startedAt} />
					) : (
						toolCall.durationMs != null && (
							<Text size="xs" c="dimmed">
								{(toolCall.durationMs / 1000).toFixed(1)}s
							</Text>
						)
					)}
					{opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
				</Group>
			</Group>
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

function FileDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const fp = getFilePath(toolCall.inputJson);
	const isEdit = toolCall.toolName === "Edit" || toolCall.toolName === "MultiEdit";
	const isWrite = toolCall.toolName === "Write";

	const outputText =
		typeof toolCall.outputJson === "string"
			? toolCall.outputJson
			: toolCall.outputJson
				? JSON.stringify(toolCall.outputJson, null, 2)
				: "";

	// For Write tool, display the written content from input instead of the result prompt
	const writeContent = isWrite ? (toolCall.inputJson?.content ?? "") : "";

	return (
		<Box mt="xs">
			{fp && (
				<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={fp}>
					{fp}
				</Text>
			)}
			{isEdit && toolCall.inputJson?.old_string != null && (
				<ContentViewer
					content={`--- old\n${toolCall.inputJson.old_string}\n+++ new\n${toolCall.inputJson.new_string ?? ""}`}
					title={fp ? basename(fp) : "Diff"}
					contentType="diff"
					diff={{
						oldStr: toolCall.inputJson.old_string,
						newStr: toolCall.inputJson.new_string ?? "",
					}}
					renderContent={(wordWrap) => (
						<DiffView
							oldStr={toolCall.inputJson.old_string}
							newStr={toolCall.inputJson.new_string ?? ""}
							maxHeight={200}
							wordWrap={wordWrap}
						/>
					)}
				/>
			)}
			{isWrite && writeContent && (
				<ContentViewer
					content={writeContent}
					style={codeStyle}
					title={fp ? basename(fp) : "Write"}
				/>
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
					/>
				</>
			)}
			{isEdit && !toolCall.inputJson?.old_string && (
				<ContentViewer
					content={JSON.stringify(toolCall.inputJson, null, 2)}
					style={codeStyle}
					title={fp ? basename(fp) : "Edit"}
				/>
			)}
		</Box>
	);
}

function BashDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const cmd = toolCall.inputJson?.command ?? "";
	const outputText =
		typeof toolCall.outputJson === "string"
			? toolCall.outputJson
			: toolCall.outputJson
				? JSON.stringify(toolCall.outputJson, null, 2)
				: "";

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
						title={cmd ? `$ ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}` : "Bash"}
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
	const pattern = toolCall.inputJson?.pattern ?? toolCall.inputJson?.glob ?? "";
	const outputText =
		typeof toolCall.outputJson === "string"
			? toolCall.outputJson
			: toolCall.outputJson
				? JSON.stringify(toolCall.outputJson, null, 2)
				: "";

	return (
		<Box mt="xs">
			{pattern && <Code style={{ fontSize: 11 }}>/{pattern}/</Code>}
			{toolCall.inputJson?.path && (
				<Text size="xs" c="dimmed" ff="monospace" ml={4} span>
					in {toolCall.inputJson.path}
				</Text>
			)}
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt={4} mb={2}>
						{t("output")}
					</Text>
					<ContentViewer
						content={outputText}
						style={codeStyle}
						title={pattern ? `/${pattern}/` : "Search"}
					/>
				</>
			)}
		</Box>
	);
}

function WebSearchDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const query = toolCall.inputJson?.query ?? "";
	const raw =
		typeof toolCall.outputJson === "string"
			? toolCall.outputJson
			: toolCall.outputJson
				? JSON.stringify(toolCall.outputJson, null, 2)
				: "";

	// Try to parse structured search results from the output
	const results = useMemo(() => {
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed?.results)) return parsed.results;
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// not JSON — fall through
		}
		return null;
	}, [raw]);

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
	const inputText = JSON.stringify(toolCall.inputJson, null, 2);
	const outputText =
		typeof toolCall.outputJson === "string"
			? toolCall.outputJson
			: toolCall.outputJson
				? JSON.stringify(toolCall.outputJson, null, 2)
				: "";

	return (
		<Box mt="xs">
			<Text size="xs" fw={500} mb={2}>
				{t("input")}
			</Text>
			<ContentViewer content={inputText} style={codeStyle} title={`${toolCall.toolName} Input`} />
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
	const todos: { content?: string; status?: string }[] =
		toolCall.inputJson?.todos ?? toolCall.outputJson?.todos ?? [];

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
	const taskId = toolCall.inputJson?.task_id ?? "";
	const block = toolCall.inputJson?.block;
	const timeout = toolCall.inputJson?.timeout;

	// Parse the XML-style output
	const parsed = useMemo(() => {
		const out = toolCall.outputJson;
		if (!out) return null;
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
		</Box>
	);
}

function PlanDetail({ toolCall }: { toolCall: ToolCallData }) {
	// Plan content from inputJson.plan is shown by InlinePermission during approval.
	// Here we only render after completion, using outputJson or falling back to inputJson.plan.
	const planText =
		toolCall.status === "success" || toolCall.status === "fail"
			? typeof toolCall.outputJson === "string"
				? toolCall.outputJson
				: toolCall.outputJson?._truncated
					? (toolCall.outputJson.preview as string)
					: typeof toolCall.inputJson?.plan === "string"
						? toolCall.inputJson.plan
						: ""
			: "";

	if (!planText) {
		return null;
	}

	return (
		<Box
			mt="xs"
			style={{ flex: 1, minHeight: 0, maxHeight: "calc(100vh - 200px)", overflow: "auto" }}
		>
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
	const questions = toolCall.inputJson?.questions ?? [];
	const answers: Record<string, string> = toolCall.inputJson?.answers ?? {};

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

function InlinePermission({
	permission,
	onDecision,
	onQuestionSubmit,
	onQuestionDeny,
}: {
	permission: PendingPermission;
	onDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
	) => void;
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onQuestionDeny?: (requestId: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const [feedback, setFeedback] = useState("");

	// AskUserQuestion: render the full question form inline
	if (permission.toolName === "AskUserQuestion" && permission.inputJson?.questions) {
		return (
			<Box mt="xs">
				<AskUserQuestionBanner
					requestId={permission.id}
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

	// Regular permission: feedback textarea + Allow/Deny buttons
	return (
		<Box
			mt="xs"
			style={planText ? { display: "flex", flexDirection: "column", flex: 1 } : undefined}
		>
			{planText && (
				<Box mb="xs" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
					<ContentViewer content={planText} markdown contentType="markdown" title="Plan" />
				</Box>
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
				<Button
					size="sm"
					color="green"
					onClick={() => onDecision?.(permission.id, "allow", feedback || undefined)}
				>
					{tc("allow")}
				</Button>
				{permission.toolName === "ExitPlanMode" && (
					<Button
						size="sm"
						color="teal"
						variant="light"
						onClick={() => onDecision?.(permission.id, "allow", feedback || undefined, true)}
					>
						{t("acceptAndResetContext")}
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
}: ToolCallCardProps) {
	const cat = getCategory(toolCall.toolName);
	const isEdit = isEditTool(toolCall.toolName);
	// Auto-expand: permission pending, todo tools, or edit tools.
	// Failed Edit (not Write) defaults to collapsed (usually just a "read first" error).
	const isFailed = toolCall.status === "fail";
	const isFailedEdit = isFailed && toolCall.toolName === "Edit";
	const defaultOpen =
		!!pendingPermission ||
		toolCall.status === "pending" ||
		cat === "todo" ||
		cat === "plan" ||
		(isEdit && !isFailedEdit) ||
		(isFailed && !isEdit);
	const [opened, setOpened] = useState(defaultOpen);

	// Auto-expand when a permission request arrives or tool call enters pending state
	useEffect(() => {
		if (pendingPermission || toolCall.status === "pending") setOpened(true);
	}, [pendingPermission, toolCall.status]);

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
			onDecision={onPermissionDecision}
			onQuestionSubmit={onQuestionSubmit}
			onQuestionDeny={onQuestionDeny}
		/>
	) : null;

	// Inside a run: no Paper wrapper, just content + divider
	if (inRun) {
		return (
			<Box>
				<Box p="xs">
					<ToolHeader toolCall={toolCall} opened={opened} onToggle={() => setOpened((o) => !o)} />
					<LazyCollapse in={opened}>
						<LazyDetailRenderer toolCall={toolCall} narratorId={narratorId} opened={opened} />
						{permissionUI}
					</LazyCollapse>
				</Box>
				{!isLast && <Divider />}
			</Box>
		);
	}

	return (
		<Paper withBorder radius="sm" p="xs" style={borderColor ? { borderColor } : undefined}>
			<ToolHeader toolCall={toolCall} opened={opened} onToggle={() => setOpened((o) => !o)} />
			<LazyCollapse in={opened}>
				<LazyDetailRenderer toolCall={toolCall} narratorId={narratorId} opened={opened} />
				{permissionUI}
			</LazyCollapse>
		</Paper>
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
		<Paper withBorder radius="sm" p="xs">
			<UnstyledButton onClick={() => setExpanded((o) => !o)} w="100%">
				<Group gap={6} wrap="nowrap">
					<ThemeIcon size={18} variant="light" color={color} radius="sm">
						<Icon size={12} />
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
							<Text size="xs" c="dimmed">
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
