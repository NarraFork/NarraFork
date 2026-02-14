import {
	Badge,
	Box,
	Code,
	Collapse,
	Divider,
	Group,
	Paper,
	Text,
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
	IconSearch,
	IconTerminal2,
	IconX,
} from "@tabler/icons-react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

// --- Types ---

export interface ToolCallData {
	toolName: string;
	inputJson: any;
	outputJson?: any;
	status: string;
	durationMs?: number;
	errorMessage?: string;
}

interface ToolCallCardProps {
	toolCall: ToolCallData;
	/** When true, card is inside a tool_run wrapper — no own border/radius */
	inRun?: boolean;
	/** When true, this is the last item in a run — no bottom divider */
	isLast?: boolean;
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
const BASH_TOOLS = new Set(["Bash", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
const COMPACT_TOOLS = new Set(["TodoWrite", "TodoRead"]);

type ToolCategory = "file" | "bash" | "search" | "compact" | "generic";

function getCategory(name: string): ToolCategory {
	if (FILE_TOOLS.has(name)) return "file";
	if (BASH_TOOLS.has(name)) return "bash";
	if (SEARCH_TOOLS.has(name)) return "search";
	if (COMPACT_TOOLS.has(name)) return "compact";
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
		case "compact":
			return IconListCheck;
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
		case "compact":
			return "teal";
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
		case "compact":
			return toolName === "TodoWrite" ? "Update todos" : "Read todos";
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

	return (
		<Box mt="xs">
			{fp && (
				<Text size="xs" c="dimmed" ff="monospace" mb={4} truncate title={fp}>
					{fp}
				</Text>
			)}
			{isEdit && toolCall.inputJson?.old_string != null && (
				<Code block style={codeStyle}>
					{formatDiff(toolCall.inputJson.old_string, toolCall.inputJson.new_string)}
				</Code>
			)}
			{!isEdit && toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mb={2}>
						{t("output")}
					</Text>
					<Code block style={codeStyle}>
						{typeof toolCall.outputJson === "string"
							? toolCall.outputJson
							: JSON.stringify(toolCall.outputJson, null, 2)}
					</Code>
				</>
			)}
			{isEdit && !toolCall.inputJson?.old_string && (
				<Code block style={codeStyle}>
					{JSON.stringify(toolCall.inputJson, null, 2)}
				</Code>
			)}
		</Box>
	);
}

function formatDiff(oldStr: string, newStr: string): string {
	const lines: string[] = [];
	if (oldStr) {
		for (const line of oldStr.split("\n")) {
			lines.push(`- ${line}`);
		}
	}
	if (newStr) {
		for (const line of newStr.split("\n")) {
			lines.push(`+ ${line}`);
		}
	}
	return lines.join("\n");
}

function BashDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	const cmd = toolCall.inputJson?.command ?? "";

	return (
		<Box mt="xs">
			{cmd && (
				<Code block style={{ ...termStyle, maxHeight: 60 }}>
					$ {cmd}
				</Code>
			)}
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt={4} mb={2}>
						{t("output")}
					</Text>
					<Code block style={termStyle}>
						{typeof toolCall.outputJson === "string"
							? toolCall.outputJson
							: JSON.stringify(toolCall.outputJson, null, 2)}
					</Code>
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
					<Code block style={codeStyle}>
						{typeof toolCall.outputJson === "string"
							? toolCall.outputJson
							: JSON.stringify(toolCall.outputJson, null, 2)}
					</Code>
				</>
			)}
		</Box>
	);
}

function GenericDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("common");
	return (
		<Box mt="xs">
			<Text size="xs" fw={500} mb={2}>
				{t("input")}
			</Text>
			<Code block style={codeStyle}>
				{JSON.stringify(toolCall.inputJson, null, 2)}
			</Code>
			{toolCall.outputJson && (
				<>
					<Text size="xs" fw={500} mt="xs" mb={2}>
						{t("output")}
					</Text>
					<Code block style={codeStyle}>
						{typeof toolCall.outputJson === "string"
							? toolCall.outputJson
							: JSON.stringify(toolCall.outputJson, null, 2)}
					</Code>
				</>
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
		case "compact":
			return <GenericDetail toolCall={toolCall} />;
		default:
			return <GenericDetail toolCall={toolCall} />;
	}
}

// --- Main single card ---

export const ToolCallCard = memo(function ToolCallCard({
	toolCall,
	inRun,
	isLast,
}: ToolCallCardProps) {
	const cat = getCategory(toolCall.toolName);
	const isCompact = cat === "compact";
	// Auto-expand: running/failed open, completed/compact closed
	const defaultOpen = toolCall.status === "running" || toolCall.status === "failed";
	const [opened, setOpened] = useState(defaultOpen);

	if (isCompact) {
		return (
			<Group gap={6} ml={4}>
				<ThemeIcon size={16} variant="light" color="teal" radius="sm">
					<IconListCheck size={10} />
				</ThemeIcon>
				<Text size="xs" c="dimmed">
					{getSummary(toolCall.toolName, toolCall.inputJson)}
				</Text>
				<Badge size="xs" variant="dot" color={STATUS_COLORS[toolCall.status] ?? "gray"}>
					{toolCall.status}
				</Badge>
			</Group>
		);
	}

	const borderColor =
		toolCall.status === "failed"
			? "var(--mantine-color-red-7)"
			: toolCall.status === "running"
				? "var(--mantine-color-blue-7)"
				: undefined;

	// Inside a run: no Paper wrapper, just content + divider
	if (inRun) {
		return (
			<Box>
				<Box p="xs">
					<ToolHeader toolCall={toolCall} opened={opened} onToggle={() => setOpened((o) => !o)} />
					<Collapse in={opened}>
						<DetailRenderer toolCall={toolCall} />
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
