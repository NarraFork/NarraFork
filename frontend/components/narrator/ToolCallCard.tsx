import {
	Badge,
	Box,
	Button,
	Code,
	Collapse,
	Divider,
	Group,
	List,
	Paper,
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
	IconPlayerPlay,
	IconRobot,
	IconSearch,
	IconTerminal2,
	IconX,
} from "@tabler/icons-react";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { CodeBlockWithActions } from "./CodeBlockWithActions";
import { DiffView } from "./DiffView";

// --- Types ---

export interface ToolCallData {
	toolName: string;
	toolUseId?: string;
	inputJson: any;
	outputJson?: any;
	status: string;
	durationMs?: number;
	errorMessage?: string;
}

export interface PendingPermission {
	id: string;
	toolName: string;
	toolUseId?: string;
	inputJson: any;
	decisionReason?: string;
	suggestions?: any[];
}

interface ToolCallCardProps {
	toolCall: ToolCallData;
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
	pending: "yellow",
	approved: "teal",
	denied: "red",
	running: "blue",
	completed: "green",
	failed: "red",
};

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const BASH_TOOLS = new Set(["Bash", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
const TODO_TOOLS = new Set(["TodoWrite", "TodoRead"]);
const TASK_OUTPUT_TOOLS = new Set(["TaskOutput", "TaskStop"]);

type ToolCategory = "file" | "bash" | "search" | "todo" | "taskOutput" | "generic";

export function isEditTool(name: string): boolean {
	return EDIT_TOOLS.has(name);
}

function getCategory(name: string): ToolCategory {
	if (FILE_TOOLS.has(name)) return "file";
	if (BASH_TOOLS.has(name)) return "bash";
	if (SEARCH_TOOLS.has(name)) return "search";
	if (TODO_TOOLS.has(name)) return "todo";
	if (TASK_OUTPUT_TOOLS.has(name)) return "taskOutput";
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
		case "todo":
			return IconListCheck;
		case "taskOutput":
			return IconRobot;
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
		case "todo":
			return "teal";
		case "taskOutput":
			return "indigo";
		default:
			return "gray";
	}
}

// --- Helper: extract a human-readable summary for the header ---

function getFilePath(input: any): string {
	return input?.file_path ?? input?.filePath ?? input?.path ?? "";
}

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

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
		case "todo":
			return toolName === "TodoWrite" ? "Update todos" : "Read todos";
		case "taskOutput": {
			const taskId = input?.task_id ?? "";
			if (toolName === "TaskStop") return taskId ? `Stop ${taskId}` : "Stop task";
			return taskId ? `Check ${taskId}` : "Check task output";
		}
		default:
			return toolName;
	}
}

// --- Helper: status indicator icon ---

