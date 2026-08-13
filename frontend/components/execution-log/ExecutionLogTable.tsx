import { getCategory, getCategoryColor } from "@frontend/components/narrator/tool-display";
import {
	formatDurationText,
	formatFullLocaleDateTime,
	formatSmartTime,
} from "@frontend/lib/format";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import type { ExecutionLogRecord, ExecutionLogStatus } from "@frontend/types/execution-log";
import {
	Badge,
	Card,
	Group,
	ScrollArea,
	Stack,
	Table,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconClock, IconDeviceLaptop, IconServer } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

interface ExecutionLogTableProps {
	records: ExecutionLogRecord[];
	loading?: boolean;
	onSelect: (record: ExecutionLogRecord) => void;
}

function statusColor(status: ExecutionLogStatus): string {
	switch (status) {
		case "success":
			return "green";
		case "fail":
			return "red";
		case "running":
			return "blue";
		case "pending":
			return "yellow";
		default:
			return "gray";
	}
}

/**
 * Which timestamp column the row's `startedAt` came from.
 *
 * The value is a fallback chain, so "when did this run" can mean four different
 * lifecycle stages. Naming the source keeps a row whose only timestamp is its
 * creation from reading as though execution was actually observed.
 */
function startedAtSource(
	record: ExecutionLogRecord,
): "execution" | "permission" | "stream" | "created" {
	if (record.executionStartedAt) return "execution";
	if (record.permissionStartedAt) return "permission";
	if (record.streamStartedAt) return "stream";
	return "created";
}

function NarratorCell({ record }: { record: ExecutionLogRecord }) {
	const { t } = useTranslation("common");
	const isSubagent = record.narratorType === "subagent";
	const label = record.narratorTitle?.trim() || t("executionLogUntitledNarrator");

	return (
		<Stack gap={2} style={{ minWidth: 0 }}>
			<Group gap={6} wrap="nowrap">
				<Text size="sm" lineClamp={1} title={label}>
					{label}
				</Text>
				{isSubagent ? (
					<Badge size="xs" variant="light" color="pink">
						{record.subagentType || t("executionLogSubagent")}
					</Badge>
				) : null}
				{record.isBackground ? (
					<Badge size="xs" variant="outline" color="gray">
						{t("executionLogBackground")}
					</Badge>
				) : null}
			</Group>
			{record.chapterTitle || record.projectName ? (
				<Text size="xs" c="dimmed" lineClamp={1}>
					{[record.projectName, record.chapterTitle].filter(Boolean).join(" · ")}
				</Text>
			) : (
				<Text size="xs" c="dimmed">
					{t("executionLogStandalone")}
				</Text>
			)}
		</Stack>
	);
}

function ToolCell({ record }: { record: ExecutionLogRecord }) {
	// Category is derived from the tool name only: the list intentionally has no
	// input payload to inspect, and the name alone is what colours the glyph.
	const color = getCategoryColor(getCategory(record.toolName));
	return (
		<Stack gap={2} style={{ minWidth: 0 }}>
			<Badge size="sm" variant="light" color={color} style={{ alignSelf: "flex-start" }}>
				{record.toolName}
			</Badge>
			{record.summary ? (
				<Text size="xs" c="dimmed" lineClamp={2} title={record.summary}>
					{record.summary}
				</Text>
			) : null}
		</Stack>
	);
}

function TargetCell({ record }: { record: ExecutionLogRecord }) {
	const { t } = useTranslation("common");
	if (!record.executionDeviceId && !record.executionCwd) {
		return (
			<Text size="sm" c="dimmed">
				-
			</Text>
		);
	}
	const isLocal = !record.executionDeviceId || record.executionDeviceId === "local";
	return (
		<Stack gap={2} style={{ minWidth: 0 }}>
			<Group gap={4} wrap="nowrap">
				{isLocal ? <IconServer size={13} /> : <IconDeviceLaptop size={13} />}
				<Text size="xs" ff={isLocal ? undefined : "monospace"} lineClamp={1}>
					{isLocal ? t("executionLogLocalTarget") : record.executionDeviceId}
				</Text>
			</Group>
			{record.executionCwd ? (
				<Text size="xs" c="dimmed" ff="monospace" lineClamp={1} title={record.executionCwd}>
					{record.executionCwd}
				</Text>
			) : null}
		</Stack>
	);
}

