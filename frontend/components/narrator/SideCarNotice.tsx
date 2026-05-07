import {
	ActionIcon,
	Badge,
	Box,
	CopyButton,
	Group,
	Stack,
	Text,
	ThemeIcon,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconInfoCircle,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SideCarRecord } from "../../lib/api";
import { LazyCollapse } from "./LazyCollapse";

const SOURCE_META: Record<string, { color: string; key: string }> = {
	silent_progress: { color: "indigo", key: "silent_progress" },
	todo_reminder: { color: "gray", key: "todo_reminder" },
	bg_agent: { color: "blue", key: "bg_agent" },
	bg_bash: { color: "blue", key: "bg_bash" },
	team_message: { color: "grape", key: "team_message" },
	buffered_user: { color: "gray", key: "buffered_user" },
};

function sourceColor(source: string): string {
	return SOURCE_META[source]?.color ?? "gray";
}

function previewContent(content: string): string {
	const compact = content.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
}

function sideCarKey(sideCar: SideCarRecord): string {
	return [
		sideCar.id,
		sideCar.source,
		sideCar.target,
		sideCar.toolUseId ?? "message",
		sideCar.orderIndex ?? "no-order",
		sideCar.content.slice(0, 48),
	]
		.filter(Boolean)
		.join(":");
}

function sourceLabel(t: (key: string) => string, source: string): string {
	const meta = SOURCE_META[source];
	if (!meta) return source || t("sidecar.unknownSource");
	return t(`sidecar.sources.${meta.key}`);
}

function SideCarItem({ sideCar, detail }: { sideCar: SideCarRecord; detail?: boolean }) {
	const { t } = useTranslation("narrator");
	const label = sourceLabel(t, sideCar.source);
	const color = sourceColor(sideCar.source);
	const content = sideCar.content ?? "";

	return (
		<Box
			p="xs"
			style={{
				borderLeft: `2px solid var(--mantine-color-${color}-5)`,
				backgroundColor: "rgba(255, 255, 255, 0.025)",
				borderRadius: "var(--mantine-radius-sm)",
			}}
		>
			<Stack gap={6}>
				<Group gap="xs" justify="space-between" align="center">
					<Group gap={6} wrap="wrap">
						<Badge size="xs" variant="light" color={color}>
							{label}
						</Badge>
						<Badge size="xs" variant="outline" color="gray">
							{sideCar.target}
						</Badge>
						{sideCar.toolUseId && (
							<Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
								{sideCar.toolUseId}
							</Text>
						)}
						{sideCar.orderIndex != null && (
							<Text size="xs" c="dimmed">
								#{sideCar.orderIndex}
							</Text>
						)}
					</Group>
					<CopyButton value={content} timeout={1500}>
						{({ copied, copy }) => (
							<Tooltip label={copied ? t("sidecar.copied") : t("sidecar.copy")}>
								<ActionIcon
									variant="subtle"
									color={copied ? "green" : "gray"}
									size="xs"
									onClick={(event) => {
										event.stopPropagation();
										copy();
									}}
								>
									{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
								</ActionIcon>
							</Tooltip>
						)}
					</CopyButton>
				</Group>
				<Box
					component={detail ? "pre" : "div"}
					style={{
						margin: 0,
						whiteSpace: detail ? "pre-wrap" : "normal",
						wordBreak: "break-word",
						fontFamily: detail ? "var(--mantine-font-family-monospace)" : undefined,
					}}
				>
					<Text size="xs" c="dimmed" component="span">
						{detail ? content || t("sidecar.empty") : previewContent(content) || t("sidecar.empty")}
					</Text>
				</Box>
			</Stack>
		</Box>
	);
}

export function SideCarNotice({
	sideCars,
	mode = "inline",
	initiallyOpen = false,
}: {
	sideCars?: SideCarRecord[] | null;
	mode?: "inline" | "detail";
	initiallyOpen?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(initiallyOpen || mode === "detail");
	const visibleSideCars = useMemo(
		() => (sideCars ?? []).filter((sideCar) => sideCar.content?.trim()),
		[sideCars],
	);
	const sources = useMemo(
		() => [...new Set(visibleSideCars.map((sideCar) => sideCar.source))],
		[visibleSideCars],
	);
	if (visibleSideCars.length === 0) return null;

	const title = t("sidecar.titleWithCount", { count: visibleSideCars.length });

	if (mode === "detail") {
		return (
			<Stack gap="xs">
				<Group gap="xs">
					<ThemeIcon size="sm" variant="light" color="indigo">
						<IconInfoCircle size={14} />
					</ThemeIcon>
					<Text size="sm" fw={600}>
						{title}
					</Text>
				</Group>
				{visibleSideCars.map((sideCar) => (
					<SideCarItem key={sideCarKey(sideCar)} sideCar={sideCar} detail />
				))}
			</Stack>
		);
	}

	return (
		<Box mt={6} onClick={(event) => event.stopPropagation()}>
			<UnstyledButton
				onClick={(event) => {
					event.stopPropagation();
					setOpened((value) => !value);
				}}
				style={{ width: "100%" }}
			>
				<Group gap="xs" wrap="wrap" align="center">
					<ThemeIcon size="xs" variant="light" color="indigo">
						<IconInfoCircle size={12} />
					</ThemeIcon>
					<Text size="xs" c="dimmed" fw={500}>
						{title}
					</Text>
					{sources.map((source) => (
						<Badge key={source} size="xs" variant="light" color={sourceColor(source)}>
							{sourceLabel(t, source)}
						</Badge>
					))}
					{opened ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
				</Group>
			</UnstyledButton>
			<LazyCollapse in={opened}>
				<Stack gap={6} mt={6}>
					{visibleSideCars.map((sideCar) => (
						<SideCarItem key={sideCarKey(sideCar)} sideCar={sideCar} />
					))}
				</Stack>
			</LazyCollapse>
		</Box>
	);
}
