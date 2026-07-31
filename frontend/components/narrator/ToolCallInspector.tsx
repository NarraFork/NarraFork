import {
	ActionIcon,
	Badge,
	Box,
	CopyButton,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	Timeline,
	Tooltip,
} from "@mantine/core";
import { readLeafText, stringifyForDisplay } from "@shared/pretext-layout/tool-io-projection";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToolCallDetail } from "../../hooks/useNarrator";
import type { SideCarRecord } from "../../lib/api";
import type { ExecutionTargetIdentity } from "../../lib/api/types";
import { formatDurationText, formatFullLocaleDateTime } from "../../lib/format";
import { ContentViewer } from "./ContentViewer";
import { SideCarNotice } from "./SideCarNotice";

const MAX_JSON_PREVIEW_CHARS = 80_000;

interface ToolCallLike {
	id?: string;
	toolName?: string;
	toolUseId?: string;
	status?: string;
	durationMs?: number | null;
	streamStartedAt?: string | number | null;
	permissionStartedAt?: string | number | null;
	executionStartedAt?: string | number | null;
	completedAt?: string | number | null;
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	executionTarget?: ExecutionTargetIdentity | null;
	executionTargets?: ExecutionTargetIdentity[];
	deviceSelectionSource?: "explicit" | "session_default" | "local_default" | null;
	createdAt?: string | number | null;
	errorMessage?: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: tool call JSON is dynamic by design
	inputJson?: any;
	// biome-ignore lint/suspicious/noExplicitAny: tool call JSON is dynamic by design
	outputJson?: any;
	sideCars?: SideCarRecord[];
}

interface ToolCallInspectorProps {
	narratorId: string;
	toolUseId: string | null | undefined;
	opened: boolean;
	onClose: () => void;
	initialToolCall?: ToolCallLike | null;
}

function stringifyJson(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	// Truncated leaves render as their preview text; dumping the wrapper's own
	// `{_truncated,preview,fullLength}` structure into the inspector (and into what
	// the user copies) would be strictly worse than showing the text it stands for.
	return stringifyForDisplay(value);
}

function formatJsonPreview(value: unknown, maxChars: number): { text: string; truncated: boolean } {
	if (value == null) return { text: "", truncated: false };
	if (typeof value === "string") {
		return value.length > maxChars
			? { text: value.slice(0, maxChars), truncated: true }
			: { text: value, truncated: false };
	}

	const parts: string[] = [];
	const seen = new WeakSet<object>();
	let remaining = maxChars;
	let truncated = false;
	const append = (text: string): boolean => {
		if (remaining <= 0) {
			truncated = true;
			return false;
		}
		if (text.length > remaining) {
			parts.push(text.slice(0, remaining));
			remaining = 0;
			truncated = true;
			return false;
		}
		parts.push(text);
		remaining -= text.length;
		return true;
	};
	const writeIndent = (depth: number) => append("  ".repeat(depth));
	const write = (current: unknown, depth: number): boolean => {
		if (current == null || typeof current === "number" || typeof current === "boolean") {
			return append(JSON.stringify(current));
		}
		const leafText = readLeafText(current);
		if (typeof current === "object" && leafText !== undefined) {
			// A truncated leaf is rendered as its text, never as its wrapper object.
			const snippet = leafText.length > remaining ? leafText.slice(0, remaining) : leafText;
			return append(JSON.stringify(`${snippet}…`));
		}
		if (typeof current === "string") {
			const snippet = current.length > remaining ? current.slice(0, remaining) : current;
			return append(JSON.stringify(snippet));
		}
		if (typeof current !== "object") return append(JSON.stringify(String(current)));
		if (seen.has(current)) return append('"[Circular]"');
		seen.add(current);
		if (Array.isArray(current)) {
			if (current.length === 0) return append("[]");
			if (!append("[\n")) return false;
			for (let i = 0; i < current.length; i++) {
				if (!writeIndent(depth + 1)) return false;
				if (!write(current[i], depth + 1)) return false;
				if (!append(i === current.length - 1 ? "\n" : ",\n")) return false;
			}
			return writeIndent(depth) && append("]");
		}
		const record = current as Record<string, unknown>;
		let wroteAny = false;
		let first = true;
		if (!append("{\n")) return false;
		for (const key in record) {
			if (!Object.hasOwn(record, key)) continue;
			if (!first && !append(",\n")) return false;
			first = false;
			wroteAny = true;
			if (!writeIndent(depth + 1)) return false;
			if (!append(`${JSON.stringify(key)}: `)) return false;
			if (!write(record[key], depth + 1)) return false;
		}
		if (!wroteAny) {
			parts.pop();
			return append("{}");
		}
		return append("\n") && writeIndent(depth) && append("}");
	};

	write(value, 0);
	return { text: parts.join(""), truncated };
}

