import { UsageBreakdownChart } from "@frontend/components/usage-history/UsageBreakdownChart";
import { UsageHistoryChart } from "@frontend/components/usage-history/UsageHistoryChart";
import { UsageHistoryTable } from "@frontend/components/usage-history/UsageHistoryTable";
import { UsageStackedChart } from "@frontend/components/usage-history/UsageStackedChart";
import { UsageStatsSummary } from "@frontend/components/usage-history/UsageStatsSummary";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import {
	advanceUsageHistoryCursor,
	currentUsageHistoryCursor,
	retreatUsageHistoryCursor,
	usageHistoryListQueryKey,
} from "@frontend/lib/usage-history-cursor-window";
import type {
	UsageHistoryFilters,
	UsageHistoryGranularity,
	UsageHistoryRecord,
} from "@frontend/types/usage-history";
import {
	Autocomplete,
	Button,
	Collapse,
	Grid,
	Group,
	Select,
	Stack,
	Tabs,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useLocalStorage, useMediaQuery } from "@mantine/hooks";
import {
	IconChartBar,
	IconChevronDown,
	IconChevronRight,
	IconDownload,
	IconFilter,
	IconFilterOff,
	IconList,
	IconRefresh,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/settings/usage")({
	component: SettingsUsagePage,
});

const USAGE_HISTORY_QUERY_GC_TIME_MS = 60_000;

// --- Date preset helpers ---

