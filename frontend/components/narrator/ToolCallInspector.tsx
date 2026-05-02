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
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { ContentViewer } from "./ContentViewer";

interface ToolCallLike {
	id?: string;
	toolName?: string;
	toolUseId?: string;
	status?: string;
	durationMs?: number | null;
	streamStartedAt?: string | null;
	permissionStartedAt?: string | null;
	executionStartedAt?: string | null;
	completedAt?: string | null;
	createdAt?: string | null;
	errorMessage?: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: tool call JSON is dynamic by design
	inputJson?: any;
	// biome-ignore lint/suspicious/noExplicitAny: tool call JSON is dynamic by design
	outputJson?: any;
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
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}min${seconds}s`;
}

function parseTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const time = new Date(value).getTime();
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
									{new Date(step.time).toLocaleString()}
								</Text>
								{delta != null && (
									<Badge size="xs" variant="light" color="gray">
										+{formatDuration(delta)}
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
							duration: formatDuration(totalEnd - streamStarted),
						})}
					</Badge>
				)}
				{permissionStarted != null && executionStarted != null && (
					<Badge size="sm" variant="light" color="yellow">
						{t("toolCallInspector.timing.permissionWait", {
							duration: formatDuration(executionStarted - permissionStarted),
						})}
					</Badge>
				)}
				{executionStarted != null && totalEnd != null && (
					<Badge size="sm" variant="light" color="blue">
						{t("toolCallInspector.timing.execution", {
							duration: formatDuration(totalEnd - executionStarted),
						})}
					</Badge>
				)}
			</Group>
		</Stack>
	);
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
	const { t } = useTranslation("narrator");
	const content = stringifyJson(value);
	return (
		<Stack gap={6}>
			<Group justify="space-between" gap="xs">
				<Text size="sm" fw={600}>
					{title}
				</Text>
				<CopyIconButton value={content} label={t("toolCallInspector.copy")} />
			</Group>
			{content ? (
				<ContentViewer
					content={content}
					fullContent={content}
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
	const { data, isLoading, isError } = useQuery({
		queryKey: ["narrators", narratorId, "tool-calls", toolUseId, "inspector"],
		queryFn: () => api.getToolCallDetail(narratorId, toolUseId as string),
		enabled,
		staleTime: 30 * 1000,
	});

	const toolCall = useMemo<ToolCallLike | null>(() => {
		if (!data) return initialToolCall ?? null;
		return {
			...initialToolCall,
			...data,
		};
	}, [data, initialToolCall]);

	const inputContent = stringifyJson(toolCall?.inputJson);
	const outputContent = stringifyJson(toolCall?.outputJson);

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
								{t("toolCallInspector.duration", { ms: toolCall.durationMs })}
							</Text>
						)}
					</Stack>
					{isLoading && <Loader size="sm" />}
				</Group>

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

				<Group gap="xs" justify="flex-end">
					<CopyButton value={inputContent} timeout={1500}>
						{({ copied, copy }) => (
							<ActionIcon.Group>
								<Tooltip
									label={copied ? t("toolCallInspector.copied") : t("toolCallInspector.copyInput")}
								>
									<ActionIcon variant="light" onClick={copy} disabled={!inputContent}>
										{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
									</ActionIcon>
								</Tooltip>
							</ActionIcon.Group>
						)}
					</CopyButton>
					<CopyButton value={outputContent} timeout={1500}>
						{({ copied, copy }) => (
							<Tooltip
								label={copied ? t("toolCallInspector.copied") : t("toolCallInspector.copyOutput")}
							>
								<ActionIcon variant="light" onClick={copy} disabled={!outputContent}>
									{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
								</ActionIcon>
							</Tooltip>
						)}
					</CopyButton>
				</Group>
			</Stack>
		</Modal>
	);
}