function parseTime(value: string | number | null | undefined): number | null {
	if (value == null) return null;
	const time = typeof value === "number" ? value : new Date(value).getTime();
	return Number.isFinite(time) ? time : null;
}

function statusColor(status?: string): string {
	switch (status) {
		case "success":
		case "completed":
			return "green";
		case "running":
		case "pending":
		case "initializing":
			return "blue";
		case "cancelled":
		case "timeout":
			return "orange";
		case "fail":
		case "failed":
		case "error":
			return "red";
		default:
			return "gray";
	}
}

function CopyIconButton({ value, label }: { value: string; label: string }) {
	return (
		<CopyButton value={value} timeout={1500}>
			{({ copied, copy }) => (
				<Tooltip label={copied ? label : label}>
					<ActionIcon
						variant="subtle"
						color={copied ? "green" : "gray"}
						size="sm"
						onClick={copy}
						disabled={!value}
					>
						{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
					</ActionIcon>
				</Tooltip>
			)}
		</CopyButton>
	);
}

function LazyCopyJsonIconButton({ value, label }: { value: unknown; label: string }) {
	const [copied, setCopied] = useState(false);
	const disabled = value == null;
	return (
		<Tooltip label={copied ? label : label}>
			<ActionIcon
				variant="subtle"
				color={copied ? "green" : "gray"}
				size="sm"
				disabled={disabled}
				onClick={async () => {
					const text = stringifyJson(value);
					if (!text) return;
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
			</ActionIcon>
		</Tooltip>
	);
}

function TimingTimeline({ toolCall }: { toolCall: ToolCallLike }) {
	const { t } = useTranslation("narrator");
	const streamStarted = parseTime(toolCall.streamStartedAt) ?? parseTime(toolCall.createdAt);
	const permissionStarted = parseTime(toolCall.permissionStartedAt);
	const executionStarted = parseTime(toolCall.executionStartedAt);
	const completed = parseTime(toolCall.completedAt);
	const totalEnd =
		completed ??
		(executionStarted != null && toolCall.durationMs != null
			? executionStarted + toolCall.durationMs
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
		{ key: "completed", label: t("toolCallInspector.timing.completed"), time: totalEnd },
	].filter((step) => step.time != null) as Array<{ key: string; label: string; time: number }>;

	if (steps.length === 0) return null;

	return (
		<Stack gap={6}>
			<Text size="sm" fw={600}>
				{t("toolCallInspector.timing.title")}
			</Text>
			<Timeline active={steps.length - 1} bulletSize={12} lineWidth={1} color="indigo">
				{steps.map((step, index) => {
					const previous = steps[index - 1]?.time;
					const delta = previous == null ? null : Math.max(0, step.time - previous);
					return (
						<Timeline.Item key={step.key} title={step.label}>
							<Group gap="xs" wrap="wrap">
								<Text size="xs" c="dimmed">
									{formatFullLocaleDateTime(step.time)}
								</Text>
								{delta != null && (
									<Badge size="xs" variant="light" color="gray">
										+{formatDurationText(delta, { style: "precise" })}
									</Badge>
								)}
							</Group>
						</Timeline.Item>
					);
				})}
			</Timeline>
			<Group gap="xs" wrap="wrap">
				{streamStarted != null && totalEnd != null && (
					<Badge size="sm" variant="light">
						{t("toolCallInspector.timing.total", {
							duration: formatDurationText(totalEnd - streamStarted, { style: "precise" }),
						})}
					</Badge>
				)}
				{permissionStarted != null && executionStarted != null && (
					<Badge size="sm" variant="light" color="yellow">
						{t("toolCallInspector.timing.permissionWait", {
							duration: formatDurationText(executionStarted - permissionStarted, {
								style: "precise",
							}),
						})}
					</Badge>
				)}
				{executionStarted != null && totalEnd != null && (
					<Badge size="sm" variant="light" color="blue">
						{t("toolCallInspector.timing.execution", {
							duration: formatDurationText(totalEnd - executionStarted, { style: "precise" }),
						})}
					</Badge>
				)}
			</Group>
		</Stack>
	);
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
	const { t } = useTranslation("narrator");
	const preview = useMemo(() => formatJsonPreview(value, MAX_JSON_PREVIEW_CHARS), [value]);
	const content = preview.truncated
		? `${preview.text}\n\n${t("toolCallInspector.truncatedPreview")}`
		: preview.text;
	return (
		<Stack gap={6}>
			<Group justify="space-between" gap="xs">
				<Text size="sm" fw={600}>
					{title}
				</Text>
				<LazyCopyJsonIconButton value={value} label={t("toolCallInspector.copy")} />
			</Group>
			{content ? (
				<ContentViewer
					content={content}
					title={title}
					language="json"
					style={{ maxHeight: 260, overflow: "auto", fontSize: 12 }}
				/>
			) : (
				<Text size="sm" c="dimmed">
					{t("toolCallInspector.empty")}
				</Text>
			)}
		</Stack>
	);
}

export function ToolCallInspector({
	narratorId,
	toolUseId,
	opened,
	onClose,
	initialToolCall,
}: ToolCallInspectorProps) {
	const { t } = useTranslation("narrator");
	const enabled = opened && !!narratorId && !!toolUseId;
	const { data, isLoading, isError } = useToolCallDetail(narratorId, toolUseId ?? "", enabled);

	const toolCall = useMemo<ToolCallLike | null>(() => {
		if (!data) return initialToolCall ?? null;
		return {
			...initialToolCall,
			...data,
		};
	}, [data, initialToolCall]);
	const executionTarget = useMemo<ExecutionTargetIdentity | null>(() => {
		if (!toolCall) return null;
		const canonical = toolCall.executionTarget ?? toolCall.executionTargets?.[0];
		if (canonical) return canonical;
		if (!toolCall.executionDeviceId || !toolCall.executionCwd) return null;
		return {
			deviceId: toolCall.executionDeviceId,
			cwd: toolCall.executionCwd,
			resolvedFilePath: toolCall.resolvedFilePath ?? undefined,
			lexicalPath: toolCall.resolvedFilePath ?? undefined,
			selectionSource: toolCall.deviceSelectionSource ?? undefined,
		};
	}, [toolCall]);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("toolCallInspector.title")}
			size="xl"
			overlayProps={{ backgroundOpacity: 0.55, blur: 2 }}
		>
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" gap="sm">
					<Stack gap={4} style={{ minWidth: 0 }}>
						<Group gap="xs" wrap="nowrap">
							<Text fw={700} truncate>
								{toolCall?.toolName ?? t("toolCallInspector.unknownTool")}
							</Text>
							{toolCall?.status && (
								<Badge size="sm" variant="light" color={statusColor(toolCall.status)}>
									{toolCall.status}
								</Badge>
							)}
						</Group>
						<Group gap={6} wrap="nowrap">
							<Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }} truncate>
								{toolUseId}
							</Text>
							<CopyIconButton value={toolUseId ?? ""} label={t("toolCallInspector.copy")} />
						</Group>
						{toolCall?.durationMs != null && (
							<Text size="xs" c="dimmed">
								{t("toolCallInspector.duration", {
									duration: formatDurationText(toolCall.durationMs, { style: "precise" }),
								})}
							</Text>
						)}
					</Stack>
					{isLoading && <Loader size="sm" />}
				</Group>

				{executionTarget && (
					<Stack gap={6}>
						<Text size="sm" fw={600}>
							{t("toolCallInspector.executionTarget.title")}
						</Text>
						<Group gap="xs" wrap="wrap">
							<Badge
								variant="light"
								color={executionTarget.deviceId === "local" ? "gray" : "indigo"}
							>
								{executionTarget.deviceId === "local"
									? t("executionTargetLocal")
									: executionTarget.deviceId}
							</Badge>
							{executionTarget.selectionSource && (
								<Badge variant="outline" color="gray">
									{t(`toolCallInspector.executionTarget.${executionTarget.selectionSource}`)}
								</Badge>
							)}
							{executionTarget.pathFlavor && (
								<Badge variant="outline" color="blue">
									{t("executionTargetPathFlavor", { flavor: executionTarget.pathFlavor })}
								</Badge>
							)}
							{executionTarget.runtimeGeneration != null && (
								<Badge variant="outline" color="grape">
									{t("executionTargetRuntimeGeneration", {
										generation: executionTarget.runtimeGeneration,
									})}
								</Badge>
							)}
						</Group>
						<Group gap={6} wrap="nowrap">
							<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
								{t("executionTargetCwd", { cwd: executionTarget.cwd })}
							</Text>
							<CopyIconButton value={executionTarget.cwd} label={t("toolCallInspector.copy")} />
						</Group>
						{executionTarget.lexicalPath && (
							<Group gap={6} wrap="nowrap">
								<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
									{t("executionTargetLexicalPath", { path: executionTarget.lexicalPath })}
								</Text>
								<CopyIconButton
									value={executionTarget.lexicalPath}
									label={t("toolCallInspector.copy")}
								/>
							</Group>
						)}
						{executionTarget.canonicalPath && (
							<Group gap={6} wrap="nowrap">
								<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
									{t("executionTargetCanonicalPath", { path: executionTarget.canonicalPath })}
								</Text>
								<CopyIconButton
									value={executionTarget.canonicalPath}
									label={t("toolCallInspector.copy")}
								/>
							</Group>
						)}
					</Stack>
				)}

				{toolCall && <TimingTimeline toolCall={toolCall} />}

				{isError && (
					<Box
						p="sm"
						style={{
							border: "1px solid var(--mantine-color-red-5)",
							borderRadius: "var(--mantine-radius-sm)",
						}}
					>
						<Text size="sm" c="red">
							{t("toolCallInspector.loadFailed")}
						</Text>
					</Box>
				)}

				{toolCall?.errorMessage && (
					<Stack gap={6}>
						<Text size="sm" fw={600} c="red">
							{t("toolCallInspector.error")}
						</Text>
						<ContentViewer
							content={toolCall.errorMessage}
							fullContent={toolCall.errorMessage}
							title={t("toolCallInspector.error")}
							style={{ maxHeight: 160, overflow: "auto", fontSize: 12 }}
						/>
					</Stack>
				)}

				<JsonSection title={t("toolCallInspector.input")} value={toolCall?.inputJson} />
				<JsonSection title={t("toolCallInspector.output")} value={toolCall?.outputJson} />
				<SideCarNotice sideCars={toolCall?.sideCars} mode="detail" />

				<Group gap="xs" justify="flex-end">
					<LazyCopyJsonIconButton
						value={toolCall?.inputJson}
						label={t("toolCallInspector.copyInput")}
					/>
					<LazyCopyJsonIconButton
						value={toolCall?.outputJson}
						label={t("toolCallInspector.copyOutput")}
					/>
				</Group>
			</Stack>
		</Modal>
	);
}