function toDateStr(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function getDatePreset(preset: string): { start: string; end: string } {
	const now = new Date();
	const today = toDateStr(now);

	switch (preset) {
		case "today":
			return { start: today, end: today };
		case "7d": {
			const d = new Date(now);
			d.setDate(d.getDate() - 6);
			return { start: toDateStr(d), end: today };
		}
		case "30d": {
			const d = new Date(now);
			d.setDate(d.getDate() - 29);
			return { start: toDateStr(d), end: today };
		}
		case "month": {
			const start = new Date(now.getFullYear(), now.getMonth(), 1);
			return { start: toDateStr(start), end: today };
		}
		case "lastMonth": {
			const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			const end = new Date(now.getFullYear(), now.getMonth(), 0);
			return { start: toDateStr(start), end: toDateStr(end) };
		}
		default:
			return { start: today, end: today };
	}
}

// --- CSV export ---

function exportRecordsToCsv(records: UsageHistoryRecord[], fileName: string) {
	const headers = [
		"Time",
		"Narrator",
		"Chapter",
		"Kind",
		"Provider",
		"Model",
		"Input Tokens",
		"Output Tokens",
		"Cached Tokens",
		"Reasoning Tokens",
		"TTFT (ms)",
		"Duration (ms)",
		"Cost (USD)",
		"Error",
	];
	const rows = records.map((r) => [
		r.createdAt,
		r.narratorTitle ?? r.narratorId ?? "",
		r.chapterTitle ?? "",
		r.kind,
		r.provider ?? "",
		r.model ?? "",
		r.inputTokens,
		r.outputTokens,
		r.cachedInputTokens,
		r.reasoningTokens,
		r.ttftMs ?? "",
		r.durationMs ?? "",
		r.costUsd ?? "",
		r.errorMessage ?? "",
	]);

	const escapeCsv = (v: unknown) => {
		const s = String(v ?? "");
		return s.includes(",") || s.includes('"') || s.includes("\n")
			? `"${s.replace(/"/g, '""')}"`
			: s;
	};

	const csv = [
		headers.map(escapeCsv).join(","),
		...rows.map((row) => row.map(escapeCsv).join(",")),
	].join("\n");

	const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

// --- Collapsible section ---

function CollapsibleSection({
	title,
	storageKey,
	children,
}: {
	title: string;
	storageKey: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useLocalStorage({ key: storageKey, defaultValue: true });

	return (
		<Stack gap={0}>
			<Group
				gap="xs"
				style={{ cursor: "pointer", userSelect: "none" }}
				onClick={() => setOpen(!open)}
			>
				{open ? (
					<IconChevronDown size={16} color="var(--mantine-color-dimmed)" />
				) : (
					<IconChevronRight size={16} color="var(--mantine-color-dimmed)" />
				)}
				<Text size="sm" fw={500} c="dimmed">
					{title}
				</Text>
			</Group>
			<Collapse expanded={open}>
				<div style={{ paddingTop: 8 }}>{children}</div>
			</Collapse>
		</Stack>
	);
}

// --- Main page ---

function SettingsUsagePage() {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const [pageSize, setPageSize] = useState(50);
	const [cursorStack, setCursorStack] = useState<string[]>([]);
	const [filters, setFilters] = useState<UsageHistoryFilters>({});
	const [tempFilters, setTempFilters] = useState<UsageHistoryFilters>({});
	const [granularity, setGranularity] = useState<UsageHistoryGranularity>("day");
	const [startDate, setStartDate] = useState<string | null>(null);
	const [endDate, setEndDate] = useState<string | null>(null);
	const [activePreset, setActivePreset] = useState<string | null>(null);
	const currentCursor = currentUsageHistoryCursor(cursorStack);

	const {
		data: listData,
		isLoading: isLoadingList,
		isFetching: isFetchingList,
		refetch: refetchList,
	} = useQuery({
		queryKey: usageHistoryListQueryKey(filters, pageSize, currentCursor),
		queryFn: ({ signal }) =>
			usageHistoryApi.listCursor(filters, {
				cursor: currentCursor,
				limit: pageSize,
				signal,
			}),
		gcTime: USAGE_HISTORY_QUERY_GC_TIME_MS,
	});

	const { data: stats, refetch: refetchStats } = useQuery({
		queryKey: ["usage-history", "stats", filters],
		queryFn: () => usageHistoryApi.getStats(filters),
		gcTime: USAGE_HISTORY_QUERY_GC_TIME_MS,
	});

	const {
		data: timeSeries,
		isLoading: isLoadingTimeSeries,
		refetch: refetchTimeSeries,
	} = useQuery({
		queryKey: ["usage-history", "timeseries", filters, granularity],
		queryFn: () => usageHistoryApi.getTimeSeries(filters, { granularity }),
		gcTime: USAGE_HISTORY_QUERY_GC_TIME_MS,
	});

	const { data: providersData } = useQuery({
		queryKey: ["usage-history", "providers"],
		queryFn: () => usageHistoryApi.listProviders(),
		gcTime: USAGE_HISTORY_QUERY_GC_TIME_MS,
	});

	const kindOptions = useMemo(
		() =>
			[
				"narrator",
				"compact",
				"context_ask",
				"fork_summary",
				"title",
				"merge_summary",
				"web_fetch_smart",
				"reflection",
				"reasoning_translation",
				"settings_test",
				"git_summary",
				"internal",
			].map((kind) => ({ value: kind, label: t(`usageHistoryKind_${kind}`, kind) })),
		[t],
	);

	const applyFilters = useCallback(() => {
		setCursorStack([]);
		setFilters({
			provider: tempFilters.provider?.trim() || undefined,
			model: tempFilters.model?.trim() || undefined,
			kind: tempFilters.kind || undefined,
			startDate: startDate ? new Date(`${startDate}T00:00:00.000Z`).toISOString() : undefined,
			endDate: endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined,
		});
	}, [tempFilters, startDate, endDate]);

	const resetFilters = () => {
		setTempFilters({});
		setStartDate(null);
		setEndDate(null);
		setActivePreset(null);
		setCursorStack([]);
		setFilters({});
	};

	const applyDatePreset = (preset: string) => {
		const { start, end } = getDatePreset(preset);
		setStartDate(start);
		setEndDate(end);
		setActivePreset(preset);
		setCursorStack([]);
		setFilters({
			provider: tempFilters.provider?.trim() || undefined,
			model: tempFilters.model?.trim() || undefined,
			kind: tempFilters.kind || undefined,
			startDate: new Date(`${start}T00:00:00.000Z`).toISOString(),
			endDate: new Date(`${end}T23:59:59.999Z`).toISOString(),
		});
	};

	const handleExportCsv = () => {
		const records = listData?.records ?? [];
		if (records.length === 0) return;
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		exportRecordsToCsv(records, `usage-history-${ts}.csv`);
	};

	const hasActiveFilters =
		!!filters.provider ||
		!!filters.model ||
		!!filters.kind ||
		!!filters.startDate ||
		!!filters.endDate;

	const datePresets = useMemo(
		() => [
			{ key: "today", label: t("usageDatePresetToday") },
			{ key: "7d", label: t("usageDatePreset7d") },
			{ key: "30d", label: t("usageDatePreset30d") },
			{ key: "month", label: t("usageDatePresetMonth") },
			{ key: "lastMonth", label: t("usageDatePresetLastMonth") },
		],
		[t],
	);

	return (
		<div
			style={{
				padding: isMobile ? "0.75rem" : "2rem",
				maxWidth: 1400,
				margin: "0 auto",
			}}
		>
			<Stack gap={isMobile ? "md" : "lg"}>
				{/* Header */}
				<Group justify="space-between">
					<Title order={isMobile ? 3 : 2}>{t("usageHistoryTitle")}</Title>
					<Button
						size={isMobile ? "sm" : "md"}
						leftSection={<IconRefresh size={isMobile ? 14 : 16} />}
						variant="light"
						onClick={() => {
							refetchList();
							refetchStats();
							refetchTimeSeries();
						}}
					>
						{t("usageHistoryRefresh")}
					</Button>
				</Group>

				{/* Shared filters */}
				<Stack gap="xs">
					<Group gap={4} wrap="wrap">
						{datePresets.map((preset) => (
							<Button
								key={preset.key}
								size="compact-xs"
								variant={activePreset === preset.key ? "filled" : "light"}
								color={activePreset === preset.key ? "indigo" : "gray"}
								onClick={() => applyDatePreset(preset.key)}
							>
								{preset.label}
							</Button>
						))}
					</Group>

					<Group gap={isMobile ? "xs" : "sm"} wrap="wrap" align="flex-end">
						<Autocomplete
							size="xs"
							label={t("usageHistoryProvider")}
							placeholder={t("usageHistoryProviderPlaceholder")}
							data={providersData?.providers ?? []}
							value={tempFilters.provider ?? ""}
							w={isMobile ? "100%" : 140}
							onChange={(value) =>
								setTempFilters((prev) => ({
									...prev,
									provider: value || undefined,
								}))
							}
						/>
						<TextInput
							size="xs"
							label={t("usageHistoryModel")}
							placeholder={t("usageHistoryModelPlaceholder")}
							value={tempFilters.model ?? ""}
							w={isMobile ? "100%" : 150}
							onChange={(e) => {
								const value = e.currentTarget.value;
								setTempFilters((prev) => ({ ...prev, model: value || undefined }));
							}}
						/>
						<Select
							size="xs"
							label={t("usageHistoryKind")}
							placeholder={t("usageHistoryAllKinds")}
							data={kindOptions}
							clearable
							value={tempFilters.kind ?? null}
							w={isMobile ? "100%" : 140}
							onChange={(value) =>
								setTempFilters((prev) => ({ ...prev, kind: value || undefined }))
							}
						/>
						<DatePickerInput
							size="xs"
							label={t("usageHistoryStartDate")}
							placeholder={t("usageHistoryStartDate")}
							value={startDate}
							clearable
							w={isMobile ? "100%" : 140}
							onChange={(v) => {
								setStartDate(v);
								setActivePreset(null);
							}}
							maxDate={endDate ?? undefined}
							popoverProps={{ withinPortal: true }}
						/>
						<DatePickerInput
							size="xs"
							label={t("usageHistoryEndDate")}
							placeholder={t("usageHistoryEndDate")}
							value={endDate}
							clearable
							w={isMobile ? "100%" : 140}
							onChange={(v) => {
								setEndDate(v);
								setActivePreset(null);
							}}
							minDate={startDate ?? undefined}
							popoverProps={{ withinPortal: true }}
						/>
						<Button size="xs" leftSection={<IconFilter size={14} />} onClick={applyFilters}>
							{t("usageHistoryApplyFilters")}
						</Button>
						<Button
							size="xs"
							variant="light"
							color={hasActiveFilters ? "red" : "gray"}
							leftSection={<IconFilterOff size={14} />}
							onClick={resetFilters}
						>
							{t("usageHistoryReset")}
						</Button>
					</Group>
				</Stack>

				{/* Tabs */}
				<Tabs defaultValue="charts" keepMounted={false}>
					<Tabs.List>
						<Tabs.Tab value="charts" leftSection={<IconChartBar size={14} />}>
							{t("usageTabCharts")}
						</Tabs.Tab>
						<Tabs.Tab value="records" leftSection={<IconList size={14} />}>
							{t("usageTabRecords")}
						</Tabs.Tab>
					</Tabs.List>

					{/* Charts Tab */}
					<Tabs.Panel value="charts" pt="md">
						<Stack gap="lg">
							{stats ? <UsageStatsSummary stats={stats} /> : null}

							<CollapsibleSection
								title={t("usageChartSectionTrend")}
								storageKey="narrafork-usage-charts-open"
							>
								<Grid>
									<Grid.Col span={{ base: 12, lg: 8 }}>
										<UsageHistoryChart
											data={timeSeries}
											loading={isLoadingTimeSeries}
											granularity={granularity}
											onGranularityChange={setGranularity}
										/>
									</Grid.Col>
									<Grid.Col span={{ base: 12, lg: 4 }}>
										<UsageBreakdownChart filters={filters} />
									</Grid.Col>
								</Grid>
							</CollapsibleSection>

							<CollapsibleSection
								title={t("usageChartSectionStacked")}
								storageKey="narrafork-usage-stacked-open"
							>
								<UsageStackedChart filters={filters} />
							</CollapsibleSection>
						</Stack>
					</Tabs.Panel>

					{/* Records Tab */}
					<Tabs.Panel value="records" pt="md">
						<Stack gap="md">
							<Group justify="flex-end">
								<Button
									size="xs"
									leftSection={<IconDownload size={14} />}
									variant="light"
									disabled={!listData?.records?.length}
									onClick={handleExportCsv}
								>
									{t("usageHistoryExportCsv")}
								</Button>
							</Group>

							<UsageHistoryTable records={listData?.records ?? []} loading={isLoadingList} />

							<Group justify="center" align="end" wrap="wrap">
								<Button
									size={isMobile ? "sm" : "md"}
									variant="light"
									disabled={cursorStack.length === 0 || isFetchingList}
									onClick={() => setCursorStack((current) => retreatUsageHistoryCursor(current))}
								>
									{t("usageHistoryPreviousPage")}
								</Button>
								<Text
									size="sm"
									c="dimmed"
									h={isMobile ? 36 : 42}
									style={{ display: "flex", alignItems: "center" }}
								>
									{t("usageHistoryPage", { page: cursorStack.length + 1 })}
								</Text>
								<Button
									size={isMobile ? "sm" : "md"}
									variant="light"
									disabled={!listData?.hasMore || !listData.nextCursor || isFetchingList}
									onClick={() => {
										setCursorStack((current) =>
											advanceUsageHistoryCursor(current, listData?.nextCursor),
										);
									}}
								>
									{t("usageHistoryNextPage")}
								</Button>
								<Select
									size={isMobile ? "xs" : "sm"}
									label={t("usageHistoryPageSize")}
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
						</Stack>
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</div>
	);
}
