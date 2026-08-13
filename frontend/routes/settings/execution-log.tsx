import {
	EMPTY_EXECUTION_LOG_DRAFT,
	type ExecutionLogDraftFilters,
	ExecutionLogFilterBar,
	toExecutionLogFilters,
} from "@frontend/components/execution-log/ExecutionLogFilterBar";
import { ExecutionLogTable } from "@frontend/components/execution-log/ExecutionLogTable";
import { ToolCallInspector } from "@frontend/components/narrator/ToolCallInspector";
import { executionLogApi } from "@frontend/lib/execution-log-api";
import {
	advanceExecutionLogCursor,
	currentExecutionLogCursor,
	executionLogListQueryKey,
	retreatExecutionLogCursor,
} from "@frontend/lib/execution-log-cursor-window";
import { formatFullLocaleDateTime } from "@frontend/lib/format";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import type { ExecutionLogFilters, ExecutionLogRecord } from "@frontend/types/execution-log";
import { Alert, Button, Group, Select, Stack, Text, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconInfoCircle, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/settings/execution-log")({
	component: SettingsExecutionLogPage,
});

const EXECUTION_LOG_QUERY_GC_TIME_MS = 60_000;

function SettingsExecutionLogPage() {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const [pageSize, setPageSize] = useState(50);
	const [cursorStack, setCursorStack] = useState<string[]>([]);
	const [filters, setFilters] = useState<ExecutionLogFilters>({});
	const [draft, setDraft] = useState<ExecutionLogDraftFilters>(EMPTY_EXECUTION_LOG_DRAFT);
	const [selected, setSelected] = useState<ExecutionLogRecord | null>(null);
	const currentCursor = currentExecutionLogCursor(cursorStack);

	const {
		data: listData,
		isLoading,
		isFetching,
		refetch,
	} = useQuery({
		queryKey: executionLogListQueryKey(filters, pageSize, currentCursor),
		queryFn: ({ signal }) =>
			executionLogApi.listCursor(filters, { cursor: currentCursor, limit: pageSize, signal }),
		gcTime: EXECUTION_LOG_QUERY_GC_TIME_MS,
	});

	const { data: facets } = useQuery({
		queryKey: ["execution-log", "facets"],
		queryFn: ({ signal }) => executionLogApi.getFacets(signal),
		gcTime: EXECUTION_LOG_QUERY_GC_TIME_MS,
	});

	// The list carries no payloads by design, so the detail is fetched on demand.
	const {
		data: detail,
		isLoading: isDetailLoading,
		isError: isDetailError,
	} = useQuery({
		queryKey: ["execution-log", "detail", selected?.id],
		queryFn: ({ signal }) => executionLogApi.getRecord(selected?.id as string, signal),
		enabled: !!selected?.id,
		gcTime: 0,
	});

	const applyFilters = () => {
		setCursorStack([]);
		setFilters(toExecutionLogFilters(draft));
	};

	const resetFilters = () => {
		setDraft(EMPTY_EXECUTION_LOG_DRAFT);
		setCursorStack([]);
		setFilters({});
	};

	const inspectorDetail = useMemo(() => {
		if (!selected) return null;
		// Merge so the modal can show the row's own context (narrator, chapter)
		// immediately while the payload-bearing detail is still in flight.
		return detail ? { ...selected, ...detail } : null;
	}, [selected, detail]);

	return (
		<Stack gap={isMobile ? "md" : "lg"}>
			<Group justify="space-between" wrap="wrap" gap="xs">
				<Stack gap={2}>
					<Title order={3}>{t("executionLogTitle")}</Title>
					<Text size="sm" c="dimmed">
						{t("executionLogSubtitle")}
					</Text>
				</Stack>
				<Button
					size={isMobile ? "xs" : "sm"}
					leftSection={<IconRefresh size={16} />}
					variant="light"
					loading={isFetching}
					onClick={() => refetch()}
				>
					{t("executionLogRefresh")}
				</Button>
			</Group>

			<ExecutionLogFilterBar
				draft={draft}
				onDraftChange={setDraft}
				onApply={applyFilters}
				onReset={resetFilters}
				facets={facets}
			/>

			{listData?.payloadSearchTruncated ? (
				<Alert
					color="yellow"
					variant="light"
					icon={<IconInfoCircle size={18} />}
					title={t("executionLogPayloadWindowTitle")}
				>
					<Text size="sm">
						{t("executionLogPayloadWindowHint", {
							since: listData.payloadSearchWindowStart
								? formatFullLocaleDateTime(listData.payloadSearchWindowStart)
								: "",
						})}
					</Text>
				</Alert>
			) : null}

			<ExecutionLogTable
				records={listData?.records ?? []}
				loading={isLoading}
				onSelect={setSelected}
			/>

			<Group justify="center" align="end" wrap="wrap">
				<Button
					size={isMobile ? "sm" : "md"}
					variant="light"
					disabled={cursorStack.length === 0 || isFetching}
					onClick={() => setCursorStack((current) => retreatExecutionLogCursor(current))}
				>
					{t("executionLogPreviousPage")}
				</Button>
				<Text
					size="sm"
					c="dimmed"
					h={isMobile ? 36 : 42}
					style={{ display: "flex", alignItems: "center" }}
				>
					{t("executionLogPage", { page: cursorStack.length + 1 })}
				</Text>
				<Button
					size={isMobile ? "sm" : "md"}
					variant="light"
					disabled={!listData?.hasMore || !listData.nextCursor || isFetching}
					onClick={() =>
						setCursorStack((current) => advanceExecutionLogCursor(current, listData?.nextCursor))
					}
				>
					{t("executionLogNextPage")}
				</Button>
				<Select
					size={isMobile ? "xs" : "sm"}
					label={t("executionLogPageSize")}
					data={["25", "50", "100"]}
					value={String(pageSize)}
					allowDeselect={false}
					w={100}
					onChange={(value) => {
						if (!value) return;
						setCursorStack([]);
						setPageSize(Number(value));
					}}
				/>
			</Group>

			{selected ? (
				<ToolCallInspector
					narratorId={selected.narratorId}
					toolUseId={selected.toolUseId}
					opened={!!selected}
					onClose={() => setSelected(null)}
					initialToolCall={selected}
					// Fed externally: this page reads the tool-call table directly, so it can
					// show rows the narrator-scoped endpoint would refuse.
					detail={inspectorDetail}
					detailLoading={isDetailLoading}
					detailError={isDetailError}
				/>
			) : null}
		</Stack>
	);
}