function TimeCell({ record }: { record: ExecutionLogRecord }) {
	const { t } = useTranslation("common");
	const source = startedAtSource(record);
	return (
		<Stack gap={2}>
			<Tooltip
				label={`${formatFullLocaleDateTime(record.startedAt)} · ${t(
					`executionLogStartedFrom_${source}`,
				)}`}
				withArrow
			>
				<Text size="sm" style={{ cursor: "help" }}>
					{formatSmartTime(record.startedAt)}
				</Text>
			</Tooltip>
			{source === "created" ? (
				<Text size="xs" c="dimmed">
					{t("executionLogApproxTime")}
				</Text>
			) : null}
		</Stack>
	);
}

export function ExecutionLogTable({ records, loading, onSelect }: ExecutionLogTableProps) {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;

	if (loading) return <Text c="dimmed">{t("executionLogLoading")}</Text>;
	if (records.length === 0) return <Text c="dimmed">{t("executionLogEmpty")}</Text>;

	if (isMobile) {
		return (
			<Stack gap="xs">
				{records.map((record) => (
					// UnstyledButton wraps the Card rather than being its polymorphic
					// `component`: Mantine's Card typing does not accept the button's
					// event props, and nesting keeps the row keyboard-activatable.
					<UnstyledButton
						key={record.id}
						onClick={() => onSelect(record)}
						style={{ textAlign: "left", width: "100%" }}
					>
						<Card withBorder radius="sm" padding="xs">
							<Stack gap="xs">
								<Group justify="space-between" align="start" wrap="nowrap" gap="xs">
									<TimeCell record={record} />
									<Group gap={4} wrap="nowrap">
										<Badge size="sm" variant="light" color={statusColor(record.status)}>
											{t(`executionLogStatus_${record.status}`)}
										</Badge>
									</Group>
								</Group>
								<ToolCell record={record} />
								<NarratorCell record={record} />
								<Group justify="space-between" wrap="nowrap" gap="xs">
									<TargetCell record={record} />
									<Group gap={4} wrap="nowrap">
										<IconClock size={13} />
										<Text size="xs">
											{formatDurationText(record.durationMs, { style: "precise", fallback: "-" })}
										</Text>
									</Group>
								</Group>
								{record.errorMessage ? (
									<Text size="xs" c="red" lineClamp={2}>
										{record.errorMessage}
									</Text>
								) : null}
							</Stack>
						</Card>
					</UnstyledButton>
				))}
			</Stack>
		);
	}

	return (
		<ScrollArea type="auto" offsetScrollbars>
			<Table striped highlightOnHover withTableBorder withColumnBorders miw={1100}>
				<Table.Thead>
					<Table.Tr>
						<Table.Th w={140}>{t("executionLogColumnStartedAt")}</Table.Th>
						<Table.Th w={220}>{t("executionLogColumnNarrator")}</Table.Th>
						<Table.Th>{t("executionLogColumnTool")}</Table.Th>
						<Table.Th w={110}>{t("executionLogColumnStatus")}</Table.Th>
						<Table.Th w={90}>{t("executionLogColumnDuration")}</Table.Th>
						<Table.Th w={200}>{t("executionLogColumnTarget")}</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{records.map((record) => (
						<Table.Tr
							key={record.id}
							onClick={() => onSelect(record)}
							style={{ cursor: "pointer" }}
						>
							<Table.Td>
								<TimeCell record={record} />
							</Table.Td>
							<Table.Td>
								<NarratorCell record={record} />
							</Table.Td>
							<Table.Td>
								<ToolCell record={record} />
								{record.errorMessage ? (
									<Text size="xs" c="red" lineClamp={2} mt={2}>
										{record.errorMessage}
									</Text>
								) : null}
							</Table.Td>
							<Table.Td>
								<Badge size="sm" variant="light" color={statusColor(record.status)}>
									{t(`executionLogStatus_${record.status}`)}
								</Badge>
							</Table.Td>
							<Table.Td>
								<Group gap={4} wrap="nowrap">
									<IconClock size={13} />
									<Text size="sm">
										{formatDurationText(record.durationMs, { style: "precise", fallback: "-" })}
									</Text>
								</Group>
							</Table.Td>
							<Table.Td>
								<TargetCell record={record} />
							</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>
		</ScrollArea>
	);
}