export function StatusIcon({ status }: { status: string }) {
	if (status === "running" || status === "pending") {
		return <IconLoader2 size={12} style={{ animation: "spin 1s linear infinite" }} />;
	}
	if (status === "completed" || status === "approved") {
		return <IconCheck size={12} />;
	}
	if (status === "failed" || status === "denied") {
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
					{toolCall.durationMs != null && (
						<Text size="xs" c="dimmed">
							{(toolCall.durationMs / 1000).toFixed(1)}s
						</Text>
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

	const outputText =
		typeof toolCall.outputJson === "string"
			? toolCall.outputJson
			: toolCall.outputJson
				? JSON.stringify(toolCall.outputJson, null, 2)
				: "";

	return (
		<Box mt="xs">
			{fp && (
				<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={fp}>
					{fp}
				</Text>
			)}
			{isEdit && toolCall.inputJson?.old_string != null && (
				<CodeBlockWithActions
					content={`--- old\n${toolCall.inputJson.old_string}\n+++ new\n${toolCall.inputJson.new_string ?? ""}`}
					title={fp ? basename(fp) : "Diff"}
					diff={{
						oldStr: toolCall.inputJson.old_string,
						newStr: toolCall.inputJson.new_string ?? "",
					}}
				>
					<DiffView
						oldStr={toolCall.inputJson.old_string}
						newStr={toolCall.inputJson.new_string ?? ""}
					/>
				</CodeBlockWithActions>
			)}
			{!isEdit && toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mb={2}>
						{t("output")}
					</Text>
					<CodeBlockWithActions
						content={outputText}
						style={codeStyle}
						title={fp ? basename(fp) : "Output"}
					/>
				</>
			)}
			{isEdit && !toolCall.inputJson?.old_string && (
				<CodeBlockWithActions
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
				<CodeBlockWithActions
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
					<CodeBlockWithActions
						content={outputText}
						style={termStyle}
						title={cmd ? `$ ${cmd}` : "Bash"}
					/>
				</>
			)}
			{toolCall.errorMessage && (
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
					<CodeBlockWithActions
						content={outputText}
						style={codeStyle}
						title={pattern ? `/${pattern}/` : "Search"}
					/>
				</>
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
			<CodeBlockWithActions
				content={inputText}
				style={codeStyle}
				title={`${toolCall.toolName} Input`}
			/>
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt="xs" mb={2}>
						{t("output")}
					</Text>
					<CodeBlockWithActions
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
	in_progress: { icon: IconLoader2, color: "blue" },
	pending: { icon: IconChevronRight, color: "yellow" },
};

function TodoDetail({ toolCall }: { toolCall: ToolCallData }) {
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
					const StatusIconComp = entry.icon;
					return (
						<List.Item
							// biome-ignore lint/suspicious/noArrayIndexKey: todo items lack unique IDs
							key={i}
							icon={
								<ThemeIcon size={16} variant="light" color={entry.color} radius="xl">
									<StatusIconComp
										size={10}
										style={
											todo.status === "in_progress"
												? { animation: "spin 1s linear infinite" }
												: undefined
										}
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
					? out.map((b: any) => b.text ?? "").join("")
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
				<CodeBlockWithActions
					content={parsed.output}
					style={codeStyle}
					title={`TaskOutput ${taskId}`}
				/>
			)}
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
		case "todo":
			return <TodoDetail toolCall={toolCall} />;
		case "taskOutput":
			return <TaskOutputDetail toolCall={toolCall} />;
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
	onDecision?: (requestId: string, decision: "allow" | "deny", feedbackText?: string) => void;
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

	// Regular permission: feedback textarea + Allow/Deny buttons
	return (
		<Box mt="xs">
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

// --- Main single card ---

export const ToolCallCard = memo(function ToolCallCard({
	toolCall,
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
	// Auto-expand: failed, permission pending, todo tools, or edit tools
	const defaultOpen =
		toolCall.status === "failed" || !!pendingPermission || cat === "todo" || isEdit;
	const [opened, setOpened] = useState(defaultOpen);

	// Auto-expand when a permission request arrives
	useEffect(() => {
		if (pendingPermission) setOpened(true);
	}, [pendingPermission]);

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
		: toolCall.status === "failed"
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
					<Collapse in={opened}>
						<DetailRenderer toolCall={toolCall} />
						{permissionUI}
					</Collapse>
				</Box>
				{!isLast && <Divider />}
			</Box>
		);
	}

	return (
		<Paper withBorder radius="sm" p="xs" style={borderColor ? { borderColor } : undefined}>
			<ToolHeader toolCall={toolCall} opened={opened} onToggle={() => setOpened((o) => !o)} />
			<Collapse in={opened}>
				<DetailRenderer toolCall={toolCall} />
				{permissionUI}
			</Collapse>
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
	const allDone = toolCalls.every((tc) => tc.status === "completed");
	const anyFailed = toolCalls.some((tc) => tc.status === "failed");
	const anyRunning = toolCalls.some((tc) => tc.status === "running");

	const statusColor = anyFailed ? "red" : anyRunning ? "blue" : allDone ? "green" : "yellow";
	const statusLabel = anyFailed
		? "failed"
		: anyRunning
			? "running"
			: allDone
				? "completed"
				: "pending";

	// Collect unique tool names for the label
	const names = [...new Set(toolCalls.map((tc) => tc.toolName))];
	const label = names.length === 1 ? names[0] : names.join(", ");
	const totalMs = toolCalls.reduce((sum, tc) => sum + (tc.durationMs ?? 0), 0);

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
					{totalMs > 0 && (
						<Text size="xs" c="dimmed">
							{(totalMs / 1000).toFixed(1)}s
						</Text>
					)}
					{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
				</Group>
			</UnstyledButton>
			<Collapse in={expanded}>
				<Box mt={4} pl={4} style={{ borderLeft: `2px solid var(--mantine-color-${color}-4)` }}>
					{toolCalls.map((tc, i) => (
						<ToolCallCard key={tc.inputJson?.file_path ?? i} toolCall={tc} />
					))}
				</Box>
			</Collapse>
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
